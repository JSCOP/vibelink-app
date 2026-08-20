use super::browser_cdp::{option, DebugTarget};
use super::chrome_profile;
use crate::dedicated_cli::{ActionCommand, BrowserAction};
use crate::runtime_ports;
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap, VecDeque},
    fs, io,
    net::{Shutdown, TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, AtomicUsize, Ordering},
        mpsc::{self, Sender, SyncSender, TryRecvError, TrySendError},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tungstenite::{handshake::HandshakeError, Message, WebSocket};
use uuid::Uuid;

const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const SEND_TIMEOUT: Duration = Duration::from_secs(60);
const SOCKET_POLL_TIMEOUT: Duration = Duration::from_millis(10);
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(not(test))]
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(20);
#[cfg(test)]
const KEEPALIVE_INTERVAL: Duration = Duration::from_millis(200);
#[cfg(not(test))]
const IDLE_DEADLINE: Duration = Duration::from_secs(60);
#[cfg(test)]
const IDLE_DEADLINE: Duration = Duration::from_millis(600);
const MAX_TEXT_FRAME_BYTES: usize = 8 * 1024 * 1024;
const MAX_UNANSWERED_FRAMES: usize = 4096;
const MAX_UNAUTHENTICATED_CONNECTIONS: usize = 16;
const MAX_EVENTS_PER_TAB: usize = 1024;
const MAX_EVENT_BUFFER_BYTES: usize = 2 * 1024 * 1024;
const UNAVAILABLE_ERROR: &str =
    "VibeLink browser extension is unavailable; open Chrome with the VibeLink extension loaded and enabled";

static SHARED: OnceLock<Arc<ExtensionBridge>> = OnceLock::new();
static SHARED_INIT: Mutex<()> = Mutex::new(());

type PendingResult = std::result::Result<Value, String>;
struct UnauthenticatedConnectionPermit {
    active: Arc<AtomicUsize>,
}

impl Drop for UnauthenticatedConnectionPermit {
    fn drop(&mut self) {
        let previous = self.active.fetch_sub(1, Ordering::AcqRel);
        debug_assert!(previous > 0, "unauthenticated connection count underflow");
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionTab {
    pub tab_id: i64,
    pub window_id: i64,
    pub url: String,
    pub title: String,
    pub active: bool,
    pub attached: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionStatus {
    pub listening: bool,
    pub port: u16,
    pub connected: bool,
    pub browser: Option<String>,
    pub extension_version: Option<String>,
    pub connected_at_ms: Option<u64>,
    /// The extension id this daemon has bound itself to, if any.
    pub trusted_extension_id: Option<String>,
    /// Set when an extension was turned away because another id is trusted.
    pub rejected_extension_id: Option<String>,
}

struct OutboundFrame {
    id: u64,
    text: String,
}

struct Connection {
    id: Uuid,
    outbound: SyncSender<OutboundFrame>,
    stream: TcpStream,
}

struct BufferedEvent {
    sequence: u64,
    bytes: usize,
    value: Value,
}

#[derive(Default)]
struct BridgeState {
    connection: Option<Connection>,
    browser: Option<String>,
    extension_version: Option<String>,
    connected_at_ms: Option<u64>,
    trusted_extension_id: Option<String>,
    rejected_extension_id: Option<String>,
    pending: HashMap<u64, Sender<PendingResult>>,
    events: HashMap<i64, VecDeque<BufferedEvent>>,
    event_fronts: BTreeSet<(u64, i64)>,
    event_bytes: usize,
    next_event_sequence: u64,
}
impl BridgeState {
    fn pop_event(&mut self, tab_id: i64) -> Option<BufferedEvent> {
        let (event, next_sequence, empty) = {
            let queue = self.events.get_mut(&tab_id)?;
            let event = queue.pop_front()?;
            (
                event,
                queue.front().map(|event| event.sequence),
                queue.is_empty(),
            )
        };
        self.event_fronts.remove(&(event.sequence, tab_id));
        if let Some(sequence) = next_sequence {
            self.event_fronts.insert((sequence, tab_id));
        }
        if empty {
            self.events.remove(&tab_id);
        }
        self.event_bytes = self.event_bytes.saturating_sub(event.bytes);
        Some(event)
    }

    fn push_event(&mut self, tab_id: i64, bytes: usize, value: Value) {
        while self
            .events
            .get(&tab_id)
            .is_some_and(|events| events.len() >= MAX_EVENTS_PER_TAB)
        {
            self.pop_event(tab_id)
                .expect("browser extension per-tab event queue");
        }

        let sequence = self.next_event_sequence;
        self.next_event_sequence = self
            .next_event_sequence
            .checked_add(1)
            .expect("browser extension event sequence exhausted");
        let queue = self.events.entry(tab_id).or_default();
        if queue.is_empty() {
            self.event_fronts.insert((sequence, tab_id));
        }
        queue.push_back(BufferedEvent {
            sequence,
            bytes,
            value,
        });
        self.event_bytes = self.event_bytes.saturating_add(bytes);

        while self.event_bytes > MAX_EVENT_BUFFER_BYTES {
            let (_, oldest_tab_id) = self
                .event_fronts
                .iter()
                .next()
                .copied()
                .expect("browser extension global event order");
            self.pop_event(oldest_tab_id)
                .expect("browser extension oldest event");
        }
    }

    fn clear_events(&mut self) {
        self.events.clear();
        self.event_fronts.clear();
        self.event_bytes = 0;
    }
}

pub struct ExtensionBridge {
    port: u16,
    /// Where the trusted extension id is remembered, next to the extension
    /// folder rather than inside it: the folder must stay byte-identical for
    /// every user so one Chrome Web Store build serves everyone.
    trust_path: PathBuf,
    next_id: AtomicU64,
    unauthenticated_connections: Arc<AtomicUsize>,
    state: Mutex<BridgeState>,
}

impl ExtensionBridge {
    /// Starts (once per process) the loopback listener on `port` and returns the
    /// shared handle. Repeat calls with the same port return the same handle;
    /// a call with a different port is an error.
    pub fn shared(port: u16, trust_path: PathBuf) -> Result<Arc<ExtensionBridge>> {
        if let Some(bridge) = SHARED.get() {
            return bridge.for_port(port);
        }

        let _init = SHARED_INIT
            .lock()
            .expect("browser extension bridge init mutex");
        if let Some(bridge) = SHARED.get() {
            return bridge.for_port(port);
        }

        let listener = TcpListener::bind(("127.0.0.1", port)).with_context(|| {
            format!("bind VibeLink browser extension listener on 127.0.0.1:{port}")
        })?;
        let bridge = Self::start(listener, trust_path)?;
        SHARED
            .set(Arc::clone(&bridge))
            .map_err(|_| anyhow!("initialize shared VibeLink browser extension bridge"))?;
        Ok(bridge)
    }

    pub fn status(&self) -> ExtensionStatus {
        let state = self.state.lock().expect("browser extension state mutex");
        ExtensionStatus {
            listening: true,
            port: self.port,
            connected: state.connection.is_some(),
            browser: state.browser.clone(),
            extension_version: state.extension_version.clone(),
            connected_at_ms: state.connected_at_ms,
            trusted_extension_id: state.trusted_extension_id.clone(),
            rejected_extension_id: state.rejected_extension_id.clone(),
        }
    }

    /// Forgets the trusted extension so a different build — a developer's
    /// unpacked copy replaced by the Chrome Web Store one, say — can bind.
    pub fn unpair(&self) -> Result<()> {
        let (connection, pending, trust_result) = {
            let mut state = self.state.lock().expect("browser extension state mutex");
            state.trusted_extension_id = None;
            state.rejected_extension_id = None;
            let trust_result = write_trust(&self.trust_path, None);
            let connection = state.connection.take();
            state.browser = None;
            state.extension_version = None;
            state.connected_at_ms = None;
            state.clear_events();
            let pending = state
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>();
            (connection, pending, trust_result)
        };
        if let Some(connection) = connection {
            let _ = connection.stream.shutdown(Shutdown::Both);
        }
        for sender in pending {
            let _ = sender.send(Err(UNAVAILABLE_ERROR.to_string()));
        }
        trust_result
    }

    /// Binds the bridge to the first extension id that sends a valid hello;
    /// after that only that id is served.
    fn authorize(&self, extension_id: &str) -> bool {
        let mut state = self.state.lock().expect("browser extension state mutex");
        match state.trusted_extension_id.as_deref() {
            Some(trusted) if trusted == extension_id => {
                state.rejected_extension_id = None;
                true
            }
            Some(_) => {
                state.rejected_extension_id = Some(extension_id.to_string());
                false
            }
            None => {
                state.trusted_extension_id = Some(extension_id.to_string());
                state.rejected_extension_id = None;
                if let Err(error) = write_trust(&self.trust_path, Some(extension_id)) {
                    tracing::warn!(%error, "remember the trusted browser extension");
                }
                true
            }
        }
    }

    pub fn list_tabs(&self) -> Result<Vec<ExtensionTab>> {
        let result = self.request(json!({"v": 1, "op": "listTabs"}), REQUEST_TIMEOUT)?;
        #[derive(Deserialize)]
        struct TabsResult {
            tabs: Vec<ExtensionTab>,
        }
        serde_json::from_value::<TabsResult>(result)
            .map(|result| result.tabs)
            .map_err(|_| anyhow!("VibeLink browser extension returned invalid tabs"))
    }

    pub fn new_tab(&self, url: &str) -> Result<ExtensionTab> {
        let result = self.request(json!({"v": 1, "op": "newTab", "url": url}), REQUEST_TIMEOUT)?;
        serde_json::from_value(result)
            .map_err(|_| anyhow!("VibeLink browser extension returned an invalid tab"))
    }

    pub fn close_tab(&self, tab_id: i64) -> Result<()> {
        self.request(
            json!({"v": 1, "op": "closeTab", "tabId": tab_id}),
            REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    pub fn name_session(&self, tab_id: i64, title: &str, color: &str) -> Result<()> {
        self.request(
            json!({
                "v": 1,
                "op": "nameSession",
                "tabId": tab_id,
                "title": title,
                "color": color,
            }),
            REQUEST_TIMEOUT,
        )?;
        Ok(())
    }

    /// One CDP command against one live tab. The extension attaches on demand.
    pub fn send(&self, tab_id: i64, method: &str, params: Value) -> Result<Value> {
        self.send_with_timeout(tab_id, method, params, SEND_TIMEOUT)
    }

    pub fn send_with_timeout(
        &self,
        tab_id: i64,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value> {
        self.request(
            json!({
                "v": 1,
                "op": "send",
                "tabId": tab_id,
                "method": method,
                "params": params,
            }),
            timeout,
        )
    }

    /// Buffered CDP events for one tab, oldest first, removed as they are read.
    pub fn drain_events(&self, tab_id: i64, max: usize) -> Vec<Value> {
        if max == 0 {
            return Vec::new();
        }
        let mut state = self.state.lock().expect("browser extension state mutex");
        let mut drained = Vec::with_capacity(max.min(MAX_EVENTS_PER_TAB));
        while drained.len() < max {
            let Some(event) = state.pop_event(tab_id) else {
                break;
            };
            drained.push(event.value);
        }
        drained
    }

    fn for_port(self: &Arc<Self>, port: u16) -> Result<Arc<Self>> {
        if self.port == port {
            Ok(Arc::clone(self))
        } else {
            bail!(
                "VibeLink browser extension bridge already listens on port {}; requested port {port}",
                self.port
            )
        }
    }

    fn start(listener: TcpListener, trust_path: PathBuf) -> Result<Arc<Self>> {
        let address = listener
            .local_addr()
            .context("read VibeLink browser extension listener address")?;
        if !address.ip().is_loopback() {
            bail!("VibeLink browser extension listener must use a loopback address");
        }
        let bridge = Arc::new(Self {
            port: address.port(),
            next_id: AtomicU64::new(1),
            unauthenticated_connections: Arc::new(AtomicUsize::new(0)),
            state: Mutex::new(BridgeState {
                trusted_extension_id: read_trust(&trust_path),
                ..BridgeState::default()
            }),
            trust_path,
        });
        let listener_bridge = Arc::clone(&bridge);
        thread::Builder::new()
            .name("vibelink-browser-extension-listener".to_string())
            .spawn(move || listener_bridge.accept_loop(listener))
            .context("spawn VibeLink browser extension listener thread")?;
        Ok(bridge)
    }

    fn accept_loop(self: Arc<Self>, listener: TcpListener) {
        loop {
            match listener.accept() {
                Ok((stream, _)) => {
                    if self
                        .unauthenticated_connections
                        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                            (active < MAX_UNAUTHENTICATED_CONNECTIONS).then_some(active + 1)
                        })
                        .is_err()
                    {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    let unauthenticated = UnauthenticatedConnectionPermit {
                        active: Arc::clone(&self.unauthenticated_connections),
                    };
                    let authentication_deadline = Instant::now() + HELLO_TIMEOUT;
                    let bridge = Arc::clone(&self);
                    if let Err(error) = thread::Builder::new()
                        .name("vibelink-browser-extension-client".to_string())
                        .spawn(move || {
                            if let Err(error) = bridge.handle_connection(
                                stream,
                                authentication_deadline,
                                unauthenticated,
                            ) {
                                tracing::warn!(
                                    ?error,
                                    "VibeLink browser extension connection ended"
                                );
                            }
                        })
                    {
                        tracing::warn!(?error, "failed to spawn browser extension client thread");
                    }
                }
                Err(error) => {
                    tracing::warn!(?error, "VibeLink browser extension accept failed");
                    thread::sleep(Duration::from_millis(100));
                }
            }
        }
    }

    // The error type here is `tungstenite`'s handshake `ErrorResponse`, whose
    // size the callback signature dictates. Boxing it is not an option.
    #[allow(clippy::result_large_err)]
    fn handle_connection(
        self: &Arc<Self>,
        stream: TcpStream,
        authentication_deadline: Instant,
        unauthenticated: UnauthenticatedConnectionPermit,
    ) -> Result<()> {
        stream.set_nodelay(true)?;
        stream.set_write_timeout(Some(SOCKET_WRITE_TIMEOUT))?;
        stream.set_nonblocking(true)?;
        let config = tungstenite::protocol::WebSocketConfig::default()
            .read_buffer_size(32 * 1024)
            .write_buffer_size(32 * 1024)
            .max_write_buffer_size(MAX_TEXT_FRAME_BYTES)
            .max_message_size(Some(MAX_TEXT_FRAME_BYTES))
            .max_frame_size(Some(MAX_TEXT_FRAME_BYTES));
        // The browser sets `Origin` on the upgrade and script cannot override it,
        // so an extension origin is proof the peer really is an installed
        // extension rather than a page that guessed the port.
        let origin = Arc::new(Mutex::new(None));
        let captured = Arc::clone(&origin);
        let mut handshake = tungstenite::accept_hdr_with_config(
            stream,
            move |request: &tungstenite::handshake::server::Request,
                  response: tungstenite::handshake::server::Response| {
                *captured.lock().expect("browser extension origin mutex") = request
                    .headers()
                    .get("origin")
                    .and_then(|value| value.to_str().ok())
                    .and_then(extension_id_from_origin);
                Ok(response)
            },
            Some(config),
        );
        let mut websocket = loop {
            match handshake {
                Ok(websocket) => break websocket,
                Err(HandshakeError::Interrupted(mid)) => {
                    if Instant::now() >= authentication_deadline {
                        return Ok(());
                    }
                    thread::sleep(SOCKET_POLL_TIMEOUT);
                    handshake = mid.handshake();
                }
                Err(HandshakeError::Failure(error)) => {
                    return Err(error).context("accept VibeLink browser extension WebSocket")
                }
            }
        };
        let extension_id = origin
            .lock()
            .expect("browser extension origin mutex")
            .take();
        let Some(extension_id) = extension_id else {
            let _ = websocket.send(Message::Close(None));
            return Ok(());
        };

        let hello_text = loop {
            if Instant::now() >= authentication_deadline {
                let _ = websocket.send(Message::Close(None));
                return Ok(());
            }
            match websocket.read() {
                Ok(Message::Text(text)) if text.len() <= MAX_TEXT_FRAME_BYTES => break text,
                Ok(_) => {
                    let _ = websocket.send(Message::Close(None));
                    return Ok(());
                }
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) =>
                {
                    thread::sleep(SOCKET_POLL_TIMEOUT);
                }
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Ok(())
                }
                Err(error) => return Err(error).context("read VibeLink browser extension hello"),
            }
        };
        let hello: HelloFrame = match serde_json::from_str(hello_text.as_ref()) {
            Ok(hello) => hello,
            Err(_) => {
                let _ = websocket.send(Message::Close(None));
                return Ok(());
            }
        };
        if hello.v != 1 || hello.message_type != "hello" {
            let _ = websocket.send(Message::Close(None));
            return Ok(());
        }

        websocket.get_mut().set_nonblocking(false)?;
        websocket
            .get_mut()
            .set_read_timeout(Some(SOCKET_POLL_TIMEOUT))?;
        let connection_stream = websocket
            .get_ref()
            .try_clone()
            .context("clone VibeLink browser extension stream")?;
        if !self.authorize(&extension_id) {
            let _ = websocket.send(Message::Close(None));
            return Ok(());
        }
        let connection_id = Uuid::new_v4();
        let (outbound, outbound_rx) = mpsc::sync_channel(MAX_UNANSWERED_FRAMES);
        if !self.activate_connection(
            connection_id,
            outbound,
            connection_stream,
            hello.browser,
            hello.extension_version,
        ) {
            let _ = websocket.send(Message::Close(None));
            return Ok(());
        }
        drop(unauthenticated);

        let result = self.run_connection(&mut websocket, connection_id, outbound_rx);
        self.disconnect(connection_id);
        result
    }

    fn activate_connection(
        &self,
        id: Uuid,
        outbound: SyncSender<OutboundFrame>,
        stream: TcpStream,
        browser: String,
        extension_version: String,
    ) -> bool {
        let mut state = self.state.lock().expect("browser extension state mutex");
        if state.connection.is_some() {
            return false;
        }
        state.connection = Some(Connection {
            id,
            outbound,
            stream,
        });
        state.browser = Some(browser);
        state.extension_version = Some(extension_version);
        state.connected_at_ms = Some(now_ms());
        true
    }

    fn run_connection(
        &self,
        websocket: &mut WebSocket<TcpStream>,
        connection_id: Uuid,
        outbound: mpsc::Receiver<OutboundFrame>,
    ) -> Result<()> {
        let mut last_frame = Instant::now();
        let mut last_ping = Instant::now();
        loop {
            for _ in 0..64 {
                match outbound.try_recv() {
                    Ok(frame) => {
                        if self.request_is_pending(connection_id, frame.id) {
                            websocket.send(Message::Text(frame.text.into()))?;
                        }
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return Ok(()),
                }
            }

            match websocket.read() {
                Ok(message) => {
                    last_frame = Instant::now();
                    match message {
                        Message::Text(text) => {
                            if text.len() > MAX_TEXT_FRAME_BYTES {
                                let _ = websocket.send(Message::Close(None));
                                bail!("VibeLink browser extension text frame exceeds 8 MiB");
                            }
                            if let Err(error) = self.handle_text_frame(connection_id, text.as_ref())
                            {
                                let _ = websocket.send(Message::Close(None));
                                return Err(error);
                            }
                        }
                        Message::Ping(data) => websocket.send(Message::Pong(data))?,
                        Message::Pong(_) => {}
                        Message::Close(_) => return Ok(()),
                        _ => {
                            let _ = websocket.send(Message::Close(None));
                            bail!("VibeLink browser extension messages must be text frames");
                        }
                    }
                }
                Err(tungstenite::Error::Io(error))
                    if matches!(
                        error.kind(),
                        io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                    ) => {}
                Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                    return Ok(())
                }
                Err(error) => return Err(error.into()),
            }

            if last_frame.elapsed() >= IDLE_DEADLINE {
                let _ = websocket.send(Message::Close(None));
                bail!("VibeLink browser extension idle deadline exceeded");
            }
            if last_ping.elapsed() >= KEEPALIVE_INTERVAL {
                websocket.send(Message::Ping(Vec::new().into()))?;
                last_ping = Instant::now();
            }
        }
    }

    fn handle_text_frame(&self, connection_id: Uuid, text: &str) -> Result<()> {
        let frame: Value = serde_json::from_str(text)
            .map_err(|_| anyhow!("invalid VibeLink browser extension frame"))?;
        if frame.get("v").and_then(Value::as_u64) != Some(1) {
            bail!("unsupported VibeLink browser extension protocol version");
        }
        let message_type = frame
            .get("type")
            .and_then(Value::as_str)
            .context("VibeLink browser extension frame type is required")?;
        if !self.is_active_connection(connection_id) {
            bail!("stale VibeLink browser extension connection");
        }

        match message_type {
            "result" => {
                let id = frame
                    .get("id")
                    .and_then(Value::as_u64)
                    .context("VibeLink browser extension result id is required")?;
                let ok = frame
                    .get("ok")
                    .and_then(Value::as_bool)
                    .context("VibeLink browser extension result status is required")?;
                let reply = if ok {
                    Ok(frame
                        .get("result")
                        .cloned()
                        .context("VibeLink browser extension result value is required")?)
                } else {
                    Err(frame
                        .get("error")
                        .and_then(Value::as_str)
                        .unwrap_or("VibeLink browser extension request failed")
                        .to_string())
                };
                let sender = self
                    .state
                    .lock()
                    .expect("browser extension state mutex")
                    .pending
                    .remove(&id);
                if let Some(sender) = sender {
                    let _ = sender.send(reply);
                }
            }
            "event" => {
                let tab_id = frame
                    .get("tabId")
                    .and_then(Value::as_i64)
                    .context("VibeLink browser extension event tabId is required")?;
                frame
                    .get("method")
                    .and_then(Value::as_str)
                    .context("VibeLink browser extension event method is required")?;
                frame
                    .get("params")
                    .context("VibeLink browser extension event params are required")?;
                self.push_event(tab_id, frame);
            }
            "keepalive" => {}
            _ => bail!("unsupported VibeLink browser extension frame type"),
        }
        Ok(())
    }

    fn request(&self, mut request: Value, timeout: Duration) -> Result<Value> {
        let id = self.next_request_id()?;
        let operation = request
            .get("op")
            .and_then(Value::as_str)
            .unwrap_or("request")
            .to_string();
        request
            .as_object_mut()
            .context("VibeLink browser extension request must be a JSON object")?
            .insert("id".to_string(), Value::from(id));
        let text = serde_json::to_string(&request)
            .context("serialize VibeLink browser extension request")?;
        let (reply_tx, reply_rx) = mpsc::channel();

        let (connection_id, outbound) = {
            let mut state = self.state.lock().expect("browser extension state mutex");
            let connection = state.connection.as_ref().ok_or_else(unavailable)?;
            if state.pending.len() >= MAX_UNANSWERED_FRAMES {
                bail!("VibeLink browser extension has too many unanswered requests");
            }
            let connection_id = connection.id;
            let outbound = connection.outbound.clone();
            state.pending.insert(id, reply_tx);
            (connection_id, outbound)
        };

        match outbound.try_send(OutboundFrame { id, text }) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => {
                self.remove_pending(id);
                bail!("VibeLink browser extension has too many unanswered requests");
            }
            Err(TrySendError::Disconnected(_)) => {
                self.disconnect(connection_id);
                return Err(unavailable());
            }
        }

        match reply_rx.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(anyhow!(error)),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                self.remove_pending(id);
                bail!("{operation} timed out waiting for the VibeLink browser extension")
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => Err(unavailable()),
        }
    }

    fn next_request_id(&self) -> Result<u64> {
        self.next_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| anyhow!("VibeLink browser extension request id space is exhausted"))
    }

    fn request_is_pending(&self, connection_id: Uuid, id: u64) -> bool {
        let state = self.state.lock().expect("browser extension state mutex");
        state
            .connection
            .as_ref()
            .is_some_and(|connection| connection.id == connection_id)
            && state.pending.contains_key(&id)
    }

    fn is_active_connection(&self, connection_id: Uuid) -> bool {
        self.state
            .lock()
            .expect("browser extension state mutex")
            .connection
            .as_ref()
            .is_some_and(|connection| connection.id == connection_id)
    }

    fn remove_pending(&self, id: u64) {
        self.state
            .lock()
            .expect("browser extension state mutex")
            .pending
            .remove(&id);
    }

    fn disconnect(&self, connection_id: Uuid) {
        let pending = {
            let mut state = self.state.lock().expect("browser extension state mutex");
            if state
                .connection
                .as_ref()
                .is_none_or(|connection| connection.id != connection_id)
            {
                return;
            }
            state.connection = None;
            state.browser = None;
            state.extension_version = None;
            state.connected_at_ms = None;
            state.clear_events();
            state
                .pending
                .drain()
                .map(|(_, sender)| sender)
                .collect::<Vec<_>>()
        };
        for sender in pending {
            let _ = sender.send(Err(UNAVAILABLE_ERROR.to_string()));
        }
    }

    fn push_event(&self, tab_id: i64, value: Value) {
        let bytes = serde_json::to_vec(&value)
            .map(|encoded| encoded.len())
            .unwrap_or(MAX_EVENT_BUFFER_BYTES.saturating_add(1));
        self.state
            .lock()
            .expect("browser extension state mutex")
            .push_event(tab_id, bytes, value);
    }
}

/// The extension identifies itself; it no longer proves anything here, because
/// the WebSocket `Origin` already did.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HelloFrame {
    v: u8,
    #[serde(rename = "type")]
    message_type: String,
    browser: String,
    extension_version: String,
    #[serde(rename = "userAgent")]
    _user_agent: String,
}

/// `chrome-extension://<32 chars a-p>` is the only origin this bridge serves.
fn extension_id_from_origin(origin: &str) -> Option<String> {
    let id = origin.strip_prefix("chrome-extension://")?;
    extension_id_from_origin_bare(id.strip_suffix('/').unwrap_or(id))
}

fn read_trust(path: &Path) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    let value: Value = serde_json::from_slice(&bytes).ok()?;
    value
        .get("extensionId")
        .and_then(Value::as_str)
        .and_then(extension_id_from_origin_bare)
}

fn extension_id_from_origin_bare(id: &str) -> Option<String> {
    (id.len() == 32 && id.bytes().all(|byte| matches!(byte, b'a'..=b'p'))).then(|| id.to_string())
}

fn write_trust(path: &Path, extension_id: Option<&str>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("create the VibeLink browser extension data folder")?;
    }
    match extension_id {
        Some(extension_id) => fs::write(
            path,
            serde_json::to_vec_pretty(&json!({ "extensionId": extension_id }))?,
        )
        .context("write the VibeLink browser extension trust file"),
        None => match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("clear the VibeLink browser extension trust file"),
        },
    }
}

/// Starts the loopback listener at daemon boot so the extension can connect
/// before any browser command has run. A failure must not stop the daemon.
pub fn start_for_daemon(sessions_path: &Path) {
    let artifact_root = sessions_path
        .parent()
        .unwrap_or(sessions_path)
        .join("browser-artifacts");
    let main_port = std::env::var("VIBELINK_BROWSER_CDP_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|port| *port != 0)
        .unwrap_or_else(runtime_ports::current_main_webview_cdp_port);
    if let Err(error) = bridge_for(&artifact_root, main_port) {
        tracing::warn!(%error, "browser extension bridge unavailable");
    }
}

fn unavailable() -> anyhow::Error {
    anyhow!(UNAVAILABLE_ERROR)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

/// The extension is embedded in the binary rather than read from a bundled
/// resource path so the daemon can materialize it identically in a dev
/// checkout and an installed package.
const MANIFEST_JSON: &str = include_str!("../../resources/browser-extension/manifest.json");
const SERVICE_WORKER_JS: &str = include_str!("../../resources/browser-extension/service-worker.js");
const EXTENSION_README: &str = include_str!("../../resources/browser-extension/README.md");
const ICON_32_PNG: &[u8] = include_bytes!("../../resources/browser-extension/icons/icon-32.png");
const ICON_128_PNG: &[u8] = include_bytes!("../../resources/browser-extension/icons/icon-128.png");

/// The id the Chrome Web Store console assigns at the first draft upload. While
/// it is `None`, `--install` only writes the unpacked bundle, exactly as before.
const STORE_EXTENSION_ID: Option<&str> = None;
#[cfg(windows)]
const STORE_UPDATE_URL: &str = "https://clients2.google.com/service/update2/crx";

/// `(HKCU subkey path, value name, value)`, split out from the registry write so
/// the key shape is testable without touching the registry.
#[cfg(windows)]
fn store_registration(extension_id: &str) -> (String, &'static str, &'static str) {
    (
        format!("Software\\Google\\Chrome\\Extensions\\{extension_id}"),
        "update_url",
        STORE_UPDATE_URL,
    )
}

/// The store id, but only for a build allowed to own that key. The registry
/// path is per-user and NOT flavor-scoped, so a DEV build writing it would
/// install the extension for the RELEASE runtime too.
fn store_extension_id_for_this_flavor() -> Option<&'static str> {
    STORE_EXTENSION_ID.filter(|_| crate::daemon::paths::app_flavor() == "prod")
}

/// HKCU rather than HKLM: the NSIS bundle installs per-user, and the machine
/// hive would demand an elevation VibeLink never asks for. Chrome reads external
/// extension registrations from both hives. Returns the full key path to show
/// the user.
#[cfg(windows)]
fn register_store_extension(extension_id: &str) -> Result<String> {
    let (path, name, value) = store_registration(extension_id);
    let (key, _) = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
        .create_subkey(&path)
        .with_context(|| format!("create HKCU\\{path}"))?;
    key.set_value(name, &value)
        .with_context(|| format!("set HKCU\\{path}\\{name}"))?;
    Ok(format!("HKCU\\{path}"))
}

#[cfg(windows)]
fn unregister_store_extension(extension_id: &str) -> Result<()> {
    let (path, _, _) = store_registration(extension_id);
    match winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER).delete_subkey_all(&path) {
        // Already absent is the goal state, not a failure.
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result.with_context(|| format!("delete HKCU\\{path}")),
    }
}

/// Off Windows there is no Chrome external-extension registry, so this fails
/// loudly rather than reporting a registration that never happened. It exists
/// only so the module still compiles there.
#[cfg(not(windows))]
fn register_store_extension(_extension_id: &str) -> Result<String> {
    bail!("registering a Chrome extension with the system is only supported on Windows")
}

#[cfg(not(windows))]
fn unregister_store_extension(_extension_id: &str) -> Result<()> {
    Ok(())
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionInstall {
    pub directory: PathBuf,
    pub ports: Vec<u16>,
    pub load_unpacked_hint: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_extension_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub store_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_key: Option<String>,
}

pub fn install_directory(data_root: &Path) -> PathBuf {
    data_root.join("browser-extension")
}

/// Writes the unpacked extension. `bridge-port.json` advertises only this
/// flavor's listener; no per-user secret is baked in. Off-store, Chrome still
/// needs the user to load this folder once through `chrome://extensions` in
/// developer mode.
pub fn install(data_root: &Path, port: u16) -> Result<ExtensionInstall> {
    let directory = install_directory(data_root);
    fs::create_dir_all(&directory).context("create the VibeLink browser extension directory")?;
    for (name, contents) in [
        ("manifest.json", MANIFEST_JSON),
        ("service-worker.js", SERVICE_WORKER_JS),
        ("README.md", EXTENSION_README),
    ] {
        fs::write(directory.join(name), contents)
            .with_context(|| format!("write VibeLink browser extension file {name}"))?;
    }
    let icons = directory.join("icons");
    fs::create_dir_all(&icons).context("create the VibeLink browser extension icon directory")?;
    for (name, bytes) in [("icon-32.png", ICON_32_PNG), ("icon-128.png", ICON_128_PNG)] {
        fs::write(icons.join(name), bytes)
            .with_context(|| format!("write VibeLink browser extension icon {name}"))?;
    }
    fs::write(
        directory.join("bridge-port.json"),
        format!(r#"{{"port": {port}}}"#),
    )
    .context("write VibeLink browser extension bridge port")?;
    // Older builds baked a per-machine token here. Leaving it behind would keep
    // one user's folder different from the store build for no reason.
    let stale = directory.join("pairing.json");
    if let Err(error) = fs::remove_file(&stale) {
        if error.kind() != io::ErrorKind::NotFound {
            return Err(error).context("remove the obsolete browser extension pairing file");
        }
    }
    Ok(ExtensionInstall {
        load_unpacked_hint: format!(
            "Open chrome://extensions, enable Developer mode, choose \"Load unpacked\", and select {}",
            directory.display()
        ),
        directory,
        ports: vec![port],
        store_extension_id: None,
        store_url: None,
        registry_key: None,
    })
}

/// Where the trusted extension id is remembered: beside the extension folder,
/// never inside it.
pub fn trust_path(data_root: &Path) -> PathBuf {
    data_root.join("browser-extension.json")
}

/// `browser chrome` owns the real-Chrome backend. The default report and
/// `--install` drive the extension that attaches to the user's running Chrome;
/// `--copy-profile` is the fallback for a machine where that extension cannot
/// be loaded, and it deliberately refuses while Chrome still owns the profile.
pub(super) fn chrome_backend(
    command: &ActionCommand<BrowserAction>,
    artifact_root: &Path,
    main_port: u16,
    reserved_ports: &[u16],
) -> Result<Value> {
    let data_root = artifact_root.parent().unwrap_or(artifact_root);
    if command.arguments.switches.contains("install") {
        // Only this flavor's port. Listing a port no daemon serves makes the
        // service worker retry a dead endpoint forever, and Chrome records every
        // refused WebSocket as an extension error the user has to read.
        let bridge = bridge_for(artifact_root, main_port)?;
        let mut install = install(data_root, bridge.port)?;
        if let Some(id) = store_extension_id_for_this_flavor() {
            // The unpacked bundle is already on disk, so a registry failure
            // leaves the user a working fallback rather than a dead end — but it
            // must still be reported, not swallowed.
            install.registry_key = Some(
                register_store_extension(id)
                    .context("register the VibeLink browser extension with Chrome")?,
            );
            install.store_extension_id = Some(id.to_string());
            install.store_url = Some(format!("https://chromewebstore.google.com/detail/{id}"));
        }
        return Ok(serde_json::to_value(install)?);
    }
    if command.arguments.switches.contains("unpair") {
        let bridge = bridge_for(artifact_root, main_port)?;
        // Leaving the registration behind would let Chrome reinstall the
        // extension on its next start, so an unpair would not stay unpaired.
        if let Some(id) = store_extension_id_for_this_flavor() {
            unregister_store_extension(id)
                .context("remove the VibeLink browser extension registration from Chrome")?;
        }
        bridge.unpair()?;
        return Ok(json!({ "backend": "extension", "status": bridge.status() }));
    }
    if command.arguments.switches.contains("copy-profile") {
        if !command.arguments.switches.contains("confirm") {
            bail!("--confirm is required: this copies the signed-in Chrome profile into VibeLink-owned storage");
        }
        return Ok(serde_json::to_value(chrome_profile::ensure(
            artifact_root,
            main_port,
            reserved_ports,
            option(command, "source-profile"),
            command.arguments.switches.contains("refresh"),
        )?)?);
    }
    let bridge = bridge_for(artifact_root, main_port)?;
    if let Some(title) = option(command, "session-title") {
        // Naming the session groups the tab in Chrome's own tab strip, so the
        // user can see at a glance which tabs an agent is working in.
        let tab_id = command
            .selectors
            .tab
            .as_deref()
            .and_then(|value| value.strip_prefix("chrome-tab-"))
            .and_then(|value| value.parse::<i64>().ok())
            .context("--tab must name a chrome-tab-<id> target")?;
        bridge.name_session(
            tab_id,
            title,
            option(command, "session-color").unwrap_or("blue"),
        )?;
        return Ok(json!({ "tabId": tab_id, "sessionTitle": title }));
    }

    let status = bridge.status();
    let tabs = bridge.list_tabs().unwrap_or_default();
    Ok(json!({
        "backend": "extension",
        "status": status,
        "tabs": tabs,
        "installDirectory": install_directory(data_root),
    }))
}

pub(super) fn bridge_for(artifact_root: &Path, main_port: u16) -> Result<Arc<ExtensionBridge>> {
    let data_root = artifact_root.parent().unwrap_or(artifact_root);
    ExtensionBridge::shared(
        runtime_ports::browser_extension_port(main_port),
        trust_path(data_root),
    )
}

/// A tab in the user's Chrome is not workspace-scoped, so it carries the
/// caller's workspace and leaves the existing workspace filters untouched.
pub(super) fn extension_target(tab: ExtensionTab, workspace_id: Option<String>) -> DebugTarget {
    DebugTarget {
        id: format!("chrome-tab-{}", tab.tab_id),
        title: tab.title,
        url: tab.url,
        target_type: "page".to_string(),
        web_socket_debugger_url: None,
        cdp_port: 0,
        page_id: None,
        profile_id: Some("chrome-extension".to_string()),
        workspace_id,
        external: true,
        extension_tab_id: Some(tab.tab_id),
    }
}

#[cfg(test)]
#[path = "browser_extension_tests.rs"]
mod tests;

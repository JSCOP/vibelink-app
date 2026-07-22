use crate::protocol::{
    read_frame, write_frame, ClientToDaemon, DaemonToClient, RemoteBrowserHostRequest,
    RemoteBrowserHostResponse, ReplyResult, Req, TaskSignal,
};
use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::{bounded, Sender, TrySendError};
use interprocess::local_socket::{
    prelude::*, RecvHalf as LocalSocketRecvHalf, SendHalf as LocalSocketSendHalf,
};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{ipc::Channel, AppHandle, Emitter, Manager as _};
use tracing::{error, info, warn};
use uuid::Uuid;

use super::spawn_daemon::{
    ensure_daemon, ensure_daemon_with_recovery, DaemonStream, StartupRecoveryBudget,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_DELAY: Duration = Duration::from_millis(250);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(10);
// A renderer can stop reading while WebView2 is busy or suspended. Keep each
// local client bounded by frames AND bytes; overflow is counted and surfaced
// after it catches up.
const TERMINAL_WS_QUEUE_FRAMES: usize = 1024;
const TERMINAL_WS_QUEUE_MAX_BYTES: usize = 4 * 1024 * 1024;
// Repeat trim notices for the same pane are throttled so a recovering stream
// is not drowned in notice lines.
const TRIM_NOTICE_MIN_INTERVAL: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TerminalEvent {
    Exited {
        #[serde(rename = "paneId")]
        pane_id: String,
        #[serde(rename = "exitCode")]
        exit_code: Option<i32>,
    },
    Resized {
        #[serde(rename = "paneId")]
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    SessionChanged {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
    Task {
        #[serde(rename = "sessionId")]
        session_id: String,
        signal: TaskSignal,
    },
    ConnectionLost {
        message: String,
    },
    ConnectionRestored,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPromptEvent {
    session_id: String,
    prompt: String,
}

#[derive(Clone)]
pub struct DaemonClient {
    shared: Arc<ClientShared>,
}

struct ClientShared {
    writer: Mutex<LocalSocketSendHalf>,
    pending: Mutex<HashMap<Req, Sender<DaemonToClient>>>,
    output_channel: Mutex<Option<Channel<TerminalEvent>>>,
    app_handle: Option<AppHandle>,
    ws_port: u16,
    ws_clients: Mutex<Vec<TerminalWsClient>>,
    next_req: AtomicU64,
    reconnecting: AtomicBool,
    shutting_down: AtomicBool,
    connection_generation: AtomicU64,
}

struct TerminalWsClient {
    sender: Sender<Arc<[u8]>>,
    queued_bytes: Arc<AtomicUsize>,
    trims: HashMap<String, PaneTrimState>,
}

#[derive(Default)]
struct PaneTrimState {
    dropped_bytes: u64,
    last_notice_at: Option<Instant>,
}

impl TerminalWsClient {
    /// Delivers one pane output frame, prepending a throttled trim notice
    /// after a lag. Returns `false` when the client is gone and must be
    /// removed.
    fn deliver_output(
        &mut self,
        pane_id: &str,
        data: &[u8],
        base_frame: &Arc<[u8]>,
        now: Instant,
    ) -> bool {
        let notice = self.pending_notice(pane_id, now);
        let frame: Arc<[u8]> = match notice.as_deref() {
            // Merge the notice into the SAME frame as the data. A separate
            // notice frame competes with real output for the last free queue
            // slot; under sustained backpressure every delivered frame then
            // becomes a notice while every data frame is dropped, filling the
            // terminal with notices and starving actual output.
            Some(text) => {
                let mut body = Vec::with_capacity(text.len() + data.len());
                body.extend_from_slice(text.as_bytes());
                body.extend_from_slice(data);
                Arc::from(frame_output(pane_id, &body).into_boxed_slice())
            }
            None => Arc::clone(base_frame),
        };
        let frame_len = frame.len();
        if self
            .queued_bytes
            .load(Ordering::Acquire)
            .saturating_add(frame_len)
            > TERMINAL_WS_QUEUE_MAX_BYTES
        {
            self.record_dropped(pane_id, data.len());
            return true;
        }
        match self.sender.try_send(frame) {
            Ok(()) => {
                self.queued_bytes.fetch_add(frame_len, Ordering::AcqRel);
                if notice.is_some() {
                    self.mark_notice_reported(pane_id, now);
                }
                true
            }
            Err(TrySendError::Full(_)) => {
                self.record_dropped(pane_id, data.len());
                true
            }
            Err(TrySendError::Disconnected(_)) => false,
        }
    }

    fn pending_notice(&self, pane_id: &str, now: Instant) -> Option<String> {
        let state = self.trims.get(pane_id)?;
        if state.dropped_bytes == 0 {
            return None;
        }
        if let Some(last) = state.last_notice_at {
            if now.duration_since(last) < TRIM_NOTICE_MIN_INTERVAL {
                return None;
            }
        }
        let dropped_bytes = state.dropped_bytes;
        Some(format!(
            "\r\n\x1b[33m[VibeLink: terminal output trimmed ({dropped_bytes} bytes) to keep the app responsive]\x1b[0m\r\n"
        ))
    }

    fn mark_notice_reported(&mut self, pane_id: &str, now: Instant) {
        if let Some(state) = self.trims.get_mut(pane_id) {
            state.dropped_bytes = 0;
            state.last_notice_at = Some(now);
        }
    }

    fn record_dropped(&mut self, pane_id: &str, bytes: usize) {
        let bytes = u64::try_from(bytes).unwrap_or(u64::MAX);
        let state = self.trims.entry(pane_id.to_string()).or_default();
        if state.dropped_bytes == 0 {
            warn!(
                pane_id,
                "terminal websocket client fell behind; trimming output"
            );
        }
        state.dropped_bytes = state.dropped_bytes.saturating_add(bytes);
    }
}

impl DaemonClient {
    pub fn new(stream: DaemonStream) -> Self {
        Self::new_inner(stream, None)
    }

    pub fn new_with_app(stream: DaemonStream, app_handle: AppHandle) -> Self {
        Self::new_inner(stream, Some(app_handle))
    }

    fn new_inner(stream: DaemonStream, app_handle: Option<AppHandle>) -> Self {
        let register_browser_host = app_handle.is_some();
        let (reader, writer) = split_daemon_stream(stream);
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("bind terminal ws listener");
        let ws_port = listener.local_addr().expect("ws local addr").port();
        let shared = Arc::new(ClientShared {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            output_channel: Mutex::new(None),
            app_handle,
            ws_port,
            ws_clients: Mutex::new(Vec::new()),
            next_req: AtomicU64::new(1),
            reconnecting: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            connection_generation: AtomicU64::new(0),
        });

        spawn_ws_accept_loop(listener, Arc::clone(&shared));
        spawn_reader_loop(reader, Arc::clone(&shared), 0);

        let client = Self { shared };
        if register_browser_host {
            let _ = client.send(ClientToDaemon::RegisterBrowserHost);
        }
        client
    }

    pub fn set_output_channel(&self, channel: Channel<TerminalEvent>) {
        *self
            .shared
            .output_channel
            .lock()
            .expect("output channel mutex poisoned") = Some(channel);
    }

    pub fn ws_port(&self) -> u16 {
        self.shared.ws_port
    }

    pub fn ping(&self) -> Result<()> {
        let req = self.next_req();
        match self.request(req, ClientToDaemon::Ping { req })? {
            DaemonToClient::Pong { req: reply_req } if reply_req == req => Ok(()),
            DaemonToClient::Error { message, .. } => bail!(message),
            other => bail!("unexpected ping response: {other:?}"),
        }
    }

    pub fn request_reply<F>(&self, make_msg: F) -> Result<ReplyResult>
    where
        F: FnOnce(Req) -> ClientToDaemon,
    {
        let req = self.next_req();
        match self.request(req, make_msg(req))? {
            DaemonToClient::Reply {
                req: reply_req,
                result,
            } if reply_req == req => Ok(result),
            DaemonToClient::Error { message, .. } => bail!(message),
            other => bail!("unexpected daemon response: {other:?}"),
        }
    }

    pub fn send(&self, msg: ClientToDaemon) -> Result<()> {
        let result = {
            let mut writer = self
                .shared
                .writer
                .lock()
                .expect("daemon writer mutex poisoned");
            write_frame(&mut *writer, &msg).context("write daemon message")
        };
        if let Err(err) = result {
            start_background_reconnect(&self.shared, format!("daemon write failed: {err}"));
            Err(err)
        } else {
            Ok(())
        }
    }

    pub fn prepare_shutdown(&self) {
        self.shared.shutting_down.store(true, Ordering::Release);
        fail_pending(&self.shared, "daemon client is shutting down".to_string());
    }

    pub fn restart(&self) -> Result<()> {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !begin_reconnect(&self.shared) {
            if self.shared.shutting_down.load(Ordering::Acquire) {
                bail!("client shutting down");
            }
            if Instant::now() >= deadline {
                bail!("restart timed out acquiring reconnect slot");
            }
            thread::sleep(RECONNECT_DELAY);
        }

        let result = (|| -> Result<()> {
            super::spawn_daemon::shutdown_daemon().context("shutdown current daemon")?;
            let stream = ensure_daemon().context("spawn fresh daemon")?;
            let (reader, writer) = split_daemon_stream(stream);
            *self
                .shared
                .writer
                .lock()
                .expect("daemon writer mutex poisoned") = writer;
            let generation = self
                .shared
                .connection_generation
                .fetch_add(1, Ordering::AcqRel)
                + 1;
            spawn_reader_loop(reader, Arc::clone(&self.shared), generation);
            if self.shared.app_handle.is_some() {
                self.send(ClientToDaemon::RegisterBrowserHost)?;
            }
            Ok(())
        })();

        finish_reconnect(&self.shared);
        let _ = send_terminal_event(&self.shared, TerminalEvent::ConnectionRestored);
        result
    }

    fn next_req(&self) -> Req {
        self.shared.next_req.fetch_add(1, Ordering::Relaxed)
    }

    fn request(&self, req: Req, msg: ClientToDaemon) -> Result<DaemonToClient> {
        self.request_with_timeout(req, msg, REQUEST_TIMEOUT)
    }

    fn request_with_timeout(
        &self,
        req: Req,
        msg: ClientToDaemon,
        timeout: Duration,
    ) -> Result<DaemonToClient> {
        let (tx, rx) = bounded(1);
        self.shared
            .pending
            .lock()
            .expect("pending request mutex poisoned")
            .insert(req, tx);

        let write_result = self.send(msg);

        if let Err(err) = write_result {
            remove_pending_request(&self.shared, req);
            return Err(err);
        }

        match rx.recv_timeout(timeout) {
            Ok(msg) => Ok(msg),
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                remove_pending_request(&self.shared, req);
                Err(anyhow!(
                    "daemon request {req} timed out after {}ms",
                    timeout.as_millis()
                ))
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                remove_pending_request(&self.shared, req);
                Err(anyhow!("daemon request {req} response channel closed"))
            }
        }
    }
}

fn spawn_reader_loop(reader: LocalSocketRecvHalf, shared: Arc<ClientShared>, generation: u64) {
    thread::Builder::new()
        .name("vibelink-daemon-reader".to_string())
        .spawn(move || reader_loop(reader, shared, generation))
        .expect("spawn daemon reader thread");
}

fn reader_loop(mut reader: LocalSocketRecvHalf, shared: Arc<ClientShared>, mut generation: u64) {
    loop {
        match read_frame::<_, DaemonToClient>(&mut reader) {
            Ok(msg) => route_daemon_message(&shared, msg),
            Err(err) => {
                if !reader_generation_is_current(
                    shared.connection_generation.load(Ordering::Acquire),
                    generation,
                ) {
                    break;
                }
                error!(?err, "daemon reader stopped");
                fail_pending(&shared, format!("daemon connection lost: {err}"));
                let _ = send_terminal_event(
                    &shared,
                    TerminalEvent::ConnectionLost {
                        message: err.to_string(),
                    },
                );
                if begin_reconnect(&shared) {
                    if let Some((next_reader, next_generation)) = reconnect(&shared) {
                        info!("daemon reconnected");
                        let _ = send_terminal_event(&shared, TerminalEvent::ConnectionRestored);
                        finish_reconnect(&shared);
                        reader = next_reader;
                        generation = next_generation;
                    } else {
                        finish_reconnect(&shared);
                        break;
                    }
                } else {
                    break;
                }
            }
        }
    }
}

fn reconnect(shared: &Arc<ClientShared>) -> Option<(LocalSocketRecvHalf, u64)> {
    let mut delay = RECONNECT_DELAY;
    let mut startup_recovery = StartupRecoveryBudget::default();
    loop {
        if shared.shutting_down.load(Ordering::Acquire) {
            return None;
        }

        match ensure_daemon_with_recovery(&mut startup_recovery) {
            Ok(stream) => {
                let (reader, writer) = split_daemon_stream(stream);
                *shared.writer.lock().expect("daemon writer mutex poisoned") = writer;
                let generation = shared.connection_generation.fetch_add(1, Ordering::AcqRel) + 1;
                if shared.app_handle.is_some() {
                    let mut writer = shared.writer.lock().expect("daemon writer mutex poisoned");
                    if write_frame(&mut *writer, &ClientToDaemon::RegisterBrowserHost).is_err() {
                        return None;
                    }
                }
                return Some((reader, generation));
            }
            Err(err) => {
                warn!(
                    ?err,
                    delay_ms = delay.as_millis(),
                    "daemon reconnect attempt failed"
                );
                thread::sleep(delay);
                delay = next_reconnect_delay(delay);
            }
        }
    }
}

fn next_reconnect_delay(current: Duration) -> Duration {
    current.saturating_mul(2).min(RECONNECT_MAX_DELAY)
}

fn start_background_reconnect(shared: &Arc<ClientShared>, message: String) {
    if !begin_reconnect(shared) {
        return;
    }

    let _ = send_terminal_event(shared, TerminalEvent::ConnectionLost { message });
    let reconnect_shared = Arc::clone(shared);
    if let Err(err) = thread::Builder::new()
        .name("vibelink-daemon-reconnector".to_string())
        .spawn(move || {
            if let Some((reader, generation)) = reconnect(&reconnect_shared) {
                info!("daemon reconnected");
                let _ = send_terminal_event(&reconnect_shared, TerminalEvent::ConnectionRestored);
                finish_reconnect(&reconnect_shared);
                reader_loop(reader, reconnect_shared, generation);
            } else {
                finish_reconnect(&reconnect_shared);
            }
        })
    {
        finish_reconnect(shared);
        error!(?err, "failed to spawn daemon reconnector");
    }
}

fn begin_reconnect(shared: &ClientShared) -> bool {
    if !reconnect_is_allowed(
        shared.shutting_down.load(Ordering::Acquire),
        shared.reconnecting.load(Ordering::Acquire),
    ) {
        return false;
    }

    shared
        .reconnecting
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
}

fn reconnect_is_allowed(shutting_down: bool, reconnecting: bool) -> bool {
    !shutting_down && !reconnecting
}

fn finish_reconnect(shared: &ClientShared) {
    shared.reconnecting.store(false, Ordering::Release);
}

fn route_daemon_message(shared: &Arc<ClientShared>, msg: DaemonToClient) {
    if let Some(req) = response_req(&msg) {
        let sender = shared
            .pending
            .lock()
            .expect("pending request mutex poisoned")
            .remove(&req);
        if let Some(sender) = sender {
            let _ = sender.try_send(msg);
        }
    } else {
        match msg {
            DaemonToClient::Output { pane_id, data } => {
                broadcast_output(shared, &pane_id.to_string(), &data);
            }
            DaemonToClient::RemotePaneLease { event } => {
                if let Some(app_handle) = &shared.app_handle {
                    let _ = app_handle.emit("remote://pane-lease", event);
                }
            }
            DaemonToClient::RemoteBrowserRequest { request } => {
                handle_remote_browser_request(shared, request);
            }
            other => {
                if let Err(err) = forward_terminal_event(shared, other) {
                    warn!(?err, "dropping terminal event");
                }
            }
        }
    }
}

fn handle_remote_browser_request(shared: &Arc<ClientShared>, request: RemoteBrowserHostRequest) {
    let shared = Arc::clone(shared);
    let _ = thread::Builder::new()
        .name("vibelink-browser-host-request".to_string())
        .spawn(move || {
            let result = shared
                .app_handle
                .as_ref()
                .ok_or_else(|| {
                    "browser_unavailable: desktop browser host is unavailable".to_string()
                })
                .and_then(|app| {
                    let manager = app
                        .state::<super::browser::ManagedBrowser>()
                        .inner()
                        .clone();
                    super::browser::handle_remote_browser_request(
                        &manager,
                        &request.method,
                        &request.payload_json,
                    )
                });
            let response = match result {
                Ok(value) => RemoteBrowserHostResponse {
                    request_id: request.request_id,
                    result_json: serde_json::to_string(&value).ok(),
                    error: None,
                },
                Err(error) => RemoteBrowserHostResponse {
                    request_id: request.request_id,
                    result_json: None,
                    error: Some(error),
                },
            };
            let mut writer = shared.writer.lock().expect("daemon writer mutex poisoned");
            let _ = write_frame(
                &mut *writer,
                &ClientToDaemon::RemoteBrowserResponse { response },
            );
        });
}

fn spawn_ws_accept_loop(listener: std::net::TcpListener, shared: Arc<ClientShared>) {
    thread::Builder::new()
        .name("vibelink-term-ws-accept".to_string())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    continue;
                };
                let shared = Arc::clone(&shared);
                let _ = thread::Builder::new()
                    .name("vibelink-term-ws-conn".to_string())
                    .spawn(move || {
                        let mut ws = match tungstenite::accept(stream) {
                            Ok(ws) => ws,
                            Err(_) => return,
                        };
                        let (tx, rx) = bounded::<Arc<[u8]>>(TERMINAL_WS_QUEUE_FRAMES);
                        let queued_bytes = Arc::new(AtomicUsize::new(0));
                        shared
                            .ws_clients
                            .lock()
                            .expect("ws clients mutex poisoned")
                            .push(TerminalWsClient {
                                sender: tx,
                                queued_bytes: Arc::clone(&queued_bytes),
                                trims: HashMap::new(),
                            });
                        while let Ok(frame) = rx.recv() {
                            queued_bytes.fetch_sub(frame.len(), Ordering::AcqRel);
                            if ws
                                .send(tungstenite::Message::Binary(frame.to_vec().into()))
                                .is_err()
                            {
                                break;
                            }
                        }
                    });
            }
        })
        .ok();
}

fn frame_output(pane_id: &str, data: &[u8]) -> Vec<u8> {
    let id = pane_id.as_bytes();
    let id_len = u16::try_from(id.len()).expect("pane id too long for output frame");
    let mut frame = Vec::with_capacity(2 + id.len() + data.len());
    frame.extend_from_slice(&id_len.to_be_bytes());
    frame.extend_from_slice(id);
    frame.extend_from_slice(data);
    frame
}

fn broadcast_output(shared: &ClientShared, pane_id: &str, data: &[u8]) {
    let base_frame: Arc<[u8]> = Arc::from(frame_output(pane_id, data).into_boxed_slice());
    let now = Instant::now();
    let mut clients = shared.ws_clients.lock().expect("ws clients mutex poisoned");
    clients.retain_mut(|client| client.deliver_output(pane_id, data, &base_frame, now));
}

fn remove_pending_request(shared: &ClientShared, req: Req) {
    shared
        .pending
        .lock()
        .expect("pending request mutex poisoned")
        .remove(&req);
}

fn fail_pending(shared: &ClientShared, message: String) {
    let pending = std::mem::take(
        &mut *shared
            .pending
            .lock()
            .expect("pending request mutex poisoned"),
    );
    for (req, sender) in pending {
        let _ = sender.try_send(DaemonToClient::Error {
            req: Some(req),
            message: message.clone(),
        });
    }
}

fn forward_terminal_event(shared: &ClientShared, msg: DaemonToClient) -> Result<()> {
    if let DaemonToClient::TaskEvent { session_id, event } = msg {
        let session_id_text = session_id.to_string();
        if let TaskSignal::AgentPrompt { prompt } = &event {
            if let Some(app_handle) = &shared.app_handle {
                app_handle.emit(
                    "vibelink://agent-prompt",
                    AgentPromptEvent {
                        session_id: session_id_text,
                        prompt: prompt.clone(),
                    },
                )?;
            }
            return Ok(());
        }
        send_terminal_event(
            shared,
            TerminalEvent::Task {
                session_id: session_id_text.clone(),
                signal: event,
            },
        )?;
        return send_terminal_event(
            shared,
            TerminalEvent::Task {
                session_id: session_id_text,
                signal: TaskSignal::BoardChanged {},
            },
        );
    }

    let event = match msg {
        DaemonToClient::PaneExited { pane_id, exit_code } => TerminalEvent::Exited {
            pane_id: pane_id.to_string(),
            exit_code,
        },
        DaemonToClient::PaneResized {
            pane_id,
            cols,
            rows,
            ..
        } => TerminalEvent::Resized {
            pane_id: pane_id.to_string(),
            cols,
            rows,
        },
        DaemonToClient::SessionChanged { session_id } => TerminalEvent::SessionChanged {
            session_id: session_id.to_string(),
        },
        other => bail!("not a terminal event: {other:?}"),
    };

    send_terminal_event(shared, event)
}

fn send_terminal_event(shared: &ClientShared, event: TerminalEvent) -> Result<()> {
    if let Some(channel) = shared
        .output_channel
        .lock()
        .expect("output channel mutex poisoned")
        .as_ref()
        .cloned()
    {
        channel.send(event)?;
    }
    Ok(())
}

fn response_req(msg: &DaemonToClient) -> Option<Req> {
    match msg {
        DaemonToClient::Pong { req } | DaemonToClient::Reply { req, .. } => Some(*req),
        DaemonToClient::Error { req, .. } => *req,
        DaemonToClient::Output { .. }
        | DaemonToClient::PaneExited { .. }
        | DaemonToClient::PaneResized { .. }
        | DaemonToClient::SessionChanged { .. }
        | DaemonToClient::RemotePaneLease { .. }
        | DaemonToClient::RemoteBrowserRequest { .. }
        | DaemonToClient::TaskEvent { .. } => None,
    }
}

pub fn parse_uuid(value: &str) -> Result<Uuid> {
    Uuid::parse_str(value).with_context(|| format!("invalid UUID {value}"))
}

fn split_daemon_stream(stream: DaemonStream) -> (LocalSocketRecvHalf, LocalSocketSendHalf) {
    let _ = stream.set_send_timeout(Some(REQUEST_TIMEOUT));
    stream.split()
}

fn reader_generation_is_current(current_generation: u64, reader_generation: u64) -> bool {
    current_generation == reader_generation
}

#[cfg(test)]
mod tests {
    use super::*;
    use interprocess::local_socket::{GenericNamespaced, ListenerOptions};

    fn test_client() -> (DaemonClient, DaemonStream) {
        let socket_name = format!("vibelink-daemon-client-test-{}", Uuid::new_v4());
        let listener_name = socket_name
            .as_str()
            .to_ns_name::<GenericNamespaced>()
            .expect("listener name");
        let connect_name = socket_name
            .as_str()
            .to_ns_name::<GenericNamespaced>()
            .expect("connect name");
        let listener = ListenerOptions::new()
            .name(listener_name)
            .create_sync()
            .expect("test listener");
        let stream = interprocess::local_socket::ConnectOptions::new()
            .name(connect_name)
            .connect_sync()
            .expect("test connect");
        let peer = listener.accept().expect("test accept");
        (DaemonClient::new(stream), peer)
    }

    #[test]
    fn output_frame_round_trips_pane_id_and_bytes() {
        let pane_id = Uuid::new_v4().to_string();
        let data = b"\x1b[31mhello\x1b[0m";

        let frame = frame_output(&pane_id, data);
        let id_len = u16::from_be_bytes([frame[0], frame[1]]) as usize;
        let decoded_id = std::str::from_utf8(&frame[2..2 + id_len]).expect("utf8 pane id");
        let decoded_data = &frame[2 + id_len..];

        assert_eq!(decoded_id, pane_id);
        assert_eq!(decoded_data, data);
    }

    fn test_ws_client(
        capacity: usize,
    ) -> (
        TerminalWsClient,
        crossbeam_channel::Receiver<Arc<[u8]>>,
        Arc<AtomicUsize>,
    ) {
        let (tx, rx) = bounded::<Arc<[u8]>>(capacity);
        let queued_bytes = Arc::new(AtomicUsize::new(0));
        (
            TerminalWsClient {
                sender: tx,
                queued_bytes: Arc::clone(&queued_bytes),
                trims: HashMap::new(),
            },
            rx,
            queued_bytes,
        )
    }

    fn frame_text(frame: &[u8]) -> String {
        let id_len = u16::from_be_bytes([frame[0], frame[1]]) as usize;
        String::from_utf8(frame[2 + id_len..].to_vec()).expect("frame utf8")
    }

    #[test]
    fn output_messages_route_to_websocket_clients() {
        let (client, _peer) = test_client();
        let (ws_client, rx, _queued_bytes) = test_ws_client(TERMINAL_WS_QUEUE_FRAMES);
        client
            .shared
            .ws_clients
            .lock()
            .expect("ws clients mutex")
            .push(ws_client);
        let pane_id = Uuid::new_v4();
        let data = b"hello".to_vec();

        route_daemon_message(
            &client.shared,
            DaemonToClient::Output {
                pane_id,
                data: data.clone(),
            },
        );

        let frame = rx.recv_timeout(Duration::from_secs(1)).expect("ws frame");
        let id_len = u16::from_be_bytes([frame[0], frame[1]]) as usize;
        let decoded_id = std::str::from_utf8(&frame[2..2 + id_len]).expect("pane id");
        assert_eq!(decoded_id, pane_id.to_string());
        assert_eq!(&frame[2 + id_len..], data.as_slice());
    }

    #[test]
    fn slow_websocket_client_queue_is_bounded() {
        let (client, _peer) = test_client();
        let (ws_client, rx, queued_bytes) = test_ws_client(TERMINAL_WS_QUEUE_FRAMES);
        client
            .shared
            .ws_clients
            .lock()
            .expect("ws clients mutex")
            .push(ws_client);
        let pane_id = Uuid::new_v4();
        let data = vec![b'x'; 64 * 1024];

        for _ in 0..300 {
            route_daemon_message(
                &client.shared,
                DaemonToClient::Output {
                    pane_id,
                    data: data.clone(),
                },
            );
        }

        // The byte budget bounds the queue well below the 300 sent frames.
        assert!(rx.len() < 300);
        assert!(queued_bytes.load(Ordering::Acquire) <= TERMINAL_WS_QUEUE_MAX_BYTES);
        let dropped_bytes = client.shared.ws_clients.lock().expect("ws clients mutex")[0]
            .trims
            .get(&pane_id.to_string())
            .map(|state| state.dropped_bytes)
            .expect("dropped output count");
        assert!(dropped_bytes > 0);

        // Simulate the connection thread catching up.
        while rx.try_recv().is_ok() {}
        queued_bytes.store(0, Ordering::Release);

        route_daemon_message(
            &client.shared,
            DaemonToClient::Output {
                pane_id,
                data: b"tail".to_vec(),
            },
        );

        // ONE merged frame carries the notice AND the live data; the notice
        // never occupies a queue slot of its own.
        let frame = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("merged frame");
        let text = frame_text(&frame);
        assert!(text.contains("terminal output trimmed"));
        assert!(text.ends_with("tail"));
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn trim_notice_is_merged_and_throttled() {
        let (mut client, rx, _queued_bytes) = test_ws_client(8);
        let pane_id = "pane-1";
        let now = Instant::now();

        client.record_dropped(pane_id, 512);
        let base: Arc<[u8]> = Arc::from(frame_output(pane_id, b"data").into_boxed_slice());
        assert!(client.deliver_output(pane_id, b"data", &base, now));
        let text = frame_text(&rx.try_recv().expect("merged frame"));
        assert!(text.contains("terminal output trimmed (512 bytes)"));
        assert!(text.ends_with("data"));

        // Within the throttle window a new lag stays silent...
        client.record_dropped(pane_id, 64);
        let base: Arc<[u8]> = Arc::from(frame_output(pane_id, b"more").into_boxed_slice());
        assert!(client.deliver_output(pane_id, b"more", &base, now));
        let text = frame_text(&rx.try_recv().expect("plain frame"));
        assert!(!text.contains("terminal output trimmed"));
        assert_eq!(text, "more");

        // ...and reports the accumulated total once the window elapses.
        client
            .trims
            .get_mut(pane_id)
            .expect("trim state")
            .last_notice_at = now.checked_sub(TRIM_NOTICE_MIN_INTERVAL);
        let base: Arc<[u8]> = Arc::from(frame_output(pane_id, b"late").into_boxed_slice());
        assert!(client.deliver_output(pane_id, b"late", &base, now));
        let text = frame_text(&rx.try_recv().expect("late merged frame"));
        assert!(text.contains("terminal output trimmed (64 bytes)"));
        assert!(text.ends_with("late"));
    }

    #[test]
    fn websocket_queue_is_byte_bounded() {
        let (mut client, rx, _queued_bytes) = test_ws_client(TERMINAL_WS_QUEUE_FRAMES);
        let pane_id = "pane-1";
        let data = vec![b'x'; 1024 * 1024];
        let base: Arc<[u8]> = Arc::from(frame_output(pane_id, &data).into_boxed_slice());
        let now = Instant::now();

        for _ in 0..10 {
            assert!(client.deliver_output(pane_id, &data, &base, now));
        }

        assert!(rx.len() >= 1);
        assert!(rx.len() < 10);
        let dropped = client.trims.get(pane_id).expect("trim state").dropped_bytes;
        assert!(dropped > 0);
    }

    #[test]
    fn terminal_events_use_frontend_field_names() {
        let exited = serde_json::to_value(TerminalEvent::Exited {
            pane_id: "pane-2".to_string(),
            exit_code: Some(7),
        })
        .expect("serialize exited terminal event");

        assert_eq!(exited["kind"], "exited");
        assert_eq!(exited["paneId"], "pane-2");
        assert_eq!(exited["exitCode"], 7);
        assert!(exited.get("pane_id").is_none());

        let resized = serde_json::to_value(TerminalEvent::Resized {
            pane_id: "pane-2".to_string(),
            cols: 200,
            rows: 32,
        })
        .expect("serialize resized terminal event");

        assert_eq!(resized["kind"], "resized");
        assert_eq!(resized["paneId"], "pane-2");
        assert_eq!(resized["cols"], 200);
        assert_eq!(resized["rows"], 32);
        assert!(resized.get("pane_id").is_none());
        assert!(exited.get("exit_code").is_none());

        let session_changed = serde_json::to_value(TerminalEvent::SessionChanged {
            session_id: "session-1".to_string(),
        })
        .expect("serialize session changed");

        assert_eq!(session_changed["kind"], "sessionChanged");
        assert_eq!(session_changed["sessionId"], "session-1");
        assert!(session_changed.get("session_id").is_none());

        let task = serde_json::to_value(TerminalEvent::Task {
            session_id: "session-1".to_string(),
            signal: TaskSignal::Done {
                task_id: "task-1".to_string(),
                commit_msg: Some("done".to_string()),
                result_summary: Some("said hi".to_string()),
                pane_id: None,
            },
        })
        .expect("serialize task terminal event");

        assert_eq!(task["kind"], "task");
        assert_eq!(task["sessionId"], "session-1");
        assert_eq!(task["signal"]["kind"], "done");
        assert_eq!(task["signal"]["taskId"], "task-1");
        assert_eq!(task["signal"]["commitMsg"], "done");
        assert_eq!(task["signal"]["resultSummary"], "said hi");
        assert!(task.get("session_id").is_none());
    }
    #[test]
    fn request_timeout_allows_large_replies() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(10));
    }

    #[test]
    fn request_timeout_removes_only_own_pending_request() {
        let (client, _peer) = test_client();
        let (other_tx, _other_rx) = bounded(1);
        client
            .shared
            .pending
            .lock()
            .expect("pending mutex")
            .insert(99, other_tx);

        let error = client
            .request_with_timeout(
                42,
                ClientToDaemon::Ping { req: 42 },
                Duration::from_millis(10),
            )
            .expect_err("request should time out");

        assert!(error.to_string().contains("timed out"));
        let pending = client.shared.pending.lock().expect("pending mutex");
        assert!(!pending.contains_key(&42));
        assert!(pending.contains_key(&99));
        assert!(!client.shared.reconnecting.load(Ordering::Acquire));
    }

    #[test]
    fn reconnect_delay_doubles_until_cap() {
        assert_eq!(
            next_reconnect_delay(RECONNECT_DELAY),
            Duration::from_millis(500)
        );
        assert_eq!(
            next_reconnect_delay(Duration::from_secs(8)),
            RECONNECT_MAX_DELAY
        );
        assert_eq!(
            next_reconnect_delay(RECONNECT_MAX_DELAY),
            RECONNECT_MAX_DELAY
        );
    }

    #[test]
    fn stale_reader_generation_is_not_current() {
        assert!(reader_generation_is_current(3, 3));
        assert!(!reader_generation_is_current(4, 3));
    }

    #[test]
    fn reconnect_permission_rejects_shutdown_and_existing_reconnect() {
        assert!(reconnect_is_allowed(false, false));
        assert!(!reconnect_is_allowed(true, false));
        assert!(!reconnect_is_allowed(false, true));
    }

    #[test]
    fn response_req_extracts_correlated_messages_only() {
        assert_eq!(response_req(&DaemonToClient::Pong { req: 4 }), Some(4));
        assert_eq!(
            response_req(&DaemonToClient::Reply {
                req: 9,
                result: ReplyResult::Ok,
            }),
            Some(9)
        );
        assert_eq!(
            response_req(&DaemonToClient::Error {
                req: Some(11),
                message: "bad".to_string(),
            }),
            Some(11)
        );
        assert_eq!(
            response_req(&DaemonToClient::Output {
                pane_id: Uuid::new_v4(),
                data: vec![1, 2, 3],
            }),
            None
        );
        assert_eq!(
            response_req(&DaemonToClient::TaskEvent {
                session_id: Uuid::new_v4(),
                event: TaskSignal::Note {
                    task_id: "task-1".to_string(),
                    message: "working".to_string(),
                    pane_id: None,
                },
            }),
            None
        );
    }
}

use crate::app::authorization::AuthorizationSnapshot;
use crate::protocol::{
    constant_time_eq, read_frame, write_frame, ClientKind, ClientToDaemon, DaemonToClient,
    RemoteBrowserHostRequest, RemoteBrowserHostResponse, ReplyResult, Req, TaskSignal,
};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chrono::{Duration as ChronoDuration, Utc};
use crossbeam_channel::{bounded, Sender, TrySendError};
use interprocess::local_socket::{
    prelude::*, RecvHalf as LocalSocketRecvHalf, SendHalf as LocalSocketSendHalf,
};
use rand::{rngs::OsRng, RngCore};
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
    ensure_daemon_for, ensure_daemon_with_recovery_for, DaemonStream, StartupRecoveryBudget,
};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const RECONNECT_DELAY: Duration = Duration::from_millis(250);
const RECONNECT_MAX_DELAY: Duration = Duration::from_secs(10);
// A renderer can stop reading while WebView2 is busy or suspended. Keep each
// local client bounded by frames AND bytes. Every frame carries its pane
// cursor, so a later frame makes any overflow observable and recoverable.
const TERMINAL_WS_QUEUE_FRAMES: usize = 1024;
const TERMINAL_WS_QUEUE_MAX_BYTES: usize = 4 * 1024 * 1024;

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
    AuthorizationChanged {
        code: String,
        #[serde(rename = "policyEpoch")]
        policy_epoch: u64,
    },
    ConnectionRestored,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentPromptEvent {
    session_id: String,
    prompt: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeChangedEvent {
    method: String,
    operation_id: String,
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
    ws_token: [u8; 32],
    ws_port: u16,
    ws_clients: Mutex<Vec<TerminalWsClient>>,
    next_req: AtomicU64,
    reconnecting: AtomicBool,
    shutting_down: AtomicBool,
    connection_generation: AtomicU64,
    client_kind: ClientKind,
}

struct TerminalWsClient {
    sender: Sender<Arc<[u8]>>,
    queued_bytes: Arc<AtomicUsize>,
}

impl TerminalWsClient {
    /// Delivers one pane output frame. A full queue drops the frame instead of
    /// blocking the daemon; the next delivered cursor exposes the gap so the
    /// renderer can replace the pane from an atomic daemon snapshot.
    fn deliver_output(&self, frame: Arc<[u8]>) -> bool {
        let frame_len = frame.len();
        if self
            .queued_bytes
            .load(Ordering::Acquire)
            .saturating_add(frame_len)
            > TERMINAL_WS_QUEUE_MAX_BYTES
        {
            return true;
        }
        match self.sender.try_send(frame) {
            Ok(()) => {
                self.queued_bytes.fetch_add(frame_len, Ordering::AcqRel);
                true
            }
            Err(TrySendError::Full(_)) => true,
            Err(TrySendError::Disconnected(_)) => false,
        }
    }
}

impl DaemonClient {
    pub fn new(stream: DaemonStream) -> Self {
        Self::new_with_kind(stream, ClientKind::App)
    }

    pub fn new_with_kind(stream: DaemonStream, client_kind: ClientKind) -> Self {
        Self::new_inner(stream, None, client_kind)
    }

    pub fn new_with_app(stream: DaemonStream, app_handle: AppHandle) -> Self {
        Self::new_inner(stream, Some(app_handle), ClientKind::App)
    }

    fn new_inner(
        stream: DaemonStream,
        app_handle: Option<AppHandle>,
        client_kind: ClientKind,
    ) -> Self {
        let register_browser_host = app_handle.is_some();
        let (reader, writer) = split_daemon_stream(stream);
        let listener =
            std::net::TcpListener::bind("127.0.0.1:0").expect("bind terminal ws listener");
        let ws_port = listener.local_addr().expect("ws local addr").port();
        let mut ws_token = [0_u8; 32];
        OsRng.fill_bytes(&mut ws_token);
        let shared = Arc::new(ClientShared {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            output_channel: Mutex::new(None),
            app_handle,
            ws_token,
            ws_port,
            ws_clients: Mutex::new(Vec::new()),
            next_req: AtomicU64::new(1),
            reconnecting: AtomicBool::new(false),
            shutting_down: AtomicBool::new(false),
            connection_generation: AtomicU64::new(0),
            client_kind,
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

    pub fn ws_token(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.shared.ws_token)
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

    pub fn worktree_rpc<T: Serialize>(
        &self,
        operation_id: Uuid,
        method: &str,
        payload: &T,
    ) -> Result<String> {
        self.worktree_rpc_with_timeout(operation_id, method, payload, REQUEST_TIMEOUT)
    }

    pub fn worktree_rpc_with_timeout<T: Serialize>(
        &self,
        operation_id: Uuid,
        method: &str,
        payload: &T,
        timeout: Duration,
    ) -> Result<String> {
        let payload_json = serde_json::to_string(payload).context("serialize worktree request")?;
        let req = self.next_req();
        match self.request_with_timeout(
            req,
            ClientToDaemon::Worktree {
                req,
                operation_id,
                method: method.to_string(),
                payload_json,
            },
            timeout,
        )? {
            DaemonToClient::Reply {
                req: reply_req,
                result: ReplyResult::Worktree(response),
            } if reply_req == req => Ok(response),
            DaemonToClient::Error { message, .. } => bail!(message),
            other => bail!("unexpected worktree response: {other:?}"),
        }
    }

    pub fn send_authorization_heartbeat(&self, mut snapshot: AuthorizationSnapshot) -> Result<()> {
        let heartbeat_cap = Utc::now() + ChronoDuration::seconds(90);
        if snapshot.lease_until > heartbeat_cap {
            snapshot.lease_until = heartbeat_cap;
        }
        self.send(ClientToDaemon::AuthorizationHeartbeat {
            snapshot: snapshot.into(),
        })
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
            let stream =
                ensure_daemon_for(self.shared.client_kind).context("spawn fresh daemon")?;
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
            Ok(msg) => {
                if !reader_generation_is_current(
                    shared.connection_generation.load(Ordering::Acquire),
                    generation,
                ) {
                    break;
                }
                route_daemon_message(&shared, msg)
            }
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

        match ensure_daemon_with_recovery_for(&mut startup_recovery, shared.client_kind) {
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
            DaemonToClient::Output {
                pane_id,
                pane_generation,
                output_sequence,
                data,
            } => {
                broadcast_output(
                    shared,
                    &pane_id.to_string(),
                    pane_generation,
                    output_sequence,
                    &data,
                );
            }
            DaemonToClient::RemotePaneLease { event } => {
                if let Some(app_handle) = &shared.app_handle {
                    let _ = app_handle.emit("remote://pane-lease", event);
                }
            }
            DaemonToClient::WorktreeChanged {
                method,
                operation_id,
            } => {
                if let Some(app_handle) = &shared.app_handle {
                    let _ = app_handle.emit(
                        "worktree://changed",
                        WorktreeChangedEvent {
                            method,
                            operation_id: operation_id.to_string(),
                        },
                    );
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
                let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
                let shared = Arc::clone(&shared);
                let _ = thread::Builder::new()
                    .name("vibelink-term-ws-conn".to_string())
                    .spawn(move || {
                        let mut ws = match tungstenite::accept(stream) {
                            Ok(ws) => ws,
                            Err(_) => return,
                        };
                        let authenticated = match ws.read() {
                            Ok(tungstenite::Message::Text(token)) => {
                                websocket_token_matches(&shared.ws_token, token.as_ref())
                            }
                            _ => false,
                        };
                        if !authenticated {
                            let _ = ws.close(None);
                            return;
                        }

                        let (tx, rx) = bounded::<Arc<[u8]>>(TERMINAL_WS_QUEUE_FRAMES);
                        let queued_bytes = Arc::new(AtomicUsize::new(0));
                        shared
                            .ws_clients
                            .lock()
                            .expect("ws clients mutex poisoned")
                            .push(TerminalWsClient {
                                sender: tx,
                                queued_bytes: Arc::clone(&queued_bytes),
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

fn websocket_token_matches(expected: &[u8; 32], encoded: &str) -> bool {
    let Ok(provided) = URL_SAFE_NO_PAD.decode(encoded) else {
        return false;
    };
    constant_time_eq(expected, &provided)
}

fn frame_output(pane_id: &str, pane_generation: u64, output_sequence: u64, data: &[u8]) -> Vec<u8> {
    let id = pane_id.as_bytes();
    let id_len = u16::try_from(id.len()).expect("pane id too long for output frame");
    let mut frame = Vec::with_capacity(2 + id.len() + 16 + data.len());
    frame.extend_from_slice(&id_len.to_be_bytes());
    frame.extend_from_slice(id);
    frame.extend_from_slice(&pane_generation.to_be_bytes());
    frame.extend_from_slice(&output_sequence.to_be_bytes());
    frame.extend_from_slice(data);
    frame
}

fn broadcast_output(
    shared: &ClientShared,
    pane_id: &str,
    pane_generation: u64,
    output_sequence: u64,
    data: &[u8],
) {
    let base_frame: Arc<[u8]> =
        Arc::from(frame_output(pane_id, pane_generation, output_sequence, data).into_boxed_slice());
    let mut clients = shared.ws_clients.lock().expect("ws clients mutex poisoned");
    clients.retain_mut(|client| client.deliver_output(Arc::clone(&base_frame)));
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
        DaemonToClient::AuthorizationChanged { code, policy_epoch } => {
            TerminalEvent::AuthorizationChanged { code, policy_epoch }
        }
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
        DaemonToClient::Challenge { .. }
        | DaemonToClient::Authenticated { .. }
        | DaemonToClient::AuthorizationChanged { .. }
        | DaemonToClient::Output { .. }
        | DaemonToClient::PaneExited { .. }
        | DaemonToClient::PaneResized { .. }
        | DaemonToClient::SessionChanged { .. }
        | DaemonToClient::WorktreeChanged { .. }
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
    #[test]
    fn terminal_websocket_requires_exact_process_token() {
        let token = [0x6a_u8; 32];
        let encoded = URL_SAFE_NO_PAD.encode(token);

        assert!(websocket_token_matches(&token, &encoded));
        assert!(!websocket_token_matches(
            &token,
            &URL_SAFE_NO_PAD.encode([0x6b_u8; 32])
        ));
        assert!(!websocket_token_matches(&token, "not-base64!"));
        assert!(!websocket_token_matches(
            &token,
            &URL_SAFE_NO_PAD.encode([0x6a_u8; 31])
        ));
    }

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

        let frame = frame_output(&pane_id, 7, 42, data);
        let id_len = u16::from_be_bytes([frame[0], frame[1]]) as usize;
        let cursor_start = 2 + id_len;
        let decoded_id = std::str::from_utf8(&frame[2..cursor_start]).expect("utf8 pane id");
        let decoded_generation = u64::from_be_bytes(
            frame[cursor_start..cursor_start + 8]
                .try_into()
                .expect("generation bytes"),
        );
        let decoded_sequence = u64::from_be_bytes(
            frame[cursor_start + 8..cursor_start + 16]
                .try_into()
                .expect("sequence bytes"),
        );
        let decoded_data = &frame[cursor_start + 16..];

        assert_eq!(decoded_id, pane_id);
        assert_eq!(decoded_generation, 7);
        assert_eq!(decoded_sequence, 42);
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
            },
            rx,
            queued_bytes,
        )
    }

    fn frame_cursor(frame: &[u8]) -> (u64, u64, usize) {
        let id_len = u16::from_be_bytes([frame[0], frame[1]]) as usize;
        let cursor_start = 2 + id_len;
        let generation = u64::from_be_bytes(
            frame[cursor_start..cursor_start + 8]
                .try_into()
                .expect("generation bytes"),
        );
        let sequence = u64::from_be_bytes(
            frame[cursor_start + 8..cursor_start + 16]
                .try_into()
                .expect("sequence bytes"),
        );
        (generation, sequence, cursor_start + 16)
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
                pane_generation: 7,
                output_sequence: 42,
                data: data.clone(),
            },
        );

        let frame = rx.recv_timeout(Duration::from_secs(1)).expect("ws frame");
        let id_len = u16::from_be_bytes([frame[0], frame[1]]) as usize;
        let decoded_id = std::str::from_utf8(&frame[2..2 + id_len]).expect("pane id");
        let (generation, sequence, data_start) = frame_cursor(&frame);
        assert_eq!(decoded_id, pane_id.to_string());
        assert_eq!(generation, 7);
        assert_eq!(sequence, 42);
        assert_eq!(&frame[data_start..], data.as_slice());
    }

    #[test]
    fn slow_websocket_client_queue_is_bounded_and_exposes_sequence_gap() {
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

        for output_sequence in 1..=300 {
            route_daemon_message(
                &client.shared,
                DaemonToClient::Output {
                    pane_id,
                    pane_generation: 7,
                    output_sequence,
                    data: data.clone(),
                },
            );
        }

        assert!(rx.len() < 300);
        assert!(queued_bytes.load(Ordering::Acquire) <= TERMINAL_WS_QUEUE_MAX_BYTES);
        let queued = rx.try_iter().collect::<Vec<_>>();
        let (_, last_delivered_sequence, _) =
            frame_cursor(queued.last().expect("at least one queued frame"));
        assert!(last_delivered_sequence < 300);
        queued_bytes.store(0, Ordering::Release);

        route_daemon_message(
            &client.shared,
            DaemonToClient::Output {
                pane_id,
                pane_generation: 7,
                output_sequence: 301,
                data: b"tail".to_vec(),
            },
        );

        let frame = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("post-overflow frame");
        let (generation, sequence, data_start) = frame_cursor(&frame);
        assert_eq!(generation, 7);
        assert_eq!(sequence, 301);
        assert!(last_delivered_sequence.saturating_add(1) < sequence);
        assert_eq!(&frame[data_start..], b"tail");
    }

    #[test]
    fn websocket_queue_is_byte_bounded() {
        let (client, rx, _queued_bytes) = test_ws_client(TERMINAL_WS_QUEUE_FRAMES);
        let pane_id = "pane-1";
        let data = vec![b'x'; 1024 * 1024];

        for output_sequence in 1..=10 {
            let frame: Arc<[u8]> =
                Arc::from(frame_output(pane_id, 1, output_sequence, &data).into_boxed_slice());
            assert!(client.deliver_output(frame));
        }

        assert!(rx.len() >= 1);
        assert!(rx.len() < 10);
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
                pane_generation: 1,
                output_sequence: 1,
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

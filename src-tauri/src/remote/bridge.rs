use super::v2::{
    generated::{
        TerminalAckParams, TerminalInputParams, TerminalLeaseClaimParams, TerminalLeaseRecord,
        TerminalLeaseReleaseParams, TerminalLeaseStatusParams, TerminalSnapshotParams,
        TerminalSnapshotResult, TerminalSubscribeParams, TerminalSubscribeResult,
        TerminalUnsubscribeParams,
    },
    secure::{SecureFrameKind, SecureHandshake, SecureTransport},
    wire::{
        BinaryChannel, BinaryFrame, DomainSequenceValidator, OperationReplayWindow, SequenceError,
        TerminalAckWindow, TerminalFlowError, TerminalRecordDecision, FLAG_FINAL, FLAG_RESYNC,
        MAX_BINARY_PAYLOAD_BYTES, MAX_SEQUENCE_DOMAINS,
    },
    CONTRACT_SHA256 as V2_CONTRACT_SHA256, PROTOCOL_VERSION as V2_PROTOCOL_VERSION,
    SUBPROTOCOL as V2_SUBPROTOCOL,
};
use super::{
    devices::{TERMINAL_INPUT_GRANT, TERMINAL_VIEW_GRANT},
    layout_order::pane_order,
    protocol::{
        encode_buffer, frame_pane_output, AuthRequest, ClientMessage, PaneDto, ServerMessage,
        WorkspaceDto, PROTOCOL_VERSION, SUBPROTOCOL,
    },
    server::{desktop_name, RemoteShared},
};
use crate::dedicated_cli::{parse_args as parse_cli_args, CliControlRequest};
use crate::{
    app::spawn_daemon,
    protocol::{
        read_frame, write_frame, ClientToDaemon, DaemonToClient, PaneCommandOrigin, PaneMeta,
        RemoteConnectionCleanupRequest, RemotePaneLease, RemotePaneLeaseClaimRequest,
        RemotePaneLeaseEvent, RemotePaneLeaseEventKind, RemotePaneLeaseEventReason,
        RemotePaneLeaseReleaseRequest, RemotePaneLeaseRenewRequest, RemotePaneLeaseResult,
        RemotePaneLeaseStatusRequest, ReplyResult, SessionMeta,
    },
};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use crossbeam_channel::{bounded, unbounded, Receiver, Sender, TryRecvError, TrySendError};
use interprocess::local_socket::prelude::*;
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    fs, io,
    net::TcpStream,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    handshake::server::{Request, Response},
    Message, WebSocket,
};
use uuid::Uuid;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const DAEMON_REPLY_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_TIMEOUT: Duration = Duration::from_millis(30);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(15);
const KEEPALIVE_DEADLINE: Duration = Duration::from_secs(45);
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_millis(250);
const REMOTE_LEASE_RENEW_INTERVAL: Duration = Duration::from_secs(5);
const DAEMON_OUTPUT_QUEUE_CAPACITY: usize = 1024;
const DAEMON_OUTPUT_QUEUE_MAX_BYTES: usize = 2 * 1024 * 1024;
const PUSH_QUEUE_CAPACITY: usize = 1024;
const MAX_CONTROL_FRAMES_PER_LOOP: usize = 32;
const MAX_PUSH_FRAMES_PER_LOOP: usize = 32;
const MAX_OUTPUT_FRAMES_PER_LOOP: usize = 1;
const MAX_OUTPUT_BYTES_PER_LOOP: usize = 48 * 1024;
const MAX_TERMINAL_COALESCE_BYTES: usize = 48 * 1024;
const TERMINAL_MAX_UNACKED_BYTES_PER_STREAM: usize = 512 * 1024;
const TERMINAL_MAX_UNACKED_BYTES_PER_CONNECTION: usize = 2 * 1024 * 1024;
const MAX_REMOTE_MESSAGE_BYTES: usize = 1024 * 1024;
#[derive(Clone, Debug)]
struct V2Subscription {
    workspace_id: Uuid,
    pane_id: Uuid,
    stream_id: u64,
}

struct PendingTerminalOutput {
    pane_id: Uuid,
    data: Vec<u8>,
    offset: usize,
}

#[derive(Default)]
struct V2OutputPump {
    pending: Option<PendingTerminalOutput>,
    buffers: HashMap<u64, Vec<u8>>,
    order: VecDeque<u64>,
}

impl V2OutputPump {
    fn purge(&mut self, pane_id: Uuid, stream_id: u64) {
        if self
            .pending
            .as_ref()
            .is_some_and(|pending| pending.pane_id == pane_id)
        {
            self.pending = None;
        }
        self.buffers.remove(&stream_id);
        self.order.retain(|candidate| *candidate != stream_id);
    }
}

#[derive(Default)]
struct RemoteLeaseProjection {
    by_pane: HashMap<Uuid, RemotePaneLease>,
}

impl RemoteLeaseProjection {
    fn record(&mut self, lease: RemotePaneLease) {
        self.by_pane.insert(lease.pane_id, lease);
    }

    fn remove_pane(&mut self, pane_id: Uuid) {
        self.by_pane.remove(&pane_id);
    }

    fn by_lease_id(&self, lease_id: Uuid) -> Option<&RemotePaneLease> {
        self.by_pane
            .values()
            .find(|lease| lease.lease_id == lease_id)
    }
}

const MAX_REMOTE_FRAME_BYTES: usize = 1024 * 1024;

type RemoteSocket = WebSocket<StreamOwned<ServerConnection, TcpStream>>;

struct QueuedDaemonOutput {
    message: DaemonToClient,
    reserved_bytes: usize,
}

struct DaemonSenders {
    control: Sender<DaemonToClient>,
    output: Sender<QueuedDaemonOutput>,
    output_bytes: Arc<AtomicUsize>,
    dropped_output: Arc<Mutex<HashMap<Uuid, u64>>>,
}

struct DaemonInbox {
    control: Receiver<DaemonToClient>,
    output: Receiver<QueuedDaemonOutput>,
    output_bytes: Arc<AtomicUsize>,
    dropped_output: Arc<Mutex<HashMap<Uuid, u64>>>,
    deferred_control: VecDeque<DaemonToClient>,
}

impl DaemonInbox {
    fn try_control(&mut self) -> Result<Option<DaemonToClient>> {
        if let Some(message) = self.deferred_control.pop_front() {
            return Ok(Some(message));
        }
        match self.control.try_recv() {
            Ok(message) => Ok(Some(message)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => bail!("remote daemon connection closed"),
        }
    }

    fn recv_new_control_timeout(&self, timeout: Duration) -> Result<DaemonToClient> {
        self.control.recv_timeout(timeout).map_err(Into::into)
    }

    fn defer_control(&mut self, message: DaemonToClient) {
        self.deferred_control.push_back(message);
    }

    fn has_pending_control(&self) -> bool {
        !self.deferred_control.is_empty() || !self.control.is_empty()
    }

    fn try_output(&self) -> Result<Option<DaemonToClient>> {
        match self.output.try_recv() {
            Ok(output) => {
                self.output_bytes
                    .fetch_sub(output.reserved_bytes, Ordering::AcqRel);
                Ok(Some(output.message))
            }
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => bail!("remote daemon connection closed"),
        }
    }

    #[cfg(test)]
    fn queued_output_bytes(&self) -> usize {
        self.output_bytes.load(Ordering::Acquire)
    }

    fn take_all_output_drops(&self) -> HashMap<Uuid, u64> {
        std::mem::take(
            &mut *self
                .dropped_output
                .lock()
                .expect("remote output drops mutex"),
        )
    }
}

fn daemon_channels(output_capacity: usize) -> (DaemonSenders, DaemonInbox) {
    let (control_tx, control_rx) = unbounded();
    let (output_tx, output_rx) = bounded(output_capacity);
    let output_bytes = Arc::new(AtomicUsize::new(0));
    let dropped_output = Arc::new(Mutex::new(HashMap::new()));
    (
        DaemonSenders {
            control: control_tx,
            output: output_tx,
            output_bytes: Arc::clone(&output_bytes),
            dropped_output: Arc::clone(&dropped_output),
        },
        DaemonInbox {
            control: control_rx,
            output: output_rx,
            output_bytes,
            deferred_control: VecDeque::new(),
            dropped_output,
        },
    )
}

fn route_daemon_message(senders: &DaemonSenders, message: DaemonToClient) -> bool {
    match message {
        DaemonToClient::Output { pane_id, data } => {
            let bytes = data.len();
            let reserved = senders
                .output_bytes
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
                    (bytes <= DAEMON_OUTPUT_QUEUE_MAX_BYTES.saturating_sub(current))
                        .then_some(current + bytes)
                })
                .is_ok();
            if reserved {
                match senders.output.try_send(QueuedDaemonOutput {
                    message: DaemonToClient::Output { pane_id, data },
                    reserved_bytes: bytes,
                }) {
                    Ok(()) => return true,
                    Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {
                        senders.output_bytes.fetch_sub(bytes, Ordering::AcqRel);
                    }
                }
            }
            let mut drops = senders
                .dropped_output
                .lock()
                .expect("remote output drops mutex");
            let skipped = u64::try_from(bytes.div_ceil(MAX_TERMINAL_COALESCE_BYTES))
                .unwrap_or(u64::MAX)
                .max(1);
            let count = drops.entry(pane_id).or_default();
            *count = count.saturating_add(skipped);
            false
        }
        control => senders.control.send(control).is_ok(),
    }
}

pub fn handle_connection(
    stream: TcpStream,
    tls_config: Arc<ServerConfig>,
    shared: Arc<RemoteShared>,
) -> Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(HELLO_TIMEOUT))?;
    stream.set_write_timeout(Some(SOCKET_WRITE_TIMEOUT))?;
    let tls = StreamOwned::new(ServerConnection::new(tls_config)?, stream);
    let websocket_config = tungstenite::protocol::WebSocketConfig::default()
        .read_buffer_size(32 * 1024)
        .write_buffer_size(32 * 1024)
        .max_write_buffer_size(2 * 1024 * 1024)
        .max_message_size(Some(MAX_REMOTE_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_REMOTE_FRAME_BYTES));
    let negotiated_v2 = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let negotiation = Arc::clone(&negotiated_v2);
    let mut ws = tungstenite::accept_hdr_with_config(
        tls,
        move |request: &Request, mut response: Response| {
            let offered = request
                .headers()
                .get("sec-websocket-protocol")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .collect::<Vec<_>>();
            let selected = if offered.contains(&V2_SUBPROTOCOL) {
                negotiation.store(true, std::sync::atomic::Ordering::Release);
                V2_SUBPROTOCOL
            } else if offered.contains(&SUBPROTOCOL) {
                SUBPROTOCOL
            } else {
                return Err(tungstenite::http::Response::builder()
                    .status(400)
                    .body(Some("missing VibeLink remote subprotocol".to_string()))
                    .expect("error response"));
            };
            response.headers_mut().insert(
                "sec-websocket-protocol",
                selected.parse().expect("subprotocol header"),
            );
            Ok(response)
        },
        Some(websocket_config),
    )
    .context("accept remote websocket")?;
    if negotiated_v2.load(std::sync::atomic::Ordering::Acquire) {
        return handle_v2_connection(ws, shared);
    }

    let first = ws.read().context("read remote hello")?;
    let hello: ClientMessage = match first {
        Message::Text(text) => serde_json::from_str(text.as_ref()).context("parse remote hello")?,
        _ => bail!("remote hello must be a text frame"),
    };
    let (device_id, device_token, grants) = authenticate(&mut ws, &shared, hello)?;
    send_json(
        &mut ws,
        &ServerMessage::Authed {
            device_id: device_id.clone(),
            device_token,
            desktop_name: desktop_name(),
            protocol_version: PROTOCOL_VERSION,
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            capabilities: vec!["paneLease".to_string()],
        },
    )?;

    ws.get_mut().sock.set_read_timeout(Some(POLL_TIMEOUT))?;
    let (mut daemon_writer, mut daemon_inbox) = open_daemon_connection()?;
    let client_key = Uuid::new_v4();
    let (push_tx, push_rx) = bounded(PUSH_QUEUE_CAPACITY);
    let close_requested = Arc::new(AtomicBool::new(false));
    shared
        .client_close_requests
        .lock()
        .expect("remote close requests mutex")
        .insert(client_key, Arc::clone(&close_requested));
    shared
        .client_senders
        .lock()
        .expect("remote clients mutex")
        .insert(client_key, push_tx);
    shared
        .client_devices
        .lock()
        .expect("remote client devices mutex")
        .insert(client_key, device_id.clone());

    let result = run_authenticated(
        &mut ws,
        &mut daemon_writer,
        &mut daemon_inbox,
        &push_rx,
        &close_requested,
        &shared,
        client_key,
        &device_id,
        &grants,
    );
    if let Err(error) =
        cleanup_remote_connection(&mut daemon_writer, &mut daemon_inbox, client_key, u64::MAX)
    {
        tracing::warn!(?error, %client_key, "failed to clean up remote daemon connection");
    }
    shared
        .client_senders
        .lock()
        .expect("remote clients mutex")
        .remove(&client_key);
    shared
        .client_close_requests
        .lock()
        .expect("remote close requests mutex")
        .remove(&client_key);
    shared
        .client_devices
        .lock()
        .expect("remote client devices mutex")
        .remove(&client_key);
    result
}

fn authenticate(
    ws: &mut RemoteSocket,
    shared: &RemoteShared,
    hello: ClientMessage,
) -> Result<(String, Option<String>, Vec<String>)> {
    let ClientMessage::Hello {
        protocol_version,
        auth,
    } = hello
    else {
        send_error(ws, "authFailed", "hello must be the first message", None)?;
        bail!("hello was not first message");
    };
    if protocol_version != PROTOCOL_VERSION {
        send_error(
            ws,
            "protocolMismatch",
            "unsupported remote protocol version",
            None,
        )?;
        bail!("protocol mismatch");
    }
    let mut devices = shared.devices.lock().expect("remote devices mutex");
    match auth {
        AuthRequest::Pair { code, device_name } => {
            match devices.consume_pairing(&code, &device_name) {
                Ok((record, token)) => Ok((record.id, Some(token), record.grants)),
                Err(error) => {
                    let code = auth_error_code(&error);
                    send_error(ws, code, "remote pairing failed", None)?;
                    bail!("remote pairing failed: {code}")
                }
            }
        }
        AuthRequest::Token { device_id, token } => match devices.verify_token(&device_id, &token) {
            Ok(true) => {
                let grants = devices.grants_for(&device_id).unwrap_or_default();
                Ok((device_id, None, grants))
            }
            _ => {
                send_error(ws, "authFailed", "remote authentication failed", None)?;
                bail!("remote token authentication failed")
            }
        },
    }
}

fn auth_error_code(error: &super::devices::AuthFailure) -> &'static str {
    match error {
        super::devices::AuthFailure::Failed => "authFailed",
        super::devices::AuthFailure::PairExpired => "pairExpired",
        super::devices::AuthFailure::RateLimited => "rateLimited",
    }
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2AuthRequest {
    mode: String,
    code: Option<String>,
    device_name: Option<String>,
    device_id: Option<String>,
    revocation_epoch: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct V2Envelope {
    version: u16,
    request_id: String,
    domain: String,
    method: String,
    operation_id: String,
    sequence: u64,
    revocation_epoch: u64,
    #[serde(default)]
    payload: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct V2Response<'a> {
    version: u16,
    request_id: &'a str,
    domain: &'a str,
    method: &'a str,
    operation_id: &'a str,
    sequence: u64,
    revocation_epoch: u64,
    payload: Value,
    error: Option<Value>,
}

fn handle_v2_connection(mut ws: RemoteSocket, shared: Arc<RemoteShared>) -> Result<()> {
    let mut handshake = SecureHandshake::responder(&shared.v2_identity)?;
    let first = read_binary(&mut ws, "remote-v2 handshake message one")?;
    handshake.read(&first)?;
    let server_hello = serde_json::to_vec(&json!({
        "protocolVersion": V2_PROTOCOL_VERSION,
        "contractSha256": V2_CONTRACT_SHA256,
        "desktopName": desktop_name(),
        "desktopFingerprint": shared.v2_identity.fingerprint(),
    }))?;
    ws.send(Message::Binary(handshake.write(&server_hello)?.into()))?;
    let third = read_binary(&mut ws, "remote-v2 handshake message three")?;
    let auth_payload = handshake.read(&third)?;
    let auth: V2AuthRequest =
        serde_json::from_slice(&auth_payload).context("parse remote-v2 auth")?;
    let transport = handshake.finish(None)?;
    let peer_fingerprint = transport.peer_fingerprint().to_string();
    let (device_id, grants, revocation_epoch) = {
        let mut devices = shared.devices.lock().expect("remote devices mutex");
        match auth.mode.as_str() {
            "pair" => {
                let record = devices
                    .consume_v2_pairing(
                        auth.code.as_deref().context("pair code is required")?,
                        auth.device_name
                            .as_deref()
                            .context("device name is required")?,
                        &peer_fingerprint,
                    )
                    .map_err(|_| anyhow!("remote-v2 pairing failed"))?;
                (record.id, record.grants, record.revocation_epoch)
            }
            "resume" => {
                let device_id = auth.device_id.context("device id is required")?;
                devices
                    .verify_v2_identity(&device_id, &peer_fingerprint)
                    .map_err(|_| anyhow!("remote-v2 identity verification failed"))?;
                let authorization = devices
                    .v2_authorization(&device_id, &peer_fingerprint)
                    .context("remote-v2 device was revoked")?;
                if auth.revocation_epoch != Some(authorization.revocation_epoch) {
                    bail!("remote-v2 stale revocation epoch");
                }
                (
                    device_id,
                    authorization.grants,
                    authorization.revocation_epoch,
                )
            }
            _ => bail!("unsupported remote-v2 auth mode"),
        }
    };
    let mut transport = transport;
    let auth_response = serde_json::to_vec(&json!({
        "version": V2_PROTOCOL_VERSION,
        "requestId": "auth",
        "domain": "system",
        "method": "authenticated",
        "operationId": Uuid::new_v4().to_string(),
        "sequence": 0,
        "revocationEpoch": revocation_epoch,
        "payload": {
            "deviceId": device_id,
            "grants": grants,
            "revocationEpoch": revocation_epoch,
            "contractSha256": V2_CONTRACT_SHA256
        },
        "error": null,
    }))?;
    ws.send(Message::Binary(
        transport
            .seal(SecureFrameKind::Control, &auth_response)?
            .into(),
    ))?;
    ws.get_mut().sock.set_read_timeout(Some(POLL_TIMEOUT))?;

    let (mut daemon_writer, mut daemon_inbox) = open_daemon_connection()?;
    let client_key = Uuid::new_v4();
    let (push_tx, push_rx) = bounded(PUSH_QUEUE_CAPACITY);
    let close_requested = Arc::new(AtomicBool::new(false));
    shared
        .client_close_requests
        .lock()
        .expect("remote close requests mutex")
        .insert(client_key, Arc::clone(&close_requested));
    shared
        .client_senders
        .lock()
        .expect("remote clients mutex")
        .insert(client_key, push_tx);
    shared
        .client_devices
        .lock()
        .expect("remote client devices mutex")
        .insert(client_key, device_id.clone());
    shared
        .v2_clients
        .lock()
        .expect("remote v2 clients mutex")
        .insert(client_key);

    let result = run_v2_authenticated(
        &mut ws,
        &mut transport,
        &mut daemon_writer,
        &mut daemon_inbox,
        &shared,
        &push_rx,
        &close_requested,
        client_key,
        &device_id,
        &peer_fingerprint,
        revocation_epoch,
    );
    if let Err(error) =
        cleanup_remote_connection(&mut daemon_writer, &mut daemon_inbox, client_key, u64::MAX)
    {
        tracing::warn!(?error, %client_key, "failed to clean up remote-v2 daemon connection");
    }
    shared
        .client_senders
        .lock()
        .expect("remote clients mutex")
        .remove(&client_key);
    shared
        .client_close_requests
        .lock()
        .expect("remote close requests mutex")
        .remove(&client_key);
    shared
        .client_devices
        .lock()
        .expect("remote client devices mutex")
        .remove(&client_key);
    shared
        .v2_clients
        .lock()
        .expect("remote v2 clients mutex")
        .remove(&client_key);
    result
}

fn run_v2_authenticated(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    shared: &RemoteShared,
    push_rx: &Receiver<Message>,
    close_requested: &AtomicBool,
    owner_connection_id: Uuid,
    device_id: &str,
    peer_fingerprint: &str,
    session_epoch: u64,
) -> Result<()> {
    let mut next_req = 1_u64;
    let mut sequences = DomainSequenceValidator::default();
    let mut binary_sequences: HashMap<(BinaryChannel, u64), u64> = HashMap::new();
    let mut subscriptions: HashMap<String, V2Subscription> = HashMap::new();
    let mut leases = RemoteLeaseProjection::default();
    let mut acknowledgements = TerminalAckWindow::new(
        TERMINAL_MAX_UNACKED_BYTES_PER_STREAM,
        TERMINAL_MAX_UNACKED_BYTES_PER_CONNECTION,
    )?;
    let mut output_pump = V2OutputPump::default();
    let mut last_ping = Instant::now();
    let mut last_peer_activity = Instant::now();
    loop {
        if close_requested.load(Ordering::Acquire) {
            let _ = ws.send(Message::Close(None));
            break;
        }
        match push_rx.try_recv() {
            Ok(Message::Close(_)) | Err(TryRecvError::Disconnected) => {
                let _ = ws.send(Message::Close(None));
                break;
            }
            Ok(_) | Err(TryRecvError::Empty) => {}
        }

        for _ in 0..MAX_CONTROL_FRAMES_PER_LOOP {
            let Some(message) = daemon_inbox.try_control()? else {
                break;
            };
            if let DaemonToClient::RemotePaneLease { event } = message {
                apply_lease_event(&mut leases, &event);
                if event.owner_connection_id == owner_connection_id {
                    send_v2_lease_event(ws, transport, session_epoch, &event)?;
                }
            }
        }

        let authorization = shared
            .devices
            .lock()
            .expect("remote devices mutex")
            .v2_authorization(device_id, peer_fingerprint);
        let Some(authorization) = authorization else {
            send_v2_session_error(
                ws,
                transport,
                session_epoch,
                "revoked",
                "remote device was revoked",
            )?;
            let _ = ws.send(Message::Close(None));
            break;
        };
        if authorization.revocation_epoch != session_epoch {
            send_v2_session_error(
                ws,
                transport,
                authorization.revocation_epoch,
                "revoked",
                "remote device authorization changed",
            )?;
            let _ = ws.send(Message::Close(None));
            break;
        }

        match ws.read() {
            Ok(Message::Binary(ciphertext)) => {
                let frame = transport.open(&ciphertext)?;
                if frame.kind != SecureFrameKind::Control {
                    bail!("unexpected encrypted remote-v2 frame kind");
                }
                last_peer_activity = Instant::now();
                let request: V2Envelope =
                    serde_json::from_slice(&frame.payload).context("parse remote-v2 envelope")?;
                let mut binary_after_response = Vec::new();
                let mut complete_resync_after_response = None;
                let response = if request.version != V2_PROTOCOL_VERSION {
                    v2_error(
                        &request,
                        "protocol_mismatch",
                        "remote protocol version mismatch",
                    )
                } else if request.revocation_epoch != authorization.revocation_epoch {
                    v2_error(&request, "revoked", "remote device authorization is stale")
                } else if Uuid::parse_str(&request.operation_id).is_err() {
                    v2_error(&request, "invalid_argument", "operationId must be a UUID")
                } else {
                    match sequences.validate(&request.domain, request.sequence) {
                        Err(SequenceError::Replay { expected, received }) => v2_error_with_details(
                            &request,
                            "sequence_replay",
                            "remote-v2 sequence was already processed",
                            json!({ "expected": expected, "received": received }),
                        ),
                        Err(SequenceError::Gap { expected, received }) => v2_error_with_details(
                            &request,
                            "sequence_gap",
                            "remote-v2 sequence gap requires domain resync",
                            json!({ "expected": expected, "received": received, "resyncRequired": true }),
                        ),
                        Err(SequenceError::InvalidDomain) => v2_error(
                            &request,
                            "invalid_argument",
                            "remote-v2 domain is invalid or the domain limit was reached",
                        ),
                        Ok(())
                            if !record_v2_operation(shared, device_id, &request.operation_id)? =>
                        {
                            v2_error(
                                &request,
                                "sequence_replay",
                                "remote-v2 operationId was already processed",
                            )
                        }
                        Ok(()) if request.domain == "system" && request.method == "resync" => {
                            let target_domain = request
                                .payload
                                .get("domain")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            let next_sequence = request
                                .payload
                                .get("nextSequence")
                                .and_then(Value::as_u64)
                                .unwrap_or(0);
                            match sequences.resync(target_domain, next_sequence) {
                                Ok(()) => V2Response {
                                    version: V2_PROTOCOL_VERSION,
                                    request_id: &request.request_id,
                                    domain: &request.domain,
                                    method: &request.method,
                                    operation_id: &request.operation_id,
                                    sequence: request.sequence,
                                    revocation_epoch: request.revocation_epoch,
                                    payload: json!({ "domain": target_domain, "nextSequence": next_sequence }),
                                    error: None,
                                },
                                Err(error) => {
                                    v2_error(&request, "resync_required", &error.to_string())
                                }
                            }
                        }
                        Ok(()) => {
                            let result = if request.domain == "terminal"
                                && request.method == "snapshot"
                            {
                                require_grant(&authorization.grants, TERMINAL_VIEW_GRANT)
                                    .and_then(|_| {
                                        v2_terminal_snapshot(
                                            &request,
                                            daemon_writer,
                                            daemon_inbox,
                                            &mut next_req,
                                            &subscriptions,
                                            &mut binary_sequences,
                                        )
                                    })
                                    .map(|(payload, frames, stream_id)| {
                                        binary_after_response = frames;
                                        complete_resync_after_response = Some(stream_id);
                                        payload
                                    })
                            } else if request.domain == "terminal" && request.method == "subscribe"
                            {
                                require_grant(&authorization.grants, TERMINAL_VIEW_GRANT)
                                    .and_then(|_| {
                                        v2_terminal_subscribe(
                                            &request,
                                            daemon_writer,
                                            daemon_inbox,
                                            &mut next_req,
                                            &mut subscriptions,
                                            &mut binary_sequences,
                                        )
                                    })
                                    .map(|(payload, frames)| {
                                        binary_after_response = frames;
                                        payload
                                    })
                            } else {
                                handle_v2_request(
                                    &request,
                                    &authorization.grants,
                                    owner_connection_id,
                                    device_id,
                                    daemon_writer,
                                    daemon_inbox,
                                    &mut next_req,
                                    &mut subscriptions,
                                    &mut leases,
                                    &mut acknowledgements,
                                    &mut output_pump,
                                    &mut binary_sequences,
                                )
                            };
                            match result {
                                Ok(payload) => V2Response {
                                    version: V2_PROTOCOL_VERSION,
                                    request_id: &request.request_id,
                                    domain: &request.domain,
                                    method: &request.method,
                                    operation_id: &request.operation_id,
                                    sequence: request.sequence,
                                    revocation_epoch: request.revocation_epoch,
                                    payload,
                                    error: None,
                                },
                                Err(error) => {
                                    v2_error(&request, v2_error_code(&error), &error.to_string())
                                }
                            }
                        }
                    }
                };
                let payload = serde_json::to_vec(&response)?;
                ws.send(Message::Binary(
                    transport.seal(SecureFrameKind::Control, &payload)?.into(),
                ))?;
                for frame in binary_after_response {
                    send_v2_binary(ws, transport, frame)?;
                }
                if let Some(stream_id) = complete_resync_after_response {
                    acknowledgements.complete_resync(stream_id);
                }
            }
            Ok(Message::Pong(_)) => last_peer_activity = Instant::now(),
            Ok(Message::Ping(payload)) => {
                last_peer_activity = Instant::now();
                ws.send(Message::Pong(payload))?;
            }
            Ok(Message::Close(_)) => break,
            Ok(_) => bail!("unexpected remote websocket message kind"),
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => break,
            Err(error) => return Err(error.into()),
        }
        if authorization
            .grants
            .iter()
            .any(|grant| grant == TERMINAL_VIEW_GRANT || grant == "admin")
        {
            for (pane_id, skipped_sequences) in daemon_inbox.take_all_output_drops() {
                if let Some(stream_id) = subscriptions
                    .values()
                    .find(|subscription| subscription.pane_id == pane_id)
                    .map(|subscription| subscription.stream_id)
                {
                    mark_v2_terminal_gap(
                        ws,
                        transport,
                        stream_id,
                        skipped_sequences,
                        &mut binary_sequences,
                        &mut acknowledgements,
                    )?;
                }
            }
            pump_v2_terminal_output(
                ws,
                transport,
                daemon_inbox,
                &subscriptions,
                &mut output_pump,
                &mut binary_sequences,
                &mut acknowledgements,
            )?;
        }
        if last_ping.elapsed() >= KEEPALIVE_INTERVAL {
            if last_peer_activity.elapsed() >= KEEPALIVE_DEADLINE {
                bail!("remote-v2 keepalive timed out");
            }
            ws.send(Message::Ping(Vec::new().into()))?;
            last_ping = Instant::now();
        }
    }
    Ok(())
}

fn record_v2_operation(shared: &RemoteShared, device_id: &str, operation_id: &str) -> Result<bool> {
    let mut devices = shared
        .v2_operation_ids
        .lock()
        .expect("remote v2 replay mutex");
    if !devices.contains_key(device_id) {
        devices.insert(device_id.to_string(), OperationReplayWindow::new(4096)?);
    }
    Ok(devices
        .get_mut(device_id)
        .expect("inserted remote v2 replay window")
        .record(operation_id))
}

fn validate_v2_subscription_target(
    subscriptions: &HashMap<String, V2Subscription>,
    pane_id: Uuid,
    stream_id: u64,
) -> Result<()> {
    if subscriptions
        .values()
        .any(|subscription| subscription.pane_id == pane_id)
    {
        bail!("conflict: terminal pane already has a live subscription");
    }
    if subscriptions
        .values()
        .any(|subscription| subscription.stream_id == stream_id)
    {
        bail!("conflict: terminal stream id collides with another pane");
    }
    Ok(())
}
fn v2_terminal_subscribe(
    request: &V2Envelope,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
    subscriptions: &mut HashMap<String, V2Subscription>,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
) -> Result<(Value, Vec<BinaryFrame>)> {
    let params: TerminalSubscribeParams = serde_json::from_value(request.payload.clone())
        .context("parse terminal.subscribe payload")?;
    let workspace_id =
        Uuid::parse_str(&params.workspace_id).context("workspaceId must be a UUID")?;
    let pane_id = Uuid::parse_str(&params.pane_id).context("paneId must be a UUID")?;
    let stream_id = v2_stream_id(pane_id);
    validate_v2_subscription_target(subscriptions, pane_id, stream_id)?;
    ensure_binary_sequence_capacity(
        sequences,
        &[
            (BinaryChannel::TerminalOutput, stream_id),
            (BinaryChannel::TerminalSnapshot, stream_id),
        ],
    )?;
    let (snapshot, frames, first_live_sequence) = v2_atomic_snapshot(
        daemon_writer,
        daemon_inbox,
        next_req,
        workspace_id,
        pane_id,
        stream_id,
        sequences,
    )?;
    let subscription_id = Uuid::new_v4().to_string();
    subscriptions.insert(
        subscription_id.clone(),
        V2Subscription {
            workspace_id,
            pane_id,
            stream_id,
        },
    );
    let result = TerminalSubscribeResult {
        alive: snapshot.alive,
        cols: snapshot.cols,
        first_live_sequence,
        pane_generation: snapshot.pane_generation,
        rows: snapshot.rows,
        snapshot_bytes: u64::try_from(snapshot.data.len()).context("snapshot byte count")?,
        snapshot_chunks: u32::try_from(frames.len()).context("snapshot chunk count")?,
        stream_id,
        subscription_id,
    };
    Ok((serde_json::to_value(result)?, frames))
}

fn v2_terminal_snapshot(
    request: &V2Envelope,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
    subscriptions: &HashMap<String, V2Subscription>,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
) -> Result<(Value, Vec<BinaryFrame>, u64)> {
    let params: TerminalSnapshotParams = serde_json::from_value(request.payload.clone())
        .context("parse terminal.snapshot payload")?;
    let subscription = subscriptions
        .get(&params.subscription_id)
        .context("terminal subscription not found")?;
    let (snapshot, frames, first_live_sequence) = v2_atomic_snapshot(
        daemon_writer,
        daemon_inbox,
        next_req,
        subscription.workspace_id,
        subscription.pane_id,
        subscription.stream_id,
        sequences,
    )?;
    let result = TerminalSnapshotResult {
        first_live_sequence,
        pane_generation: snapshot.pane_generation,
        snapshot_bytes: u64::try_from(snapshot.data.len()).context("snapshot byte count")?,
        snapshot_chunks: u32::try_from(frames.len()).context("snapshot chunk count")?,
        stream_id: subscription.stream_id,
        subscription_id: params.subscription_id,
    };
    Ok((
        serde_json::to_value(result)?,
        frames,
        subscription.stream_id,
    ))
}

fn v2_atomic_snapshot(
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
    session_id: Uuid,
    pane_id: Uuid,
    stream_id: u64,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
) -> Result<(crate::protocol::TerminalSnapshot, Vec<BinaryFrame>, u64)> {
    let req = take_req(next_req);
    let snapshot = match request_reply(
        daemon_writer,
        daemon_inbox,
        req,
        ClientToDaemon::SubscribePane {
            req,
            session_id,
            pane_id,
        },
    )? {
        ReplyResult::TerminalSnapshot(snapshot) => snapshot,
        other => bail!("unexpected terminal snapshot reply: {other:?}"),
    };
    if snapshot.session_id != session_id || snapshot.pane_id != pane_id {
        bail!("stale_target: daemon returned a different terminal snapshot");
    }
    let first_live_sequence =
        peek_binary_sequence(sequences, BinaryChannel::TerminalOutput, stream_id)?;
    let frames = v2_binary_chunks(
        BinaryChannel::TerminalSnapshot,
        stream_id,
        &snapshot.data,
        0,
        sequences,
    )?;
    Ok((snapshot, frames, first_live_sequence))
}

fn v2_terminal_ack(
    request: &V2Envelope,
    subscriptions: &HashMap<String, V2Subscription>,
    acknowledgements: &mut TerminalAckWindow,
) -> Result<Value> {
    let params: TerminalAckParams =
        serde_json::from_value(request.payload.clone()).context("parse terminal.ack payload")?;
    let subscription = subscriptions
        .get(&params.subscription_id)
        .context("terminal subscription not found")?;
    acknowledgements
        .ack(subscription.stream_id, params.sequence)
        .map_err(map_terminal_ack_error)?;
    Ok(json!({}))
}

fn map_terminal_ack_error(error: TerminalFlowError) -> anyhow::Error {
    match error {
        TerminalFlowError::AckBehind { .. } => anyhow!("stale_ref: {error}"),
        TerminalFlowError::InvalidStreamId
        | TerminalFlowError::StreamLimitExceeded { .. }
        | TerminalFlowError::SequenceNotIncreasing { .. }
        | TerminalFlowError::AckAhead { .. } => anyhow!("invalid_argument: {error}"),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum V2TerminalFrameDisposition {
    Send,
    EmitResync,
    Suppress,
}

fn record_v2_terminal_frame(
    acknowledgements: &mut TerminalAckWindow,
    stream_id: u64,
    sequence: u64,
    bytes: usize,
) -> Result<V2TerminalFrameDisposition> {
    if acknowledgements.requires_resync(stream_id) {
        return Ok(V2TerminalFrameDisposition::Suppress);
    }
    match acknowledgements.record_sent(stream_id, sequence, bytes)? {
        TerminalRecordDecision::Recorded => Ok(V2TerminalFrameDisposition::Send),
        TerminalRecordDecision::Backpressured { .. } => Ok(V2TerminalFrameDisposition::EmitResync),
    }
}

fn fence_v2_terminal_gap(acknowledgements: &mut TerminalAckWindow, stream_id: u64) -> Result<bool> {
    if acknowledgements.requires_resync(stream_id) {
        return Ok(false);
    }
    acknowledgements.mark_gap(stream_id)?;
    Ok(true)
}

fn mark_v2_terminal_gap(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    stream_id: u64,
    skipped_sequences: u64,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
    acknowledgements: &mut TerminalAckWindow,
) -> Result<()> {
    advance_binary_sequence(
        sequences,
        BinaryChannel::TerminalOutput,
        stream_id,
        skipped_sequences,
    )?;
    if !fence_v2_terminal_gap(acknowledgements, stream_id)? {
        return Ok(());
    }
    send_v2_resync_marker(ws, transport, stream_id, sequences, acknowledgements)
}

fn send_v2_terminal_payload(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    stream_id: u64,
    payload: Vec<u8>,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
    acknowledgements: &mut TerminalAckWindow,
) -> Result<bool> {
    let sequence = take_binary_sequence(sequences, BinaryChannel::TerminalOutput, stream_id)?;
    match record_v2_terminal_frame(acknowledgements, stream_id, sequence, payload.len())? {
        V2TerminalFrameDisposition::Send => {
            send_v2_binary(
                ws,
                transport,
                BinaryFrame {
                    channel: BinaryChannel::TerminalOutput,
                    flags: FLAG_FINAL,
                    stream_id,
                    sequence,
                    dropped_before: 0,
                    payload,
                },
            )?;
            Ok(true)
        }
        V2TerminalFrameDisposition::EmitResync => {
            acknowledgements.mark_gap(stream_id)?;
            send_v2_resync_marker(ws, transport, stream_id, sequences, acknowledgements)?;
            Ok(false)
        }
        V2TerminalFrameDisposition::Suppress => Ok(false),
    }
}

fn record_v2_resync_marker(
    acknowledgements: &mut TerminalAckWindow,
    stream_id: u64,
    sequence: u64,
) -> Result<()> {
    match acknowledgements.record_sent(stream_id, sequence, 0)? {
        TerminalRecordDecision::Recorded => Ok(()),
        TerminalRecordDecision::Backpressured { reason } => {
            bail!("resync marker was unexpectedly backpressured: {reason:?}")
        }
    }
}

fn send_v2_resync_marker(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    stream_id: u64,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
    acknowledgements: &mut TerminalAckWindow,
) -> Result<()> {
    let sequence = take_binary_sequence(sequences, BinaryChannel::TerminalOutput, stream_id)?;
    record_v2_resync_marker(acknowledgements, stream_id, sequence)?;
    send_v2_binary(
        ws,
        transport,
        BinaryFrame {
            channel: BinaryChannel::TerminalOutput,
            flags: FLAG_RESYNC | FLAG_FINAL,
            stream_id,
            sequence,
            dropped_before: 0,
            payload: Vec::new(),
        },
    )
}

fn pump_v2_terminal_output(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    daemon_inbox: &DaemonInbox,
    subscriptions: &HashMap<String, V2Subscription>,
    pump: &mut V2OutputPump,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
    acknowledgements: &mut TerminalAckWindow,
) -> Result<()> {
    let mut consumed_bytes = 0_usize;
    let mut sent_frames = 0_usize;
    let mut dequeued_frames = 0_usize;
    loop {
        if consumed_bytes >= MAX_OUTPUT_BYTES_PER_LOOP
            || sent_frames + pump.buffers.len() >= MAX_OUTPUT_FRAMES_PER_LOOP
            || daemon_inbox.has_pending_control()
        {
            break;
        }
        let mut pending = if let Some(pending) = pump.pending.take() {
            pending
        } else {
            if dequeued_frames >= MAX_OUTPUT_FRAMES_PER_LOOP {
                break;
            }
            let Some(message) = daemon_inbox.try_output()? else {
                break;
            };
            dequeued_frames += 1;
            let DaemonToClient::Output { pane_id, data } = message else {
                continue;
            };
            PendingTerminalOutput {
                pane_id,
                data,
                offset: 0,
            }
        };
        let Some(stream_id) = subscriptions
            .values()
            .find(|subscription| subscription.pane_id == pending.pane_id)
            .map(|subscription| subscription.stream_id)
        else {
            continue;
        };
        let remaining = pending.data.len().saturating_sub(pending.offset);
        if acknowledgements.requires_resync(stream_id) {
            let skipped = u64::try_from(remaining.div_ceil(MAX_TERMINAL_COALESCE_BYTES))
                .unwrap_or(u64::MAX)
                .max(1);
            advance_binary_sequence(sequences, BinaryChannel::TerminalOutput, stream_id, skipped)?;
            continue;
        }
        if !pump.buffers.contains_key(&stream_id) {
            pump.buffers
                .insert(stream_id, Vec::with_capacity(MAX_TERMINAL_COALESCE_BYTES));
            pump.order.push_back(stream_id);
        }
        let budget = MAX_OUTPUT_BYTES_PER_LOOP.saturating_sub(consumed_bytes);
        if budget == 0 {
            pump.pending = Some(pending);
            break;
        }
        let (taken, full) = {
            let buffer = pump
                .buffers
                .get_mut(&stream_id)
                .expect("terminal coalescing buffer was inserted");
            let take = remaining
                .min(MAX_TERMINAL_COALESCE_BYTES.saturating_sub(buffer.len()))
                .min(budget);
            buffer.extend_from_slice(&pending.data[pending.offset..pending.offset + take]);
            (take, buffer.len() == MAX_TERMINAL_COALESCE_BYTES)
        };
        pending.offset += taken;
        consumed_bytes += taken;
        if full {
            let payload = pump
                .buffers
                .remove(&stream_id)
                .expect("full terminal coalescing buffer exists");
            pump.order.retain(|candidate| *candidate != stream_id);
            send_v2_terminal_payload(
                ws,
                transport,
                stream_id,
                payload,
                sequences,
                acknowledgements,
            )?;
            sent_frames += 1;
        }
        if pending.offset < pending.data.len() {
            pump.pending = Some(pending);
        }
    }

    while sent_frames < MAX_OUTPUT_FRAMES_PER_LOOP {
        let Some(stream_id) = pump.order.pop_front() else {
            break;
        };
        let Some(payload) = pump.buffers.remove(&stream_id) else {
            continue;
        };
        if payload.is_empty() {
            continue;
        }
        if acknowledgements.requires_resync(stream_id) {
            advance_binary_sequence(sequences, BinaryChannel::TerminalOutput, stream_id, 1)?;
        } else {
            send_v2_terminal_payload(
                ws,
                transport,
                stream_id,
                payload,
                sequences,
                acknowledgements,
            )?;
        }
        sent_frames += 1;
    }
    Ok(())
}

fn v2_binary_chunks(
    channel: BinaryChannel,
    stream_id: u64,
    data: &[u8],
    first_flags: u16,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
) -> Result<Vec<BinaryFrame>> {
    if data.is_empty() {
        return Ok(vec![BinaryFrame {
            channel,
            flags: first_flags | FLAG_FINAL,
            stream_id,
            sequence: take_binary_sequence(sequences, channel, stream_id)?,
            dropped_before: 0,
            payload: Vec::new(),
        }]);
    }
    let chunk_count = data.len().div_ceil(MAX_BINARY_PAYLOAD_BYTES);
    let mut frames = Vec::with_capacity(chunk_count);
    for (index, chunk) in data.chunks(MAX_BINARY_PAYLOAD_BYTES).enumerate() {
        frames.push(BinaryFrame {
            channel,
            flags: (if index == 0 { first_flags } else { 0 })
                | if index + 1 == chunk_count {
                    FLAG_FINAL
                } else {
                    0
                },
            stream_id,
            sequence: take_binary_sequence(sequences, channel, stream_id)?,
            dropped_before: 0,
            payload: chunk.to_vec(),
        });
    }
    Ok(frames)
}

fn ensure_binary_sequence_capacity(
    sequences: &HashMap<(BinaryChannel, u64), u64>,
    keys: &[(BinaryChannel, u64)],
) -> Result<()> {
    let missing = keys
        .iter()
        .filter(|key| !sequences.contains_key(key))
        .count();
    if missing > MAX_SEQUENCE_DOMAINS.saturating_sub(sequences.len()) {
        bail!("invalid_argument: remote-v2 binary stream limit reached");
    }
    Ok(())
}

fn peek_binary_sequence(
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
    channel: BinaryChannel,
    stream_id: u64,
) -> Result<u64> {
    ensure_binary_sequence_capacity(sequences, &[(channel, stream_id)])?;
    Ok(*sequences.entry((channel, stream_id)).or_insert(1))
}

fn advance_binary_sequence(
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
    channel: BinaryChannel,
    stream_id: u64,
    count: u64,
) -> Result<()> {
    let next = peek_binary_sequence(sequences, channel, stream_id)?;
    let advanced = next
        .checked_add(count)
        .context("remote-v2 binary sequence exhausted")?;
    sequences.insert((channel, stream_id), advanced);
    Ok(())
}

fn take_binary_sequence(
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
    channel: BinaryChannel,
    stream_id: u64,
) -> Result<u64> {
    let sequence = peek_binary_sequence(sequences, channel, stream_id)?;
    let next = sequence
        .checked_add(1)
        .context("remote-v2 binary sequence exhausted")?;
    sequences.insert((channel, stream_id), next);
    Ok(sequence)
}

fn send_v2_binary(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    frame: BinaryFrame,
) -> Result<()> {
    let encoded = frame.encode()?;
    ws.send(Message::Binary(
        transport.seal(SecureFrameKind::Binary, &encoded)?.into(),
    ))?;
    Ok(())
}

fn v2_stream_id(pane_id: Uuid) -> u64 {
    let mut bytes = [0_u8; 8];
    bytes.copy_from_slice(&pane_id.as_bytes()[..8]);
    u64::from_be_bytes(bytes).max(1)
}

fn send_v2_session_error(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    revocation_epoch: u64,
    code: &str,
    message: &str,
) -> Result<()> {
    let payload = serde_json::to_vec(&json!({
        "version": V2_PROTOCOL_VERSION,
        "requestId": "session",
        "domain": "system",
        "method": "closed",
        "operationId": Uuid::new_v4().to_string(),
        "sequence": 0,
        "revocationEpoch": revocation_epoch,
        "payload": null,
        "error": { "code": code, "message": message },
    }))?;
    ws.send(Message::Binary(
        transport.seal(SecureFrameKind::Control, &payload)?.into(),
    ))?;
    Ok(())
}

fn remote_origin(
    owner_connection_id: Uuid,
    device_id: &str,
    lease_id: Option<Uuid>,
    revision: Option<u64>,
) -> PaneCommandOrigin {
    PaneCommandOrigin::Remote {
        owner_connection_id,
        device_id: device_id.to_string(),
        lease_id,
        revision,
    }
}

fn remote_lease_result(reply: ReplyResult) -> Result<RemotePaneLeaseResult> {
    let result = match reply {
        ReplyResult::RemotePaneLease(result) => result,
        other => bail!("unexpected daemon lease reply: {other:?}"),
    };
    match result {
        RemotePaneLeaseResult::Busy { lease } => bail!(
            "conflict: pane_busy lease {} revision {} is active",
            lease.lease_id,
            lease.revision
        ),
        RemotePaneLeaseResult::Stale { reason, .. } => {
            bail!("stale_ref: terminal lease is stale ({reason:?})")
        }
        result => Ok(result),
    }
}

fn claimed_lease_result(reply: ReplyResult) -> Result<RemotePaneLease> {
    match remote_lease_result(reply)? {
        RemotePaneLeaseResult::Claimed { lease }
        | RemotePaneLeaseResult::Updated { lease }
        | RemotePaneLeaseResult::Renewed { lease } => Ok(lease),
        other => bail!("unexpected terminal lease claim reply: {other:?}"),
    }
}

fn v2_lease_record(lease: &RemotePaneLease) -> TerminalLeaseRecord {
    TerminalLeaseRecord {
        cols: lease.target_cols,
        lease_id: lease.lease_id.to_string(),
        lease_revision: lease.revision,
        pane_id: lease.pane_id.to_string(),
        rows: lease.target_rows,
        viewport_revision: lease.viewport_revision,
        workspace_id: lease.session_id.to_string(),
    }
}

fn lease_from_event(event: &RemotePaneLeaseEvent) -> RemotePaneLease {
    RemotePaneLease {
        lease_id: event.lease_id,
        owner_connection_id: event.owner_connection_id,
        device_id: event.device_id.clone(),
        session_id: event.session_id,
        pane_id: event.pane_id,
        pane_generation: event.pane_generation,
        revision: event.revision,
        original_cols: event.original_cols,
        original_rows: event.original_rows,
        target_cols: event.target_cols,
        target_rows: event.target_rows,
        viewport_revision: event.viewport_revision,
        expires_at: event.expires_at,
    }
}

fn apply_lease_event(leases: &mut RemoteLeaseProjection, event: &RemotePaneLeaseEvent) {
    match event.kind {
        RemotePaneLeaseEventKind::Claimed | RemotePaneLeaseEventKind::Updated => {
            leases.record(lease_from_event(event));
        }
        RemotePaneLeaseEventKind::Released | RemotePaneLeaseEventKind::Lost => {
            leases.remove_pane(event.pane_id);
        }
    }
}

fn send_v2_lease_event(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    revocation_epoch: u64,
    event: &RemotePaneLeaseEvent,
) -> Result<()> {
    let (method, payload) = match event.kind {
        RemotePaneLeaseEventKind::Claimed | RemotePaneLeaseEventKind::Updated => (
            "lease.changed",
            json!({
                "viewGeneration": event.pane_generation.max(1),
                "lease": v2_lease_record(&lease_from_event(event)),
            }),
        ),
        RemotePaneLeaseEventKind::Released | RemotePaneLeaseEventKind::Lost => (
            "lease.lost",
            json!({
                "workspaceId": event.session_id,
                "paneId": event.pane_id,
                "leaseId": event.lease_id,
                "leaseRevision": event.revision,
                "reason": v2_lease_lost_reason(event.reason),
            }),
        ),
    };
    let payload = serde_json::to_vec(&json!({
        "version": V2_PROTOCOL_VERSION,
        "requestId": "event",
        "domain": "terminal",
        "method": method,
        "operationId": Uuid::new_v4(),
        "sequence": 0,
        "revocationEpoch": revocation_epoch,
        "payload": payload,
        "error": null,
    }))?;
    ws.send(Message::Binary(
        transport.seal(SecureFrameKind::Control, &payload)?.into(),
    ))?;
    Ok(())
}

fn v2_lease_lost_reason(reason: RemotePaneLeaseEventReason) -> &'static str {
    match reason {
        RemotePaneLeaseEventReason::Released => "released",
        RemotePaneLeaseEventReason::AdminReclaimed => "explicit_revoke",
        RemotePaneLeaseEventReason::Expired => "expired",
        RemotePaneLeaseEventReason::ConnectionClosed => "connection_closed",
        RemotePaneLeaseEventReason::PaneExited => "pane_exited",
        RemotePaneLeaseEventReason::Claimed => "claimed",
        RemotePaneLeaseEventReason::TargetUpdated => "target_updated",
        RemotePaneLeaseEventReason::Renewed => "renewed",
    }
}

fn map_v2_terminal_input(
    params: TerminalInputParams,
    subscriptions: &HashMap<String, V2Subscription>,
    leases: &RemoteLeaseProjection,
    owner_connection_id: Uuid,
    device_id: &str,
) -> Result<ClientToDaemon> {
    let subscription = subscriptions
        .get(&params.subscription_id)
        .context("terminal subscription not found")?;
    let lease_id = params
        .lease_id
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()
        .context("leaseId must be a UUID")?;
    let revision = lease_id
        .map(|lease_id| {
            leases
                .by_lease_id(lease_id)
                .map(|lease| lease.revision)
                .context("stale_ref: terminal lease is not active")
        })
        .transpose()?;
    let data = base64::engine::general_purpose::STANDARD
        .decode(params.data_base64)
        .context("decode dataBase64 terminal input")?;
    Ok(ClientToDaemon::WritePane {
        session_id: subscription.workspace_id,
        pane_id: subscription.pane_id,
        data,
        origin: remote_origin(owner_connection_id, device_id, lease_id, revision),
    })
}

fn release_v2_subscription_state(
    subscription: &V2Subscription,
    output_pump: &mut V2OutputPump,
    acknowledgements: &mut TerminalAckWindow,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
) -> Result<()> {
    output_pump.purge(subscription.pane_id, subscription.stream_id);
    acknowledgements.remove_stream(subscription.stream_id)?;
    sequences.remove(&(BinaryChannel::TerminalOutput, subscription.stream_id));
    sequences.remove(&(BinaryChannel::TerminalSnapshot, subscription.stream_id));
    Ok(())
}

fn handle_v2_request(
    request: &V2Envelope,
    grants: &[String],
    owner_connection_id: Uuid,
    device_id: &str,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
    subscriptions: &mut HashMap<String, V2Subscription>,
    leases: &mut RemoteLeaseProjection,
    acknowledgements: &mut TerminalAckWindow,
    output_pump: &mut V2OutputPump,
    binary_sequences: &mut HashMap<(BinaryChannel, u64), u64>,
) -> Result<Value> {
    match (request.domain.as_str(), request.method.as_str()) {
        ("system", "status") => Ok(json!({
            "protocolVersion": V2_PROTOCOL_VERSION,
            "contractSha256": V2_CONTRACT_SHA256,
            "capabilities": grants,
        })),
        ("workspace", "list") => {
            require_grant(grants, TERMINAL_VIEW_GRANT)?;
            Ok(serde_json::to_value(list_sessions(
                daemon_writer,
                daemon_inbox,
                next_req,
            )?)?)
        }
        ("workspace", "attach") => {
            require_grant(grants, TERMINAL_VIEW_GRANT)?;
            let session_id = v2_uuid(&request.payload, "workspaceId")?;
            let (layout_json, panes) =
                attach_session(daemon_writer, daemon_inbox, next_req, session_id)?;
            let panes = panes
                .iter()
                .map(|pane| {
                    let mut value = serde_json::to_value(PaneDto::from(pane))?;
                    value
                        .as_object_mut()
                        .context("pane projection must be an object")?
                        .insert(
                            "terminalOutputStreamId".to_string(),
                            json!(v2_stream_id(pane.id)),
                        );
                    Ok(value)
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(json!({ "layoutJson": layout_json, "panes": panes }))
        }
        ("workspace", "detach") => {
            require_grant(grants, TERMINAL_VIEW_GRANT)?;
            let workspace_id = v2_uuid(&request.payload, "workspaceId")?;
            cleanup_remote_connection(
                daemon_writer,
                daemon_inbox,
                owner_connection_id,
                take_req(next_req),
            )?;
            leases.by_pane.clear();
            let removed_ids = subscriptions
                .iter()
                .filter_map(|(id, subscription)| {
                    (subscription.workspace_id == workspace_id).then_some(id.clone())
                })
                .collect::<Vec<_>>();
            for id in removed_ids {
                if let Some(subscription) = subscriptions.remove(&id) {
                    release_v2_subscription_state(
                        &subscription,
                        output_pump,
                        acknowledgements,
                        binary_sequences,
                    )?;
                }
            }
            write_frame(
                daemon_writer,
                &ClientToDaemon::DetachSession {
                    session_id: workspace_id,
                },
            )?;
            Ok(json!({}))
        }
        ("terminal", "ack") => {
            require_grant(grants, TERMINAL_VIEW_GRANT)?;
            v2_terminal_ack(request, subscriptions, acknowledgements)
        }
        ("terminal", "unsubscribe") => {
            require_grant(grants, TERMINAL_VIEW_GRANT)?;
            let params: TerminalUnsubscribeParams = serde_json::from_value(request.payload.clone())
                .context("parse terminal.unsubscribe payload")?;
            let subscription = subscriptions
                .remove(&params.subscription_id)
                .context("terminal subscription not found")?;
            if !subscriptions
                .values()
                .any(|candidate| candidate.pane_id == subscription.pane_id)
            {
                write_frame(
                    daemon_writer,
                    &ClientToDaemon::DetachPane {
                        session_id: subscription.workspace_id,
                        pane_id: subscription.pane_id,
                    },
                )?;
            }
            release_v2_subscription_state(
                &subscription,
                output_pump,
                acknowledgements,
                binary_sequences,
            )?;
            Ok(json!({}))
        }
        ("terminal", "input") => {
            require_grant(grants, TERMINAL_INPUT_GRANT)?;
            let params: TerminalInputParams = serde_json::from_value(request.payload.clone())
                .context("parse terminal.input payload")?;
            let command = map_v2_terminal_input(
                params,
                subscriptions,
                leases,
                owner_connection_id,
                device_id,
            )?;
            write_frame(daemon_writer, &command)?;
            Ok(json!({}))
        }
        ("terminal", "lease.claim") => {
            require_grant(grants, TERMINAL_INPUT_GRANT)?;
            let params: TerminalLeaseClaimParams = serde_json::from_value(request.payload.clone())
                .context("parse terminal.lease.claim payload")?;
            let session_id =
                Uuid::parse_str(&params.workspace_id).context("workspaceId must be a UUID")?;
            let pane_id = Uuid::parse_str(&params.pane_id).context("paneId must be a UUID")?;
            let lease_id = params
                .lease_id
                .as_deref()
                .map(Uuid::parse_str)
                .transpose()
                .context("leaseId must be a UUID")?;
            let current = lease_id
                .map(|lease_id| {
                    leases
                        .by_lease_id(lease_id)
                        .cloned()
                        .context("stale_ref: terminal lease is not active")
                })
                .transpose()?;
            let req = take_req(next_req);
            let message = match current.as_ref() {
                Some(current)
                    if current.target_cols == params.cols.clamp(20, 360)
                        && current.target_rows == params.rows.clamp(5, 200)
                        && current.viewport_revision == params.viewport_revision =>
                {
                    ClientToDaemon::RemotePaneLeaseRenew {
                        req,
                        request: RemotePaneLeaseRenewRequest {
                            owner_connection_id,
                            device_id: device_id.to_string(),
                            session_id,
                            pane_id,
                            lease_id: current.lease_id,
                            revision: current.revision,
                            viewport_revision: params.viewport_revision,
                        },
                    }
                }
                _ => ClientToDaemon::RemotePaneLeaseClaim {
                    req,
                    request: RemotePaneLeaseClaimRequest {
                        owner_connection_id,
                        device_id: device_id.to_string(),
                        session_id,
                        pane_id,
                        cols: params.cols.clamp(20, 360),
                        rows: params.rows.clamp(5, 200),
                        viewport_revision: params.viewport_revision,
                        lease_id,
                        revision: current.as_ref().map(|lease| lease.revision),
                    },
                },
            };
            let lease =
                claimed_lease_result(request_reply(daemon_writer, daemon_inbox, req, message)?)?;
            leases.record(lease.clone());
            Ok(serde_json::to_value(v2_lease_record(&lease))?)
        }
        ("terminal", "lease.release") => {
            require_grant(grants, TERMINAL_INPUT_GRANT)?;
            let params: TerminalLeaseReleaseParams =
                serde_json::from_value(request.payload.clone())
                    .context("parse terminal.lease.release payload")?;
            let lease_id = Uuid::parse_str(&params.lease_id).context("leaseId must be a UUID")?;
            let lease = leases
                .by_lease_id(lease_id)
                .cloned()
                .context("stale_ref: terminal lease is not active")?;
            let req = take_req(next_req);
            match remote_lease_result(request_reply(
                daemon_writer,
                daemon_inbox,
                req,
                ClientToDaemon::RemotePaneLeaseRelease {
                    req,
                    request: RemotePaneLeaseReleaseRequest {
                        owner_connection_id,
                        device_id: device_id.to_string(),
                        session_id: lease.session_id,
                        pane_id: lease.pane_id,
                        lease_id,
                        revision: params.lease_revision,
                    },
                },
            )?)? {
                RemotePaneLeaseResult::Released { release } => {
                    leases.remove_pane(release.lease.pane_id);
                    Ok(json!({}))
                }
                other => bail!("unexpected terminal lease release reply: {other:?}"),
            }
        }
        ("terminal", "lease.status") => {
            require_grant(grants, TERMINAL_VIEW_GRANT)?;
            let params: TerminalLeaseStatusParams = serde_json::from_value(request.payload.clone())
                .context("parse terminal.lease.status payload")?;
            let workspace_id =
                Uuid::parse_str(&params.workspace_id).context("workspaceId must be a UUID")?;
            let pane_id = Uuid::parse_str(&params.pane_id).context("paneId must be a UUID")?;
            let req = take_req(next_req);
            match remote_lease_result(request_reply(
                daemon_writer,
                daemon_inbox,
                req,
                ClientToDaemon::RemotePaneLeaseStatus {
                    req,
                    request: RemotePaneLeaseStatusRequest { pane_id },
                },
            )?)? {
                RemotePaneLeaseResult::Status { lease } => {
                    if lease
                        .as_ref()
                        .is_some_and(|lease| lease.session_id != workspace_id)
                    {
                        bail!("stale_target: pane belongs to a different workspace");
                    }
                    if let Some(lease) = lease.as_ref() {
                        leases.record(lease.clone());
                    } else {
                        leases.remove_pane(pane_id);
                    }
                    Ok(json!({ "lease": lease.as_ref().map(v2_lease_record) }))
                }
                other => bail!("unexpected terminal lease status reply: {other:?}"),
            }
        }
        ("files", method) => {
            require_grant(
                grants,
                if method == "write" {
                    "admin"
                } else {
                    "files.view"
                },
            )?;
            handle_v2_files(request, method, daemon_writer, daemon_inbox, next_req)
        }
        ("git", method) => {
            require_grant(
                grants,
                if matches!(method, "status" | "log" | "diff") {
                    "files.view"
                } else {
                    "git.write"
                },
            )?;
            handle_v2_git(request, method, daemon_writer, daemon_inbox, next_req)
        }
        ("orchestration", method) => {
            require_grant(grants, "orchestration.view")?;
            if !matches!(
                method,
                "runs.list" | "run.get" | "tasks.list" | "messages.list" | "gates.list"
            ) {
                require_grant(grants, "orchestration.control")?;
            }
            let req = take_req(next_req);
            let operation_id = Uuid::parse_str(&request.operation_id)?;
            match request_reply(
                daemon_writer,
                daemon_inbox,
                req,
                ClientToDaemon::Orchestration {
                    req,
                    operation_id,
                    method: method.to_string(),
                    payload_json: request.payload.to_string(),
                },
            )? {
                ReplyResult::Orchestration(response) => Ok(serde_json::from_str(&response)?),
                other => bail!("unexpected orchestration reply: {other:?}"),
            }
        }
        (domain @ ("browser" | "computer" | "automation" | "skill" | "remote"), method) => {
            let grant = match domain {
                "browser"
                    if matches!(
                        method,
                        "tabs"
                            | "profiles"
                            | "snapshot"
                            | "screenshot"
                            | "full-screenshot"
                            | "get"
                            | "is"
                            | "console"
                            | "network"
                            | "cookies"
                            | "storage"
                    ) =>
                {
                    "browser.view"
                }
                "browser" => "browser.control",
                "computer"
                    if matches!(
                        method,
                        "capabilities" | "list-apps" | "list-windows" | "get-app-state"
                    ) =>
                {
                    "computer.observe"
                }
                "computer" => "computer.control",
                "automation" => "orchestration.control",
                _ => "admin",
            };
            require_grant(grants, grant)?;
            dispatch_v2_cli(
                request,
                domain,
                method,
                daemon_writer,
                daemon_inbox,
                next_req,
            )
        }
        _ => bail!(
            "unsupported remote-v2 method {}.{}",
            request.domain,
            request.method
        ),
    }
}

fn dispatch_v2_cli(
    request: &V2Envelope,
    domain: &str,
    method: &str,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
) -> Result<Value> {
    let mut args = vec![domain.to_string(), method.to_string()];
    if let Some(extra) = request.payload.get("args").and_then(Value::as_array) {
        for argument in extra {
            args.push(
                argument
                    .as_str()
                    .context("remote-v2 CLI args must be strings")?
                    .to_string(),
            );
        }
    }
    let invocation = parse_cli_args(args).map_err(|error| anyhow!(error.to_string()))?;
    let cli_request = CliControlRequest {
        schema_version: crate::dedicated_cli::COMMAND_SCHEMA_VERSION,
        operation_id: Uuid::parse_str(&request.operation_id)?,
        expected_revision: request
            .payload
            .get("expectedRevision")
            .and_then(Value::as_u64),
        command: invocation.command,
    };
    let request_json = serde_json::to_string(&json!({ "kind": "cli", "request": cli_request }))?;
    let req = take_req(next_req);
    match request_reply(
        daemon_writer,
        daemon_inbox,
        req,
        ClientToDaemon::Cli {
            req,
            operation_id: cli_request.operation_id,
            request_json,
        },
    )? {
        ReplyResult::Cli(response) => {
            let value: Value = serde_json::from_str(&response)?;
            if value.get("ok").and_then(Value::as_bool) == Some(false) {
                bail!(
                    "remote CLI request failed: {}",
                    value.get("error").cloned().unwrap_or(Value::Null)
                );
            }
            Ok(value.get("result").cloned().unwrap_or(Value::Null))
        }
        other => bail!("unexpected remote CLI reply: {other:?}"),
    }
}

fn handle_v2_files(
    request: &V2Envelope,
    method: &str,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
) -> Result<Value> {
    let root = v2_workspace_root(&request.payload, daemon_writer, daemon_inbox, next_req)?;
    let relative = request
        .payload
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("");
    let path = confined_workspace_path(&root, relative, method == "write")?;
    match method {
        "list" => {
            let mut entries = fs::read_dir(&path)?
                .map(|entry| {
                    let entry = entry?;
                    let metadata = entry.metadata()?;
                    Ok(json!({
                        "name": entry.file_name().to_string_lossy(),
                        "path": entry.path().strip_prefix(&root).unwrap_or(entry.path().as_path()).to_string_lossy().replace('\\', "/"),
                        "kind": if metadata.is_dir() { "directory" } else { "file" },
                        "size": metadata.len(),
                    }))
                })
                .collect::<Result<Vec<_>>>()?;
            entries.sort_by(|left, right| {
                left.get("name")
                    .and_then(Value::as_str)
                    .cmp(&right.get("name").and_then(Value::as_str))
            });
            Ok(json!({ "path": relative, "entries": entries }))
        }
        "read" => {
            let metadata = fs::metadata(&path)?;
            if metadata.len() > 1024 * 1024 {
                bail!("file exceeds remote text read limit");
            }
            Ok(json!({ "path": relative, "text": fs::read_to_string(&path)? }))
        }
        "write" => {
            let text = request
                .payload
                .get("text")
                .and_then(Value::as_str)
                .context("text is required")?;
            if text.len() > 1024 * 1024 {
                bail!("file exceeds remote text write limit");
            }
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, text)?;
            Ok(json!({ "path": relative, "bytes": text.len() }))
        }
        _ => bail!("unsupported remote-v2 files method {method}"),
    }
}

fn handle_v2_git(
    request: &V2Envelope,
    method: &str,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
) -> Result<Value> {
    let root = v2_workspace_root(&request.payload, daemon_writer, daemon_inbox, next_req)?;
    let args = match method {
        "status" => vec!["status", "--short", "--branch"],
        "log" => vec![
            "log",
            "-n",
            "50",
            "--date=iso-strict",
            "--pretty=format:%H%x09%ad%x09%an%x09%s",
        ],
        "diff" => vec!["diff", "--no-ext-diff"],
        "stage" => vec![
            "add",
            request
                .payload
                .get("path")
                .and_then(Value::as_str)
                .context("path is required")?,
        ],
        "commit" => vec![
            "commit",
            "-m",
            request
                .payload
                .get("message")
                .and_then(Value::as_str)
                .context("message is required")?,
        ],
        _ => bail!("unsupported remote-v2 git method {method}"),
    };
    let output = ProcessCommand::new("git")
        .arg("-C")
        .arg(&root)
        .args(args)
        .output()
        .context("run git")?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if !output.status.success() {
        bail!("git {method} failed: {stderr}");
    }
    Ok(json!({ "stdout": stdout, "stderr": stderr, "exitCode": output.status.code() }))
}

fn v2_workspace_root(
    payload: &Value,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
) -> Result<PathBuf> {
    let workspace_id = v2_uuid(payload, "workspaceId")?;
    let session = list_sessions(daemon_writer, daemon_inbox, next_req)?
        .into_iter()
        .find(|session| session.id == workspace_id)
        .context("workspace not found")?;
    let root = PathBuf::from(
        session
            .workspace_folder
            .context("workspace has no folder")?,
    );
    fs::canonicalize(root).context("canonicalize workspace folder")
}

fn confined_workspace_path(root: &Path, relative: &str, allow_missing: bool) -> Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        bail!("path must stay within the workspace");
    }
    let candidate = root.join(relative);
    if candidate.exists() {
        let canonical = fs::canonicalize(&candidate)?;
        if !canonical.starts_with(root) {
            bail!("path escapes the workspace");
        }
        return Ok(canonical);
    }
    if !allow_missing {
        bail!("path not found");
    }
    let parent = candidate.parent().context("path has no parent")?;
    let canonical_parent = fs::canonicalize(parent).context("write parent not found")?;
    if !canonical_parent.starts_with(root) {
        bail!("path escapes the workspace");
    }
    Ok(candidate)
}

fn v2_error<'a>(request: &'a V2Envelope, code: &str, message: &str) -> V2Response<'a> {
    V2Response {
        version: V2_PROTOCOL_VERSION,
        request_id: &request.request_id,
        domain: &request.domain,
        method: &request.method,
        operation_id: &request.operation_id,
        sequence: request.sequence,
        revocation_epoch: request.revocation_epoch,
        payload: Value::Null,
        error: Some(json!({ "code": code, "message": message })),
    }
}

fn v2_error_with_details<'a>(
    request: &'a V2Envelope,
    code: &str,
    message: &str,
    details: Value,
) -> V2Response<'a> {
    let mut response = v2_error(request, code, message);
    if let Some(error) = response.error.as_mut().and_then(Value::as_object_mut) {
        error.insert("details".to_string(), details);
    }
    response
}

fn v2_error_code(error: &anyhow::Error) -> &'static str {
    let message = error.to_string().to_ascii_lowercase();
    if message.contains("capability_denied") {
        "capability_denied"
    } else if message.contains("stale_target") {
        "stale_target"
    } else if message.contains("stale_ref") {
        "stale_ref"
    } else if message.contains("unsupported") {
        "unsupported"
    } else if message.contains("not found") || message.contains("not_found") {
        "not_found"
    } else if message.contains("too large") || message.contains("exceeds") {
        "frame_too_large"
    } else if message.contains("timeout") || message.contains("timed out") {
        "timeout"
    } else if message.contains("conflict") {
        "conflict"
    } else if message.contains("required")
        || message.contains("invalid")
        || message.contains("must")
        || message.contains("within the workspace")
    {
        "invalid_argument"
    } else {
        "internal"
    }
}

fn read_binary(ws: &mut RemoteSocket, context: &str) -> Result<Vec<u8>> {
    match ws.read().with_context(|| context.to_string())? {
        Message::Binary(bytes) => Ok(bytes.to_vec()),
        _ => bail!("{context} must be binary"),
    }
}

fn v2_uuid(payload: &Value, key: &str) -> Result<Uuid> {
    Uuid::parse_str(
        payload
            .get(key)
            .and_then(Value::as_str)
            .with_context(|| format!("{key} is required"))?,
    )
    .with_context(|| format!("{key} must be a UUID"))
}

fn require_grant(grants: &[String], grant: &str) -> Result<()> {
    if grants
        .iter()
        .any(|candidate| candidate == grant || candidate == "admin")
    {
        Ok(())
    } else {
        bail!("capability_denied: {grant}")
    }
}

fn open_daemon_connection() -> Result<(interprocess::local_socket::SendHalf, DaemonInbox)> {
    let stream =
        spawn_daemon::connect_daemon().context("connect authenticated remote daemon client")?;
    let (reader, writer) = stream.split();
    let (senders, inbox) = daemon_channels(DAEMON_OUTPUT_QUEUE_CAPACITY);
    thread::Builder::new()
        .name("vibelink-remote-daemon-reader".to_string())
        .spawn(move || daemon_reader(reader, senders))?;
    Ok((writer, inbox))
}

fn daemon_reader(mut reader: interprocess::local_socket::RecvHalf, senders: DaemonSenders) {
    while let Ok(message) = read_frame::<_, DaemonToClient>(&mut reader) {
        let output = matches!(&message, DaemonToClient::Output { .. });
        if route_daemon_message(&senders, message) {
            continue;
        }
        if output {
            tracing::warn!("dropping remote daemon output for slow client");
        } else {
            break;
        }
    }
}

fn run_authenticated(
    ws: &mut RemoteSocket,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    push_rx: &Receiver<Message>,
    close_requested: &AtomicBool,
    shared: &RemoteShared,
    client_key: Uuid,
    device_id: &str,
    grants: &[String],
) -> Result<()> {
    if !has_grant(grants, TERMINAL_VIEW_GRANT) {
        send_error(
            ws,
            "capabilityDenied",
            "terminal viewing is not granted",
            None,
        )?;
        bail!("remote device lacks terminal.view");
    }
    let mut next_req = 1_u64;
    let mut attached: Option<Uuid> = None;
    let mut attached_panes: Vec<Uuid> = Vec::new();
    let mut pane_geometry: HashMap<Uuid, (u16, u16)> = HashMap::new();
    let mut leases = RemoteLeaseProjection::default();
    let appearance = shared
        .appearance
        .read()
        .expect("remote appearance lock")
        .clone();
    send_json(
        ws,
        &ServerMessage::Appearance {
            payload: appearance,
        },
    )?;
    let sessions = list_sessions(daemon_writer, daemon_inbox, &mut next_req)?;
    send_workspaces(
        ws,
        ordered_sessions(
            sessions,
            &shared
                .workspace_order
                .read()
                .expect("remote workspace order lock"),
        ),
        &shared
            .workspace_alerts
            .read()
            .expect("remote workspace alerts lock"),
        None,
    )?;

    let mut last_ping = Instant::now();
    let mut last_lease_renewal = Instant::now();
    let mut last_peer_activity = Instant::now();
    loop {
        if close_requested.load(Ordering::Acquire) {
            let _ = ws.send(Message::Close(None));
            return Ok(());
        }
        for _ in 0..MAX_CONTROL_FRAMES_PER_LOOP {
            let Some(message) = daemon_inbox.try_control()? else {
                break;
            };
            handle_daemon_control(
                ws,
                daemon_writer,
                daemon_inbox,
                shared,
                client_key,
                &mut next_req,
                attached,
                &mut attached_panes,
                &mut pane_geometry,
                &mut leases,
                message,
            )?;
        }
        for _ in 0..MAX_PUSH_FRAMES_PER_LOOP {
            let Ok(message) = push_rx.try_recv() else {
                break;
            };
            ws.send(message)?;
        }
        let mut output_bytes = 0_usize;
        for _ in 0..MAX_OUTPUT_FRAMES_PER_LOOP {
            if daemon_inbox.has_pending_control() || output_bytes >= MAX_OUTPUT_BYTES_PER_LOOP {
                break;
            }
            let Some(message) = daemon_inbox.try_output()? else {
                break;
            };
            if let DaemonToClient::Output { pane_id, data } = message {
                output_bytes = output_bytes.saturating_add(data.len());
                if attached_panes.contains(&pane_id) {
                    ws.send(Message::Binary(
                        frame_pane_output(&pane_id.to_string(), &data).into(),
                    ))?;
                }
            }
        }

        match ws.read() {
            Ok(Message::Text(text)) => {
                last_peer_activity = Instant::now();
                let message: ClientMessage =
                    serde_json::from_str(text.as_ref()).context("parse remote message")?;
                handle_client_message(
                    ws,
                    daemon_writer,
                    daemon_inbox,
                    shared,
                    client_key,
                    device_id,
                    &mut next_req,
                    &mut attached,
                    &mut attached_panes,
                    &mut pane_geometry,
                    &mut leases,
                    grants,
                    message,
                )?;
            }
            Ok(Message::Pong(_)) => last_peer_activity = Instant::now(),
            Ok(Message::Ping(data)) => {
                last_peer_activity = Instant::now();
                ws.send(Message::Pong(data))?;
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => bail!("unexpected remote websocket message kind"),
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
        if last_lease_renewal.elapsed() >= REMOTE_LEASE_RENEW_INTERVAL {
            renew_remote_leases(
                daemon_writer,
                daemon_inbox,
                &mut next_req,
                client_key,
                device_id,
                &mut leases,
            )?;
            last_lease_renewal = Instant::now();
        }

        if last_ping.elapsed() >= KEEPALIVE_INTERVAL {
            if last_peer_activity.elapsed() >= KEEPALIVE_DEADLINE {
                bail!("remote keepalive timed out");
            }
            ws.send(Message::Ping(Vec::new().into()))?;
            last_ping = Instant::now();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn handle_client_message(
    ws: &mut RemoteSocket,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    shared: &RemoteShared,
    client_key: Uuid,
    device_id: &str,
    next_req: &mut u64,
    attached: &mut Option<Uuid>,
    attached_panes: &mut Vec<Uuid>,
    pane_geometry: &mut HashMap<Uuid, (u16, u16)>,
    leases: &mut RemoteLeaseProjection,
    grants: &[String],
    message: ClientMessage,
) -> Result<()> {
    if let Some(required) = required_grant(&message) {
        if !has_grant(grants, required) {
            return send_error(
                ws,
                "capabilityDenied",
                "remote device capability denied",
                message.req_id(),
            );
        }
    }
    match message {
        ClientMessage::Hello { .. } => {
            send_error(ws, "authFailed", "hello may only be sent once", None)
        }
        ClientMessage::ListWorkspaces { req_id } => {
            let sessions = list_sessions(daemon_writer, daemon_inbox, next_req)?;
            send_workspaces(
                ws,
                ordered_sessions(
                    sessions,
                    &shared
                        .workspace_order
                        .read()
                        .expect("remote workspace order lock"),
                ),
                &shared
                    .workspace_alerts
                    .read()
                    .expect("remote workspace alerts lock"),
                req_id,
            )
        }
        ClientMessage::AttachWorkspace { session_id, req_id } => {
            let session_id = parse_uuid(&session_id, ws, req_id)?;
            if let Some(previous) = *attached {
                cleanup_remote_connection(
                    daemon_writer,
                    daemon_inbox,
                    client_key,
                    take_req(next_req),
                )?;
                leases.by_pane.clear();
                write_frame(
                    daemon_writer,
                    &ClientToDaemon::DetachSession {
                        session_id: previous,
                    },
                )?;
            }
            let (layout, panes) =
                attach_session(daemon_writer, daemon_inbox, next_req, session_id)?;
            let order = pane_order(layout.as_deref(), &panes);
            let pane_by_id: HashMap<_, _> = panes.into_iter().map(|pane| (pane.id, pane)).collect();
            let ordered: Vec<_> = order
                .into_iter()
                .filter_map(|id| pane_by_id.get(&id).cloned())
                .collect();
            attached_panes.clear();
            attached_panes.extend(ordered.iter().map(|pane| pane.id));
            pane_geometry.clear();
            pane_geometry.extend(
                ordered
                    .iter()
                    .map(|pane| (pane.id, (pane.config.cols, pane.config.rows))),
            );
            *attached = Some(session_id);
            send_json(
                ws,
                &ServerMessage::WorkspaceAttached {
                    session_id: session_id.to_string(),
                    panes: ordered.iter().map(PaneDto::from).collect(),
                    req_id,
                },
            )?;
            for pane in &ordered {
                write_frame(
                    daemon_writer,
                    &ClientToDaemon::AttachPane {
                        session_id,
                        pane_id: pane.id,
                    },
                )?;
            }
            Ok(())
        }
        ClientMessage::DetachWorkspace { session_id, req_id } => {
            let session_id = parse_uuid(&session_id, ws, req_id)?;
            cleanup_remote_connection(daemon_writer, daemon_inbox, client_key, take_req(next_req))?;
            leases.by_pane.clear();
            write_frame(daemon_writer, &ClientToDaemon::DetachSession { session_id })?;
            if *attached == Some(session_id) {
                *attached = None;
                attached_panes.clear();
                pane_geometry.clear();
            }
            Ok(())
        }
        ClientMessage::WritePane {
            pane_id,
            data,
            req_id,
        } => {
            let Some(session_id) = *attached else {
                return send_error(ws, "internal", "no workspace attached", req_id);
            };
            let pane_id = parse_uuid(&pane_id, ws, req_id)?;
            write_frame(
                daemon_writer,
                &ClientToDaemon::WritePane {
                    session_id,
                    pane_id,
                    data: data.into_bytes(),
                    origin: leases
                        .by_pane
                        .get(&pane_id)
                        .map(|lease| {
                            remote_origin(
                                client_key,
                                device_id,
                                Some(lease.lease_id),
                                Some(lease.revision),
                            )
                        })
                        .unwrap_or_else(|| remote_origin(client_key, device_id, None, None)),
                },
            )?;
            Ok(())
        }
        ClientMessage::RefreshPane { pane_id, req_id } => {
            let Some(session_id) = *attached else {
                return send_error(ws, "internal", "no workspace attached", req_id);
            };
            let pane_id = parse_uuid(&pane_id, ws, req_id)?;
            let req = take_req(next_req);
            let reply = request_reply(
                daemon_writer,
                daemon_inbox,
                req,
                ClientToDaemon::GetScrollback {
                    req,
                    session_id,
                    pane_id,
                },
            )?;
            match reply {
                ReplyResult::ScrollbackData(data) => send_json(
                    ws,
                    &ServerMessage::PaneBuffer {
                        pane_id: pane_id.to_string(),
                        data_b64: encode_buffer(&data),
                        req_id,
                    },
                ),
                other => Err(anyhow!("unexpected scrollback reply: {other:?}")),
            }
        }
        ClientMessage::ClaimPane {
            pane_id,
            cols,
            rows,
            req_id,
        } => {
            let Some(session_id) = *attached else {
                return send_error(ws, "internal", "no workspace attached", req_id);
            };
            let pane_id = parse_uuid(&pane_id, ws, req_id)?;
            if !attached_panes.contains(&pane_id) {
                return send_error(ws, "internal", "pane not attached", req_id);
            }
            let current = leases.by_pane.get(&pane_id).cloned();
            let req = take_req(next_req);
            let result = request_reply(
                daemon_writer,
                daemon_inbox,
                req,
                ClientToDaemon::RemotePaneLeaseClaim {
                    req,
                    request: RemotePaneLeaseClaimRequest {
                        owner_connection_id: client_key,
                        device_id: device_id.to_string(),
                        session_id,
                        pane_id,
                        cols: cols.clamp(20, 360),
                        rows: rows.clamp(5, 200),
                        viewport_revision: current
                            .as_ref()
                            .map(|lease| lease.viewport_revision.saturating_add(1))
                            .unwrap_or(1),
                        lease_id: current.as_ref().map(|lease| lease.lease_id),
                        revision: current.as_ref().map(|lease| lease.revision),
                    },
                },
            )?;
            match result {
                ReplyResult::RemotePaneLease(
                    RemotePaneLeaseResult::Claimed { lease }
                    | RemotePaneLeaseResult::Updated { lease }
                    | RemotePaneLeaseResult::Renewed { lease },
                ) => {
                    leases.record(lease.clone());
                    send_json(
                        ws,
                        &ServerMessage::PaneLease {
                            pane_id: pane_id.to_string(),
                            leased: true,
                            cols: Some(lease.target_cols),
                            rows: Some(lease.target_rows),
                            req_id,
                        },
                    )
                }
                ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Busy { .. }) => send_error(
                    ws,
                    "paneBusy",
                    "pane is already in use by another mobile client",
                    req_id,
                ),
                ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Stale { .. }) => {
                    send_error(ws, "paneBusy", "pane lease changed; claim it again", req_id)
                }
                other => Err(anyhow!("unexpected pane lease claim reply: {other:?}")),
            }
        }
        ClientMessage::ReleasePane { pane_id, req_id } => {
            let pane_id = parse_uuid(&pane_id, ws, req_id)?;
            if let Some(lease) = leases.by_pane.get(&pane_id).cloned() {
                let req = take_req(next_req);
                match request_reply(
                    daemon_writer,
                    daemon_inbox,
                    req,
                    ClientToDaemon::RemotePaneLeaseRelease {
                        req,
                        request: RemotePaneLeaseReleaseRequest {
                            owner_connection_id: client_key,
                            device_id: device_id.to_string(),
                            session_id: lease.session_id,
                            pane_id,
                            lease_id: lease.lease_id,
                            revision: lease.revision,
                        },
                    },
                )? {
                    ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Released { .. })
                    | ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Stale { .. }) => {
                        leases.remove_pane(pane_id);
                    }
                    other => return Err(anyhow!("unexpected pane lease release reply: {other:?}")),
                }
            }
            send_json(
                ws,
                &ServerMessage::PaneLease {
                    pane_id: pane_id.to_string(),
                    leased: false,
                    cols: None,
                    rows: None,
                    req_id,
                },
            )
        }
        ClientMessage::Unknown => Ok(()),
        ClientMessage::Ping { req_id } => send_json(ws, &ServerMessage::Pong { req_id }),
    }
}
fn required_grant(message: &ClientMessage) -> Option<&'static str> {
    match message {
        ClientMessage::WritePane { .. }
        | ClientMessage::ClaimPane { .. }
        | ClientMessage::ReleasePane { .. } => Some(TERMINAL_INPUT_GRANT),
        ClientMessage::ListWorkspaces { .. }
        | ClientMessage::AttachWorkspace { .. }
        | ClientMessage::DetachWorkspace { .. }
        | ClientMessage::RefreshPane { .. } => Some(TERMINAL_VIEW_GRANT),
        ClientMessage::Hello { .. } | ClientMessage::Ping { .. } | ClientMessage::Unknown => None,
    }
}

fn has_grant(grants: &[String], required: &str) -> bool {
    grants.iter().any(|grant| grant == required)
}

fn handle_daemon_control(
    ws: &mut RemoteSocket,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    _shared: &RemoteShared,
    client_key: Uuid,
    next_req: &mut u64,
    attached: Option<Uuid>,
    attached_panes: &mut Vec<Uuid>,
    pane_geometry: &mut HashMap<Uuid, (u16, u16)>,
    leases: &mut RemoteLeaseProjection,
    message: DaemonToClient,
) -> Result<()> {
    match message {
        DaemonToClient::PaneExited { pane_id, .. } if attached_panes.contains(&pane_id) => {
            pane_geometry.remove(&pane_id);
            leases.remove_pane(pane_id);
            send_json(
                ws,
                &ServerMessage::PaneExited {
                    pane_id: pane_id.to_string(),
                },
            )
        }
        DaemonToClient::PaneResized {
            session_id,
            pane_id,
            cols,
            rows,
        } if attached == Some(session_id) => {
            pane_geometry.insert(pane_id, (cols, rows));
            send_json(
                ws,
                &ServerMessage::PaneResized {
                    pane_id: pane_id.to_string(),
                    cols,
                    rows,
                },
            )
        }
        DaemonToClient::SessionChanged { session_id } if attached == Some(session_id) => {
            let (layout, panes) =
                attach_session(daemon_writer, daemon_inbox, next_req, session_id)?;
            let order = pane_order(layout.as_deref(), &panes);
            let pane_by_id: HashMap<_, _> = panes.into_iter().map(|pane| (pane.id, pane)).collect();
            let ordered: Vec<_> = order
                .into_iter()
                .filter_map(|id| pane_by_id.get(&id).cloned())
                .collect();
            attached_panes.clear();
            attached_panes.extend(ordered.iter().map(|pane| pane.id));
            pane_geometry.clear();
            pane_geometry.extend(
                ordered
                    .iter()
                    .map(|pane| (pane.id, (pane.config.cols, pane.config.rows))),
            );
            send_json(
                ws,
                &ServerMessage::PanesChanged {
                    session_id: session_id.to_string(),
                    panes: ordered.iter().map(PaneDto::from).collect(),
                },
            )
        }
        DaemonToClient::RemotePaneLease { event } if event.owner_connection_id == client_key => {
            apply_lease_event(leases, &event);
            send_json(
                ws,
                &ServerMessage::PaneLease {
                    pane_id: event.pane_id.to_string(),
                    leased: event.leased,
                    cols: event.cols,
                    rows: event.rows,
                    req_id: None,
                },
            )
        }
        DaemonToClient::Error { message, .. } => send_error(ws, "internal", &message, None),
        _ => Ok(()),
    }
}

fn renew_remote_leases(
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
    owner_connection_id: Uuid,
    device_id: &str,
    leases: &mut RemoteLeaseProjection,
) -> Result<()> {
    for lease in leases.by_pane.values().cloned().collect::<Vec<_>>() {
        let req = take_req(next_req);
        match request_reply(
            daemon_writer,
            daemon_inbox,
            req,
            ClientToDaemon::RemotePaneLeaseRenew {
                req,
                request: RemotePaneLeaseRenewRequest {
                    owner_connection_id,
                    device_id: device_id.to_string(),
                    session_id: lease.session_id,
                    pane_id: lease.pane_id,
                    lease_id: lease.lease_id,
                    revision: lease.revision,
                    viewport_revision: lease.viewport_revision,
                },
            },
        )? {
            ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Renewed { lease })
            | ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Updated { lease }) => {
                leases.record(lease);
            }
            ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Stale { .. }) => {
                leases.remove_pane(lease.pane_id);
            }
            other => bail!("unexpected remote lease renew reply: {other:?}"),
        }
    }
    Ok(())
}

fn cleanup_remote_connection(
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    owner_connection_id: Uuid,
    req: u64,
) -> Result<()> {
    match request_reply(
        daemon_writer,
        daemon_inbox,
        req,
        ClientToDaemon::RemoteConnectionCleanup {
            req,
            request: RemoteConnectionCleanupRequest {
                owner_connection_id,
            },
        },
    )? {
        ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Cleanup { .. }) => Ok(()),
        other => bail!("unexpected remote connection cleanup reply: {other:?}"),
    }
}

fn list_sessions(
    writer: &mut interprocess::local_socket::SendHalf,
    inbox: &mut DaemonInbox,
    next_req: &mut u64,
) -> Result<Vec<SessionMeta>> {
    let req = take_req(next_req);
    match request_reply(writer, inbox, req, ClientToDaemon::ListSessions { req })? {
        ReplyResult::Sessions(sessions) => Ok(sessions),
        other => Err(anyhow!("unexpected session list reply: {other:?}")),
    }
}

fn attach_session(
    writer: &mut interprocess::local_socket::SendHalf,
    inbox: &mut DaemonInbox,
    next_req: &mut u64,
    session_id: Uuid,
) -> Result<(Option<String>, Vec<PaneMeta>)> {
    let req = take_req(next_req);
    match request_reply(
        writer,
        inbox,
        req,
        ClientToDaemon::AttachSession { req, session_id },
    )? {
        ReplyResult::Attached { layout_json, panes } => Ok((layout_json, panes)),
        other => Err(anyhow!("unexpected attach reply: {other:?}")),
    }
}

fn request_control_result(
    inbox: &mut DaemonInbox,
    req: u64,
    message: DaemonToClient,
) -> Result<Option<ReplyResult>> {
    match message {
        DaemonToClient::Reply {
            req: reply_req,
            result,
        } if reply_req == req => Ok(Some(result)),
        DaemonToClient::Error {
            req: Some(reply_req),
            message,
        } if reply_req == req => bail!(message),
        unrelated => {
            inbox.defer_control(unrelated);
            Ok(None)
        }
    }
}

fn request_reply(
    writer: &mut interprocess::local_socket::SendHalf,
    inbox: &mut DaemonInbox,
    req: u64,
    message: ClientToDaemon,
) -> Result<ReplyResult> {
    write_frame(writer, &message)?;
    let deadline = Instant::now() + DAEMON_REPLY_TIMEOUT;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            bail!("daemon request {req} timed out");
        }
        let message = inbox.recv_new_control_timeout(remaining)?;
        if let Some(result) = request_control_result(inbox, req, message)? {
            return Ok(result);
        }
    }
}

fn ordered_sessions(sessions: Vec<SessionMeta>, order: &[String]) -> Vec<SessionMeta> {
    let mut by_id: std::collections::HashMap<_, _> = sessions
        .iter()
        .cloned()
        .map(|session| (session.id.to_string(), session))
        .collect();
    let mut ordered = Vec::new();
    for id in order {
        if let Some(session) = by_id.remove(id) {
            ordered.push(session);
        }
    }
    for session in sessions {
        if let Some(session) = by_id.remove(&session.id.to_string()) {
            ordered.push(session);
        }
    }
    ordered
}

fn send_workspaces(
    ws: &mut RemoteSocket,
    sessions: Vec<SessionMeta>,
    alerts: &std::collections::HashMap<String, usize>,
    req_id: Option<u64>,
) -> Result<()> {
    let workspaces = sessions
        .into_iter()
        .map(|session| {
            let alert_count = alerts.get(&session.id.to_string()).copied().unwrap_or(0);
            WorkspaceDto::from_session(session, alert_count)
        })
        .collect();
    send_json(ws, &ServerMessage::Workspaces { workspaces, req_id })
}

fn send_json(ws: &mut RemoteSocket, message: &ServerMessage) -> Result<()> {
    ws.send(Message::Text(serde_json::to_string(message)?.into()))?;
    Ok(())
}

fn send_error(ws: &mut RemoteSocket, code: &str, message: &str, req_id: Option<u64>) -> Result<()> {
    send_json(
        ws,
        &ServerMessage::Error {
            code: code.to_string(),
            message: message.to_string(),
            req_id,
        },
    )
}

fn parse_uuid(value: &str, ws: &mut RemoteSocket, req_id: Option<u64>) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        let _ = send_error(ws, "internal", "invalid identifier", req_id);
        error.into()
    })
}

fn take_req(next_req: &mut u64) -> u64 {
    let value = *next_req;
    *next_req = next_req.saturating_add(1);
    value
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_workspace_order_precedes_unsaved_sessions() {
        let a = SessionMeta {
            id: Uuid::new_v4(),
            name: "A".into(),
            pane_count: 0,
            created_at: 1,
            workspace_folder: None,
        };
        let b = SessionMeta {
            id: Uuid::new_v4(),
            name: "B".into(),
            pane_count: 0,
            created_at: 2,
            workspace_folder: None,
        };
        let c = SessionMeta {
            id: Uuid::new_v4(),
            name: "C".into(),
            pane_count: 0,
            created_at: 3,
            workspace_folder: None,
        };
        let result = ordered_sessions(
            vec![a.clone(), b.clone(), c.clone()],
            &[b.id.to_string(), "missing".into(), a.id.to_string()],
        );
        assert_eq!(
            result.iter().map(|session| session.id).collect::<Vec<_>>(),
            vec![b.id, a.id, c.id]
        );
    }

    #[test]
    fn byte_saturated_output_queue_marks_one_pane_gap_but_control_survives() {
        let (senders, mut inbox) = daemon_channels(8);
        let buffered_pane = Uuid::new_v4();
        let gapped_pane = Uuid::new_v4();

        assert!(route_daemon_message(
            &senders,
            DaemonToClient::Output {
                pane_id: buffered_pane,
                data: vec![1; DAEMON_OUTPUT_QUEUE_MAX_BYTES],
            }
        ));
        assert_eq!(inbox.queued_output_bytes(), DAEMON_OUTPUT_QUEUE_MAX_BYTES);
        assert!(!route_daemon_message(
            &senders,
            DaemonToClient::Output {
                pane_id: gapped_pane,
                data: vec![2],
            }
        ));
        let gaps = inbox.take_all_output_drops();
        assert_eq!(gaps.len(), 1);
        assert_eq!(gaps.get(&gapped_pane), Some(&1));
        assert!(!gaps.contains_key(&buffered_pane));

        assert!(route_daemon_message(
            &senders,
            DaemonToClient::Reply {
                req: 7,
                result: ReplyResult::Ok,
            }
        ));
        assert_eq!(
            inbox.try_control().expect("reply control"),
            Some(DaemonToClient::Reply {
                req: 7,
                result: ReplyResult::Ok,
            })
        );
        match inbox.try_output().expect("output receive") {
            Some(DaemonToClient::Output { pane_id, data }) => {
                assert_eq!(pane_id, buffered_pane);
                assert_eq!(data.len(), DAEMON_OUTPUT_QUEUE_MAX_BYTES);
            }
            other => panic!("unexpected queued output: {other:?}"),
        }
        assert_eq!(inbox.queued_output_bytes(), 0);
    }

    #[test]
    fn five_mib_two_hundred_frame_queue_stays_within_both_bounds() {
        let frame_capacity = 80;
        let (senders, mut inbox) = daemon_channels(frame_capacity);
        let pane_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let frame_bytes = 26_215;
        let mut accepted = 0;
        for _ in 0..200 {
            if route_daemon_message(
                &senders,
                DaemonToClient::Output {
                    pane_id,
                    data: vec![3; frame_bytes],
                },
            ) {
                accepted += 1;
            }
        }
        assert!(accepted <= frame_capacity);
        assert!(accepted < 200);
        assert!(inbox.queued_output_bytes() <= DAEMON_OUTPUT_QUEUE_MAX_BYTES);
        assert!(
            inbox
                .take_all_output_drops()
                .get(&pane_id)
                .copied()
                .unwrap_or(0)
                > 0
        );
        assert!(route_daemon_message(
            &senders,
            DaemonToClient::SessionChanged { session_id }
        ));
        assert_eq!(
            inbox.try_control().expect("control survives saturation"),
            Some(DaemonToClient::SessionChanged { session_id })
        );
        let mut drained = 0;
        while inbox.try_output().expect("drain queued output").is_some() {
            drained += 1;
        }
        assert_eq!(drained, accepted);
        assert_eq!(inbox.queued_output_bytes(), 0);
    }

    #[test]
    fn unrelated_control_is_deferred_while_waiting_for_reply() {
        let (_, mut inbox) = daemon_channels(1);
        let session_id = Uuid::new_v4();

        for _ in 0..2 {
            assert_eq!(
                request_control_result(
                    &mut inbox,
                    7,
                    DaemonToClient::SessionChanged { session_id }
                )
                .expect("defer control"),
                None,
            );
        }
        assert_eq!(
            request_control_result(
                &mut inbox,
                7,
                DaemonToClient::Reply {
                    req: 7,
                    result: ReplyResult::Ok
                }
            )
            .expect("match reply"),
            Some(ReplyResult::Ok),
        );
        assert_eq!(
            inbox.try_control().expect("first deferred control"),
            Some(DaemonToClient::SessionChanged { session_id })
        );
        assert_eq!(
            inbox.try_control().expect("second deferred control"),
            Some(DaemonToClient::SessionChanged { session_id })
        );
    }
    #[test]
    fn canonical_v2_terminal_input_maps_subscription_and_remote_lease_origin() {
        let owner_connection_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let mut subscriptions = HashMap::new();
        subscriptions.insert(
            "subscription-1".to_string(),
            V2Subscription {
                workspace_id: session_id,
                pane_id,
                stream_id: v2_stream_id(pane_id),
            },
        );
        let mut leases = RemoteLeaseProjection::default();
        leases.record(RemotePaneLease {
            lease_id,
            owner_connection_id,
            device_id: "device-1".to_string(),
            session_id,
            pane_id,
            pane_generation: 7,
            revision: 4,
            original_cols: 100,
            original_rows: 30,
            target_cols: 120,
            target_rows: 40,
            viewport_revision: 43,
            expires_at: 99,
        });
        let params: TerminalInputParams = serde_json::from_value(json!({
            "subscriptionId": "subscription-1",
            "leaseId": lease_id,
            "dataBase64": "cHdkDQ==",
        }))
        .expect("parse canonical terminal input");

        let command = map_v2_terminal_input(
            params,
            &subscriptions,
            &leases,
            owner_connection_id,
            "device-1",
        )
        .expect("map terminal input");
        assert!(matches!(
            command,
            ClientToDaemon::WritePane {
                session_id: mapped_session,
                pane_id: mapped_pane,
                data,
                origin: PaneCommandOrigin::Remote {
                    owner_connection_id: mapped_owner,
                    device_id,
                    lease_id: Some(mapped_lease),
                    revision: Some(4),
                },
            } if mapped_session == session_id
                && mapped_pane == pane_id
                && mapped_owner == owner_connection_id
                && mapped_lease == lease_id
                && device_id == "device-1"
                && data == b"pwd\r"
        ));
        assert!(serde_json::from_value::<TerminalInputParams>(json!({
            "sessionId": session_id,
            "paneId": pane_id,
            "data": "cHdkDQ==",
        }))
        .is_err());
    }

    #[test]
    fn terminal_ack_releases_capacity_and_rejects_aliases() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let stream_id = v2_stream_id(pane_id);
        let subscription_id = "subscription-ack".to_string();
        let subscriptions = HashMap::from([(
            subscription_id.clone(),
            V2Subscription {
                workspace_id: session_id,
                pane_id,
                stream_id,
            },
        )]);
        let mut acknowledgements = TerminalAckWindow::new(
            TERMINAL_MAX_UNACKED_BYTES_PER_STREAM,
            TERMINAL_MAX_UNACKED_BYTES_PER_CONNECTION,
        )
        .unwrap();
        assert_eq!(
            acknowledgements.record_sent(stream_id, 1, 4096).unwrap(),
            TerminalRecordDecision::Recorded
        );
        let request = V2Envelope {
            version: V2_PROTOCOL_VERSION,
            request_id: "request-ack".to_string(),
            domain: "terminal".to_string(),
            method: "ack".to_string(),
            operation_id: Uuid::new_v4().to_string(),
            sequence: 1,
            revocation_epoch: 1,
            payload: json!({
                "subscriptionId": subscription_id,
                "sequence": 1,
            }),
        };
        assert_eq!(
            v2_terminal_ack(&request, &subscriptions, &mut acknowledgements).unwrap(),
            json!({})
        );
        assert_eq!(acknowledgements.stream_unacked_bytes(stream_id), 0);
        assert_eq!(acknowledgements.connection_unacked_bytes(), 0);
        assert!(serde_json::from_value::<TerminalAckParams>(json!({
            "subscription_id": "subscription-ack",
            "sequence": 1,
        }))
        .is_err());
        assert!(serde_json::from_value::<TerminalAckParams>(json!({
            "subscriptionId": "subscription-ack",
            "sequence": 1,
            "streamId": stream_id,
        }))
        .is_err());
    }

    #[test]
    fn five_mib_flow_emits_one_resync_and_resumes_only_after_snapshot() {
        let stream_id = 41;
        let mut acknowledgements = TerminalAckWindow::new(
            TERMINAL_MAX_UNACKED_BYTES_PER_STREAM,
            TERMINAL_MAX_UNACKED_BYTES_PER_CONNECTION,
        )
        .unwrap();
        let frame_bytes = 26_215;
        let mut sequence = 1;
        let mut sent = 0;
        let mut resync_markers = 0;
        let mut suppressed = 0;
        for _ in 0..200 {
            match record_v2_terminal_frame(&mut acknowledgements, stream_id, sequence, frame_bytes)
                .unwrap()
            {
                V2TerminalFrameDisposition::Send => sent += 1,
                V2TerminalFrameDisposition::EmitResync => {
                    acknowledgements.mark_gap(stream_id).unwrap();
                    resync_markers += 1;
                }
                V2TerminalFrameDisposition::Suppress => suppressed += 1,
            }
            sequence += 1;
        }
        assert!(sent > 0);
        assert_eq!(resync_markers, 1);
        assert!(suppressed > 0);
        assert!(acknowledgements.requires_resync(stream_id));
        assert_eq!(acknowledgements.stream_unacked_bytes(stream_id), 0);
        assert!(
            acknowledgements.connection_unacked_bytes()
                <= TERMINAL_MAX_UNACKED_BYTES_PER_CONNECTION
        );
        assert_eq!(
            record_v2_terminal_frame(&mut acknowledgements, stream_id, sequence, 1).unwrap(),
            V2TerminalFrameDisposition::Suppress
        );
        let highest_sent = acknowledgements.highest_sent_sequence(stream_id);
        acknowledgements.ack(stream_id, highest_sent).unwrap();
        assert!(acknowledgements.requires_resync(stream_id));
        assert!(acknowledgements.complete_resync(stream_id));
        assert_eq!(
            record_v2_terminal_frame(&mut acknowledgements, stream_id, sequence + 1, 1).unwrap(),
            V2TerminalFrameDisposition::Send
        );
    }

    #[test]
    fn terminal_gap_is_isolated_between_streams() {
        let mut acknowledgements = TerminalAckWindow::new(
            TERMINAL_MAX_UNACKED_BYTES_PER_STREAM,
            TERMINAL_MAX_UNACKED_BYTES_PER_CONNECTION,
        )
        .unwrap();
        assert_eq!(
            record_v2_terminal_frame(&mut acknowledgements, 11, 1, 1024).unwrap(),
            V2TerminalFrameDisposition::Send
        );
        assert_eq!(
            record_v2_terminal_frame(&mut acknowledgements, 22, 1, 1024).unwrap(),
            V2TerminalFrameDisposition::Send
        );
        assert!(fence_v2_terminal_gap(&mut acknowledgements, 11).unwrap());
        assert!(acknowledgements.requires_resync(11));
        assert!(!acknowledgements.requires_resync(22));
        assert_eq!(acknowledgements.stream_unacked_bytes(11), 0);
        assert_eq!(acknowledgements.stream_unacked_bytes(22), 1024);
        assert_eq!(
            record_v2_terminal_frame(&mut acknowledgements, 22, 2, 1024).unwrap(),
            V2TerminalFrameDisposition::Send
        );
        assert!(!fence_v2_terminal_gap(&mut acknowledgements, 11).unwrap());
    }

    #[test]
    fn duplicate_pane_subscription_is_rejected_deterministically() {
        let workspace_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let stream_id = v2_stream_id(pane_id);
        let subscriptions = HashMap::from([(
            "subscription-existing".to_string(),
            V2Subscription {
                workspace_id,
                pane_id,
                stream_id,
            },
        )]);
        let duplicate = validate_v2_subscription_target(&subscriptions, pane_id, stream_id)
            .expect_err("duplicate pane must be rejected");
        assert!(duplicate
            .to_string()
            .contains("already has a live subscription"));
        let colliding_pane = Uuid::new_v4();
        let collision = validate_v2_subscription_target(&subscriptions, colliding_pane, stream_id)
            .expect_err("stream collision must be rejected");
        assert!(collision.to_string().contains("stream id collides"));
    }

    #[test]
    fn v1_claim_maps_to_typed_daemon_request_with_generated_revision_handles() {
        let owner_connection_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let command = ClientToDaemon::RemotePaneLeaseClaim {
            req: 9,
            request: RemotePaneLeaseClaimRequest {
                owner_connection_id,
                device_id: "legacy-device".to_string(),
                session_id,
                pane_id,
                cols: 52,
                rows: 38,
                viewport_revision: 3,
                lease_id: Some(lease_id),
                revision: Some(2),
            },
        };
        assert!(matches!(
            command,
            ClientToDaemon::RemotePaneLeaseClaim { req: 9, request }
                if request.owner_connection_id == owner_connection_id
                    && request.device_id == "legacy-device"
                    && request.session_id == session_id
                    && request.pane_id == pane_id
                    && request.lease_id == Some(lease_id)
                    && request.revision == Some(2)
        ));
    }

    #[test]
    fn v2_binary_chunks_are_bounded_and_sequence_terminal_data() {
        let pane_id = Uuid::new_v4();
        let stream_id = v2_stream_id(pane_id);
        let mut sequences = HashMap::new();
        let payload = vec![7_u8; MAX_BINARY_PAYLOAD_BYTES + 1];
        let chunks = v2_binary_chunks(
            BinaryChannel::TerminalOutput,
            stream_id,
            &payload,
            FLAG_RESYNC,
            &mut sequences,
        )
        .unwrap();
        assert_eq!(chunks.len(), 2);
        assert_eq!(chunks[0].sequence, 1);
        assert_eq!(chunks[0].flags & FLAG_RESYNC, FLAG_RESYNC);
        assert_eq!(chunks[1].sequence, 2);
        assert_eq!(chunks[1].flags & FLAG_FINAL, FLAG_FINAL);
        assert!(chunks
            .iter()
            .all(|frame| frame.payload.len() <= MAX_BINARY_PAYLOAD_BYTES));
    }

    #[test]
    fn remote_socket_deadline_constants_match_streaming_contract() {
        assert_eq!(HELLO_TIMEOUT, Duration::from_secs(10));
        assert_eq!(SOCKET_WRITE_TIMEOUT, Duration::from_millis(250));
        assert_eq!(KEEPALIVE_INTERVAL, Duration::from_secs(15));
        assert_eq!(KEEPALIVE_DEADLINE, Duration::from_secs(45));
    }

    #[test]
    fn remote_v1_literals_and_binary_output_remain_unchanged() {
        assert_eq!(PROTOCOL_VERSION, 1);
        assert_eq!(SUBPROTOCOL, "vibelink-remote-v1");
        let frame = frame_pane_output("pane-1", b"abc");
        assert_eq!(
            frame,
            vec![0, 6, b'p', b'a', b'n', b'e', b'-', b'1', b'a', b'b', b'c']
        );
    }
}

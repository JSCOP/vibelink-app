use super::v2::{
    secure::{SecureFrameKind, SecureHandshake, SecureTransport},
    wire::{
        BinaryChannel, BinaryFrame, DomainSequenceValidator, OperationReplayWindow, SequenceError,
        FLAG_FINAL, FLAG_RESYNC, MAX_BINARY_PAYLOAD_BYTES,
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
    server::{desktop_name, PaneLease, RemotePaneLeaseEvent, RemoteShared},
};
use crate::dedicated_cli::{parse_args as parse_cli_args, CliControlRequest};
use crate::{
    app::spawn_daemon,
    protocol::{
        read_frame, write_frame, ClientToDaemon, DaemonToClient, PaneMeta, ReplyResult, SessionMeta,
    },
};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use crossbeam_channel::{bounded, unbounded, Receiver, Sender, TryRecvError};
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
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    handshake::server::{Request, Response},
    Message, WebSocket,
};
use uuid::Uuid;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_TIMEOUT: Duration = Duration::from_millis(30);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const KEEPALIVE_DEADLINE: Duration = Duration::from_secs(60);
const DAEMON_OUTPUT_QUEUE_CAPACITY: usize = 1024;
const PUSH_QUEUE_CAPACITY: usize = 1024;
const MAX_OUTPUT_FRAMES_PER_LOOP: usize = 32;
const MAX_REMOTE_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_REMOTE_FRAME_BYTES: usize = 1024 * 1024;

type RemoteSocket = WebSocket<StreamOwned<ServerConnection, TcpStream>>;

struct DaemonSenders {
    control: Sender<DaemonToClient>,
    output: Sender<DaemonToClient>,
    dropped_output: Arc<Mutex<HashMap<Uuid, u64>>>,
}

struct DaemonInbox {
    control: Receiver<DaemonToClient>,
    output: Receiver<DaemonToClient>,
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
            Ok(message) => Ok(Some(message)),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => bail!("remote daemon connection closed"),
        }
    }

    fn take_output_drops(&self, pane_id: Uuid) -> u64 {
        self.dropped_output
            .lock()
            .expect("remote output drops mutex")
            .remove(&pane_id)
            .unwrap_or(0)
    }
}

fn daemon_channels(output_capacity: usize) -> (DaemonSenders, DaemonInbox) {
    let (control_tx, control_rx) = unbounded();
    let (output_tx, output_rx) = bounded(output_capacity);
    let dropped_output = Arc::new(Mutex::new(HashMap::new()));
    (
        DaemonSenders {
            control: control_tx,
            output: output_tx,
            dropped_output: Arc::clone(&dropped_output),
        },
        DaemonInbox {
            control: control_rx,
            output: output_rx,
            deferred_control: VecDeque::new(),
            dropped_output,
        },
    )
}

fn route_daemon_message(senders: &DaemonSenders, message: DaemonToClient) -> bool {
    match message {
        output @ DaemonToClient::Output { pane_id, .. } => {
            if senders.output.try_send(output).is_ok() {
                true
            } else {
                let mut drops = senders
                    .dropped_output
                    .lock()
                    .expect("remote output drops mutex");
                let count = drops.entry(pane_id).or_default();
                *count = count.saturating_add(1);
                false
            }
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
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
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
    shared
        .client_senders
        .lock()
        .expect("remote clients mutex")
        .insert(client_key, push_tx);
    shared
        .client_devices
        .lock()
        .expect("remote client devices mutex")
        .insert(client_key, device_id);

    let result = run_authenticated(
        &mut ws,
        &mut daemon_writer,
        &mut daemon_inbox,
        &push_rx,
        &shared,
        client_key,
        &grants,
    );
    if let Err(error) = restore_owned_leases(&shared, client_key, &mut daemon_writer, None) {
        tracing::warn!(?error, %client_key, "failed to restore remote pane leases during disconnect");
    }
    shared
        .client_senders
        .lock()
        .expect("remote clients mutex")
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

    let client_key = Uuid::new_v4();
    let (push_tx, push_rx) = bounded(PUSH_QUEUE_CAPACITY);
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
        &shared,
        &push_rx,
        &device_id,
        &peer_fingerprint,
        revocation_epoch,
    );
    shared
        .client_senders
        .lock()
        .expect("remote clients mutex")
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
    shared: &RemoteShared,
    push_rx: &Receiver<Message>,
    device_id: &str,
    peer_fingerprint: &str,
    session_epoch: u64,
) -> Result<()> {
    let (mut daemon_writer, mut daemon_inbox) = open_daemon_connection()?;
    let mut next_req = 1_u64;
    let mut sequences = DomainSequenceValidator::default();
    let mut binary_sequences: HashMap<(BinaryChannel, u64), u64> = HashMap::new();
    loop {
        match push_rx.try_recv() {
            Ok(Message::Close(_)) | Err(TryRecvError::Disconnected) => {
                let _ = ws.send(Message::Close(None));
                break;
            }
            Ok(_) | Err(TryRecvError::Empty) => {}
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
                    continue;
                }
                let request: V2Envelope =
                    serde_json::from_slice(&frame.payload).context("parse remote-v2 envelope")?;
                let mut binary_after_response = Vec::new();
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
                            let result =
                                if request.domain == "terminal" && request.method == "snapshot" {
                                    require_grant(&authorization.grants, TERMINAL_VIEW_GRANT)
                                        .and_then(|_| {
                                            v2_terminal_snapshot(
                                                &request,
                                                &mut daemon_writer,
                                                &mut daemon_inbox,
                                                &mut next_req,
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
                                        &mut daemon_writer,
                                        &mut daemon_inbox,
                                        &mut next_req,
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
            }
            Ok(Message::Ping(payload)) => ws.send(Message::Pong(payload))?,
            Ok(Message::Close(_)) => break,
            Ok(_) => {}
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) => {}
            Err(error) => return Err(error.into()),
        }
        if authorization
            .grants
            .iter()
            .any(|grant| grant == TERMINAL_VIEW_GRANT || grant == "admin")
        {
            for _ in 0..MAX_OUTPUT_FRAMES_PER_LOOP {
                let Some(message) = daemon_inbox.try_output()? else {
                    break;
                };
                if let DaemonToClient::Output { pane_id, data } = message {
                    let dropped = daemon_inbox.take_output_drops(pane_id);
                    send_v2_terminal_output(
                        ws,
                        transport,
                        pane_id,
                        &data,
                        dropped,
                        &mut binary_sequences,
                    )?;
                }
            }
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
fn v2_terminal_snapshot(
    request: &V2Envelope,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
) -> Result<(Value, Vec<BinaryFrame>)> {
    let session_id = v2_uuid(&request.payload, "sessionId")?;
    let pane_id = v2_uuid(&request.payload, "paneId")?;
    let req = take_req(next_req);
    let data = match request_reply(
        daemon_writer,
        daemon_inbox,
        req,
        ClientToDaemon::GetScrollback {
            req,
            session_id,
            pane_id,
        },
    )? {
        ReplyResult::ScrollbackData(data) => data,
        other => bail!("unexpected terminal snapshot reply: {other:?}"),
    };
    let stream_id = v2_stream_id(pane_id);
    let frames = v2_binary_chunks(
        BinaryChannel::TerminalSnapshot,
        stream_id,
        &data,
        0,
        sequences,
    )?;
    Ok((
        json!({
            "paneId": pane_id,
            "streamId": stream_id,
            "bytes": data.len(),
            "chunks": frames.len(),
        }),
        frames,
    ))
}

fn send_v2_terminal_output(
    ws: &mut RemoteSocket,
    transport: &mut SecureTransport,
    pane_id: Uuid,
    data: &[u8],
    dropped_frames: u64,
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
) -> Result<()> {
    let stream_id = v2_stream_id(pane_id);
    if dropped_frames > 0 {
        let next = sequences
            .entry((BinaryChannel::TerminalOutput, stream_id))
            .or_insert(1);
        *next = next.saturating_add(dropped_frames);
    }
    let flags = if dropped_frames > 0 { FLAG_RESYNC } else { 0 };
    for frame in v2_binary_chunks(
        BinaryChannel::TerminalOutput,
        stream_id,
        data,
        flags,
        sequences,
    )? {
        send_v2_binary(ws, transport, frame)?;
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
    let chunks = data.chunks(MAX_BINARY_PAYLOAD_BYTES).collect::<Vec<_>>();
    if chunks.is_empty() {
        let sequence = take_binary_sequence(sequences, channel, stream_id)?;
        return Ok(vec![BinaryFrame {
            channel,
            flags: first_flags | FLAG_FINAL,
            stream_id,
            sequence,
            dropped_before: 0,
            payload: Vec::new(),
        }]);
    }
    let last = chunks.len() - 1;
    chunks
        .into_iter()
        .enumerate()
        .map(|(index, chunk)| {
            Ok(BinaryFrame {
                channel,
                flags: (if index == 0 { first_flags } else { 0 })
                    | if index == last { FLAG_FINAL } else { 0 },
                stream_id,
                sequence: take_binary_sequence(sequences, channel, stream_id)?,
                dropped_before: 0,
                payload: chunk.to_vec(),
            })
        })
        .collect()
}

fn take_binary_sequence(
    sequences: &mut HashMap<(BinaryChannel, u64), u64>,
    channel: BinaryChannel,
    stream_id: u64,
) -> Result<u64> {
    let next = sequences.entry((channel, stream_id)).or_insert(1);
    let sequence = *next;
    *next = next
        .checked_add(1)
        .context("remote-v2 binary sequence exhausted")?;
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

fn handle_v2_request(
    request: &V2Envelope,
    grants: &[String],
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
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
            let session_id = v2_uuid(&request.payload, "sessionId")?;
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
        ("terminal", "input") => {
            require_grant(grants, TERMINAL_INPUT_GRANT)?;
            let session_id = v2_uuid(&request.payload, "sessionId")?;
            let pane_id = v2_uuid(&request.payload, "paneId")?;
            let data = request
                .payload
                .get("data")
                .and_then(Value::as_str)
                .context("data is required")?;
            let data = base64::engine::general_purpose::STANDARD
                .decode(data)
                .context("decode terminal input")?;
            write_frame(
                daemon_writer,
                &ClientToDaemon::WritePane {
                    session_id,
                    pane_id,
                    data,
                },
            )?;
            Ok(json!({ "ok": true }))
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
    shared: &RemoteShared,
    client_key: Uuid,
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
    let mut last_pong = Instant::now();
    loop {
        while let Some(message) = daemon_inbox.try_control()? {
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
                message,
            )?;
        }
        while let Ok(message) = push_rx.try_recv() {
            ws.send(message)?;
        }
        for _ in 0..MAX_OUTPUT_FRAMES_PER_LOOP {
            if daemon_inbox.has_pending_control() {
                break;
            }
            let Some(message) = daemon_inbox.try_output()? else {
                break;
            };
            if let DaemonToClient::Output { pane_id, data } = message {
                if attached_panes.contains(&pane_id) {
                    ws.send(Message::Binary(
                        frame_pane_output(&pane_id.to_string(), &data).into(),
                    ))?;
                }
            }
        }

        match ws.read() {
            Ok(Message::Text(text)) => {
                let message: ClientMessage =
                    serde_json::from_str(text.as_ref()).context("parse remote message")?;
                handle_client_message(
                    ws,
                    daemon_writer,
                    daemon_inbox,
                    shared,
                    client_key,
                    &mut next_req,
                    &mut attached,
                    &mut attached_panes,
                    &mut pane_geometry,
                    grants,
                    message,
                )?;
            }
            Ok(Message::Pong(_)) => last_pong = Instant::now(),
            Ok(Message::Ping(data)) => {
                ws.send(Message::Pong(data))?;
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
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

        if last_ping.elapsed() >= KEEPALIVE_INTERVAL {
            if last_pong.elapsed() >= KEEPALIVE_DEADLINE {
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
    next_req: &mut u64,
    attached: &mut Option<Uuid>,
    attached_panes: &mut Vec<Uuid>,
    pane_geometry: &mut HashMap<Uuid, (u16, u16)>,
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
                restore_owned_leases(shared, client_key, daemon_writer, Some(previous))?;
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
            restore_owned_leases(shared, client_key, daemon_writer, Some(session_id))?;
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
            let Some(&(current_cols, current_rows)) = pane_geometry.get(&pane_id) else {
                return send_error(ws, "internal", "pane geometry unavailable", req_id);
            };
            let target = (cols.clamp(20, 360), rows.clamp(5, 200));
            let claim = claim_pane_lease(
                &mut shared.pane_leases.lock().expect("remote pane leases mutex"),
                session_id,
                pane_id,
                client_key,
                (current_cols, current_rows),
                target,
            );
            match claim {
                ClaimLeaseResult::Busy => send_error(
                    ws,
                    "paneBusy",
                    "pane is already in use by another mobile client",
                    req_id,
                ),
                ClaimLeaseResult::Claimed { lease, resize } => {
                    shared.notify_pane_lease(claimed_event(pane_id, &lease));
                    if let Some(resize) = resize {
                        write_pane_resize(daemon_writer, resize)?;
                    }
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
            }
        }
        ClientMessage::ReleasePane { pane_id, req_id } => {
            let pane_id = parse_uuid(&pane_id, ws, req_id)?;
            let restore = release_pane_lease(
                &mut shared.pane_leases.lock().expect("remote pane leases mutex"),
                pane_id,
                client_key,
            );
            if let Some(restore) = restore {
                shared.notify_pane_lease(released_event(restore.session_id, pane_id));
                write_pane_resize(daemon_writer, restore)?;
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
    shared: &RemoteShared,
    client_key: Uuid,
    next_req: &mut u64,
    attached: Option<Uuid>,
    attached_panes: &mut Vec<Uuid>,
    pane_geometry: &mut HashMap<Uuid, (u16, u16)>,
    message: DaemonToClient,
) -> Result<()> {
    match message {
        DaemonToClient::PaneExited { pane_id, .. } if attached_panes.contains(&pane_id) => {
            pane_geometry.remove(&pane_id);
            if let Some(session_id) = drop_owned_lease(
                &mut shared.pane_leases.lock().expect("remote pane leases mutex"),
                pane_id,
                client_key,
            ) {
                shared.notify_pane_lease(released_event(session_id, pane_id));
            }
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
            let target = shared
                .pane_leases
                .lock()
                .expect("remote pane leases mutex")
                .get(&pane_id)
                .filter(|lease| lease.owner == client_key)
                .map(|lease| (lease.target_cols, lease.target_rows));
            if let Some((target_cols, target_rows)) = target {
                if (cols, rows) != (target_cols, target_rows) {
                    write_frame(
                        daemon_writer,
                        &ClientToDaemon::ResizePane {
                            session_id,
                            pane_id,
                            cols: target_cols,
                            rows: target_rows,
                        },
                    )?;
                    return Ok(());
                }
            }
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
            for pane_id in drop_missing_owned_leases(
                &mut shared.pane_leases.lock().expect("remote pane leases mutex"),
                client_key,
                session_id,
                attached_panes,
            ) {
                shared.notify_pane_lease(released_event(session_id, pane_id));
            }
            send_json(
                ws,
                &ServerMessage::PanesChanged {
                    session_id: session_id.to_string(),
                    panes: ordered.iter().map(PaneDto::from).collect(),
                },
            )
        }
        DaemonToClient::Error { message, .. } => send_error(ws, "internal", &message, None),
        _ => Ok(()),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct PaneResize {
    session_id: Uuid,
    pane_id: Uuid,
    cols: u16,
    rows: u16,
}

#[derive(Clone, Debug)]
enum ClaimLeaseResult {
    Busy,
    Claimed {
        lease: PaneLease,
        resize: Option<PaneResize>,
    },
}

fn claim_pane_lease(
    leases: &mut HashMap<Uuid, PaneLease>,
    session_id: Uuid,
    pane_id: Uuid,
    owner: Uuid,
    current: (u16, u16),
    target: (u16, u16),
) -> ClaimLeaseResult {
    if let Some(lease) = leases.get_mut(&pane_id) {
        if lease.owner != owner {
            return ClaimLeaseResult::Busy;
        }
        lease.target_cols = target.0;
        lease.target_rows = target.1;
        let lease = lease.clone();
        let resize = (current != target).then_some(PaneResize {
            session_id,
            pane_id,
            cols: target.0,
            rows: target.1,
        });
        return ClaimLeaseResult::Claimed { lease, resize };
    }

    let lease = PaneLease {
        session_id,
        owner,
        original_cols: current.0,
        original_rows: current.1,
        target_cols: target.0,
        target_rows: target.1,
    };
    leases.insert(pane_id, lease.clone());
    let resize = (current != target).then_some(PaneResize {
        session_id,
        pane_id,
        cols: target.0,
        rows: target.1,
    });
    ClaimLeaseResult::Claimed { lease, resize }
}

fn release_pane_lease(
    leases: &mut HashMap<Uuid, PaneLease>,
    pane_id: Uuid,
    owner: Uuid,
) -> Option<PaneResize> {
    let lease = leases.get(&pane_id)?;
    if lease.owner != owner {
        return None;
    }
    let lease = leases.remove(&pane_id)?;
    Some(PaneResize {
        session_id: lease.session_id,
        pane_id,
        cols: lease.original_cols,
        rows: lease.original_rows,
    })
}

fn take_owned_lease_restores(
    leases: &mut HashMap<Uuid, PaneLease>,
    owner: Uuid,
    session_filter: Option<Uuid>,
) -> Vec<PaneResize> {
    let mut restores = Vec::new();
    leases.retain(|pane_id, lease| {
        if lease.owner == owner
            && session_filter.is_none_or(|session_id| lease.session_id == session_id)
        {
            restores.push(PaneResize {
                session_id: lease.session_id,
                pane_id: *pane_id,
                cols: lease.original_cols,
                rows: lease.original_rows,
            });
            false
        } else {
            true
        }
    });
    restores
}

fn drop_owned_lease(
    leases: &mut HashMap<Uuid, PaneLease>,
    pane_id: Uuid,
    owner: Uuid,
) -> Option<Uuid> {
    let lease = leases.get(&pane_id)?;
    if lease.owner != owner {
        return None;
    }
    leases.remove(&pane_id).map(|lease| lease.session_id)
}

fn drop_missing_owned_leases(
    leases: &mut HashMap<Uuid, PaneLease>,
    owner: Uuid,
    session_id: Uuid,
    live_panes: &[Uuid],
) -> Vec<Uuid> {
    let mut removed = Vec::new();
    leases.retain(|pane_id, lease| {
        if lease.owner == owner && lease.session_id == session_id && !live_panes.contains(pane_id) {
            removed.push(*pane_id);
            false
        } else {
            true
        }
    });
    removed
}

fn claimed_event(pane_id: Uuid, lease: &PaneLease) -> RemotePaneLeaseEvent {
    RemotePaneLeaseEvent {
        session_id: lease.session_id.to_string(),
        pane_id: pane_id.to_string(),
        leased: true,
        cols: Some(lease.target_cols),
        rows: Some(lease.target_rows),
    }
}

fn released_event(session_id: Uuid, pane_id: Uuid) -> RemotePaneLeaseEvent {
    RemotePaneLeaseEvent {
        session_id: session_id.to_string(),
        pane_id: pane_id.to_string(),
        leased: false,
        cols: None,
        rows: None,
    }
}

fn restore_owned_leases(
    shared: &RemoteShared,
    owner: Uuid,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    session_filter: Option<Uuid>,
) -> Result<()> {
    let restores = take_owned_lease_restores(
        &mut shared.pane_leases.lock().expect("remote pane leases mutex"),
        owner,
        session_filter,
    );
    for restore in restores {
        shared.notify_pane_lease(released_event(restore.session_id, restore.pane_id));
        write_pane_resize(daemon_writer, restore)?;
    }
    Ok(())
}

fn write_pane_resize(
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    resize: PaneResize,
) -> Result<()> {
    write_frame(
        daemon_writer,
        &ClientToDaemon::ResizePane {
            session_id: resize.session_id,
            pane_id: resize.pane_id,
            cols: resize.cols,
            rows: resize.rows,
        },
    )?;
    Ok(())
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
    let deadline = Instant::now() + Duration::from_secs(10);
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
    fn full_output_queue_drops_output_but_not_control() {
        let (senders, mut inbox) = daemon_channels(1);
        let pane_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();

        assert!(route_daemon_message(
            &senders,
            DaemonToClient::Output {
                pane_id,
                data: vec![1]
            }
        ));
        assert!(!route_daemon_message(
            &senders,
            DaemonToClient::Output {
                pane_id,
                data: vec![2]
            }
        ));
        assert_eq!(inbox.take_output_drops(pane_id), 1);
        assert!(route_daemon_message(
            &senders,
            DaemonToClient::SessionChanged { session_id }
        ));
        assert!(route_daemon_message(
            &senders,
            DaemonToClient::Reply {
                req: 7,
                result: ReplyResult::Ok
            }
        ));
        assert!(route_daemon_message(
            &senders,
            DaemonToClient::PaneResized {
                session_id,
                pane_id,
                cols: 80,
                rows: 24
            }
        ));

        assert_eq!(
            inbox.try_control().expect("session control"),
            Some(DaemonToClient::SessionChanged { session_id })
        );
        assert_eq!(
            inbox.try_control().expect("reply control"),
            Some(DaemonToClient::Reply {
                req: 7,
                result: ReplyResult::Ok
            })
        );
        assert_eq!(
            inbox.try_control().expect("resize control"),
            Some(DaemonToClient::PaneResized {
                session_id,
                pane_id,
                cols: 80,
                rows: 24
            })
        );
        assert_eq!(
            inbox.try_output().expect("output receive"),
            Some(DaemonToClient::Output {
                pane_id,
                data: vec![1]
            })
        );
        assert_eq!(inbox.try_output().expect("empty output queue"), None);
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
    fn pane_lease_is_exclusive_and_restores_original_geometry() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let mut leases = HashMap::new();

        let first = claim_pane_lease(&mut leases, session_id, pane_id, owner, (102, 42), (48, 36));
        let ClaimLeaseResult::Claimed { lease, resize } = first else {
            panic!("first claim should succeed")
        };
        assert_eq!((lease.original_cols, lease.original_rows), (102, 42));
        assert_eq!(
            resize,
            Some(PaneResize {
                session_id,
                pane_id,
                cols: 48,
                rows: 36
            })
        );

        assert!(matches!(
            claim_pane_lease(&mut leases, session_id, pane_id, other, (48, 36), (60, 30)),
            ClaimLeaseResult::Busy
        ));

        let updated = claim_pane_lease(&mut leases, session_id, pane_id, owner, (48, 36), (56, 32));
        let ClaimLeaseResult::Claimed { lease, .. } = updated else {
            panic!("owner update should succeed")
        };
        assert_eq!((lease.original_cols, lease.original_rows), (102, 42));
        assert_eq!((lease.target_cols, lease.target_rows), (56, 32));

        assert_eq!(
            release_pane_lease(&mut leases, pane_id, owner),
            Some(PaneResize {
                session_id,
                pane_id,
                cols: 102,
                rows: 42
            })
        );
        assert!(leases.is_empty());
    }

    #[test]
    fn disconnect_restores_only_the_owners_matching_session() {
        let owner = Uuid::new_v4();
        let other = Uuid::new_v4();
        let session_a = Uuid::new_v4();
        let session_b = Uuid::new_v4();
        let pane_a = Uuid::new_v4();
        let pane_b = Uuid::new_v4();
        let pane_other = Uuid::new_v4();
        let mut leases = HashMap::new();

        let _ = claim_pane_lease(&mut leases, session_a, pane_a, owner, (80, 24), (44, 30));
        let _ = claim_pane_lease(&mut leases, session_b, pane_b, owner, (90, 30), (50, 34));
        let _ = claim_pane_lease(
            &mut leases,
            session_a,
            pane_other,
            other,
            (100, 32),
            (52, 36),
        );

        assert_eq!(
            take_owned_lease_restores(&mut leases, owner, Some(session_a)),
            vec![PaneResize {
                session_id: session_a,
                pane_id: pane_a,
                cols: 80,
                rows: 24
            }]
        );
        assert!(leases.contains_key(&pane_b));
        assert!(leases.contains_key(&pane_other));
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

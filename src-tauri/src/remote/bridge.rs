use super::{layout_order::pane_order, protocol::{encode_buffer, frame_pane_output, AuthRequest, ClientMessage, PaneDto, ServerMessage, WorkspaceDto, PROTOCOL_VERSION, SUBPROTOCOL}, server::{desktop_name, RemoteShared}};
use crate::{app::spawn_daemon, protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, PaneMeta, ReplyResult, SessionMeta}};
use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::{bounded, unbounded, Receiver, Sender, TryRecvError};
use interprocess::local_socket::prelude::*;
use rustls::{ServerConfig, ServerConnection, StreamOwned};
use std::{collections::{HashMap, VecDeque}, io, net::TcpStream, sync::Arc, thread, time::{Duration, Instant}};
use tungstenite::{handshake::server::{Request, Response}, Message, WebSocket};
use uuid::Uuid;

const HELLO_TIMEOUT: Duration = Duration::from_secs(10);
const POLL_TIMEOUT: Duration = Duration::from_millis(30);
const KEEPALIVE_INTERVAL: Duration = Duration::from_secs(30);
const KEEPALIVE_DEADLINE: Duration = Duration::from_secs(60);
const DAEMON_OUTPUT_QUEUE_CAPACITY: usize = 1024;
const PUSH_QUEUE_CAPACITY: usize = 1024;
const MAX_OUTPUT_FRAMES_PER_LOOP: usize = 32;

type RemoteSocket = WebSocket<StreamOwned<ServerConnection, TcpStream>>;

struct DaemonSenders {
    control: Sender<DaemonToClient>,
    output: Sender<DaemonToClient>,
}

struct DaemonInbox {
    control: Receiver<DaemonToClient>,
    output: Receiver<DaemonToClient>,
    deferred_control: VecDeque<DaemonToClient>,
}

impl DaemonInbox {
    fn try_control(&mut self) -> Result<Option<DaemonToClient>> {
        if let Some(message) = self.deferred_control.pop_front() { return Ok(Some(message)); }
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
}

fn daemon_channels(output_capacity: usize) -> (DaemonSenders, DaemonInbox) {
    let (control_tx, control_rx) = unbounded();
    let (output_tx, output_rx) = bounded(output_capacity);
    (
        DaemonSenders { control: control_tx, output: output_tx },
        DaemonInbox { control: control_rx, output: output_rx, deferred_control: VecDeque::new() },
    )
}

fn route_daemon_message(senders: &DaemonSenders, message: DaemonToClient) -> bool {
    match message {
        output @ DaemonToClient::Output { .. } => senders.output.try_send(output).is_ok(),
        control => senders.control.send(control).is_ok(),
    }
}

pub fn handle_connection(stream: TcpStream, tls_config: Arc<ServerConfig>, shared: Arc<RemoteShared>) -> Result<()> {
    stream.set_nonblocking(false)?;
    stream.set_read_timeout(Some(HELLO_TIMEOUT))?;
    stream.set_write_timeout(Some(Duration::from_secs(10)))?;
    let tls = StreamOwned::new(ServerConnection::new(tls_config)?, stream);
    let mut ws = tungstenite::accept_hdr(tls, |request: &Request, mut response: Response| {
        let offered = request.headers().get("sec-websocket-protocol").and_then(|value| value.to_str().ok()).unwrap_or("");
        if !offered.split(',').map(str::trim).any(|value| value == SUBPROTOCOL) {
            return Err(tungstenite::http::Response::builder().status(400).body(Some("missing vibelink-remote-v1 subprotocol".to_string())).expect("error response"));
        }
        response.headers_mut().insert("sec-websocket-protocol", SUBPROTOCOL.parse().expect("subprotocol header"));
        Ok(response)
    }).context("accept remote websocket")?;

    let first = ws.read().context("read remote hello")?;
    let hello: ClientMessage = match first {
        Message::Text(text) => serde_json::from_str(text.as_ref()).context("parse remote hello")?,
        _ => bail!("remote hello must be a text frame"),
    };
    let (device_id, device_token) = authenticate(&mut ws, &shared, hello)?;
    send_json(&mut ws, &ServerMessage::Authed {
        device_id,
        device_token,
        desktop_name: desktop_name(),
        protocol_version: PROTOCOL_VERSION,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        capabilities: Vec::new(),
    })?;

    ws.get_mut().sock.set_read_timeout(Some(POLL_TIMEOUT))?;
    let (mut daemon_writer, mut daemon_inbox) = open_daemon_connection()?;
    let client_key = Uuid::new_v4();
    let (push_tx, push_rx) = bounded(PUSH_QUEUE_CAPACITY);
    shared.client_senders.lock().expect("remote clients mutex").insert(client_key, push_tx);

    let result = run_authenticated(&mut ws, &mut daemon_writer, &mut daemon_inbox, &push_rx, &shared);
    shared.client_senders.lock().expect("remote clients mutex").remove(&client_key);
    result
}

fn authenticate(ws: &mut RemoteSocket, shared: &RemoteShared, hello: ClientMessage) -> Result<(String, Option<String>)> {
    let ClientMessage::Hello { protocol_version, auth } = hello else {
        send_error(ws, "authFailed", "hello must be the first message", None)?;
        bail!("hello was not first message");
    };
    if protocol_version != PROTOCOL_VERSION {
        send_error(ws, "protocolMismatch", "unsupported remote protocol version", None)?;
        bail!("protocol mismatch");
    }
    let mut devices = shared.devices.lock().expect("remote devices mutex");
    match auth {
        AuthRequest::Pair { code, device_name } => match devices.consume_pairing(&code, &device_name) {
            Ok((record, token)) => Ok((record.id, Some(token))),
            Err(error) => {
                let code = auth_error_code(&error);
                send_error(ws, code, "remote pairing failed", None)?;
                bail!("remote pairing failed: {code}")
            }
        },
        AuthRequest::Token { device_id, token } => match devices.verify_token(&device_id, &token) {
            Ok(true) => Ok((device_id, None)),
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

fn open_daemon_connection() -> Result<(interprocess::local_socket::SendHalf, DaemonInbox)> {
    let stream = spawn_daemon::connect_daemon().context("connect dedicated remote daemon client")?;
    let (reader, mut writer) = stream.split();
    write_frame(&mut writer, &ClientToDaemon::Hello { client_id: Uuid::new_v4() })?;
    let (senders, inbox) = daemon_channels(DAEMON_OUTPUT_QUEUE_CAPACITY);
    thread::Builder::new().name("vibelink-remote-daemon-reader".to_string()).spawn(move || daemon_reader(reader, senders))?;
    Ok((writer, inbox))
}

fn daemon_reader(mut reader: interprocess::local_socket::RecvHalf, senders: DaemonSenders) {
    while let Ok(message) = read_frame::<_, DaemonToClient>(&mut reader) {
        let output = matches!(&message, DaemonToClient::Output { .. });
        if route_daemon_message(&senders, message) { continue; }
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
) -> Result<()> {
    let mut next_req = 1_u64;
    let mut attached: Option<Uuid> = None;
    let mut attached_panes: Vec<Uuid> = Vec::new();
    let appearance = shared.appearance.read().expect("remote appearance lock").clone();
    send_json(ws, &ServerMessage::Appearance { payload: appearance })?;
    let sessions = list_sessions(daemon_writer, daemon_inbox, &mut next_req)?;
    send_workspaces(ws, ordered_sessions(sessions, &shared.workspace_order.read().expect("remote workspace order lock")), &shared.workspace_alerts.read().expect("remote workspace alerts lock"), None)?;

    let mut last_ping = Instant::now();
    let mut last_pong = Instant::now();
    loop {
        while let Some(message) = daemon_inbox.try_control()? {
            handle_daemon_control(ws, daemon_writer, daemon_inbox, &mut next_req, attached, &mut attached_panes, message)?;
        }
        while let Ok(message) = push_rx.try_recv() { ws.send(message)?; }
        for _ in 0..MAX_OUTPUT_FRAMES_PER_LOOP {
            if daemon_inbox.has_pending_control() { break; }
            let Some(message) = daemon_inbox.try_output()? else { break; };
            if let DaemonToClient::Output { pane_id, data } = message {
                if attached_panes.contains(&pane_id) {
                    ws.send(Message::Binary(frame_pane_output(&pane_id.to_string(), &data).into()))?;
                }
            }
        }

        match ws.read() {
            Ok(Message::Text(text)) => {
                let message: ClientMessage = serde_json::from_str(text.as_ref()).context("parse remote message")?;
                handle_client_message(ws, daemon_writer, daemon_inbox, shared, &mut next_req, &mut attached, &mut attached_panes, message)?;
            }
            Ok(Message::Pong(_)) => last_pong = Instant::now(),
            Ok(Message::Ping(data)) => { ws.send(Message::Pong(data))?; }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(error)) if matches!(error.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => return Ok(()),
            Err(error) => return Err(error.into()),
        }

        if last_ping.elapsed() >= KEEPALIVE_INTERVAL {
            if last_pong.elapsed() >= KEEPALIVE_DEADLINE { bail!("remote keepalive timed out"); }
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
    next_req: &mut u64,
    attached: &mut Option<Uuid>,
    attached_panes: &mut Vec<Uuid>,
    message: ClientMessage,
) -> Result<()> {
    match message {
        ClientMessage::Hello { .. } => send_error(ws, "authFailed", "hello may only be sent once", None),
        ClientMessage::ListWorkspaces { req_id } => {
            let sessions = list_sessions(daemon_writer, daemon_inbox, next_req)?;
            send_workspaces(ws, ordered_sessions(sessions, &shared.workspace_order.read().expect("remote workspace order lock")), &shared.workspace_alerts.read().expect("remote workspace alerts lock"), req_id)
        }
        ClientMessage::AttachWorkspace { session_id, req_id } => {
            let session_id = parse_uuid(&session_id, ws, req_id)?;
            if let Some(previous) = *attached {
                write_frame(daemon_writer, &ClientToDaemon::DetachSession { session_id: previous })?;
            }
            let (layout, panes) = attach_session(daemon_writer, daemon_inbox, next_req, session_id)?;
            let order = pane_order(layout.as_deref(), &panes);
            let pane_by_id: HashMap<_, _> = panes.into_iter().map(|pane| (pane.id, pane)).collect();
            let ordered: Vec<_> = order.into_iter().filter_map(|id| pane_by_id.get(&id).cloned()).collect();
            attached_panes.clear();
            attached_panes.extend(ordered.iter().map(|pane| pane.id));
            *attached = Some(session_id);
            send_json(ws, &ServerMessage::WorkspaceAttached { session_id: session_id.to_string(), panes: ordered.iter().map(PaneDto::from).collect(), req_id })?;
            for pane in &ordered { write_frame(daemon_writer, &ClientToDaemon::AttachPane { session_id, pane_id: pane.id })?; }
            Ok(())
        }
        ClientMessage::DetachWorkspace { session_id, req_id } => {
            let session_id = parse_uuid(&session_id, ws, req_id)?;
            write_frame(daemon_writer, &ClientToDaemon::DetachSession { session_id })?;
            if *attached == Some(session_id) {
                *attached = None;
                attached_panes.clear();
            }
            Ok(())
        }
        ClientMessage::WritePane { pane_id, data, req_id } => {
            let Some(session_id) = *attached else { return send_error(ws, "internal", "no workspace attached", req_id); };
            let pane_id = parse_uuid(&pane_id, ws, req_id)?;
            write_frame(daemon_writer, &ClientToDaemon::WritePane { session_id, pane_id, data: data.into_bytes() })?;
            Ok(())
        }
        ClientMessage::RefreshPane { pane_id, req_id } => {
            let Some(session_id) = *attached else { return send_error(ws, "internal", "no workspace attached", req_id); };
            let pane_id = parse_uuid(&pane_id, ws, req_id)?;
            let req = take_req(next_req);
            let reply = request_reply(daemon_writer, daemon_inbox, req, ClientToDaemon::GetScrollback { req, session_id, pane_id })?;
            match reply {
                ReplyResult::ScrollbackData(data) => send_json(ws, &ServerMessage::PaneBuffer { pane_id: pane_id.to_string(), data_b64: encode_buffer(&data), req_id }),
                other => Err(anyhow!("unexpected scrollback reply: {other:?}")),
            }
        }
        ClientMessage::SetPaneSize { .. } | ClientMessage::ClearPaneSize { .. } => Ok(()),
        ClientMessage::Unknown => Ok(()),
        ClientMessage::Ping { req_id } => send_json(ws, &ServerMessage::Pong { req_id }),
    }
}



fn handle_daemon_control(
    ws: &mut RemoteSocket,
    daemon_writer: &mut interprocess::local_socket::SendHalf,
    daemon_inbox: &mut DaemonInbox,
    next_req: &mut u64,
    attached: Option<Uuid>,
    attached_panes: &mut Vec<Uuid>,
    message: DaemonToClient,
) -> Result<()> {
    match message {
        DaemonToClient::PaneExited { pane_id, .. } if attached_panes.contains(&pane_id) => send_json(ws, &ServerMessage::PaneExited { pane_id: pane_id.to_string() }),
        DaemonToClient::PaneResized { session_id, pane_id, cols, rows } if attached == Some(session_id) => {
            send_json(ws, &ServerMessage::PaneResized { pane_id: pane_id.to_string(), cols, rows })
        }
        DaemonToClient::SessionChanged { session_id } if attached == Some(session_id) => {
            let (layout, panes) = attach_session(daemon_writer, daemon_inbox, next_req, session_id)?;
            let order = pane_order(layout.as_deref(), &panes);
            let pane_by_id: HashMap<_, _> = panes.into_iter().map(|pane| (pane.id, pane)).collect();
            let ordered: Vec<_> = order.into_iter().filter_map(|id| pane_by_id.get(&id).cloned()).collect();
            attached_panes.clear();
            attached_panes.extend(ordered.iter().map(|pane| pane.id));
            send_json(ws, &ServerMessage::PanesChanged { session_id: session_id.to_string(), panes: ordered.iter().map(PaneDto::from).collect() })
        }
        DaemonToClient::Error { message, .. } => send_error(ws, "internal", &message, None),
        _ => Ok(()),
    }
}


fn list_sessions(writer: &mut interprocess::local_socket::SendHalf, inbox: &mut DaemonInbox, next_req: &mut u64) -> Result<Vec<SessionMeta>> {
    let req = take_req(next_req);
    match request_reply(writer, inbox, req, ClientToDaemon::ListSessions { req })? {
        ReplyResult::Sessions(sessions) => Ok(sessions),
        other => Err(anyhow!("unexpected session list reply: {other:?}")),
    }
}

fn attach_session(writer: &mut interprocess::local_socket::SendHalf, inbox: &mut DaemonInbox, next_req: &mut u64, session_id: Uuid) -> Result<(Option<String>, Vec<PaneMeta>)> {
    let req = take_req(next_req);
    match request_reply(writer, inbox, req, ClientToDaemon::AttachSession { req, session_id })? {
        ReplyResult::Attached { layout_json, panes } => Ok((layout_json, panes)),
        other => Err(anyhow!("unexpected attach reply: {other:?}")),
    }
}

fn request_control_result(inbox: &mut DaemonInbox, req: u64, message: DaemonToClient) -> Result<Option<ReplyResult>> {
    match message {
        DaemonToClient::Reply { req: reply_req, result } if reply_req == req => Ok(Some(result)),
        DaemonToClient::Error { req: Some(reply_req), message } if reply_req == req => bail!(message),
        unrelated => {
            inbox.defer_control(unrelated);
            Ok(None)
        }
    }
}

fn request_reply(writer: &mut interprocess::local_socket::SendHalf, inbox: &mut DaemonInbox, req: u64, message: ClientToDaemon) -> Result<ReplyResult> {
    write_frame(writer, &message)?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() { bail!("daemon request {req} timed out"); }
        let message = inbox.recv_new_control_timeout(remaining)?;
        if let Some(result) = request_control_result(inbox, req, message)? { return Ok(result); }
    }
}

fn ordered_sessions(sessions: Vec<SessionMeta>, order: &[String]) -> Vec<SessionMeta> {
    let mut by_id: std::collections::HashMap<_, _> = sessions.iter().cloned().map(|session| (session.id.to_string(), session)).collect();
    let mut ordered = Vec::new();
    for id in order { if let Some(session) = by_id.remove(id) { ordered.push(session); } }
    for session in sessions { if let Some(session) = by_id.remove(&session.id.to_string()) { ordered.push(session); } }
    ordered
}

fn send_workspaces(ws: &mut RemoteSocket, sessions: Vec<SessionMeta>, alerts: &std::collections::HashMap<String, usize>, req_id: Option<u64>) -> Result<()> {
    let workspaces = sessions.into_iter().map(|session| {
        let alert_count = alerts.get(&session.id.to_string()).copied().unwrap_or(0);
        WorkspaceDto::from_session(session, alert_count)
    }).collect();
    send_json(ws, &ServerMessage::Workspaces { workspaces, req_id })
}

fn send_json(ws: &mut RemoteSocket, message: &ServerMessage) -> Result<()> {
    ws.send(Message::Text(serde_json::to_string(message)?.into()))?;
    Ok(())
}

fn send_error(ws: &mut RemoteSocket, code: &str, message: &str, req_id: Option<u64>) -> Result<()> {
    send_json(ws, &ServerMessage::Error { code: code.to_string(), message: message.to_string(), req_id })
}

fn parse_uuid(value: &str, ws: &mut RemoteSocket, req_id: Option<u64>) -> Result<Uuid> {
    Uuid::parse_str(value).map_err(|error| {
        let _ = send_error(ws, "internal", "invalid identifier", req_id);
        error.into()
    })
}

fn take_req(next_req: &mut u64) -> u64 { let value = *next_req; *next_req = next_req.saturating_add(1); value }

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saved_workspace_order_precedes_unsaved_sessions() {
        let a = SessionMeta { id: Uuid::new_v4(), name: "A".into(), pane_count: 0, created_at: 1, workspace_folder: None };
        let b = SessionMeta { id: Uuid::new_v4(), name: "B".into(), pane_count: 0, created_at: 2, workspace_folder: None };
        let c = SessionMeta { id: Uuid::new_v4(), name: "C".into(), pane_count: 0, created_at: 3, workspace_folder: None };
        let result = ordered_sessions(vec![a.clone(), b.clone(), c.clone()], &[b.id.to_string(), "missing".into(), a.id.to_string()]);
        assert_eq!(result.iter().map(|session| session.id).collect::<Vec<_>>(), vec![b.id, a.id, c.id]);
    }

    #[test]
    fn full_output_queue_drops_output_but_not_control() {
        let (senders, mut inbox) = daemon_channels(1);
        let pane_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();

        assert!(route_daemon_message(&senders, DaemonToClient::Output { pane_id, data: vec![1] }));
        assert!(!route_daemon_message(&senders, DaemonToClient::Output { pane_id, data: vec![2] }));
        assert!(route_daemon_message(&senders, DaemonToClient::SessionChanged { session_id }));
        assert!(route_daemon_message(&senders, DaemonToClient::Reply { req: 7, result: ReplyResult::Ok }));
        assert!(route_daemon_message(&senders, DaemonToClient::PaneResized { session_id, pane_id, cols: 80, rows: 24 }));

        assert_eq!(inbox.try_control().expect("session control"), Some(DaemonToClient::SessionChanged { session_id }));
        assert_eq!(inbox.try_control().expect("reply control"), Some(DaemonToClient::Reply { req: 7, result: ReplyResult::Ok }));
        assert_eq!(inbox.try_control().expect("resize control"), Some(DaemonToClient::PaneResized { session_id, pane_id, cols: 80, rows: 24 }));
        assert_eq!(inbox.try_output().expect("output receive"), Some(DaemonToClient::Output { pane_id, data: vec![1] }));
        assert_eq!(inbox.try_output().expect("empty output queue"), None);
    }

    #[test]
    fn unrelated_control_is_deferred_while_waiting_for_reply() {
        let (_, mut inbox) = daemon_channels(1);
        let session_id = Uuid::new_v4();

        for _ in 0..2 {
            assert_eq!(
                request_control_result(&mut inbox, 7, DaemonToClient::SessionChanged { session_id }).expect("defer control"),
                None,
            );
        }
        assert_eq!(
            request_control_result(&mut inbox, 7, DaemonToClient::Reply { req: 7, result: ReplyResult::Ok }).expect("match reply"),
            Some(ReplyResult::Ok),
        );
        assert_eq!(inbox.try_control().expect("first deferred control"), Some(DaemonToClient::SessionChanged { session_id }));
        assert_eq!(inbox.try_control().expect("second deferred control"), Some(DaemonToClient::SessionChanged { session_id }));
    }
}

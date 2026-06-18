use crate::protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, ReplyResult, Req};
use anyhow::{anyhow, bail, Context, Result};
use base64::Engine;
use crossbeam_channel::{bounded, Sender};
use interprocess::local_socket::{prelude::*, RecvHalf as LocalSocketRecvHalf, SendHalf as LocalSocketSendHalf};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::Duration,
};
use tauri::ipc::Channel;
use tracing::{error, info, warn};
use uuid::Uuid;

use super::spawn_daemon::{ensure_daemon, DaemonStream};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const RECONNECT_DELAY: Duration = Duration::from_millis(250);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TerminalEvent {
    Output { pane_id: String, data_b64: String },
    Exited { pane_id: String, exit_code: Option<i32> },
    ConnectionLost { message: String },
    ConnectionRestored,
}

pub struct DaemonClient {
    shared: Arc<ClientShared>,
}

struct ClientShared {
    writer: Mutex<LocalSocketSendHalf>,
    pending: Mutex<HashMap<Req, Sender<DaemonToClient>>>,
    output_channel: Mutex<Option<Channel<TerminalEvent>>>,
    next_req: AtomicU64,
    reconnecting: AtomicBool,
    connection_generation: AtomicU64,
}

impl DaemonClient {
    pub fn new(stream: DaemonStream) -> Self {
        let (reader, writer) = split_daemon_stream(stream);
        let shared = Arc::new(ClientShared {
            writer: Mutex::new(writer),
            pending: Mutex::new(HashMap::new()),
            output_channel: Mutex::new(None),
            next_req: AtomicU64::new(1),
            reconnecting: AtomicBool::new(false),
            connection_generation: AtomicU64::new(0),
        });

        spawn_reader_loop(reader, Arc::clone(&shared), 0);

        Self { shared }
    }

    pub fn set_output_channel(&self, channel: Channel<TerminalEvent>) {
        *self
            .shared
            .output_channel
            .lock()
            .expect("output channel mutex poisoned") = Some(channel);
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
            DaemonToClient::Reply { req: reply_req, result } if reply_req == req => Ok(result),
            DaemonToClient::Error { message, .. } => bail!(message),
            other => bail!("unexpected daemon response: {other:?}"),
        }
    }

    pub fn send(&self, msg: ClientToDaemon) -> Result<()> {
        let result = {
            let mut writer = self.shared.writer.lock().expect("daemon writer mutex poisoned");
            write_frame(&mut *writer, &msg).context("write daemon message")
        };
        if let Err(err) = result {
            start_background_reconnect(&self.shared, format!("daemon write failed: {err}"));
            Err(err)
        } else {
            Ok(())
        }
    }

    fn next_req(&self) -> Req {
        self.shared.next_req.fetch_add(1, Ordering::Relaxed)
    }

    fn request(&self, req: Req, msg: ClientToDaemon) -> Result<DaemonToClient> {
        let (tx, rx) = bounded(1);
        self.shared
            .pending
            .lock()
            .expect("pending request mutex poisoned")
            .insert(req, tx);

        let write_result = self.send(msg);

        if let Err(err) = write_result {
            self.shared
                .pending
                .lock()
                .expect("pending request mutex poisoned")
                .remove(&req);
            return Err(err);
        }

        match rx.recv_timeout(REQUEST_TIMEOUT) {
            Ok(msg) => Ok(msg),
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                let message = format!(
                    "daemon request {req} timed out after {}ms",
                    REQUEST_TIMEOUT.as_millis()
                );
                fail_pending(&self.shared, message.clone());
                start_background_reconnect(&self.shared, message.clone());
                Err(anyhow!(message))
            }
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                self.shared
                    .pending
                    .lock()
                    .expect("pending request mutex poisoned")
                    .remove(&req);
                Err(anyhow!("daemon request {req} response channel closed"))
            }
        }
    }
}

fn spawn_reader_loop(reader: LocalSocketRecvHalf, shared: Arc<ClientShared>, generation: u64) {
    thread::Builder::new()
        .name("awt-daemon-reader".to_string())
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
                    let (next_reader, next_generation) = reconnect(&shared);
                    info!("daemon reconnected");
                    let _ = send_terminal_event(&shared, TerminalEvent::ConnectionRestored);
                    finish_reconnect(&shared);
                    reader = next_reader;
                    generation = next_generation;
                } else {
                    break;
                }
            }
        }
    }
}

fn reconnect(shared: &Arc<ClientShared>) -> (LocalSocketRecvHalf, u64) {
    loop {
        match ensure_daemon() {
            Ok(stream) => {
                let (reader, writer) = split_daemon_stream(stream);
                *shared.writer.lock().expect("daemon writer mutex poisoned") = writer;
                let generation = shared.connection_generation.fetch_add(1, Ordering::AcqRel) + 1;
                return (reader, generation);
            }
            Err(err) => {
                warn!(?err, "daemon reconnect attempt failed");
                thread::sleep(RECONNECT_DELAY);
            }
        }
    }
}

fn start_background_reconnect(shared: &Arc<ClientShared>, message: String) {
    if !begin_reconnect(shared) {
        return;
    }

    let _ = send_terminal_event(shared, TerminalEvent::ConnectionLost { message });
    let reconnect_shared = Arc::clone(shared);
    if let Err(err) = thread::Builder::new()
        .name("awt-daemon-reconnector".to_string())
        .spawn(move || {
            let (reader, generation) = reconnect(&reconnect_shared);
            info!("daemon reconnected");
            let _ = send_terminal_event(&reconnect_shared, TerminalEvent::ConnectionRestored);
            finish_reconnect(&reconnect_shared);
            reader_loop(reader, reconnect_shared, generation);
        })
    {
        finish_reconnect(shared);
        error!(?err, "failed to spawn daemon reconnector");
    }
}

fn begin_reconnect(shared: &ClientShared) -> bool {
    shared
        .reconnecting
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_ok()
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
    } else if let Err(err) = forward_terminal_event(shared, msg) {
        warn!(?err, "dropping terminal event");
    }
}

fn fail_pending(shared: &ClientShared, message: String) {
    let pending = std::mem::take(&mut *shared.pending.lock().expect("pending request mutex poisoned"));
    for (req, sender) in pending {
        let _ = sender.try_send(DaemonToClient::Error {
            req: Some(req),
            message: message.clone(),
        });
    }
}

fn forward_terminal_event(shared: &ClientShared, msg: DaemonToClient) -> Result<()> {
    let event = match msg {
        DaemonToClient::Output { pane_id, data } => TerminalEvent::Output {
            pane_id: pane_id.to_string(),
            data_b64: base64::engine::general_purpose::STANDARD.encode(data),
        },
        DaemonToClient::PaneExited { pane_id, exit_code } => TerminalEvent::Exited {
            pane_id: pane_id.to_string(),
            exit_code,
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
        DaemonToClient::Output { .. } | DaemonToClient::PaneExited { .. } => None,
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
    fn request_timeout_stays_below_legacy_ten_second_hang() {
        assert!(REQUEST_TIMEOUT < Duration::from_secs(10));
    }

    #[test]
    fn writer_timeout_uses_request_timeout_budget() {
        assert_eq!(REQUEST_TIMEOUT, Duration::from_secs(3));
    }

    #[test]
    fn stale_reader_generation_is_not_current() {
        assert!(reader_generation_is_current(3, 3));
        assert!(!reader_generation_is_current(4, 3));
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
    }
}

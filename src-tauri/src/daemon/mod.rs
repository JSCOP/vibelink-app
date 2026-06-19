pub mod paths;
pub mod persistence;
pub mod pty;
pub mod scrollback;
pub mod session;

use crate::daemon::persistence::{load_sessions, save_sessions};
use crate::daemon::pty::{Pane, SharedChild};
use crate::daemon::session::DaemonState;
use crate::protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, ReplyResult, Req};
use anyhow::Result;
use crossbeam_channel::{unbounded, Sender};
use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::Duration,
};
use tracing::{error, info, warn};
use uuid::Uuid;

type SharedState = Arc<Mutex<DaemonState>>;
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(3);
static PERSISTENCE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

pub fn run() {
    if let Err(err) = run_inner() {
        eprintln!("daemon failed: {err:#}");
    }
}

fn run_inner() -> Result<()> {
    let paths = paths::daemon_paths()?;
    init_logging(&paths.log);

    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&paths.lock)?;

    if let Err(err) = lock_file.try_lock() {
        info!(?err, "another daemon owns the lock");
        return Ok(());
    }

    let _pid_file = PidFileGuard::create(paths.pid.clone())?;

    let state = Arc::new(Mutex::new(DaemonState::new()));
    reconstruct_sessions(Arc::clone(&state), &paths.sessions)?;

    let sessions_path = Arc::new(paths.sessions.clone());
    let shutdown = Arc::new(AtomicBool::new(false));
    let socket_name = paths::socket_name_string();
    let name = socket_name.as_str().to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(name).create_sync()?;
    info!(socket_name, data_dir = ?paths.data_dir, "daemon listening");

    for stream in listener.incoming() {
        if shutdown.load(Ordering::Acquire) {
            break;
        }
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                let sessions_path = Arc::clone(&sessions_path);
                let shutdown = Arc::clone(&shutdown);
                thread::Builder::new()
                    .name("awt-daemon-client".to_string())
                    .spawn(move || handle_connection(stream, state, sessions_path, shutdown))?;
            }
            Err(err) => warn!(?err, "failed to accept daemon client"),
        }
    }

    info!("daemon shutting down, killing all panes");
    kill_all_panes(&state);
    if let Err(err) = persist_state(&state, &sessions_path) {
        warn!(?err, "failed to persist state during shutdown");
    }
    drop(lock_file);
    Ok(())
}

struct PidFileGuard {
    path: PathBuf,
}

impl PidFileGuard {
    fn create(path: PathBuf) -> Result<Self> {
        fs::write(&path, std::process::id().to_string())?;
        Ok(Self { path })
    }
}

impl Drop for PidFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

fn init_logging(log_path: &Path) {
    let file = OpenOptions::new().create(true).append(true).open(log_path);
    let Ok(file) = file else {
        return;
    };

    let file = Arc::new(Mutex::new(file));
    let writer = move || {
        file.lock()
            .expect("daemon log mutex poisoned")
            .try_clone()
            .expect("clone daemon log")
    };

    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(writer)
        .try_init();
}

fn reconstruct_sessions(state: SharedState, sessions_path: &Path) -> Result<()> {
    for persisted in load_sessions(sessions_path)? {
        state
            .lock()
            .expect("daemon state mutex poisoned")
            .insert_session(
                crate::protocol::SessionMeta {
                    id: persisted.id,
                    name: persisted.name,
                    pane_count: 0,
                    created_at: persisted.created_at,
                    workspace_folder: persisted.workspace_folder,
                },
                persisted.layout_json,
            );

        if !persisted.panes.is_empty() {
            warn!(
                pane_count = persisted.panes.len(),
                session_id = %persisted.id,
                "ignoring persisted pane records"
            );
        }
    }
    Ok(())
}

fn handle_connection(
    stream: LocalSocketStream,
    state: SharedState,
    sessions_path: Arc<PathBuf>,
    shutdown: Arc<AtomicBool>,
) {
    if let Err(err) = stream.set_send_timeout(Some(CLIENT_WRITE_TIMEOUT)) {
        warn!(?err, "failed to set daemon client write timeout");
    }
    let client_id = Uuid::new_v4();
    let (mut reader, mut writer) = stream.split();
    let (tx, rx) = unbounded::<DaemonToClient>();

    state
        .lock()
        .expect("daemon state mutex poisoned")
        .add_client(client_id, tx.clone());

    let writer_thread = thread::Builder::new()
        .name("awt-daemon-client-writer".to_string())
        .spawn(move || {
            while let Ok(msg) = rx.recv() {
                if let Err(err) = write_frame(&mut writer, &msg) {
                    error!(?err, "failed to write daemon reply");
                    break;
                }
            }
        });

    loop {
        let msg = match read_frame::<_, ClientToDaemon>(&mut reader) {
            Ok(msg) => msg,
            Err(crate::protocol::FrameError::Io(err))
                if err.kind() == io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(err) => {
                error!(?err, "failed to read daemon frame");
                break;
            }
        };

        let request_id = request_id(&msg);
        if let Err(err) = dispatch_message(
            Arc::clone(&state),
            &sessions_path,
            client_id,
            &tx,
            msg,
            &shutdown,
        ) {
            let _ = tx.send(DaemonToClient::Error {
                req: request_id,
                message: err.to_string(),
            });
        }

        if shutdown.load(Ordering::Acquire) {
            break;
        }
    }

    state
        .lock()
        .expect("daemon state mutex poisoned")
        .remove_client(client_id);
    drop(tx);
    if let Ok(writer_thread) = writer_thread {
        let _ = writer_thread.join();
    }
}

fn dispatch_message(
    state: SharedState,
    sessions_path: &Path,
    client_id: Uuid,
    tx: &Sender<DaemonToClient>,
    msg: ClientToDaemon,
    shutdown: &Arc<AtomicBool>,
) -> Result<()> {
    match msg {
        ClientToDaemon::Hello { .. } => Ok(()),
        ClientToDaemon::Ping { req } => send(tx, DaemonToClient::Pong { req }),
        ClientToDaemon::ListSessions { req } => {
            let sessions = state
                .lock()
                .expect("daemon state mutex poisoned")
                .list_sessions();
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Sessions(sessions),
                },
            )
        }
        ClientToDaemon::CreateSession {
            req,
            name,
            workspace_folder,
        } => {
            let meta = state
                .lock()
                .expect("daemon state mutex poisoned")
                .create_session(name, workspace_folder);
            persist_state(&state, sessions_path)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::SessionCreated(meta),
                },
            )
        }
        ClientToDaemon::RenameSession {
            req,
            session_id,
            name,
        } => {
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .rename_session(session_id, name)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)
        }
        ClientToDaemon::DeleteSession { req, session_id } => {
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .delete_session(session_id)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)
        }
        ClientToDaemon::AttachSession { req, session_id } => {
            let (layout_json, panes) = state
                .lock()
                .expect("daemon state mutex poisoned")
                .attach_session(session_id)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Attached { layout_json, panes },
                },
            )
        }
        ClientToDaemon::DetachSession { session_id } => {
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .detach_session(client_id, session_id);
            Ok(())
        }
        ClientToDaemon::SaveLayout {
            session_id,
            layout_json,
        } => {
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .save_layout(session_id, layout_json)?;
            persist_state(&state, sessions_path)
        }
        ClientToDaemon::SpawnPane {
            req,
            session_id,
            cfg,
        } => {
            let meta = spawn_pane_for_session(
                Arc::clone(&state),
                sessions_path.to_path_buf(),
                session_id,
                cfg,
            )?;
            persist_state(&state, sessions_path)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::PaneSpawned(meta),
                },
            )
        }
        ClientToDaemon::AttachPane { pane_id } => {
            info!(%client_id, %pane_id, "attaching pane");
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .attach_pane(client_id, pane_id)?;
            Ok(())
        }
        ClientToDaemon::WritePane { pane_id, data } => {
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .write_pane(pane_id, &data)?;
            Ok(())
        }
        ClientToDaemon::ResizePane {
            pane_id,
            cols,
            rows,
        } => {
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .resize_pane(pane_id, cols, rows)?;
            Ok(())
        }
        ClientToDaemon::SetPaneTitle {
            req,
            pane_id,
            title,
        } => {
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .set_pane_title(pane_id, title)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)
        }
        ClientToDaemon::ClosePane { req, pane_id } => {
            let pane = state
                .lock()
                .expect("daemon state mutex poisoned")
                .close_pane(pane_id)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            if let Some(mut pane) = pane {
                thread::Builder::new()
                    .name(format!("awt-close-pty-{pane_id}"))
                    .spawn(move || {
                        if let Err(err) = pane.kill() {
                            warn!(?err, pane_id = %pane_id, "failed to kill closed pane");
                        }
                    })?;
            }
            Ok(())
        }
        ClientToDaemon::ClearSession { req, session_id } => {
            let panes = state
                .lock()
                .expect("daemon state mutex poisoned")
                .close_session_panes(session_id)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            for mut pane in panes {
                let pane_id = pane.id;
                thread::Builder::new()
                    .name(format!("awt-close-pty-{pane_id}"))
                    .spawn(move || {
                        if let Err(err) = pane.kill() {
                            warn!(?err, pane_id = %pane_id, "failed to kill cleared pane");
                        }
                    })?;
            }
            Ok(())
        }
        ClientToDaemon::GetScrollback {
            req,
            session_id,
            pane_id,
        } => {
            let data = state
                .lock()
                .expect("daemon state mutex poisoned")
                .get_scrollback(session_id, pane_id)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::ScrollbackData(data),
                },
            )
        }
        ClientToDaemon::Shutdown { req } => {
            info!("daemon received shutdown request");
            send_ok(tx, req)?;
            shutdown.store(true, Ordering::Release);

            // Clean up all panes before exiting
            info!("daemon shutting down, killing all panes");
            kill_all_panes(&state);
            if let Err(err) = persist_state(&state, sessions_path) {
                warn!(?err, "failed to persist state during shutdown");
            }

            // Exit the process to unblock the main thread's accept() loop
            std::process::exit(0);
        }
    }
}

fn request_id(msg: &ClientToDaemon) -> Option<crate::protocol::Req> {
    match msg {
        ClientToDaemon::Ping { req }
        | ClientToDaemon::ListSessions { req }
        | ClientToDaemon::CreateSession { req, .. }
        | ClientToDaemon::RenameSession { req, .. }
        | ClientToDaemon::DeleteSession { req, .. }
        | ClientToDaemon::AttachSession { req, .. }
        | ClientToDaemon::SpawnPane { req, .. }
        | ClientToDaemon::SetPaneTitle { req, .. }
        | ClientToDaemon::ClosePane { req, .. }
        | ClientToDaemon::ClearSession { req, .. }
        | ClientToDaemon::GetScrollback { req, .. }
        | ClientToDaemon::Shutdown { req } => Some(*req),
        ClientToDaemon::Hello { .. }
        | ClientToDaemon::DetachSession { .. }
        | ClientToDaemon::SaveLayout { .. }
        | ClientToDaemon::AttachPane { .. }
        | ClientToDaemon::WritePane { .. }
        | ClientToDaemon::ResizePane { .. } => None,
    }
}

fn persist_state(state: &SharedState, sessions_path: &Path) -> Result<()> {
    let _guard = PERSISTENCE_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .expect("daemon persistence mutex poisoned");
    let persisted = state
        .lock()
        .expect("daemon state mutex poisoned")
        .persisted_sessions();
    save_sessions(sessions_path, &persisted)
}

fn spawn_pane_for_session(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    cfg: crate::protocol::PaneConfig,
) -> Result<crate::protocol::PaneMeta> {
    state
        .lock()
        .expect("daemon state mutex poisoned")
        .pane_metas(session_id)?;

    let pane_id = cfg.pane_id;
    let spawned = Pane::spawn(cfg)?;
    let child = spawned.pane.child();
    let reader = spawned.reader;
    let meta = state
        .lock()
        .expect("daemon state mutex poisoned")
        .insert_pane(session_id, spawned.pane)?;

    thread::Builder::new()
        .name(format!("awt-pty-{pane_id}"))
        .spawn(move || read_pane_loop(state, pane_id, reader, child, Arc::new(sessions_path)))?;

    Ok(meta)
}

fn read_pane_loop(
    state: SharedState,
    pane_id: Uuid,
    mut reader: Box<dyn Read + Send>,
    child: SharedChild,
    sessions_path: Arc<PathBuf>,
) {
    let mut buf = [0_u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let bytes = buf[..n].to_vec();
                let senders = state
                    .lock()
                    .expect("daemon state mutex poisoned")
                    .record_output(pane_id, &bytes);
                for sender in senders {
                    let _ = sender.send(DaemonToClient::Output {
                        pane_id,
                        data: bytes.clone(),
                    });
                }
            }
            Err(err) => {
                warn!(?err, pane_id = %pane_id, "pty reader stopped");
                break;
            }
        }
    }

    let exit_code = child
        .lock()
        .expect("pty child mutex poisoned")
        .wait()
        .ok()
        .and_then(|status| i32::try_from(status.exit_code()).ok());
    let senders = state
        .lock()
        .expect("daemon state mutex poisoned")
        .mark_exited(pane_id);
    for sender in senders {
        let _ = sender.send(DaemonToClient::PaneExited { pane_id, exit_code });
    }
    if let Err(err) = persist_state(&state, &sessions_path) {
        error!(?err, %pane_id, "failed to persist pane exit");
    }
}

fn send(tx: &Sender<DaemonToClient>, msg: DaemonToClient) -> Result<()> {
    tx.send(msg)?;
    Ok(())
}

fn send_ok(tx: &Sender<DaemonToClient>, req: Req) -> Result<()> {
    send(
        tx,
        DaemonToClient::Reply {
            req,
            result: ReplyResult::Ok,
        },
    )
}

fn kill_all_panes(state: &SharedState) {
    let pane_ids: Vec<Uuid> = state
        .lock()
        .expect("daemon state mutex poisoned")
        .list_sessions()
        .into_iter()
        .flat_map(|meta| {
            state
                .lock()
                .expect("daemon state mutex poisoned")
                .pane_metas(meta.id)
                .unwrap_or_default()
                .into_iter()
                .map(|p| p.id)
                .collect::<Vec<_>>()
        })
        .collect();

    for pane_id in pane_ids {
        let Some(mut pane) = (match state
            .lock()
            .expect("daemon state mutex poisoned")
            .close_pane(pane_id)
        {
            Ok(pane) => pane,
            Err(err) => {
                warn!(?err, %pane_id, "failed to remove pane during shutdown");
                continue;
            }
        }) else {
            continue;
        };
        if let Err(err) = pane.kill() {
            warn!(?err, %pane_id, "failed to kill pane during shutdown");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ping_reply_can_be_sent() {
        let (tx, rx) = unbounded();
        send(&tx, DaemonToClient::Pong { req: 77 }).expect("send pong");
        assert_eq!(rx.recv().expect("pong"), DaemonToClient::Pong { req: 77 });
    }

    #[test]
    fn client_write_timeout_is_bounded() {
        assert!(CLIENT_WRITE_TIMEOUT <= Duration::from_secs(3));
    }

    #[test]
    fn request_id_tracks_spawn_pane_errors() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let msg = ClientToDaemon::SpawnPane {
            req: 42,
            session_id,
            cfg: crate::protocol::PaneConfig {
                pane_id,
                shell: Some("missing-shell".to_string()),
                args: Vec::new(),
                cwd: None,
                env: Vec::new(),
                title: None,
                cols: 80,
                rows: 24,
            },
        };

        assert_eq!(request_id(&msg), Some(42));
    }

    #[test]
    fn pid_file_guard_writes_and_removes_current_pid() {
        let path = std::env::temp_dir().join(format!(
            "awt-daemon-test-{}-{}.pid",
            std::process::id(),
            Uuid::new_v4()
        ));

        {
            let _guard = PidFileGuard::create(path.clone()).expect("create pid guard");
            let pid = std::fs::read_to_string(&path).expect("read pid file");
            assert_eq!(pid.trim(), std::process::id().to_string());
        }

        assert!(!path.exists());
    }
}

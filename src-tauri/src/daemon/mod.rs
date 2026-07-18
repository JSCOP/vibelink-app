pub mod paths;
pub mod persistence;
pub mod proc;
pub mod pty;
pub mod query_filter;
pub mod scrollback;
pub mod session;

use crate::app::{
    authorization::{AuthorizationErrorCode, AuthorizationSnapshot, Capability},
    license::HeadlessLicenseCache,
    spawn_daemon::load_or_create_ipc_secret,
};
use crate::daemon::persistence::{load_sessions, save_sessions};
use crate::daemon::pty::{Pane, SharedChild};
use crate::daemon::session::DaemonState;
use crate::protocol::{
    constant_time_eq, daemon_auth_proof, read_frame, write_frame, ClientKind, ClientToDaemon,
    DaemonToClient, ReplyResult, Req, DAEMON_AUTH_REQUIRED, DAEMON_PROTOCOL_VERSION,
};
use anyhow::{bail, Result};
use chrono::Utc;
use crossbeam_channel::{bounded, Sender, TrySendError};
use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
use rand::{rngs::OsRng, RngCore};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tracing::{error, info, warn};
use uuid::Uuid;

type SharedState = Arc<Mutex<DaemonState>>;
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(3);
type SharedConnections = Arc<Mutex<std::collections::HashMap<Uuid, ConnectionControl>>>;
const CLIENT_QUEUE_CAPACITY: usize = 256;
const PERSIST_DEBOUNCE_INTERVAL: Duration = Duration::from_millis(500);
const AUTH_CHALLENGE_TTL: Duration = Duration::from_secs(3);
const POLICY_HEARTBEAT_TTL: Duration = Duration::from_secs(90);
static PERSISTENCE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static DEBOUNCED_PERSISTER: LazyLock<Mutex<Option<DebouncedPersister>>> =
    LazyLock::new(|| Mutex::new(None));

struct DebouncedPersister {
    dirty: Arc<AtomicBool>,
}

#[derive(Clone)]
struct ConnectionControl {
    sender: Sender<DaemonToClient>,
    cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AuthenticatedClient {
    client_id: Uuid,
    client_kind: ClientKind,
}

struct PendingChallenge {
    boot_id: Uuid,
    nonce: [u8; 32],
    client_id: Uuid,
    client_kind: ClientKind,
    expires_at: Instant,
    consumed: bool,
}

impl PendingChallenge {
    fn verify(
        &mut self,
        secret: &[u8; 32],
        client_id: Uuid,
        proof: &[u8; 32],
        now: Instant,
    ) -> std::result::Result<(), AuthorizationErrorCode> {
        if self.consumed {
            return Err(AuthorizationErrorCode::AuthRequired);
        }
        self.consumed = true;
        if now > self.expires_at || client_id != self.client_id {
            return Err(AuthorizationErrorCode::AuthRequired);
        }
        let expected = daemon_auth_proof(
            secret,
            DAEMON_PROTOCOL_VERSION,
            self.boot_id,
            &self.nonce,
            self.client_id,
            self.client_kind,
        );
        if !constant_time_eq(&expected, proof) {
            return Err(AuthorizationErrorCode::AuthRequired);
        }
        Ok(())
    }
}

#[derive(Default)]
struct PolicyHeartbeat {
    deadline: Option<Instant>,
    policy_epoch: u64,
    revoked: bool,
}

impl PolicyHeartbeat {
    fn note_app_connection(&mut self) {
        self.deadline = Some(Instant::now() + POLICY_HEARTBEAT_TTL);
        self.revoked = false;
    }

    fn update(&mut self, snapshot: AuthorizationSnapshot) {
        let now_wall = Utc::now();
        let remaining = snapshot
            .lease_until
            .signed_duration_since(now_wall)
            .to_std()
            .unwrap_or_default()
            .min(POLICY_HEARTBEAT_TTL);
        self.deadline = Some(Instant::now() + remaining);
        self.policy_epoch = snapshot.policy_epoch;
        self.revoked = snapshot
            .authorize(Capability::WorkspaceRead, now_wall)
            .is_err();
    }

    fn stale(&self, now: Instant) -> bool {
        self.deadline.is_some_and(|deadline| now > deadline)
    }
}

fn lock_state(state: &SharedState) -> MutexGuard<'_, DaemonState> {
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub fn run() {
    if let Err(err) = run_inner() {
        eprintln!("daemon failed: {err:#}");
    }
}

fn run_inner() -> Result<()> {
    let paths = paths::daemon_paths()?;
    let app_flavor = paths::app_flavor();
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

    let ipc_secret = Arc::new(load_or_create_ipc_secret()?);
    let boot_id = Uuid::new_v4();
    let policy_heartbeat = Arc::new(Mutex::new(PolicyHeartbeat::default()));
    let connections = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let sessions_path = Arc::new(paths.sessions.clone());
    let shutdown = Arc::new(AtomicBool::new(false));
    spawn_policy_monitor(
        Arc::clone(&state),
        Arc::clone(&sessions_path),
        Arc::clone(&connections),
        Arc::clone(&policy_heartbeat),
        Arc::clone(&shutdown),
    )?;
    let socket_name = paths::socket_name_string();
    let name = socket_name.as_str().to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(name).create_sync()?;
    info!(socket_name, app_flavor, data_dir = ?paths.data_dir, "daemon listening");

    for stream in listener.incoming() {
        if shutdown.load(Ordering::Acquire) {
            break;
        }
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                let sessions_path = Arc::clone(&sessions_path);
                let shutdown = Arc::clone(&shutdown);
                let ipc_secret = Arc::clone(&ipc_secret);
                let policy_heartbeat = Arc::clone(&policy_heartbeat);
                let connections = Arc::clone(&connections);
                thread::Builder::new()
                    .name("vibelink-daemon-client".to_string())
                    .spawn(move || {
                        handle_connection(
                            stream,
                            state,
                            sessions_path,
                            shutdown,
                            boot_id,
                            ipc_secret,
                            policy_heartbeat,
                            connections,
                        )
                    })?;
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
    let writer = move || lock_mutex(&file).try_clone().expect("clone daemon log");

    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(writer)
        .try_init();
}

fn reconstruct_sessions(state: SharedState, sessions_path: &Path) -> Result<()> {
    for persisted in load_sessions(sessions_path)? {
        lock_state(&state).insert_session(
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

fn unix_time_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn send_admission_error<S: Write>(stream: &mut S, code: AuthorizationErrorCode) {
    let _ = write_frame(
        stream,
        &DaemonToClient::Error {
            req: None,
            message: code.as_str().to_string(),
        },
    );
}

fn authenticate_connection<S: Read + Write>(
    stream: &mut S,
    boot_id: Uuid,
    secret: &[u8; 32],
) -> std::result::Result<AuthenticatedClient, AuthorizationErrorCode> {
    let (client_id, client_kind) = match read_frame::<_, ClientToDaemon>(stream) {
        Ok(ClientToDaemon::Hello {
            protocol_version,
            client_id,
            client_kind,
        }) if protocol_version == DAEMON_PROTOCOL_VERSION => (client_id, client_kind),
        Ok(ClientToDaemon::Hello { .. }) => {
            send_admission_error(stream, AuthorizationErrorCode::DaemonProtocolMismatch);
            return Err(AuthorizationErrorCode::DaemonProtocolMismatch);
        }
        Ok(_) | Err(_) => {
            send_admission_error(stream, AuthorizationErrorCode::AuthRequired);
            return Err(AuthorizationErrorCode::AuthRequired);
        }
    };

    let mut nonce = [0_u8; 32];
    OsRng.fill_bytes(&mut nonce);
    let mut pending = PendingChallenge {
        boot_id,
        nonce,
        client_id,
        client_kind,
        expires_at: Instant::now() + AUTH_CHALLENGE_TTL,
        consumed: false,
    };
    write_frame(
        stream,
        &DaemonToClient::Challenge {
            protocol_version: DAEMON_PROTOCOL_VERSION,
            boot_id,
            nonce,
            expires_at_unix_ms: unix_time_millis() + AUTH_CHALLENGE_TTL.as_millis() as i64,
        },
    )
    .map_err(|_| AuthorizationErrorCode::AuthRequired)?;

    let (authenticate_client_id, proof) = match read_frame::<_, ClientToDaemon>(stream) {
        Ok(ClientToDaemon::Authenticate { client_id, proof }) => (client_id, proof),
        Ok(_) | Err(_) => {
            send_admission_error(stream, AuthorizationErrorCode::AuthRequired);
            return Err(AuthorizationErrorCode::AuthRequired);
        }
    };
    if let Err(code) = pending.verify(secret, authenticate_client_id, &proof, Instant::now()) {
        send_admission_error(stream, code);
        return Err(code);
    }

    let (policy_epoch, lease_until_unix_ms) = HeadlessLicenseCache::load()
        .map(|cache| {
            let snapshot = cache.authorization_snapshot(0);
            (
                snapshot.policy_epoch,
                snapshot.lease_until.timestamp_millis(),
            )
        })
        .unwrap_or_else(|_| (0, unix_time_millis()));
    write_frame(
        stream,
        &DaemonToClient::Authenticated {
            policy_epoch,
            lease_until_unix_ms,
        },
    )
    .map_err(|_| AuthorizationErrorCode::AuthRequired)?;
    Ok(AuthenticatedClient {
        client_id,
        client_kind,
    })
}

fn request_capability(
    msg: &ClientToDaemon,
) -> std::result::Result<Capability, AuthorizationErrorCode> {
    match msg {
        ClientToDaemon::Hello { .. } | ClientToDaemon::Authenticate { .. } => {
            Err(AuthorizationErrorCode::AuthRequired)
        }
        ClientToDaemon::Ping { .. } | ClientToDaemon::AuthorizationHeartbeat { .. } => {
            Ok(Capability::AccountStatus)
        }
        ClientToDaemon::Shutdown { .. } => Ok(Capability::DaemonShutdown),
        ClientToDaemon::ListSessions { .. }
        | ClientToDaemon::AttachSession { .. }
        | ClientToDaemon::DetachSession { .. } => Ok(Capability::WorkspaceRead),
        ClientToDaemon::CreateSession { .. }
        | ClientToDaemon::RenameSession { .. }
        | ClientToDaemon::DeleteSession { .. }
        | ClientToDaemon::SaveLayout { .. }
        | ClientToDaemon::SpawnPane { .. }
        | ClientToDaemon::CancelPaneSpawn { .. }
        | ClientToDaemon::ResizePane { .. }
        | ClientToDaemon::NotifySessionChanged { .. }
        | ClientToDaemon::SetPaneTitle { .. }
        | ClientToDaemon::SetPaneRole { .. }
        | ClientToDaemon::ClosePane { .. }
        | ClientToDaemon::ClearSession { .. }
        | ClientToDaemon::TaskEvent { .. } => Ok(Capability::WorkspaceMutate),
        ClientToDaemon::AttachPane { .. }
        | ClientToDaemon::GetScrollback { .. }
        | ClientToDaemon::ResourceSnapshot { .. } => Ok(Capability::TerminalRead),
        ClientToDaemon::WritePane { .. } => Ok(Capability::TerminalWrite),
    }
}

fn client_capability(
    client_kind: ClientKind,
    msg: &ClientToDaemon,
) -> std::result::Result<Option<Capability>, AuthorizationErrorCode> {
    match client_kind {
        ClientKind::App => Ok(None),
        ClientKind::Cli => Ok(Some(Capability::CliControl)),
        ClientKind::Mcp => Ok(Some(Capability::McpCall)),
        ClientKind::Remote => Ok(Some(Capability::RemoteConnect)),
        ClientKind::StartupProbe if matches!(msg, ClientToDaemon::Ping { .. }) => Ok(None),
        ClientKind::Shutdown
            if matches!(
                msg,
                ClientToDaemon::Ping { .. } | ClientToDaemon::Shutdown { .. }
            ) =>
        {
            Ok(None)
        }
        ClientKind::StartupProbe | ClientKind::Shutdown => {
            Err(AuthorizationErrorCode::AuthRequired)
        }
    }
}

fn authorize_daemon_message(
    msg: &ClientToDaemon,
    client_kind: ClientKind,
) -> std::result::Result<(), AuthorizationErrorCode> {
    authorize_daemon_message_with(msg, client_kind, || {
        HeadlessLicenseCache::load().map(|cache| cache.authorization_snapshot(0))
    })
}

fn authorize_daemon_message_with<F>(
    msg: &ClientToDaemon,
    client_kind: ClientKind,
    load_snapshot: F,
) -> std::result::Result<(), AuthorizationErrorCode>
where
    F: FnOnce() -> Result<AuthorizationSnapshot>,
{
    let operation = request_capability(msg)?;
    let ingress = client_capability(client_kind, msg)?;
    let snapshot = load_snapshot().map_err(|_| AuthorizationErrorCode::AuthorizationStale)?;
    let now = Utc::now();
    if let Some(ingress) = ingress {
        snapshot
            .authorize(ingress, now)
            .map_err(|denied| denied.code)?;
    }
    snapshot
        .authorize(operation, now)
        .map_err(|denied| denied.code)
}

fn revoke_daemon_authorization(
    state: &SharedState,
    sessions_path: &Path,
    connections: &SharedConnections,
    shutdown: &Arc<AtomicBool>,
    code: AuthorizationErrorCode,
    policy_epoch: u64,
    terminate_daemon: bool,
) {
    let controls = lock_mutex(connections)
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for control in controls {
        let _ = control.sender.send_timeout(
            DaemonToClient::AuthorizationChanged {
                code: code.as_str().to_string(),
                policy_epoch,
            },
            Duration::from_millis(250),
        );
        control.cancelled.store(true, Ordering::Release);
    }
    kill_all_panes(state);
    if let Err(error) = persist_state(state, sessions_path) {
        warn!(?error, "failed to persist authorization revocation cleanup");
    }
    if terminate_daemon {
        shutdown.store(true, Ordering::Release);
        let _ = crate::app::spawn_daemon::connect_daemon();
    }
}

fn heartbeat_revocation(
    heartbeat: &Mutex<PolicyHeartbeat>,
    now: Instant,
) -> Option<(AuthorizationErrorCode, u64, bool)> {
    let mut heartbeat = lock_mutex(heartbeat);
    if heartbeat.revoked {
        return Some((
            AuthorizationErrorCode::EntitlementRequired,
            heartbeat.policy_epoch,
            false,
        ));
    }
    if heartbeat.stale(now) {
        heartbeat.revoked = true;
        return Some((
            AuthorizationErrorCode::AuthorizationStale,
            heartbeat.policy_epoch,
            true,
        ));
    }
    None
}

fn spawn_policy_monitor(
    state: SharedState,
    sessions_path: Arc<PathBuf>,
    connections: SharedConnections,
    heartbeat: Arc<Mutex<PolicyHeartbeat>>,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    thread::Builder::new()
        .name("vibelink-daemon-policy".to_string())
        .spawn(move || {
            while !shutdown.load(Ordering::Acquire) {
                thread::sleep(Duration::from_secs(1));
                if let Some((code, epoch, terminate_daemon)) =
                    heartbeat_revocation(&heartbeat, Instant::now())
                {
                    revoke_daemon_authorization(
                        &state,
                        &sessions_path,
                        &connections,
                        &shutdown,
                        code,
                        epoch,
                        terminate_daemon,
                    );
                    if terminate_daemon {
                        break;
                    }
                }
            }
        })?;
    Ok(())
}

fn handle_connection(
    mut stream: LocalSocketStream,
    state: SharedState,
    sessions_path: Arc<PathBuf>,
    shutdown: Arc<AtomicBool>,
    boot_id: Uuid,
    ipc_secret: Arc<[u8; 32]>,
    policy_heartbeat: Arc<Mutex<PolicyHeartbeat>>,
    connections: SharedConnections,
) {
    if let Err(err) = stream.set_send_timeout(Some(CLIENT_WRITE_TIMEOUT)) {
        warn!(?err, "failed to set daemon client write timeout");
    }
    if let Err(err) = stream.set_recv_timeout(Some(AUTH_CHALLENGE_TTL)) {
        warn!(?err, "failed to set daemon admission timeout");
    }
    let authenticated = match authenticate_connection(&mut stream, boot_id, &ipc_secret) {
        Ok(authenticated) => authenticated,
        Err(error) => {
            warn!(code = error.as_str(), "daemon client admission rejected");
            return;
        }
    };
    if let Err(err) = stream.set_recv_timeout(Some(Duration::from_secs(1))) {
        warn!(?err, "failed to set daemon client read timeout");
    }
    if authenticated.client_kind == ClientKind::App {
        lock_mutex(&policy_heartbeat).note_app_connection();
    }

    let client_id = authenticated.client_id;
    let client_kind = authenticated.client_kind;
    let (mut reader, mut writer) = stream.split();
    let (tx, rx) = bounded::<DaemonToClient>(CLIENT_QUEUE_CAPACITY);
    let cancelled = Arc::new(AtomicBool::new(false));

    lock_state(&state).add_client(client_id, tx.clone());
    lock_mutex(&connections).insert(
        client_id,
        ConnectionControl {
            sender: tx.clone(),
            cancelled: Arc::clone(&cancelled),
        },
    );

    let writer_thread = thread::Builder::new()
        .name("vibelink-daemon-client-writer".to_string())
        .spawn(move || {
            while let Ok(msg) = rx.recv() {
                if let Err(err) = write_frame(&mut writer, &msg) {
                    error!(?err, "failed to write daemon reply");
                    break;
                }
            }
        });

    loop {
        if cancelled.load(Ordering::Acquire) {
            break;
        }
        if let Some((code, epoch, terminate_daemon)) =
            heartbeat_revocation(&policy_heartbeat, Instant::now())
        {
            revoke_daemon_authorization(
                &state,
                &sessions_path,
                &connections,
                &shutdown,
                code,
                epoch,
                terminate_daemon,
            );
            break;
        }

        let msg = match read_frame::<_, ClientToDaemon>(&mut reader) {
            Ok(msg) => msg,
            Err(crate::protocol::FrameError::Io(err))
                if err.kind() == io::ErrorKind::UnexpectedEof =>
            {
                break
            }
            Err(crate::protocol::FrameError::Io(err))
                if matches!(
                    err.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) =>
            {
                continue
            }
            Err(err) => {
                error!(?err, "failed to read daemon frame");
                break;
            }
        };

        let request_id = request_id(&msg);
        if let Err(code) = authorize_daemon_message(&msg, client_kind) {
            let _ = tx.send(DaemonToClient::Error {
                req: request_id,
                message: code.as_str().to_string(),
            });
            if matches!(
                code,
                AuthorizationErrorCode::EntitlementRequired
                    | AuthorizationErrorCode::AuthorizationStale
            ) {
                let epoch = lock_mutex(&policy_heartbeat).policy_epoch;
                revoke_daemon_authorization(
                    &state,
                    &sessions_path,
                    &connections,
                    &shutdown,
                    code,
                    epoch,
                    false,
                );
            } else {
                cancelled.store(true, Ordering::Release);
            }
            break;
        }

        if let ClientToDaemon::AuthorizationHeartbeat { snapshot } = &msg {
            if client_kind != ClientKind::App {
                let _ = tx.send(DaemonToClient::Error {
                    req: request_id,
                    message: DAEMON_AUTH_REQUIRED.to_string(),
                });
                break;
            }
            let mut heartbeat = lock_mutex(&policy_heartbeat);
            heartbeat.update(snapshot.clone().into());
            let revoked = heartbeat.revoked;
            let epoch = heartbeat.policy_epoch;
            drop(heartbeat);
            if revoked {
                revoke_daemon_authorization(
                    &state,
                    &sessions_path,
                    &connections,
                    &shutdown,
                    AuthorizationErrorCode::EntitlementRequired,
                    epoch,
                    false,
                );
                break;
            }
        }

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

    lock_state(&state).remove_client(client_id);
    lock_mutex(&connections).remove(&client_id);
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
        ClientToDaemon::Hello { .. } | ClientToDaemon::Authenticate { .. } => {
            bail!(DAEMON_AUTH_REQUIRED)
        }
        ClientToDaemon::AuthorizationHeartbeat { .. } => Ok(()),
        ClientToDaemon::Ping { req } => send(tx, DaemonToClient::Pong { req }),
        ClientToDaemon::ListSessions { req } => {
            let sessions = lock_state(&state).list_sessions();
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
            let meta = lock_state(&state).create_session(name, workspace_folder);
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
            lock_state(&state).rename_session(session_id, name)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)
        }
        ClientToDaemon::DeleteSession { req, session_id } => {
            let panes = lock_state(&state).delete_session(session_id)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            for mut pane in panes {
                let pane_id = pane.id;
                thread::Builder::new()
                    .name(format!("vibelink-close-pty-{pane_id}"))
                    .spawn(move || {
                        if let Err(err) = pane.kill() {
                            warn!(?err, %pane_id, "failed to kill deleted pane");
                        }
                    })?;
            }
            Ok(())
        }
        ClientToDaemon::AttachSession { req, session_id } => {
            let (layout_json, panes) = {
                let mut state = lock_state(&state);
                let attached = state.attach_session(session_id)?;
                state.attach_client_to_session(client_id, session_id);
                attached
            };
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Attached { layout_json, panes },
                },
            )
        }
        ClientToDaemon::DetachSession { session_id } => {
            lock_state(&state).detach_session(client_id, session_id);
            Ok(())
        }
        ClientToDaemon::SaveLayout {
            session_id,
            layout_json,
        } => {
            lock_state(&state).save_layout(session_id, layout_json)?;
            debounce_persist_state(&state, sessions_path)
        }
        ClientToDaemon::SpawnPane {
            req,
            session_id,
            cfg,
            attach,
        } => {
            let meta = spawn_pane_for_session(
                Arc::clone(&state),
                sessions_path.to_path_buf(),
                session_id,
                cfg,
                attach.then_some(client_id),
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
        ClientToDaemon::CancelPaneSpawn {
            req,
            session_id,
            pane_id,
        } => {
            let pane = lock_state(&state).cancel_pane_spawn(session_id, pane_id)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            if let Some(mut pane) = pane {
                thread::Builder::new()
                    .name(format!("vibelink-cancel-pty-{pane_id}"))
                    .spawn(move || {
                        if let Err(error) = pane.kill() {
                            warn!(?error, %pane_id, "failed to kill cancelled pane spawn");
                        }
                    })?;
            }
            Ok(())
        }
        ClientToDaemon::AttachPane {
            req,
            session_id,
            pane_id,
        } => {
            info!(%client_id, %session_id, %pane_id, "attaching pane");
            lock_state(&state).attach_pane(client_id, session_id, pane_id)?;
            send_ok(tx, req)
        }
        ClientToDaemon::WritePane {
            req,
            session_id,
            pane_id,
            data,
        } => {
            let writer = {
                let guard = lock_state(&state);
                guard.pane_writer(session_id, pane_id)?
            };
            let mut writer = lock_mutex(&writer);
            writer.write_all(&data)?;
            writer.flush()?;
            send_ok(tx, req)
        }
        ClientToDaemon::ResizePane {
            session_id,
            pane_id,
            cols,
            rows,
        } => {
            let senders = lock_state(&state).resize_pane(session_id, pane_id, cols, rows)?;
            for sender in senders {
                send(
                    &sender,
                    DaemonToClient::PaneResized {
                        session_id,
                        pane_id,
                        cols: cols.max(1),
                        rows: rows.max(1),
                    },
                )?;
            }
            Ok(())
        }
        ClientToDaemon::NotifySessionChanged { session_id } => {
            notify_session_changed(&state, session_id)
        }
        ClientToDaemon::SetPaneTitle {
            req,
            session_id,
            pane_id,
            title,
        } => {
            lock_state(&state).set_pane_title(session_id, pane_id, title)?;
            debounce_persist_state(&state, sessions_path)?;
            send_ok(tx, req)
        }
        ClientToDaemon::SetPaneRole {
            req,
            session_id,
            pane_id,
            role,
        } => {
            lock_state(&state).set_pane_role(session_id, pane_id, role)?;
            debounce_persist_state(&state, sessions_path)?;
            send_ok(tx, req)
        }
        ClientToDaemon::ClosePane {
            req,
            session_id,
            pane_id,
        } => {
            let pane = lock_state(&state).close_pane(session_id, pane_id)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            if let Some(mut pane) = pane {
                thread::Builder::new()
                    .name(format!("vibelink-close-pty-{pane_id}"))
                    .spawn(move || {
                        if let Err(err) = pane.kill() {
                            warn!(?err, pane_id = %pane_id, "failed to kill closed pane");
                        }
                    })?;
            }
            Ok(())
        }
        ClientToDaemon::ClearSession { req, session_id } => {
            let panes = lock_state(&state).close_session_panes(session_id)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            for mut pane in panes {
                let pane_id = pane.id;
                thread::Builder::new()
                    .name(format!("vibelink-close-pty-{pane_id}"))
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
            let data = lock_state(&state).get_scrollback(session_id, pane_id)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::ScrollbackData(data),
                },
            )
        }
        ClientToDaemon::TaskEvent {
            req,
            session_id,
            event,
        } => {
            info!(%session_id, ?event, "relaying task event");
            if let crate::protocol::TaskSignal::PaneConfigured { pane_id, role, .. } = &event {
                lock_state(&state).set_pane_role(session_id, *pane_id, role.clone())?;
                debounce_persist_state(&state, sessions_path)?;
            }
            let senders = lock_state(&state).senders_for_session(session_id);
            for sender in senders {
                let _ = sender.send(DaemonToClient::TaskEvent {
                    session_id,
                    event: event.clone(),
                });
            }
            send_ok(tx, req)
        }
        ClientToDaemon::ResourceSnapshot { req } => {
            let targets = lock_state(&state).resource_targets();
            let mut sys = sysinfo::System::new();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
            let daemon_pid = std::process::id();
            let daemon_mem_bytes = sys
                .process(sysinfo::Pid::from_u32(daemon_pid))
                .map(|process| process.memory())
                .unwrap_or(0);
            let panes = targets
                .into_iter()
                .map(|(session_id, pane_id, root_pid)| {
                    let (mem_bytes, process_count) = root_pid
                        .map(|pid| crate::daemon::proc::tree_metrics(&sys, pid))
                        .unwrap_or((0, 0));
                    crate::protocol::PaneResource {
                        session_id,
                        pane_id,
                        root_pid,
                        mem_bytes,
                        process_count,
                    }
                })
                .collect();
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::ResourceSnapshot(crate::protocol::ResourceSnapshotData {
                        daemon_pid,
                        daemon_mem_bytes,
                        panes,
                    }),
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
        | ClientToDaemon::CancelPaneSpawn { req, .. }
        | ClientToDaemon::AttachPane { req, .. }
        | ClientToDaemon::WritePane { req, .. }
        | ClientToDaemon::SetPaneTitle { req, .. }
        | ClientToDaemon::SetPaneRole { req, .. }
        | ClientToDaemon::ClosePane { req, .. }
        | ClientToDaemon::ClearSession { req, .. }
        | ClientToDaemon::GetScrollback { req, .. }
        | ClientToDaemon::TaskEvent { req, .. }
        | ClientToDaemon::ResourceSnapshot { req }
        | ClientToDaemon::Shutdown { req } => Some(*req),
        ClientToDaemon::Hello { .. }
        | ClientToDaemon::Authenticate { .. }
        | ClientToDaemon::AuthorizationHeartbeat { .. }
        | ClientToDaemon::DetachSession { .. }
        | ClientToDaemon::SaveLayout { .. }
        | ClientToDaemon::ResizePane { .. }
        | ClientToDaemon::NotifySessionChanged { .. } => None,
    }
}

fn persist_state(state: &SharedState, sessions_path: &Path) -> Result<()> {
    let _guard = lock_mutex(&PERSISTENCE_LOCK);
    let persisted = lock_state(state).persisted_sessions();
    save_sessions(sessions_path, &persisted)
}

fn debounce_persist_state(state: &SharedState, sessions_path: &Path) -> Result<()> {
    let mut persister = lock_mutex(&DEBOUNCED_PERSISTER);
    if let Some(persister) = persister.as_ref() {
        persister.dirty.store(true, Ordering::Release);
        return Ok(());
    }

    let dirty = Arc::new(AtomicBool::new(true));
    let thread_dirty = Arc::clone(&dirty);
    let thread_state = Arc::clone(state);
    let thread_sessions_path = sessions_path.to_path_buf();
    thread::Builder::new()
        .name("vibelink-daemon-persister".to_string())
        .spawn(move || loop {
            thread::sleep(PERSIST_DEBOUNCE_INTERVAL);
            if thread_dirty.swap(false, Ordering::AcqRel) {
                if let Err(err) = persist_state(&thread_state, &thread_sessions_path) {
                    warn!(?err, "failed to persist debounced state");
                }
            }
        })?;
    *persister = Some(DebouncedPersister { dirty });
    Ok(())
}

fn spawn_pane_for_session(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    mut cfg: crate::protocol::PaneConfig,
    attach_client: Option<Uuid>,
) -> Result<crate::protocol::PaneMeta> {
    if lock_state(&state).pane_spawn_cancelled(session_id, cfg.pane_id) {
        bail!("PANE_SPAWN_CANCELLED");
    }
    lock_state(&state).pane_metas(session_id)?;

    let pane_id = cfg.pane_id;
    cfg.env = pty::inject_pane_identity(std::mem::take(&mut cfg.env), session_id, pane_id);
    let spawned = Pane::spawn(cfg)?;
    let child = spawned.pane.child();
    let reader = spawned.reader;
    let meta = {
        let mut guard = lock_state(&state);
        if guard.pane_spawn_cancelled(session_id, pane_id) {
            drop(guard);
            let mut pane = spawned.pane;
            if let Err(error) = pane.kill() {
                warn!(?error, %pane_id, "failed to kill pane cancelled during spawn");
            }
            bail!("PANE_SPAWN_CANCELLED");
        }
        let meta = match guard.insert_pane_or_recover(session_id, spawned.pane) {
            Ok(meta) => meta,
            Err((err, mut pane)) => {
                drop(guard);
                if let Err(kill_err) = pane.kill() {
                    warn!(?kill_err, %pane_id, "failed to kill pane after insert error");
                }
                return Err(err);
            }
        };
        // Attach before the reader thread exists so the client receives the
        // pane's output live from the very first byte — a later AttachPane is
        // then a no-op and never has to replay a snapshot into the emulator.
        if let Some(client_id) = attach_client {
            guard.attach_client_to_pane(client_id, pane_id);
        }
        meta
    };

    thread::Builder::new()
        .name(format!("vibelink-pty-{pane_id}"))
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
    let mut buf = [0_u8; 65536];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let bytes = &buf[..n];
                let senders = lock_state(&state).record_output_and_push(pane_id, bytes);
                if !senders.is_empty() {
                    send_output_to_clients(senders, pane_id, bytes.to_vec());
                }
            }
            Err(err) => {
                warn!(?err, pane_id = %pane_id, "pty reader stopped");
                break;
            }
        }
    }

    let exit_code = lock_mutex(&child)
        .wait()
        .ok()
        .and_then(|status| i32::try_from(status.exit_code()).ok());
    let senders = lock_state(&state).mark_exited(pane_id);
    for sender in senders {
        let _ = sender.send(DaemonToClient::PaneExited { pane_id, exit_code });
    }
    if let Err(err) = persist_state(&state, &sessions_path) {
        error!(?err, %pane_id, "failed to persist pane exit");
    }
}

fn send_output_to_clients(senders: Vec<Sender<DaemonToClient>>, pane_id: Uuid, data: Vec<u8>) {
    if senders.is_empty() {
        return;
    }

    let last_index = senders.len() - 1;
    let mut original = Some(data);
    for (index, sender) in senders.into_iter().enumerate() {
        let data = if index == last_index {
            original.take().expect("original output frame present")
        } else {
            original
                .as_ref()
                .expect("original output frame present")
                .clone()
        };
        match sender.try_send(DaemonToClient::Output { pane_id, data }) {
            Ok(()) | Err(TrySendError::Full(_)) | Err(TrySendError::Disconnected(_)) => {}
        }
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

fn notify_session_changed(state: &SharedState, session_id: Uuid) -> Result<()> {
    let senders = lock_state(state).senders_for_session(session_id);
    for sender in senders {
        let _ = sender.send(DaemonToClient::SessionChanged { session_id });
    }
    Ok(())
}

fn kill_all_panes(state: &SharedState) {
    let pane_ids: Vec<Uuid> = {
        let guard = lock_state(state);
        guard
            .list_sessions()
            .into_iter()
            .flat_map(|meta| {
                guard
                    .pane_metas(meta.id)
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| p.id)
            })
            .collect()
    };

    for pane_id in pane_ids {
        let pane = {
            let mut guard = lock_state(state);
            match guard.close_pane_any(pane_id) {
                Ok(pane) => pane,
                Err(err) => {
                    warn!(?err, %pane_id, "failed to remove pane during shutdown");
                    continue;
                }
            }
        };
        let Some(mut pane) = pane else {
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
    use crate::app::authorization::AuthorizationState;
    use std::io::Cursor;

    struct AdmissionScript {
        read: Cursor<Vec<u8>>,
        written: Vec<u8>,
    }

    impl AdmissionScript {
        fn from_client_message(message: &ClientToDaemon) -> Self {
            let mut read = Vec::new();
            write_frame(&mut read, message).expect("encode client frame");
            Self {
                read: Cursor::new(read),
                written: Vec::new(),
            }
        }

        fn response(&self) -> DaemonToClient {
            read_frame(&mut Cursor::new(self.written.clone())).expect("decode daemon response")
        }
    }

    impl Read for AdmissionScript {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            self.read.read(buffer)
        }
    }

    impl Write for AdmissionScript {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.written.extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn authorization_snapshot(
        entitled: bool,
        lease_until: chrono::DateTime<Utc>,
    ) -> AuthorizationSnapshot {
        AuthorizationSnapshot {
            state: if entitled {
                AuthorizationState::ValidOnline
            } else {
                AuthorizationState::TrialExpired
            },
            entitled,
            observed_at: Utc::now(),
            lease_until,
            offline_grace_until: None,
            policy_epoch: 9,
        }
    }

    fn pending_challenge() -> (PendingChallenge, [u8; 32]) {
        let secret = [0x51_u8; 32];
        (
            PendingChallenge {
                boot_id: Uuid::new_v4(),
                nonce: [0x31_u8; 32],
                client_id: Uuid::new_v4(),
                client_kind: ClientKind::Cli,
                expires_at: Instant::now() + AUTH_CHALLENGE_TTL,
                consumed: false,
            },
            secret,
        )
    }

    #[test]
    fn valid_current_admission_proof_succeeds() {
        let (mut challenge, secret) = pending_challenge();
        let proof = daemon_auth_proof(
            &secret,
            DAEMON_PROTOCOL_VERSION,
            challenge.boot_id,
            &challenge.nonce,
            challenge.client_id,
            challenge.client_kind,
        );

        assert_eq!(
            challenge.verify(&secret, challenge.client_id, &proof, Instant::now()),
            Ok(())
        );
    }

    #[test]
    fn wrong_secret_expired_nonce_and_replay_fail_closed() {
        let (mut wrong_secret, secret) = pending_challenge();
        let wrong_proof = daemon_auth_proof(
            &[0x52_u8; 32],
            DAEMON_PROTOCOL_VERSION,
            wrong_secret.boot_id,
            &wrong_secret.nonce,
            wrong_secret.client_id,
            wrong_secret.client_kind,
        );
        assert_eq!(
            wrong_secret.verify(
                &secret,
                wrong_secret.client_id,
                &wrong_proof,
                Instant::now()
            ),
            Err(AuthorizationErrorCode::AuthRequired)
        );

        let (mut expired, secret) = pending_challenge();
        let proof = daemon_auth_proof(
            &secret,
            DAEMON_PROTOCOL_VERSION,
            expired.boot_id,
            &expired.nonce,
            expired.client_id,
            expired.client_kind,
        );
        assert_eq!(
            expired.verify(
                &secret,
                expired.client_id,
                &proof,
                expired.expires_at + Duration::from_millis(1),
            ),
            Err(AuthorizationErrorCode::AuthRequired)
        );

        let (mut replayed, secret) = pending_challenge();
        let proof = daemon_auth_proof(
            &secret,
            DAEMON_PROTOCOL_VERSION,
            replayed.boot_id,
            &replayed.nonce,
            replayed.client_id,
            replayed.client_kind,
        );
        assert!(replayed
            .verify(&secret, replayed.client_id, &proof, Instant::now())
            .is_ok());
        assert_eq!(
            replayed.verify(&secret, replayed.client_id, &proof, Instant::now()),
            Err(AuthorizationErrorCode::AuthRequired)
        );
    }

    #[test]
    fn unauthenticated_command_and_shutdown_are_rejected_as_first_frame() {
        for message in [
            ClientToDaemon::Ping { req: 1 },
            ClientToDaemon::Shutdown { req: 2 },
        ] {
            let mut stream = AdmissionScript::from_client_message(&message);
            assert_eq!(
                authenticate_connection(&mut stream, Uuid::new_v4(), &[7_u8; 32]),
                Err(AuthorizationErrorCode::AuthRequired)
            );
            assert_eq!(
                stream.response(),
                DaemonToClient::Error {
                    req: None,
                    message: "AUTH_REQUIRED".to_string(),
                }
            );
        }
    }

    #[test]
    fn expired_entitlement_and_logout_fail_next_request_with_stable_codes() {
        let message = ClientToDaemon::WritePane {
            req: 1,
            session_id: Uuid::new_v4(),
            pane_id: Uuid::new_v4(),
            data: b"whoami\r".to_vec(),
        };
        let active = authorization_snapshot(true, Utc::now() + chrono::Duration::minutes(1));
        assert_eq!(
            authorize_daemon_message_with(&message, ClientKind::Cli, || Ok(active)),
            Ok(())
        );

        let logged_out = authorization_snapshot(false, Utc::now());
        assert_eq!(
            authorize_daemon_message_with(&message, ClientKind::Cli, || Ok(logged_out)),
            Err(AuthorizationErrorCode::EntitlementRequired)
        );

        let expired = authorization_snapshot(true, Utc::now() - chrono::Duration::milliseconds(1));
        assert_eq!(
            authorize_daemon_message_with(&message, ClientKind::App, || Ok(expired)),
            Err(AuthorizationErrorCode::AuthorizationStale)
        );
    }

    #[test]
    fn stale_policy_heartbeat_requires_daemon_shutdown() {
        let heartbeat = Mutex::new(PolicyHeartbeat {
            deadline: Some(Instant::now() - Duration::from_millis(1)),
            policy_epoch: 12,
            revoked: false,
        });

        assert_eq!(
            heartbeat_revocation(&heartbeat, Instant::now()),
            Some((AuthorizationErrorCode::AuthorizationStale, 12, true))
        );
    }

    #[test]
    fn heartbeat_lease_is_bounded_to_ninety_seconds() {
        let mut heartbeat = PolicyHeartbeat::default();
        heartbeat.update(authorization_snapshot(
            true,
            Utc::now() + chrono::Duration::hours(1),
        ));
        let deadline = heartbeat.deadline.expect("heartbeat deadline");

        assert!(deadline <= Instant::now() + POLICY_HEARTBEAT_TTL);
        assert!(!heartbeat.revoked);
    }

    #[test]
    fn ping_reply_can_be_sent() {
        let (tx, rx) = bounded(1);
        send(&tx, DaemonToClient::Pong { req: 77 }).expect("send pong");
        assert_eq!(rx.recv().expect("pong"), DaemonToClient::Pong { req: 77 });
    }

    #[test]
    fn client_write_timeout_is_bounded() {
        assert!(CLIENT_WRITE_TIMEOUT <= Duration::from_secs(3));
    }

    #[test]
    fn client_queue_capacity_is_bounded() {
        assert_eq!(CLIENT_QUEUE_CAPACITY, 256);
    }

    #[test]
    fn output_frame_is_dropped_when_client_queue_is_full() {
        let (tx, rx) = bounded(1);
        let pane_id = Uuid::new_v4();

        tx.send(DaemonToClient::Pong { req: 1 })
            .expect("fill client queue");
        send_output_to_clients(vec![tx], pane_id, b"dropped".to_vec());

        assert_eq!(
            rx.recv().expect("queued control frame"),
            DaemonToClient::Pong { req: 1 }
        );
        assert!(rx.try_recv().is_err());
    }
    #[test]
    fn kill_all_panes_does_not_deadlock() {
        let state = Arc::new(Mutex::new(DaemonState::new()));
        let pane_id = Uuid::new_v4();
        {
            let mut guard = state.lock().expect("state mutex");
            let session = guard.create_session("Workspace".to_string(), None);
            guard
                .insert_pane(
                    session.id,
                    Pane::for_test(
                        crate::protocol::PaneConfig {
                            pane_id,
                            shell: None,
                            args: Vec::new(),
                            cwd: None,
                            env: Vec::new(),
                            title: Some("test".to_string()),
                            icon: None,
                            profile_id: None,
                            role: None,
                            cols: 80,
                            rows: 24,
                        },
                        true,
                    ),
                )
                .expect("insert pane");
        }

        let (tx, rx) = bounded(1);
        let state_for_thread = Arc::clone(&state);
        thread::spawn(move || {
            kill_all_panes(&state_for_thread);
            tx.send(()).expect("notify completion");
        });

        rx.recv_timeout(Duration::from_secs(1))
            .expect("kill_all_panes returned");
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
                icon: None,
                profile_id: None,
                role: None,
                cols: 80,
                rows: 24,
            },
            attach: false,
        };

        assert_eq!(request_id(&msg), Some(42));
    }

    #[test]
    fn request_id_tracks_attach_and_write_acknowledgements() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        assert_eq!(
            request_id(&ClientToDaemon::AttachPane {
                req: 7,
                session_id,
                pane_id,
            }),
            Some(7)
        );
        assert_eq!(
            request_id(&ClientToDaemon::CancelPaneSpawn {
                req: 9,
                session_id,
                pane_id,
            }),
            Some(9)
        );
        assert_eq!(
            request_id(&ClientToDaemon::WritePane {
                req: 8,
                session_id,
                pane_id,
                data: b"input".to_vec(),
            }),
            Some(8)
        );
    }

    #[test]
    fn pid_file_guard_writes_and_removes_current_pid() {
        let path = std::env::temp_dir().join(format!(
            "vibelink-daemon-test-{}-{}.pid",
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

mod automation;
mod browser_cdp;
pub mod paths;
pub mod persistence;
pub mod proc;
pub mod pty;
pub mod query_filter;
pub mod scrollback;
pub mod session;
mod terminal_history;

use crate::agent_runtime::WorktreeManager;
use crate::app::git::worktree::{WorktreeStorage, WorktreeStorageMode};
use crate::app::git::worktree_lifecycle::{WorktreeCreateResult, WorktreeLifecycleService};
use crate::app::git::worktree_registry::{
    WorktreeBlockerKind, WorktreeCheckpointRequest, WorktreeCreateRequest, WorktreeIdRequest,
    WorktreeImportRequest, WorktreeListRequest, WorktreeMoveRequest, WorktreeOperationIdRequest,
    WorktreeOrigin, WorktreeProjection, WorktreeReconcileRequest, WorktreeRegistry,
    WorktreeRemovalPreflightRequest, WorktreeRemovalResult, WorktreeRemoveRequest,
    WorktreeReviewCommentRequest, WorktreeRuntimeBlockers, WorktreeSetRequest,
    WORKTREE_METHOD_CANCEL, WORKTREE_METHOD_CHECKPOINT, WORKTREE_METHOD_CHECKPOINTS,
    WORKTREE_METHOD_CREATE, WORKTREE_METHOD_IMPORT, WORKTREE_METHOD_LIST, WORKTREE_METHOD_MOVE,
    WORKTREE_METHOD_PREFLIGHT_REMOVE, WORKTREE_METHOD_RECONCILE, WORKTREE_METHOD_REMOVE,
    WORKTREE_METHOD_REVIEW_COMMENTS, WORKTREE_METHOD_REVIEW_COMMENT_PUT, WORKTREE_METHOD_SET,
};
use crate::computer_use::{
    ActionRequest, ActionTarget, ApprovalRequest, ComputerAction as ProviderComputerAction,
    HostRequest, HostResponseBody, Point, ProviderError, ProviderHostSupervisor, SnapshotLimits,
    SnapshotRequest, WindowIdentity, WindowsProcessSpawner,
};
use crate::control_plane::{ControlCommand, ControlPlane};
use crate::daemon::automation::{AutomationService, AutomationWorktreeProvision};
use crate::daemon::persistence::{load_sessions, save_sessions};
use crate::daemon::pty::{Pane, SharedChild};
use crate::daemon::session::{
    DaemonState, PaneExitEffect, PaneLeaseEffect, PaneLeaseTransition, PaneOutputEffect,
};
use crate::daemon::terminal_history::{
    load_pane_history, remove_pane_history, remove_session_history, TerminalHistoryWriter,
};
use crate::dedicated_cli::{
    AutomationAction, CliControlRequest, Command as DedicatedCommand, ComputerAction,
    OrchestrationAction, RemoteAction, SkillAction, TerminalAction, WorkspaceAction,
    WorktreeAction,
};
use crate::orchestration::adapters::AgentProvider;
use crate::orchestration::{
    AcknowledgeEventsRequest, AgentLaunchFailureRequest, BindDispatchRequest,
    CleanupAppliedRequest, CoordinatorError, CoordinatorService, CreateGateRequest,
    CreateRunRequest, CreateTaskRequest, DispatchCleanupTarget, DispatchLaunchOutcome,
    DispatchLaunchPreparation, DispatchLaunchRequest, DispatchLaunchResult, DispatchLaunchStatus,
    DispatchResourceRecord, DispatchResourceReservation, DispatchStatus, GateMutationResult,
    GateStatus, HeartbeatRequest, LaunchFailureRequest, LifecycleIdentity, MergeAppliedRequest,
    MessageType, PostMessageRequest, ReconcileLivenessRequest, RegisterAgentRequest,
    ResolveGateRequest, ResourceDisposition, RetryTaskRequest, RunDecisionRequest,
    RunRevisionRequest, UpdateTaskRequest, WorkerDoneRequest, WorktreeAssignment, WorktreeMode,
};
use crate::protocol::{
    read_frame, write_frame, ClientToDaemon, DaemonToClient, PaneCommandOrigin, PaneConfig,
    RemoteBrowserHostRequest, RemoteBrowserHostResponse, RemoteConnectionCleanupRequest,
    RemotePaneLeaseResult, RemotePaneLeaseStatusRequest, ReplyResult, Req,
};
use crate::remote::{RemotePaneLeaseStatus, RemoteServer};
use anyhow::{Context, Result};
use crossbeam_channel::{bounded, Sender, TrySendError};
use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, MutexGuard,
    },
    thread,
    time::{Duration, Instant},
};
use tracing::{error, info, warn};
use uuid::Uuid;

type SharedState = Arc<Mutex<DaemonState>>;
type SharedComputerHost = Sender<ComputerHostCall>;

struct ComputerHostCall {
    operation_id: Uuid,
    request: HostRequest,
    reply: Sender<std::result::Result<HostResponseBody, ProviderError>>,
}
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(3);
const CLIENT_QUEUE_CAPACITY: usize = 256;
const PERSIST_DEBOUNCE_INTERVAL: Duration = Duration::from_millis(500);
const REMOTE_PANE_LEASE_SWEEP_INTERVAL: Duration = Duration::from_secs(1);
const AUTOMATION_SCHEDULER_INTERVAL: Duration = Duration::from_secs(30);
const AUTOMATION_SCHEDULER_SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(100);
static PERSISTENCE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static DEBOUNCED_PERSISTER: LazyLock<Mutex<Option<DebouncedPersister>>> =
    LazyLock::new(|| Mutex::new(None));
static ORCHESTRATION_LAUNCH_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static BROWSER_HOST_ROUTER: LazyLock<Mutex<BrowserHostRouter>> =
    LazyLock::new(|| Mutex::new(BrowserHostRouter::default()));

#[derive(Default)]
struct BrowserHostRouter {
    host: Option<(Uuid, Sender<DaemonToClient>)>,
    pending: HashMap<Uuid, Sender<RemoteBrowserHostResponse>>,
}

fn register_browser_host(client_id: Uuid, sender: Sender<DaemonToClient>) {
    lock_mutex(&BROWSER_HOST_ROUTER).host = Some((client_id, sender));
}

fn unregister_browser_host(client_id: Uuid) {
    let mut router = lock_mutex(&BROWSER_HOST_ROUTER);
    if router
        .host
        .as_ref()
        .is_some_and(|(host_id, _)| *host_id == client_id)
    {
        router.host = None;
        router.pending.clear();
    }
}

fn dispatch_browser_host_request(
    operation_id: Uuid,
    method: String,
    payload_json: String,
) -> Result<String> {
    let request_id = Uuid::new_v4();
    let (response_tx, response_rx) = bounded(1);
    let host = {
        let mut router = lock_mutex(&BROWSER_HOST_ROUTER);
        let host = router
            .host
            .as_ref()
            .map(|(_, sender)| sender.clone())
            .context("browser_unavailable: desktop browser host is not connected")?;
        router.pending.insert(request_id, response_tx);
        host
    };
    let request = RemoteBrowserHostRequest {
        request_id,
        operation_id,
        method,
        payload_json,
    };
    if host
        .send(DaemonToClient::RemoteBrowserRequest { request })
        .is_err()
    {
        lock_mutex(&BROWSER_HOST_ROUTER).pending.remove(&request_id);
        anyhow::bail!("browser_unavailable: desktop browser host disconnected");
    }
    let response = match response_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(response) => response,
        Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
            lock_mutex(&BROWSER_HOST_ROUTER).pending.remove(&request_id);
            anyhow::bail!("browser_unavailable: desktop browser host timed out");
        }
        Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
            lock_mutex(&BROWSER_HOST_ROUTER).pending.remove(&request_id);
            anyhow::bail!("browser_unavailable: desktop browser host disconnected");
        }
    };
    if response.request_id != request_id {
        anyhow::bail!("conflict: browser host response identity mismatch");
    }
    if let Some(error) = response.error {
        anyhow::bail!(error);
    }
    response
        .result_json
        .context("browser host returned no result")
}

fn resolve_browser_host_response(
    client_id: Uuid,
    response: RemoteBrowserHostResponse,
) -> Result<()> {
    let sender = {
        let mut router = lock_mutex(&BROWSER_HOST_ROUTER);
        if !router
            .host
            .as_ref()
            .is_some_and(|(host_id, _)| *host_id == client_id)
        {
            anyhow::bail!("capability_denied: client is not the registered browser host");
        }
        router.pending.remove(&response.request_id)
    };
    if let Some(sender) = sender {
        let _ = sender.send(response);
    }
    Ok(())
}

struct DebouncedPersister {
    dirty: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    handle: thread::JoinHandle<()>,
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
    let boot_token = Arc::new(paths::load_or_create_boot_token(&paths.auth_token)?);
    let user_sid = Arc::new(paths::current_user_sid());

    let state = Arc::new(Mutex::new(DaemonState::new()));
    reconstruct_sessions(Arc::clone(&state), &paths.sessions)?;
    let control = Arc::new(ControlPlane::open(&paths.data_dir)?);
    let worktree_registry = Arc::new(WorktreeRegistry::new(Arc::clone(&control)));
    let worktree_lifecycle = Arc::new(WorktreeLifecycleService::native(Arc::clone(
        &worktree_registry,
    )));
    let coordinator = Arc::new(CoordinatorService::new(Arc::clone(&control)));
    let worktrees = Arc::new(WorktreeManager::new(
        paths
            .data_dir
            .join("automation-artifacts")
            .join("worktrees"),
        Arc::clone(&worktree_registry),
    )?);
    reconcile_orchestration_startup(&state, &coordinator, &worktrees)?;
    let automation = Arc::new(AutomationService::open(
        &paths
            .data_dir
            .join("control")
            .join("vibelink-control.sqlite3"),
        paths.data_dir.join("automation-artifacts"),
        Arc::clone(&coordinator),
        Arc::clone(&worktree_registry),
    )?);
    let computer_host_executable = std::env::var_os("VIBELINK_COMPUTER_HOST_EXE")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe().ok().and_then(|path| {
                path.parent()
                    .map(|parent| parent.join("vibelink-computer-host.exe"))
            })
        })
        .context("resolve computer-use host executable")?;
    let computer = start_computer_host(
        WindowsProcessSpawner::new(paths.data_dir.join("computer-artifacts"), app_flavor),
        computer_host_executable,
    )?;
    let remote = Arc::new(RemoteServer::new(paths.data_dir.clone())?);
    remote.start_if_enabled()?;

    let sessions_path = Arc::new(paths.sessions.clone());
    let shutdown = Arc::new(AtomicBool::new(false));
    start_automation_scheduler(
        Arc::clone(&automation),
        Arc::clone(&state),
        Arc::clone(&shutdown),
        Arc::clone(&sessions_path),
        Arc::clone(&worktree_lifecycle),
        Arc::clone(&worktrees),
    )?;
    start_remote_pane_lease_expiry_sweep(Arc::clone(&state), Arc::clone(&shutdown))?;
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
                let control = Arc::clone(&control);
                let coordinator = Arc::clone(&coordinator);
                let worktree_registry = Arc::clone(&worktree_registry);
                let worktree_lifecycle = Arc::clone(&worktree_lifecycle);
                let computer = computer.clone();
                let automation = Arc::clone(&automation);
                let worktrees = Arc::clone(&worktrees);
                let remote = Arc::clone(&remote);
                let boot_token = Arc::clone(&boot_token);
                let user_sid = Arc::clone(&user_sid);
                thread::Builder::new()
                    .name("vibelink-daemon-client".to_string())
                    .spawn(move || {
                        handle_connection(
                            stream,
                            state,
                            sessions_path,
                            control,
                            coordinator,
                            worktree_registry,
                            worktree_lifecycle,
                            worktrees,
                            automation,
                            remote,
                            shutdown,
                            computer,
                            boot_token,
                            user_sid,
                        )
                    })?;
            }
            Err(err) => warn!(?err, "failed to accept daemon client"),
        }
    }

    info!("daemon shutting down, preserving restorable panes");
    if let Err(err) = persist_restorable_panes_and_kill_all(&state, &sessions_path) {
        warn!(?err, "failed to persist state during shutdown");
    }
    drop(lock_file);


    Ok(())
}

fn start_automation_scheduler(
    automation: Arc<AutomationService>,
    state: SharedState,
    shutdown: Arc<AtomicBool>,
    sessions_path: Arc<PathBuf>,
    worktree_lifecycle: Arc<WorktreeLifecycleService>,
    worktrees: Arc<WorktreeManager>,
) -> Result<()> {
    thread::Builder::new()
        .name("vibelink-automation-scheduler".to_string())
        .spawn(move || {
            automation_scheduler_loop(&shutdown, || {
                run_automation_scheduler_tick(
                    &automation,
                    &state,
                    &sessions_path,
                    &worktree_lifecycle,
                    &worktrees,
                );
            });
        })?;
    Ok(())
}

fn automation_scheduler_loop<F>(shutdown: &AtomicBool, mut tick: F)
where
    F: FnMut(),
{
    while !shutdown.load(Ordering::Acquire) {
        tick();
        if wait_for_automation_scheduler_shutdown(shutdown, AUTOMATION_SCHEDULER_INTERVAL) {
            break;
        }
    }
}

fn wait_for_automation_scheduler_shutdown(shutdown: &AtomicBool, timeout: Duration) -> bool {
    if shutdown.load(Ordering::Acquire) {
        return true;
    }

    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return shutdown.load(Ordering::Acquire);
        }
        thread::sleep(remaining.min(AUTOMATION_SCHEDULER_SHUTDOWN_POLL_INTERVAL));
        if shutdown.load(Ordering::Acquire) {
            return true;
        }
    }
}

fn run_automation_scheduler_tick(
    automation: &Arc<AutomationService>,
    state: &SharedState,
    sessions_path: &Arc<PathBuf>,
    worktree_lifecycle: &Arc<WorktreeLifecycleService>,
    worktrees: &Arc<WorktreeManager>,
) {
    let claims = match automation.claim_due(orchestration_now_millis()) {
        Ok(claims) => claims,
        Err(error) => {
            warn!(?error, "automation scheduler scan failed");
            return;
        }
    };

    for claim in claims {
        let workspace = automation
            .get(&claim.automation_id)
            .ok()
            .and_then(|record| automation_workspace(state, &record.session_id).ok())
            .unwrap_or_else(|| PathBuf::from("__vibelink_missing_workspace__"));
        let automation = Arc::clone(automation);
        let state = Arc::clone(state);
        let sessions_path = Arc::clone(sessions_path);
        let worktree_lifecycle = Arc::clone(worktree_lifecycle);
        let worktrees = Arc::clone(worktrees);
        let spawn_run_id = claim.id.clone();
        let execution_run_id = spawn_run_id.clone();
        let thread_name = format!(
            "vibelink-automation-{}",
            spawn_run_id.get(..8).unwrap_or(&spawn_run_id)
        );
        if let Err(error) = thread::Builder::new().name(thread_name).spawn(move || {
            if let Err(error) = automation.execute_and_notify_with_worktree(
                &claim,
                &workspace,
                |record, claim, workspace, planned| {
                    provision_automation_worktree(
                        &state,
                        &sessions_path,
                        &worktree_lifecycle,
                        &worktrees,
                        record,
                        claim,
                        workspace,
                        planned,
                    )
                },
            ) {
                error!(automation_run_id = %execution_run_id, ?error, "automation run failed");
            }
        }) {
            error!(automation_run_id = %spawn_run_id, ?error, "failed to spawn automation run thread");
        }
    }
}

fn start_remote_pane_lease_expiry_sweep(
    state: SharedState,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    thread::Builder::new()
        .name("vibelink-pane-lease-expiry".to_string())
        .spawn(move || {
            while !shutdown.load(Ordering::Acquire) {
                thread::sleep(REMOTE_PANE_LEASE_SWEEP_INTERVAL);
                if shutdown.load(Ordering::Acquire) {
                    break;
                }
                let transitions =
                    lock_state(&state).expire_remote_pane_leases(orchestration_now_millis());
                process_pane_lease_transitions(&state, transitions);
            }
        })?;
    Ok(())
}

fn start_computer_host(
    spawner: WindowsProcessSpawner,
    executable_path: PathBuf,
) -> Result<SharedComputerHost> {
    let (tx, rx) = bounded::<ComputerHostCall>(64);
    thread::Builder::new()
        .name("vibelink-computer-host-owner".to_string())
        .spawn(move || {
            let mut supervisor = ProviderHostSupervisor::new(spawner, executable_path);
            while let Ok(call) = rx.recv() {
                let result = supervisor.request(call.operation_id, call.request);
                let _ = call.reply.send(result);
            }
        })?;
    Ok(tx)
}

fn request_computer_host(
    computer: &SharedComputerHost,
    operation_id: Uuid,
    request: HostRequest,
) -> Result<HostResponseBody> {
    let (reply, response) = bounded(1);
    computer
        .send(ComputerHostCall {
            operation_id,
            request,
            reply,
        })
        .context("computer-use host actor is unavailable")?;
    response
        .recv()
        .context("computer-use host actor stopped")?
        .map_err(anyhow::Error::from)
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExactProcessObservation {
    Running,
    Gone,
    Reused,
}

fn orchestration_now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn process_start_time(root_pid: u32) -> Option<u64> {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .process(sysinfo::Pid::from_u32(root_pid))
        .map(sysinfo::Process::start_time)
}

fn observe_exact_process(root_pid: u32, started_at: u64) -> ExactProcessObservation {
    match process_start_time(root_pid) {
        None => ExactProcessObservation::Gone,
        Some(current) if current == started_at => ExactProcessObservation::Running,
        Some(_) => ExactProcessObservation::Reused,
    }
}

fn processes_for_pane_identity(pane_id: Uuid) -> Vec<(u32, u64)> {
    let expected = format!("VIBELINK_PANE_ID={pane_id}");
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::everything(),
    );
    let matches = system
        .processes()
        .iter()
        .filter_map(|(pid, process)| {
            process
                .environ()
                .iter()
                .any(|entry| entry.to_string_lossy() == expected)
                .then(|| {
                    (
                        pid.as_u32(),
                        process.start_time(),
                        process.parent().map(|parent| parent.as_u32()),
                    )
                })
        })
        .collect::<Vec<_>>();
    matches
        .iter()
        .filter(|(_, _, parent)| {
            parent.map_or(true, |parent| {
                !matches.iter().any(|(pid, _, _)| *pid == parent)
            })
        })
        .map(|(pid, started_at, _)| (*pid, *started_at))
        .collect()
}

fn kill_pane_processes_until_exit(pane_id: Uuid) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let roots = processes_for_pane_identity(pane_id);
        if roots.is_empty() {
            return true;
        }
        for (root_pid, _) in roots {
            crate::daemon::proc::kill_process_tree(root_pid);
        }
        if std::time::Instant::now() >= deadline {
            return processes_for_pane_identity(pane_id).is_empty();
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn cleanup_dispatch_target(
    state: &SharedState,
    coordinator: &CoordinatorService,
    worktrees: &WorktreeManager,
    target: &DispatchCleanupTarget,
    reason: &str,
) -> (Option<DispatchResourceRecord>, Vec<String>) {
    let mut resource = target.resources.clone().unwrap_or_else(|| {
        let repository_root = automation_workspace(state, &target.session_id)
            .ok()
            .and_then(|workspace| worktrees.authority(&workspace).ok())
            .map(|authority| authority.repository_root_string());
        DispatchResourceRecord {
            session_id: target.session_id.clone(),
            repository_root,
            relative_prefix: String::new(),
            launch_path: None,
            agent_instance_id: target.dispatch.agent_instance_id.clone(),
            pane_id: target.dispatch.pane_id.clone(),
            root_pid: None,
            process_started_at: None,
            process_generation: target.dispatch.process_generation,
            worktree: target.dispatch.worktree.clone(),
            pane_disposition: if target.dispatch.pane_id.is_some() {
                ResourceDisposition::Live
            } else {
                ResourceDisposition::NotCreated
            },
            worktree_disposition: if target.dispatch.worktree.is_some() {
                ResourceDisposition::Retained
            } else {
                ResourceDisposition::NotCreated
            },
            cleanup_reason: None,
            cleanup_error: None,
        }
    });
    let mut errors = Vec::new();
    if target.resources.is_none()
        && target.dispatch.pane_id.is_none()
        && target.dispatch.worktree.is_none()
    {
        return (Some(resource), errors);
    }
    match coordinator.mark_dispatch_resource_disposition(
        &target.dispatch.id,
        None,
        None,
        false,
        false,
        Some(reason),
        None,
    ) {
        Ok(updated) => resource = updated,
        Err(error) => {
            let message = format!(
                "failed to persist cleanup ownership for dispatch {}: {}",
                target.dispatch.id, error
            );
            resource.pane_disposition = ResourceDisposition::CleanupFailed;
            resource.cleanup_reason = Some(reason.to_string());
            resource.cleanup_error = Some(bounded_launch_error(&message));
            return (Some(resource), vec![message]);
        }
    }

    if let Some(pane_id_text) = resource
        .pane_id
        .clone()
        .or_else(|| target.dispatch.pane_id.clone())
    {
        let pane_error_start = errors.len();
        match (
            Uuid::parse_str(&target.session_id),
            Uuid::parse_str(&pane_id_text),
        ) {
            (Ok(session_id), Ok(pane_id)) => {
                let live_root = lock_state(state)
                    .resource_targets()
                    .into_iter()
                    .find(|(owner_session, owner_pane, _)| {
                        *owner_session == session_id && *owner_pane == pane_id
                    })
                    .and_then(|(_, _, root_pid)| root_pid);
                let root_identity_changed = live_root.is_some()
                    && resource.root_pid.is_some()
                    && live_root != resource.root_pid;
                if root_identity_changed {
                    errors.push(format!(
                        "pane {pane_id} root process identity changed; refusing cleanup"
                    ));
                } else {
                    if live_root.is_some() {
                        let (pane, lease_transition) = {
                            let mut guard = lock_state(state);
                            match guard.close_pane(session_id, pane_id) {
                                Ok(pane) => {
                                    let lease = guard.cleanup_remote_pane_lease_on_exit(pane_id);
                                    (pane, lease)
                                }
                                Err(error) => {
                                    errors.push(format!("pane {pane_id} cleanup failed: {error}"));
                                    (None, None)
                                }
                            }
                        };
                        if let Some(transition) = lease_transition {
                            process_pane_lease_transition(state, transition);
                        }
                        if let Some(mut pane) = pane {
                            if let Err(error) = pane.kill() {
                                errors.push(format!("pane {pane_id} cleanup failed: {error}"));
                            }
                        }
                    } else if let (Some(root_pid), Some(started_at)) =
                        (resource.root_pid, resource.process_started_at)
                    {
                        if observe_exact_process(root_pid, started_at)
                            == ExactProcessObservation::Running
                        {
                            crate::daemon::proc::kill_process_tree(root_pid);
                        }
                    }

                    let identity_roots = processes_for_pane_identity(pane_id);
                    if identity_roots.is_empty()
                        && resource.process_started_at.is_none()
                        && resource
                            .root_pid
                            .is_some_and(|root_pid| process_start_time(root_pid).is_some())
                    {
                        errors.push(format!(
                            "pane {pane_id} has no durable process start identity; refusing PID-only cleanup"
                        ));
                    }
                    if !kill_pane_processes_until_exit(pane_id) {
                        errors.push(format!(
                            "pane {pane_id} process trees remained alive after cleanup"
                        ));
                    }
                    if let (Some(root_pid), Some(started_at)) =
                        (resource.root_pid, resource.process_started_at)
                    {
                        if observe_exact_process(root_pid, started_at)
                            == ExactProcessObservation::Running
                        {
                            errors.push(format!(
                                "pane {pane_id} exact root process {root_pid} remained alive after cleanup"
                            ));
                        }
                    }
                }
            }
            _ => errors.push(format!("invalid durable pane identity {pane_id_text}")),
        }

        let pane_error =
            (errors.len() > pane_error_start).then(|| errors[pane_error_start..].join("; "));
        resource.pane_disposition = if pane_error.is_some() {
            ResourceDisposition::CleanupFailed
        } else {
            ResourceDisposition::Cleaned
        };
        if pane_error.is_none() {
            resource.pane_id = None;
            resource.root_pid = None;
            resource.process_started_at = None;
        }
        if let Ok(updated) = coordinator.mark_dispatch_resource_disposition(
            &target.dispatch.id,
            Some(resource.pane_disposition),
            None,
            pane_error.is_none(),
            false,
            Some(reason),
            pane_error.as_deref(),
        ) {
            resource = updated;
        }
    }

    (Some(resource), errors)
}

fn cleanup_run_resources(
    state: &SharedState,
    coordinator: &CoordinatorService,
    worktrees: &WorktreeManager,
    run_id: &str,
    reason: &str,
) -> Result<(Vec<DispatchResourceRecord>, Vec<String>)> {
    let mut resources = Vec::new();
    let mut errors = Vec::new();
    for target in coordinator.cleanup_targets_for_run(run_id)? {
        let (resource, mut target_errors) =
            cleanup_dispatch_target(state, coordinator, worktrees, &target, reason);
        if let Some(resource) = resource {
            resources.push(resource);
        }
        errors.append(&mut target_errors);
    }
    Ok((resources, errors))
}

fn reconcile_orchestration_startup(
    state: &SharedState,
    coordinator: &CoordinatorService,
    worktrees: &WorktreeManager,
) -> Result<()> {
    let mut resources = Vec::new();
    let mut cleanup_errors = Vec::new();
    for target in coordinator.active_cleanup_targets()? {
        let retained_reason = target
            .resources
            .as_ref()
            .and_then(|resource| resource.cleanup_reason.as_deref())
            .filter(|reason| {
                matches!(
                    *reason,
                    "cancel"
                        | "reject"
                        | "gate_reject"
                        | "merge_applied"
                        | "launch_failure"
                        | "retry_cleanup"
                )
            });
        let cleanup_reason = retained_reason.unwrap_or("daemon_restart");
        let (resource, mut errors) =
            cleanup_dispatch_target(state, coordinator, worktrees, &target, cleanup_reason);
        if let Some(resource) = resource {
            resources.push(resource);
        }
        cleanup_errors.append(&mut errors);
    }
    require_workers_stopped(&resources, &cleanup_errors)
        .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
    coordinator.reconcile_daemon_restart(Uuid::new_v4(), orchestration_now_millis())?;
    Ok(())
}

fn reconstruct_sessions(state: SharedState, sessions_path: &Path) -> Result<()> {
    let mut panes_to_restore = Vec::new();
    for persisted in load_sessions(sessions_path)? {
        let session_id = persisted.id;
        let workspace_folder = persisted.workspace_folder;
        let sleeping = persisted.sleeping;
        // Orca parity (`HistoryReader.hasRestorableHistory`): a workspace shut
        // down deliberately is NOT reconstructed. Only an unclean exit --
        // crash, machine reboot, or force kill -- leaves `clean_exit` false and
        // therefore rebuilds its panes. This is what makes "close, then open"
        // predictable instead of always resurrecting the previous screen.
        let restorable = !sleeping && !persisted.clean_exit;
        for cfg in persisted.panes {
            if restorable && cfg.restore_on_start {
                panes_to_restore.push((session_id, workspace_folder.clone(), cfg));
            }
        }
        if persisted.clean_exit {
            // The stale bytes would otherwise be replayed into whatever pane
            // later reuses this id.
            if let Err(error) = remove_session_history(sessions_path, session_id) {
                warn!(?error, %session_id, "failed to drop history after clean exit");
            }
        }
        lock_state(&state).insert_session(
            crate::protocol::SessionMeta {
                id: session_id,
                name: persisted.name,
                pane_count: 0,
                created_at: persisted.created_at,
                workspace_folder,
            },
            persisted.layout_json,
            sleeping,
            persisted.clean_exit,
        );
    }

    for (session_id, workspace_folder, mut cfg) in panes_to_restore {
        if cfg
            .cwd
            .as_deref()
            .is_some_and(|cwd| !Path::new(cwd).is_dir())
        {
            let fallback = workspace_folder.filter(|folder| Path::new(folder).is_dir());
            warn!(
                pane_id = %cfg.pane_id,
                old_cwd = ?cfg.cwd,
                fallback_cwd = ?fallback,
                "restored pane working directory no longer exists"
            );
            cfg.cwd = fallback;
        }
        let pane_id = cfg.pane_id;
        let scrollback = match load_pane_history(sessions_path, session_id, pane_id) {
            Ok(scrollback) => scrollback,
            Err(error) => {
                warn!(?error, %session_id, %pane_id, "failed to load terminal history");
                Vec::new()
            }
        };
        if let Err(error) = restore_pane_for_session(
            Arc::clone(&state),
            sessions_path.to_path_buf(),
            session_id,
            cfg,
            scrollback,
        ) {
            warn!(?error, %session_id, %pane_id, "failed to cold-restore pane");
            let _ = remove_pane_history(sessions_path, session_id, pane_id);
        }
    }
    persist_state(&state, sessions_path)
}

fn handle_connection(
    stream: LocalSocketStream,
    state: SharedState,
    sessions_path: Arc<PathBuf>,
    control: Arc<ControlPlane>,
    coordinator: Arc<CoordinatorService>,
    worktree_registry: Arc<WorktreeRegistry>,
    worktree_lifecycle: Arc<WorktreeLifecycleService>,
    worktrees: Arc<WorktreeManager>,
    automation: Arc<AutomationService>,
    remote: Arc<RemoteServer>,
    shutdown: Arc<AtomicBool>,
    computer: SharedComputerHost,
    boot_token: Arc<String>,
    user_sid: Arc<String>,
) {
    if let Err(err) = stream.set_send_timeout(Some(CLIENT_WRITE_TIMEOUT)) {
        warn!(?err, "failed to set daemon client write timeout");
    }
    let mut client_id = Uuid::new_v4();
    let mut authenticated = false;
    let (mut reader, mut writer) = stream.split();
    let (tx, rx) = bounded::<DaemonToClient>(CLIENT_QUEUE_CAPACITY);

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

        match &msg {
            ClientToDaemon::Hello { .. } | ClientToDaemon::Ping { .. } => {}
            ClientToDaemon::Authenticate {
                req,
                client_id: authenticated_client_id,
                boot_token: supplied_token,
                process_id,
                user_sid: supplied_sid,
            } => {
                if *process_id == 0
                    || supplied_sid != user_sid.as_str()
                    || !constant_time_equal(supplied_token.as_bytes(), boot_token.as_bytes())
                {
                    let _ = tx.send(DaemonToClient::Error {
                        req: Some(*req),
                        message: "authentication_denied: invalid daemon client identity"
                            .to_string(),
                    });
                    continue;
                }
                client_id = *authenticated_client_id;
                lock_state(&state).add_client(client_id, tx.clone());
                let _ = tx.send(DaemonToClient::Reply {
                    req: *req,
                    result: ReplyResult::Ok,
                });
                authenticated = true;
                continue;
            }
            _ if !authenticated => {
                let _ = tx.send(DaemonToClient::Error {
                    req: request_id(&msg),
                    message:
                        "authentication_required: authenticate before privileged daemon requests"
                            .to_string(),
                });
                continue;
            }
            _ => {}
        }

        let request_id = request_id(&msg);
        if let Err(err) = dispatch_message(
            Arc::clone(&state),
            &sessions_path,
            client_id,
            &tx,
            Arc::clone(&control),
            Arc::clone(&coordinator),
            Arc::clone(&worktree_registry),
            Arc::clone(&worktree_lifecycle),
            Arc::clone(&worktrees),
            Arc::clone(&automation),
            Arc::clone(&remote),
            computer.clone(),
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

    let lease_transitions = {
        let mut guard = lock_state(&state);
        guard.remove_client(client_id);
        guard.cleanup_remote_connection_leases(RemoteConnectionCleanupRequest {
            owner_connection_id: client_id,
        })
    };
    process_pane_lease_transitions(&state, lease_transitions);
    unregister_browser_host(client_id);
    drop(tx);
    if let Ok(writer_thread) = writer_thread {
        let _ = writer_thread.join();
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcIdRequest {
    id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MarkDispatchRunningRequest {
    identity: LifecycleIdentity,
    observed_at: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EventCatchupRequest {
    run_id: String,
    consumer_id: String,
    after_sequence: Option<u64>,
    #[serde(default = "default_event_page_size")]
    limit: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationCatchupRequest {
    #[serde(default)]
    after_sequence: u64,
    #[serde(default = "default_event_page_size")]
    limit: u32,
}

fn default_event_page_size() -> u32 {
    200
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestrationRpcEnvelope {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<OrchestrationRpcError>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OrchestrationRpcError {
    code: String,
    message: String,
}

fn orchestration_rpc_response(
    state: &SharedState,
    sessions_path: &Path,
    coordinator: &CoordinatorService,
    registry: &WorktreeRegistry,
    lifecycle: &WorktreeLifecycleService,
    worktrees: &WorktreeManager,
    operation_id: Uuid,
    method: &str,
    payload_json: &str,
) -> String {
    let result = dispatch_orchestration_rpc(
        state,
        sessions_path,
        coordinator,
        registry,
        lifecycle,
        worktrees,
        operation_id,
        method,
        payload_json,
    );
    let envelope = match result {
        Ok(data) => {
            if !orchestration_method_is_read_only(method) {
                notify_all_sessions_changed(state);
            }
            OrchestrationRpcEnvelope {
                ok: true,
                data: Some(data),
                error: None,
            }
        }
        Err(error) => OrchestrationRpcEnvelope {
            ok: false,
            data: None,
            error: Some(error),
        },
    };
    serde_json::to_string(&envelope).expect("serialize orchestration RPC envelope")
}

fn orchestration_method_is_read_only(method: &str) -> bool {
    matches!(
        method,
        "runs.list"
            | "run.get"
            | "tasks.list"
            | "dispatches.list"
            | "messages.list"
            | "gates.list"
            | "gate.get"
            | "merge.authorization"
            | "agents.list"
            | "events.catchup"
            | "notifications.catchup"
    )
}

fn dispatch_orchestration_rpc(
    state: &SharedState,
    sessions_path: &Path,
    coordinator: &CoordinatorService,
    registry: &WorktreeRegistry,
    lifecycle: &WorktreeLifecycleService,
    worktrees: &WorktreeManager,
    operation_id: Uuid,
    method: &str,
    payload_json: &str,
) -> std::result::Result<Value, OrchestrationRpcError> {
    macro_rules! mutation {
        ($request:ty, $method:ident) => {{
            let request: $request = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.$method(operation_id, request))
        }};
    }
    match method {
        "run.create" => mutation!(CreateRunRequest, create_run),
        "run.start" => mutation!(RunRevisionRequest, start_run),
        "run.cancel" => {
            let request: RunRevisionRequest = parse_orchestration_payload(payload_json)?;
            let current = coordinator
                .run(&request.run_id)
                .map_err(orchestration_coordinator_error)?;
            if current.status == crate::orchestration::RunStatus::Cancelled {
                let run = coordinator
                    .cancel_run(operation_id, request)
                    .map_err(orchestration_coordinator_error)?;
                let resources = coordinator
                    .cleanup_targets_for_run(&run.id)
                    .map_err(orchestration_coordinator_error)?
                    .into_iter()
                    .filter_map(|target| target.resources)
                    .collect::<Vec<_>>();
                return Ok(json!({ "run": run, "resources": resources, "cleanupErrors": [] }));
            }
            validate_run_cleanup_revision(
                coordinator,
                &request.run_id,
                request.expected_run_revision,
            )?;
            let (resources, cleanup_errors) =
                cleanup_run_resources(state, coordinator, worktrees, &request.run_id, "cancel")
                    .map_err(orchestration_internal_error)?;
            require_workers_stopped(&resources, &cleanup_errors)?;
            persist_state(state, sessions_path).map_err(orchestration_internal_error)?;
            let run = coordinator
                .cancel_run(operation_id, request)
                .map_err(orchestration_coordinator_error)?;
            Ok(json!({ "run": run, "resources": resources, "cleanupErrors": cleanup_errors }))
        }
        "run.accept" => {
            let request: RunDecisionRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.accept_run(operation_id, request))
        }
        "run.reject" => {
            let request: RunDecisionRequest = parse_orchestration_payload(payload_json)?;
            let current = coordinator
                .run(&request.run_id)
                .map_err(orchestration_coordinator_error)?;
            if current.status == crate::orchestration::RunStatus::Cancelled {
                let decision = coordinator
                    .reject_run(operation_id, request)
                    .map_err(orchestration_coordinator_error)?;
                let resources = coordinator
                    .cleanup_targets_for_run(&decision.run.id)
                    .map_err(orchestration_coordinator_error)?
                    .into_iter()
                    .filter_map(|target| target.resources)
                    .collect::<Vec<_>>();
                return Ok(
                    json!({ "decision": decision, "resources": resources, "cleanupErrors": [] }),
                );
            }
            validate_run_cleanup_revision(
                coordinator,
                &request.run_id,
                request.expected_run_revision,
            )?;
            let (resources, cleanup_errors) =
                cleanup_run_resources(state, coordinator, worktrees, &request.run_id, "reject")
                    .map_err(orchestration_internal_error)?;
            require_workers_stopped(&resources, &cleanup_errors)?;
            persist_state(state, sessions_path).map_err(orchestration_internal_error)?;
            let decision = coordinator
                .reject_run(operation_id, request)
                .map_err(orchestration_coordinator_error)?;
            Ok(
                json!({ "decision": decision, "resources": resources, "cleanupErrors": cleanup_errors }),
            )
        }
        "task.create" => mutation!(CreateTaskRequest, create_task),
        "task.update" => mutation!(UpdateTaskRequest, update_task),
        "task.retry" => mutation!(RetryTaskRequest, retry_task),
        "dispatch.launch" => {
            let request: DispatchLaunchRequest = parse_orchestration_payload(payload_json)?;
            let result = launch_ready_dispatches(
                state,
                sessions_path,
                coordinator,
                registry,
                lifecycle,
                worktrees,
                operation_id,
                request,
            )?;
            serde_json::to_value(result).map_err(|error| OrchestrationRpcError {
                code: "internal".to_string(),
                message: error.to_string(),
            })
        }
        "dispatch.cleanup" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            let target = coordinator
                .cleanup_target_for_dispatch(&request.id)
                .map_err(orchestration_coordinator_error)?;
            let retryable = target.resources.as_ref().is_some_and(|resource| {
                resource.pane_disposition == ResourceDisposition::CleanupFailed
                    || resource.worktree_disposition == ResourceDisposition::CleanupFailed
            });
            let already_clean = target.resources.as_ref().is_some_and(|resource| {
                matches!(
                    resource.pane_disposition,
                    ResourceDisposition::Cleaned | ResourceDisposition::NotCreated
                ) && matches!(
                    resource.worktree_disposition,
                    ResourceDisposition::Cleaned | ResourceDisposition::NotCreated
                )
            });
            if already_clean {
                return Ok(json!({
                    "resources": target.resources.into_iter().collect::<Vec<_>>(),
                    "cleanupErrors": [],
                }));
            }
            if !retryable {
                return Err(OrchestrationRpcError {
                    code: "invalid_transition".to_string(),
                    message: "Dispatch resources are not in a retryable cleanup-failure state."
                        .to_string(),
                });
            }
            let (resource, cleanup_errors) =
                cleanup_dispatch_target(state, coordinator, worktrees, &target, "retry_cleanup");
            let resources = resource.into_iter().collect::<Vec<_>>();
            require_workers_stopped(&resources, &cleanup_errors)?;
            persist_state(state, sessions_path).map_err(orchestration_internal_error)?;
            Ok(json!({ "resources": resources, "cleanupErrors": cleanup_errors }))
        }
        "agent.heartbeat" => mutation!(HeartbeatRequest, heartbeat),
        "agent.reconcile" => mutation!(ReconcileLivenessRequest, reconcile_liveness),
        "worker.done" => mutation!(WorkerDoneRequest, worker_done),
        "gate.create" => mutation!(CreateGateRequest, create_gate),
        "gate.resolve" => {
            let request: ResolveGateRequest = parse_orchestration_payload(payload_json)?;
            let prior_gate = coordinator
                .gate(&request.gate_id)
                .map_err(orchestration_coordinator_error)?;
            let mutation = if prior_gate.status == GateStatus::Pending {
                coordinator
                    .resolve_gate(operation_id, request.clone())
                    .map_err(orchestration_coordinator_error)?
            } else {
                let mut recorded_resolution = prior_gate.resolution.clone().unwrap_or(Value::Null);
                if let Some(object) = recorded_resolution.as_object_mut() {
                    object.remove("applied");
                }
                if recorded_resolution != request.resolution {
                    return Err(OrchestrationRpcError {
                        code: "conflict".to_string(),
                        message: "gate was already resolved with a different decision".to_string(),
                    });
                }
                let run = coordinator
                    .run(&prior_gate.run_id)
                    .map_err(orchestration_coordinator_error)?;
                let dispatch = prior_gate
                    .dispatch_id
                    .as_deref()
                    .map(|dispatch_id| {
                        coordinator
                            .dispatches(&prior_gate.run_id)
                            .map_err(orchestration_coordinator_error)?
                            .into_iter()
                            .find(|dispatch| dispatch.id == dispatch_id)
                            .ok_or_else(|| OrchestrationRpcError {
                                code: "not_found".to_string(),
                                message: format!("dispatch not found: {dispatch_id}"),
                            })
                    })
                    .transpose()?;
                GateMutationResult {
                    run,
                    gate: prior_gate,
                    dispatch,
                    cleanup_gate: None,
                }
            };
            let decision = mutation
                .gate
                .resolution
                .as_ref()
                .and_then(|value| value.get("decision"))
                .and_then(Value::as_str);
            if mutation.gate.gate_type != "cleanup" || decision != Some("approve") {
                return Ok(json!({
                    "mutation": mutation,
                    "resources": [],
                    "cleanupErrors": [],
                }));
            }
            let (mutation, resources, removal) = apply_approved_cleanup(
                state,
                sessions_path,
                coordinator,
                registry,
                lifecycle,
                worktrees,
                operation_id,
                mutation,
            )?;
            Ok(json!({
                "mutation": mutation,
                "resources": resources,
                "removal": removal,
                "cleanupErrors": [],
            }))
        }
        "merge.applied" => {
            let request: MergeAppliedRequest = parse_orchestration_payload(payload_json)?;
            coordinator
                .merge_authorization(&request.gate_id)
                .map_err(orchestration_coordinator_error)?;
            let mutation = coordinator
                .mark_merge_applied(operation_id, request)
                .map_err(orchestration_coordinator_error)?;
            let mut resources = Vec::new();
            let mut cleanup_errors = Vec::new();
            if let Some(dispatch_id) = mutation.gate.dispatch_id.as_deref() {
                let target = coordinator
                    .cleanup_target_for_dispatch(dispatch_id)
                    .map_err(orchestration_coordinator_error)?;
                let (resource, errors) = cleanup_dispatch_target(
                    state,
                    coordinator,
                    worktrees,
                    &target,
                    "merge_applied_worker_stop",
                );
                resources.extend(resource);
                cleanup_errors.extend(errors);
                persist_state(state, sessions_path).map_err(orchestration_internal_error)?;
            }
            Ok(json!({
                "mutation": mutation,
                "resources": resources,
                "cleanupErrors": cleanup_errors,
            }))
        }
        "message.post" => mutation!(PostMessageRequest, post_message),
        "events.acknowledge" => mutation!(AcknowledgeEventsRequest, acknowledge_events),
        "dispatch.running" => {
            let request: MarkDispatchRunningRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.mark_dispatch_running(
                operation_id,
                request.identity,
                request.observed_at,
            ))
        }
        "runs.list" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.runs_for_session(&request.id))
        }
        "run.get" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.run(&request.id))
        }
        "tasks.list" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.tasks(&request.id))
        }
        "dispatches.list" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.dispatches(&request.id))
        }
        "messages.list" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.messages(&request.id))
        }
        "gates.list" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.gates(&request.id))
        }
        "gate.get" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.gate(&request.id))
        }
        "merge.authorization" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.merge_authorization(&request.id))
        }
        "agents.list" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.agents(&request.id))
        }
        "events.catchup" => {
            let request: EventCatchupRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.events_after(
                &request.run_id,
                &request.consumer_id,
                request.after_sequence,
                request.limit,
            ))
        }
        "notifications.catchup" => {
            let request: NotificationCatchupRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(
                coordinator.notifications_after(request.after_sequence, request.limit),
            )
        }
        "notification.acknowledge" => {
            let request: RpcIdRequest = parse_orchestration_payload(payload_json)?;
            coordinator_value(coordinator.acknowledge_notification(operation_id, request.id))
        }
        _ => Err(OrchestrationRpcError {
            code: "method_not_found".to_string(),
            message: format!("unknown orchestration method: {method}"),
        }),
    }
}

fn apply_approved_cleanup(
    state: &SharedState,
    sessions_path: &Path,
    coordinator: &CoordinatorService,
    registry: &WorktreeRegistry,
    lifecycle: &WorktreeLifecycleService,
    worktrees: &WorktreeManager,
    operation_id: Uuid,
    mutation: GateMutationResult,
) -> std::result::Result<
    (
        GateMutationResult,
        Vec<DispatchResourceRecord>,
        Option<WorktreeRemovalResult>,
    ),
    OrchestrationRpcError,
> {
    if mutation
        .gate
        .resolution
        .as_ref()
        .and_then(|value| value.get("applied"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return Ok((mutation, Vec::new(), None));
    }
    let authorization = coordinator
        .cleanup_authorization(&mutation.gate.id)
        .map_err(orchestration_coordinator_error)?;
    let dispatch_id =
        mutation
            .gate
            .dispatch_id
            .as_deref()
            .ok_or_else(|| OrchestrationRpcError {
                code: "conflict".to_string(),
                message: "cleanup gate has no dispatch".to_string(),
            })?;
    let target = coordinator
        .cleanup_target_for_dispatch(dispatch_id)
        .map_err(orchestration_coordinator_error)?;
    let (resource, cleanup_errors) =
        cleanup_dispatch_target(state, coordinator, worktrees, &target, "cleanup_approved");
    let mut resources = resource.into_iter().collect::<Vec<_>>();
    require_workers_stopped(&resources, &cleanup_errors)?;
    persist_state(state, sessions_path).map_err(orchestration_internal_error)?;

    let worktree_id = authorization
        .worktree
        .worktree_id
        .as_deref()
        .ok_or_else(|| OrchestrationRpcError {
            code: "conflict".to_string(),
            message: "cleanup requires a stable worktree id".to_string(),
        })?;
    let expected_instance_id = authorization
        .worktree
        .instance_id
        .as_deref()
        .ok_or_else(|| OrchestrationRpcError {
            code: "conflict".to_string(),
            message: "cleanup requires an expected worktree instance id".to_string(),
        })?;
    let acknowledged_blockers = authorization
        .acknowledged_blockers
        .iter()
        .map(|blocker| {
            serde_json::from_value::<WorktreeBlockerKind>(Value::String(blocker.clone())).map_err(
                |error| OrchestrationRpcError {
                    code: "invalid_argument".to_string(),
                    message: format!("invalid cleanup blocker acknowledgement {blocker}: {error}"),
                },
            )
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let acknowledged_set = acknowledged_blockers
        .iter()
        .copied()
        .collect::<HashSet<_>>();
    if acknowledged_set.len() != acknowledged_blockers.len() {
        return Err(OrchestrationRpcError {
            code: "invalid_argument".to_string(),
            message: "cleanup blocker acknowledgements must not contain duplicates".to_string(),
        });
    }
    let preflight_request = WorktreeRemovalPreflightRequest {
        worktree_id: worktree_id.to_string(),
        delete_branch: authorization.delete_branch,
    };
    let runtime = worktree_runtime_blockers(state, registry, worktree_id)
        .map_err(orchestration_internal_error)?;
    let preflight = registry
        .removal_preflight(&preflight_request, runtime)
        .map_err(orchestration_internal_error)?;
    if authorization.delete_branch
        && preflight
            .blockers
            .iter()
            .any(|blocker| blocker.kind == WorktreeBlockerKind::Unpushed)
    {
        return Err(OrchestrationRpcError {
            code: "conflict".to_string(),
            message: "cleanup will not delete an unpushed branch; approve cleanup with deleteBranch false"
                .to_string(),
        });
    }
    let expected_acknowledgements = if authorization.force {
        preflight
            .blockers
            .iter()
            .filter(|blocker| !blocker.hard)
            .map(|blocker| blocker.kind)
            .collect::<HashSet<_>>()
    } else {
        HashSet::new()
    };
    if acknowledged_set != expected_acknowledgements {
        return Err(OrchestrationRpcError {
            code: "conflict".to_string(),
            message: "cleanup blocker acknowledgements do not exactly match current preflight"
                .to_string(),
        });
    }
    let remove_operation_id = derived_operation_id(operation_id, dispatch_id, "worktree-remove");
    let remove_request = WorktreeRemoveRequest {
        operation_id: remove_operation_id,
        worktree_id: worktree_id.to_string(),
        expected_instance_id: expected_instance_id.to_string(),
        force: authorization.force,
        delete_branch: authorization.delete_branch,
        provider_merged_head: None,
        acknowledged_blockers,
    };
    let removal: WorktreeRemovalResult = serde_json::from_value(
        dispatch_worktree_request(
            state,
            registry,
            lifecycle,
            sessions_path,
            remove_operation_id,
            WORKTREE_METHOD_REMOVE,
            &serde_json::to_string(&remove_request)
                .map_err(|error| orchestration_internal_error(error.into()))?,
        )
        .map_err(orchestration_internal_error)?,
    )
    .map_err(|error| orchestration_internal_error(error.into()))?;
    let resource = coordinator
        .mark_dispatch_resource_disposition(
            dispatch_id,
            None,
            Some(ResourceDisposition::Cleaned),
            false,
            true,
            Some("cleanup_approved"),
            None,
        )
        .map_err(orchestration_coordinator_error)?;
    resources.clear();
    resources.push(resource);
    let mutation = coordinator
        .mark_cleanup_applied(
            derived_operation_id(operation_id, dispatch_id, "cleanup-applied"),
            CleanupAppliedRequest {
                gate_id: mutation.gate.id,
                expected_run_revision: mutation.run.revision,
            },
        )
        .map_err(orchestration_coordinator_error)?;
    Ok((mutation, resources, Some(removal)))
}

fn parse_orchestration_payload<T: for<'de> Deserialize<'de>>(
    payload_json: &str,
) -> std::result::Result<T, OrchestrationRpcError> {
    serde_json::from_str(payload_json).map_err(|error| OrchestrationRpcError {
        code: "invalid_argument".to_string(),
        message: error.to_string(),
    })
}

fn coordinator_value<T: Serialize>(
    result: std::result::Result<T, CoordinatorError>,
) -> std::result::Result<Value, OrchestrationRpcError> {
    let value = result.map_err(|error| OrchestrationRpcError {
        code: error.code().to_string(),
        message: error.to_string(),
    })?;
    serde_json::to_value(value).map_err(|error| OrchestrationRpcError {
        code: "internal".to_string(),
        message: error.to_string(),
    })
}

fn orchestration_internal_error(error: anyhow::Error) -> OrchestrationRpcError {
    OrchestrationRpcError {
        code: "internal".to_string(),
        message: bounded_launch_error(&error.to_string()),
    }
}

fn validate_run_cleanup_revision(
    coordinator: &CoordinatorService,
    run_id: &str,
    expected_revision: u64,
) -> std::result::Result<(), OrchestrationRpcError> {
    let run = coordinator
        .run(run_id)
        .map_err(orchestration_coordinator_error)?;
    if run.revision != expected_revision {
        return Err(OrchestrationRpcError {
            code: "stale_revision".to_string(),
            message: format!(
                "stale revision for run {}: expected {}, current {}",
                run.id, expected_revision, run.revision
            ),
        });
    }
    Ok(())
}

fn require_workers_stopped(
    resources: &[DispatchResourceRecord],
    cleanup_errors: &[String],
) -> std::result::Result<(), OrchestrationRpcError> {
    let workers_running = resources.iter().any(|resource| {
        matches!(
            resource.pane_disposition,
            ResourceDisposition::Live
                | ResourceDisposition::Retained
                | ResourceDisposition::CleanupFailed
                | ResourceDisposition::Unknown
        )
    });
    if workers_running {
        return Err(OrchestrationRpcError {
            code: "cleanup_failed".to_string(),
            message: if cleanup_errors.is_empty() {
                "One or more orchestration workers could not be proven stopped.".to_string()
            } else {
                bounded_launch_error(&cleanup_errors.join("; "))
            },
        });
    }
    Ok(())
}

fn derived_operation_id(operation_id: Uuid, dispatch_id: &str, stage: &str) -> Uuid {
    use sha2::{Digest, Sha256};
    let mut digest = Sha256::new();
    digest.update(operation_id.as_bytes());
    digest.update(dispatch_id.as_bytes());
    digest.update(stage.as_bytes());
    let bytes = digest.finalize();
    let mut uuid_bytes = [0_u8; 16];
    uuid_bytes.copy_from_slice(&bytes[..16]);
    uuid_bytes[6] = (uuid_bytes[6] & 0x0f) | 0x40;
    uuid_bytes[8] = (uuid_bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(uuid_bytes)
}

fn launch_ready_dispatches(
    state: &SharedState,
    sessions_path: &Path,
    coordinator: &CoordinatorService,
    registry: &WorktreeRegistry,
    lifecycle: &WorktreeLifecycleService,
    worktrees: &WorktreeManager,
    operation_id: Uuid,
    mut request: DispatchLaunchRequest,
) -> std::result::Result<DispatchLaunchResult, OrchestrationRpcError> {
    let _launch = ORCHESTRATION_LAUNCH_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    request.command = request.command.trim().to_string();
    request.profile = request.profile.take().and_then(|profile| {
        let profile = profile.trim().to_string();
        (!profile.is_empty()).then_some(profile)
    });
    let plan = match coordinator
        .prepare_dispatch_launch(operation_id, request.clone())
        .map_err(orchestration_coordinator_error)?
    {
        DispatchLaunchPreparation::Replay(result) => return Ok(result),
        DispatchLaunchPreparation::Intent(plan) => plan,
    };
    let parent_session_id =
        Uuid::parse_str(&plan.run.session_id).map_err(|error| OrchestrationRpcError {
            code: "internal".to_string(),
            message: format!("run session identity is invalid: {error}"),
        })?;
    let workspace = automation_workspace(state, &plan.run.session_id)
        .map_err(|error| bounded_launch_error(&error.to_string()));
    let tasks = coordinator
        .tasks(&request.run_id)
        .map_err(orchestration_coordinator_error)?;
    let mut launches = Vec::with_capacity(plan.dispatches.len());
    let mut spawned_any = false;

    for planned in plan.dispatches {
        let current = coordinator
            .dispatches(&request.run_id)
            .map_err(orchestration_coordinator_error)?
            .into_iter()
            .find(|dispatch| dispatch.id == planned.id)
            .unwrap_or(planned);
        if current.status != DispatchStatus::Pending {
            let agents = coordinator
                .agents(&request.run_id)
                .map_err(orchestration_coordinator_error)?;
            launches.push(existing_launch_outcome(&current, &agents));
            continue;
        }
        let Some(task) = tasks.iter().find(|task| task.id == current.task_id) else {
            launches.push(DispatchLaunchOutcome {
                dispatch_id: current.id,
                task_id: current.task_id,
                attempt: current.attempt,
                status: DispatchLaunchStatus::Failed,
                agent_instance_id: None,
                pane_id: None,
                runtime_identity: None,
                process_generation: None,
                worktree: None,
                resources: current.resources,
                failure_code: Some("task_missing".to_string()),
                error: Some("The dispatch task record is unavailable.".to_string()),
            });
            continue;
        };

        let spec = coordinator
            .dispatch_launch_spec(&current.id, operation_id)
            .map_err(orchestration_coordinator_error)?;
        let mut agent_instance_id = current.agent_instance_id.clone();
        let mut durably_bound = false;
        let mut failure_code = "workspace_unavailable";
        let launch = (|| -> Result<DispatchLaunchOutcome> {
            let workspace = workspace
                .as_ref()
                .map_err(|message| anyhow::anyhow!(message.clone()))?
                .canonicalize()
                .context("canonicalize orchestration workspace authority")?;
            let resolved_authority = worktrees.authority(&workspace)?;
            let (authority, mut planned_worktree) = if spec.worktree_mode == WorktreeMode::Worktree
            {
                failure_code = "worktree_authority";
                let mut assignment = current
                    .resources
                    .as_ref()
                    .and_then(|resource| resource.worktree.clone())
                    .unwrap_or(worktrees.plan(
                        &resolved_authority,
                        &request.run_id,
                        &task.id,
                        current.attempt,
                    )?);
                if assignment.base_revision.trim().is_empty() {
                    assignment.base_revision =
                        exact_worktree_base_snapshot(&resolved_authority.repository_root)?;
                }
                (Some(resolved_authority), Some(assignment))
            } else {
                (None, None)
            };

            let mut dispatch_session_id = parent_session_id;
            if let (Some(authority), Some(assignment)) =
                (authority.as_ref(), planned_worktree.as_ref())
            {
                failure_code = "worktree_create";
                if assignment.worktree_id.is_none() || assignment.instance_id.is_none() {
                    let create_operation_id =
                        derived_operation_id(operation_id, &current.id, "worktree-create");
                    let create_request = WorktreeCreateRequest {
                        operation_id: create_operation_id,
                        repository_path: authority.repository_root_string(),
                        parent_session_id: parent_session_id.to_string(),
                        parent_worktree_id: None,
                        name: format!(
                            "run-{}-task-{}",
                            short_identity(&request.run_id),
                            short_identity(&task.id)
                        ),
                        start_ref: assignment.base_revision.clone(),
                        branch: Some(assignment.branch.clone()),
                        storage: WorktreeStorage {
                            mode: WorktreeStorageMode::Custom,
                            drive: String::new(),
                            folder_name: String::new(),
                            custom_root: worktrees.root().to_string_lossy().to_string(),
                            group_by_repository: false,
                        },
                        fetch: false,
                        setup_policy: "skip".to_string(),
                        sparse_preset: None,
                        linked_files: Vec::new(),
                        profile_id: spec.profile.clone(),
                        initial_agent: None,
                        initial_prompt: Some(task.description.clone()),
                        origin: WorktreeOrigin::Orchestration,
                    };
                    let created: WorktreeCreateResult =
                        serde_json::from_value(dispatch_worktree_request(
                            state,
                            registry,
                            lifecycle,
                            sessions_path,
                            create_operation_id,
                            WORKTREE_METHOD_CREATE,
                            &serde_json::to_string(&create_request)?,
                        )?)?;
                    dispatch_session_id = Uuid::parse_str(&created.session_id)
                        .context("parse created worktree session id")?;
                    planned_worktree = Some(WorktreeAssignment {
                        worktree_id: Some(created.worktree.id),
                        instance_id: Some(created.worktree.instance_id),
                        base_revision: assignment.base_revision.clone(),
                        branch: created.worktree.branch,
                        worktree_path: created.worktree.worktree_path,
                    });
                } else if let Some(resource) = current.resources.as_ref() {
                    dispatch_session_id = Uuid::parse_str(&resource.session_id)
                        .context("parse persisted dispatch session id")?;
                }
            }

            let cwd = if let (Some(authority), Some(assignment)) =
                (authority.as_ref(), planned_worktree.as_ref())
            {
                worktrees
                    .launch_path(authority, assignment)?
                    .to_string_lossy()
                    .to_string()
            } else {
                workspace.to_string_lossy().to_string()
            };
            let mut resource = coordinator
                .reserve_dispatch_resources(
                    operation_id,
                    DispatchResourceReservation {
                        dispatch_id: current.id.clone(),
                        session_id: dispatch_session_id.to_string(),
                        repository_root: authority
                            .as_ref()
                            .map(|value| value.repository_root_string()),
                        relative_prefix: authority
                            .as_ref()
                            .map(|value| value.relative_prefix_string())
                            .unwrap_or_default(),
                        launch_path: Some(cwd.clone()),
                        worktree: planned_worktree.clone(),
                    },
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if matches!(
                resource.pane_disposition,
                ResourceDisposition::CleanupFailed | ResourceDisposition::Unknown
            ) || resource.worktree_disposition == ResourceDisposition::CleanupFailed
            {
                failure_code = "cleanup_pending";
                anyhow::bail!(
                    "prior dispatch resources require successful cleanup before relaunch"
                );
            }
            if let Some(assignment) = planned_worktree.as_ref() {
                resource = coordinator
                    .update_dispatch_worktree(&current.id, operation_id, assignment)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
                resource = coordinator
                    .mark_dispatch_resource_disposition(
                        &current.id,
                        None,
                        Some(ResourceDisposition::Live),
                        false,
                        false,
                        None,
                        None,
                    )
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            }

            failure_code = "agent_register";
            let agent = coordinator
                .register_agent(
                    derived_operation_id(operation_id, &current.id, "agent-register"),
                    RegisterAgentRequest {
                        provider: AgentProvider::PtyCli,
                        profile: spec.profile.clone(),
                        workspace_path: workspace.to_string_lossy().to_string(),
                        worktree_path: planned_worktree
                            .as_ref()
                            .map(|assignment| assignment.worktree_path.clone()),
                        resumable: false,
                    },
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            agent_instance_id = Some(agent.id.clone());
            resource = coordinator
                .record_dispatch_agent_resource(&current.id, operation_id, &agent.id)
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;

            failure_code = "pane_spawn";
            let next_pane_id = derived_operation_id(operation_id, &current.id, "pane");
            resource = coordinator
                .record_dispatch_pane_resource(
                    &current.id,
                    operation_id,
                    &next_pane_id.to_string(),
                    None,
                    None,
                    1,
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            let capsule = orchestration_context_capsule(
                &plan.run,
                task,
                &tasks,
                &current.id,
                &agent.id,
                &next_pane_id.to_string(),
                &parent_session_id.to_string(),
                &dispatch_session_id.to_string(),
                authority
                    .as_ref()
                    .map(|value| value.repository_root_string())
                    .as_deref(),
                authority
                    .as_ref()
                    .map(|value| value.relative_prefix_string())
                    .as_deref(),
                planned_worktree.as_ref(),
                &coordinator
                    .gates(&request.run_id)
                    .map_err(|error| anyhow::anyhow!(error.to_string()))?,
            )?;
            let context_capsule_path = write_orchestration_context_capsule(
                worktrees.root(),
                &current.id,
                operation_id,
                &capsule,
            )?;
            let existing_pane = lock_state(state)
                .pane_metas(dispatch_session_id)?
                .into_iter()
                .find(|pane| pane.id == next_pane_id && pane.alive);
            let pane = if let Some(pane) = existing_pane {
                pane
            } else {
                spawned_any = true;
                spawn_orchestration_pane_for_session(
                    Arc::clone(state),
                    sessions_path.to_path_buf(),
                    dispatch_session_id,
                    PaneConfig {
                        pane_id: next_pane_id,
                        shell: Some("cmd.exe".to_string()),
                        args: vec![
                            "/D".to_string(),
                            "/S".to_string(),
                            "/C".to_string(),
                            spec.command.clone(),
                        ],
                        cwd: Some(cwd),
                        env: vec![
                            ("VIBELINK_RUN_ID".to_string(), request.run_id.clone()),
                            ("VIBELINK_TASK_ID".to_string(), task.id.clone()),
                            ("VIBELINK_DISPATCH_ID".to_string(), current.id.clone()),
                            ("VIBELINK_AGENT_INSTANCE_ID".to_string(), agent.id.clone()),
                            (
                                "VIBELINK_SESSION_ID".to_string(),
                                dispatch_session_id.to_string(),
                            ),
                            (
                                "VIBELINK_CONTEXT_CAPSULE_PATH".to_string(),
                                context_capsule_path,
                            ),
                        ],
                        title: Some(task.title.clone()),
                        icon: Some("bot".to_string()),
                        profile_id: spec.profile.clone(),
                        role: Some("orchestration-worker".to_string()),
                        restore_on_start: false,
                        cols: 120,
                        rows: 32,
                    },
                    Arc::new(coordinator.clone()),
                )?
            };
            let root_pid = lock_state(state)
                .resource_targets()
                .into_iter()
                .find(|(owner_session, pane_id, _)| {
                    *owner_session == dispatch_session_id && *pane_id == pane.id
                })
                .and_then(|(_, _, root_pid)| root_pid)
                .context("orchestration pane has no project-owned root process identity")?;
            let started_at = process_start_time(root_pid)
                .context("orchestration pane root process exited before identity capture")?;
            let process_generation = 1;
            resource = coordinator
                .record_dispatch_pane_resource(
                    &current.id,
                    operation_id,
                    &pane.id.to_string(),
                    Some(root_pid),
                    Some(started_at),
                    process_generation,
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            if !lock_state(state)
                .pane_metas(dispatch_session_id)?
                .into_iter()
                .any(|current_pane| current_pane.id == pane.id && current_pane.alive)
            {
                anyhow::bail!("orchestration pane exited before durable binding");
            }
            let runtime_identity = format!("pane:{}:{process_generation}", pane.id);

            failure_code = "dispatch_bind";
            let bound = coordinator
                .bind_dispatch(
                    derived_operation_id(operation_id, &current.id, "dispatch-bind"),
                    BindDispatchRequest {
                        dispatch_id: current.id.clone(),
                        expected_task_revision: task.revision,
                        agent_instance_id: agent.id.clone(),
                        runtime_identity,
                        pane_id: Some(pane.id.to_string()),
                        process_generation,
                        worktree: planned_worktree,
                    },
                )
                .map_err(|error| anyhow::anyhow!(error.to_string()))?;
            durably_bound = true;
            Ok(DispatchLaunchOutcome {
                dispatch_id: bound.dispatch.id,
                task_id: bound.task.id,
                attempt: bound.dispatch.attempt,
                status: DispatchLaunchStatus::Launched,
                agent_instance_id: Some(bound.agent.id),
                pane_id: bound.dispatch.pane_id,
                runtime_identity: bound.agent.runtime_identity,
                process_generation: bound.dispatch.process_generation,
                worktree: bound.dispatch.worktree,
                resources: Some(resource),
                failure_code: None,
                error: None,
            })
        })();

        match launch {
            Ok(outcome) => launches.push(outcome),
            Err(error) => {
                let mut details = bounded_launch_error(&error.to_string());
                let mut resource = coordinator
                    .cleanup_target_for_dispatch(&current.id)
                    .ok()
                    .and_then(|target| target.resources);
                if !durably_bound {
                    if let Ok(target) = coordinator.cleanup_target_for_dispatch(&current.id) {
                        let (cleaned, cleanup_errors) = cleanup_dispatch_target(
                            state,
                            coordinator,
                            worktrees,
                            &target,
                            "launch_failure",
                        );
                        resource = cleaned;
                        if !cleanup_errors.is_empty() {
                            details.push_str("; ");
                            details.push_str(&bounded_launch_error(&cleanup_errors.join("; ")));
                        }
                    }
                }
                let recorded = coordinator.record_launch_failure(
                    derived_operation_id(operation_id, &current.id, "launch-failure"),
                    LaunchFailureRequest {
                        dispatch_id: current.id.clone(),
                        expected_task_revision: task.revision,
                        failure_code: failure_code.to_string(),
                    },
                );
                let stored_failure = match recorded {
                    Ok(result) => result.dispatch.failure_code,
                    Err(record_error) => {
                        details.push_str("; failure recording failed: ");
                        details.push_str(&bounded_launch_error(&record_error.to_string()));
                        Some(format!("launch:{failure_code}"))
                    }
                };
                if let Some(agent_id) = agent_instance_id.as_ref() {
                    if let Err(agent_error) = coordinator.record_unbound_agent_launch_failure(
                        derived_operation_id(operation_id, &current.id, "agent-launch-failure"),
                        AgentLaunchFailureRequest {
                            agent_instance_id: agent_id.clone(),
                            failure_code: failure_code.to_string(),
                        },
                    ) {
                        details.push_str("; agent cleanup failed: ");
                        details.push_str(&bounded_launch_error(&agent_error.to_string()));
                    }
                }
                let pane_retained = resource
                    .as_ref()
                    .is_some_and(|value| value.pane_disposition != ResourceDisposition::Cleaned);
                let worktree_retained = resource.as_ref().is_some_and(|value| {
                    !matches!(
                        value.worktree_disposition,
                        ResourceDisposition::Cleaned | ResourceDisposition::NotCreated
                    )
                });
                launches.push(DispatchLaunchOutcome {
                    dispatch_id: current.id,
                    task_id: current.task_id,
                    attempt: current.attempt,
                    status: DispatchLaunchStatus::Failed,
                    agent_instance_id: if pane_retained {
                        agent_instance_id
                    } else {
                        None
                    },
                    pane_id: resource
                        .as_ref()
                        .filter(|_| pane_retained)
                        .and_then(|value| value.pane_id.clone()),
                    runtime_identity: None,
                    process_generation: resource
                        .as_ref()
                        .filter(|_| pane_retained)
                        .and_then(|value| value.process_generation),
                    worktree: if worktree_retained {
                        resource.as_ref().and_then(|value| value.worktree.clone())
                    } else {
                        None
                    },
                    resources: resource,
                    failure_code: stored_failure,
                    error: Some(bounded_launch_error(&details)),
                });
            }
        }
    }

    persist_state(state, sessions_path).map_err(|error| OrchestrationRpcError {
        code: "internal".to_string(),
        message: error.to_string(),
    })?;
    if spawned_any {
        notify_all_sessions_changed(state);
    }
    let result = DispatchLaunchResult {
        run: coordinator
            .run(&request.run_id)
            .map_err(orchestration_coordinator_error)?,
        launches,
        newly_ready_task_ids: plan.newly_ready_task_ids,
        newly_blocked_task_ids: plan.newly_blocked_task_ids,
    };
    coordinator
        .complete_dispatch_launch(operation_id, &request, &result)
        .map_err(orchestration_coordinator_error)
}
const ORCHESTRATION_CONTEXT_CAPSULE_MAX_BYTES: usize = 16 * 1024;
fn exact_worktree_base_snapshot(repository: &Path) -> Result<String> {
    let run = |arguments: &[&str]| -> Result<String> {
        let output = Command::new("git")
            .args(arguments)
            .current_dir(repository)
            .output()
            .with_context(|| format!("run git {}", arguments.join(" ")))?;
        if !output.status.success() {
            anyhow::bail!(
                "git {} failed: {}",
                arguments.join(" "),
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    };
    let snapshot = run(&["stash", "create"])?;
    if snapshot.is_empty() {
        run(&["rev-parse", "HEAD"])
    } else {
        Ok(snapshot)
    }
}

fn short_identity(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .take(8)
        .collect()
}

fn bounded_context_text(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect()
}

fn orchestration_context_capsule(
    run: &crate::orchestration::RunRecord,
    task: &crate::orchestration::TaskRecord,
    tasks: &[crate::orchestration::TaskRecord],
    dispatch_id: &str,
    agent_instance_id: &str,
    pane_id: &str,
    parent_session_id: &str,
    session_id: &str,
    repository_root: Option<&str>,
    relative_prefix: Option<&str>,
    worktree: Option<&WorktreeAssignment>,
    gates: &[crate::orchestration::DecisionGateRecord],
) -> Result<String> {
    let dependency_results = task
        .dependencies
        .iter()
        .filter_map(|dependency_id| {
            tasks
                .iter()
                .find(|candidate| candidate.id == *dependency_id)
        })
        .take(8)
        .map(|dependency| {
            json!({
                "taskId": dependency.id,
                "status": dependency.status,
                "result": dependency.result.as_ref().map(|result| {
                    bounded_context_text(&result.to_string(), 512)
                }),
            })
        })
        .collect::<Vec<_>>();
    let gate_state = gates
        .iter()
        .filter(|gate| {
            gate.task_id.as_deref() == Some(task.id.as_str()) || gate.dispatch_id.is_none()
        })
        .take(16)
        .map(|gate| {
            json!({
                "gateId": gate.id,
                "gateType": gate.gate_type,
                "status": gate.status,
            })
        })
        .collect::<Vec<_>>();
    let repository_rules = worktree
        .map(|assignment| Path::new(&assignment.worktree_path))
        .into_iter()
        .flat_map(|root| {
            ["AGENTS.md", "docs/KNOWHOW.md", "PROJECT_MEMORY.md"]
                .into_iter()
                .map(move |relative| (root, relative))
        })
        .filter(|(root, relative)| root.join(relative).is_file())
        .map(|(_, relative)| relative.to_string())
        .collect::<Vec<_>>();
    let memory_references = repository_rules
        .iter()
        .filter(|path| path.contains("MEMORY") || path.contains("KNOWHOW"))
        .cloned()
        .collect::<Vec<_>>();
    let capsule = json!({
        "schemaVersion": 1,
        "identity": {
            "runId": run.id,
            "taskId": task.id,
            "dispatchId": dispatch_id,
            "agentInstanceId": agent_instance_id,
            "paneId": pane_id,
            "parentSessionId": parent_session_id,
            "sessionId": session_id,
        },
        "objective": {
            "rootRequest": bounded_context_text(&run.goal, 2_000),
            "title": bounded_context_text(&task.title, 512),
            "description": bounded_context_text(&task.description, 4_000),
        },
        "dependencies": task.dependencies,
        "dependencyResults": dependency_results,
        "repository": {
            "root": repository_root,
            "relativePrefix": relative_prefix,
            "rules": repository_rules,
            "memoryReferences": memory_references,
        },
        "gateState": gate_state,
        "refs": worktree.map(|assignment| json!({
            "worktreeId": assignment.worktree_id,
            "instanceId": assignment.instance_id,
            "baseSha": assignment.base_revision,
            "branch": assignment.branch,
            "worktreePath": assignment.worktree_path,
        })),
        "allowedScope": {
            "taskId": task.id,
            "relativePrefix": relative_prefix,
            "files": [],
        },
        "commands": {
            "progress": "vibelink orchestration send --run-id <run-id> --task-id <task-id> --message <text>",
            "completionFields": ["files", "tests", "commit", "checkpoint", "result"],
        },
        "workerContract": {
            "mayMerge": false,
            "mayDeleteBranch": false,
            "mayDeleteCheckout": false,
            "mayRecursivelyCleanPath": false,
        },
    });
    let serialized = serde_json::to_string(&capsule)?;
    if serialized.len() > ORCHESTRATION_CONTEXT_CAPSULE_MAX_BYTES {
        anyhow::bail!(
            "bounded orchestration context capsule exceeded {} bytes",
            ORCHESTRATION_CONTEXT_CAPSULE_MAX_BYTES
        );
    }
    Ok(serialized)
}

fn write_orchestration_context_capsule(
    worktree_root: &Path,
    dispatch_id: &str,
    operation_id: Uuid,
    content: &str,
) -> Result<String> {
    let artifact_root = worktree_root
        .parent()
        .unwrap_or(worktree_root)
        .join("context-capsules");
    fs::create_dir_all(&artifact_root)
        .with_context(|| format!("create context capsule root {}", artifact_root.display()))?;
    let path = artifact_root.join(format!(
        "{}-{}.json",
        short_identity(dispatch_id),
        operation_id.simple()
    ));
    if path.exists() {
        return Ok(path.to_string_lossy().to_string());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .with_context(|| format!("create context capsule {}", path.display()))?;
    file.write_all(content.as_bytes())
        .with_context(|| format!("write context capsule {}", path.display()))?;
    file.flush()
        .with_context(|| format!("flush context capsule {}", path.display()))?;
    Ok(path.to_string_lossy().to_string())
}

fn existing_launch_outcome(
    dispatch: &crate::orchestration::DispatchRecord,
    agents: &[crate::orchestration::AgentInstanceRecord],
) -> DispatchLaunchOutcome {
    let agent = dispatch
        .agent_instance_id
        .as_deref()
        .and_then(|agent_id| agents.iter().find(|agent| agent.id == agent_id));
    let pane_live = dispatch.resources.as_ref().is_some_and(|resource| {
        resource.pane_disposition == ResourceDisposition::Live && resource.pane_id.is_some()
    });
    let has_identity = dispatch.agent_instance_id.is_some()
        && (pane_live || dispatch.status == DispatchStatus::Completed);
    let status = if has_identity
        && matches!(
            dispatch.status,
            DispatchStatus::Dispatched
                | DispatchStatus::Running
                | DispatchStatus::Waiting
                | DispatchStatus::Completed
        ) {
        DispatchLaunchStatus::Existing
    } else {
        DispatchLaunchStatus::Failed
    };
    let worktree_live = dispatch.resources.as_ref().is_some_and(|resource| {
        matches!(
            resource.worktree_disposition,
            ResourceDisposition::Live
                | ResourceDisposition::Retained
                | ResourceDisposition::CleanupFailed
        )
    });
    DispatchLaunchOutcome {
        dispatch_id: dispatch.id.clone(),
        task_id: dispatch.task_id.clone(),
        attempt: dispatch.attempt,
        status,
        agent_instance_id: (status == DispatchLaunchStatus::Existing)
            .then(|| dispatch.agent_instance_id.clone())
            .flatten(),
        pane_id: dispatch
            .resources
            .as_ref()
            .filter(|_| pane_live)
            .and_then(|resource| resource.pane_id.clone()),
        runtime_identity: (status == DispatchLaunchStatus::Existing)
            .then(|| agent.and_then(|record| record.runtime_identity.clone()))
            .flatten(),
        process_generation: pane_live.then_some(dispatch.process_generation).flatten(),
        worktree: worktree_live.then(|| dispatch.worktree.clone()).flatten(),
        resources: dispatch.resources.clone(),
        failure_code: dispatch.failure_code.clone().or_else(|| {
            (status == DispatchLaunchStatus::Failed)
                .then(|| "launch_state_inconsistent".to_string())
        }),
        error: None,
    }
}

fn orchestration_coordinator_error(error: CoordinatorError) -> OrchestrationRpcError {
    OrchestrationRpcError {
        code: error.code().to_string(),
        message: error.to_string(),
    }
}

fn bounded_launch_error(message: &str) -> String {
    message.chars().take(1_000).collect()
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliRequestEnvelope {
    kind: String,
    request: CliControlRequest,
}

fn dispatch_cli_request(
    state: &SharedState,
    sessions_path: &Path,
    control: &ControlPlane,
    worktree_registry: &WorktreeRegistry,
    worktree_lifecycle: &WorktreeLifecycleService,
    coordinator: &CoordinatorService,
    worktrees: &WorktreeManager,
    automation: &AutomationService,
    remote: &RemoteServer,
    computer: &SharedComputerHost,
    outer_operation_id: Uuid,
    request_json: &str,
) -> Result<Value> {
    let envelope: CliRequestEnvelope =
        serde_json::from_str(request_json).context("parse dedicated CLI request")?;
    if envelope.kind != "cli" || envelope.request.schema_version != 1 {
        anyhow::bail!("invalid dedicated CLI request schema");
    }
    if envelope.request.operation_id != outer_operation_id {
        anyhow::bail!("conflict: inner and outer operation ids differ");
    }
    let expected_revision = envelope.request.expected_revision;
    let caller_cwd = envelope.request.caller_cwd.clone();
    match envelope.request.command {
        DedicatedCommand::Status => Ok(serde_json::json!({ "state": "running" })),
        DedicatedCommand::Workspace(command) => match command.action {
            WorkspaceAction::List => Ok(serde_json::to_value(lock_state(state).list_sessions())?),
            WorkspaceAction::Show => {
                let session_id =
                    resolve_cli_session(state, command.selectors.workspace.as_deref())?;
                let session = lock_state(state)
                    .list_sessions()
                    .into_iter()
                    .find(|session| session.id == session_id)
                    .context("workspace not found")?;
                Ok(serde_json::to_value(session)?)
            }
            WorkspaceAction::Create => {
                let name = required_cli_option(&command.arguments, "name")?.to_string();
                let workspace_folder =
                    cli_option(&command.arguments, "folder")?.map(str::to_string);
                let session = lock_state(state).create_session(name, workspace_folder);
                persist_state(state, sessions_path)?;
                Ok(serde_json::to_value(session)?)
            }
            WorkspaceAction::Delete => {
                let session_id =
                    resolve_cli_session(state, command.selectors.workspace.as_deref())?;
                let (mut panes, lease_transitions) = {
                    let mut guard = lock_state(state);
                    let panes = guard.delete_session(session_id)?;
                    let lease_transitions =
                        guard.cleanup_remote_pane_leases_on_exit(panes.iter().map(|pane| pane.id));
                    (panes, lease_transitions)
                };
                process_pane_lease_transitions(state, lease_transitions);
                persist_state(state, sessions_path)?;
                for pane in &mut panes {
                    pane.kill()?;
                }
                if let Err(error) = remove_session_history(sessions_path, session_id) {
                    warn!(?error, %session_id, "failed to remove deleted workspace history");
                }
                Ok(serde_json::json!({ "deleted": session_id }))
            }
            WorkspaceAction::Open => {
                let session_id =
                    resolve_cli_session(state, command.selectors.workspace.as_deref())?;
                let (session, senders) = {
                    let state = lock_state(state);
                    let session = state
                        .list_sessions()
                        .into_iter()
                        .find(|session| session.id == session_id)
                        .context("workspace not found")?;
                    (session, state.all_senders())
                };
                for sender in senders {
                    let _ = sender.send(DaemonToClient::SessionChanged { session_id });
                }
                Ok(
                    json!({ "workspace": session, "lifecycle": if lock_state(state).session_sleeping(session_id)? { "sleeping" } else { "awake" }, "openRequested": true }),
                )
            }
            WorkspaceAction::Sleep => {
                let session_id =
                    resolve_cli_session(state, command.selectors.workspace.as_deref())?;
                let (mut panes, senders, lease_transitions) = {
                    let mut state = lock_state(state);
                    let panes = state.sleep_session(session_id)?;
                    let lease_transitions =
                        state.cleanup_remote_pane_leases_on_exit(panes.iter().map(|pane| pane.id));
                    (panes, state.all_senders(), lease_transitions)
                };
                process_pane_lease_transitions(state, lease_transitions);
                for pane in &mut panes {
                    let pane_id = pane.id;
                    pane.kill()?;
                    if let Err(error) = remove_pane_history(sessions_path, session_id, pane_id) {
                        warn!(?error, %pane_id, "failed to remove sleeping pane history");
                    }
                }
                if let Err(error) = remove_session_history(sessions_path, session_id) {
                    warn!(?error, %session_id, "failed to remove sleeping workspace history");
                }
                persist_state(state, sessions_path)?;
                for sender in senders {
                    let _ = sender.send(DaemonToClient::SessionChanged { session_id });
                }
                Ok(
                    json!({ "workspaceId": session_id, "lifecycle": "sleeping", "stoppedPanes": panes.len() }),
                )
            }
            WorkspaceAction::Wake => {
                let session_id =
                    resolve_cli_session(state, command.selectors.workspace.as_deref())?;
                let senders = {
                    let mut state = lock_state(state);
                    state.wake_session(session_id)?;
                    state.all_senders()
                };
                persist_state(state, sessions_path)?;
                for sender in senders {
                    let _ = sender.send(DaemonToClient::SessionChanged { session_id });
                }
                Ok(json!({ "workspaceId": session_id, "lifecycle": "awake" }))
            }
        },
        DedicatedCommand::Worktree(command) => {
            let selected_worktree = || {
                resolve_cli_worktree(
                    state,
                    worktree_registry,
                    command.selectors.worktree.as_deref(),
                    command.selectors.workspace.as_deref(),
                    caller_cwd.as_deref(),
                )
            };
            let selected_by_cwd = || {
                resolve_cli_worktree(state, worktree_registry, None, None, caller_cwd.as_deref())
            };
            let expected_instance = || {
                required_cli_option(&command.arguments, "expected-instance-id")
                    .context("--expected-instance-id is required for this worktree action")
            };
            let option = |name: &str| {
                cli_option(&command.arguments, name).map(|value| value.map(str::to_string))
            };
            match command.action {
                WorktreeAction::List => dispatch_worktree_request(
                    state,
                    worktree_registry,
                    worktree_lifecycle,
                    sessions_path,
                    outer_operation_id,
                    WORKTREE_METHOD_LIST,
                    &json!({
                        "repositoryPath": option("repo")?,
                        "includeExternal": command.arguments.switches.contains("include-external"),
                        "includeHidden": command.arguments.switches.contains("include-hidden"),
                    })
                    .to_string(),
                ),
                WorktreeAction::Show => Ok(serde_json::to_value(selected_worktree()?)?),
                WorktreeAction::Current => Ok(serde_json::to_value(selected_by_cwd()?)?),
                WorktreeAction::Create => {
                    let parent_session_id =
                        if let Some(workspace) = command.selectors.workspace.as_deref() {
                            resolve_cli_session(state, Some(workspace))?
                        } else {
                            selected_by_cwd()?
                            .record
                            .and_then(|record| record.session_id)
                            .and_then(|session_id| Uuid::parse_str(&session_id).ok())
                            .context(
                                "caller cwd is not bound to a workspace session; use --workspace",
                            )?
                        };
                    let payload = json!({
                        "operationId": outer_operation_id,
                        "repositoryPath": required_cli_option(&command.arguments, "repo")?,
                        "parentSessionId": parent_session_id,
                        "parentWorktreeId": if command.arguments.switches.contains("no-parent") { None } else { option("parent-worktree")? },
                        "name": required_cli_option(&command.arguments, "name")?,
                        "startRef": option("base-ref")?.unwrap_or_else(|| "HEAD".to_string()),
                        "branch": option("branch")?,
                        "storage": {
                            "mode": "drive",
                            "drive": "",
                            "folderName": "VibeLinkWorktrees",
                            "customRoot": "",
                            "groupByRepository": true
                        },
                        "fetch": command.arguments.switches.contains("fetch"),
                        "setupPolicy": option("setup")?.unwrap_or_else(|| "inherit".to_string()),
                        "sparsePreset": option("sparse-preset")?,
                        "linkedFiles": command.arguments.options.get("linked-file").cloned().unwrap_or_default(),
                        "profileId": option("profile")?,
                        "initialAgent": Value::Null,
                        "initialPrompt": option("prompt")?,
                        "origin": "cli"
                    });
                    dispatch_worktree_request(
                        state,
                        worktree_registry,
                        worktree_lifecycle,
                        sessions_path,
                        outer_operation_id,
                        WORKTREE_METHOD_CREATE,
                        &payload.to_string(),
                    )
                }
                WorktreeAction::Import => dispatch_worktree_request(
                    state,
                    worktree_registry,
                    worktree_lifecycle,
                    sessions_path,
                    outer_operation_id,
                    WORKTREE_METHOD_IMPORT,
                    &json!({
                        "repositoryPath": required_cli_option(&command.arguments, "repo")?,
                        "worktreePath": required_cli_option(&command.arguments, "path")?,
                        "parentSessionId": option("parent-session")?,
                        "sessionId": option("session")?,
                    })
                    .to_string(),
                ),
                WorktreeAction::Move => {
                    let selected = selected_worktree()?;
                    dispatch_worktree_request(
                        state,
                        worktree_registry,
                        worktree_lifecycle,
                        sessions_path,
                        outer_operation_id,
                        WORKTREE_METHOD_MOVE,
                        &json!({
                            "operationId": outer_operation_id,
                            "worktreeId": selected.id,
                            "expectedInstanceId": expected_instance()?,
                            "destinationPath": required_cli_option(&command.arguments, "destination")?,
                        })
                        .to_string(),
                    )
                }
                WorktreeAction::PreflightRemove => {
                    let selected = selected_worktree()?;
                    dispatch_worktree_request(
                        state,
                        worktree_registry,
                        worktree_lifecycle,
                        sessions_path,
                        outer_operation_id,
                        WORKTREE_METHOD_PREFLIGHT_REMOVE,
                        &json!({
                            "worktreeId": selected.id,
                            "deleteBranch": command.arguments.switches.contains("delete-branch"),
                        })
                        .to_string(),
                    )
                }
                WorktreeAction::Remove => {
                    let selected = selected_worktree()?;
                    dispatch_worktree_request(
                        state,
                        worktree_registry,
                        worktree_lifecycle,
                        sessions_path,
                        outer_operation_id,
                        WORKTREE_METHOD_REMOVE,
                        &json!({
                            "operationId": outer_operation_id,
                            "worktreeId": selected.id,
                            "expectedInstanceId": expected_instance()?,
                            "force": command.arguments.switches.contains("force"),
                            "deleteBranch": command.arguments.switches.contains("delete-branch"),
                            "acknowledgedBlockers": command.arguments.options.get("acknowledge-blocker").cloned().unwrap_or_default(),
                        })
                        .to_string(),
                    )
                }
                WorktreeAction::Set => {
                    let selected = selected_worktree()?;
                    dispatch_worktree_request(
                        state,
                        worktree_registry,
                        worktree_lifecycle,
                        sessions_path,
                        outer_operation_id,
                        WORKTREE_METHOD_SET,
                        &json!({
                            "worktreeId": selected.id,
                            "expectedInstanceId": expected_instance()?,
                            "comment": if command.arguments.switches.contains("clear-comment") { Some(String::new()) } else { option("comment")? },
                            "reviewTarget": if command.arguments.switches.contains("clear-review-target") { Some(String::new()) } else { option("review-target")? },
                            "parentWorktreeId": option("parent-worktree")?,
                            "clearParent": command.arguments.switches.contains("clear-parent"),
                        })
                        .to_string(),
                    )
                }
                WorktreeAction::Checkpoint => {
                    let selected = selected_worktree()?;
                    dispatch_worktree_request(
                        state,
                        worktree_registry,
                        worktree_lifecycle,
                        sessions_path,
                        outer_operation_id,
                        WORKTREE_METHOD_CHECKPOINT,
                        &json!({
                            "worktreeId": selected.id,
                            "kind": required_cli_option(&command.arguments, "kind")?,
                            "label": required_cli_option(&command.arguments, "label")?,
                            "comment": option("comment")?,
                        })
                        .to_string(),
                    )
                }
                WorktreeAction::Comment => {
                    let selected = selected_worktree()?;
                    let line = option("line")?
                        .map(|value| value.parse::<u32>().context("parse --line"))
                        .transpose()?;
                    let range = option("range-json")?
                        .map(|value| {
                            serde_json::from_str::<Value>(&value).context("parse --range-json")
                        })
                        .transpose()?;
                    dispatch_worktree_request(
                        state,
                        worktree_registry,
                        worktree_lifecycle,
                        sessions_path,
                        outer_operation_id,
                        WORKTREE_METHOD_REVIEW_COMMENT_PUT,
                        &json!({
                            "worktreeId": selected.id,
                            "expectedInstanceId": expected_instance()?,
                            "baseHead": required_cli_option(&command.arguments, "base-head")?,
                            "head": required_cli_option(&command.arguments, "head")?,
                            "path": required_cli_option(&command.arguments, "path")?,
                            "side": required_cli_option(&command.arguments, "side")?,
                            "line": line,
                            "range": range,
                            "hunkId": option("hunk-id")?,
                            "body": required_cli_option(&command.arguments, "body")?,
                        })
                        .to_string(),
                    )
                }
            }
        }
        DedicatedCommand::Terminal(command) => {
            let session_id = resolve_cli_session(state, command.selectors.workspace.as_deref())?;
            match command.action {
                TerminalAction::List | TerminalAction::Show => {
                    let (_, panes) = lock_state(state).attach_session(session_id)?;
                    if command.action == TerminalAction::Show {
                        let pane_id = resolve_cli_pane(&panes, command.selectors.pane.as_deref())?;
                        let pane = panes
                            .into_iter()
                            .find(|pane| pane.id == pane_id)
                            .context("pane not found")?;
                        Ok(serde_json::to_value(pane)?)
                    } else {
                        Ok(serde_json::to_value(panes)?)
                    }
                }
                TerminalAction::Read => {
                    let (_, panes) = lock_state(state).attach_session(session_id)?;
                    let pane_id = resolve_cli_pane(&panes, command.selectors.pane.as_deref())?;
                    let bytes = lock_state(state).get_scrollback(session_id, pane_id)?;
                    Ok(serde_json::json!({
                        "sessionId": session_id,
                        "paneId": pane_id,
                        "text": String::from_utf8_lossy(&bytes),
                    }))
                }
                TerminalAction::Send => {
                    let (_, panes) = lock_state(state).attach_session(session_id)?;
                    let pane_id = resolve_cli_pane(&panes, command.selectors.pane.as_deref())?;
                    let mut data = required_cli_option(&command.arguments, "text")?
                        .as_bytes()
                        .to_vec();
                    if command.arguments.switches.contains("enter") {
                        data.push(b'\r');
                    }
                    write_pane_authorized(
                        state,
                        session_id,
                        pane_id,
                        &data,
                        &PaneCommandOrigin::Desktop,
                    )?;
                    Ok(serde_json::json!({ "sent": data.len(), "paneId": pane_id }))
                }
                TerminalAction::Create | TerminalAction::Split => {
                    let program = required_cli_option(&command.arguments, "program")?.to_string();
                    let cwd = cli_option(&command.arguments, "cwd")?.map(str::to_string);
                    let title = cli_option(&command.arguments, "title")?.map(str::to_string);
                    let args = command.arguments.positionals;
                    let pane = spawn_pane_for_session(
                        Arc::clone(state),
                        sessions_path.to_path_buf(),
                        session_id,
                        PaneConfig {
                            pane_id: Uuid::new_v4(),
                            shell: Some(program),
                            args,
                            cwd,
                            env: Vec::new(),
                            title,
                            icon: None,
                            profile_id: None,
                            role: None,
                            restore_on_start: false,
                            cols: 120,
                            rows: 30,
                        },
                        None,
                    )?;
                    Ok(serde_json::to_value(pane)?)
                }
                TerminalAction::Close => {
                    let (_, panes) = lock_state(state).attach_session(session_id)?;
                    let pane_id = resolve_cli_pane(&panes, command.selectors.pane.as_deref())?;
                    let (pane, lease_transition) = {
                        let mut guard = lock_state(state);
                        let pane = guard.close_pane(session_id, pane_id)?;
                        let lease = guard.cleanup_remote_pane_lease_on_exit(pane_id);
                        (pane, lease)
                    };
                    if let Some(transition) = lease_transition {
                        process_pane_lease_transition(state, transition);
                    }
                    if let Some(mut pane) = pane {
                        pane.kill()?;
                        if let Err(error) = remove_pane_history(sessions_path, session_id, pane_id)
                        {
                            warn!(?error, %pane_id, "failed to remove closed pane history");
                        }
                    }
                    persist_state(state, sessions_path)?;
                    Ok(serde_json::json!({ "closed": pane_id }))
                }
                TerminalAction::Complete => {
                    let (_, panes) = lock_state(state).attach_session(session_id)?;
                    let pane_id = resolve_cli_pane(&panes, command.selectors.pane.as_deref())?;
                    let agent = cli_option(&command.arguments, "agent-id")?.map(str::to_string);
                    // Broadcast so the attached GUI can highlight the pane. The
                    // hook fires once per finished turn, so this is a plain
                    // notification with no daemon-side state to persist.
                    let senders = lock_state(state).all_senders();
                    for sender in senders {
                        let _ = sender.send(DaemonToClient::TaskEvent {
                            session_id,
                            event: crate::protocol::TaskSignal::PaneCompleted {
                                pane_id,
                                agent: agent.clone(),
                            },
                        });
                    }
                    Ok(serde_json::json!({ "paneId": pane_id, "agent": agent }))
                }
                TerminalAction::Wait => {
                    let (_, panes) = lock_state(state).attach_session(session_id)?;
                    let pane_id = resolve_cli_pane(&panes, command.selectors.pane.as_deref())?;
                    let after_sequence = cli_option(&command.arguments, "after-sequence")?
                        .map(|value| {
                            value
                                .parse::<u64>()
                                .context("--after-sequence must be an unsigned integer")
                        })
                        .transpose()?;
                    let (generation, sequence, alive, bytes) =
                        lock_state(state).terminal_snapshot(session_id, pane_id)?;
                    let text = String::from_utf8_lossy(&bytes).into_owned();
                    let matched =
                        cli_option(&command.arguments, "text")?.map(|needle| text.contains(needle));
                    let output_advanced = after_sequence.is_some_and(|after| after < sequence);
                    let gap = after_sequence
                        .filter(|after| sequence > after.saturating_add(1))
                        .map(|after| {
                            json!({
                                "expectedSequence": after.saturating_add(1),
                                "observedSequence": sequence,
                                "resyncRequired": true,
                            })
                        });
                    Ok(json!({
                        "event": if output_advanced { "output" } else { "snapshot" },
                        "workspaceId": session_id,
                        "paneId": pane_id,
                        "generation": generation,
                        "sequence": sequence,
                        "alive": alive,
                        "matched": matched,
                        "gap": gap,
                        "resyncRequired": output_advanced,
                        "resync": { "kind": "snapshot", "text": text },
                    }))
                }
            }
        }
        DedicatedCommand::Orchestration(command) => {
            let run_id = cli_option(&command.arguments, "run-id")?.map(str::to_string);
            match command.action {
                OrchestrationAction::Run => {
                    let session_id = resolve_cli_session(state, command.selectors.workspace.as_deref())?;
                    let created = coordinator.create_run(
                        outer_operation_id,
                        CreateRunRequest {
                            session_id: session_id.to_string(),
                            goal: required_cli_option(&command.arguments, "goal")?.to_string(),
                            policy: Default::default(),
                        },
                    )?;
                    let started = coordinator.start_run(
                        Uuid::new_v4(),
                        RunRevisionRequest { run_id: created.id, expected_run_revision: created.revision },
                    )?;
                    Ok(serde_json::to_value(started)?)
                }
                OrchestrationAction::RunStop => {
                    let run_id = run_id.context("--run-id is required")?;
                    let expected_run_revision = expected_revision.context("--expected-revision is required")?;
                    let run = coordinator.run(&run_id)?;
                    if run.status == crate::orchestration::RunStatus::Cancelled {
                        let run = coordinator.cancel_run(
                            outer_operation_id,
                            RunRevisionRequest {
                                run_id: run_id.clone(),
                                expected_run_revision,
                            },
                        )?;
                        let resources = coordinator
                            .cleanup_targets_for_run(&run.id)?
                            .into_iter()
                            .filter_map(|target| target.resources)
                            .collect::<Vec<_>>();
                        return Ok(json!({
                            "run": run,
                            "resources": resources,
                            "cleanupErrors": [],
                        }));
                    }
                    if run.revision != expected_run_revision {
                        anyhow::bail!(
                            "stale revision for run {}: expected {}, current {}",
                            run.id,
                            expected_run_revision,
                            run.revision
                        );
                    }
                    let (resources, cleanup_errors) = cleanup_run_resources(
                        state,
                        coordinator,
                        worktrees,
                        &run_id,
                        "cancel",
                    )?;
                    require_workers_stopped(&resources, &cleanup_errors)
                        .map_err(|error| anyhow::anyhow!(error.message))?;
                    persist_state(state, sessions_path)?;
                    let run = coordinator.cancel_run(
                        outer_operation_id,
                        RunRevisionRequest {
                            run_id,
                            expected_run_revision,
                        },
                    )?;
                    Ok(json!({ "run": run, "resources": resources, "cleanupErrors": cleanup_errors }))
                }
                OrchestrationAction::TaskCreate => {
                    let run_id = run_id.context("--run-id is required")?;
                    Ok(serde_json::to_value(coordinator.create_task(
                        outer_operation_id,
                        CreateTaskRequest {
                            run_id,
                            title: required_cli_option(&command.arguments, "title")?.to_string(),
                            description: cli_option(&command.arguments, "description")?.unwrap_or_default().to_string(),
                            dependencies: command.arguments.options.get("dependency").cloned().unwrap_or_default(),
                            expected_run_revision: expected_revision.context("--expected-revision is required")?,
                        },
                    )?)?)
                }
                OrchestrationAction::TaskList => {
                    Ok(serde_json::to_value(coordinator.tasks(&run_id.context("--run-id is required")?)?)?)
                }
                OrchestrationAction::TaskUpdate => {
                    let run_id = run_id.context("--run-id is required")?;
                    let task_id = required_cli_option(&command.arguments, "task-id")?.to_string();
                    let task_revision = expected_revision.context("--expected-revision is required")?;
                    let status = match required_cli_option(&command.arguments, "status")? {
                        "pending" => crate::orchestration::OrchestrationTaskStatus::Pending,
                        "ready" => crate::orchestration::OrchestrationTaskStatus::Ready,
                        "dispatched" => crate::orchestration::OrchestrationTaskStatus::Dispatched,
                        "completed" | "done" => crate::orchestration::OrchestrationTaskStatus::Completed,
                        "failed" => crate::orchestration::OrchestrationTaskStatus::Failed,
                        "blocked" => crate::orchestration::OrchestrationTaskStatus::Blocked,
                        "cancelled" => crate::orchestration::OrchestrationTaskStatus::Cancelled,
                        value => anyhow::bail!("unsupported orchestration task status: {value}"),
                    };
                    let run = coordinator.run(&run_id)?;
                    Ok(serde_json::to_value(coordinator.update_task(
                        outer_operation_id,
                        UpdateTaskRequest {
                            run_id,
                            task_id,
                            expected_run_revision: run.revision,
                            expected_task_revision: task_revision,
                            patch: crate::orchestration::UpdateTaskPatch {
                                status: Some(status),
                                result: cli_option(&command.arguments, "result-summary")?
                                    .map(|value| json!({ "summary": value })),
                                ..Default::default()
                            },
                        },
                    )?)?)
                }
                OrchestrationAction::Send => {
                    let message = required_cli_option(&command.arguments, "message")?.to_string();
                    if let Some(run_id) = run_id {
                        Ok(serde_json::to_value(coordinator.post_message(
                            outer_operation_id,
                            PostMessageRequest {
                                run_id,
                                task_id: cli_option(&command.arguments, "task-id")?.map(str::to_string),
                                dispatch_id: cli_option(&command.arguments, "dispatch-id")?.map(str::to_string),
                                parent_id: None,
                                sender_kind: "cli".to_string(),
                                message_type: crate::orchestration::MessageType::Chat,
                                payload: serde_json::json!({ "text": message }),
                            },
                        )?)?)
                    } else {
                        let session_id = resolve_cli_session(state, command.selectors.workspace.as_deref())?;
                        Ok(serde_json::to_value(control.execute(
                            outer_operation_id,
                            ControlCommand::TaskNote {
                                session_id: session_id.to_string(),
                                task_id: required_cli_option(&command.arguments, "task-id")?.to_string(),
                                message,
                            },
                        )?)?)
                    }
                }
                OrchestrationAction::Check => {
                    let run_id = run_id.context("--run-id is required")?;
                    let run = coordinator.run(&run_id)?;
                    if let Some(after_revision) = cli_option(&command.arguments, "after-revision")? {
                        let after_revision = after_revision.parse::<u64>().context("--after-revision must be an unsigned integer")?;
                        Ok(json!({ "changed": run.revision > after_revision, "revision": run.revision, "run": run }))
                    } else {
                        Ok(serde_json::to_value(run)?)
                    }
                }
                OrchestrationAction::Inbox => {
                    let run_id = run_id.context("--run-id is required")?;
                    let messages = coordinator.messages(&run_id)?;
                    if let Some(after_sequence) = cli_option(&command.arguments, "after-sequence")? {
                        let after_sequence = after_sequence.parse::<u64>().context("--after-sequence must be an unsigned integer")?;
                        let replay = coordinator.events_after(&run_id, "cli-inbox", Some(after_sequence), 200)?;
                        Ok(json!({ "messages": messages, "replay": replay }))
                    } else {
                        Ok(serde_json::to_value(messages)?)
                    }
                }
                OrchestrationAction::Dispatch => {
                    let run_id = run_id.context("--run-id is required")?;
                    if cli_option(&command.arguments, "worktree")?.is_some()
                        || cli_option(&command.arguments, "base-revision")?.is_some()
                        || cli_option(&command.arguments, "branch")?.is_some()
                    {
                        anyhow::bail!(
                            "raw worktree paths and refs are not accepted; use --worktree-mode worktree"
                        );
                    }
                    let worktree_mode = match cli_option(&command.arguments, "worktree-mode")?
                        .unwrap_or("worktree")
                    {
                        "worktree" => WorktreeMode::Worktree,
                        "reuse" => WorktreeMode::Reuse,
                        value => anyhow::bail!("unsupported --worktree-mode: {value}"),
                    };
                    let result = launch_ready_dispatches(
                        state,
                        sessions_path,
                        coordinator,
                        worktree_registry,
                        worktree_lifecycle,
                        worktrees,
                        envelope.request.operation_id,
                        DispatchLaunchRequest {
                            run_id,
                            expected_run_revision: expected_revision
                                .context("--expected-revision is required")?,
                            command: required_cli_option(&command.arguments, "command")?
                                .to_string(),
                            profile: cli_option(&command.arguments, "profile")?
                                .map(str::to_string),
                            worktree_mode,
                        },
                    )
                    .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
                    Ok(serde_json::to_value(result)?)
                }
                OrchestrationAction::GateList => {
                    Ok(serde_json::to_value(coordinator.gates(&run_id.context("--run-id is required")?)?)?)
                }
                OrchestrationAction::GateResolve => {
                    let gate_id = required_cli_option(&command.arguments, "gate-id")?.to_string();
                    let gate = coordinator.gate(&gate_id)?;
                    let decision = required_cli_option(&command.arguments, "resolution")?;
                    let resolution = if gate.gate_type == "cleanup" && decision == "approve" {
                        json!({
                            "decision": decision,
                            "force": command.arguments.switches.contains("force"),
                            "deleteBranch": command.arguments.switches.contains("delete-branch"),
                            "acknowledgedBlockers": command.arguments.options
                                .get("acknowledge-blocker")
                                .cloned()
                                .unwrap_or_default(),
                        })
                    } else {
                        json!({ "decision": decision })
                    };
                    let request = ResolveGateRequest {
                        gate_id,
                        resolution,
                        expected_run_revision: expected_revision
                            .context("--expected-revision is required")?,
                    };
                    dispatch_orchestration_rpc(
                        state,
                        sessions_path,
                        coordinator,
                        worktree_registry,
                        worktree_lifecycle,
                        worktrees,
                        outer_operation_id,
                        "gate.resolve",
                        &serde_json::to_string(&request)?,
                    )
                    .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))
                }
                OrchestrationAction::GateCreate => {
                    let run_id = run_id.context("--run-id is required")?;
                    Ok(serde_json::to_value(coordinator.create_gate(
                        outer_operation_id,
                        CreateGateRequest {
                            run_id,
                            task_id: cli_option(&command.arguments, "task-id")?.map(str::to_string),
                            dispatch_id: cli_option(&command.arguments, "dispatch-id")?.map(str::to_string),
                            gate_type: cli_option(&command.arguments, "type")?.unwrap_or("decision").to_string(),
                            prompt: required_cli_option(&command.arguments, "prompt")?.to_string(),
                            options: command.arguments.options.get("option").cloned().unwrap_or_default(),
                            expires_at: None,
                            expected_run_revision: expected_revision.context("--expected-revision is required")?,
                        },
                    )?)?)
                }
                OrchestrationAction::DispatchShow => {
                    let run_id = run_id.context("--run-id is required")?;
                    let dispatch_id = required_cli_option(&command.arguments, "dispatch-id")?;
                    let dispatch = coordinator.dispatches(&run_id)?
                        .into_iter()
                        .find(|dispatch| dispatch.id == dispatch_id)
                        .with_context(|| format!("dispatch not found: {dispatch_id}"))?;
                    Ok(serde_json::to_value(dispatch)?)
                }
                OrchestrationAction::Reply => {
                    Ok(serde_json::to_value(coordinator.post_message(
                        outer_operation_id,
                        PostMessageRequest {
                            run_id: run_id.context("--run-id is required")?,
                            task_id: cli_option(&command.arguments, "task-id")?.map(str::to_string),
                            dispatch_id: cli_option(&command.arguments, "dispatch-id")?.map(str::to_string),
                            parent_id: Some(required_cli_option(&command.arguments, "parent-id")?.to_string()),
                            sender_kind: "user".to_string(),
                            message_type: MessageType::Status,
                            payload: json!({ "message": required_cli_option(&command.arguments, "message")? }),
                        },
                    )?)?)
                }
                OrchestrationAction::Ask => {
                    Ok(serde_json::to_value(coordinator.create_gate(
                        outer_operation_id,
                        CreateGateRequest {
                            run_id: run_id.context("--run-id is required")?,
                            task_id: cli_option(&command.arguments, "task-id")?.map(str::to_string),
                            dispatch_id: cli_option(&command.arguments, "dispatch-id")?.map(str::to_string),
                            gate_type: "decision".to_string(),
                            prompt: required_cli_option(&command.arguments, "prompt")?.to_string(),
                            options: command.arguments.options.get("option").cloned().unwrap_or_else(|| vec!["approve".to_string(), "reject".to_string()]),
                            expires_at: None,
                            expected_run_revision: expected_revision.context("--expected-revision is required")?,
                        },
                    )?)?)
                }
                OrchestrationAction::Reset => {
                    Ok(serde_json::to_value(coordinator.create_gate(
                        outer_operation_id,
                        CreateGateRequest {
                            run_id: run_id.context("--run-id is required")?,
                            task_id: None,
                            dispatch_id: None,
                            gate_type: "reset".to_string(),
                            prompt: "Approve resetting this orchestration run? Existing dispatch identity and results will remain auditable.".to_string(),
                            options: vec!["approve".to_string(), "reject".to_string()],
                            expires_at: None,
                            expected_run_revision: expected_revision.context("--expected-revision is required")?,
                        },
                    )?)?)
                }
            }
        }
        DedicatedCommand::Skill(command) => dispatch_skill_cli(state, command),
        DedicatedCommand::Automation(command) => dispatch_automation_cli(
            state,
            sessions_path,
            worktree_lifecycle,
            worktrees,
            automation,
            command,
        ),
        DedicatedCommand::Browser(command) => browser_cdp::execute(
            command,
            &sessions_path
                .parent()
                .unwrap_or(sessions_path)
                .join("browser-artifacts"),
        ),
        DedicatedCommand::Computer(command) => {
            dispatch_computer_cli(computer, outer_operation_id, command)
        }
        DedicatedCommand::Remote(command) => match command.action {
            RemoteAction::Status => Ok(json!({
                "server": remote.status(),
                "protocolVersion": crate::remote::v2::PROTOCOL_VERSION,
                "contractSha256": crate::remote::v2::CONTRACT_SHA256,
            })),
            RemoteAction::Configure => {
                if command.arguments.switches.contains("enable")
                    && command.arguments.switches.contains("disable")
                {
                    anyhow::bail!("--enable and --disable are mutually exclusive");
                }
                if command.arguments.switches.contains("enable-lan")
                    && command.arguments.switches.contains("disable-lan")
                {
                    anyhow::bail!("--enable-lan and --disable-lan are mutually exclusive");
                }
                if let Some(port) = cli_option(&command.arguments, "port")? {
                    remote.set_port(port.parse::<u16>().context("--port must be a valid port")?)?;
                }
                if command.arguments.switches.contains("enable-lan") {
                    remote.set_lan_enabled(true)?;
                } else if command.arguments.switches.contains("disable-lan") {
                    remote.set_lan_enabled(false)?;
                }
                if command.arguments.switches.contains("enable") {
                    remote.set_enabled(true)?;
                } else if command.arguments.switches.contains("disable") {
                    remote.set_enabled(false)?;
                }
                Ok(serde_json::to_value(remote.status())?)
            }
            RemoteAction::Pair => {
                if let Some(port) = cli_option(&command.arguments, "port")? {
                    remote.set_port(port.parse::<u16>().context("--port must be a valid port")?)?;
                }
                if command.arguments.switches.contains("enable-lan") {
                    remote.set_lan_enabled(true)?;
                }
                if command.arguments.switches.contains("enable") {
                    remote.set_enabled(true)?;
                }
                Ok(serde_json::to_value(remote.create_pairing_v2()?)?)
            }
            RemoteAction::Devices => Ok(serde_json::to_value(remote.status().devices)?),
            RemoteAction::Revoke => {
                let device_id = command
                    .arguments
                    .positionals
                    .first()
                    .map(String::as_str)
                    .or_else(|| cli_option(&command.arguments, "device-id").ok().flatten())
                    .context("device id is required")?;
                remote.revoke_device(device_id)?;
                Ok(json!({ "deviceId": device_id, "revoked": true }))
            }
        },
        DedicatedCommand::Mcp(_) => anyhow::bail!("mcp serve runs in the dedicated CLI process"),
    }
}

fn dispatch_automation_cli(
    state: &SharedState,
    sessions_path: &Path,
    worktree_lifecycle: &WorktreeLifecycleService,
    worktrees: &WorktreeManager,
    automation: &AutomationService,
    command: crate::dedicated_cli::ActionCommand<AutomationAction>,
) -> Result<Value> {
    match command.action {
        AutomationAction::List => {
            let session_id = command
                .selectors
                .workspace
                .as_deref()
                .map(|selector| resolve_cli_session(state, Some(selector)).map(|id| id.to_string()))
                .transpose()?;
            Ok(serde_json::to_value(
                automation.list(session_id.as_deref())?,
            )?)
        }
        AutomationAction::Create => {
            let session_id = resolve_cli_session(state, command.selectors.workspace.as_deref())?;
            let payload = automation_json_payload(&command.arguments)?;
            Ok(serde_json::to_value(
                automation.create(&session_id.to_string(), &payload)?,
            )?)
        }
        AutomationAction::Update => {
            let id = automation_cli_id(&command.arguments, "automation id")?;
            let payload = automation_json_payload(&command.arguments)?;
            Ok(serde_json::to_value(automation.update(id, &payload)?)?)
        }
        AutomationAction::Delete => {
            let id = automation_cli_id(&command.arguments, "automation id")?;
            automation.delete(id)?;
            Ok(json!({ "id": id, "deleted": true }))
        }
        AutomationAction::Run => {
            let id = automation_cli_id(&command.arguments, "automation id")?;
            let record = automation.get(id)?;
            let workspace = automation_workspace(state, &record.session_id)?;
            let claim = automation.trigger(id)?;
            Ok(serde_json::to_value(automation.execute_and_notify_with_worktree(
                &claim,
                &workspace,
                |record, claim, workspace, planned| {
                    provision_automation_worktree(
                        state,
                        sessions_path,
                        worktree_lifecycle,
                        worktrees,
                        record,
                        claim,
                        workspace,
                        planned,
                    )
                },
            )?)?)
        }
        AutomationAction::Runs => {
            let id = automation_cli_id(&command.arguments, "automation id")?;
            let limit = cli_option(&command.arguments, "limit")?
                .unwrap_or("50")
                .parse::<u32>()
                .context("--limit must be an unsigned integer")?;
            Ok(serde_json::to_value(automation.runs(id, limit)?)?)
        }
        AutomationAction::SchedulePreview => {
            let payload = automation_json_payload(&command.arguments)?;
            Ok(automation.schedule_preview(&payload)?)
        }
        AutomationAction::Precheck => {
            let id = automation_cli_id(&command.arguments, "automation id")?;
            let record = automation.get(id)?;
            let workspace = automation_workspace(state, &record.session_id)?;
            Ok(serde_json::to_value(
                automation.precheck(&record, &workspace),
            )?)
        }
        AutomationAction::Cancel => {
            let id = automation_cli_id(&command.arguments, "automation run id")?;
            Ok(serde_json::to_value(automation.cancel(id)?)?)
        }
        AutomationAction::ImportPreview => {
            let session_id = resolve_cli_session(state, command.selectors.workspace.as_deref())?;
            let workspace = automation_workspace(state, &session_id.to_string())?;
            Ok(serde_json::to_value(
                automation.import_preview(&session_id.to_string(), &workspace)?,
            )?)
        }
        AutomationAction::Import => {
            let session_id = resolve_cli_session(state, command.selectors.workspace.as_deref())?;
            let workspace = automation_workspace(state, &session_id.to_string())?;
            let payload = automation_json_payload(&command.arguments)?;
            Ok(serde_json::to_value(automation.import(
                &session_id.to_string(),
                &workspace,
                &payload,
            )?)?)
        }
        AutomationAction::DraftPreview => {
            let session_id = resolve_cli_session(state, command.selectors.workspace.as_deref())?;
            let payload = automation_json_payload(&command.arguments)?;
            Ok(serde_json::to_value(
                automation.draft_preview(&session_id.to_string(), &payload)?,
            )?)
        }
        AutomationAction::DraftCancel => {
            let id = automation_cli_id(&command.arguments, "automation draft request id")?;
            Ok(serde_json::to_value(automation.cancel_draft(id)?)?)
        }
    }
}

fn automation_cli_id<'a>(
    arguments: &'a crate::dedicated_cli::OperationArguments,
    label: &str,
) -> Result<&'a str> {
    let positional = arguments.positionals.first().map(String::as_str);
    let option = cli_option(arguments, "id")?;
    let id = match (positional, option) {
        (Some(_), Some(_)) => {
            anyhow::bail!("{label} must be supplied either positionally or with --id, not both")
        }
        (Some(id), None) | (None, Some(id)) => id,
        (None, None) => anyhow::bail!("{label} is required"),
    };
    Uuid::parse_str(id).with_context(|| format!("{label} must be a UUID"))?;
    Ok(id)
}

fn automation_json_payload(arguments: &crate::dedicated_cli::OperationArguments) -> Result<Value> {
    let raw = required_cli_option(arguments, "json")?;
    let payload: Value =
        serde_json::from_str(raw).context("automation --json must be valid JSON")?;
    if !payload.is_object() {
        anyhow::bail!("automation --json must contain a JSON object");
    }
    Ok(payload)
}

fn automation_workspace(state: &SharedState, session_id: &str) -> Result<PathBuf> {
    let session_id = Uuid::parse_str(session_id).context("automation session id is invalid")?;
    lock_state(state)
        .list_sessions()
        .into_iter()
        .find(|session| session.id == session_id)
        .and_then(|session| session.workspace_folder)
        .map(PathBuf::from)
        .context("automation workspace folder is unavailable")
}

fn provision_automation_worktree(
    state: &SharedState,
    sessions_path: &Path,
    lifecycle: &WorktreeLifecycleService,
    worktrees: &WorktreeManager,
    automation: &crate::daemon::automation::AutomationRecord,
    claim: &crate::daemon::automation::AutomationRunRecord,
    workspace: &Path,
    planned: &WorktreeAssignment,
) -> Result<AutomationWorktreeProvision> {
    let authority = worktrees.authority(workspace)?;
    let operation_id = derived_operation_id(
        Uuid::parse_str(&claim.id).context("automation run id is invalid")?,
        &automation.id,
        "worktree-create",
    );
    let base_sha = planned.base_revision.clone();
    let custom_root = PathBuf::from(&planned.worktree_path)
        .parent()
        .context("automation worktree path has no managed root")?
        .to_string_lossy()
        .to_string();
    let request = WorktreeCreateRequest {
        operation_id,
        repository_path: authority.repository_root_string(),
        parent_session_id: automation.session_id.clone(),
        parent_worktree_id: None,
        name: format!("automation-{}", short_identity(&claim.id)),
        start_ref: base_sha,
        branch: Some(planned.branch.clone()),
        storage: WorktreeStorage {
            mode: WorktreeStorageMode::Custom,
            drive: String::new(),
            folder_name: String::new(),
            custom_root,
            group_by_repository: false,
        },
        fetch: false,
        setup_policy: "skip".to_string(),
        sparse_preset: None,
        linked_files: Vec::new(),
        profile_id: None,
        initial_agent: None,
        initial_prompt: None,
        origin: WorktreeOrigin::Automation,
    };
    let session_name = format!("{} run", automation.name);
    let created = lifecycle.create(
        request,
        |record| {
            let session =
                lock_state(state).create_session(session_name, Some(record.worktree_path.clone()));
            persist_state(state, sessions_path)?;
            Ok(session.id.to_string())
        },
        |session_id| remove_worktree_session(state, sessions_path, session_id).map(|_| ()),
    )?;
    Ok(AutomationWorktreeProvision {
        session_id: created.session_id,
        assignment: WorktreeAssignment {
            worktree_id: Some(created.worktree.id),
            instance_id: Some(created.worktree.instance_id),
            base_revision: created.base_sha,
            branch: created.worktree.branch,
            worktree_path: created.worktree.worktree_path,
        },
    })
}

fn dispatch_skill_cli(
    state: &SharedState,
    command: crate::dedicated_cli::ActionCommand<SkillAction>,
) -> Result<Value> {
    use crate::app::skills::{
        apply_skill, delete_skill, get_skill, list_skills, SkillApplyInput, SkillScope,
    };

    let session_id = command
        .selectors
        .workspace
        .as_deref()
        .map(|selector| resolve_cli_session(state, Some(selector)).map(|id| id.to_string()))
        .transpose()?;
    let selected_scope = || -> Result<SkillScope> {
        match cli_option(&command.arguments, "scope")? {
            Some("global") => Ok(SkillScope::Global),
            Some("workspace") => {
                session_id
                    .as_ref()
                    .context("--workspace is required for workspace skill scope")?;
                Ok(SkillScope::Workspace)
            }
            Some(_) => anyhow::bail!("--scope must be workspace or global"),
            None if session_id.is_some() => Ok(SkillScope::Workspace),
            None => Ok(SkillScope::Global),
        }
    };
    let skill_id = || {
        command
            .arguments
            .positionals
            .first()
            .map(String::as_str)
            .or_else(|| cli_option(&command.arguments, "id").ok().flatten())
            .context("skill id is required")
    };

    match command.action {
        SkillAction::List => Ok(json!({ "skills": list_skills(session_id.as_deref())? })),
        SkillAction::Show => Ok(serde_json::to_value(get_skill(
            skill_id()?,
            session_id.as_deref(),
            cli_option(&command.arguments, "scope")?
                .map(|_| selected_scope())
                .transpose()?,
        )?)?),
        SkillAction::Apply => {
            let id = skill_id()?;
            let builtin = crate::dedicated_cli::builtin_skill(id)
                .with_context(|| format!("builtin skill not found: {id}"))?;
            Ok(serde_json::to_value(apply_skill(SkillApplyInput {
                id: builtin.id.to_string(),
                name: Some(builtin.name.to_string()),
                category: Some(builtin.category.to_string()),
                description: Some(builtin.description.to_string()),
                content: builtin.content.to_string(),
                scope: selected_scope()?,
                session_id,
                enabled: Some(true),
                required_capabilities: builtin
                    .required_capabilities
                    .iter()
                    .map(|value| (*value).to_string())
                    .collect(),
            })?)?)
        }
        SkillAction::Delete => {
            let id = skill_id()?.to_string();
            let scope = selected_scope()?;
            delete_skill(&id, session_id.as_deref(), Some(scope))?;
            Ok(json!({ "id": id, "scope": scope, "deleted": true }))
        }
        SkillAction::Doctor => {
            let skills = list_skills(session_id.as_deref())?;
            Ok(json!({
                "ok": true,
                "builtinVersion": crate::dedicated_cli::BUILTIN_SKILL_VERSION,
                "builtinCount": skills.iter().filter(|entry| entry.read_only).count(),
                "installedCount": skills.iter().filter(|entry| !entry.read_only).count(),
                "precedence": ["workspace", "global", "builtin"],
            }))
        }
    }
}

fn dispatch_computer_cli(
    computer: &SharedComputerHost,
    operation_id: Uuid,
    command: crate::dedicated_cli::ActionCommand<ComputerAction>,
) -> Result<Value> {
    let response = match command.action {
        ComputerAction::Capabilities => {
            request_computer_host(computer, operation_id, HostRequest::Capabilities)?
        }
        ComputerAction::ListApps => {
            request_computer_host(computer, operation_id, HostRequest::ListApps)?
        }
        ComputerAction::ListWindows => {
            let process_id = cli_option(&command.arguments, "process-id")?
                .map(|value| {
                    value
                        .parse::<u32>()
                        .context("--process-id must be an unsigned integer")
                })
                .transpose()?;
            request_computer_host(
                computer,
                operation_id,
                HostRequest::ListWindows { process_id },
            )?
        }
        ComputerAction::GetAppState => {
            let windows = request_computer_host(
                computer,
                operation_id,
                HostRequest::ListWindows { process_id: None },
            )?;
            let HostResponseBody::Windows(windows) = windows else {
                anyhow::bail!("computer-use host returned an unexpected window response")
            };
            let window = resolve_computer_window(
                &windows,
                command.selectors.window.as_deref(),
                command.selectors.app.as_deref(),
            )?;
            request_computer_host(
                computer,
                operation_id,
                HostRequest::Snapshot {
                    request: SnapshotRequest {
                        operation_id,
                        window,
                        no_screenshot: command.arguments.switches.contains("no-screenshot"),
                        restore_window: command.arguments.switches.contains("restore-window"),
                        limits: SnapshotLimits::default(),
                    },
                },
            )?
        }
        ComputerAction::ApprovalList => request_computer_host(
            computer,
            operation_id,
            HostRequest::ApprovalList {
                limit: computer_history_limit(&command.arguments, 50)?,
            },
        )?,
        ComputerAction::ActionHistory => request_computer_host(
            computer,
            operation_id,
            HostRequest::ActionHistory {
                limit: computer_history_limit(&command.arguments, 100)?,
            },
        )?,
        ComputerAction::ApprovalResolve => {
            let approval_id =
                Uuid::parse_str(required_cli_option(&command.arguments, "approval-id")?)
                    .context("--approval-id must be a UUID")?;
            let approved = match required_cli_option(&command.arguments, "decision")? {
                "approve" | "approved" => true,
                "deny" | "denied" => false,
                _ => anyhow::bail!("--decision must be approve or deny"),
            };
            request_computer_host(
                computer,
                operation_id,
                HostRequest::ApprovalResolve {
                    approval_id,
                    approved,
                },
            )?
        }
        ComputerAction::ApprovalCreate => {
            let requested =
                ComputerAction::parse(required_cli_option(&command.arguments, "action")?)
                    .context("--action must name a computer action")?;
            let request = computer_action_request(operation_id, requested, &command.arguments)?;
            request_computer_host(
                computer,
                operation_id,
                HostRequest::ApprovalCreate {
                    request: ApprovalRequest {
                        operation_id: request.operation_id,
                        snapshot_id: request.snapshot_id,
                        window_generation: request.window_generation,
                        target: request.target,
                        action: request.action,
                    },
                },
            )?
        }
        action => {
            let request = computer_action_request(operation_id, action, &command.arguments)?;
            request_computer_host(computer, operation_id, HostRequest::Action { request })?
        }
    };
    Ok(serde_json::to_value(response)?)
}

fn computer_history_limit(
    arguments: &crate::dedicated_cli::OperationArguments,
    default: u32,
) -> Result<u32> {
    cli_option(arguments, "limit")?
        .map(|value| {
            value
                .parse::<u32>()
                .context("--limit must be an unsigned integer")
        })
        .transpose()
        .map(|value| value.unwrap_or(default).clamp(1, 500))
}

fn computer_action_request(
    operation_id: Uuid,
    action: ComputerAction,
    arguments: &crate::dedicated_cli::OperationArguments,
) -> Result<ActionRequest> {
    let snapshot_id = Uuid::parse_str(required_cli_option(arguments, "snapshot-id")?)
        .context("--snapshot-id must be a UUID")?;
    let window_generation = required_cli_option(arguments, "window-generation")?
        .parse::<u64>()
        .context("--window-generation must be an unsigned integer")?;
    let target = if let Some(index) = cli_option(arguments, "element-index")? {
        ActionTarget::Element {
            index: index
                .parse::<u32>()
                .context("--element-index must be an unsigned integer")?,
        }
    } else {
        ActionTarget::Coordinate {
            point: Point {
                x: required_cli_option(arguments, "x")?
                    .parse::<i32>()
                    .context("--x must be an integer")?,
                y: required_cli_option(arguments, "y")?
                    .parse::<i32>()
                    .context("--y must be an integer")?,
            },
            window_generation,
        }
    };
    let action = computer_provider_action(action, arguments)?;
    let action = if let Some(approval_id) = cli_option(arguments, "approval-id")? {
        ProviderComputerAction::Approved {
            approval_id: Uuid::parse_str(approval_id).context("--approval-id must be a UUID")?,
            action: Box::new(action),
        }
    } else {
        action
    };
    Ok(ActionRequest {
        operation_id,
        snapshot_id,
        window_generation,
        target,
        action,
    })
}

fn computer_provider_action(
    action: ComputerAction,
    arguments: &crate::dedicated_cli::OperationArguments,
) -> Result<ProviderComputerAction> {
    Ok(match action {
        ComputerAction::Click => ProviderComputerAction::Click,
        ComputerAction::PerformSecondaryAction => ProviderComputerAction::SecondaryAction,
        ComputerAction::Scroll => ProviderComputerAction::Scroll {
            delta_x: cli_option(arguments, "delta-x")?
                .unwrap_or("0")
                .parse()
                .context("--delta-x must be an integer")?,
            delta_y: cli_option(arguments, "delta-y")?
                .unwrap_or("0")
                .parse()
                .context("--delta-y must be an integer")?,
        },
        ComputerAction::Drag => ProviderComputerAction::Drag {
            to: Point {
                x: required_cli_option(arguments, "to-x")?
                    .parse()
                    .context("--to-x must be an integer")?,
                y: required_cli_option(arguments, "to-y")?
                    .parse()
                    .context("--to-y must be an integer")?,
            },
        },
        ComputerAction::TypeText => ProviderComputerAction::TypeText {
            text: required_cli_option(arguments, "text")?.to_string(),
        },
        ComputerAction::PressKey => ProviderComputerAction::PressKey {
            key: required_cli_option(arguments, "key")?.to_string(),
        },
        ComputerAction::Hotkey => ProviderComputerAction::Hotkey {
            keys: arguments
                .options
                .get("key")
                .cloned()
                .filter(|keys| !keys.is_empty())
                .context("--key is required")?,
        },
        ComputerAction::PasteText => ProviderComputerAction::PasteText {
            text: required_cli_option(arguments, "text")?.to_string(),
        },
        ComputerAction::SetValue => ProviderComputerAction::SetValue {
            value: required_cli_option(arguments, "value")?.to_string(),
        },
        ComputerAction::Capabilities
        | ComputerAction::ListApps
        | ComputerAction::ListWindows
        | ComputerAction::GetAppState
        | ComputerAction::ApprovalCreate
        | ComputerAction::ApprovalResolve
        | ComputerAction::ApprovalList
        | ComputerAction::ActionHistory => {
            anyhow::bail!("--action must name an executable computer action")
        }
    })
}

fn resolve_computer_window(
    windows: &[WindowIdentity],
    window_selector: Option<&str>,
    app_selector: Option<&str>,
) -> Result<WindowIdentity> {
    let selector = window_selector
        .or(app_selector)
        .context("--window or --app is required")?;
    if let Ok(handle) = selector.parse::<u64>() {
        if let Some(window) = windows.iter().find(|window| window.handle == handle) {
            return Ok(window.clone());
        }
    }
    let matches = windows
        .iter()
        .filter(|window| {
            window.title.eq_ignore_ascii_case(selector)
                || window.executable_name.eq_ignore_ascii_case(selector)
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [window] => Ok((*window).clone()),
        [] => anyhow::bail!("window not found: {selector}"),
        _ => anyhow::bail!("ambiguous window selector: {selector}"),
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CliWorktreeCandidate {
    id: String,
    branch: Option<String>,
    paths: Vec<String>,
    session_id: Option<String>,
}

fn resolve_cli_worktree(
    state: &SharedState,
    registry: &WorktreeRegistry,
    worktree_selector: Option<&str>,
    workspace_selector: Option<&str>,
    caller_cwd: Option<&str>,
) -> Result<WorktreeProjection> {
    if worktree_selector.is_some() && workspace_selector.is_some() {
        anyhow::bail!("ambiguous worktree selector: --worktree and --workspace are exclusive");
    }
    let workspace_session_id = workspace_selector
        .map(|selector| resolve_cli_session(state, Some(selector)).map(|id| id.to_string()))
        .transpose()?;
    let projections = registry.list(WorktreeListRequest {
        repository_path: None,
        include_external: true,
        include_hidden: true,
    })?;
    let candidates = projections
        .iter()
        .map(|projection| {
            let mut paths = Vec::new();
            if let Some(record) = projection.record.as_ref() {
                paths.push(record.worktree_path.clone());
            }
            if let Some(native) = projection.native.as_ref() {
                if !paths
                    .iter()
                    .any(|path| crate::app::git::worktree::paths_equal(path, &native.worktree_path))
                {
                    paths.push(native.worktree_path.clone());
                }
            }
            CliWorktreeCandidate {
                id: projection.id.clone(),
                branch: projection
                    .record
                    .as_ref()
                    .map(|record| record.branch.clone())
                    .or_else(|| {
                        projection
                            .native
                            .as_ref()
                            .and_then(|native| native.branch.clone())
                    }),
                session_id: projection
                    .record
                    .as_ref()
                    .and_then(|record| record.session_id.clone()),
                paths,
            }
        })
        .collect::<Vec<_>>();
    let selected_id = select_cli_worktree_candidate(
        &candidates,
        worktree_selector,
        workspace_session_id.as_deref(),
        caller_cwd,
    )?;
    projections
        .into_iter()
        .find(|projection| projection.id == selected_id)
        .context("selected worktree projection disappeared")
}

fn select_cli_worktree_candidate(
    candidates: &[CliWorktreeCandidate],
    worktree_selector: Option<&str>,
    workspace_session_id: Option<&str>,
    caller_cwd: Option<&str>,
) -> Result<String> {
    if let Some(selector) = worktree_selector {
        let selector = selector.trim();
        if selector.is_empty() {
            anyhow::bail!("worktree selector is empty");
        }
        let stable_id = Uuid::parse_str(selector).is_ok();
        let matches = candidates
            .iter()
            .filter(|candidate| {
                candidate.id == selector
                    || (!stable_id
                        && (candidate.branch.as_deref() == Some(selector)
                            || candidate.paths.iter().any(|path| {
                                crate::app::git::worktree::paths_equal(path, selector)
                            })))
            })
            .collect::<Vec<_>>();
        return match matches.as_slice() {
            [candidate] => Ok(candidate.id.clone()),
            [] => anyhow::bail!("worktree not found: {selector}"),
            _ => anyhow::bail!("ambiguous worktree selector: {selector}"),
        };
    }
    if let Some(session_id) = workspace_session_id {
        let matches = candidates
            .iter()
            .filter(|candidate| candidate.session_id.as_deref() == Some(session_id))
            .collect::<Vec<_>>();
        return match matches.as_slice() {
            [candidate] => Ok(candidate.id.clone()),
            [] => anyhow::bail!("workspace is not bound to a worktree: {session_id}"),
            _ => anyhow::bail!("ambiguous workspace worktree binding: {session_id}"),
        };
    }
    let cwd = caller_cwd
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .context("caller cwd is unavailable; use --worktree or --workspace")?;
    let normalized_cwd = crate::app::git::worktree::normalize_path_for_comparison(cwd);
    let mut containing = candidates
        .iter()
        .flat_map(|candidate| {
            let normalized_cwd = &normalized_cwd;
            candidate.paths.iter().filter_map(move |path| {
                let normalized = crate::app::git::worktree::normalize_path_for_comparison(path);
                let contains = normalized_cwd.as_str() == normalized
                    || normalized_cwd
                        .strip_prefix(&normalized)
                        .is_some_and(|suffix| suffix.starts_with('/'));
                contains.then_some((candidate, normalized.matches('/').count(), normalized.len()))
            })
        })
        .collect::<Vec<_>>();
    containing.sort_by(|left, right| right.1.cmp(&left.1).then_with(|| right.2.cmp(&left.2)));
    let Some((selected, depth, length)) = containing.first().copied() else {
        anyhow::bail!("caller cwd is not inside a registered worktree: {cwd}");
    };
    if containing
        .iter()
        .skip(1)
        .any(|(candidate, other_depth, other_length)| {
            *other_depth == depth && *other_length == length && candidate.id != selected.id
        })
    {
        anyhow::bail!("ambiguous caller cwd worktree: {cwd}");
    }
    Ok(selected.id.clone())
}

#[cfg(test)]
mod worktree_cli_selector_tests {
    use super::*;

    fn candidate(id: &str, path: &str, session_id: Option<&str>) -> CliWorktreeCandidate {
        CliWorktreeCandidate {
            id: id.to_string(),
            branch: None,
            paths: vec![path.to_string()],
            session_id: session_id.map(str::to_string),
        }
    }

    #[test]
    fn caller_cwd_uses_deepest_containing_checkout_without_focus_fallback() {
        let candidates = vec![
            candidate("root", "C:/repo", Some("root-session")),
            candidate("child", "C:/repo/children/task", Some("child-session")),
        ];
        assert_eq!(
            select_cli_worktree_candidate(
                &candidates,
                None,
                None,
                Some("C:/repo/children/task/src")
            )
            .expect("deepest checkout"),
            "child"
        );
        assert!(
            select_cli_worktree_candidate(&candidates, None, None, Some("C:/elsewhere"))
                .expect_err("no focus fallback")
                .to_string()
                .contains("not inside")
        );
    }

    #[test]
    fn exact_and_workspace_selectors_reject_ambiguity() {
        let mut first = candidate("one", "C:/one", Some("shared"));
        first.branch = Some("feature".to_string());
        let mut second = candidate("two", "C:/two", Some("shared"));
        second.branch = Some("feature".to_string());
        let candidates = vec![first, second];
        assert!(
            select_cli_worktree_candidate(&candidates, Some("feature"), None, None)
                .expect_err("ambiguous exact branch")
                .to_string()
                .contains("ambiguous")
        );
        assert!(
            select_cli_worktree_candidate(&candidates, None, Some("shared"), None)
                .expect_err("ambiguous binding")
                .to_string()
                .contains("ambiguous")
        );
    }
}

fn resolve_cli_session(state: &SharedState, selector: Option<&str>) -> Result<Uuid> {
    let selector = selector
        .map(str::to_string)
        .or_else(|| std::env::var("VIBELINK_SESSION_ID").ok())
        .context("workspace selector is required")?;
    let sessions = lock_state(state).list_sessions();
    if let Ok(id) = Uuid::parse_str(&selector) {
        if sessions.iter().any(|session| session.id == id) {
            return Ok(id);
        }
    }
    let matches = sessions
        .iter()
        .filter(|session| session.name.eq_ignore_ascii_case(&selector))
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [session] => Ok(session.id),
        [] => anyhow::bail!("workspace not found: {selector}"),
        _ => anyhow::bail!("ambiguous workspace selector: {selector}"),
    }
}

fn resolve_cli_pane(panes: &[crate::protocol::PaneMeta], selector: Option<&str>) -> Result<Uuid> {
    let selector = selector
        .map(str::to_string)
        .or_else(|| std::env::var("VIBELINK_PANE_ID").ok())
        .context("pane selector is required")?;
    if let Ok(id) = Uuid::parse_str(&selector) {
        if panes.iter().any(|pane| pane.id == id) {
            return Ok(id);
        }
    }
    let matches = panes
        .iter()
        .filter(|pane| {
            pane.config
                .title
                .as_deref()
                .is_some_and(|title| title.eq_ignore_ascii_case(&selector))
        })
        .collect::<Vec<_>>();
    match matches.as_slice() {
        [pane] => Ok(pane.id),
        [] => anyhow::bail!("pane not found: {selector}"),
        _ => anyhow::bail!("ambiguous pane selector: {selector}"),
    }
}

fn cli_option<'a>(
    arguments: &'a crate::dedicated_cli::OperationArguments,
    name: &str,
) -> Result<Option<&'a str>> {
    let values = match arguments.options.get(name) {
        Some(values) => values,
        None => return Ok(None),
    };
    match values.as_slice() {
        [value] => Ok(Some(value.as_str())),
        _ => anyhow::bail!("--{name} must be supplied exactly once"),
    }
}

fn required_cli_option<'a>(
    arguments: &'a crate::dedicated_cli::OperationArguments,
    name: &str,
) -> Result<&'a str> {
    cli_option(arguments, name)?.with_context(|| format!("--{name} is required"))
}

fn dispatch_message(
    state: SharedState,
    sessions_path: &Path,
    client_id: Uuid,
    tx: &Sender<DaemonToClient>,
    control: Arc<ControlPlane>,
    coordinator: Arc<CoordinatorService>,
    worktree_registry: Arc<WorktreeRegistry>,
    worktree_lifecycle: Arc<WorktreeLifecycleService>,
    worktrees: Arc<WorktreeManager>,
    automation: Arc<AutomationService>,
    remote: Arc<RemoteServer>,
    computer: SharedComputerHost,
    msg: ClientToDaemon,
    shutdown: &Arc<AtomicBool>,
) -> Result<()> {
    match msg {
        ClientToDaemon::Hello { .. } => Ok(()),
        ClientToDaemon::Authenticate { req, .. } => send(
            tx,
            DaemonToClient::Reply {
                req,
                result: ReplyResult::Ok,
            },
        ),
        ClientToDaemon::RegisterBrowserHost => {
            register_browser_host(client_id, tx.clone());
            Ok(())
        }
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
        ClientToDaemon::RemoteWorkspaceProjection { req, workspace_id } => {
            let pane_ids = workspace_id
                .map(|workspace_id| {
                    lock_state(&state).pane_metas(workspace_id).map(|panes| {
                        panes
                            .into_iter()
                            .map(|pane| pane.id.to_string())
                            .collect::<Vec<_>>()
                    })
                })
                .transpose()?
                .unwrap_or_default();
            let pane_states = coordinator.pane_projection_states(&pane_ids)?;
            let projection = {
                let mut guard = lock_state(&state);
                let projection = guard.remote_workspace_projection(workspace_id, &pane_states)?;
                if let Some(workspace_id) = workspace_id {
                    guard.attach_client_to_session(client_id, workspace_id);
                }
                projection
            };
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::RemoteWorkspaceProjection(projection),
                },
            )
        }
        ClientToDaemon::SetDesktopSelection { req, selection } => {
            let affected = lock_state(&state).set_desktop_selection(selection)?;
            send_ok(tx, req)?;
            for session_id in affected {
                notify_session_changed(&state, session_id)?;
            }
            Ok(())
        }
        ClientToDaemon::CreateSession {
            req,
            name,
            workspace_folder,
        } => {
            let meta = lock_state(&state).create_session(name, workspace_folder);
            let session_id = meta.id;
            persist_state(&state, sessions_path)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::SessionCreated(meta),
                },
            )?;
            notify_session_changed(&state, session_id)
        }
        ClientToDaemon::RenameSession {
            req,
            session_id,
            name,
        } => {
            lock_state(&state).rename_session(session_id, name)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            notify_session_changed(&state, session_id)
        }
        ClientToDaemon::SetSessionWorkspaceFolder {
            req,
            session_id,
            workspace_folder,
        } => {
            lock_state(&state).set_session_workspace_folder(session_id, workspace_folder)?;
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            notify_session_changed(&state, session_id)
        }
        ClientToDaemon::DeleteSession { req, session_id } => {
            let (panes, lease_transitions) = {
                let mut guard = lock_state(&state);
                let panes = guard.delete_session(session_id)?;
                let lease_transitions =
                    guard.cleanup_remote_pane_leases_on_exit(panes.iter().map(|pane| pane.id));
                (panes, lease_transitions)
            };
            process_pane_lease_transitions(&state, lease_transitions);
            persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            notify_session_changed(&state, session_id)?;
            if let Err(error) = remove_session_history(sessions_path, session_id) {
                warn!(?error, %session_id, "failed to remove deleted workspace history");
            }
            for mut pane in panes {
                let pane_id = pane.id;
                let sessions_path = sessions_path.to_path_buf();
                thread::Builder::new()
                    .name(format!("vibelink-close-pty-{pane_id}"))
                    .spawn(move || {
                        if let Err(err) = pane.kill() {
                            warn!(?err, %pane_id, "failed to kill deleted pane");
                        }
                        if let Err(error) = remove_pane_history(&sessions_path, session_id, pane_id)
                        {
                            warn!(?error, %pane_id, "failed to remove deleted pane history");
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
                // The workspace is live again, so a later crash must restore
                // it even though the previous run exited cleanly.
                state.clear_clean_exit(session_id);
                attached
            };
            debounce_persist_state(&state, sessions_path)?;
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
            debounce_persist_state(&state, sessions_path)?;
            notify_session_changed(&state, session_id)
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
            )?;
            notify_session_changed(&state, session_id)
        }
        ClientToDaemon::AttachPane {
            session_id,
            pane_id,
        } => {
            info!(%client_id, %session_id, %pane_id, "attaching pane");
            lock_state(&state).attach_pane(client_id, session_id, pane_id)?;
            Ok(())
        }
        ClientToDaemon::SubscribePane {
            req,
            session_id,
            pane_id,
        } => {
            info!(%client_id, %session_id, %pane_id, "subscribing pane atomically");
            let snapshot = lock_state(&state).subscribe_pane(client_id, session_id, pane_id)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::TerminalSnapshot(snapshot),
                },
            )
        }
        ClientToDaemon::DetachPane {
            session_id,
            pane_id,
        } => {
            lock_state(&state).detach_pane(client_id, session_id, pane_id)?;
            Ok(())
        }
        ClientToDaemon::WritePane {
            session_id,
            pane_id,
            data,
            origin,
        } => {
            write_pane_authorized(&state, session_id, pane_id, &data, &origin)?;
            Ok(())
        }
        ClientToDaemon::ResizePane {
            session_id,
            pane_id,
            cols,
            rows,
            origin,
        } => {
            resize_pane_authorized(&state, session_id, pane_id, cols, rows, &origin)?;
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
            send_ok(tx, req)?;
            notify_session_changed(&state, session_id)
        }
        ClientToDaemon::SetPaneRole {
            req,
            session_id,
            pane_id,
            role,
        } => {
            lock_state(&state).set_pane_role(session_id, pane_id, role)?;
            debounce_persist_state(&state, sessions_path)?;
            send_ok(tx, req)?;
            notify_session_changed(&state, session_id)
        }
        ClientToDaemon::ClosePane {
            req,
            session_id,
            pane_id,
        } => {
            let (pane, lease_transition) = {
                let mut guard = lock_state(&state);
                let pane = guard.close_pane(session_id, pane_id)?;
                let lease = guard.cleanup_remote_pane_lease_on_exit(pane_id);
                (pane, lease)
            };
            if let Some(transition) = lease_transition {
                process_pane_lease_transition(&state, transition);
            }
            persist_state(&state, sessions_path)?;
            notify_session_changed(&state, session_id)?;
            send_ok(tx, req)?;
            if let Some(mut pane) = pane {
                let sessions_path = sessions_path.to_path_buf();
                thread::Builder::new()
                    .name(format!("vibelink-close-pty-{pane_id}"))
                    .spawn(move || {
                        if let Err(err) = pane.kill() {
                            warn!(?err, pane_id = %pane_id, "failed to kill closed pane");
                        }
                        if let Err(error) = remove_pane_history(&sessions_path, session_id, pane_id)
                        {
                            warn!(?error, %pane_id, "failed to remove closed pane history");
                        }
                    })?;
            }
            Ok(())
        }
        ClientToDaemon::ClearSession { req, session_id } => {
            let (panes, lease_transitions) = {
                let mut guard = lock_state(&state);
                let panes = guard.close_session_panes(session_id)?;
                let lease_transitions =
                    guard.cleanup_remote_pane_leases_on_exit(panes.iter().map(|pane| pane.id));
                (panes, lease_transitions)
            };
            process_pane_lease_transitions(&state, lease_transitions);
            persist_state(&state, sessions_path)?;
            notify_session_changed(&state, session_id)?;
            send_ok(tx, req)?;
            for mut pane in panes {
                let pane_id = pane.id;
                let sessions_path = sessions_path.to_path_buf();
                thread::Builder::new()
                    .name(format!("vibelink-close-pty-{pane_id}"))
                    .spawn(move || {
                        if let Err(err) = pane.kill() {
                            warn!(?err, pane_id = %pane_id, "failed to kill cleared pane");
                        }
                        if let Err(error) = remove_pane_history(&sessions_path, session_id, pane_id)
                        {
                            warn!(?error, %pane_id, "failed to remove cleared pane history");
                        }
                    })?;
            }
            if let Err(error) = remove_session_history(sessions_path, session_id) {
                warn!(?error, %session_id, "failed to remove cleared workspace history");
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
        ClientToDaemon::Control {
            req,
            operation_id,
            command_json,
        } => {
            let command: ControlCommand =
                serde_json::from_str(&command_json).context("parse control command")?;
            let response = control.execute(operation_id, command)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Control(serde_json::to_string(&response)?),
                },
            )
        }
        ClientToDaemon::Worktree {
            req,
            operation_id,
            method,
            payload_json,
        } => {
            let response = dispatch_worktree_request(
                &state,
                &worktree_registry,
                &worktree_lifecycle,
                sessions_path,
                operation_id,
                &method,
                &payload_json,
            )?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Worktree(serde_json::to_string(&response)?),
                },
            )
        }
        ClientToDaemon::Orchestration {
            req,
            operation_id,
            method,
            payload_json,
        } => send(
            tx,
            DaemonToClient::Reply {
                req,
                result: ReplyResult::Orchestration(orchestration_rpc_response(
                    &state,
                    sessions_path,
                    &coordinator,
                    &worktree_registry,
                    &worktree_lifecycle,
                    &worktrees,
                    operation_id,
                    &method,
                    &payload_json,
                )),
            },
        ),
        ClientToDaemon::Cli {
            req,
            operation_id,
            request_json,
        } => {
            let response = dispatch_cli_request(
                &state,
                sessions_path,
                &control,
                &worktree_registry,
                &worktree_lifecycle,
                &coordinator,
                &worktrees,
                &automation,
                &remote,
                &computer,
                operation_id,
                &request_json,
            )?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Cli(serde_json::to_string(&response)?),
                },
            )
        }
        ClientToDaemon::Computer {
            req,
            operation_id,
            request_json,
        } => {
            let request: HostRequest =
                serde_json::from_str(&request_json).context("parse computer-use request")?;
            match &request {
                HostRequest::Snapshot { request } if request.operation_id != operation_id => {
                    anyhow::bail!("conflict: computer snapshot operation id mismatch")
                }
                HostRequest::Action { request } if request.operation_id != operation_id => {
                    anyhow::bail!("conflict: computer action operation id mismatch")
                }
                _ => {}
            }
            let response = request_computer_host(&computer, operation_id, request)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Computer(serde_json::to_string(&response)?),
                },
            )
        }
        ClientToDaemon::Remote { req, request_json } => {
            let response = dispatch_remote_request(&state, &remote, &request_json)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Remote(serde_json::to_string(&response)?),
                },
            )
        }
        ClientToDaemon::RemoteBrowser {
            req,
            operation_id,
            method,
            payload_json,
        } => {
            let response = dispatch_browser_host_request(operation_id, method, payload_json)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Browser(response),
                },
            )
        }
        ClientToDaemon::RemoteBrowserResponse { response } => {
            resolve_browser_host_response(client_id, response)
        }
        ClientToDaemon::RemotePaneLeaseClaim { req, request } => {
            let transition = lock_state(&state)
                .claim_or_update_remote_pane_lease(request, orchestration_now_millis())?;
            send_pane_lease_transition(&state, tx, req, transition)
        }
        ClientToDaemon::RemotePaneLeaseRenew { req, request } => {
            let transition =
                lock_state(&state).renew_remote_pane_lease(request, orchestration_now_millis())?;
            send_pane_lease_transition(&state, tx, req, transition)
        }
        ClientToDaemon::RemotePaneLeaseRelease { req, request } => {
            let transition = lock_state(&state).release_remote_pane_lease(request)?;
            send_pane_lease_transition(&state, tx, req, transition)
        }
        ClientToDaemon::RemotePaneLeaseStatus { req, request } => {
            let result =
                lock_state(&state).remote_pane_lease_status(request, orchestration_now_millis());
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::RemotePaneLease(result),
                },
            )
        }
        ClientToDaemon::RemotePaneLeaseAdminReclaim { req, request } => {
            let transition = lock_state(&state).admin_reclaim_remote_pane_lease(request)?;
            send_pane_lease_transition(&state, tx, req, transition)
        }
        ClientToDaemon::RemoteConnectionCleanup { req, request } => {
            let transitions = lock_state(&state).cleanup_remote_connection_leases(request);
            send_remote_connection_cleanup(&state, tx, req, transitions)
        }
        ClientToDaemon::ResourceSnapshot { req } => {
            let daemon_pid = std::process::id();
            let targets = lock_state(&state).resource_targets();
            let mut sys = sysinfo::System::new();
            sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
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
        ClientToDaemon::AttentionSnapshot { req } => {
            let pane_ids = lock_state(&state)
                .resource_targets()
                .into_iter()
                .map(|(_, pane_id, _)| pane_id.to_string())
                .collect::<Vec<_>>();
            let pane_states = coordinator.pane_projection_states(&pane_ids)?;
            let snapshot = lock_state(&state).attention_snapshot(&pane_states);
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::AttentionSnapshot(snapshot),
                },
            )
        }
        ClientToDaemon::Shutdown { req, clean_exit } => {
            info!(clean_exit, "daemon received shutdown request");
            send_ok(tx, req)?;
            shutdown.store(true, Ordering::Release);

            if clean_exit {
                // Deliberate quit: record it BEFORE the final persist so the
                // next start treats these workspaces as already closed.
                lock_state(&state).mark_clean_exit();
            }
            info!("daemon shutting down, preserving restorable panes");
            if let Err(err) = persist_restorable_panes_and_kill_all(&state, sessions_path) {
                warn!(?err, "failed to persist state during shutdown");
            }

            if let Ok(paths) = paths::daemon_paths() {
                let _ = fs::remove_file(paths.pid);
            }
            // Exit the process to unblock the main thread's accept() loop
            std::process::exit(0);
        }
    }
}

fn dispatch_worktree_request(
    state: &SharedState,
    registry: &WorktreeRegistry,
    lifecycle: &WorktreeLifecycleService,
    sessions_path: &Path,
    operation_id: Uuid,
    method: &str,
    payload_json: &str,
) -> Result<Value> {
    let response = dispatch_worktree_request_inner(
        state,
        registry,
        lifecycle,
        sessions_path,
        operation_id,
        method,
        payload_json,
    )?;
    if matches!(
        method,
        WORKTREE_METHOD_RECONCILE
            | WORKTREE_METHOD_IMPORT
            | WORKTREE_METHOD_CREATE
            | WORKTREE_METHOD_MOVE
            | WORKTREE_METHOD_REMOVE
            | WORKTREE_METHOD_SET
            | WORKTREE_METHOD_CHECKPOINT
            | WORKTREE_METHOD_REVIEW_COMMENT_PUT
    ) {
        for sender in lock_state(state).all_senders() {
            let _ = sender.send(DaemonToClient::WorktreeChanged {
                method: method.to_string(),
                operation_id,
            });
        }
    }
    Ok(response)
}

fn import_external_worktree(
    state: &SharedState,
    registry: &WorktreeRegistry,
    sessions_path: &Path,
    request: WorktreeImportRequest,
) -> Result<WorktreeProjection> {
    if let Some(parent_session_id) = request.parent_session_id.as_deref() {
        let parent_session_id =
            Uuid::parse_str(parent_session_id).context("parse import parent session id")?;
        if !lock_state(state)
            .list_sessions()
            .iter()
            .any(|session| session.id == parent_session_id)
        {
            anyhow::bail!("parent workspace session not found");
        }
    }

    let mut projection = registry.import_external(request)?;
    let Some(record) = projection.record.as_ref() else {
        anyhow::bail!("imported worktree record is unavailable");
    };
    if record.session_id.is_some() {
        return Ok(projection);
    }

    let session_name = record
        .branch
        .trim()
        .rsplit('/')
        .find(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            Path::new(&record.worktree_path)
                .file_name()
                .and_then(|value| value.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Worktree".to_string());
    let session =
        lock_state(state).create_session(session_name, Some(record.worktree_path.clone()));
    if let Err(error) = persist_state(state, sessions_path) {
        let _ = lock_state(state).delete_session(session.id);
        return Err(error.context("persist imported worktree session"));
    }

    let bound = match registry.bind_session(
        &record.id,
        &record.instance_id,
        &session.id.to_string(),
    ) {
        Ok(bound) => bound,
        Err(error) => {
            let _ = lock_state(state).delete_session(session.id);
            if let Err(rollback_error) = persist_state(state, sessions_path) {
                return Err(error.context(format!(
                    "bind imported worktree session; session rollback also failed: {rollback_error:#}"
                )));
            }
            return Err(error.context("bind imported worktree session"));
        }
    };
    projection.record = Some(bound);
    notify_session_changed(state, session.id)?;
    Ok(projection)
}

fn dispatch_worktree_request_inner(
    state: &SharedState,
    registry: &WorktreeRegistry,
    lifecycle: &WorktreeLifecycleService,
    sessions_path: &Path,
    operation_id: Uuid,
    method: &str,
    payload_json: &str,
) -> Result<Value> {
    match method {
        WORKTREE_METHOD_CANCEL => {
            let request: WorktreeOperationIdRequest =
                serde_json::from_str(payload_json).context("parse worktree cancel request")?;
            Ok(serde_json::to_value(
                registry.request_cancel(request.operation_id)?,
            )?)
        }
        WORKTREE_METHOD_LIST => Ok(serde_json::to_value(
            registry.list(
                serde_json::from_str::<WorktreeListRequest>(payload_json)
                    .context("parse worktree list request")?,
            )?,
        )?),
        WORKTREE_METHOD_RECONCILE => Ok(serde_json::to_value(
            registry.reconcile(
                serde_json::from_str::<WorktreeReconcileRequest>(payload_json)
                    .context("parse worktree reconcile request")?,
            )?,
        )?),
        WORKTREE_METHOD_IMPORT => {
            let request = serde_json::from_str::<WorktreeImportRequest>(payload_json)
                .context("parse worktree import request")?;
            Ok(serde_json::to_value(import_external_worktree(
                state,
                registry,
                sessions_path,
                request,
            )?)?)
        }
        WORKTREE_METHOD_SET => Ok(serde_json::to_value(
            registry.set(
                serde_json::from_str::<WorktreeSetRequest>(payload_json)
                    .context("parse worktree metadata request")?,
            )?,
        )?),
        WORKTREE_METHOD_CHECKPOINT => Ok(serde_json::to_value(
            registry.checkpoint(
                serde_json::from_str::<WorktreeCheckpointRequest>(payload_json)
                    .context("parse worktree checkpoint request")?,
            )?,
        )?),
        WORKTREE_METHOD_CHECKPOINTS => {
            let request: WorktreeIdRequest =
                serde_json::from_str(payload_json).context("parse worktree checkpoints request")?;
            Ok(serde_json::to_value(
                registry.list_checkpoints(&request.worktree_id)?,
            )?)
        }
        WORKTREE_METHOD_REVIEW_COMMENT_PUT => Ok(serde_json::to_value(
            registry.put_review_comment(
                serde_json::from_str::<WorktreeReviewCommentRequest>(payload_json)
                    .context("parse worktree review comment request")?,
            )?,
        )?),
        WORKTREE_METHOD_REVIEW_COMMENTS => {
            let request: WorktreeIdRequest = serde_json::from_str(payload_json)
                .context("parse worktree review comments request")?;
            Ok(serde_json::to_value(
                registry.list_review_comments(&request.worktree_id)?,
            )?)
        }
        WORKTREE_METHOD_PREFLIGHT_REMOVE => {
            let request: WorktreeRemovalPreflightRequest = serde_json::from_str(payload_json)
                .context("parse worktree removal preflight request")?;
            let runtime = worktree_runtime_blockers(state, registry, &request.worktree_id)?;
            Ok(serde_json::to_value(
                registry.removal_preflight(&request, runtime)?,
            )?)
        }
        WORKTREE_METHOD_CREATE => {
            let request: WorktreeCreateRequest =
                serde_json::from_str(payload_json).context("parse worktree create request")?;
            if request.operation_id != operation_id {
                anyhow::bail!("worktree create operation id mismatch");
            }
            let parent_session_id =
                Uuid::parse_str(&request.parent_session_id).context("parse parent session id")?;
            if !lock_state(state)
                .list_sessions()
                .iter()
                .any(|session| session.id == parent_session_id)
            {
                anyhow::bail!("parent workspace session not found");
            }
            let session_name = request.name.clone();
            let headless_launch =
                matches!(request.origin, WorktreeOrigin::Cli | WorktreeOrigin::Mcp);
            let profile_id = request.profile_id.clone();
            let initial_agent = request.initial_agent.clone();
            let initial_prompt = request.initial_prompt.clone();
            let result = lifecycle.create(
                request,
                |record| {
                    let session = lock_state(state)
                        .create_session(session_name, Some(record.worktree_path.clone()));
                    if headless_launch {
                        let (config, agent_profile) = worktree_initial_pane_config(
                            &record.worktree_path,
                            profile_id.as_deref(),
                            initial_agent.as_deref(),
                            initial_prompt.is_some(),
                        )?;
                        let pane = spawn_pane_for_session(
                            Arc::clone(state),
                            sessions_path.to_path_buf(),
                            session.id,
                            config,
                            None,
                        )?;
                        if let Some(prompt) = initial_prompt.as_deref() {
                            if !agent_profile {
                                anyhow::bail!("an initial prompt requires an agent profile");
                            }
                            let mut input = prompt.trim().as_bytes().to_vec();
                            input.push(b'\r');
                            write_pane_authorized(
                                state,
                                session.id,
                                pane.id,
                                &input,
                                &PaneCommandOrigin::Desktop,
                            )?;
                        }
                    }
                    persist_state(state, sessions_path)?;
                    notify_session_changed(state, session.id)?;
                    Ok(session.id.to_string())
                },
                |session_id| remove_worktree_session(state, sessions_path, session_id).map(|_| ()),
            )?;
            Ok(serde_json::to_value(result)?)
        }
        WORKTREE_METHOD_MOVE => {
            let request: WorktreeMoveRequest =
                serde_json::from_str(payload_json).context("parse worktree move request")?;
            if request.operation_id != operation_id {
                anyhow::bail!("worktree move operation id mismatch");
            }
            let result = lifecycle.move_checkout(request)?;
            if let Some(session_id) = result.worktree.session_id.as_deref() {
                let session_id =
                    Uuid::parse_str(session_id).context("parse moved worktree session id")?;
                lock_state(state).set_session_workspace_folder(
                    session_id,
                    result.worktree.worktree_path.clone(),
                )?;
                persist_state(state, sessions_path)?;
                notify_session_changed(state, session_id)?;
            }
            Ok(serde_json::to_value(result)?)
        }
        WORKTREE_METHOD_REMOVE => {
            let request: WorktreeRemoveRequest =
                serde_json::from_str(payload_json).context("parse worktree remove request")?;
            if request.operation_id != operation_id {
                anyhow::bail!("worktree remove operation id mismatch");
            }
            Ok(serde_json::to_value(execute_shared_worktree_removal(
                state,
                registry,
                lifecycle,
                sessions_path,
                request,
            )?)?)
        }
        _ => anyhow::bail!("unsupported worktree method {method} for operation {operation_id}"),
    }
}

fn worktree_initial_pane_config(
    worktree_path: &str,
    profile_id: Option<&str>,
    initial_agent: Option<&str>,
    has_prompt: bool,
) -> Result<(PaneConfig, bool)> {
    let selected = initial_agent
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .or_else(|| profile_id.map(str::trim).filter(|value| !value.is_empty()))
        .unwrap_or(if has_prompt { "omp" } else { "default" });
    let pane_id = Uuid::new_v4();
    let (shell, args, title, icon, agent_profile) = match selected {
        "default" | "powershell" => (
            "pwsh.exe".to_string(),
            vec!["-NoLogo".to_string()],
            "PowerShell".to_string(),
            "powershell".to_string(),
            false,
        ),
        "cmd" => (
            "cmd.exe".to_string(),
            vec!["/D".to_string()],
            "CMD".to_string(),
            "square-terminal".to_string(),
            false,
        ),
        "claude" | "codex" | "omp" => {
            let reset =
                "`e[?1049l`e[2J`e[3J`e[H`e[?25h`e[?1000l`e[?1002l`e[?1003l`e[?1006l`e[?2004l`e[0m";
            (
                "pwsh.exe".to_string(),
                vec![
                    "-NoLogo".to_string(),
                    "-NoExit".to_string(),
                    "-Command".to_string(),
                    format!(
                        "try {{ & {selected} }} finally {{ [Console]::Out.Write(\"{reset}\") }}"
                    ),
                ],
                selected.to_string(),
                selected.to_string(),
                true,
            )
        }
        _ => anyhow::bail!("headless worktree create cannot resolve profile: {selected}"),
    };
    Ok((
        PaneConfig {
            pane_id,
            shell: Some(shell),
            args,
            cwd: Some(worktree_path.to_string()),
            env: Vec::new(),
            title: Some(title),
            icon: Some(icon),
            profile_id: Some(selected.to_string()),
            role: agent_profile.then(|| "agent".to_string()),
            cols: 120,
            rows: 32,
            restore_on_start: false,
        },
        agent_profile,
    ))
}

fn execute_shared_worktree_removal(
    state: &SharedState,
    registry: &WorktreeRegistry,
    lifecycle: &WorktreeLifecycleService,
    sessions_path: &Path,
    request: WorktreeRemoveRequest,
) -> Result<WorktreeRemovalResult> {
    let runtime = worktree_runtime_blockers(state, registry, &request.worktree_id)?;
    lifecycle.remove(
        request,
        runtime,
        |record| cleanup_worktree_session_resources(state, sessions_path, record),
        |session_id| remove_worktree_session(state, sessions_path, session_id),
    )
}

fn worktree_runtime_blockers(
    state: &SharedState,
    registry: &WorktreeRegistry,
    worktree_id: &str,
) -> Result<WorktreeRuntimeBlockers> {
    let record = registry.record(worktree_id)?;
    Ok(record
        .session_id
        .as_deref()
        .and_then(|id| Uuid::parse_str(id).ok())
        .map(|session_id| {
            let guard = lock_state(state);
            WorktreeRuntimeBlockers {
                live_session: guard
                    .list_sessions()
                    .iter()
                    .any(|session| session.id == session_id),
                live_panes: guard
                    .pane_metas(session_id)
                    .map(|panes| !panes.is_empty())
                    .unwrap_or(false),
            }
        })
        .unwrap_or_default())
}

fn cleanup_worktree_session_resources(
    state: &SharedState,
    sessions_path: &Path,
    record: &crate::app::git::worktree_registry::WorktreeRecord,
) -> Result<()> {
    let Some(session_id) = record.session_id.as_deref() else {
        return Ok(());
    };
    let session_id = Uuid::parse_str(session_id).context("parse bound worktree session id")?;
    let pane_ids = {
        let guard = lock_state(state);
        if !guard
            .list_sessions()
            .iter()
            .any(|session| session.id == session_id)
        {
            return Ok(());
        }
        guard
            .pane_metas(session_id)?
            .into_iter()
            .map(|pane| pane.id)
            .collect::<Vec<_>>()
    };
    for pane_id in &pane_ids {
        if !kill_pane_processes_until_exit(*pane_id) {
            anyhow::bail!("pane {pane_id} process tree remained alive during worktree cleanup");
        }
    }
    let panes = lock_state(state).close_session_panes(session_id)?;
    let mut failures = Vec::new();
    for mut pane in panes {
        if let Err(error) = pane.kill() {
            failures.push(error.to_string());
        }
    }
    if !failures.is_empty() {
        anyhow::bail!(
            "failed to terminate worktree panes: {}",
            failures.join("; ")
        );
    }
    persist_state(state, sessions_path)?;
    notify_session_changed(state, session_id)?;
    Ok(())
}

fn remove_worktree_session(
    state: &SharedState,
    sessions_path: &Path,
    session_id: &str,
) -> Result<bool> {
    let session_id = Uuid::parse_str(session_id).context("parse bound worktree session id")?;
    let exists = lock_state(state)
        .list_sessions()
        .iter()
        .any(|session| session.id == session_id);
    if !exists {
        return Ok(false);
    }
    let panes = lock_state(state).delete_session(session_id)?;
    for mut pane in panes {
        pane.kill()
            .context("terminate worktree pane before checkout removal")?;
    }
    persist_state(state, sessions_path)?;
    notify_session_changed(state, session_id)?;
    Ok(true)
}

fn dispatch_remote_request(
    state: &SharedState,
    remote: &RemoteServer,
    request_json: &str,
) -> Result<Value> {
    let request: Value = serde_json::from_str(request_json).context("parse remote request")?;
    let action = request
        .get("action")
        .and_then(Value::as_str)
        .context("remote action is required")?;
    match action {
        "status" => Ok(serde_json::to_value(remote.status())?),
        "setEnabled" => Ok(serde_json::to_value(
            remote.set_enabled(
                request
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .context("enabled is required")?,
            )?,
        )?),
        "setPort" => Ok(serde_json::to_value(
            remote.set_port(
                request
                    .get("port")
                    .and_then(Value::as_u64)
                    .and_then(|value| u16::try_from(value).ok())
                    .context("valid port is required")?,
            )?,
        )?),
        "setLanEnabled" => Ok(serde_json::to_value(
            remote.set_lan_enabled(
                request
                    .get("lanEnabled")
                    .and_then(Value::as_bool)
                    .context("lanEnabled is required")?,
            )?,
        )?),
        "createPairing" => Ok(serde_json::to_value(remote.create_pairing()?)?),
        "createPairingV2" => Ok(serde_json::to_value(remote.create_pairing_v2()?)?),
        "revokeDevice" => {
            let device_id = request
                .get("deviceId")
                .and_then(Value::as_str)
                .context("deviceId is required")?;
            remote.revoke_device(device_id)?;
            Ok(Value::Null)
        }
        "regenerateIdentity" => Ok(serde_json::to_value(remote.regenerate_identity()?)?),
        "paneLease" => {
            let pane_id = request
                .get("paneId")
                .and_then(Value::as_str)
                .context("paneId is required")?;
            let pane_id = Uuid::parse_str(pane_id).context("paneId must be a UUID")?;
            let result = lock_state(state).remote_pane_lease_status(
                RemotePaneLeaseStatusRequest { pane_id },
                orchestration_now_millis(),
            );
            Ok(serde_json::to_value(remote_pane_lease_status_response(
                result,
            )?)?)
        }
        "setAppearance" => {
            let appearance = request.get("appearance").cloned().unwrap_or(Value::Null);
            let workspace_order = serde_json::from_value(
                request
                    .get("workspaceOrder")
                    .cloned()
                    .unwrap_or_else(|| json!([])),
            )?;
            let workspace_alerts = serde_json::from_value(
                request
                    .get("workspaceAlerts")
                    .cloned()
                    .unwrap_or_else(|| json!({})),
            )?;
            remote.set_appearance(appearance, workspace_order, workspace_alerts);
            Ok(Value::Null)
        }
        _ => anyhow::bail!("unsupported remote action: {action}"),
    }
}

fn remote_pane_lease_status_response(
    result: RemotePaneLeaseResult,
) -> Result<Option<RemotePaneLeaseStatus>> {
    match result {
        RemotePaneLeaseResult::Status { lease } => Ok(lease.map(|lease| RemotePaneLeaseStatus {
            session_id: lease.session_id.to_string(),
            pane_id: lease.pane_id.to_string(),
            device_id: lease.device_id,
            cols: lease.target_cols,
            rows: lease.target_rows,
            expires_at: lease.expires_at,
        })),
        other => anyhow::bail!("unexpected remote pane lease status result: {other:?}"),
    }
}

fn request_id(msg: &ClientToDaemon) -> Option<crate::protocol::Req> {
    match msg {
        ClientToDaemon::Authenticate { req, .. }
        | ClientToDaemon::Ping { req }
        | ClientToDaemon::ListSessions { req }
        | ClientToDaemon::RemoteWorkspaceProjection { req, .. }
        | ClientToDaemon::SetDesktopSelection { req, .. }
        | ClientToDaemon::CreateSession { req, .. }
        | ClientToDaemon::RenameSession { req, .. }
        | ClientToDaemon::SetSessionWorkspaceFolder { req, .. }
        | ClientToDaemon::DeleteSession { req, .. }
        | ClientToDaemon::AttachSession { req, .. }
        | ClientToDaemon::SpawnPane { req, .. }
        | ClientToDaemon::SubscribePane { req, .. }
        | ClientToDaemon::SetPaneTitle { req, .. }
        | ClientToDaemon::SetPaneRole { req, .. }
        | ClientToDaemon::ClosePane { req, .. }
        | ClientToDaemon::ClearSession { req, .. }
        | ClientToDaemon::GetScrollback { req, .. }
        | ClientToDaemon::TaskEvent { req, .. }
        | ClientToDaemon::Control { req, .. }
        | ClientToDaemon::Worktree { req, .. }
        | ClientToDaemon::Orchestration { req, .. }
        | ClientToDaemon::Cli { req, .. }
        | ClientToDaemon::Computer { req, .. }
        | ClientToDaemon::Remote { req, .. }
        | ClientToDaemon::RemoteBrowser { req, .. }
        | ClientToDaemon::RemotePaneLeaseClaim { req, .. }
        | ClientToDaemon::RemotePaneLeaseRenew { req, .. }
        | ClientToDaemon::RemotePaneLeaseRelease { req, .. }
        | ClientToDaemon::RemotePaneLeaseStatus { req, .. }
        | ClientToDaemon::RemotePaneLeaseAdminReclaim { req, .. }
        | ClientToDaemon::RemoteConnectionCleanup { req, .. }
        | ClientToDaemon::ResourceSnapshot { req }
        | ClientToDaemon::AttentionSnapshot { req }
        | ClientToDaemon::Shutdown { req, .. } => Some(*req),
        ClientToDaemon::Hello { .. }
        | ClientToDaemon::RegisterBrowserHost
        | ClientToDaemon::RemoteBrowserResponse { .. }
        | ClientToDaemon::DetachSession { .. }
        | ClientToDaemon::SaveLayout { .. }
        | ClientToDaemon::AttachPane { .. }
        | ClientToDaemon::DetachPane { .. }
        | ClientToDaemon::WritePane { .. }
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
    let stop = Arc::new(AtomicBool::new(false));
    let thread_dirty = Arc::clone(&dirty);
    let thread_stop = Arc::clone(&stop);
    let thread_state = Arc::clone(state);
    let thread_sessions_path = sessions_path.to_path_buf();
    let handle = thread::Builder::new()
        .name("vibelink-daemon-persister".to_string())
        .spawn(move || loop {
            thread::sleep(PERSIST_DEBOUNCE_INTERVAL);
            if thread_stop.load(Ordering::Acquire) {
                break;
            }
            if thread_dirty.swap(false, Ordering::AcqRel) {
                if let Err(err) = persist_state(&thread_state, &thread_sessions_path) {
                    warn!(?err, "failed to persist debounced state");
                }
            }
        })?;
    *persister = Some(DebouncedPersister {
        dirty,
        stop,
        handle,
    });
    Ok(())
}

fn stop_debounced_persister() {
    let persister = lock_mutex(&DEBOUNCED_PERSISTER).take();
    if let Some(persister) = persister {
        persister.stop.store(true, Ordering::Release);
        if persister.handle.join().is_err() {
            warn!("debounced persistence thread panicked during shutdown");
        }
    }
}

fn spawn_pane_for_session(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    cfg: crate::protocol::PaneConfig,
    attach_client: Option<Uuid>,
) -> Result<crate::protocol::PaneMeta> {
    spawn_pane_for_session_internal(
        state,
        sessions_path,
        session_id,
        cfg,
        attach_client,
        None,
        None,
    )
}

fn restore_pane_for_session(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    cfg: crate::protocol::PaneConfig,
    scrollback: Vec<u8>,
) -> Result<crate::protocol::PaneMeta> {
    spawn_pane_for_session_internal(
        state,
        sessions_path,
        session_id,
        cfg,
        None,
        None,
        Some(scrollback),
    )
}

fn spawn_orchestration_pane_for_session(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    cfg: crate::protocol::PaneConfig,
    coordinator: Arc<CoordinatorService>,
) -> Result<crate::protocol::PaneMeta> {
    spawn_pane_for_session_internal(
        state,
        sessions_path,
        session_id,
        cfg,
        None,
        Some(coordinator),
        None,
    )
}

fn spawn_pane_for_session_internal(
    state: SharedState,
    sessions_path: PathBuf,
    session_id: Uuid,
    mut cfg: crate::protocol::PaneConfig,
    attach_client: Option<Uuid>,
    coordinator: Option<Arc<CoordinatorService>>,
    restored_scrollback: Option<Vec<u8>>,
) -> Result<crate::protocol::PaneMeta> {
    lock_state(&state).pane_metas(session_id)?;

    let pane_id = cfg.pane_id;
    cfg.env = pty::inject_pane_identity(std::mem::take(&mut cfg.env), session_id, pane_id);
    let spawned = match restored_scrollback {
        Some(scrollback) => Pane::spawn_restored(cfg, scrollback)?,
        None => Pane::spawn(cfg)?,
    };
    let child = spawned.pane.child();
    let reader = spawned.reader;
    let history_snapshot = spawned
        .pane
        .config
        .restore_on_start
        .then(|| spawned.pane.scrollback_snapshot());
    let (meta, generation) = {
        let mut guard = lock_state(&state);
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
        if let Some(client_id) = attach_client {
            guard.attach_client_to_pane(client_id, pane_id);
        }
        let generation = guard
            .pane_output_generation(pane_id)
            .expect("inserted pane has an output generation");
        (meta, generation)
    };

    let history = history_snapshot.and_then(|snapshot| {
        match TerminalHistoryWriter::open(&sessions_path, session_id, pane_id, &snapshot) {
            Ok(writer) => Some(writer),
            Err(error) => {
                warn!(?error, %session_id, %pane_id, "failed to open terminal history");
                None
            }
        }
    });

    thread::Builder::new()
        .name(format!("vibelink-pty-{pane_id}"))
        .spawn(move || {
            read_pane_loop(
                state,
                pane_id,
                generation,
                reader,
                child,
                Arc::new(sessions_path),
                coordinator,
                history,
            )
        })?;

    Ok(meta)
}

fn read_pane_loop(
    state: SharedState,
    pane_id: Uuid,
    generation: u64,
    mut reader: Box<dyn Read + Send>,
    child: SharedChild,
    sessions_path: Arc<PathBuf>,
    coordinator: Option<Arc<CoordinatorService>>,
    mut history: Option<TerminalHistoryWriter>,
) {
    let mut buf = [0_u8; 65536];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => {
                let bytes = &buf[..n];
                let capture_snapshot = history
                    .as_ref()
                    .is_some_and(|writer| writer.should_compact(bytes.len()));
                let Some(PaneOutputEffect { senders, snapshot }) = lock_state(&state)
                    .record_output_and_push_for_generation(
                        pane_id,
                        generation,
                        bytes,
                        capture_snapshot,
                    )
                else {
                    continue;
                };
                if let Some(writer) = history.as_mut() {
                    if let Err(error) = writer.record(bytes, snapshot.as_deref()) {
                        warn!(?error, %pane_id, "failed to persist terminal output");
                    }
                }
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
    let Some(PaneExitEffect { senders, lease }) =
        lock_state(&state).mark_exited_for_generation(pane_id, generation)
    else {
        return;
    };
    if let Some(history) = history {
        if let Err(error) = history.remove() {
            warn!(?error, %pane_id, "failed to remove exited pane history");
        }
    }
    for sender in senders {
        let _ = sender.send(DaemonToClient::PaneExited { pane_id, exit_code });
    }
    if let Some(transition) = lease {
        process_pane_lease_transition(&state, transition);
    }
    if let Some(coordinator) = coordinator {
        if let Err(error) = coordinator.record_pane_exit(
            Uuid::new_v4(),
            &pane_id.to_string(),
            exit_code,
            orchestration_now_millis(),
        ) {
            warn!(?error, %pane_id, "failed to reconcile orchestration pane exit");
        }
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

fn constant_time_equal(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
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

fn write_pane_authorized(
    state: &SharedState,
    session_id: Uuid,
    pane_id: Uuid,
    data: &[u8],
    origin: &PaneCommandOrigin,
) -> Result<()> {
    let writer = lock_state(state).pane_writer_authorized(session_id, pane_id, origin)?;
    let mut writer = lock_mutex(&writer);
    writer.write_all(data)?;
    writer.flush()?;
    Ok(())
}

fn resize_pane_authorized(
    state: &SharedState,
    session_id: Uuid,
    pane_id: Uuid,
    cols: u16,
    rows: u16,
    origin: &PaneCommandOrigin,
) -> Result<()> {
    let senders =
        lock_state(state).resize_pane_authorized(session_id, pane_id, cols, rows, origin)?;
    broadcast_pane_resize(senders, session_id, pane_id, cols.max(1), rows.max(1));
    Ok(())
}

fn broadcast_pane_resize(
    senders: Vec<Sender<DaemonToClient>>,
    session_id: Uuid,
    pane_id: Uuid,
    cols: u16,
    rows: u16,
) {
    for sender in senders {
        let _ = sender.send(DaemonToClient::PaneResized {
            session_id,
            pane_id,
            cols,
            rows,
        });
    }
}

fn broadcast_pane_lease_event(state: &SharedState, event: crate::protocol::RemotePaneLeaseEvent) {
    let senders = lock_state(state).all_senders();
    for sender in senders {
        let _ = sender.send(DaemonToClient::RemotePaneLease {
            event: event.clone(),
        });
    }
}

fn process_pane_lease_effect(state: &SharedState, effect: PaneLeaseEffect) {
    if let Some(resize) = effect.resize {
        broadcast_pane_resize(
            resize.senders,
            resize.session_id,
            resize.pane_id,
            resize.cols,
            resize.rows,
        );
    }
    if let Some(event) = effect.event {
        broadcast_pane_lease_event(state, event);
    }
}

fn process_pane_lease_transition(state: &SharedState, transition: PaneLeaseTransition) {
    for effect in transition.effects {
        process_pane_lease_effect(state, effect);
    }
}

fn process_pane_lease_transitions(state: &SharedState, transitions: Vec<PaneLeaseTransition>) {
    for transition in transitions {
        process_pane_lease_transition(state, transition);
    }
}

fn send_pane_lease_transition(
    state: &SharedState,
    tx: &Sender<DaemonToClient>,
    req: Req,
    transition: PaneLeaseTransition,
) -> Result<()> {
    let result = transition.result.clone();
    process_pane_lease_transition(state, transition);
    send(
        tx,
        DaemonToClient::Reply {
            req,
            result: ReplyResult::RemotePaneLease(result),
        },
    )
}

fn send_remote_connection_cleanup(
    state: &SharedState,
    tx: &Sender<DaemonToClient>,
    req: Req,
    transitions: Vec<PaneLeaseTransition>,
) -> Result<()> {
    let mut releases = Vec::with_capacity(transitions.len());
    for transition in &transitions {
        let RemotePaneLeaseResult::Cleanup {
            releases: transition_releases,
        } = &transition.result
        else {
            anyhow::bail!("unexpected remote connection cleanup transition");
        };
        releases.extend(transition_releases.iter().cloned());
    }
    process_pane_lease_transitions(state, transitions);
    send(
        tx,
        DaemonToClient::Reply {
            req,
            result: ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Cleanup { releases }),
        },
    )
}

fn notify_session_changed(state: &SharedState, session_id: Uuid) -> Result<()> {
    let senders = lock_state(state).all_senders();
    for sender in senders {
        let _ = sender.send(DaemonToClient::SessionChanged { session_id });
    }
    Ok(())
}

fn notify_all_sessions_changed(state: &SharedState) {
    let (session_ids, senders) = {
        let guard = lock_state(state);
        (guard.session_ids(), guard.all_senders())
    };
    for session_id in session_ids {
        for sender in &senders {
            let _ = sender.send(DaemonToClient::SessionChanged { session_id });
        }
    }
}

fn persist_restorable_panes_and_kill_all(state: &SharedState, sessions_path: &Path) -> Result<()> {
    stop_debounced_persister();
    let persist_result = persist_state(state, sessions_path);
    kill_all_panes(state);
    persist_result
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

    #[test]
    fn headless_worktree_prompt_defaults_to_omp_and_rejects_unknown_profiles() {
        let (config, agent_profile) =
            worktree_initial_pane_config("E:/repo/worktree", None, None, true)
                .expect("default prompt profile");
        assert!(agent_profile);
        assert_eq!(config.profile_id.as_deref(), Some("omp"));
        assert_eq!(config.cwd.as_deref(), Some("E:/repo/worktree"));
        assert!(worktree_initial_pane_config(
            "E:/repo/worktree",
            Some("custom-profile"),
            None,
            false,
        )
        .expect_err("unknown headless profile")
        .to_string()
        .contains("cannot resolve profile"));
    }

    fn state_with_test_pane(cols: u16, rows: u16) -> (SharedState, Uuid, Uuid) {
        let state = Arc::new(Mutex::new(DaemonState::new()));
        let session_id;
        let pane_id = Uuid::new_v4();
        {
            let mut guard = lock_state(&state);
            session_id = guard.create_session("Workspace".to_string(), None).id;
            guard
                .insert_pane(
                    session_id,
                    Pane::for_test(
                        PaneConfig {
                            pane_id,
                            shell: None,
                            args: Vec::new(),
                            cwd: None,
                            env: Vec::new(),
                            title: Some("lease test".to_string()),
                            icon: None,
                            profile_id: None,
                            role: None,
                            restore_on_start: false,
                            cols,
                            rows,
                        },
                        true,
                    ),
                )
                .expect("insert test pane");
        }
        (state, session_id, pane_id)
    }

    /// A restorable pane descriptor that never spawns a real process: these
    /// tests assert on the RESTORE DECISION, not on PTY behavior.
    fn restorable_test_config(pane_id: Uuid) -> PaneConfig {
        PaneConfig {
            pane_id,
            shell: None,
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            title: Some("restore test".to_string()),
            icon: None,
            profile_id: None,
            role: None,
            restore_on_start: true,
            cols: 80,
            rows: 24,
        }
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
                            restore_on_start: false,
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
    fn shutdown_persists_restartable_panes_before_removing_live_handles() {
        let state = Arc::new(Mutex::new(DaemonState::new()));
        let session_id;
        let pane_id = Uuid::new_v4();
        {
            let mut guard = lock_state(&state);
            session_id = guard.create_session("Workspace".to_string(), None).id;
            let config = crate::protocol::PaneConfig {
                pane_id,
                shell: None,
                args: Vec::new(),
                cwd: None,
                env: Vec::new(),
                title: Some("restorable".to_string()),
                icon: None,
                profile_id: None,
                role: None,
                restore_on_start: true,
                cols: 80,
                rows: 24,
            };
            guard
                .insert_pane(session_id, Pane::for_test(config, true))
                .expect("insert restartable pane");
        }
        let root = std::env::temp_dir().join(format!("vibelink-shutdown-{}", Uuid::new_v4()));
        let sessions_path = root.join("sessions.json");

        debounce_persist_state(&state, &sessions_path).expect("queue debounced persistence");
        persist_restorable_panes_and_kill_all(&state, &sessions_path)
            .expect("persist shutdown state");
        thread::sleep(PERSIST_DEBOUNCE_INTERVAL + Duration::from_millis(100));

        let persisted = load_sessions(&sessions_path).expect("load shutdown state");
        assert_eq!(persisted.len(), 1);
        assert_eq!(persisted[0].id, session_id);
        assert_eq!(persisted[0].panes.len(), 1);
        assert_eq!(persisted[0].panes[0].pane_id, pane_id);
        assert!(lock_state(&state)
            .pane_metas(session_id)
            .expect("pane metadata")
            .is_empty());
        let _ = fs::remove_dir_all(root);
    }

    /// End-to-end proof of the user-visible contract: a live restorable pane
    /// plus a DELIBERATE quit must yield an initialized screen on the next
    /// daemon start. The pane descriptor is still persisted either way, so the
    /// clean-exit marker is the only thing that changes the outcome.
    ///
    /// The crash counterpart deliberately stops at the persisted flag: actually
    /// reconstructing a pane spawns a real shell that blocks on the ConPTY
    /// startup handshake, which
    /// `cold_restart_reconstructs_restartable_pane_with_saved_history` already
    /// covers with a fixture process that answers it.
    #[test]
    fn deliberate_quit_reopens_clean_while_a_crash_stays_restorable() {
        for clean_exit in [true, false] {
            let state = Arc::new(Mutex::new(DaemonState::new()));
            let pane_id = Uuid::new_v4();
            let session_id = {
                let mut guard = lock_state(&state);
                let session_id = guard.create_session("Workspace".to_string(), None).id;
                guard
                    .insert_pane(
                        session_id,
                        Pane::for_test(restorable_test_config(pane_id), true),
                    )
                    .expect("insert restartable pane");
                session_id
            };
            let root = std::env::temp_dir().join(format!("vibelink-quit-{}", Uuid::new_v4()));
            let sessions_path = root.join("sessions.json");

            // The exact ordering the shutdown handler uses.
            if clean_exit {
                lock_state(&state).mark_clean_exit();
            }
            persist_restorable_panes_and_kill_all(&state, &sessions_path)
                .expect("persist shutdown state");

            let persisted = load_sessions(&sessions_path).expect("load shutdown state");
            assert_eq!(
                persisted[0].panes.len(),
                1,
                "the pane descriptor is always persisted; only the restore decision differs"
            );
            assert_eq!(persisted[0].clean_exit, clean_exit);

            if clean_exit {
                // A fresh daemon start over that exact state must spawn nothing.
                let restarted = Arc::new(Mutex::new(DaemonState::new()));
                reconstruct_sessions(Arc::clone(&restarted), &sessions_path)
                    .expect("reconstruct persisted sessions");
                let guard = lock_state(&restarted);
                assert!(
                    guard
                        .pane_metas(session_id)
                        .expect("session survives the quit")
                        .is_empty(),
                    "a deliberate quit must reopen clean"
                );
                assert_eq!(
                    guard.list_sessions().len(),
                    1,
                    "the workspace itself must remain openable"
                );
            }
            let _ = fs::remove_dir_all(root);
        }
    }

    #[test]
    fn cold_restart_reconstructs_restartable_pane_with_saved_history() {
        let root = std::env::temp_dir().join(format!("vibelink-cold-restore-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create cold restore fixture directory");
        let sessions_path = root.join("sessions.json");
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let fixture_name = "daemon::tests::cold_restore_fixture_process";
        let executable = std::env::current_exe().expect("resolve current test executable");
        let config = PaneConfig {
            pane_id,
            shell: Some(executable.to_string_lossy().into_owned()),
            args: vec![
                "--exact".to_string(),
                fixture_name.to_string(),
                "--nocapture".to_string(),
            ],
            cwd: Some(root.to_string_lossy().into_owned()),
            env: vec![("VIBELINK_COLD_RESTORE_FIXTURE".to_string(), "1".to_string())],
            title: Some("restored fixture".to_string()),
            icon: None,
            profile_id: None,
            role: None,
            restore_on_start: true,
            cols: 80,
            rows: 2,
        };
        save_sessions(
            &sessions_path,
            &[crate::daemon::persistence::PersistedSession {
                id: session_id,
                name: "Cold restore".to_string(),
                created_at: 123,
                layout_json: None,
                workspace_folder: Some(root.to_string_lossy().into_owned()),
                sleeping: false,
                clean_exit: false,
                panes: vec![config.clone()],
            }],
        )
        .expect("persist cold restore fixture");
        drop(
            TerminalHistoryWriter::open(
                &sessions_path,
                session_id,
                pane_id,
                b"saved terminal output",
            )
            .expect("persist terminal history fixture"),
        );

        let state = Arc::new(Mutex::new(DaemonState::new()));
        let outcome = reconstruct_sessions(Arc::clone(&state), &sessions_path).and_then(|()| {
            let (panes, snapshot, writer) = {
                let guard = lock_state(&state);
                (
                    guard.pane_metas(session_id)?,
                    guard.get_scrollback(session_id, pane_id)?,
                    guard.pane_writer_authorized(
                        session_id,
                        pane_id,
                        &PaneCommandOrigin::Desktop,
                    )?,
                )
            };
            lock_mutex(&writer)
                .write_all(b"\x1b[1;1R")
                .context("answer cold restore fixture cursor query")?;
            Ok((panes, snapshot))
        });

        let restored_pane = lock_state(&state)
            .close_pane(session_id, pane_id)
            .expect("remove restored pane");
        let child = restored_pane.as_ref().map(Pane::child);
        let mut exit_status = None;
        let mut wait_error = None;
        if let Some(child) = child.as_ref() {
            for _ in 0..500 {
                match lock_mutex(child).try_wait() {
                    Ok(Some(status)) => {
                        exit_status = Some(status);
                        break;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(20)),
                    Err(error) => {
                        wait_error = Some(error);
                        break;
                    }
                }
            }
        }
        drop(child);
        if exit_status.is_some() {
            drop(restored_pane);
        } else if let Some(mut pane) = restored_pane {
            let _ = pane.kill();
            std::mem::forget(pane);
        }
        let mut removed = false;
        for _ in 0..100 {
            match fs::remove_dir_all(&root) {
                Ok(()) => {
                    removed = true;
                    break;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    removed = true;
                    break;
                }
                Err(_) => thread::sleep(Duration::from_millis(20)),
            }
        }

        let exit_status = exit_status
            .unwrap_or_else(|| panic!("cold restore fixture process did not exit: {wait_error:?}"));
        assert!(exit_status.success(), "cold restore fixture process failed");
        assert!(removed, "cold restore fixture directory remained locked");
        let (panes, snapshot) = outcome.expect("reconstruct persisted sessions");
        assert_eq!(panes.len(), 1);
        let restored = &panes[0].config;
        assert_eq!(&restored.pane_id, &config.pane_id);
        assert_eq!(&restored.shell, &config.shell);
        assert_eq!(&restored.args, &config.args);
        assert_eq!(&restored.cwd, &config.cwd);
        assert_eq!(&restored.title, &config.title);
        assert!(restored.restore_on_start);
        assert!(restored
            .env
            .iter()
            .any(|(key, value)| key == "VIBELINK_COLD_RESTORE_FIXTURE" && value == "1"));
        assert!(restored.env.iter().any(|(key, value)| {
            key == "VIBELINK_SESSION_ID" && value == &session_id.to_string()
        }));
        assert!(restored
            .env
            .iter()
            .any(|(key, value)| key == "VIBELINK_PANE_ID" && value == &pane_id.to_string()));
        let rendered = String::from_utf8_lossy(&snapshot);
        assert!(rendered.contains("saved terminal output"));
        assert!(rendered.contains("[VibeLink cold restore:"));
    }

    /// A deliberate quit must produce an initialized screen, not the previous
    /// one. This is the whole point of the clean-exit marker: the pane
    /// descriptor is still on disk and still `restore_on_start`, yet nothing
    /// may be reconstructed, and the stale history must not survive to be
    /// replayed into a later pane.
    #[test]
    fn clean_exit_workspace_is_not_reconstructed_and_drops_its_history() {
        let root = std::env::temp_dir().join(format!("vibelink-clean-exit-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create clean exit fixture directory");
        let sessions_path = root.join("sessions.json");
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let config = restorable_test_config(pane_id);
        save_sessions(
            &sessions_path,
            &[crate::daemon::persistence::PersistedSession {
                id: session_id,
                name: "Clean exit".to_string(),
                created_at: 123,
                layout_json: Some("{\"grid\":true}".to_string()),
                workspace_folder: Some(root.to_string_lossy().into_owned()),
                sleeping: false,
                clean_exit: true,
                panes: vec![config],
            }],
        )
        .expect("persist clean exit fixture");
        drop(
            TerminalHistoryWriter::open(&sessions_path, session_id, pane_id, b"previous output")
                .expect("persist terminal history fixture"),
        );

        let state = Arc::new(Mutex::new(DaemonState::new()));
        reconstruct_sessions(Arc::clone(&state), &sessions_path)
            .expect("reconstruct persisted sessions");

        let guard = lock_state(&state);
        assert_eq!(
            guard.pane_metas(session_id).expect("session exists").len(),
            0,
            "a cleanly closed workspace must not respawn its panes"
        );
        assert_eq!(
            guard.list_sessions().len(),
            1,
            "the workspace itself must survive so the user can reopen it"
        );
        drop(guard);
        assert!(
            load_pane_history(&sessions_path, session_id, pane_id)
                .expect("history load")
                .is_empty(),
            "clean exit must drop stale scrollback"
        );

        let _ = fs::remove_dir_all(root);
    }

    /// The inverse: an unclean exit (crash/reboot) leaves `clean_exit` false,
    /// so the pane descriptor is still queued for cold restore.
    #[test]
    fn unclean_exit_workspace_keeps_its_restorable_panes() {
        let root = std::env::temp_dir().join(format!("vibelink-unclean-exit-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create unclean exit fixture directory");
        let sessions_path = root.join("sessions.json");
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let config = restorable_test_config(pane_id);
        save_sessions(
            &sessions_path,
            &[crate::daemon::persistence::PersistedSession {
                id: session_id,
                name: "Unclean exit".to_string(),
                created_at: 123,
                layout_json: None,
                workspace_folder: Some(root.to_string_lossy().into_owned()),
                sleeping: false,
                clean_exit: false,
                panes: vec![config],
            }],
        )
        .expect("persist unclean exit fixture");

        drop(
            TerminalHistoryWriter::open(&sessions_path, session_id, pane_id, b"crashed output")
                .expect("persist terminal history fixture"),
        );
        assert!(
            !load_pane_history(&sessions_path, session_id, pane_id)
                .expect("history load")
                .is_empty(),
            "an unclean exit must retain scrollback for cold restore"
        );

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn cold_restore_fixture_process() {
        if std::env::var("VIBELINK_COLD_RESTORE_FIXTURE").as_deref() != Ok("1") {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
    /// The agent-completion hooks reach the GUI ONLY through this broadcast, so
    /// a regression here silently disables every hook while the CLI still
    /// reports success.
    #[test]
    fn terminal_complete_broadcasts_a_pane_completed_signal() {
        let state = Arc::new(Mutex::new(DaemonState::new()));
        let pane_id = Uuid::new_v4();
        let session_id = {
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
                            title: Some("omp".to_string()),
                            icon: None,
                            profile_id: None,
                            role: None,
                            restore_on_start: false,
                            cols: 80,
                            rows: 24,
                        },
                        true,
                    ),
                )
                .expect("insert pane");
            session.id
        };

        let (tx, rx) = bounded(4);
        state
            .lock()
            .expect("state mutex")
            .add_client(Uuid::new_v4(), tx);

        let senders = lock_state(&state).all_senders();
        for sender in senders {
            sender
                .send(DaemonToClient::TaskEvent {
                    session_id,
                    event: crate::protocol::TaskSignal::PaneCompleted {
                        pane_id,
                        agent: Some("omp".to_string()),
                    },
                })
                .expect("broadcast completion");
        }

        assert_eq!(
            rx.recv_timeout(Duration::from_secs(1))
                .expect("client receives the completion"),
            DaemonToClient::TaskEvent {
                session_id,
                event: crate::protocol::TaskSignal::PaneCompleted {
                    pane_id,
                    agent: Some("omp".to_string()),
                },
            }
        );
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
                restore_on_start: false,
                cols: 80,
                rows: 24,
            },
            attach: false,
        };

        assert_eq!(request_id(&msg), Some(42));
    }

    #[test]
    fn request_id_tracks_subscribe_but_not_detach_pane() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();

        assert_eq!(
            request_id(&ClientToDaemon::SubscribePane {
                req: 43,
                session_id,
                pane_id,
            }),
            Some(43)
        );
        assert_eq!(
            request_id(&ClientToDaemon::DetachPane {
                session_id,
                pane_id,
            }),
            None
        );
    }

    #[test]
    fn request_id_tracks_remote_pane_lease_requests() {
        let owner_connection_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let lease_id = Uuid::new_v4();
        let messages = vec![
            ClientToDaemon::RemotePaneLeaseClaim {
                req: 1,
                request: crate::protocol::RemotePaneLeaseClaimRequest {
                    owner_connection_id,
                    device_id: "device".to_string(),
                    session_id,
                    pane_id,
                    cols: 80,
                    rows: 24,
                    viewport_revision: 1,
                    lease_id: None,
                    revision: None,
                },
            },
            ClientToDaemon::RemotePaneLeaseRenew {
                req: 2,
                request: crate::protocol::RemotePaneLeaseRenewRequest {
                    owner_connection_id,
                    device_id: "device".to_string(),
                    session_id,
                    pane_id,
                    lease_id,
                    revision: 1,
                    viewport_revision: 2,
                },
            },
            ClientToDaemon::RemotePaneLeaseRelease {
                req: 3,
                request: crate::protocol::RemotePaneLeaseReleaseRequest {
                    owner_connection_id,
                    device_id: "device".to_string(),
                    session_id,
                    pane_id,
                    lease_id,
                    revision: 2,
                },
            },
            ClientToDaemon::RemotePaneLeaseStatus {
                req: 4,
                request: RemotePaneLeaseStatusRequest { pane_id },
            },
            ClientToDaemon::RemotePaneLeaseAdminReclaim {
                req: 5,
                request: crate::protocol::RemotePaneLeaseAdminReclaimRequest {
                    session_id,
                    pane_id,
                },
            },
            ClientToDaemon::RemoteConnectionCleanup {
                req: 6,
                request: RemoteConnectionCleanupRequest {
                    owner_connection_id,
                },
            },
        ];

        assert_eq!(
            messages.iter().map(request_id).collect::<Vec<_>>(),
            vec![Some(1), Some(2), Some(3), Some(4), Some(5), Some(6)]
        );
    }

    #[test]
    fn remote_pane_lease_status_uses_negotiated_target_geometry() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let status = remote_pane_lease_status_response(RemotePaneLeaseResult::Status {
            lease: Some(crate::protocol::RemotePaneLease {
                lease_id: Uuid::new_v4(),
                owner_connection_id: Uuid::new_v4(),
                device_id: "device".to_string(),
                session_id,
                pane_id,
                pane_generation: 7,
                revision: 3,
                original_cols: 120,
                original_rows: 40,
                target_cols: 52,
                target_rows: 31,
                viewport_revision: 9,
                expires_at: 100,
            }),
        })
        .expect("map lease status")
        .expect("active lease");

        assert_eq!(status.session_id, session_id.to_string());
        assert_eq!(status.pane_id, pane_id.to_string());
        assert_eq!(status.device_id, "device");
        assert_eq!((status.cols, status.rows), (52, 31));
        assert_eq!(status.expires_at, 100);
    }

    #[test]
    fn pane_dispatch_rejects_desktop_and_accepts_matching_remote_origin() {
        let (state, session_id, pane_id) = state_with_test_pane(120, 40);
        let owner_connection_id = Uuid::new_v4();
        write_pane_authorized(
            &state,
            session_id,
            pane_id,
            b"desktop before lease",
            &PaneCommandOrigin::Desktop,
        )
        .expect("desktop write without lease");
        write_pane_authorized(
            &state,
            session_id,
            pane_id,
            b"shared remote before lease",
            &PaneCommandOrigin::Remote {
                owner_connection_id,
                device_id: "mobile".to_string(),
                lease_id: None,
                revision: None,
            },
        )
        .expect("shared remote write without lease");
        let transition = lock_state(&state)
            .claim_or_update_remote_pane_lease(
                crate::protocol::RemotePaneLeaseClaimRequest {
                    owner_connection_id,
                    device_id: "mobile".to_string(),
                    session_id,
                    pane_id,
                    cols: 52,
                    rows: 31,
                    viewport_revision: 1,
                    lease_id: None,
                    revision: None,
                },
                orchestration_now_millis(),
            )
            .expect("claim lease");
        let lease = match &transition.result {
            RemotePaneLeaseResult::Claimed { lease } => lease.clone(),
            other => panic!("unexpected claim result: {other:?}"),
        };
        process_pane_lease_transition(&state, transition);

        assert!(write_pane_authorized(
            &state,
            session_id,
            pane_id,
            b"desktop",
            &PaneCommandOrigin::Desktop,
        )
        .is_err());
        assert!(resize_pane_authorized(
            &state,
            session_id,
            pane_id,
            120,
            40,
            &PaneCommandOrigin::Desktop,
        )
        .is_err());

        let remote_origin = PaneCommandOrigin::Remote {
            owner_connection_id,
            device_id: "mobile".to_string(),
            lease_id: Some(lease.lease_id),
            revision: Some(lease.revision),
        };
        write_pane_authorized(&state, session_id, pane_id, b"remote", &remote_origin)
            .expect("matching remote write");
        resize_pane_authorized(&state, session_id, pane_id, 52, 31, &remote_origin)
            .expect("matching remote resize");
    }

    #[test]
    fn expiry_transition_restores_geometry_and_broadcasts_lost_event() {
        let (state, session_id, pane_id) = state_with_test_pane(120, 40);
        let client_id = Uuid::new_v4();
        let (tx, rx) = bounded(16);
        {
            let mut guard = lock_state(&state);
            guard.add_client(client_id, tx);
            guard.attach_client_to_pane(client_id, pane_id);
        }
        let transition = lock_state(&state)
            .claim_or_update_remote_pane_lease(
                crate::protocol::RemotePaneLeaseClaimRequest {
                    owner_connection_id: Uuid::new_v4(),
                    device_id: "mobile".to_string(),
                    session_id,
                    pane_id,
                    cols: 52,
                    rows: 31,
                    viewport_revision: 1,
                    lease_id: None,
                    revision: None,
                },
                1_000,
            )
            .expect("claim lease");
        let expires_at = match &transition.result {
            RemotePaneLeaseResult::Claimed { lease } => lease.expires_at,
            other => panic!("unexpected claim result: {other:?}"),
        };
        process_pane_lease_transition(&state, transition);
        let _ = rx.try_iter().collect::<Vec<_>>();

        let transitions = lock_state(&state).expire_remote_pane_leases(expires_at);
        process_pane_lease_transitions(&state, transitions);

        let pane = lock_state(&state)
            .pane_metas(session_id)
            .expect("pane metadata")
            .into_iter()
            .find(|pane| pane.id == pane_id)
            .expect("live pane");
        assert_eq!((pane.config.cols, pane.config.rows), (120, 40));
        let messages = rx.try_iter().collect::<Vec<_>>();
        assert!(messages.iter().any(|message| matches!(
            message,
            DaemonToClient::PaneResized {
                cols: 120,
                rows: 40,
                ..
            }
        )));
        assert!(messages.iter().any(|message| matches!(
            message,
            DaemonToClient::RemotePaneLease { event }
                if event.kind == crate::protocol::RemotePaneLeaseEventKind::Lost
                    && event.reason == crate::protocol::RemotePaneLeaseEventReason::Expired
                    && event.restoration.as_ref().is_some_and(|restoration|
                        restoration.status == crate::protocol::RemotePaneLeaseRestorationStatus::Restored)
        )));
    }

    #[test]
    fn admin_reclaim_transition_restores_geometry_and_broadcasts_lost_event() {
        let (state, session_id, pane_id) = state_with_test_pane(120, 40);
        let client_id = Uuid::new_v4();
        let (tx, rx) = bounded(16);
        {
            let mut guard = lock_state(&state);
            guard.add_client(client_id, tx);
            guard.attach_client_to_pane(client_id, pane_id);
        }
        let transition = lock_state(&state)
            .claim_or_update_remote_pane_lease(
                crate::protocol::RemotePaneLeaseClaimRequest {
                    owner_connection_id: Uuid::new_v4(),
                    device_id: "mobile".to_string(),
                    session_id,
                    pane_id,
                    cols: 52,
                    rows: 31,
                    viewport_revision: 1,
                    lease_id: None,
                    revision: None,
                },
                orchestration_now_millis(),
            )
            .expect("claim lease");
        process_pane_lease_transition(&state, transition);
        let _ = rx.try_iter().collect::<Vec<_>>();

        let transition = lock_state(&state)
            .admin_reclaim_remote_pane_lease(crate::protocol::RemotePaneLeaseAdminReclaimRequest {
                session_id,
                pane_id,
            })
            .expect("admin reclaim");
        process_pane_lease_transition(&state, transition);

        let pane = lock_state(&state)
            .pane_metas(session_id)
            .expect("pane metadata")
            .into_iter()
            .find(|pane| pane.id == pane_id)
            .expect("live pane");
        assert_eq!((pane.config.cols, pane.config.rows), (120, 40));
        let messages = rx.try_iter().collect::<Vec<_>>();
        assert!(messages.iter().any(|message| matches!(
            message,
            DaemonToClient::PaneResized {
                cols: 120,
                rows: 40,
                ..
            }
        )));
        assert!(messages.iter().any(|message| matches!(
            message,
            DaemonToClient::RemotePaneLease { event }
                if event.kind == crate::protocol::RemotePaneLeaseEventKind::Lost
                    && event.reason == crate::protocol::RemotePaneLeaseEventReason::AdminReclaimed
                    && event.restoration.as_ref().is_some_and(|restoration|
                        restoration.status == crate::protocol::RemotePaneLeaseRestorationStatus::Restored)
        )));
    }

    #[test]
    fn connection_cleanup_restores_geometry_and_emits_disconnect_loss() {
        let (state, session_id, pane_id) = state_with_test_pane(120, 40);
        let owner_connection_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let (event_tx, event_rx) = bounded(16);
        {
            let mut guard = lock_state(&state);
            guard.add_client(client_id, event_tx);
            guard.attach_client_to_pane(client_id, pane_id);
        }
        let transition = lock_state(&state)
            .claim_or_update_remote_pane_lease(
                crate::protocol::RemotePaneLeaseClaimRequest {
                    owner_connection_id,
                    device_id: "mobile".to_string(),
                    session_id,
                    pane_id,
                    cols: 52,
                    rows: 31,
                    viewport_revision: 1,
                    lease_id: None,
                    revision: None,
                },
                orchestration_now_millis(),
            )
            .expect("claim lease");
        process_pane_lease_transition(&state, transition);
        let _ = event_rx.try_iter().collect::<Vec<_>>();

        let transitions =
            lock_state(&state).cleanup_remote_connection_leases(RemoteConnectionCleanupRequest {
                owner_connection_id,
            });
        let (reply_tx, reply_rx) = bounded(1);
        send_remote_connection_cleanup(&state, &reply_tx, 91, transitions)
            .expect("send disconnect cleanup");

        assert!(matches!(
            reply_rx.recv().expect("cleanup reply"),
            DaemonToClient::Reply {
                req: 91,
                result: ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Cleanup { .. })
            }
        ));
        let pane = lock_state(&state)
            .pane_metas(session_id)
            .expect("pane metadata")
            .into_iter()
            .find(|pane| pane.id == pane_id)
            .expect("live pane");
        assert_eq!((pane.config.cols, pane.config.rows), (120, 40));
        let messages = event_rx.try_iter().collect::<Vec<_>>();
        assert!(messages.iter().any(|message| matches!(
            message,
            DaemonToClient::RemotePaneLease { event }
                if event.kind == crate::protocol::RemotePaneLeaseEventKind::Lost
                    && event.reason == crate::protocol::RemotePaneLeaseEventReason::ConnectionClosed
                    && event.restoration.as_ref().is_some_and(|restoration|
                        restoration.status == crate::protocol::RemotePaneLeaseRestorationStatus::Restored)
        )));
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
    #[test]
    fn automation_cli_id_validation() {
        let valid_uuid = Uuid::new_v4().to_string();

        let mut args_valid = crate::dedicated_cli::OperationArguments::default();
        args_valid.positionals.push(valid_uuid.clone());
        let res = automation_cli_id(&args_valid, "automation id");
        assert_eq!(res.unwrap(), valid_uuid);

        let mut args_opt = crate::dedicated_cli::OperationArguments::default();
        args_opt
            .options
            .insert("id".to_string(), vec![valid_uuid.clone()]);
        let res = automation_cli_id(&args_opt, "automation id");
        assert_eq!(res.unwrap(), valid_uuid);

        let mut args_conflict = crate::dedicated_cli::OperationArguments::default();
        args_conflict.positionals.push(valid_uuid.clone());
        args_conflict
            .options
            .insert("id".to_string(), vec![valid_uuid.clone()]);
        let res = automation_cli_id(&args_conflict, "automation id");
        assert!(res.is_err());
        assert!(res
            .unwrap_err()
            .to_string()
            .contains("either positionally or with --id, not both"));

        let args_missing = crate::dedicated_cli::OperationArguments::default();
        let res = automation_cli_id(&args_missing, "automation id");
        assert!(res.is_err());
        assert!(res
            .unwrap_err()
            .to_string()
            .contains("automation id is required"));

        let mut args_invalid = crate::dedicated_cli::OperationArguments::default();
        args_invalid.positionals.push("not-a-uuid".to_string());
        let res = automation_cli_id(&args_invalid, "automation id");
        assert!(res.is_err());
        assert!(res
            .unwrap_err()
            .to_string()
            .contains("automation id must be a UUID"));
    }

    #[test]
    fn automation_json_payload_validation() {
        let mut args_valid = crate::dedicated_cli::OperationArguments::default();
        args_valid.options.insert(
            "json".to_string(),
            vec![r#"{"name":"test","prompt":"hello"}"#.to_string()],
        );
        let payload = automation_json_payload(&args_valid).unwrap();
        assert!(payload.is_object());
        assert_eq!(payload.get("name").and_then(Value::as_str), Some("test"));

        let mut args_non_object = crate::dedicated_cli::OperationArguments::default();
        args_non_object
            .options
            .insert("json".to_string(), vec!["[1, 2, 3]".to_string()]);
        let res = automation_json_payload(&args_non_object);
        assert!(res.is_err());
        assert!(res
            .unwrap_err()
            .to_string()
            .contains("must contain a JSON object"));

        let mut args_malformed = crate::dedicated_cli::OperationArguments::default();
        args_malformed
            .options
            .insert("json".to_string(), vec!["{invalid json".to_string()]);
        let res = automation_json_payload(&args_malformed);
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("must be valid JSON"));

        let args_missing = crate::dedicated_cli::OperationArguments::default();
        let res = automation_json_payload(&args_missing);
        assert!(res.is_err());
        assert!(res.unwrap_err().to_string().contains("--json is required"));
    }
}

mod automation;
mod browser_cdp;
pub mod paths;
pub mod persistence;
pub mod proc;
pub mod pty;
pub mod query_filter;
pub mod scrollback;
pub mod session;

use crate::computer_use::{
    ActionRequest, ActionTarget, ApprovalRequest, ComputerAction as ProviderComputerAction,
    HostRequest, HostResponseBody, Point, ProviderError, ProviderHostSupervisor, SnapshotLimits,
    SnapshotRequest, WindowIdentity, WindowsProcessSpawner,
};
use crate::control_plane::{ControlCommand, ControlPlane};
use crate::daemon::automation::{AutomationService, CreateAutomation};
use crate::daemon::persistence::{load_sessions, save_sessions};
use crate::daemon::pty::{Pane, SharedChild};
use crate::daemon::session::DaemonState;
use crate::dedicated_cli::{
    AutomationAction, CliControlRequest, Command as DedicatedCommand, ComputerAction,
    OrchestrationAction, RemoteAction, SkillAction, TerminalAction, WorkspaceAction,
};
use crate::orchestration::adapters::AgentProvider;
use crate::orchestration::{
    AcknowledgeEventsRequest, BindDispatchRequest, CoordinatorError, CoordinatorService,
    CreateGateRequest, CreateRunRequest, CreateTaskRequest, HeartbeatRequest, LaunchFailureRequest,
    LifecycleIdentity, MergeAppliedRequest, MessageType, PostMessageRequest,
    ReconcileLivenessRequest, RegisterAgentRequest, ResolveGateRequest, RetryTaskRequest,
    RunDecisionRequest, RunRevisionRequest, ScheduleRequest, UpdateTaskRequest, WorkerDoneRequest,
    WorktreeAssignment,
};
use crate::protocol::PaneConfig;
use crate::protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, ReplyResult, Req};
use crate::remote::RemoteServer;
use anyhow::{Context, Result};
use crossbeam_channel::{bounded, Sender, TrySendError};
use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex, MutexGuard,
    },
    thread,
    time::Duration,
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
static PERSISTENCE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static DEBOUNCED_PERSISTER: LazyLock<Mutex<Option<DebouncedPersister>>> =
    LazyLock::new(|| Mutex::new(None));

struct DebouncedPersister {
    dirty: Arc<AtomicBool>,
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
    let coordinator = Arc::new(CoordinatorService::new(Arc::clone(&control)));
    coordinator.reconcile_after_restart(
        Uuid::new_v4(),
        crate::orchestration::RestartReconciliationRequest {
            now_millis: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        },
    )?;
    let automation = Arc::new(AutomationService::open(
        &paths
            .data_dir
            .join("control")
            .join("vibelink-control.sqlite3"),
        paths.data_dir.join("automation-artifacts"),
        Arc::clone(&coordinator),
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
    let remote_state = Arc::clone(&state);
    let remote = Arc::new(RemoteServer::new_with_pane_lease_notifier(
        paths.data_dir.clone(),
        move |event| {
            for sender in lock_state(&remote_state).all_senders() {
                let _ = sender.send(DaemonToClient::RemotePaneLease {
                    event: serde_json::to_value(&event).unwrap_or(Value::Null),
                });
            }
        },
    )?);
    remote.start_if_enabled()?;

    let sessions_path = Arc::new(paths.sessions.clone());
    let shutdown = Arc::new(AtomicBool::new(false));
    start_automation_scheduler(
        Arc::clone(&automation),
        Arc::clone(&coordinator),
        Arc::clone(&state),
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
                let control = Arc::clone(&control);
                let coordinator = Arc::clone(&coordinator);
                let computer = computer.clone();
                let automation = Arc::clone(&automation);
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

    info!("daemon shutting down, killing all panes");
    kill_all_panes(&state);
    if let Err(err) = persist_state(&state, &sessions_path) {
        warn!(?err, "failed to persist state during shutdown");
    }
    drop(lock_file);
    fn start_automation_scheduler(
        automation: Arc<AutomationService>,
        coordinator: Arc<CoordinatorService>,
        state: SharedState,
        shutdown: Arc<AtomicBool>,
    ) -> Result<()> {
        thread::Builder::new()
            .name("vibelink-automation-scheduler".to_string())
            .spawn(move || {
                while !shutdown.load(Ordering::Acquire) {
                    match automation.claim_due(chrono::Utc::now()) {
                        Ok(claims) => {
                            for claim in claims {
                                let workspace = automation
                                    .get(&claim.automation_id)
                                    .ok()
                                    .and_then(|record| {
                                        automation_workspace(&state, &record.session_id).ok()
                                    })
                                    .unwrap_or_else(|| {
                                        PathBuf::from("__vibelink_missing_workspace__")
                                    });
                                let automation = Arc::clone(&automation);
                                let _ = thread::Builder::new()
                                    .name(format!("vibelink-automation-{}", &claim.id[..8]))
                                    .spawn(move || {
                                        if let Err(error) = automation.execute(&claim, &workspace) {
                                            error!(automation_run_id = %claim.id, ?error, "automation run failed");
                                        }
                                    });
                            }
                        }
                        Err(error) => warn!(?error, "automation scheduler scan failed"),
                    }

                    for session in lock_state(&state).list_sessions() {
                        let session_id = session.id.to_string();
                        if let Ok(runs) = coordinator.runs_for_session(&session_id) {
                            for run in runs.into_iter().filter(|run| {
                                matches!(
                                    run.status,
                                    crate::orchestration::RunStatus::Running
                                        | crate::orchestration::RunStatus::Waiting
                                )
                            }) {
                                let _ = coordinator.schedule_ready(
                                    Uuid::new_v4(),
                                    ScheduleRequest {
                                        run_id: run.id,
                                        expected_run_revision: run.revision,
                                    },
                                );
                            }
                        }
                    }

                    if let Ok(records) = automation.list(None) {
                        for record in records {
                            let Ok(workspace) = automation_workspace(&state, &record.session_id)
                            else {
                                continue;
                            };
                            if let Ok(runs) = automation.runs(&record.id, 100) {
                                for run in runs.into_iter().filter(|run| run.status == "running") {
                                    if let Err(error) = automation.sync_run(&run.id, &workspace) {
                                        warn!(automation_run_id = %run.id, ?error, "automation reconciliation failed");
                                    }
                                }
                            }
                        }
                    }
                    thread::sleep(Duration::from_secs(1));
                }
            })?;
        Ok(())
    }

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
            persisted.sleeping,
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
    control: Arc<ControlPlane>,
    coordinator: Arc<CoordinatorService>,
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

    lock_state(&state).remove_client(client_id);
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
    coordinator: &CoordinatorService,
    operation_id: Uuid,
    method: &str,
    payload_json: &str,
) -> String {
    let result = dispatch_orchestration_rpc(coordinator, operation_id, method, payload_json);
    let envelope = match result {
        Ok(data) => OrchestrationRpcEnvelope {
            ok: true,
            data: Some(data),
            error: None,
        },
        Err(error) => OrchestrationRpcEnvelope {
            ok: false,
            data: None,
            error: Some(error),
        },
    };
    serde_json::to_string(&envelope).expect("serialize orchestration RPC envelope")
}

fn dispatch_orchestration_rpc(
    coordinator: &CoordinatorService,
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
        "run.cancel" => mutation!(RunRevisionRequest, cancel_run),
        "run.accept" => mutation!(RunDecisionRequest, accept_run),
        "run.reject" => mutation!(RunDecisionRequest, reject_run),
        "task.create" => mutation!(CreateTaskRequest, create_task),
        "task.update" => mutation!(UpdateTaskRequest, update_task),
        "task.retry" => mutation!(RetryTaskRequest, retry_task),
        "schedule.ready" => mutation!(ScheduleRequest, schedule_ready),
        "agent.register" => mutation!(RegisterAgentRequest, register_agent),
        "dispatch.bind" => mutation!(BindDispatchRequest, bind_dispatch),
        "dispatch.launchFailed" => mutation!(LaunchFailureRequest, record_launch_failure),
        "agent.heartbeat" => mutation!(HeartbeatRequest, heartbeat),
        "agent.reconcile" => mutation!(ReconcileLivenessRequest, reconcile_liveness),
        "worker.done" => mutation!(WorkerDoneRequest, worker_done),
        "gate.create" => mutation!(CreateGateRequest, create_gate),
        "gate.resolve" => mutation!(ResolveGateRequest, resolve_gate),
        "merge.applied" => mutation!(MergeAppliedRequest, mark_merge_applied),
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
    coordinator: &CoordinatorService,
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
                let mut panes = lock_state(state).delete_session(session_id)?;
                persist_state(state, sessions_path)?;
                for pane in &mut panes {
                    pane.kill()?;
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
                let (mut panes, senders) = {
                    let mut state = lock_state(state);
                    let panes = state.sleep_session(session_id)?;
                    (panes, state.all_senders())
                };
                for pane in &mut panes {
                    pane.kill()?;
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
                    let writer = lock_state(state).pane_writer(session_id, pane_id)?;
                    let mut writer = lock_mutex(&writer);
                    writer.write_all(&data)?;
                    writer.flush()?;
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
                    if let Some(mut pane) = lock_state(state).close_pane(session_id, pane_id)? {
                        pane.kill()?;
                    }
                    persist_state(state, sessions_path)?;
                    Ok(serde_json::json!({ "closed": pane_id }))
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
                    Ok(serde_json::to_value(coordinator.cancel_run(
                        outer_operation_id,
                        RunRevisionRequest {
                            run_id,
                            expected_run_revision: expected_revision.context("--expected-revision is required")?,
                        },
                    )?)?)
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
                    let session_id = resolve_cli_session(state, command.selectors.workspace.as_deref())?;
                    let command_line = required_cli_option(&command.arguments, "command")?.to_string();
                    let schedule = coordinator.schedule_ready(
                        outer_operation_id,
                        ScheduleRequest {
                            run_id: run_id.clone(),
                            expected_run_revision: expected_revision.context("--expected-revision is required")?,
                        },
                    )?;
                    let tasks = coordinator.tasks(&run_id)?;
                    let workspace_path = automation_workspace(state, &session_id.to_string())?;
                    let worktree = cli_option(&command.arguments, "worktree")?.map(|path| {
                        Ok::<_, anyhow::Error>(WorktreeAssignment {
                            base_revision: required_cli_option(&command.arguments, "base-revision")?.to_string(),
                            branch: required_cli_option(&command.arguments, "branch")?.to_string(),
                            worktree_path: path.to_string(),
                        })
                    }).transpose()?;
                    let cwd = worktree.as_ref().map(|value| value.worktree_path.clone()).unwrap_or_else(|| workspace_path.to_string_lossy().to_string());
                    let mut launches = Vec::new();
                    for dispatch in &schedule.dispatches {
                        let task = tasks.iter().find(|task| task.id == dispatch.task_id)
                            .with_context(|| format!("task not found for dispatch {}", dispatch.id))?;
                        let agent = coordinator.register_agent(
                            Uuid::new_v4(),
                            RegisterAgentRequest {
                                provider: AgentProvider::PtyCli,
                                profile: cli_option(&command.arguments, "profile")?.map(str::to_string),
                                workspace_path: workspace_path.to_string_lossy().to_string(),
                                worktree_path: worktree.as_ref().map(|value| value.worktree_path.clone()),
                                resumable: false,
                            },
                        )?;
                        let pane_id = Uuid::new_v4();
                        let pane = spawn_pane_for_session(
                            Arc::clone(state),
                            sessions_path.to_path_buf(),
                            session_id,
                            crate::protocol::PaneConfig {
                                pane_id,
                                shell: Some("cmd.exe".to_string()),
                                args: vec!["/D".to_string(), "/S".to_string(), "/C".to_string(), command_line.clone()],
                                cwd: Some(cwd.clone()),
                                env: vec![
                                    ("VIBELINK_RUN_ID".to_string(), run_id.clone()),
                                    ("VIBELINK_TASK_ID".to_string(), task.id.clone()),
                                    ("VIBELINK_DISPATCH_ID".to_string(), dispatch.id.clone()),
                                    ("VIBELINK_AGENT_INSTANCE_ID".to_string(), agent.id.clone()),
                                    ("VIBELINK_SESSION_ID".to_string(), session_id.to_string()),
                                ],
                                title: Some(task.title.clone()),
                                icon: Some("bot".to_string()),
                                profile_id: cli_option(&command.arguments, "profile")?.map(str::to_string),
                                role: Some("orchestration-worker".to_string()),
                                cols: 120,
                                rows: 32,
                            },
                            None,
                        )?;
                        let bound = coordinator.bind_dispatch(
                            Uuid::new_v4(),
                            BindDispatchRequest {
                                dispatch_id: dispatch.id.clone(),
                                expected_task_revision: task.revision,
                                agent_instance_id: agent.id,
                                runtime_identity: format!("pane:{}:1", pane.id),
                                pane_id: Some(pane.id.to_string()),
                                process_generation: 1,
                                worktree: worktree.clone(),
                            },
                        )?;
                        launches.push(json!({ "pane": pane, "binding": bound }));
                    }
                    persist_state(state, sessions_path)?;
                    Ok(json!({ "schedule": schedule, "launches": launches }))
                }
                OrchestrationAction::GateList => {
                    Ok(serde_json::to_value(coordinator.gates(&run_id.context("--run-id is required")?)?)?)
                }
                OrchestrationAction::GateResolve => {
                    Ok(serde_json::to_value(coordinator.resolve_gate(
                        outer_operation_id,
                        ResolveGateRequest {
                            gate_id: required_cli_option(&command.arguments, "gate-id")?.to_string(),
                            resolution: serde_json::json!(required_cli_option(&command.arguments, "resolution")?),
                            expected_run_revision: expected_revision.context("--expected-revision is required")?,
                        },
                    )?)?)
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
        DedicatedCommand::Automation(command) => {
            dispatch_automation_cli(state, automation, command)
        }
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
            let name = required_cli_option(&command.arguments, "name")?.to_string();
            let schedule_kind =
                required_cli_option(&command.arguments, "schedule-kind")?.to_string();
            let schedule_value =
                required_cli_option(&command.arguments, "schedule-value")?.to_string();
            let timezone = cli_option(&command.arguments, "timezone")?
                .unwrap_or("UTC")
                .to_string();
            let workspace_mode = cli_option(&command.arguments, "workspace-mode")?
                .unwrap_or("reuse")
                .to_string();
            let legacy_command = required_cli_option(&command.arguments, "command")?.to_string();
            let precheck_timeout_seconds = cli_option(&command.arguments, "timeout-seconds")?
                .unwrap_or("60")
                .parse::<u64>()
                .context("--timeout-seconds must be an unsigned integer")?
                .clamp(1, 600);
            let goal = cli_option(&command.arguments, "goal")?
                .unwrap_or(&legacy_command)
                .to_string();
            Ok(serde_json::to_value(automation.create(
                CreateAutomation {
                    session_id: session_id.to_string(),
                    name,
                    schedule_kind,
                    schedule_value,
                    timezone,
                    workspace_mode,
                    precheck: json!({
                        "requireWorkspace": true,
                        "timeoutSeconds": precheck_timeout_seconds,
                    }),
                    policy: json!({
                        "goal": goal,
                        "maxConcurrent": 4,
                        "resourceBudget": { "maxActiveRuns": 1 },
                    }),
                },
            )?)?)
        }
        AutomationAction::Update => {
            let id = command
                .arguments
                .positionals
                .first()
                .map(String::as_str)
                .or_else(|| cli_option(&command.arguments, "id").ok().flatten())
                .context("automation id is required")?;
            let mut patch = serde_json::Map::new();
            for (option_name, json_name) in [
                ("name", "name"),
                ("schedule-kind", "scheduleKind"),
                ("schedule-value", "scheduleValue"),
                ("timezone", "timezone"),
                ("workspace-mode", "workspaceMode"),
            ] {
                if let Some(value) = cli_option(&command.arguments, option_name)? {
                    patch.insert(json_name.to_string(), Value::String(value.to_string()));
                }
            }
            if command.arguments.switches.contains("enable") {
                patch.insert("enabled".to_string(), Value::Bool(true));
            }
            if command.arguments.switches.contains("disable") {
                patch.insert("enabled".to_string(), Value::Bool(false));
            }
            let existing = automation.get(id)?;
            let mut policy = existing.policy;
            if let Some(value) = cli_option(&command.arguments, "command")? {
                policy["goal"] = Value::String(value.to_string());
            }
            if let Some(value) = cli_option(&command.arguments, "goal")? {
                policy["goal"] = Value::String(value.to_string());
            }
            let mut precheck = existing.precheck;
            if let Some(value) = cli_option(&command.arguments, "timeout-seconds")? {
                precheck["timeoutSeconds"] = json!(value
                    .parse::<u64>()
                    .context("--timeout-seconds must be an unsigned integer")?
                    .clamp(1, 600));
            }
            patch.insert("precheck".to_string(), precheck);
            patch.insert("policy".to_string(), policy);
            Ok(serde_json::to_value(
                automation.update(id, &Value::Object(patch))?,
            )?)
        }
        AutomationAction::Delete => {
            let id = command
                .arguments
                .positionals
                .first()
                .map(String::as_str)
                .or_else(|| cli_option(&command.arguments, "id").ok().flatten())
                .context("automation id is required")?;
            automation.delete(id)?;
            Ok(json!({ "id": id, "deleted": true }))
        }
        AutomationAction::Run => {
            let id = command
                .arguments
                .positionals
                .first()
                .map(String::as_str)
                .or_else(|| cli_option(&command.arguments, "id").ok().flatten())
                .context("automation id is required")?;
            let record = automation.get(id)?;
            let workspace = automation_workspace(state, &record.session_id)?;
            let claim = automation.trigger(id)?;
            Ok(serde_json::to_value(
                automation.execute(&claim, &workspace)?,
            )?)
        }
        AutomationAction::Runs => {
            let id = command
                .arguments
                .positionals
                .first()
                .map(String::as_str)
                .or_else(|| cli_option(&command.arguments, "id").ok().flatten())
                .context("automation id is required")?;
            let limit = cli_option(&command.arguments, "limit")?
                .unwrap_or("50")
                .parse::<u32>()
                .context("--limit must be an unsigned integer")?;
            Ok(serde_json::to_value(automation.runs(id, limit)?)?)
        }
        AutomationAction::Precheck => {
            let id = command
                .arguments
                .positionals
                .first()
                .map(String::as_str)
                .or_else(|| cli_option(&command.arguments, "id").ok().flatten())
                .context("automation id is required")?;
            let record = automation.get(id)?;
            let workspace = automation_workspace(state, &record.session_id)?;
            Ok(serde_json::to_value(
                automation.precheck(&record, &workspace),
            )?)
        }
    }
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
        ClientToDaemon::AttachPane {
            session_id,
            pane_id,
        } => {
            info!(%client_id, %session_id, %pane_id, "attaching pane");
            lock_state(&state).attach_pane(client_id, session_id, pane_id)?;
            Ok(())
        }
        ClientToDaemon::WritePane {
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
            Ok(())
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
                    &coordinator,
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
                &coordinator,
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
            let response = dispatch_remote_request(&remote, &request_json)?;
            send(
                tx,
                DaemonToClient::Reply {
                    req,
                    result: ReplyResult::Remote(serde_json::to_string(&response)?),
                },
            )
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

            if let Ok(paths) = paths::daemon_paths() {
                let _ = fs::remove_file(paths.pid);
            }
            // Exit the process to unblock the main thread's accept() loop
            std::process::exit(0);
        }
    }
}

fn dispatch_remote_request(remote: &RemoteServer, request_json: &str) -> Result<Value> {
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
        "paneLease" => Ok(serde_json::to_value(
            remote.pane_lease(
                request
                    .get("paneId")
                    .and_then(Value::as_str)
                    .context("paneId is required")?,
            )?,
        )?),
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

fn request_id(msg: &ClientToDaemon) -> Option<crate::protocol::Req> {
    match msg {
        ClientToDaemon::Authenticate { req, .. }
        | ClientToDaemon::Ping { req }
        | ClientToDaemon::ListSessions { req }
        | ClientToDaemon::CreateSession { req, .. }
        | ClientToDaemon::RenameSession { req, .. }
        | ClientToDaemon::DeleteSession { req, .. }
        | ClientToDaemon::AttachSession { req, .. }
        | ClientToDaemon::SpawnPane { req, .. }
        | ClientToDaemon::SetPaneTitle { req, .. }
        | ClientToDaemon::SetPaneRole { req, .. }
        | ClientToDaemon::ClosePane { req, .. }
        | ClientToDaemon::ClearSession { req, .. }
        | ClientToDaemon::GetScrollback { req, .. }
        | ClientToDaemon::TaskEvent { req, .. }
        | ClientToDaemon::Control { req, .. }
        | ClientToDaemon::Orchestration { req, .. }
        | ClientToDaemon::Cli { req, .. }
        | ClientToDaemon::Computer { req, .. }
        | ClientToDaemon::Remote { req, .. }
        | ClientToDaemon::ResourceSnapshot { req }
        | ClientToDaemon::Shutdown { req } => Some(*req),
        ClientToDaemon::Hello { .. }
        | ClientToDaemon::DetachSession { .. }
        | ClientToDaemon::SaveLayout { .. }
        | ClientToDaemon::AttachPane { .. }
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
    lock_state(&state).pane_metas(session_id)?;

    let pane_id = cfg.pane_id;
    cfg.env = pty::inject_pane_identity(std::mem::take(&mut cfg.env), session_id, pane_id);
    let spawned = Pane::spawn(cfg)?;
    let child = spawned.pane.child();
    let reader = spawned.reader;
    let meta = {
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

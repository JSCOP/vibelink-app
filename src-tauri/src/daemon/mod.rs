// Daemon module map:
// - `bootstrap`: startup, schedulers, process cleanup, persistence recovery, and shutdown.
// - `auth`: admission challenge/proof checks, capability authorization, and policy revocation.
// - `connection`: socket client lifecycle and desktop browser-host request routing.
// - `dispatch`: the central protocol router plus CLI, orchestration, worktree, and Remote handlers.
// - `panes`: PTY spawn/output, resize/write authorization, lease effects, and pane termination.
// - `session`, `persistence`, `pty`, `scrollback`, and `terminal_history`: daemon state and storage.
// - `automation` and `lifecycle`: scheduled work and long-lived daemon lifetime guards.
//
// Locking contracts:
// - Acquire `PERSISTENCE_LOCK` before the state lock; never acquire them in reverse order.
// - Release every state guard before calling `Pane::kill`.
// - Return lease/output effects by value from locked regions and send them outside the state mutex.

mod auth;
pub mod automation;
mod bootstrap;
mod browser_cdp;
mod connection;
pub(crate) mod conpty;
mod dispatch;
mod lifecycle;
mod panes;
pub mod paths;
pub(crate) mod persistence;
pub mod proc;
pub mod pty;
pub(crate) mod query_filter;
pub(crate) mod scrollback;
pub mod session;
mod terminal_history;
use auth::{authenticate_connection, AdmissionError};
pub use bootstrap::run;
use bootstrap::{
    cleanup_dispatch_target, cleanup_run_resources, exit_daemon_process,
    kill_pane_processes_until_exit, orchestration_now_millis, process_start_time,
    request_computer_host,
};
#[cfg(test)]
use bootstrap::{reconstruct_sessions, rotate_daemon_log, PidFileGuard, DAEMON_LOG_ROTATE_LIMIT};
use connection::{
    dispatch_browser_host_request, handle_connection, register_browser_host,
    resolve_browser_host_response, BrowserHostRouter,
};
#[cfg(test)]
use dispatch::{
    automation_cli_id, automation_json_payload, debounce_persist_state,
    remote_pane_lease_status_response, select_cli_worktree_candidate, worktree_initial_pane_config,
    write_automation_terminal_script, CliWorktreeCandidate,
};
use dispatch::{
    automation_workspace, bounded_launch_error, dispatch_message, persist_state,
    provision_automation_worktree, request_id, require_workers_stopped,
    run_automation_in_visible_terminal, stop_debounced_persister,
};
#[cfg(test)]
use panes::send_output_to_clients;
use panes::{
    kill_all_panes, kill_owned_panes, notify_all_sessions_changed, notify_session_changed,
    persist_restorable_panes_and_kill_all, process_pane_lease_transition,
    process_pane_lease_transitions, resize_pane_authorized, restore_pane_for_session, send,
    send_ok, send_pane_lease_transition, send_remote_connection_cleanup,
    spawn_orchestration_pane_for_session, spawn_pane_for_session, write_pane_authorized,
};

use crate::agent_runtime::WorktreeManager;
use crate::app::{
    git::worktree::{WorktreeStorage, WorktreeStorageMode},
    git::worktree_lifecycle::{WorktreeCreateResult, WorktreeLifecycleService},
    git::worktree_registry::{
        WorktreeBlockerKind, WorktreeCheckpointRequest, WorktreeCreateRequest, WorktreeIdRequest,
        WorktreeImportRequest, WorktreeListRequest, WorktreeMoveRequest,
        WorktreeOperationIdRequest, WorktreeOrigin, WorktreeProjection, WorktreeReconcileRequest,
        WorktreeRegistry, WorktreeRemovalPreflightRequest, WorktreeRemovalResult,
        WorktreeRemoveRequest, WorktreeReviewCommentRequest, WorktreeReviewCommentStateRequest,
        WorktreeRuntimeBlockers, WorktreeSetRequest, WORKTREE_METHOD_CANCEL,
        WORKTREE_METHOD_CHECKPOINT, WORKTREE_METHOD_CHECKPOINTS, WORKTREE_METHOD_CREATE,
        WORKTREE_METHOD_IMPORT, WORKTREE_METHOD_LIST, WORKTREE_METHOD_MOVE,
        WORKTREE_METHOD_PREFLIGHT_REMOVE, WORKTREE_METHOD_RECONCILE, WORKTREE_METHOD_REMOVE,
        WORKTREE_METHOD_REVIEW_COMMENTS, WORKTREE_METHOD_REVIEW_COMMENT_PUT,
        WORKTREE_METHOD_REVIEW_COMMENT_STATE, WORKTREE_METHOD_SET,
    },
    spawn_daemon::load_or_create_ipc_secret,
};
use crate::computer_use::{
    platform_process_spawner, ActionRequest, ActionTarget, ApprovalRequest,
    ComputerAction as ProviderComputerAction, HostRequest, HostResponseBody, Point, ProviderError,
    ProviderHostSupervisor, ProviderProcessSpawner, SnapshotLimits, SnapshotRequest,
    WindowIdentity,
};
use crate::control_plane::{ControlCommand, ControlPlane};
use crate::daemon::automation::{
    runner::{AutomationTerminalLaunch, AutomationTerminalResult},
    AutomationRecord, AutomationRunRecord, AutomationRunner, AutomationService,
    AutomationWorktreeProvision, PreparedWorkspace, RunnerOutcome,
};
use crate::daemon::persistence::{load_sessions, save_sessions};
use crate::daemon::pty::{Pane, SharedChild};
use crate::daemon::session::{
    DaemonState, PaneExitEffect, PaneLeaseEffect, PaneLeaseTransition, PaneOutputEffect,
};
use crate::daemon::terminal_history::{
    load_pane_history, prune_orphan_history, remove_pane_history, remove_session_history,
    TerminalHistoryWriter,
};
use crate::dedicated_cli::command::MemoryAction;
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
    constant_time_eq, daemon_auth_proof, read_frame, write_frame, ClientKind, ClientToDaemon,
    DaemonToClient, PaneCommandOrigin, PaneConfig, RemoteBrowserHostRequest,
    RemoteBrowserHostResponse, RemoteConnectionCleanupRequest, RemotePaneLeaseResult,
    RemotePaneLeaseStatusRequest, ReplyResult, Req, DAEMON_AUTH_REQUIRED, DAEMON_PROTOCOL_MISMATCH,
    DAEMON_PROTOCOL_VERSION,
};
use crate::remote::{RemotePaneLeaseStatus, RemoteServer};
use anyhow::{bail, Context, Result};
use crossbeam_channel::{bounded, Sender, TrySendError};
use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};
use rand::{rngs::OsRng, RngCore};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::Command,
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
type SharedComputerHost = Sender<ComputerHostCall>;

struct ComputerHostCall {
    operation_id: Uuid,
    request: HostRequest,
    reply: Sender<std::result::Result<HostResponseBody, ProviderError>>,
}
const CLIENT_WRITE_TIMEOUT: Duration = Duration::from_secs(3);
type SharedConnections = Arc<Mutex<std::collections::HashSet<Uuid>>>;
const CLIENT_QUEUE_CAPACITY: usize = 256;
const PERSIST_DEBOUNCE_INTERVAL: Duration = Duration::from_millis(500);
const REMOTE_PANE_LEASE_SWEEP_INTERVAL: Duration = Duration::from_secs(1);
const AUTOMATION_SCHEDULER_INTERVAL: Duration = Duration::from_secs(30);
const AUTOMATION_SCHEDULER_SHUTDOWN_POLL_INTERVAL: Duration = Duration::from_millis(100);
const AUTH_CHALLENGE_TTL: Duration = Duration::from_secs(3);
static PERSISTENCE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static DEBOUNCED_PERSISTER: LazyLock<Mutex<Option<DebouncedPersister>>> =
    LazyLock::new(|| Mutex::new(None));
static ORCHESTRATION_LAUNCH_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
static BROWSER_HOST_ROUTER: LazyLock<Mutex<BrowserHostRouter>> =
    LazyLock::new(|| Mutex::new(BrowserHostRouter::default()));

struct DebouncedPersister {
    dirty: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    handle: thread::JoinHandle<()>,
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
    ) -> std::result::Result<(), AdmissionError> {
        if self.consumed {
            return Err(AdmissionError::AuthRequired);
        }
        self.consumed = true;
        if now > self.expires_at || client_id != self.client_id {
            return Err(AdmissionError::AuthRequired);
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
            return Err(AdmissionError::AuthRequired);
        }
        Ok(())
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

struct StartupPaneCleanup {
    state: SharedState,
    armed: bool,
}

impl StartupPaneCleanup {
    fn new(state: SharedState) -> Self {
        Self { state, armed: true }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for StartupPaneCleanup {
    fn drop(&mut self) {
        if self.armed {
            warn!("daemon startup failed after pane restoration; terminating reconstructed PTYs");
            kill_all_panes(&self.state);
        }
    }
}

#[cfg(test)]
#[path = "tests.rs"]
mod tests;

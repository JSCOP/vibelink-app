pub mod adapters;
mod durable;
pub use durable::*;

use crate::control_plane::ControlPlane;
use adapters::AgentProvider;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, sync::Arc};
use thiserror::Error;
use uuid::Uuid;

const DEFAULT_MAX_CONCURRENT: u32 = 4;
const CIRCUIT_BREAKER_FAILURES: u32 = 3;
const DEFAULT_HEARTBEAT_SILENCE_MILLIS: u64 = 60_000;

pub type CoordinatorResult<T> = Result<T, CoordinatorError>;

#[derive(Debug, Error)]
pub enum CoordinatorError {
    #[error("not found: {0}")]
    NotFound(String),
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("stale revision for {entity}: expected {expected}, current {current}")]
    StaleRevision {
        entity: String,
        expected: u64,
        current: u64,
    },
    #[error("invalid transition: {0}")]
    InvalidTransition(String),
    #[error("invalid dependency: {0}")]
    InvalidDependency(String),
    #[error("lifecycle identity mismatch: {0}")]
    IdentityMismatch(String),
    #[error("invalid argument: {0}")]
    InvalidArgument(String),
    #[error("storage failure: {0}")]
    Storage(String),
}

impl CoordinatorError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::StaleRevision { .. } => "stale_revision",
            Self::InvalidTransition(_) => "invalid_transition",
            Self::InvalidDependency(_) => "invalid_dependency",
            Self::IdentityMismatch(_) => "identity_mismatch",
            Self::InvalidArgument(_) => "invalid_argument",
            Self::Storage(_) => "internal_failure",
        }
    }
}

impl From<rusqlite::Error> for CoordinatorError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

impl From<serde_json::Error> for CoordinatorError {
    fn from(error: serde_json::Error) -> Self {
        Self::Storage(error.to_string())
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Queued,
    Planning,
    Running,
    Waiting,
    Paused,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OrchestrationTaskStatus {
    Pending,
    Ready,
    Dispatched,
    Completed,
    Failed,
    Blocked,
    Cancelled,
}

impl OrchestrationTaskStatus {
    fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Blocked | Self::Cancelled
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchStatus {
    Pending,
    Dispatched,
    Running,
    Waiting,
    Completed,
    Failed,
    CircuitBroken,
    Cancelled,
}

impl DispatchStatus {
    fn is_active(self) -> bool {
        matches!(
            self,
            Self::Pending | Self::Dispatched | Self::Running | Self::Waiting
        )
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GateStatus {
    Pending,
    Resolved,
    Timeout,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MessageType {
    Status,
    Dispatch,
    WorkerDone,
    MergeReady,
    Escalation,
    Handoff,
    DecisionGate,
    Heartbeat,
    Chat,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentLifecycleStatus {
    Registered,
    Starting,
    Running,
    Waiting,
    Reconciling,
    Completed,
    Failed,
    Lost,
    Cancelled,
    Stopped,
}

impl AgentLifecycleStatus {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Lost | Self::Cancelled | Self::Stopped
        )
    }

    pub fn is_active(self) -> bool {
        matches!(
            self,
            Self::Starting | Self::Running | Self::Waiting | Self::Reconciling
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunPolicy {
    #[serde(default = "default_max_concurrent")]
    pub max_concurrent: u32,
}

impl Default for RunPolicy {
    fn default() -> Self {
        Self {
            max_concurrent: DEFAULT_MAX_CONCURRENT,
        }
    }
}

fn default_max_concurrent() -> u32 {
    DEFAULT_MAX_CONCURRENT
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRecord {
    pub id: String,
    pub session_id: String,
    pub goal: String,
    pub status: RunStatus,
    pub revision: u64,
    pub policy: RunPolicy,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRecord {
    pub id: String,
    pub run_id: String,
    pub title: String,
    pub description: String,
    pub status: OrchestrationTaskStatus,
    pub revision: u64,
    pub position: u64,
    pub dependencies: Vec<String>,
    pub result: Option<Value>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeAssignment {
    pub base_revision: String,
    pub branch: String,
    pub worktree_path: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchRecord {
    pub id: String,
    pub task_id: String,
    pub attempt: u32,
    pub agent_instance_id: Option<String>,
    pub status: DispatchStatus,
    pub pane_id: Option<String>,
    pub process_generation: Option<u64>,
    pub worktree: Option<WorktreeAssignment>,
    pub failure_code: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInstanceRecord {
    pub id: String,
    pub provider: AgentProvider,
    pub profile: Option<String>,
    pub workspace_path: String,
    pub worktree_path: Option<String>,
    pub runtime_identity: Option<String>,
    pub status: AgentLifecycleStatus,
    pub resumable: bool,
    pub generation: u64,
    pub last_heartbeat_at: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageRecord {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub dispatch_id: Option<String>,
    pub parent_id: Option<String>,
    pub sender_kind: String,
    pub message_type: MessageType,
    pub payload: Value,
    pub unread: bool,
    pub delivered_at: Option<u64>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionGateRecord {
    pub id: String,
    pub run_id: String,
    pub task_id: Option<String>,
    pub dispatch_id: Option<String>,
    pub status: GateStatus,
    pub gate_type: String,
    pub prompt: String,
    pub options: Vec<String>,
    pub resolution: Option<Value>,
    pub expires_at: Option<u64>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleIdentity {
    pub task_id: String,
    pub dispatch_id: String,
    pub agent_instance_id: String,
    pub pane_id: Option<String>,
    pub process_generation: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRunRequest {
    pub session_id: String,
    pub goal: String,
    #[serde(default)]
    pub policy: RunPolicy,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub run_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub dependencies: Vec<String>,
    pub expected_run_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRevisionRequest {
    pub run_id: String,
    pub expected_run_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleRequest {
    pub run_id: String,
    pub expected_run_revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleResult {
    pub run: RunRecord,
    pub dispatches: Vec<DispatchRecord>,
    pub newly_ready_task_ids: Vec<String>,
    pub newly_blocked_task_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterAgentRequest {
    pub provider: AgentProvider,
    pub profile: Option<String>,
    pub workspace_path: String,
    pub worktree_path: Option<String>,
    pub resumable: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindDispatchRequest {
    pub dispatch_id: String,
    pub expected_task_revision: u64,
    pub agent_instance_id: String,
    pub runtime_identity: String,
    pub pane_id: Option<String>,
    pub process_generation: u64,
    pub worktree: Option<WorktreeAssignment>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoundDispatch {
    pub task: TaskRecord,
    pub dispatch: DispatchRecord,
    pub agent: AgentInstanceRecord,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchFailureRequest {
    pub dispatch_id: String,
    pub expected_task_revision: u64,
    pub failure_code: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchFailureResult {
    pub task: TaskRecord,
    pub dispatch: DispatchRecord,
    pub consecutive_failures: u32,
    pub circuit_broken: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeartbeatRequest {
    pub identity: LifecycleIdentity,
    pub observed_at: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterObservationStatus {
    Running,
    Waiting,
    Stopped,
    Lost,
    Failed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentObservation {
    pub agent_instance_id: String,
    pub status: AdapterObservationStatus,
    pub runtime_identity: Option<String>,
    pub generation: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileLivenessRequest {
    pub run_id: String,
    pub expected_run_revision: u64,
    pub now_millis: u64,
    #[serde(default = "default_heartbeat_silence")]
    pub silence_after_millis: u64,
    #[serde(default)]
    pub observations: Vec<AgentObservation>,
}

fn default_heartbeat_silence() -> u64 {
    DEFAULT_HEARTBEAT_SILENCE_MILLIS
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconciliationActionKind {
    Probe,
    Resume,
    Waiting,
    Recovered,
    BlockedAgentLost,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationAction {
    pub agent_instance_id: String,
    pub dispatch_id: String,
    pub task_id: String,
    pub kind: ReconciliationActionKind,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileLivenessResult {
    pub run: RunRecord,
    pub actions: Vec<ReconciliationAction>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDoneRequest {
    pub identity: LifecycleIdentity,
    pub expected_task_revision: u64,
    #[serde(default)]
    pub files_modified: Vec<String>,
    pub report_path: Option<String>,
    pub result: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerDoneResult {
    pub run: RunRecord,
    pub task: TaskRecord,
    pub dispatch: DispatchRecord,
    pub message: MessageRecord,
    pub merge_gate: Option<DecisionGateRecord>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateGateRequest {
    pub run_id: String,
    pub task_id: Option<String>,
    pub dispatch_id: Option<String>,
    pub gate_type: String,
    pub prompt: String,
    #[serde(default)]
    pub options: Vec<String>,
    pub expires_at: Option<u64>,
    pub expected_run_revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolveGateRequest {
    pub gate_id: String,
    pub resolution: Value,
    pub expected_run_revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GateMutationResult {
    pub run: RunRecord,
    pub gate: DecisionGateRecord,
    pub dispatch: Option<DispatchRecord>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostMessageRequest {
    pub run_id: String,
    pub task_id: Option<String>,
    pub dispatch_id: Option<String>,
    pub parent_id: Option<String>,
    pub sender_kind: String,
    pub message_type: MessageType,
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeAppliedRequest {
    pub gate_id: String,
    pub expected_run_revision: u64,
    pub commit_id: String,
}

pub struct CoordinatorService {
    control: Arc<ControlPlane>,
}

impl CoordinatorService {
    pub fn new(control: Arc<ControlPlane>) -> Self {
        Self { control }
    }

    pub fn create_run(
        &self,
        operation_id: Uuid,
        request: CreateRunRequest,
    ) -> CoordinatorResult<RunRecord> {
        validate_uuid(&request.session_id, "session id")?;
        let goal = required(&request.goal, "run goal")?;
        if request.policy.max_concurrent == 0 {
            return Err(CoordinatorError::InvalidArgument(
                "maxConcurrent must be at least 1".to_string(),
            ));
        }
        self.mutate(operation_id, "orchestration.run.create", request, move |transaction, request| { let now = now_millis();
        let run = RunRecord {
            id: Uuid::new_v4().to_string(),
            session_id: request.session_id,
            goal,
            status: RunStatus::Queued,
            revision: 0,
            policy: request.policy,
            created_at: now,
            updated_at: now,
        };
        transaction.execute(
            "INSERT INTO orchestration_runs(id, session_id, goal, status, revision, policy_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?6)",
            params![run.id, run.session_id, run.goal, run_status_text(run.status), serde_json::to_string(&run.policy)?, now as i64],
        )?;
        insert_event(transaction, Some(&run.id), "orchestration", "run.created", Some(&run.id), operation_id, json!({"status": run.status}))?;
        Ok(run) })
    }

    pub fn start_run(
        &self,
        operation_id: Uuid,
        request: RunRevisionRequest,
    ) -> CoordinatorResult<RunRecord> {
        self.mutate(
            operation_id,
            "orchestration.run.start",
            request,
            move |transaction, request| {
                let mut run = read_run(transaction, &request.run_id)?;
                require_run_revision(&run, request.expected_run_revision)?;
                if !matches!(
                    run.status,
                    RunStatus::Queued | RunStatus::Planning | RunStatus::Paused
                ) {
                    return Err(CoordinatorError::InvalidTransition(format!(
                        "run {} cannot start from {:?}",
                        run.id, run.status
                    )));
                }
                update_run_status(transaction, &mut run, RunStatus::Running)?;
                insert_event(
                    transaction,
                    Some(&run.id),
                    "orchestration",
                    "run.started",
                    Some(&run.id),
                    operation_id,
                    json!({"revision": run.revision}),
                )?;
                Ok(run)
            },
        )
    }

    pub fn create_task(
        &self,
        operation_id: Uuid,
        request: CreateTaskRequest,
    ) -> CoordinatorResult<TaskRecord> {
        let title = required(&request.title, "task title")?;
        self.mutate(operation_id, "orchestration.task.create", request, move |transaction, request| { let mut run = read_run(transaction, &request.run_id)?;
        require_run_revision(&run, request.expected_run_revision)?;
        if run.status.is_terminal() {
            return Err(CoordinatorError::InvalidTransition(format!(
                "cannot add tasks to {:?} run", run.status
            )));
        }
        let mut dependencies = request.dependencies;
        dependencies.sort();
        dependencies.dedup();
        for dependency in &dependencies {
            let dependency_task = read_task(transaction, dependency)?;
            if dependency_task.run_id != run.id {
                return Err(CoordinatorError::InvalidDependency(format!(
                    "dependency {dependency} belongs to another run"
                )));
            }
        }
        let position: i64 = transaction.query_row(
            "SELECT COALESCE(MAX(position), -1) + 1 FROM orchestration_tasks WHERE run_id = ?1",
            [&run.id],
            |row| row.get(0),
        )?;
        let now = now_millis();
        let task = TaskRecord {
            id: Uuid::new_v4().to_string(),
            run_id: run.id.clone(),
            title,
            description: request.description,
            status: OrchestrationTaskStatus::Pending,
            revision: 0,
            position: position.max(0) as u64,
            dependencies: dependencies.clone(),
            result: None,
            created_at: now,
            updated_at: now,
        };
        transaction.execute(
            "INSERT INTO orchestration_tasks(id, run_id, title, description, status, revision, position, result_json, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', 0, ?5, NULL, ?6, ?6)",
            params![task.id, task.run_id, task.title, task.description, position, now as i64],
        )?;
        for dependency in dependencies {
            transaction.execute(
                "INSERT INTO task_dependencies(task_id, depends_on_task_id) VALUES (?1, ?2)",
                params![task.id, dependency],
            )?;
        }
        bump_run_revision(transaction, &mut run)?;
        insert_event(transaction, Some(&run.id), "orchestration", "task.created", Some(&task.id), operation_id, json!({"dependencies": task.dependencies, "position": task.position}))?;
        Ok(task) })
    }

    pub fn schedule_ready(
        &self,
        operation_id: Uuid,
        request: ScheduleRequest,
    ) -> CoordinatorResult<ScheduleResult> {
        self.mutate(operation_id, "orchestration.schedule", request, move |transaction, request| { let mut run = read_run(transaction, &request.run_id)?;
        require_run_revision(&run, request.expected_run_revision)?;
        if !matches!(run.status, RunStatus::Running | RunStatus::Waiting) {
            return Err(CoordinatorError::InvalidTransition(format!(
                "run {} cannot schedule from {:?}", run.id, run.status
            )));
        }

        let mut newly_ready = Vec::new();
        let mut newly_blocked = Vec::new();
        let pending_ids = query_ids(
            transaction,
            "SELECT id FROM orchestration_tasks WHERE run_id = ?1 AND status = 'pending' ORDER BY position, id",
            &run.id,
        )?;
        for task_id in pending_ids {
            let dependency_statuses = dependency_statuses(transaction, &task_id)?;
            if dependency_statuses.iter().any(|status| {
                matches!(
                    status,
                    OrchestrationTaskStatus::Failed
                        | OrchestrationTaskStatus::Blocked
                        | OrchestrationTaskStatus::Cancelled
                )
            }) {
                set_task_status(
                    transaction,
                    &task_id,
                    OrchestrationTaskStatus::Blocked,
                    Some(json!({"reason": "dependency_failed"})),
                )?;
                newly_blocked.push(task_id);
            } else if dependency_statuses
                .iter()
                .all(|status| *status == OrchestrationTaskStatus::Completed)
            {
                set_task_status(
                    transaction,
                    &task_id,
                    OrchestrationTaskStatus::Ready,
                    None,
                )?;
                newly_ready.push(task_id);
            }
        }

        let active: u32 = transaction.query_row(
            "SELECT COUNT(*) FROM dispatches d JOIN orchestration_tasks t ON t.id = d.task_id WHERE t.run_id = ?1 AND d.status IN ('pending','dispatched','running','waiting')",
            [&run.id],
            |row| row.get::<_, i64>(0),
        )?.max(0) as u32;
        let capacity = run.policy.max_concurrent.saturating_sub(active) as usize;
        let ready_ids = query_ids_limited(
            transaction,
            "SELECT id FROM orchestration_tasks WHERE run_id = ?1 AND status = 'ready' ORDER BY position, id LIMIT ?2",
            &run.id,
            capacity,
        )?;
        let mut dispatches = Vec::new();
        for task_id in ready_ids {
            let attempt: i64 = transaction.query_row(
                "SELECT COALESCE(MAX(attempt), 0) + 1 FROM dispatches WHERE task_id = ?1",
                [&task_id],
                |row| row.get(0),
            )?;
            let now = now_millis();
            let dispatch_id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO dispatches(id, task_id, attempt, status, created_at, updated_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?4)",
                params![dispatch_id, task_id, attempt, now as i64],
            )?;
            set_task_status(
                transaction,
                &task_id,
                OrchestrationTaskStatus::Dispatched,
                None,
            )?;
            insert_event(transaction, Some(&run.id), "orchestration", "dispatch.created", Some(&dispatch_id), operation_id, json!({"taskId": task_id, "attempt": attempt}))?;
            dispatches.push(read_dispatch(transaction, &dispatch_id)?);
        }

        if !dispatches.is_empty() && run.status != RunStatus::Running {
            update_run_status(transaction, &mut run, RunStatus::Running)?;
        } else if !newly_ready.is_empty() || !newly_blocked.is_empty() || !dispatches.is_empty() {
            bump_run_revision(transaction, &mut run)?;
        }
        refresh_terminal_run_status(transaction, &mut run)?;
        Ok(ScheduleResult {
            run,
            dispatches,
            newly_ready_task_ids: newly_ready,
            newly_blocked_task_ids: newly_blocked,
        }) })
    }

    pub fn register_agent(
        &self,
        operation_id: Uuid,
        request: RegisterAgentRequest,
    ) -> CoordinatorResult<AgentInstanceRecord> {
        let workspace_path = required(&request.workspace_path, "workspace path")?;
        self.mutate(operation_id, "orchestration.agent.register", request, move |transaction, request| { let now = now_millis();
        let agent = AgentInstanceRecord {
            id: Uuid::new_v4().to_string(),
            provider: request.provider,
            profile: trim_optional(request.profile),
            workspace_path,
            worktree_path: trim_optional(request.worktree_path),
            runtime_identity: None,
            status: AgentLifecycleStatus::Registered,
            resumable: request.resumable,
            generation: 0,
            last_heartbeat_at: None,
            created_at: now,
            updated_at: now,
        };
        transaction.execute(
            "INSERT INTO agent_instances(id, provider, profile, workspace_path, worktree_path, runtime_identity, status, resumable, generation, last_heartbeat_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'registered', ?6, 0, NULL, ?7, ?7)",
            params![agent.id, provider_text(agent.provider), agent.profile, agent.workspace_path, agent.worktree_path, agent.resumable as i64, now as i64],
        )?;
        insert_event(transaction, None, "orchestration", "agent.registered", Some(&agent.id), operation_id, json!({"provider": agent.provider}))?;
        Ok(agent) })
    }

    pub fn bind_dispatch(
        &self,
        operation_id: Uuid,
        request: BindDispatchRequest,
    ) -> CoordinatorResult<BoundDispatch> {
        let runtime_identity = required(&request.runtime_identity, "runtime identity")?;
        self.mutate(operation_id, "orchestration.dispatch.bind", request, move |transaction, request| { let mut dispatch = read_dispatch(transaction, &request.dispatch_id)?;
        if dispatch.status != DispatchStatus::Pending {
            return Err(CoordinatorError::InvalidTransition(format!(
                "dispatch {} cannot bind from {:?}", dispatch.id, dispatch.status
            )));
        }
        let mut task = read_task(transaction, &dispatch.task_id)?;
        require_task_revision(&task, request.expected_task_revision)?;
        let agent = read_agent(transaction, &request.agent_instance_id)?;
        if agent.status.is_active() {
            return Err(CoordinatorError::Conflict(format!(
                "agent {} is already active", agent.id
            )));
        }
        if let Some(worktree) = &request.worktree {
            validate_worktree(worktree)?;
        }
        let now = now_millis();
        transaction.execute(
            "UPDATE dispatches SET agent_instance_id=?2, status='dispatched', pane_id=?3, process_generation=?4, base_revision=?5, branch=?6, worktree_path=?7, updated_at=?8 WHERE id=?1",
            params![
                dispatch.id,
                agent.id,
                request.pane_id,
                request.process_generation as i64,
                request.worktree.as_ref().map(|value| value.base_revision.as_str()),
                request.worktree.as_ref().map(|value| value.branch.as_str()),
                request.worktree.as_ref().map(|value| value.worktree_path.as_str()),
                now as i64,
            ],
        )?;
        transaction.execute(
            "UPDATE agent_instances SET runtime_identity=?2, status='starting', generation=?3, worktree_path=COALESCE(?4, worktree_path), updated_at=?5 WHERE id=?1",
            params![agent.id, runtime_identity, request.process_generation as i64, request.worktree.as_ref().map(|value| value.worktree_path.as_str()), now as i64],
        )?;
        bump_task_revision(transaction, &mut task)?;
        dispatch = read_dispatch(transaction, &dispatch.id)?;
        let agent = read_agent(transaction, &agent.id)?;
        let run_id = task.run_id.clone();
        insert_message(transaction, &run_id, Some(&task.id), Some(&dispatch.id), None, "coordinator", MessageType::Dispatch, json!({"agentInstanceId": agent.id, "attempt": dispatch.attempt}), now)?;
        insert_event(transaction, Some(&run_id), "orchestration", "dispatch.bound", Some(&dispatch.id), operation_id, json!({"agentInstanceId": agent.id, "processGeneration": request.process_generation}))?;
        Ok(BoundDispatch { task, dispatch, agent }) })
    }

    pub fn mark_dispatch_running(
        &self,
        operation_id: Uuid,
        identity: LifecycleIdentity,
        observed_at: u64,
    ) -> CoordinatorResult<BoundDispatch> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Request {
            identity: LifecycleIdentity,
            observed_at: u64,
        }
        self.mutate(
            operation_id,
            "orchestration.dispatch.running",
            Request {
                identity,
                observed_at,
            },
            move |transaction, request| {
                let mut dispatch = validate_identity(transaction, &request.identity)?;
                if !matches!(
                    dispatch.status,
                    DispatchStatus::Dispatched | DispatchStatus::Waiting
                ) {
                    return Err(CoordinatorError::InvalidTransition(format!(
                        "dispatch {} cannot run from {:?}",
                        dispatch.id, dispatch.status
                    )));
                }
                let now = request.observed_at.max(1);
                transaction.execute(
                    "UPDATE dispatches SET status='running', updated_at=?2 WHERE id=?1",
                    params![dispatch.id, now as i64],
                )?;
                transaction.execute(
                    "UPDATE agent_instances SET status='running', last_heartbeat_at=?2, updated_at=?2 WHERE id=?1",
                    params![request.identity.agent_instance_id, now as i64],
                )?;
                let mut task = read_task(transaction, &request.identity.task_id)?;
                bump_task_revision(transaction, &mut task)?;
                dispatch = read_dispatch(transaction, &dispatch.id)?;
                let agent = read_agent(transaction, &request.identity.agent_instance_id)?;
                insert_event(
                    transaction,
                    Some(&task.run_id),
                    "orchestration",
                    "dispatch.running",
                    Some(&dispatch.id),
                    operation_id,
                    json!({"agentInstanceId": agent.id}),
                )?;
                Ok(BoundDispatch {
                    task,
                    dispatch,
                    agent,
                })
            },
        )
    }

    pub fn record_launch_failure(
        &self,
        operation_id: Uuid,
        request: LaunchFailureRequest,
    ) -> CoordinatorResult<LaunchFailureResult> {
        let failure_code = required(&request.failure_code, "failure code")?;
        self.mutate(operation_id, "orchestration.dispatch.launch_failed", request, move |transaction, request| { let mut dispatch = read_dispatch(transaction, &request.dispatch_id)?;
        if !matches!(dispatch.status, DispatchStatus::Pending | DispatchStatus::Dispatched) {
            return Err(CoordinatorError::InvalidTransition(format!(
                "dispatch {} cannot record launch failure from {:?}", dispatch.id, dispatch.status
            )));
        }
        let mut task = read_task(transaction, &dispatch.task_id)?;
        require_task_revision(&task, request.expected_task_revision)?;
        let previous_failures: u32 = transaction.query_row(
            "SELECT COUNT(*) FROM dispatches WHERE task_id=?1 AND id<>?2 AND failure_code LIKE 'launch:%'",
            params![task.id, dispatch.id],
            |row| row.get::<_, i64>(0),
        )?.max(0) as u32;
        let consecutive_failures = previous_failures.saturating_add(1);
        let circuit_broken = consecutive_failures >= CIRCUIT_BREAKER_FAILURES;
        let status = if circuit_broken { DispatchStatus::CircuitBroken } else { DispatchStatus::Failed };
        let stored_failure = format!("launch:{failure_code}");
        transaction.execute(
            "UPDATE dispatches SET status=?2, failure_code=?3, updated_at=?4 WHERE id=?1",
            params![dispatch.id, dispatch_status_text(status), stored_failure, now_millis() as i64],
        )?;
        let task_status = if circuit_broken { OrchestrationTaskStatus::Failed } else { OrchestrationTaskStatus::Ready };
        set_task_status(
            transaction,
            &task.id,
            task_status,
            circuit_broken.then(|| json!({"reason": "launch_circuit_broken", "failures": consecutive_failures, "failureCode": failure_code})),
        )?;
        task = read_task(transaction, &task.id)?;
        dispatch = read_dispatch(transaction, &dispatch.id)?;
        if let Some(agent_id) = &dispatch.agent_instance_id {
            transaction.execute(
                "UPDATE agent_instances SET status='failed', updated_at=?2 WHERE id=?1",
                params![agent_id, now_millis() as i64],
            )?;
        }
        insert_event(transaction, Some(&task.run_id), "orchestration", if circuit_broken { "dispatch.circuit_broken" } else { "dispatch.launch_failed" }, Some(&dispatch.id), operation_id, json!({"failureCode": failure_code, "consecutiveFailures": consecutive_failures}))?;
        Ok(LaunchFailureResult { task, dispatch, consecutive_failures, circuit_broken }) })
    }

    pub fn heartbeat(
        &self,
        operation_id: Uuid,
        request: HeartbeatRequest,
    ) -> CoordinatorResult<AgentInstanceRecord> {
        self.mutate(operation_id, "orchestration.agent.heartbeat", request, move |transaction, request| { let dispatch = validate_identity(transaction, &request.identity)?;
        if !dispatch.status.is_active() {
            return Err(CoordinatorError::InvalidTransition(format!(
                "dispatch {} is not active", dispatch.id
            )));
        }
        let observed_at = request.observed_at.max(1);
        transaction.execute(
            "UPDATE agent_instances SET status='running', last_heartbeat_at=?2, updated_at=?2 WHERE id=?1",
            params![request.identity.agent_instance_id, observed_at as i64],
        )?;
        if dispatch.status == DispatchStatus::Waiting
            && pending_gate_count(transaction, Some(&dispatch.id))? == 0
        {
            transaction.execute(
                "UPDATE dispatches SET status='running', updated_at=?2 WHERE id=?1",
                params![dispatch.id, observed_at as i64],
            )?;
        }
        insert_event(transaction, Some(&read_task(transaction, &dispatch.task_id)?.run_id), "orchestration", "agent.heartbeat", Some(&request.identity.agent_instance_id), operation_id, json!({"dispatchId": dispatch.id, "observedAt": observed_at}))?;
        read_agent(transaction, &request.identity.agent_instance_id) })
    }

    pub fn reconcile_liveness(
        &self,
        operation_id: Uuid,
        request: ReconcileLivenessRequest,
    ) -> CoordinatorResult<ReconcileLivenessResult> {
        self.mutate(operation_id, "orchestration.agent.reconcile", request, move |transaction, request| { let mut run = read_run(transaction, &request.run_id)?;
        require_run_revision(&run, request.expected_run_revision)?;
        let cutoff = request.now_millis.saturating_sub(request.silence_after_millis.max(1));
        let observations = request
            .observations
            .into_iter()
            .map(|observation| (observation.agent_instance_id.clone(), observation))
            .collect::<HashMap<_, _>>();
        let mut statement = transaction.prepare(
            "SELECT a.id, d.id, d.task_id FROM agent_instances a JOIN dispatches d ON d.agent_instance_id=a.id JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 AND d.status IN ('dispatched','running','waiting') AND COALESCE(a.last_heartbeat_at, 0) < ?2 ORDER BY t.position, d.attempt, a.id",
        )?;
        let stale = statement
            .query_map(params![run.id, cutoff as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        let mut actions = Vec::new();
        for (agent_id, dispatch_id, task_id) in stale {
            let agent = read_agent(transaction, &agent_id)?;
            let observation = observations.get(&agent_id);
            let (agent_status, dispatch_status, action, task_block) = match observation.map(|value| value.status) {
                Some(AdapterObservationStatus::Running) => (AgentLifecycleStatus::Running, DispatchStatus::Running, ReconciliationActionKind::Recovered, false),
                Some(AdapterObservationStatus::Waiting) => (AgentLifecycleStatus::Waiting, DispatchStatus::Waiting, ReconciliationActionKind::Waiting, false),
                Some(AdapterObservationStatus::Stopped | AdapterObservationStatus::Lost | AdapterObservationStatus::Failed) if agent.resumable => (AgentLifecycleStatus::Reconciling, DispatchStatus::Waiting, ReconciliationActionKind::Resume, false),
                Some(AdapterObservationStatus::Stopped | AdapterObservationStatus::Lost | AdapterObservationStatus::Failed) => (AgentLifecycleStatus::Lost, DispatchStatus::Failed, ReconciliationActionKind::BlockedAgentLost, true),
                None => (AgentLifecycleStatus::Reconciling, DispatchStatus::Waiting, ReconciliationActionKind::Probe, false),
            };
            if let Some(observation) = observation {
                if let Some(runtime_identity) = &observation.runtime_identity {
                    if agent.runtime_identity.as_deref() != Some(runtime_identity.as_str()) {
                        return Err(CoordinatorError::IdentityMismatch(format!(
                            "agent {agent_id} runtime identity changed"
                        )));
                    }
                }
                if let Some(generation) = observation.generation {
                    if generation != agent.generation {
                        return Err(CoordinatorError::IdentityMismatch(format!(
                            "agent {agent_id} generation changed"
                        )));
                    }
                }
            }
            transaction.execute(
                "UPDATE agent_instances SET status=?2, last_heartbeat_at=CASE WHEN ?2='running' THEN ?3 ELSE last_heartbeat_at END, updated_at=?3 WHERE id=?1",
                params![agent_id, agent_status_text(agent_status), request.now_millis as i64],
            )?;
            transaction.execute(
                "UPDATE dispatches SET status=?2, failure_code=CASE WHEN ?3 THEN 'agent_lost' ELSE failure_code END, updated_at=?4 WHERE id=?1",
                params![dispatch_id, dispatch_status_text(dispatch_status), task_block, request.now_millis as i64],
            )?;
            if task_block {
                set_task_status(transaction, &task_id, OrchestrationTaskStatus::Blocked, Some(json!({"reason": "agent_lost"})))?;
            }
            actions.push(ReconciliationAction { agent_instance_id: agent_id, dispatch_id, task_id, kind: action });
        }
        if !actions.is_empty() {
            bump_run_revision(transaction, &mut run)?;
            insert_event(transaction, Some(&run.id), "orchestration", "agents.reconciled", Some(&run.id), operation_id, json!({"actions": actions}))?;
        }
        Ok(ReconcileLivenessResult { run, actions }) })
    }

    pub fn worker_done(
        &self,
        operation_id: Uuid,
        request: WorkerDoneRequest,
    ) -> CoordinatorResult<WorkerDoneResult> {
        self.mutate(operation_id, "orchestration.worker_done", request, move |transaction, request| { let mut dispatch = validate_identity(transaction, &request.identity)?;
        if !matches!(dispatch.status, DispatchStatus::Running | DispatchStatus::Waiting) {
            return Err(CoordinatorError::InvalidTransition(format!(
                "dispatch {} cannot complete from {:?}", dispatch.id, dispatch.status
            )));
        }
        let mut task = read_task(transaction, &request.identity.task_id)?;
        require_task_revision(&task, request.expected_task_revision)?;
        let mut run = read_run(transaction, &task.run_id)?;
        let now = now_millis();
        transaction.execute(
            "UPDATE dispatches SET status='completed', updated_at=?2 WHERE id=?1",
            params![dispatch.id, now as i64],
        )?;
        set_task_status(transaction, &task.id, OrchestrationTaskStatus::Completed, Some(request.result.clone()))?;
        transaction.execute(
            "UPDATE agent_instances SET status='completed', updated_at=?2 WHERE id=?1",
            params![request.identity.agent_instance_id, now as i64],
        )?;
        let message = insert_message(
            transaction,
            &run.id,
            Some(&task.id),
            Some(&dispatch.id),
            None,
            "worker",
            MessageType::WorkerDone,
            json!({
                "taskId": task.id,
                "dispatchId": dispatch.id,
                "agentInstanceId": request.identity.agent_instance_id,
                "filesModified": request.files_modified,
                "reportPath": request.report_path,
                "result": request.result,
            }),
            now,
        )?;
        dispatch = read_dispatch(transaction, &dispatch.id)?;
        task = read_task(transaction, &task.id)?;
        let merge_gate = if dispatch.worktree.is_some() {
            let gate = create_gate_record(
                transaction,
                &run.id,
                Some(&task.id),
                Some(&dispatch.id),
                "merge",
                "Approve merging this completed worktree into the user's branch?",
                vec!["approve".to_string(), "reject".to_string()],
                None,
                now,
            )?;
            insert_message(transaction, &run.id, Some(&task.id), Some(&dispatch.id), None, "coordinator", MessageType::MergeReady, json!({"gateId": gate.id, "worktree": dispatch.worktree}), now)?;
            Some(gate)
        } else {
            None
        };
        if merge_gate.is_some() {
            update_run_status(transaction, &mut run, RunStatus::Waiting)?;
        } else {
            bump_run_revision(transaction, &mut run)?;
            refresh_terminal_run_status(transaction, &mut run)?;
        }
        insert_event(transaction, Some(&run.id), "orchestration", "worker.completed", Some(&dispatch.id), operation_id, json!({"taskId": task.id, "mergeGateId": merge_gate.as_ref().map(|gate| &gate.id)}))?;
        Ok(WorkerDoneResult { run, task, dispatch, message, merge_gate }) })
    }

    pub fn create_gate(
        &self,
        operation_id: Uuid,
        request: CreateGateRequest,
    ) -> CoordinatorResult<GateMutationResult> {
        let gate_type = required(&request.gate_type, "gate type")?;
        let prompt = required(&request.prompt, "gate prompt")?;
        self.mutate(operation_id, "orchestration.gate.create", request, move |transaction, request| { let mut run = read_run(transaction, &request.run_id)?;
        require_run_revision(&run, request.expected_run_revision)?;
        validate_scope(transaction, &run.id, request.task_id.as_deref(), request.dispatch_id.as_deref())?;
        let now = now_millis();
        let gate = create_gate_record(transaction, &run.id, request.task_id.as_deref(), request.dispatch_id.as_deref(), &gate_type, &prompt, request.options, request.expires_at, now)?;
        let dispatch = if let Some(dispatch_id) = &request.dispatch_id {
            transaction.execute(
                "UPDATE dispatches SET status='waiting', updated_at=?2 WHERE id=?1 AND status IN ('dispatched','running')",
                params![dispatch_id, now as i64],
            )?;
            let dispatch = read_dispatch(transaction, dispatch_id)?;
            if let Some(agent_id) = &dispatch.agent_instance_id {
                transaction.execute(
                    "UPDATE agent_instances SET status='waiting', updated_at=?2 WHERE id=?1 AND status IN ('starting','running','reconciling')",
                    params![agent_id, now as i64],
                )?;
            }
            Some(dispatch)
        } else {
            None
        };
        update_run_status(transaction, &mut run, RunStatus::Waiting)?;
        insert_message(transaction, &run.id, request.task_id.as_deref(), request.dispatch_id.as_deref(), None, "coordinator", MessageType::DecisionGate, json!({"gateId": gate.id, "gateType": gate.gate_type, "prompt": gate.prompt, "options": gate.options}), now)?;
        insert_event(transaction, Some(&run.id), "orchestration", "gate.created", Some(&gate.id), operation_id, json!({"gateType": gate.gate_type}))?;
        Ok(GateMutationResult { run, gate, dispatch }) })
    }

    pub fn resolve_gate(
        &self,
        operation_id: Uuid,
        request: ResolveGateRequest,
    ) -> CoordinatorResult<GateMutationResult> {
        self.mutate(operation_id, "orchestration.gate.resolve", request, move |transaction, request| { let mut gate = read_gate(transaction, &request.gate_id)?;
        if gate.status != GateStatus::Pending {
            return Err(CoordinatorError::InvalidTransition(format!(
                "gate {} cannot resolve from {:?}", gate.id, gate.status
            )));
        }
        let mut run = read_run(transaction, &gate.run_id)?;
        require_run_revision(&run, request.expected_run_revision)?;
        let decision = request.resolution.get("decision").and_then(Value::as_str).unwrap_or_default();
        if gate.gate_type == "merge" && !matches!(decision, "approve" | "reject") {
            return Err(CoordinatorError::InvalidArgument(
                "merge gate resolution decision must be approve or reject".to_string(),
            ));
        }
        let now = now_millis();
        transaction.execute(
            "UPDATE decision_gates SET status='resolved', resolution_json=?2, updated_at=?3 WHERE id=?1",
            params![gate.id, serde_json::to_string(&request.resolution)?, now as i64],
        )?;
        gate = read_gate(transaction, &gate.id)?;
        let mut dispatch = gate.dispatch_id.as_deref().map(|id| read_dispatch(transaction, id)).transpose()?;
        if gate.gate_type == "merge" {
            if decision == "reject" {
                bump_run_revision(transaction, &mut run)?;
                refresh_terminal_run_status(transaction, &mut run)?;
            } else {
                bump_run_revision(transaction, &mut run)?;
            }
        } else {
            if let Some(current) = dispatch.as_mut() {
                if current.status == DispatchStatus::Waiting
                    && pending_gate_count(transaction, Some(&current.id))? == 0
                {
                    transaction.execute(
                        "UPDATE dispatches SET status='running', updated_at=?2 WHERE id=?1",
                        params![current.id, now as i64],
                    )?;
                    if let Some(agent_id) = &current.agent_instance_id {
                        transaction.execute(
                            "UPDATE agent_instances SET status='running', updated_at=?2 WHERE id=?1 AND status='waiting'",
                            params![agent_id, now as i64],
                        )?;
                    }
                    *current = read_dispatch(transaction, &current.id)?;
                }
            }
            if pending_gate_count_for_run(transaction, &run.id)? == 0 {
                update_run_status(transaction, &mut run, RunStatus::Running)?;
                refresh_terminal_run_status(transaction, &mut run)?;
            } else {
                bump_run_revision(transaction, &mut run)?;
            }
        }
        insert_event(transaction, Some(&run.id), "orchestration", "gate.resolved", Some(&gate.id), operation_id, json!({"resolution": gate.resolution}))?;
        Ok(GateMutationResult { run, gate, dispatch }) })
    }

    pub fn merge_authorization(&self, gate_id: &str) -> CoordinatorResult<WorktreeAssignment> {
        self.control.with_connection(|connection| {
            let gate = read_gate(connection, gate_id)?;
            if gate.gate_type != "merge" || gate.status != GateStatus::Resolved {
                return Err(CoordinatorError::InvalidTransition(format!(
                    "gate {} is not an approved merge gate",
                    gate.id
                )));
            }
            let approved = gate
                .resolution
                .as_ref()
                .and_then(|value| value.get("decision"))
                .and_then(Value::as_str)
                == Some("approve");
            if !approved {
                return Err(CoordinatorError::Conflict(
                    "merge was not approved".to_string(),
                ));
            }
            let dispatch_id = gate.dispatch_id.ok_or_else(|| {
                CoordinatorError::Conflict("merge gate has no dispatch".to_string())
            })?;
            read_dispatch(connection, &dispatch_id)?
                .worktree
                .ok_or_else(|| {
                    CoordinatorError::Conflict("merge dispatch has no worktree record".to_string())
                })
        })
    }

    pub fn mark_merge_applied(
        &self,
        operation_id: Uuid,
        request: MergeAppliedRequest,
    ) -> CoordinatorResult<GateMutationResult> {
        let commit_id = required(&request.commit_id, "merge commit id")?;
        self.mutate(
            operation_id,
            "orchestration.merge.applied",
            request,
            move |transaction, request| {
                let mut gate = read_gate(transaction, &request.gate_id)?;
                let mut run = read_run(transaction, &gate.run_id)?;
                require_run_revision(&run, request.expected_run_revision)?;
                if gate.gate_type != "merge" || gate.status != GateStatus::Resolved {
                    return Err(CoordinatorError::InvalidTransition(
                        "merge gate is not resolved".to_string(),
                    ));
                }
                let mut resolution = gate.resolution.clone().unwrap_or_else(|| json!({}));
                if resolution.get("decision").and_then(Value::as_str) != Some("approve") {
                    return Err(CoordinatorError::Conflict(
                        "merge was not approved".to_string(),
                    ));
                }
                if resolution.get("applied").and_then(Value::as_bool) == Some(true) {
                    return Err(CoordinatorError::Conflict(
                        "merge was already applied".to_string(),
                    ));
                }
                resolution["applied"] = Value::Bool(true);
                resolution["commitId"] = Value::String(commit_id.clone());
                let now = now_millis();
                transaction.execute(
                    "UPDATE decision_gates SET resolution_json=?2, updated_at=?3 WHERE id=?1",
                    params![gate.id, serde_json::to_string(&resolution)?, now as i64],
                )?;
                gate = read_gate(transaction, &gate.id)?;
                bump_run_revision(transaction, &mut run)?;
                refresh_terminal_run_status(transaction, &mut run)?;
                insert_event(
                    transaction,
                    Some(&run.id),
                    "orchestration",
                    "merge.applied",
                    gate.dispatch_id.as_deref(),
                    operation_id,
                    json!({"gateId": gate.id, "commitId": commit_id}),
                )?;
                let dispatch = gate
                    .dispatch_id
                    .as_deref()
                    .map(|id| read_dispatch(transaction, id))
                    .transpose()?;
                Ok(GateMutationResult {
                    run,
                    gate,
                    dispatch,
                })
            },
        )
    }

    pub fn cancel_run(
        &self,
        operation_id: Uuid,
        request: RunRevisionRequest,
    ) -> CoordinatorResult<RunRecord> {
        self.mutate(operation_id, "orchestration.run.cancel", request, move |transaction, request| { let mut run = read_run(transaction, &request.run_id)?;
        require_run_revision(&run, request.expected_run_revision)?;
        if run.status.is_terminal() {
            return Err(CoordinatorError::InvalidTransition(format!(
                "run {} is already {:?}", run.id, run.status
            )));
        }
        let now = now_millis();
        transaction.execute(
            "UPDATE orchestration_tasks SET status='cancelled', revision=revision+1, updated_at=?2 WHERE run_id=?1 AND status NOT IN ('completed','failed','blocked','cancelled')",
            params![run.id, now as i64],
        )?;
        transaction.execute(
            "UPDATE dispatches SET status='cancelled', updated_at=?2 WHERE task_id IN (SELECT id FROM orchestration_tasks WHERE run_id=?1) AND status IN ('pending','dispatched','running','waiting')",
            params![run.id, now as i64],
        )?;
        transaction.execute(
            "UPDATE agent_instances SET status='cancelled', updated_at=?2 WHERE id IN (SELECT agent_instance_id FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 AND d.agent_instance_id IS NOT NULL) AND status IN ('starting','running','waiting','reconciling')",
            params![run.id, now as i64],
        )?;
        transaction.execute(
            "UPDATE decision_gates SET status='cancelled', updated_at=?2 WHERE run_id=?1 AND status='pending'",
            params![run.id, now as i64],
        )?;
        update_run_status(transaction, &mut run, RunStatus::Cancelled)?;
        insert_event(transaction, Some(&run.id), "orchestration", "run.cancelled", Some(&run.id), operation_id, json!({"revision": run.revision}))?;
        Ok(run) })
    }

    pub fn post_message(
        &self,
        operation_id: Uuid,
        request: PostMessageRequest,
    ) -> CoordinatorResult<MessageRecord> {
        if matches!(
            request.message_type,
            MessageType::WorkerDone | MessageType::MergeReady | MessageType::DecisionGate
        ) {
            return Err(CoordinatorError::InvalidArgument(
                "worker_done, merge_ready, and decision_gate messages must use lifecycle methods"
                    .to_string(),
            ));
        }
        let sender_kind = required(&request.sender_kind, "sender kind")?;
        self.mutate(
            operation_id,
            "orchestration.message.post",
            request,
            move |transaction, request| {
                read_run(transaction, &request.run_id)?;
                validate_scope(
                    transaction,
                    &request.run_id,
                    request.task_id.as_deref(),
                    request.dispatch_id.as_deref(),
                )?;
                let message = insert_message(
                    transaction,
                    &request.run_id,
                    request.task_id.as_deref(),
                    request.dispatch_id.as_deref(),
                    request.parent_id.as_deref(),
                    &sender_kind,
                    request.message_type,
                    request.payload,
                    now_millis(),
                )?;
                insert_event(
                    transaction,
                    Some(&request.run_id),
                    "orchestration",
                    "message.created",
                    Some(&message.id),
                    operation_id,
                    json!({"messageType": message.message_type}),
                )?;
                Ok(message)
            },
        )
    }

    pub fn runs_for_session(&self, session_id: &str) -> CoordinatorResult<Vec<RunRecord>> {
        self.control.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id FROM orchestration_runs WHERE session_id=?1 ORDER BY updated_at DESC, id",
            )?;
            let ids = statement
                .query_map([session_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids.into_iter().map(|id| read_run(connection, &id)).collect()
        })
    }

    pub fn run(&self, run_id: &str) -> CoordinatorResult<RunRecord> {
        self.control
            .with_connection(|connection| read_run(connection, run_id))
    }

    pub fn tasks(&self, run_id: &str) -> CoordinatorResult<Vec<TaskRecord>> {
        self.control.with_connection(|connection| {
            read_run(connection, run_id)?;
            let mut statement = connection.prepare(
                "SELECT id FROM orchestration_tasks WHERE run_id=?1 ORDER BY position, id",
            )?;
            let ids = statement
                .query_map([run_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids.into_iter()
                .map(|id| read_task(connection, &id))
                .collect()
        })
    }

    pub fn dispatches(&self, run_id: &str) -> CoordinatorResult<Vec<DispatchRecord>> {
        self.control.with_connection(|connection| {
            read_run(connection, run_id)?;
            let mut statement = connection.prepare(
                "SELECT d.id FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 ORDER BY t.position, d.attempt, d.id",
            )?;
            let ids = statement
                .query_map([run_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids.into_iter().map(|id| read_dispatch(connection, &id)).collect()
        })
    }

    pub fn gate(&self, gate_id: &str) -> CoordinatorResult<DecisionGateRecord> {
        self.control
            .with_connection(|connection| read_gate(connection, gate_id))
    }

    pub fn messages(&self, run_id: &str) -> CoordinatorResult<Vec<MessageRecord>> {
        self.control.with_connection(|connection| {
            read_run(connection, run_id)?;
            let mut statement = connection
                .prepare("SELECT id FROM messages WHERE run_id=?1 ORDER BY created_at, id")?;
            let ids = statement
                .query_map([run_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids.into_iter()
                .map(|id| read_message(connection, &id))
                .collect()
        })
    }

    pub fn gates(&self, run_id: &str) -> CoordinatorResult<Vec<DecisionGateRecord>> {
        self.control.with_connection(|connection| {
            read_run(connection, run_id)?;
            let mut statement = connection
                .prepare("SELECT id FROM decision_gates WHERE run_id=?1 ORDER BY created_at, id")?;
            let ids = statement
                .query_map([run_id], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            ids.into_iter()
                .map(|id| read_gate(connection, &id))
                .collect()
        })
    }

    fn mutate<Q, R, F>(
        &self,
        operation_id: Uuid,
        kind: &'static str,
        request: Q,
        mutation: F,
    ) -> CoordinatorResult<R>
    where
        Q: Serialize,
        R: Serialize + DeserializeOwned,
        F: FnOnce(&Transaction<'_>, Q) -> CoordinatorResult<R>,
    {
        let request_bytes = serde_json::to_vec(&json!({"kind": kind, "request": &request}))?;
        let request_hash = digest_hex(&request_bytes);
        self.control.with_connection_mut(move |connection| {
            if let Some((stored_hash, response_json)) = connection
                .query_row(
                    "SELECT request_hash, response_json FROM operations WHERE operation_id=?1",
                    [operation_id.to_string()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()?
            {
                if stored_hash != request_hash {
                    return Err(CoordinatorError::Conflict(
                        "operation id was already used for a different request".to_string(),
                    ));
                }
                return Ok(serde_json::from_str(&response_json)?);
            }
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let response = mutation(&transaction, request)?;
            transaction.execute(
                "INSERT INTO operations(operation_id, request_hash, response_json, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![
                    operation_id.to_string(),
                    request_hash,
                    serde_json::to_string(&response)?,
                    now_millis() as i64
                ],
            )?;
            transaction.commit()?;
            Ok(response)
        })
    }
}

impl RunStatus {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::Failed | Self::Cancelled)
    }
}

fn validate_identity(
    connection: &Connection,
    identity: &LifecycleIdentity,
) -> CoordinatorResult<DispatchRecord> {
    let dispatch = read_dispatch(connection, &identity.dispatch_id)?;
    if dispatch.task_id != identity.task_id {
        return Err(CoordinatorError::IdentityMismatch(
            "task id does not own dispatch".to_string(),
        ));
    }
    if dispatch.agent_instance_id.as_deref() != Some(identity.agent_instance_id.as_str()) {
        return Err(CoordinatorError::IdentityMismatch(
            "agent instance does not own dispatch".to_string(),
        ));
    }
    if dispatch.pane_id != identity.pane_id {
        return Err(CoordinatorError::IdentityMismatch(
            "pane id does not match dispatch".to_string(),
        ));
    }
    if dispatch.process_generation != Some(identity.process_generation) {
        return Err(CoordinatorError::IdentityMismatch(
            "process generation does not match dispatch".to_string(),
        ));
    }
    let agent = read_agent(connection, &identity.agent_instance_id)?;
    if agent.generation != identity.process_generation {
        return Err(CoordinatorError::IdentityMismatch(
            "agent generation does not match dispatch".to_string(),
        ));
    }
    Ok(dispatch)
}

fn validate_scope(
    connection: &Connection,
    run_id: &str,
    task_id: Option<&str>,
    dispatch_id: Option<&str>,
) -> CoordinatorResult<()> {
    if let Some(task_id) = task_id {
        let task = read_task(connection, task_id)?;
        if task.run_id != run_id {
            return Err(CoordinatorError::Conflict(
                "task does not belong to run".to_string(),
            ));
        }
    }
    if let Some(dispatch_id) = dispatch_id {
        let dispatch = read_dispatch(connection, dispatch_id)?;
        let task = read_task(connection, &dispatch.task_id)?;
        if task.run_id != run_id || task_id.is_some_and(|expected| expected != task.id) {
            return Err(CoordinatorError::Conflict(
                "dispatch does not belong to requested run/task".to_string(),
            ));
        }
    }
    Ok(())
}

fn validate_worktree(worktree: &WorktreeAssignment) -> CoordinatorResult<()> {
    required(&worktree.base_revision, "base revision")?;
    required(&worktree.branch, "worktree branch")?;
    required(&worktree.worktree_path, "worktree path")?;
    Ok(())
}

fn require_run_revision(run: &RunRecord, expected: u64) -> CoordinatorResult<()> {
    if run.revision == expected {
        Ok(())
    } else {
        Err(CoordinatorError::StaleRevision {
            entity: format!("run {}", run.id),
            expected,
            current: run.revision,
        })
    }
}

fn require_task_revision(task: &TaskRecord, expected: u64) -> CoordinatorResult<()> {
    if task.revision == expected {
        Ok(())
    } else {
        Err(CoordinatorError::StaleRevision {
            entity: format!("task {}", task.id),
            expected,
            current: task.revision,
        })
    }
}

fn bump_run_revision(transaction: &Transaction<'_>, run: &mut RunRecord) -> CoordinatorResult<()> {
    run.revision = run.revision.saturating_add(1);
    run.updated_at = now_millis();
    transaction.execute(
        "UPDATE orchestration_runs SET revision=?2, updated_at=?3 WHERE id=?1",
        params![run.id, run.revision as i64, run.updated_at as i64],
    )?;
    Ok(())
}

fn update_run_status(
    transaction: &Transaction<'_>,
    run: &mut RunRecord,
    status: RunStatus,
) -> CoordinatorResult<()> {
    run.status = status;
    run.revision = run.revision.saturating_add(1);
    run.updated_at = now_millis();
    transaction.execute(
        "UPDATE orchestration_runs SET status=?2, revision=?3, updated_at=?4 WHERE id=?1",
        params![
            run.id,
            run_status_text(status),
            run.revision as i64,
            run.updated_at as i64
        ],
    )?;
    Ok(())
}

fn refresh_terminal_run_status(
    transaction: &Transaction<'_>,
    run: &mut RunRecord,
) -> CoordinatorResult<()> {
    if run.status == RunStatus::Cancelled {
        return Ok(());
    }
    let pending_gates = pending_gate_count_for_run(transaction, &run.id)?;
    let active: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 AND d.status IN ('pending','dispatched','running','waiting')",
        [&run.id],
        |row| row.get(0),
    )?;
    let incomplete: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM orchestration_tasks WHERE run_id=?1 AND status NOT IN ('completed','failed','blocked','cancelled')",
        [&run.id],
        |row| row.get(0),
    )?;
    let failed: i64 = transaction.query_row(
        "SELECT COUNT(*) FROM orchestration_tasks WHERE run_id=?1 AND status IN ('failed','blocked')",
        [&run.id],
        |row| row.get(0),
    )?;
    let desired = if pending_gates > 0 {
        RunStatus::Waiting
    } else if incomplete == 0 && failed > 0 {
        RunStatus::Failed
    } else if incomplete == 0 {
        RunStatus::Completed
    } else if active > 0 {
        RunStatus::Running
    } else {
        run.status
    };
    if desired != run.status {
        update_run_status(transaction, run, desired)?;
    }
    Ok(())
}

fn bump_task_revision(
    transaction: &Transaction<'_>,
    task: &mut TaskRecord,
) -> CoordinatorResult<()> {
    task.revision = task.revision.saturating_add(1);
    task.updated_at = now_millis();
    transaction.execute(
        "UPDATE orchestration_tasks SET revision=?2, updated_at=?3 WHERE id=?1",
        params![task.id, task.revision as i64, task.updated_at as i64],
    )?;
    Ok(())
}

fn set_task_status(
    transaction: &Transaction<'_>,
    task_id: &str,
    status: OrchestrationTaskStatus,
    result: Option<Value>,
) -> CoordinatorResult<()> {
    let now = now_millis();
    transaction.execute(
        "UPDATE orchestration_tasks SET status=?2, revision=revision+1, result_json=COALESCE(?3, result_json), updated_at=?4 WHERE id=?1",
        params![task_id, task_status_text(status), result.map(|value| value.to_string()), now as i64],
    )?;
    Ok(())
}

fn dependency_statuses(
    connection: &Connection,
    task_id: &str,
) -> CoordinatorResult<Vec<OrchestrationTaskStatus>> {
    let mut statement = connection.prepare(
        "SELECT dependency.status FROM task_dependencies edge JOIN orchestration_tasks dependency ON dependency.id=edge.depends_on_task_id WHERE edge.task_id=?1 ORDER BY dependency.position, dependency.id",
    )?;
    let values = statement
        .query_map([task_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    values
        .into_iter()
        .map(|value| parse_task_status(&value))
        .collect()
}

fn query_ids(connection: &Connection, sql: &str, run_id: &str) -> CoordinatorResult<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let ids = statement
        .query_map([run_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}
fn query_ids_limited(
    connection: &Connection,
    sql: &str,
    run_id: &str,
    limit: usize,
) -> CoordinatorResult<Vec<String>> {
    if limit == 0 {
        return Ok(Vec::new());
    }
    let mut statement = connection.prepare(sql)?;
    let ids = statement
        .query_map(params![run_id, limit as i64], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ids)
}

fn pending_gate_count(
    connection: &Connection,
    dispatch_id: Option<&str>,
) -> CoordinatorResult<u64> {
    let Some(dispatch_id) = dispatch_id else {
        return Ok(0);
    };
    Ok(connection
        .query_row(
            "SELECT COUNT(*) FROM decision_gates WHERE dispatch_id=?1 AND status='pending'",
            [dispatch_id],
            |row| row.get::<_, i64>(0),
        )?
        .max(0) as u64)
}

fn pending_gate_count_for_run(connection: &Connection, run_id: &str) -> CoordinatorResult<u64> {
    Ok(connection
        .query_row(
            "SELECT COUNT(*) FROM decision_gates WHERE run_id=?1 AND status='pending'",
            [run_id],
            |row| row.get::<_, i64>(0),
        )?
        .max(0) as u64)
}

fn create_gate_record(
    transaction: &Transaction<'_>,
    run_id: &str,
    task_id: Option<&str>,
    dispatch_id: Option<&str>,
    gate_type: &str,
    prompt: &str,
    options: Vec<String>,
    expires_at: Option<u64>,
    now: u64,
) -> CoordinatorResult<DecisionGateRecord> {
    let gate_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO decision_gates(id, run_id, task_id, dispatch_id, status, gate_type, prompt, options_json, resolution_json, expires_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, NULL, ?8, ?9, ?9)",
        params![gate_id, run_id, task_id, dispatch_id, gate_type, prompt, serde_json::to_string(&options)?, expires_at.map(|value| value as i64), now as i64],
    )?;
    read_gate(transaction, &gate_id)
}

#[allow(clippy::too_many_arguments)]
fn insert_message(
    transaction: &Transaction<'_>,
    run_id: &str,
    task_id: Option<&str>,
    dispatch_id: Option<&str>,
    parent_id: Option<&str>,
    sender_kind: &str,
    message_type: MessageType,
    payload: Value,
    now: u64,
) -> CoordinatorResult<MessageRecord> {
    let message_id = Uuid::new_v4().to_string();
    transaction.execute(
        "INSERT INTO messages(id, run_id, task_id, dispatch_id, parent_id, sender_kind, message_type, payload_json, unread, delivered_at, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, NULL, ?9)",
        params![message_id, run_id, task_id, dispatch_id, parent_id, sender_kind, message_type_text(message_type), payload.to_string(), now as i64],
    )?;
    read_message(transaction, &message_id)
}

fn insert_event(
    transaction: &Transaction<'_>,
    run_id: Option<&str>,
    domain: &str,
    event_type: &str,
    entity_id: Option<&str>,
    operation_id: Uuid,
    payload: Value,
) -> CoordinatorResult<()> {
    transaction.execute(
        "INSERT INTO run_events(run_id, domain, event_type, entity_id, operation_id, payload_json, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![run_id, domain, event_type, entity_id, operation_id.to_string(), payload.to_string(), now_millis() as i64],
    )?;
    Ok(())
}

fn read_run(connection: &Connection, run_id: &str) -> CoordinatorResult<RunRecord> {
    connection
        .query_row(
            "SELECT id, session_id, goal, status, revision, policy_json, created_at, updated_at FROM orchestration_runs WHERE id=?1",
            [run_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoordinatorError::NotFound(format!("run {run_id}")))
        .and_then(|(id, session_id, goal, status, revision, policy, created_at, updated_at)| {
            Ok(RunRecord {
                id,
                session_id,
                goal,
                status: parse_run_status(&status)?,
                revision: nonnegative(revision),
                policy: serde_json::from_str(&policy)?,
                created_at: nonnegative(created_at),
                updated_at: nonnegative(updated_at),
            })
        })
}

fn read_task(connection: &Connection, task_id: &str) -> CoordinatorResult<TaskRecord> {
    let row = connection
        .query_row(
            "SELECT id, run_id, title, description, status, revision, position, result_json, created_at, updated_at FROM orchestration_tasks WHERE id=?1",
            [task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?, row.get::<_, i64>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, i64>(8)?, row.get::<_, i64>(9)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoordinatorError::NotFound(format!("task {task_id}")))?;
    let dependencies = query_ids(
        connection,
        "SELECT depends_on_task_id FROM task_dependencies WHERE task_id=?1 ORDER BY depends_on_task_id",
        task_id,
    )?;
    Ok(TaskRecord {
        id: row.0,
        run_id: row.1,
        title: row.2,
        description: row.3,
        status: parse_task_status(&row.4)?,
        revision: nonnegative(row.5),
        position: nonnegative(row.6),
        result: row
            .7
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        dependencies,
        created_at: nonnegative(row.8),
        updated_at: nonnegative(row.9),
    })
}

fn read_dispatch(connection: &Connection, dispatch_id: &str) -> CoordinatorResult<DispatchRecord> {
    connection
        .query_row(
            "SELECT id, task_id, attempt, agent_instance_id, status, pane_id, process_generation, base_revision, branch, worktree_path, failure_code, created_at, updated_at FROM dispatches WHERE id=?1",
            [dispatch_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<i64>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?, row.get::<_, Option<String>>(10)?, row.get::<_, i64>(11)?, row.get::<_, i64>(12)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoordinatorError::NotFound(format!("dispatch {dispatch_id}")))
        .and_then(|row| {
            let worktree = match (row.7, row.8, row.9) {
                (Some(base_revision), Some(branch), Some(worktree_path)) => Some(WorktreeAssignment { base_revision, branch, worktree_path }),
                (None, None, None) => None,
                _ => return Err(CoordinatorError::Storage("partial worktree record".to_string())),
            };
            Ok(DispatchRecord {
                id: row.0,
                task_id: row.1,
                attempt: nonnegative(row.2) as u32,
                agent_instance_id: row.3,
                status: parse_dispatch_status(&row.4)?,
                pane_id: row.5,
                process_generation: row.6.map(nonnegative),
                worktree,
                failure_code: row.10,
                created_at: nonnegative(row.11),
                updated_at: nonnegative(row.12),
            })
        })
}

fn read_agent(connection: &Connection, agent_id: &str) -> CoordinatorResult<AgentInstanceRecord> {
    connection
        .query_row(
            "SELECT id, provider, profile, workspace_path, worktree_path, runtime_identity, status, resumable, generation, last_heartbeat_at, created_at, updated_at FROM agent_instances WHERE id=?1",
            [agent_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, String>(6)?, row.get::<_, i64>(7)?, row.get::<_, i64>(8)?, row.get::<_, Option<i64>>(9)?, row.get::<_, i64>(10)?, row.get::<_, i64>(11)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoordinatorError::NotFound(format!("agent {agent_id}")))
        .and_then(|row| {
            Ok(AgentInstanceRecord {
                id: row.0,
                provider: parse_provider(&row.1)?,
                profile: row.2,
                workspace_path: row.3,
                worktree_path: row.4,
                runtime_identity: row.5,
                status: parse_agent_status(&row.6)?,
                resumable: row.7 != 0,
                generation: nonnegative(row.8),
                last_heartbeat_at: row.9.map(nonnegative),
                created_at: nonnegative(row.10),
                updated_at: nonnegative(row.11),
            })
        })
}

fn read_message(connection: &Connection, message_id: &str) -> CoordinatorResult<MessageRecord> {
    connection
        .query_row(
            "SELECT id, run_id, task_id, dispatch_id, parent_id, sender_kind, message_type, payload_json, unread, delivered_at, created_at FROM messages WHERE id=?1",
            [message_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, i64>(8)?, row.get::<_, Option<i64>>(9)?, row.get::<_, i64>(10)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoordinatorError::NotFound(format!("message {message_id}")))
        .and_then(|row| {
            Ok(MessageRecord {
                id: row.0,
                run_id: row.1,
                task_id: row.2,
                dispatch_id: row.3,
                parent_id: row.4,
                sender_kind: row.5,
                message_type: parse_message_type(&row.6)?,
                payload: serde_json::from_str(&row.7)?,
                unread: row.8 != 0,
                delivered_at: row.9.map(nonnegative),
                created_at: nonnegative(row.10),
            })
        })
}

fn read_gate(connection: &Connection, gate_id: &str) -> CoordinatorResult<DecisionGateRecord> {
    connection
        .query_row(
            "SELECT id, run_id, task_id, dispatch_id, status, gate_type, prompt, options_json, resolution_json, expires_at, created_at, updated_at FROM decision_gates WHERE id=?1",
            [gate_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?, row.get::<_, String>(6)?, row.get::<_, String>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<i64>>(9)?, row.get::<_, i64>(10)?, row.get::<_, i64>(11)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoordinatorError::NotFound(format!("gate {gate_id}")))
        .and_then(|row| {
            Ok(DecisionGateRecord {
                id: row.0,
                run_id: row.1,
                task_id: row.2,
                dispatch_id: row.3,
                status: parse_gate_status(&row.4)?,
                gate_type: row.5,
                prompt: row.6,
                options: serde_json::from_str(&row.7)?,
                resolution: row.8.map(|value| serde_json::from_str(&value)).transpose()?,
                expires_at: row.9.map(nonnegative),
                created_at: nonnegative(row.10),
                updated_at: nonnegative(row.11),
            })
        })
}

fn run_status_text(status: RunStatus) -> &'static str {
    match status {
        RunStatus::Queued => "queued",
        RunStatus::Planning => "planning",
        RunStatus::Running => "running",
        RunStatus::Waiting => "waiting",
        RunStatus::Paused => "paused",
        RunStatus::Completed => "completed",
        RunStatus::Failed => "failed",
        RunStatus::Cancelled => "cancelled",
    }
}

fn parse_run_status(value: &str) -> CoordinatorResult<RunStatus> {
    match value {
        "queued" => Ok(RunStatus::Queued),
        "planning" => Ok(RunStatus::Planning),
        "running" => Ok(RunStatus::Running),
        "waiting" => Ok(RunStatus::Waiting),
        "paused" => Ok(RunStatus::Paused),
        "completed" => Ok(RunStatus::Completed),
        "failed" => Ok(RunStatus::Failed),
        "cancelled" => Ok(RunStatus::Cancelled),
        _ => Err(CoordinatorError::Storage(format!(
            "invalid run status {value}"
        ))),
    }
}

fn task_status_text(status: OrchestrationTaskStatus) -> &'static str {
    match status {
        OrchestrationTaskStatus::Pending => "pending",
        OrchestrationTaskStatus::Ready => "ready",
        OrchestrationTaskStatus::Dispatched => "dispatched",
        OrchestrationTaskStatus::Completed => "completed",
        OrchestrationTaskStatus::Failed => "failed",
        OrchestrationTaskStatus::Blocked => "blocked",
        OrchestrationTaskStatus::Cancelled => "cancelled",
    }
}

fn parse_task_status(value: &str) -> CoordinatorResult<OrchestrationTaskStatus> {
    match value {
        "pending" => Ok(OrchestrationTaskStatus::Pending),
        "ready" => Ok(OrchestrationTaskStatus::Ready),
        "dispatched" => Ok(OrchestrationTaskStatus::Dispatched),
        "completed" => Ok(OrchestrationTaskStatus::Completed),
        "failed" => Ok(OrchestrationTaskStatus::Failed),
        "blocked" => Ok(OrchestrationTaskStatus::Blocked),
        "cancelled" => Ok(OrchestrationTaskStatus::Cancelled),
        _ => Err(CoordinatorError::Storage(format!(
            "invalid task status {value}"
        ))),
    }
}

fn dispatch_status_text(status: DispatchStatus) -> &'static str {
    match status {
        DispatchStatus::Pending => "pending",
        DispatchStatus::Dispatched => "dispatched",
        DispatchStatus::Running => "running",
        DispatchStatus::Waiting => "waiting",
        DispatchStatus::Completed => "completed",
        DispatchStatus::Failed => "failed",
        DispatchStatus::CircuitBroken => "circuit_broken",
        DispatchStatus::Cancelled => "cancelled",
    }
}

fn parse_dispatch_status(value: &str) -> CoordinatorResult<DispatchStatus> {
    match value {
        "pending" => Ok(DispatchStatus::Pending),
        "dispatched" => Ok(DispatchStatus::Dispatched),
        "running" => Ok(DispatchStatus::Running),
        "waiting" => Ok(DispatchStatus::Waiting),
        "completed" => Ok(DispatchStatus::Completed),
        "failed" => Ok(DispatchStatus::Failed),
        "circuit_broken" => Ok(DispatchStatus::CircuitBroken),
        "cancelled" => Ok(DispatchStatus::Cancelled),
        _ => Err(CoordinatorError::Storage(format!(
            "invalid dispatch status {value}"
        ))),
    }
}

fn provider_text(provider: AgentProvider) -> &'static str {
    match provider {
        AgentProvider::HermesAcp => "hermes_acp",
        AgentProvider::PtyCli => "pty_cli",
    }
}

fn parse_provider(value: &str) -> CoordinatorResult<AgentProvider> {
    match value {
        "hermes_acp" => Ok(AgentProvider::HermesAcp),
        "pty_cli" => Ok(AgentProvider::PtyCli),
        _ => Err(CoordinatorError::Storage(format!(
            "invalid agent provider {value}"
        ))),
    }
}

fn agent_status_text(status: AgentLifecycleStatus) -> &'static str {
    match status {
        AgentLifecycleStatus::Registered => "registered",
        AgentLifecycleStatus::Starting => "starting",
        AgentLifecycleStatus::Running => "running",
        AgentLifecycleStatus::Waiting => "waiting",
        AgentLifecycleStatus::Reconciling => "reconciling",
        AgentLifecycleStatus::Completed => "completed",
        AgentLifecycleStatus::Failed => "failed",
        AgentLifecycleStatus::Lost => "lost",
        AgentLifecycleStatus::Cancelled => "cancelled",
        AgentLifecycleStatus::Stopped => "stopped",
    }
}

fn parse_agent_status(value: &str) -> CoordinatorResult<AgentLifecycleStatus> {
    match value {
        "registered" => Ok(AgentLifecycleStatus::Registered),
        "starting" => Ok(AgentLifecycleStatus::Starting),
        "running" => Ok(AgentLifecycleStatus::Running),
        "waiting" => Ok(AgentLifecycleStatus::Waiting),
        "reconciling" => Ok(AgentLifecycleStatus::Reconciling),
        "completed" => Ok(AgentLifecycleStatus::Completed),
        "failed" => Ok(AgentLifecycleStatus::Failed),
        "lost" => Ok(AgentLifecycleStatus::Lost),
        "cancelled" => Ok(AgentLifecycleStatus::Cancelled),
        "stopped" => Ok(AgentLifecycleStatus::Stopped),
        _ => Err(CoordinatorError::Storage(format!(
            "invalid agent status {value}"
        ))),
    }
}

fn message_type_text(message_type: MessageType) -> &'static str {
    match message_type {
        MessageType::Status => "status",
        MessageType::Dispatch => "dispatch",
        MessageType::WorkerDone => "worker_done",
        MessageType::MergeReady => "merge_ready",
        MessageType::Escalation => "escalation",
        MessageType::Handoff => "handoff",
        MessageType::DecisionGate => "decision_gate",
        MessageType::Heartbeat => "heartbeat",
        MessageType::Chat => "chat",
    }
}

fn parse_message_type(value: &str) -> CoordinatorResult<MessageType> {
    match value {
        "status" => Ok(MessageType::Status),
        "dispatch" => Ok(MessageType::Dispatch),
        "worker_done" => Ok(MessageType::WorkerDone),
        "merge_ready" => Ok(MessageType::MergeReady),
        "escalation" => Ok(MessageType::Escalation),
        "handoff" => Ok(MessageType::Handoff),
        "decision_gate" => Ok(MessageType::DecisionGate),
        "heartbeat" => Ok(MessageType::Heartbeat),
        "chat" => Ok(MessageType::Chat),
        _ => Err(CoordinatorError::Storage(format!(
            "invalid message type {value}"
        ))),
    }
}

fn parse_gate_status(value: &str) -> CoordinatorResult<GateStatus> {
    match value {
        "pending" => Ok(GateStatus::Pending),
        "resolved" => Ok(GateStatus::Resolved),
        "timeout" => Ok(GateStatus::Timeout),
        "cancelled" => Ok(GateStatus::Cancelled),
        _ => Err(CoordinatorError::Storage(format!(
            "invalid gate status {value}"
        ))),
    }
}

fn required(value: &str, field: &str) -> CoordinatorResult<String> {
    let value = value.trim();
    if value.is_empty() {
        Err(CoordinatorError::InvalidArgument(format!(
            "{field} is required"
        )))
    } else {
        Ok(value.to_string())
    }
}

fn trim_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_string();
        (!value.is_empty()).then_some(value)
    })
}

fn validate_uuid(value: &str, field: &str) -> CoordinatorResult<()> {
    Uuid::parse_str(value)
        .map(|_| ())
        .map_err(|_| CoordinatorError::InvalidArgument(format!("{field} must be a UUID")))
}

fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn nonnegative(value: i64) -> u64 {
    value.max(0) as u64
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    struct Fixture {
        directory: PathBuf,
        service: CoordinatorService,
    }

    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("vibelink-coordinator-{}", Uuid::new_v4()));
            let control = Arc::new(ControlPlane::open(&directory).expect("open control plane"));
            Self {
                directory,
                service: CoordinatorService::new(control),
            }
        }

        fn create_run(&self, max_concurrent: u32) -> RunRecord {
            self.service
                .create_run(
                    Uuid::new_v4(),
                    CreateRunRequest {
                        session_id: Uuid::new_v4().to_string(),
                        goal: "Complete the mission".to_string(),
                        policy: RunPolicy { max_concurrent },
                    },
                )
                .expect("create run")
        }

        fn create_task(
            &self,
            run: &mut RunRecord,
            title: &str,
            dependencies: Vec<String>,
        ) -> TaskRecord {
            let task = self
                .service
                .create_task(
                    Uuid::new_v4(),
                    CreateTaskRequest {
                        run_id: run.id.clone(),
                        title: title.to_string(),
                        description: String::new(),
                        dependencies,
                        expected_run_revision: run.revision,
                    },
                )
                .expect("create task");
            *run = self.service.run(&run.id).expect("reload run");
            task
        }

        fn start(&self, run: &mut RunRecord) {
            *run = self
                .service
                .start_run(
                    Uuid::new_v4(),
                    RunRevisionRequest {
                        run_id: run.id.clone(),
                        expected_run_revision: run.revision,
                    },
                )
                .expect("start run");
        }

        fn register_and_start_dispatch(
            &self,
            dispatch: &DispatchRecord,
            task: &TaskRecord,
            resumable: bool,
        ) -> (LifecycleIdentity, TaskRecord) {
            let agent = self
                .service
                .register_agent(
                    Uuid::new_v4(),
                    RegisterAgentRequest {
                        provider: AgentProvider::PtyCli,
                        profile: Some("codex".to_string()),
                        workspace_path: "C:/workspace".to_string(),
                        worktree_path: None,
                        resumable,
                    },
                )
                .expect("register agent");
            let identity = LifecycleIdentity {
                task_id: task.id.clone(),
                dispatch_id: dispatch.id.clone(),
                agent_instance_id: agent.id,
                pane_id: Some(Uuid::new_v4().to_string()),
                process_generation: 7,
            };
            self.service
                .bind_dispatch(
                    Uuid::new_v4(),
                    BindDispatchRequest {
                        dispatch_id: dispatch.id.clone(),
                        expected_task_revision: task.revision,
                        agent_instance_id: identity.agent_instance_id.clone(),
                        runtime_identity: "runtime-7".to_string(),
                        pane_id: identity.pane_id.clone(),
                        process_generation: identity.process_generation,
                        worktree: None,
                    },
                )
                .expect("bind dispatch");
            let running = self
                .service
                .mark_dispatch_running(Uuid::new_v4(), identity.clone(), 1_000)
                .expect("mark running");
            assert_eq!(running.dispatch.status, DispatchStatus::Running);
            (identity, running.task)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn dag_readiness_is_deterministic_and_respects_max_concurrency() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(2);
        let first = fixture.create_task(&mut run, "first", vec![]);
        let second = fixture.create_task(&mut run, "second", vec![]);
        let third = fixture.create_task(&mut run, "third", vec![first.id.clone()]);
        let fourth = fixture.create_task(&mut run, "fourth", vec![second.id.clone()]);
        fixture.start(&mut run);

        let scheduled = fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run.revision,
                },
            )
            .expect("schedule roots");
        assert_eq!(scheduled.dispatches.len(), 2);
        assert_eq!(
            scheduled
                .dispatches
                .iter()
                .map(|dispatch| dispatch.task_id.as_str())
                .collect::<Vec<_>>(),
            vec![first.id.as_str(), second.id.as_str()]
        );
        assert_eq!(
            scheduled.newly_ready_task_ids,
            vec![first.id.clone(), second.id.clone()]
        );

        let tasks = fixture.service.tasks(&run.id).expect("tasks");
        assert_eq!(
            tasks
                .iter()
                .find(|task| task.id == third.id)
                .expect("third")
                .status,
            OrchestrationTaskStatus::Pending
        );
        assert_eq!(
            tasks
                .iter()
                .find(|task| task.id == fourth.id)
                .expect("fourth")
                .status,
            OrchestrationTaskStatus::Pending
        );

        let no_capacity = fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: scheduled.run.revision,
                },
            )
            .expect("schedule full");
        assert!(no_capacity.dispatches.is_empty());

        for dispatch in &scheduled.dispatches {
            let task = fixture
                .service
                .tasks(&run.id)
                .expect("tasks")
                .into_iter()
                .find(|task| task.id == dispatch.task_id)
                .expect("scheduled task");
            let (identity, running_task) =
                fixture.register_and_start_dispatch(dispatch, &task, false);
            fixture
                .service
                .worker_done(
                    Uuid::new_v4(),
                    WorkerDoneRequest {
                        identity,
                        expected_task_revision: running_task.revision,
                        files_modified: vec![],
                        report_path: None,
                        result: json!({"ok": true}),
                    },
                )
                .expect("complete root");
        }

        let run = fixture.service.run(&run.id).expect("run");
        let dependents = fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run.revision,
                },
            )
            .expect("schedule dependents");
        assert_eq!(dependents.dispatches.len(), 2);
        assert_eq!(
            dependents
                .dispatches
                .iter()
                .map(|dispatch| dispatch.task_id.as_str())
                .collect::<Vec<_>>(),
            vec![third.id.as_str(), fourth.id.as_str()]
        );
    }

    #[test]
    fn worker_done_rejects_wrong_dispatch_identity() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(1);
        let task = fixture.create_task(&mut run, "identity", vec![]);
        fixture.start(&mut run);
        let scheduled = fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run.revision,
                },
            )
            .expect("schedule");
        let (mut identity, running_task) = fixture.register_and_start_dispatch(
            &scheduled.dispatches[0],
            &fixture.service.tasks(&run.id).expect("tasks")[0],
            false,
        );
        identity.process_generation += 1;
        let error = fixture
            .service
            .worker_done(
                Uuid::new_v4(),
                WorkerDoneRequest {
                    identity,
                    expected_task_revision: running_task.revision,
                    files_modified: vec![],
                    report_path: None,
                    result: json!({"ok": true}),
                },
            )
            .expect_err("reject wrong generation");
        assert_eq!(error.code(), "identity_mismatch");
        assert_eq!(
            fixture.service.tasks(&run.id).expect("tasks")[0].status,
            OrchestrationTaskStatus::Dispatched
        );
        assert_eq!(task.id, running_task.id);
    }

    #[test]
    fn three_launch_failures_trip_the_circuit_breaker() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(1);
        fixture.create_task(&mut run, "fragile", vec![]);
        fixture.start(&mut run);
        let mut run_revision = run.revision;
        for attempt in 1..=3 {
            let scheduled = fixture
                .service
                .schedule_ready(
                    Uuid::new_v4(),
                    ScheduleRequest {
                        run_id: run.id.clone(),
                        expected_run_revision: run_revision,
                    },
                )
                .expect("schedule attempt");
            let dispatch = scheduled.dispatches.first().expect("dispatch");
            let task = fixture.service.tasks(&run.id).expect("tasks").remove(0);
            let failure = fixture
                .service
                .record_launch_failure(
                    Uuid::new_v4(),
                    LaunchFailureRequest {
                        dispatch_id: dispatch.id.clone(),
                        expected_task_revision: task.revision,
                        failure_code: "spawn_failed".to_string(),
                    },
                )
                .expect("record failure");
            assert_eq!(failure.consecutive_failures, attempt);
            assert_eq!(failure.circuit_broken, attempt == 3);
            run_revision = fixture.service.run(&run.id).expect("run").revision;
            if attempt < 3 {
                assert_eq!(failure.task.status, OrchestrationTaskStatus::Ready);
                assert_eq!(failure.dispatch.status, DispatchStatus::Failed);
            } else {
                assert_eq!(failure.task.status, OrchestrationTaskStatus::Failed);
                assert_eq!(failure.dispatch.status, DispatchStatus::CircuitBroken);
            }
        }
    }

    #[test]
    fn heartbeat_silence_reconciles_before_failure_and_heartbeat_recovers() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(1);
        fixture.create_task(&mut run, "live", vec![]);
        fixture.start(&mut run);
        let scheduled = fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run.revision,
                },
            )
            .expect("schedule");
        let task = fixture.service.tasks(&run.id).expect("tasks").remove(0);
        let (identity, _) =
            fixture.register_and_start_dispatch(&scheduled.dispatches[0], &task, false);
        let run = fixture.service.run(&run.id).expect("run");
        let reconciliation = fixture
            .service
            .reconcile_liveness(
                Uuid::new_v4(),
                ReconcileLivenessRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run.revision,
                    now_millis: 62_000,
                    silence_after_millis: 60_000,
                    observations: vec![],
                },
            )
            .expect("reconcile");
        assert_eq!(
            reconciliation.actions[0].kind,
            ReconciliationActionKind::Probe
        );
        assert_eq!(
            fixture.service.dispatches(&run.id).expect("dispatches")[0].status,
            DispatchStatus::Waiting
        );

        let agent = fixture
            .service
            .heartbeat(
                Uuid::new_v4(),
                HeartbeatRequest {
                    identity,
                    observed_at: 62_100,
                },
            )
            .expect("heartbeat");
        assert_eq!(agent.status, AgentLifecycleStatus::Running);
        assert_eq!(agent.last_heartbeat_at, Some(62_100));
        assert_eq!(
            fixture.service.dispatches(&run.id).expect("dispatches")[0].status,
            DispatchStatus::Running
        );
    }

    #[test]
    fn cancellation_closes_active_tasks_dispatches_agents_and_gates() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(1);
        fixture.create_task(&mut run, "cancel", vec![]);
        fixture.start(&mut run);
        let scheduled = fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run.revision,
                },
            )
            .expect("schedule");
        let task = fixture.service.tasks(&run.id).expect("tasks").remove(0);
        fixture.register_and_start_dispatch(&scheduled.dispatches[0], &task, false);
        let run = fixture.service.run(&run.id).expect("run");
        let gate = fixture
            .service
            .create_gate(
                Uuid::new_v4(),
                CreateGateRequest {
                    run_id: run.id.clone(),
                    task_id: Some(task.id.clone()),
                    dispatch_id: Some(scheduled.dispatches[0].id.clone()),
                    gate_type: "permission".to_string(),
                    prompt: "Allow?".to_string(),
                    options: vec!["allow".to_string(), "deny".to_string()],
                    expires_at: None,
                    expected_run_revision: run.revision,
                },
            )
            .expect("gate");
        let cancelled = fixture
            .service
            .cancel_run(
                Uuid::new_v4(),
                RunRevisionRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: gate.run.revision,
                },
            )
            .expect("cancel");
        assert_eq!(cancelled.status, RunStatus::Cancelled);
        assert_eq!(
            fixture.service.tasks(&run.id).expect("tasks")[0].status,
            OrchestrationTaskStatus::Cancelled
        );
        assert_eq!(
            fixture.service.dispatches(&run.id).expect("dispatches")[0].status,
            DispatchStatus::Cancelled
        );
        assert_eq!(
            fixture.service.gate(&gate.gate.id).expect("gate").status,
            GateStatus::Cancelled
        );
    }

    #[test]
    fn decision_gate_blocks_and_resolution_resumes_dispatch() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(1);
        fixture.create_task(&mut run, "gate", vec![]);
        fixture.start(&mut run);
        let scheduled = fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run.revision,
                },
            )
            .expect("schedule");
        let task = fixture.service.tasks(&run.id).expect("tasks").remove(0);
        fixture.register_and_start_dispatch(&scheduled.dispatches[0], &task, false);
        let run = fixture.service.run(&run.id).expect("run");
        let blocked = fixture
            .service
            .create_gate(
                Uuid::new_v4(),
                CreateGateRequest {
                    run_id: run.id.clone(),
                    task_id: Some(task.id),
                    dispatch_id: Some(scheduled.dispatches[0].id.clone()),
                    gate_type: "permission".to_string(),
                    prompt: "Choose".to_string(),
                    options: vec!["allow".to_string()],
                    expires_at: None,
                    expected_run_revision: run.revision,
                },
            )
            .expect("create gate");
        assert_eq!(blocked.run.status, RunStatus::Waiting);
        assert_eq!(
            blocked.dispatch.as_ref().expect("dispatch").status,
            DispatchStatus::Waiting
        );
        let resolved = fixture
            .service
            .resolve_gate(
                Uuid::new_v4(),
                ResolveGateRequest {
                    gate_id: blocked.gate.id,
                    resolution: json!({"decision": "allow"}),
                    expected_run_revision: blocked.run.revision,
                },
            )
            .expect("resolve gate");
        assert_eq!(resolved.gate.status, GateStatus::Resolved);
        assert_eq!(resolved.run.status, RunStatus::Running);
        assert_eq!(
            resolved.dispatch.expect("dispatch").status,
            DispatchStatus::Running
        );
    }

    #[test]
    fn worktree_completion_requires_merge_approval_before_base_update() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(1);
        fixture.create_task(&mut run, "merge", vec![]);
        fixture.start(&mut run);
        let scheduled = fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: run.revision,
                },
            )
            .expect("schedule");
        let task = fixture.service.tasks(&run.id).expect("tasks").remove(0);
        let agent = fixture
            .service
            .register_agent(
                Uuid::new_v4(),
                RegisterAgentRequest {
                    provider: AgentProvider::HermesAcp,
                    profile: None,
                    workspace_path: "C:/workspace".to_string(),
                    worktree_path: Some("C:/worktrees/merge".to_string()),
                    resumable: true,
                },
            )
            .expect("register agent");
        let identity = LifecycleIdentity {
            task_id: task.id.clone(),
            dispatch_id: scheduled.dispatches[0].id.clone(),
            agent_instance_id: agent.id,
            pane_id: None,
            process_generation: 3,
        };
        let worktree = WorktreeAssignment {
            base_revision: "base-commit".to_string(),
            branch: "vibelink/task-merge".to_string(),
            worktree_path: "C:/worktrees/merge".to_string(),
        };
        fixture
            .service
            .bind_dispatch(
                Uuid::new_v4(),
                BindDispatchRequest {
                    dispatch_id: identity.dispatch_id.clone(),
                    expected_task_revision: task.revision,
                    agent_instance_id: identity.agent_instance_id.clone(),
                    runtime_identity: "acp-session".to_string(),
                    pane_id: None,
                    process_generation: identity.process_generation,
                    worktree: Some(worktree.clone()),
                },
            )
            .expect("bind worktree");
        let running = fixture
            .service
            .mark_dispatch_running(Uuid::new_v4(), identity.clone(), 1_000)
            .expect("mark running");
        let done = fixture
            .service
            .worker_done(
                Uuid::new_v4(),
                WorkerDoneRequest {
                    identity,
                    expected_task_revision: running.task.revision,
                    files_modified: vec!["src/lib.rs".to_string()],
                    report_path: Some("report.json".to_string()),
                    result: json!({"summary": "ready"}),
                },
            )
            .expect("worker done");
        let gate = done.merge_gate.expect("merge gate");
        assert_eq!(done.run.status, RunStatus::Waiting);
        assert_eq!(done.dispatch.worktree, Some(worktree.clone()));
        assert_eq!(
            fixture
                .service
                .merge_authorization(&gate.id)
                .expect_err("approval required")
                .code(),
            "invalid_transition"
        );

        let approved = fixture
            .service
            .resolve_gate(
                Uuid::new_v4(),
                ResolveGateRequest {
                    gate_id: gate.id.clone(),
                    resolution: json!({"decision": "approve"}),
                    expected_run_revision: done.run.revision,
                },
            )
            .expect("approve merge");
        assert_eq!(approved.run.status, RunStatus::Waiting);
        assert_eq!(
            fixture
                .service
                .merge_authorization(&gate.id)
                .expect("authorization"),
            worktree
        );

        let applied = fixture
            .service
            .mark_merge_applied(
                Uuid::new_v4(),
                MergeAppliedRequest {
                    gate_id: gate.id,
                    expected_run_revision: approved.run.revision,
                    commit_id: "merged-commit".to_string(),
                },
            )
            .expect("record applied merge");
        assert_eq!(applied.run.status, RunStatus::Completed);
        assert_eq!(
            applied
                .gate
                .resolution
                .as_ref()
                .and_then(|value| value.get("applied"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn operation_replay_is_idempotent_and_conflicting_reuse_is_rejected() {
        let fixture = Fixture::new();
        let operation_id = Uuid::new_v4();
        let request = CreateRunRequest {
            session_id: Uuid::new_v4().to_string(),
            goal: "Replay".to_string(),
            policy: RunPolicy { max_concurrent: 2 },
        };
        let first = fixture
            .service
            .create_run(operation_id, request.clone())
            .expect("first");
        let replay = fixture
            .service
            .create_run(operation_id, request)
            .expect("replay");
        assert_eq!(first, replay);
        let error = fixture
            .service
            .create_run(
                operation_id,
                CreateRunRequest {
                    session_id: Uuid::new_v4().to_string(),
                    goal: "Different".to_string(),
                    policy: RunPolicy::default(),
                },
            )
            .expect_err("conflict");
        assert_eq!(error.code(), "conflict");
        assert_eq!(fixture.service.run(&first.id).expect("run").revision, 0);
    }
}

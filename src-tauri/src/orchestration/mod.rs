pub mod adapters;
mod durable;
pub use durable::*;

use crate::{control_plane::ControlPlane, protocol::RemotePaneActivity};
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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    pub base_revision: String,
    pub branch: String,
    pub worktree_path: String,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceDisposition {
    NotCreated,
    Live,
    Cleaned,
    Retained,
    CleanupFailed,
    #[default]
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchLaunchClaimRecord {
    pub operation_id: String,
    pub command_digest: String,
    pub profile: Option<String>,
    pub worktree_mode: WorktreeMode,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchResourceRecord {
    pub session_id: String,
    pub repository_root: Option<String>,
    pub relative_prefix: String,
    pub launch_path: Option<String>,
    pub agent_instance_id: Option<String>,
    pub pane_id: Option<String>,
    pub root_pid: Option<u32>,
    pub process_started_at: Option<u64>,
    pub process_generation: Option<u64>,
    pub worktree: Option<WorktreeAssignment>,
    pub pane_disposition: ResourceDisposition,
    pub worktree_disposition: ResourceDisposition,
    pub cleanup_reason: Option<String>,
    pub cleanup_error: Option<String>,
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
    pub launch_claim: Option<DispatchLaunchClaimRecord>,
    pub resources: Option<DispatchResourceRecord>,
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

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PaneProjectionState {
    pub activity: RemotePaneActivity,
    pub unread_count: u32,
    pub state_updated_at: u64,
    pub blocked: bool,
    pub interrupted: bool,
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

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeMode {
    Reuse,
    #[default]
    Worktree,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct DispatchLaunchRequest {
    pub run_id: String,
    pub expected_run_revision: u64,
    pub command: String,
    pub profile: Option<String>,
    #[serde(default)]
    pub worktree_mode: WorktreeMode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DispatchLaunchStatus {
    Launched,
    Existing,
    Failed,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchLaunchOutcome {
    pub dispatch_id: String,
    pub task_id: String,
    pub attempt: u32,
    pub status: DispatchLaunchStatus,
    pub agent_instance_id: Option<String>,
    pub pane_id: Option<String>,
    pub runtime_identity: Option<String>,
    pub process_generation: Option<u64>,
    pub worktree: Option<WorktreeAssignment>,
    pub resources: Option<DispatchResourceRecord>,
    pub failure_code: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchLaunchResult {
    pub run: RunRecord,
    pub launches: Vec<DispatchLaunchOutcome>,
    pub newly_ready_task_ids: Vec<String>,
    pub newly_blocked_task_ids: Vec<String>,
}

#[derive(Clone, Debug)]
pub enum DispatchLaunchPreparation {
    Intent(ScheduleResult),
    Replay(DispatchLaunchResult),
}

#[derive(Clone, Debug)]
pub struct DispatchLaunchSpec {
    pub operation_id: Uuid,
    pub command: String,
    pub profile: Option<String>,
    pub worktree_mode: WorktreeMode,
}

#[derive(Clone, Debug)]
pub struct DispatchCleanupTarget {
    pub run_id: String,
    pub session_id: String,
    pub dispatch: DispatchRecord,
    pub resources: Option<DispatchResourceRecord>,
}

#[derive(Clone, Debug)]
pub struct DispatchResourceReservation {
    pub dispatch_id: String,
    pub session_id: String,
    pub repository_root: Option<String>,
    pub relative_prefix: String,
    pub launch_path: Option<String>,
    pub worktree: Option<WorktreeAssignment>,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunchFailureRequest {
    pub agent_instance_id: String,
    pub failure_code: String,
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
    pub files: Vec<String>,
    #[serde(default)]
    pub tests: Vec<String>,
    pub commit: Option<String>,
    pub checkpoint: Option<String>,
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
    pub cleanup_gate: Option<DecisionGateRecord>,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupAppliedRequest {
    pub gate_id: String,
    pub expected_run_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CleanupDecision {
    pub decision: String,
    pub force: bool,
    pub delete_branch: bool,
    pub acknowledged_blockers: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CleanupAuthorization {
    pub worktree: WorktreeAssignment,
    pub force: bool,
    pub delete_branch: bool,
    pub acknowledged_blockers: Vec<String>,
}

#[derive(Clone)]
pub struct CoordinatorService {
    control: Arc<ControlPlane>,
}

impl CoordinatorService {
    pub fn new(control: Arc<ControlPlane>) -> Self {
        Self { control }
    }

    pub fn pane_projection_states(
        &self,
        pane_ids: &[String],
    ) -> CoordinatorResult<HashMap<String, PaneProjectionState>> {
        let mut unique = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for pane_id in pane_ids {
            if seen.insert(pane_id.as_str()) {
                unique.push(pane_id.as_str());
            }
        }
        if unique.is_empty() {
            return Ok(HashMap::new());
        }
        let values = std::iter::repeat_n("(?)", unique.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "WITH requested(pane_id) AS (VALUES {values}),
             ranked AS (
               SELECT d.id AS dispatch_id,d.task_id,d.agent_instance_id,d.pane_id,
                      d.status AS dispatch_status,t.status AS task_status,a.status AS agent_status,
                      MAX(d.updated_at,t.updated_at,COALESCE(a.updated_at,0)) AS state_updated_at,
                      ROW_NUMBER() OVER (PARTITION BY d.pane_id ORDER BY d.updated_at DESC,d.attempt DESC,d.id DESC) AS rank
               FROM dispatches d
               JOIN orchestration_tasks t ON t.id=d.task_id
               LEFT JOIN agent_instances a ON a.id=d.agent_instance_id
               WHERE d.pane_id IN (SELECT pane_id FROM requested)
             ), current AS (
               SELECT dispatch_id,task_id,agent_instance_id,pane_id,dispatch_status,task_status,agent_status,state_updated_at
               FROM ranked WHERE rank=1
             )
             SELECT r.pane_id,c.dispatch_status,c.task_status,c.agent_status,c.state_updated_at,
                    EXISTS(SELECT 1 FROM decision_gates g WHERE g.status='pending' AND (g.dispatch_id=c.dispatch_id OR g.task_id=c.task_id)),
                    (SELECT COUNT(*) FROM messages m WHERE m.unread=1 AND (m.dispatch_id=c.dispatch_id OR m.task_id=c.task_id)),
                    (SELECT COUNT(*) FROM notifications n WHERE n.unread=1 AND n.entity_id IN (c.dispatch_id,c.task_id,c.agent_instance_id))
             FROM requested r LEFT JOIN current c ON c.pane_id=r.pane_id"
        );
        self.control.with_connection(|connection| {
            let mut statement = connection.prepare(&sql)?;
            let rows = statement.query_map(rusqlite::params_from_iter(unique), |row| {
                let pane_id: String = row.get(0)?;
                let dispatch_status: Option<String> = row.get(1)?;
                let task_status: Option<String> = row.get(2)?;
                let agent_status: Option<String> = row.get(3)?;
                let state_updated_at =
                    row.get::<_, Option<i64>>(4)?.unwrap_or_default().max(0) as u64;
                let pending_gate = row.get::<_, i64>(5)? != 0;
                let unread_messages = row.get::<_, i64>(6)?.max(0) as u64;
                let unread_notifications = row.get::<_, i64>(7)?.max(0) as u64;
                let unread_count = unread_messages
                    .saturating_add(unread_notifications)
                    .min(u64::from(u32::MAX)) as u32;
                let interrupted = pane_interrupted(
                    dispatch_status.as_deref(),
                    task_status.as_deref(),
                    agent_status.as_deref(),
                );
                Ok((
                    pane_id,
                    PaneProjectionState {
                        activity: pane_activity(
                            dispatch_status.as_deref(),
                            task_status.as_deref(),
                            agent_status.as_deref(),
                            pending_gate,
                        ),
                        unread_count,
                        state_updated_at,
                        blocked: pending_gate,
                        interrupted,
                    },
                ))
            })?;
            Ok(rows.collect::<Result<HashMap<_, _>, _>>()?)
        })
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
        self.mutate(
            operation_id,
            "orchestration.schedule",
            request,
            move |transaction, request| {
                Self::schedule_ready_transaction(
                    transaction,
                    &request.run_id,
                    request.expected_run_revision,
                    operation_id,
                )
            },
        )
    }

    pub fn prepare_dispatch_launch(
        &self,
        operation_id: Uuid,
        mut request: DispatchLaunchRequest,
    ) -> CoordinatorResult<DispatchLaunchPreparation> {
        request.command = required(&request.command, "launch command")?;
        request.profile = trim_optional(request.profile.take());
        let request_hash = dispatch_launch_request_hash(&request)?;
        let operation_id_text = operation_id.to_string();
        self.control.with_connection_mut(move |connection| {
            ensure_orchestration_runtime_schema(connection)?;
            if let Some((stored_hash, state, plan_json, result_json)) = connection
                .query_row(
                    "SELECT request_hash,state,plan_json,result_json FROM dispatch_launch_operations WHERE operation_id=?1",
                    [&operation_id_text],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?)),
                )
                .optional()?
            {
                if stored_hash != request_hash {
                    return Err(CoordinatorError::Conflict(
                        "launch operation id was already used for a different immutable specification".to_string(),
                    ));
                }
                if state == "final" {
                    let result_json = result_json.ok_or_else(|| {
                        CoordinatorError::Storage("final launch operation has no result".to_string())
                    })?;
                    return Ok(DispatchLaunchPreparation::Replay(serde_json::from_str(&result_json)?));
                }
                let mut plan: ScheduleResult = serde_json::from_str(&plan_json)?;
                let dispatch_ids = claimed_dispatch_ids(connection, &operation_id_text)?;
                plan.dispatches = dispatch_ids
                    .into_iter()
                    .map(|dispatch_id| read_dispatch(connection, &dispatch_id))
                    .collect::<CoordinatorResult<Vec<_>>>()?;
                return Ok(DispatchLaunchPreparation::Intent(plan));
            }

            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            ensure_orchestration_runtime_schema(&transaction)?;
            let mut plan = Self::schedule_ready_transaction(
                &transaction,
                &request.run_id,
                request.expected_run_revision,
                operation_id,
            )?;
            let dispatch_ids = plan
                .dispatches
                .iter()
                .map(|dispatch| dispatch.id.clone())
                .collect::<Vec<_>>();
            transaction.execute(
                "INSERT INTO dispatch_launch_operations(operation_id,request_hash,request_json,state,plan_json,result_json,created_at,updated_at) VALUES(?1,?2,?3,'intent',?4,NULL,?5,?5)",
                params![
                    operation_id_text,
                    request_hash,
                    serde_json::to_string(&request)?,
                    serde_json::to_string(&plan)?,
                    now_millis() as i64,
                ],
            )?;
            let command_digest = digest_hex(request.command.as_bytes());
            for dispatch_id in &dispatch_ids {
                transaction.execute(
                    "INSERT INTO dispatch_launch_claims(dispatch_id,operation_id,command,command_digest,profile,worktree_mode,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(dispatch_id) DO NOTHING",
                    params![
                        dispatch_id,
                        operation_id_text,
                        request.command,
                        command_digest,
                        request.profile,
                        worktree_mode_text(request.worktree_mode),
                        now_millis() as i64,
                    ],
                )?;
                let claimed_by: String = transaction.query_row(
                    "SELECT operation_id FROM dispatch_launch_claims WHERE dispatch_id=?1",
                    [dispatch_id],
                    |row| row.get(0),
                )?;
                if claimed_by != operation_id_text {
                    return Err(CoordinatorError::Conflict(format!(
                        "dispatch {dispatch_id} is already claimed by another launch operation"
                    )));
                }
            }
            plan.dispatches = dispatch_ids
                .into_iter()
                .map(|dispatch_id| read_dispatch(&transaction, &dispatch_id))
                .collect::<CoordinatorResult<Vec<_>>>()?;
            transaction.execute(
                "UPDATE dispatch_launch_operations SET plan_json=?2,updated_at=?3 WHERE operation_id=?1",
                params![
                    operation_id_text,
                    serde_json::to_string(&plan)?,
                    now_millis() as i64,
                ],
            )?;
            transaction.commit()?;
            Ok(DispatchLaunchPreparation::Intent(plan))
        })
    }

    pub fn complete_dispatch_launch(
        &self,
        operation_id: Uuid,
        request: &DispatchLaunchRequest,
        result: &DispatchLaunchResult,
    ) -> CoordinatorResult<DispatchLaunchResult> {
        let request_hash = dispatch_launch_request_hash(request)?;
        self.control.with_connection_mut(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let operation_id_text = operation_id.to_string();
            let (stored_hash, state, stored_result): (String, String, Option<String>) = transaction
                .query_row(
                    "SELECT request_hash,state,result_json FROM dispatch_launch_operations WHERE operation_id=?1",
                    [&operation_id_text],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .ok_or_else(|| CoordinatorError::NotFound(format!("launch operation {operation_id}")))?;
            if stored_hash != request_hash {
                return Err(CoordinatorError::Conflict(
                    "launch operation specification changed before completion".to_string(),
                ));
            }
            if state == "final" {
                return Ok(serde_json::from_str(&stored_result.ok_or_else(|| {
                    CoordinatorError::Storage("final launch operation has no result".to_string())
                })?)?);
            }
            transaction.execute(
                "UPDATE dispatch_launch_operations SET state='final',result_json=?2,updated_at=?3 WHERE operation_id=?1",
                params![operation_id_text, serde_json::to_string(result)?, now_millis() as i64],
            )?;
            transaction.commit()?;
            Ok(result.clone())
        })
    }

    pub fn dispatch_launch_spec(
        &self,
        dispatch_id: &str,
        operation_id: Uuid,
    ) -> CoordinatorResult<DispatchLaunchSpec> {
        self.control.with_connection(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            connection
                .query_row(
                    "SELECT operation_id,command,profile,worktree_mode FROM dispatch_launch_claims WHERE dispatch_id=?1",
                    [dispatch_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?)),
                )
                .optional()?
                .ok_or_else(|| CoordinatorError::Conflict(format!("dispatch {dispatch_id} has no launch claim")))
                .and_then(|(claimed_operation, command, profile, worktree_mode)| {
                    if claimed_operation != operation_id.to_string() {
                        return Err(CoordinatorError::Conflict(format!(
                            "dispatch {dispatch_id} is not owned by launch operation {operation_id}"
                        )));
                    }
                    Ok(DispatchLaunchSpec {
                        operation_id,
                        command,
                        profile,
                        worktree_mode: parse_worktree_mode(&worktree_mode)?,
                    })
                })
        })
    }

    pub fn reserve_dispatch_resources(
        &self,
        operation_id: Uuid,
        reservation: DispatchResourceReservation,
    ) -> CoordinatorResult<DispatchResourceRecord> {
        self.control.with_connection_mut(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let claimed_operation: String = transaction.query_row(
                "SELECT operation_id FROM dispatch_launch_claims WHERE dispatch_id=?1",
                [&reservation.dispatch_id],
                |row| row.get(0),
            )?;
            if claimed_operation != operation_id.to_string() {
                return Err(CoordinatorError::Conflict(
                    "resource reservation does not own the dispatch launch claim".to_string(),
                ));
            }
            let worktree_json = reservation
                .worktree
                .as_ref()
                .map(serde_json::to_string)
                .transpose()?;
            transaction.execute(
                "INSERT INTO dispatch_resources(dispatch_id,operation_id,session_id,repository_root,relative_prefix,launch_path,worktree_json,pane_disposition,worktree_disposition,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,'not_created',?8,?9) ON CONFLICT(dispatch_id) DO NOTHING",
                params![
                    reservation.dispatch_id,
                    operation_id.to_string(),
                    reservation.session_id,
                    reservation.repository_root,
                    reservation.relative_prefix,
                    reservation.launch_path,
                    worktree_json,
                    if reservation.worktree.is_some() { "retained" } else { "not_created" },
                    now_millis() as i64,
                ],
            )?;
            let resource = read_dispatch_resource(&transaction, &reservation.dispatch_id)?
                .ok_or_else(|| CoordinatorError::Storage("dispatch resource reservation disappeared".to_string()))?;
            if resource.session_id != reservation.session_id
                || resource.repository_root != reservation.repository_root
                || resource.relative_prefix != reservation.relative_prefix
                || resource.launch_path != reservation.launch_path
                || resource.worktree != reservation.worktree
            {
                return Err(CoordinatorError::Conflict(
                    "dispatch resource authority changed after it was reserved".to_string(),
                ));
            }
            transaction.commit()?;
            Ok(resource)
        })
    }

    pub fn update_dispatch_worktree(
        &self,
        dispatch_id: &str,
        operation_id: Uuid,
        worktree: &WorktreeAssignment,
    ) -> CoordinatorResult<DispatchResourceRecord> {
        self.control.with_connection_mut(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if read_dispatch_resource(&transaction, dispatch_id)?.is_none() {
                return Err(CoordinatorError::NotFound("dispatch resource reservation not found".to_string()));
            }
            let worktree_json = serde_json::to_string(worktree)?;
            let changed = transaction.execute(
                "UPDATE dispatch_resources SET worktree_json=?2,updated_at=?3 WHERE dispatch_id=?1 AND operation_id=?4",
                params![dispatch_id, worktree_json, now_millis() as i64, operation_id.to_string()],
            )?;
            if changed != 1 {
                return Err(CoordinatorError::Conflict("worktree identity update does not own the dispatch launch claim".to_string()));
            }
            let updated = read_dispatch_resource(&transaction, dispatch_id)?.ok_or_else(|| CoordinatorError::Storage("updated dispatch resource disappeared".to_string()))?;
            transaction.commit()?;
            Ok(updated)
        })
    }

    pub fn record_dispatch_agent_resource(
        &self,
        dispatch_id: &str,
        operation_id: Uuid,
        agent_instance_id: &str,
    ) -> CoordinatorResult<DispatchResourceRecord> {
        self.update_dispatch_resource_owner(
            dispatch_id,
            operation_id,
            Some(agent_instance_id),
            None,
        )
    }

    pub fn record_dispatch_pane_resource(
        &self,
        dispatch_id: &str,
        operation_id: Uuid,
        pane_id: &str,
        root_pid: Option<u32>,
        process_started_at: Option<u64>,
        process_generation: u64,
    ) -> CoordinatorResult<DispatchResourceRecord> {
        self.update_dispatch_resource_owner(
            dispatch_id,
            operation_id,
            None,
            Some((pane_id, root_pid, process_started_at, process_generation)),
        )
    }

    fn update_dispatch_resource_owner(
        &self,
        dispatch_id: &str,
        operation_id: Uuid,
        agent_instance_id: Option<&str>,
        pane: Option<(&str, Option<u32>, Option<u64>, u64)>,
    ) -> CoordinatorResult<DispatchResourceRecord> {
        self.control.with_connection_mut(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let existing_operation: String = transaction.query_row(
                "SELECT operation_id FROM dispatch_resources WHERE dispatch_id=?1",
                [dispatch_id],
                |row| row.get(0),
            )?;
            if existing_operation != operation_id.to_string() {
                return Err(CoordinatorError::Conflict(
                    "dispatch resource is owned by another launch operation".to_string(),
                ));
            }
            if let Some(agent_instance_id) = agent_instance_id {
                let changed = transaction.execute(
                    "UPDATE dispatch_resources SET agent_instance_id=COALESCE(agent_instance_id,?2),updated_at=?3 WHERE dispatch_id=?1 AND (agent_instance_id IS NULL OR agent_instance_id=?2)",
                    params![dispatch_id, agent_instance_id, now_millis() as i64],
                )?;
                if changed == 0 {
                    return Err(CoordinatorError::Conflict(
                        "dispatch agent identity changed after it was recorded".to_string(),
                    ));
                }
            }
            if let Some((pane_id, root_pid, process_started_at, process_generation)) = pane {
                let changed = transaction.execute(
                    "UPDATE dispatch_resources SET pane_id=COALESCE(pane_id,?2),root_pid=COALESCE(root_pid,?3),process_started_at=COALESCE(process_started_at,?4),process_generation=COALESCE(process_generation,?5),pane_disposition='live',cleanup_reason=NULL,cleanup_error=NULL,updated_at=?6 WHERE dispatch_id=?1 AND (pane_id IS NULL OR pane_id=?2)",
                    params![dispatch_id, pane_id, root_pid.map(i64::from), process_started_at.map(|value| value as i64), process_generation as i64, now_millis() as i64],
                )?;
                if changed == 0 {
                    return Err(CoordinatorError::Conflict(
                        "dispatch pane identity changed after it was recorded".to_string(),
                    ));
                }
            }
            let resource = read_dispatch_resource(&transaction, dispatch_id)?
                .ok_or_else(|| CoordinatorError::NotFound(format!("dispatch resources {dispatch_id}")))?;
            transaction.commit()?;
            Ok(resource)
        })
    }

    pub fn mark_dispatch_resource_disposition(
        &self,
        dispatch_id: &str,
        pane_disposition: Option<ResourceDisposition>,
        worktree_disposition: Option<ResourceDisposition>,
        clear_pane_identity: bool,
        clear_worktree_identity: bool,
        cleanup_reason: Option<&str>,
        cleanup_error: Option<&str>,
    ) -> CoordinatorResult<DispatchResourceRecord> {
        self.control.with_connection_mut(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let updated_at = now_millis();
            let changed = transaction.execute(
                "UPDATE dispatch_resources SET pane_disposition=COALESCE(?2,pane_disposition),worktree_disposition=COALESCE(?3,worktree_disposition),pane_id=CASE WHEN ?4 THEN NULL ELSE pane_id END,root_pid=CASE WHEN ?4 THEN NULL ELSE root_pid END,process_started_at=CASE WHEN ?4 THEN NULL ELSE process_started_at END,process_generation=CASE WHEN ?4 THEN NULL ELSE process_generation END,worktree_json=CASE WHEN ?5 THEN NULL ELSE worktree_json END,launch_path=CASE WHEN ?5 THEN NULL ELSE launch_path END,cleanup_reason=COALESCE(?6,cleanup_reason),cleanup_error=?7,cleanup_attempts=cleanup_attempts+1,updated_at=?8 WHERE dispatch_id=?1",
                params![
                    dispatch_id,
                    pane_disposition.map(resource_disposition_text),
                    worktree_disposition.map(resource_disposition_text),
                    clear_pane_identity,
                    clear_worktree_identity,
                    cleanup_reason,
                    cleanup_error,
                    updated_at as i64,
                ],
            )?;
            if changed == 0 {
                return Err(CoordinatorError::NotFound(format!("dispatch resources {dispatch_id}")));
            }
            if clear_pane_identity {
                transaction.execute(
                    "UPDATE dispatches SET pane_id=NULL,process_generation=NULL,updated_at=?2 WHERE id=?1",
                    params![dispatch_id, updated_at as i64],
                )?;
                transaction.execute(
                    "UPDATE agent_instances SET runtime_identity=NULL,updated_at=?2 WHERE id=(SELECT agent_instance_id FROM dispatches WHERE id=?1)",
                    params![dispatch_id, updated_at as i64],
                )?;
            }
            if clear_worktree_identity {
                transaction.execute(
                    "UPDATE dispatches SET base_revision=NULL,branch=NULL,worktree_path=NULL,worktree_id=NULL,worktree_instance_id=NULL,updated_at=?2 WHERE id=?1",
                    params![dispatch_id, updated_at as i64],
                )?;
            }
            let resource = read_dispatch_resource(&transaction, dispatch_id)?
                .ok_or_else(|| CoordinatorError::NotFound(format!("dispatch resources {dispatch_id}")))?;
            transaction.commit()?;
            Ok(resource)
        })
    }

    pub fn cleanup_targets_for_run(
        &self,
        run_id: &str,
    ) -> CoordinatorResult<Vec<DispatchCleanupTarget>> {
        self.control.with_connection(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let run = read_run(connection, run_id)?;
            let dispatch_ids = query_ids(
                connection,
                "SELECT d.id FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 ORDER BY t.position,d.attempt,d.id",
                run_id,
            )?;
            let dispatches = dispatch_ids
                .into_iter()
                .map(|dispatch_id| read_dispatch(connection, &dispatch_id))
                .collect::<CoordinatorResult<Vec<_>>>()?;
            Ok(dispatches
                .into_iter()
                .map(|dispatch| DispatchCleanupTarget {
                    run_id: run.id.clone(),
                    session_id: run.session_id.clone(),
                    resources: dispatch.resources.clone(),
                    dispatch,
                })
                .collect())
        })
    }

    pub fn cleanup_target_for_dispatch(
        &self,
        dispatch_id: &str,
    ) -> CoordinatorResult<DispatchCleanupTarget> {
        self.control.with_connection(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let dispatch = read_dispatch(connection, dispatch_id)?;
            let task = read_task(connection, &dispatch.task_id)?;
            let run = read_run(connection, &task.run_id)?;
            Ok(DispatchCleanupTarget {
                run_id: run.id,
                session_id: run.session_id,
                resources: dispatch.resources.clone(),
                dispatch,
            })
        })
    }

    pub fn active_cleanup_targets(&self) -> CoordinatorResult<Vec<DispatchCleanupTarget>> {
        self.control.with_connection(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let mut statement = connection.prepare(
                "SELECT d.id,t.run_id,r.session_id FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id JOIN orchestration_runs r ON r.id=t.run_id LEFT JOIN dispatch_resources dr ON dr.dispatch_id=d.id WHERE d.status IN ('pending','dispatched','running','waiting') OR dr.pane_disposition IN ('live','cleanup_failed','unknown') OR dr.worktree_disposition='cleanup_failed' ORDER BY r.created_at,t.position,d.attempt,d.id",
            )?;
            let rows = statement
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            drop(statement);
            rows.into_iter()
                .map(|(dispatch_id, run_id, session_id)| {
                    let dispatch = read_dispatch(connection, &dispatch_id)?;
                    Ok(DispatchCleanupTarget {
                        run_id,
                        session_id,
                        resources: dispatch.resources.clone(),
                        dispatch,
                    })
                })
                .collect()
        })
    }

    pub fn record_pane_exit(
        &self,
        operation_id: Uuid,
        pane_id: &str,
        exit_code: Option<i32>,
        observed_at: u64,
    ) -> CoordinatorResult<Option<DispatchRecord>> {
        self.control.with_connection_mut(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let dispatch_id = transaction
                .query_row(
                    "SELECT dispatch_id FROM dispatch_resources WHERE pane_id=?1 UNION SELECT id FROM dispatches WHERE pane_id=?1 LIMIT 1",
                    [pane_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()?;
            let Some(dispatch_id) = dispatch_id else {
                transaction.commit()?;
                return Ok(None);
            };
            let dispatch = read_dispatch(&transaction, &dispatch_id)?;
            let cleanup_reason = dispatch
                .resources
                .as_ref()
                .and_then(|resource| resource.cleanup_reason.as_deref());
            let intentional = matches!(
                cleanup_reason,
                Some("cancel" | "reject" | "gate_reject" | "merge_applied" | "launch_failure" | "daemon_restart" | "retry_cleanup")
            );
            transaction.execute(
                "UPDATE dispatch_resources SET pane_id=NULL,root_pid=NULL,process_started_at=NULL,process_generation=NULL,pane_disposition='cleaned',cleanup_reason=COALESCE(cleanup_reason,'process_exit'),cleanup_error=NULL,updated_at=?2 WHERE dispatch_id=?1",
                params![dispatch_id, observed_at as i64],
            )?;
            transaction.execute(
                "UPDATE dispatches SET pane_id=NULL,process_generation=NULL,updated_at=?2 WHERE id=?1",
                params![dispatch_id, observed_at as i64],
            )?;
            if let Some(agent_id) = dispatch.agent_instance_id.as_deref() {
                transaction.execute(
                    "UPDATE agent_instances SET runtime_identity=NULL,updated_at=?2 WHERE id=?1",
                    params![agent_id, observed_at as i64],
                )?;
            }
            let task = read_task(&transaction, &dispatch.task_id)?;
            if dispatch.status.is_active() && !intentional {
                let failure_code = exit_code
                    .map(|code| format!("process_exit:{code}"))
                    .unwrap_or_else(|| "process_exit:unknown".to_string());
                transaction.execute(
                    "UPDATE dispatches SET status='failed',failure_code=?2,updated_at=?3 WHERE id=?1",
                    params![dispatch_id, failure_code, observed_at as i64],
                )?;
                set_task_status(
                    &transaction,
                    &task.id,
                    OrchestrationTaskStatus::Blocked,
                    Some(json!({"reason": "worker_process_exited", "exitCode": exit_code})),
                )?;
                if let Some(agent_id) = dispatch.agent_instance_id.as_deref() {
                    transaction.execute(
                        "UPDATE agent_instances SET status='failed',updated_at=?2 WHERE id=?1",
                        params![agent_id, observed_at as i64],
                    )?;
                }
                let mut run = read_run(&transaction, &task.run_id)?;
                bump_run_revision(&transaction, &mut run)?;
                refresh_terminal_run_status(&transaction, &mut run)?;
                insert_event(
                    &transaction,
                    Some(&run.id),
                    "orchestration",
                    "dispatch.process_exited",
                    Some(&dispatch_id),
                    operation_id,
                    json!({"paneId": pane_id, "exitCode": exit_code}),
                )?;
            }
            let updated = read_dispatch(&transaction, &dispatch_id)?;
            transaction.commit()?;
            Ok(Some(updated))
        })
    }

    pub fn reconcile_daemon_restart(
        &self,
        operation_id: Uuid,
        observed_at: u64,
    ) -> CoordinatorResult<Vec<String>> {
        self.control.with_connection_mut(|connection| {
            ensure_orchestration_runtime_schema(connection)?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let run_ids = {
                let mut statement = transaction.prepare(
                    "SELECT id FROM orchestration_runs WHERE status IN ('planning','running','waiting','paused') ORDER BY created_at,id",
                )?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                let collected = rows.collect::<Result<Vec<_>, _>>()?;
                collected
            };
            let mut reconciled = Vec::new();
            for run_id in run_ids {
                let dispatch_ids = query_ids(
                    &transaction,
                    "SELECT d.id FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 AND d.status IN ('pending','dispatched','running','waiting') ORDER BY t.position,d.attempt,d.id",
                    &run_id,
                )?;
                let mut changed = false;
                for dispatch_id in dispatch_ids {
                    let dispatch = read_dispatch(&transaction, &dispatch_id)?;
                    if dispatch.status == DispatchStatus::Pending && dispatch.launch_claim.is_some() {
                        continue;
                    }
                    if dispatch.status == DispatchStatus::Pending {
                        transaction.execute(
                            "UPDATE dispatches SET status='failed',failure_code='restart_unclaimed',updated_at=?2 WHERE id=?1",
                            params![dispatch.id, observed_at as i64],
                        )?;
                        transaction.execute(
                            "UPDATE orchestration_tasks SET status='ready',revision=revision+1,updated_at=?2 WHERE id=?1 AND status='dispatched'",
                            params![dispatch.task_id, observed_at as i64],
                        )?;
                    } else {
                        transaction.execute(
                            "UPDATE dispatches SET status='failed',failure_code='daemon_restart',pane_id=NULL,process_generation=NULL,updated_at=?2 WHERE id=?1",
                            params![dispatch.id, observed_at as i64],
                        )?;
                        set_task_status(
                            &transaction,
                            &dispatch.task_id,
                            OrchestrationTaskStatus::Blocked,
                            Some(json!({"reason": "daemon_restart"})),
                        )?;
                        if let Some(agent_id) = dispatch.agent_instance_id.as_deref() {
                            transaction.execute(
                                "UPDATE agent_instances SET status='lost',runtime_identity=NULL,updated_at=?2 WHERE id=?1",
                                params![agent_id, observed_at as i64],
                            )?;
                        }
                    }
                    changed = true;
                }
                let timed_out = transaction.execute(
                    "UPDATE decision_gates SET status='timeout',updated_at=?2 WHERE run_id=?1 AND status='pending' AND expires_at IS NOT NULL AND expires_at<=?2",
                    params![run_id, observed_at as i64],
                )?;
                changed |= timed_out > 0;
                if changed {
                    let mut run = read_run(&transaction, &run_id)?;
                    bump_run_revision(&transaction, &mut run)?;
                    refresh_terminal_run_status(&transaction, &mut run)?;
                    insert_event(
                        &transaction,
                        Some(&run_id),
                        "orchestration",
                        "run.daemon_reconciled",
                        Some(&run_id),
                        operation_id,
                        json!({"observedAt": observed_at}),
                    )?;
                    reconciled.push(run_id);
                }
            }
            transaction.commit()?;
            Ok(reconciled)
        })
    }

    fn schedule_ready_transaction(
        transaction: &Transaction<'_>,
        run_id: &str,
        expected_run_revision: u64,
        operation_id: Uuid,
    ) -> CoordinatorResult<ScheduleResult> {
        let mut run = read_run(transaction, run_id)?;
        require_run_revision(&run, expected_run_revision)?;
        if !matches!(run.status, RunStatus::Running | RunStatus::Waiting) {
            return Err(CoordinatorError::InvalidTransition(format!(
                "run {} cannot schedule from {:?}",
                run.id, run.status
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
                set_task_status(transaction, &task_id, OrchestrationTaskStatus::Ready, None)?;
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
            insert_event(
                transaction,
                Some(&run.id),
                "orchestration",
                "dispatch.created",
                Some(&dispatch_id),
                operation_id,
                json!({"taskId": task_id, "attempt": attempt}),
            )?;
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
        })
    }

    pub fn record_unbound_agent_launch_failure(
        &self,
        operation_id: Uuid,
        request: AgentLaunchFailureRequest,
    ) -> CoordinatorResult<AgentInstanceRecord> {
        let failure_code = required(&request.failure_code, "failure code")?;
        self.mutate(
            operation_id,
            "orchestration.agent.launch_failed",
            request,
            move |transaction, request| {
                let agent = read_agent(transaction, &request.agent_instance_id)?;
                let binding_count: i64 = transaction.query_row(
                    "SELECT COUNT(*) FROM dispatches WHERE agent_instance_id=?1",
                    [&agent.id],
                    |row| row.get(0),
                )?;
                if binding_count != 0 {
                    return Err(CoordinatorError::Conflict(format!(
                        "agent {} is already bound to a dispatch",
                        agent.id
                    )));
                }
                if agent.status != AgentLifecycleStatus::Registered {
                    return Err(CoordinatorError::InvalidTransition(format!(
                        "agent {} cannot fail launch from {:?}",
                        agent.id, agent.status
                    )));
                }
                let now = now_millis();
                transaction.execute(
                    "UPDATE agent_instances SET status='failed',updated_at=?2 WHERE id=?1",
                    params![agent.id, now as i64],
                )?;
                insert_event(
                    transaction,
                    None,
                    "orchestration",
                    "agent.launch_failed",
                    Some(&agent.id),
                    operation_id,
                    json!({"failureCode": failure_code}),
                )?;
                read_agent(transaction, &agent.id)
            },
        )
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
            "UPDATE dispatches SET agent_instance_id=?2, status='dispatched', pane_id=?3, process_generation=?4, base_revision=?5, branch=?6, worktree_path=?7, worktree_id=?8, worktree_instance_id=?9, updated_at=?10 WHERE id=?1",
            params![
                dispatch.id,
                agent.id,
                request.pane_id,
                request.process_generation as i64,
                request.worktree.as_ref().map(|value| value.base_revision.as_str()),
                request.worktree.as_ref().map(|value| value.branch.as_str()),
                request.worktree.as_ref().map(|value| value.worktree_path.as_str()),
                request.worktree.as_ref().and_then(|value| value.worktree_id.as_deref()),
                request.worktree.as_ref().and_then(|value| value.instance_id.as_deref()),
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
        let completion = json!({
            "files": request.files,
            "tests": request.tests,
            "commit": request.commit,
            "checkpoint": request.checkpoint,
            "result": request.result,
        });
        transaction.execute(
            "UPDATE dispatches SET status='completed', updated_at=?2 WHERE id=?1",
            params![dispatch.id, now as i64],
        )?;
        set_task_status(transaction, &task.id, OrchestrationTaskStatus::Completed, Some(completion.clone()))?;
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
                "files": completion["files"],
                "tests": completion["tests"],
                "commit": completion["commit"],
                "checkpoint": completion["checkpoint"],
                "result": completion["result"],
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
            transaction.execute(
                "UPDATE dispatch_resources SET worktree_disposition='retained',cleanup_reason='merge_decision',cleanup_error=NULL,updated_at=?2 WHERE dispatch_id=?1",
                params![dispatch.id, now as i64],
            )?;
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
        Ok(GateMutationResult { run, gate, dispatch, cleanup_gate: None }) })
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
        if matches!(gate.gate_type.as_str(), "merge" | "cleanup")
            && !matches!(decision, "approve" | "reject")
        {
            return Err(CoordinatorError::InvalidArgument(format!(
                "{} gate resolution decision must be approve or reject",
                gate.gate_type
            )));
        }
        if gate.gate_type == "cleanup" && decision == "approve" {
            serde_json::from_value::<CleanupDecision>(request.resolution.clone()).map_err(|error| {
                CoordinatorError::InvalidArgument(format!(
                    "cleanup approval requires force, deleteBranch, and acknowledgedBlockers: {error}"
                ))
            })?;
        }
        let now = now_millis();
        transaction.execute(
            "UPDATE decision_gates SET status='resolved', resolution_json=?2, updated_at=?3 WHERE id=?1",
            params![gate.id, serde_json::to_string(&request.resolution)?, now as i64],
        )?;
        gate = read_gate(transaction, &gate.id)?;
        let mut dispatch = gate.dispatch_id.as_deref().map(|id| read_dispatch(transaction, id)).transpose()?;
        if gate.gate_type == "merge" || gate.gate_type == "cleanup" {
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
        Ok(GateMutationResult { run, gate, dispatch, cleanup_gate: None }) })
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

    pub fn cleanup_authorization(&self, gate_id: &str) -> CoordinatorResult<CleanupAuthorization> {
        self.control.with_connection(|connection| {
            let gate = read_gate(connection, gate_id)?;
            if gate.gate_type != "cleanup" || gate.status != GateStatus::Resolved {
                return Err(CoordinatorError::InvalidTransition(format!(
                    "gate {} is not an approved cleanup gate",
                    gate.id
                )));
            }
            let decision = gate
                .resolution
                .clone()
                .ok_or_else(|| CoordinatorError::Conflict("cleanup has no decision".to_string()))?;
            let decision: CleanupDecision = serde_json::from_value(decision).map_err(|error| {
                CoordinatorError::Conflict(format!("cleanup decision is invalid: {error}"))
            })?;
            if decision.decision != "approve" {
                return Err(CoordinatorError::Conflict(
                    "cleanup was not approved".to_string(),
                ));
            }
            let dispatch_id = gate.dispatch_id.ok_or_else(|| {
                CoordinatorError::Conflict("cleanup gate has no dispatch".to_string())
            })?;
            let merge_applied = connection
                .query_row(
                    "SELECT resolution_json FROM decision_gates WHERE dispatch_id=?1 AND gate_type='merge' AND status='resolved' ORDER BY created_at DESC LIMIT 1",
                    [&dispatch_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()?
                .flatten()
                .and_then(|value| serde_json::from_str::<Value>(&value).ok())
                .is_some_and(|value| {
                    value.get("decision").and_then(Value::as_str) == Some("approve")
                        && value.get("applied").and_then(Value::as_bool) == Some(true)
                });
            if !merge_applied {
                return Err(CoordinatorError::Conflict(
                    "cleanup requires a recorded applied merge".to_string(),
                ));
            }
            let worktree = read_dispatch(connection, &dispatch_id)?
                .worktree
                .ok_or_else(|| {
                    CoordinatorError::Conflict(
                        "cleanup dispatch has no worktree record".to_string(),
                    )
                })?;
            validate_worktree(&worktree)?;
            Ok(CleanupAuthorization {
                worktree,
                force: decision.force,
                delete_branch: decision.delete_branch,
                acknowledged_blockers: decision.acknowledged_blockers,
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
                let dispatch = gate
                    .dispatch_id
                    .as_deref()
                    .map(|id| read_dispatch(transaction, id))
                    .transpose()?;
                let cleanup_gate = create_gate_record(
                    transaction,
                    &run.id,
                    gate.task_id.as_deref(),
                    gate.dispatch_id.as_deref(),
                    "cleanup",
                    "Approve cleanup of the merged worktree through shared removal preflight?",
                    vec!["approve".to_string(), "reject".to_string()],
                    None,
                    now,
                )?;
                if let Some(dispatch_id) = gate.dispatch_id.as_deref() {
                    transaction.execute(
                        "UPDATE dispatch_resources SET worktree_disposition='retained',cleanup_reason='cleanup_decision',cleanup_error=NULL,updated_at=?2 WHERE dispatch_id=?1",
                        params![dispatch_id, now as i64],
                    )?;
                }
                update_run_status(transaction, &mut run, RunStatus::Waiting)?;
                insert_message(
                    transaction,
                    &run.id,
                    gate.task_id.as_deref(),
                    gate.dispatch_id.as_deref(),
                    None,
                    "coordinator",
                    MessageType::DecisionGate,
                    json!({
                        "gateId": cleanup_gate.id,
                        "gateType": "cleanup",
                        "worktree": dispatch.as_ref().and_then(|value| value.worktree.as_ref()),
                    }),
                    now,
                )?;
                insert_event(
                    transaction,
                    Some(&run.id),
                    "orchestration",
                    "merge.applied",
                    gate.dispatch_id.as_deref(),
                    operation_id,
                    json!({
                        "gateId": gate.id,
                        "commitId": commit_id,
                        "cleanupGateId": cleanup_gate.id,
                    }),
                )?;
                Ok(GateMutationResult {
                    run,
                    gate,
                    dispatch,
                    cleanup_gate: Some(cleanup_gate),
                })
            },
        )
    }

    pub fn mark_cleanup_applied(
        &self,
        operation_id: Uuid,
        request: CleanupAppliedRequest,
    ) -> CoordinatorResult<GateMutationResult> {
        self.mutate(
            operation_id,
            "orchestration.cleanup.applied",
            request,
            move |transaction, request| {
                let mut gate = read_gate(transaction, &request.gate_id)?;
                let mut run = read_run(transaction, &gate.run_id)?;
                require_run_revision(&run, request.expected_run_revision)?;
                if gate.gate_type != "cleanup" || gate.status != GateStatus::Resolved {
                    return Err(CoordinatorError::InvalidTransition(
                        "cleanup gate is not resolved".to_string(),
                    ));
                }
                let mut resolution = gate.resolution.clone().unwrap_or_else(|| json!({}));
                if resolution.get("decision").and_then(Value::as_str) != Some("approve") {
                    return Err(CoordinatorError::Conflict(
                        "cleanup was not approved".to_string(),
                    ));
                }
                resolution["applied"] = Value::Bool(true);
                let now = now_millis();
                transaction.execute(
                    "UPDATE decision_gates SET resolution_json=?2,updated_at=?3 WHERE id=?1",
                    params![gate.id, serde_json::to_string(&resolution)?, now as i64],
                )?;
                gate = read_gate(transaction, &gate.id)?;
                bump_run_revision(transaction, &mut run)?;
                refresh_terminal_run_status(transaction, &mut run)?;
                let dispatch = gate
                    .dispatch_id
                    .as_deref()
                    .map(|id| read_dispatch(transaction, id))
                    .transpose()?;
                insert_event(
                    transaction,
                    Some(&run.id),
                    "orchestration",
                    "cleanup.applied",
                    gate.dispatch_id.as_deref(),
                    operation_id,
                    json!({"gateId": gate.id}),
                )?;
                Ok(GateMutationResult {
                    run,
                    gate,
                    dispatch,
                    cleanup_gate: None,
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
    required(
        worktree.worktree_id.as_deref().unwrap_or_default(),
        "worktree id",
    )?;
    required(
        worktree.instance_id.as_deref().unwrap_or_default(),
        "worktree instance id",
    )?;
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

fn ensure_orchestration_runtime_schema(connection: &Connection) -> CoordinatorResult<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS dispatch_launch_operations (
           operation_id TEXT PRIMARY KEY,
           request_hash TEXT NOT NULL,
           request_json TEXT NOT NULL,
           state TEXT NOT NULL CHECK(state IN ('intent','final')),
           plan_json TEXT NOT NULL,
           result_json TEXT,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS dispatch_launch_claims (
           dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
           operation_id TEXT NOT NULL REFERENCES dispatch_launch_operations(operation_id) ON DELETE RESTRICT,
           command TEXT NOT NULL,
           command_digest TEXT NOT NULL,
           profile TEXT,
           worktree_mode TEXT NOT NULL CHECK(worktree_mode IN ('reuse','worktree')),
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS dispatch_launch_claims_operation ON dispatch_launch_claims(operation_id,dispatch_id);
         CREATE TABLE IF NOT EXISTS dispatch_resources (
           dispatch_id TEXT PRIMARY KEY REFERENCES dispatches(id) ON DELETE CASCADE,
           operation_id TEXT NOT NULL,
           session_id TEXT NOT NULL,
           repository_root TEXT,
           relative_prefix TEXT NOT NULL DEFAULT '',
           launch_path TEXT,
           agent_instance_id TEXT,
           pane_id TEXT,
           root_pid INTEGER,
           process_started_at INTEGER,
           process_generation INTEGER,
           worktree_json TEXT,
           pane_disposition TEXT NOT NULL DEFAULT 'not_created' CHECK(pane_disposition IN ('not_created','live','cleaned','retained','cleanup_failed','unknown')),
           worktree_disposition TEXT NOT NULL DEFAULT 'not_created' CHECK(worktree_disposition IN ('not_created','live','cleaned','retained','cleanup_failed','unknown')),
           cleanup_reason TEXT,
           cleanup_error TEXT,
           cleanup_attempts INTEGER NOT NULL DEFAULT 0,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS dispatch_resources_pane ON dispatch_resources(pane_id);
         CREATE INDEX IF NOT EXISTS dispatch_resources_operation ON dispatch_resources(operation_id,dispatch_id);",
    )?;
    Ok(())
}

fn read_dispatch_claim(
    connection: &Connection,
    dispatch_id: &str,
) -> CoordinatorResult<Option<DispatchLaunchClaimRecord>> {
    ensure_orchestration_runtime_schema(connection)?;
    connection
        .query_row(
            "SELECT operation_id,command_digest,profile,worktree_mode FROM dispatch_launch_claims WHERE dispatch_id=?1",
            [dispatch_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?, row.get::<_, String>(3)?)),
        )
        .optional()?
        .map(|(operation_id, command_digest, profile, worktree_mode)| {
            Ok(DispatchLaunchClaimRecord {
                operation_id,
                command_digest,
                profile,
                worktree_mode: parse_worktree_mode(&worktree_mode)?,
            })
        })
        .transpose()
}

fn read_dispatch_resource(
    connection: &Connection,
    dispatch_id: &str,
) -> CoordinatorResult<Option<DispatchResourceRecord>> {
    ensure_orchestration_runtime_schema(connection)?;
    connection
        .query_row(
            "SELECT session_id,repository_root,relative_prefix,launch_path,agent_instance_id,pane_id,root_pid,process_started_at,process_generation,worktree_json,pane_disposition,worktree_disposition,cleanup_reason,cleanup_error FROM dispatch_resources WHERE dispatch_id=?1",
            [dispatch_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<i64>>(6)?, row.get::<_, Option<i64>>(7)?, row.get::<_, Option<i64>>(8)?, row.get::<_, Option<String>>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?, row.get::<_, Option<String>>(12)?, row.get::<_, Option<String>>(13)?)),
        )
        .optional()?
        .map(|row| {
            Ok(DispatchResourceRecord {
                session_id: row.0,
                repository_root: row.1,
                relative_prefix: row.2,
                launch_path: row.3,
                agent_instance_id: row.4,
                pane_id: row.5,
                root_pid: row.6.map(nonnegative).and_then(|value| u32::try_from(value).ok()),
                process_started_at: row.7.map(nonnegative),
                process_generation: row.8.map(nonnegative),
                worktree: row.9.map(|value| serde_json::from_str(&value)).transpose()?,
                pane_disposition: parse_resource_disposition(&row.10)?,
                worktree_disposition: parse_resource_disposition(&row.11)?,
                cleanup_reason: row.12,
                cleanup_error: row.13,
            })
        })
        .transpose()
}

fn claimed_dispatch_ids(
    connection: &Connection,
    operation_id: &str,
) -> CoordinatorResult<Vec<String>> {
    ensure_orchestration_runtime_schema(connection)?;
    let mut statement = connection.prepare(
        "SELECT c.dispatch_id FROM dispatch_launch_claims c JOIN dispatches d ON d.id=c.dispatch_id JOIN orchestration_tasks t ON t.id=d.task_id WHERE c.operation_id=?1 ORDER BY t.position,d.attempt,d.id",
    )?;
    let rows = statement.query_map([operation_id], |row| row.get::<_, String>(0))?;
    let collected = rows.collect::<Result<Vec<_>, _>>()?;
    Ok(collected)
}

fn dispatch_launch_request_hash(request: &DispatchLaunchRequest) -> CoordinatorResult<String> {
    Ok(digest_hex(&serde_json::to_vec(&json!({
        "kind": "orchestration.dispatch.launch",
        "request": request,
    }))?))
}

fn worktree_mode_text(mode: WorktreeMode) -> &'static str {
    match mode {
        WorktreeMode::Reuse => "reuse",
        WorktreeMode::Worktree => "worktree",
    }
}

fn parse_worktree_mode(value: &str) -> CoordinatorResult<WorktreeMode> {
    match value {
        "reuse" => Ok(WorktreeMode::Reuse),
        "worktree" => Ok(WorktreeMode::Worktree),
        _ => Err(CoordinatorError::Storage(format!(
            "unknown worktree mode: {value}"
        ))),
    }
}

fn resource_disposition_text(disposition: ResourceDisposition) -> &'static str {
    match disposition {
        ResourceDisposition::NotCreated => "not_created",
        ResourceDisposition::Live => "live",
        ResourceDisposition::Cleaned => "cleaned",
        ResourceDisposition::Retained => "retained",
        ResourceDisposition::CleanupFailed => "cleanup_failed",
        ResourceDisposition::Unknown => "unknown",
    }
}

fn parse_resource_disposition(value: &str) -> CoordinatorResult<ResourceDisposition> {
    match value {
        "not_created" => Ok(ResourceDisposition::NotCreated),
        "live" => Ok(ResourceDisposition::Live),
        "cleaned" => Ok(ResourceDisposition::Cleaned),
        "retained" => Ok(ResourceDisposition::Retained),
        "cleanup_failed" => Ok(ResourceDisposition::CleanupFailed),
        "unknown" => Ok(ResourceDisposition::Unknown),
        _ => Err(CoordinatorError::Storage(format!(
            "unknown resource disposition: {value}"
        ))),
    }
}

fn read_dispatch(connection: &Connection, dispatch_id: &str) -> CoordinatorResult<DispatchRecord> {
    ensure_orchestration_runtime_schema(connection)?;
    let row = connection
        .query_row(
            "SELECT id, task_id, attempt, agent_instance_id, status, pane_id, process_generation, base_revision, branch, worktree_path, worktree_id, worktree_instance_id, failure_code, created_at, updated_at FROM dispatches WHERE id=?1",
            [dispatch_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, String>(4)?, row.get::<_, Option<String>>(5)?, row.get::<_, Option<i64>>(6)?, row.get::<_, Option<String>>(7)?, row.get::<_, Option<String>>(8)?, row.get::<_, Option<String>>(9)?, row.get::<_, Option<String>>(10)?, row.get::<_, Option<String>>(11)?, row.get::<_, Option<String>>(12)?, row.get::<_, i64>(13)?, row.get::<_, i64>(14)?,
                ))
            },
        )
        .optional()?
        .ok_or_else(|| CoordinatorError::NotFound(format!("dispatch {dispatch_id}")))?;
    let worktree = match (row.7, row.8, row.9, row.10, row.11) {
        (Some(base_revision), Some(branch), Some(worktree_path), worktree_id, instance_id) => {
            Some(WorktreeAssignment {
                worktree_id,
                instance_id,
                base_revision,
                branch,
                worktree_path,
            })
        }
        (None, None, None, None, None) => None,
        _ => {
            return Err(CoordinatorError::Storage(
                "partial worktree record".to_string(),
            ))
        }
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
        launch_claim: read_dispatch_claim(connection, dispatch_id)?,
        resources: read_dispatch_resource(connection, dispatch_id)?,
        failure_code: row.12,
        created_at: nonnegative(row.13),
        updated_at: nonnegative(row.14),
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

fn pane_interrupted(
    dispatch_status: Option<&str>,
    task_status: Option<&str>,
    agent_status: Option<&str>,
) -> bool {
    matches!(dispatch_status, Some("cancelled"))
        || matches!(task_status, Some("cancelled"))
        || matches!(agent_status, Some("cancelled" | "stopped"))
}

fn pane_activity(
    dispatch_status: Option<&str>,
    task_status: Option<&str>,
    agent_status: Option<&str>,
    pending_gate: bool,
) -> RemotePaneActivity {
    if matches!(dispatch_status, Some("failed" | "circuit_broken"))
        || matches!(task_status, Some("failed" | "blocked"))
        || matches!(agent_status, Some("failed" | "lost"))
    {
        return RemotePaneActivity::Error;
    }
    if matches!(dispatch_status, Some("cancelled"))
        || matches!(task_status, Some("cancelled"))
        || matches!(agent_status, Some("cancelled"))
    {
        return RemotePaneActivity::Idle;
    }
    if pending_gate || dispatch_status == Some("waiting") || agent_status == Some("waiting") {
        return RemotePaneActivity::Waiting;
    }
    if matches!(dispatch_status, Some("dispatched" | "running"))
        || task_status == Some("dispatched")
        || matches!(agent_status, Some("starting" | "running" | "reconciling"))
    {
        return RemotePaneActivity::Running;
    }
    if dispatch_status == Some("completed")
        || task_status == Some("completed")
        || matches!(agent_status, Some("completed" | "stopped"))
    {
        return RemotePaneActivity::Done;
    }
    RemotePaneActivity::Idle
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
                        files: vec![],
                        tests: vec![],
                        commit: None,
                        checkpoint: None,
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
                    files: vec![],
                    tests: vec![],
                    commit: None,
                    checkpoint: None,
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
            worktree_id: Some("worktree-merge".to_string()),
            instance_id: Some("instance-merge".to_string()),
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
                    files: vec!["src/lib.rs".to_string()],
                    tests: vec!["cargo test focused".to_string()],
                    commit: Some("abc123".to_string()),
                    checkpoint: Some("review_ready".to_string()),
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
        assert_eq!(applied.run.status, RunStatus::Waiting);
        assert_eq!(
            applied
                .gate
                .resolution
                .as_ref()
                .and_then(|value| value.get("applied"))
                .and_then(Value::as_bool),
            Some(true)
        );
        let cleanup_gate = applied.cleanup_gate.expect("separate cleanup gate");
        assert_eq!(cleanup_gate.gate_type, "cleanup");
        assert_eq!(
            fixture
                .service
                .cleanup_authorization(&cleanup_gate.id)
                .expect_err("cleanup approval required")
                .code(),
            "invalid_transition"
        );
        assert_eq!(
            fixture
                .service
                .resolve_gate(
                    Uuid::new_v4(),
                    ResolveGateRequest {
                        gate_id: cleanup_gate.id.clone(),
                        resolution: json!({"decision": "approve"}),
                        expected_run_revision: applied.run.revision,
                    },
                )
                .expect_err("cleanup decision fields are required")
                .code(),
            "invalid_argument"
        );
        let cleanup_approved = fixture
            .service
            .resolve_gate(
                Uuid::new_v4(),
                ResolveGateRequest {
                    gate_id: cleanup_gate.id.clone(),
                    resolution: json!({
                        "decision": "approve",
                        "force": false,
                        "deleteBranch": true,
                        "acknowledgedBlockers": [],
                    }),
                    expected_run_revision: applied.run.revision,
                },
            )
            .expect("approve cleanup");
        assert_eq!(
            fixture
                .service
                .cleanup_authorization(&cleanup_gate.id)
                .expect("cleanup authorization")
                .worktree,
            worktree
        );
        let cleaned = fixture
            .service
            .mark_cleanup_applied(
                Uuid::new_v4(),
                CleanupAppliedRequest {
                    gate_id: cleanup_gate.id,
                    expected_run_revision: cleanup_approved.run.revision,
                },
            )
            .expect("record cleanup");
        assert_eq!(cleaned.run.status, RunStatus::Completed);
    }

    #[test]
    fn dispatch_launch_claim_is_immutable_and_replay_scoped() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(1);
        fixture.create_task(&mut run, "claimed", vec![]);
        fixture.start(&mut run);
        let operation_id = Uuid::new_v4();
        let request = DispatchLaunchRequest {
            run_id: run.id.clone(),
            expected_run_revision: run.revision,
            command: "cargo check".to_string(),
            profile: Some("codex".to_string()),
            worktree_mode: WorktreeMode::Worktree,
        };

        let dispatch = match fixture
            .service
            .prepare_dispatch_launch(operation_id, request.clone())
            .expect("prepare launch")
        {
            DispatchLaunchPreparation::Intent(plan) => {
                assert_eq!(plan.dispatches.len(), 1);
                plan.dispatches.into_iter().next().expect("dispatch")
            }
            DispatchLaunchPreparation::Replay(_) => panic!("unexpected final replay"),
        };
        let claim = dispatch.launch_claim.as_ref().expect("launch claim");
        assert_eq!(claim.operation_id, operation_id.to_string());
        assert_eq!(claim.profile.as_deref(), Some("codex"));
        assert_eq!(claim.worktree_mode, WorktreeMode::Worktree);
        let spec = fixture
            .service
            .dispatch_launch_spec(&dispatch.id, operation_id)
            .expect("launch spec");
        assert_eq!(spec.command, "cargo check");

        let replay_dispatch = match fixture
            .service
            .prepare_dispatch_launch(operation_id, request.clone())
            .expect("replay intent")
        {
            DispatchLaunchPreparation::Intent(plan) => {
                assert_eq!(plan.dispatches.len(), 1);
                plan.dispatches.into_iter().next().expect("replay dispatch")
            }
            DispatchLaunchPreparation::Replay(_) => panic!("unexpected final replay"),
        };
        assert_eq!(replay_dispatch.id, dispatch.id);

        let mut changed = request;
        changed.command = "cargo test".to_string();
        assert_eq!(
            fixture
                .service
                .prepare_dispatch_launch(operation_id, changed)
                .expect_err("reject changed spec")
                .code(),
            "conflict"
        );
    }

    #[test]
    fn daemon_restart_preserves_worktree_identity_until_authorized_cleanup() {
        let fixture = Fixture::new();
        let mut run = fixture.create_run(1);
        fixture.create_task(&mut run, "cleanup", vec![]);
        fixture.start(&mut run);
        let operation_id = Uuid::new_v4();
        let request = DispatchLaunchRequest {
            run_id: run.id.clone(),
            expected_run_revision: run.revision,
            command: "echo cleanup".to_string(),
            profile: None,
            worktree_mode: WorktreeMode::Worktree,
        };
        let dispatch = match fixture
            .service
            .prepare_dispatch_launch(operation_id, request)
            .expect("prepare launch")
        {
            DispatchLaunchPreparation::Intent(plan) => {
                plan.dispatches.into_iter().next().expect("dispatch")
            }
            DispatchLaunchPreparation::Replay(_) => panic!("unexpected final replay"),
        };
        let worktree = WorktreeAssignment {
            worktree_id: Some("worktree-cleanup".to_string()),
            instance_id: Some("instance-cleanup".to_string()),
            base_revision: "base".to_string(),
            branch: "vibelink/run-cleanup/task-cleanup-attempt-1".to_string(),
            worktree_path: "C:/managed/cleanup".to_string(),
        };
        fixture
            .service
            .reserve_dispatch_resources(
                operation_id,
                DispatchResourceReservation {
                    dispatch_id: dispatch.id.clone(),
                    session_id: run.session_id.clone(),
                    repository_root: Some("C:/repository".to_string()),
                    relative_prefix: "subproject".to_string(),
                    launch_path: Some("C:/managed/cleanup/subproject".to_string()),
                    worktree: Some(worktree.clone()),
                },
            )
            .expect("reserve resources");
        let agent = fixture
            .service
            .register_agent(
                Uuid::new_v4(),
                RegisterAgentRequest {
                    provider: AgentProvider::PtyCli,
                    profile: None,
                    workspace_path: "C:/repository/subproject".to_string(),
                    worktree_path: Some(worktree.worktree_path.clone()),
                    resumable: false,
                },
            )
            .expect("register agent");
        fixture
            .service
            .record_dispatch_agent_resource(&dispatch.id, operation_id, &agent.id)
            .expect("record agent resource");
        let pane_id = Uuid::new_v4().to_string();
        fixture
            .service
            .record_dispatch_pane_resource(
                &dispatch.id,
                operation_id,
                &pane_id,
                Some(42),
                Some(99),
                1,
            )
            .expect("record pane resource");
        let task = fixture.service.tasks(&run.id).expect("tasks").remove(0);
        fixture
            .service
            .bind_dispatch(
                Uuid::new_v4(),
                BindDispatchRequest {
                    dispatch_id: dispatch.id.clone(),
                    expected_task_revision: task.revision,
                    agent_instance_id: agent.id.clone(),
                    runtime_identity: format!("pane:{pane_id}:1"),
                    pane_id: Some(pane_id),
                    process_generation: 1,
                    worktree: Some(worktree.clone()),
                },
            )
            .expect("bind dispatch");

        fixture
            .service
            .reconcile_daemon_restart(Uuid::new_v4(), 2_000)
            .expect("reconcile daemon restart");
        let after_restart = fixture
            .service
            .cleanup_target_for_dispatch(&dispatch.id)
            .expect("restart cleanup target");
        assert_eq!(
            after_restart
                .resources
                .as_ref()
                .and_then(|resource| resource.worktree.as_ref()),
            Some(&worktree)
        );
        assert_eq!(after_restart.dispatch.worktree.as_ref(), Some(&worktree));

        let resource = fixture
            .service
            .mark_dispatch_resource_disposition(
                &dispatch.id,
                Some(ResourceDisposition::Cleaned),
                Some(ResourceDisposition::Cleaned),
                true,
                true,
                Some("test_cleanup"),
                None,
            )
            .expect("clear resource identities");
        assert_eq!(resource.pane_id, None);
        assert_eq!(resource.root_pid, None);
        assert_eq!(resource.process_started_at, None);
        assert_eq!(resource.process_generation, None);
        assert_eq!(resource.worktree, None);
        assert_eq!(resource.launch_path, None);
        let dispatch = fixture
            .service
            .dispatches(&run.id)
            .expect("dispatches")
            .remove(0);
        assert_eq!(dispatch.pane_id, None);
        assert_eq!(dispatch.process_generation, None);
        assert_eq!(dispatch.worktree, None);
        let agent = fixture
            .service
            .agents(&run.id)
            .expect("agents")
            .into_iter()
            .find(|candidate| candidate.id == agent.id)
            .expect("bound agent");
        assert_eq!(agent.runtime_identity, None);
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

    #[test]
    fn pane_activity_mapping_matches_remote_contract() {
        assert_eq!(
            pane_activity(Some("failed"), None, None, false),
            RemotePaneActivity::Error
        );
        assert_eq!(
            pane_activity(None, Some("blocked"), None, false),
            RemotePaneActivity::Error
        );
        assert_eq!(
            pane_activity(None, None, Some("lost"), false),
            RemotePaneActivity::Error
        );
        assert_eq!(
            pane_activity(Some("running"), None, None, true),
            RemotePaneActivity::Waiting
        );
        assert_eq!(
            pane_activity(Some("waiting"), None, None, false),
            RemotePaneActivity::Waiting
        );
        assert_eq!(
            pane_activity(Some("dispatched"), None, None, false),
            RemotePaneActivity::Running
        );
        assert_eq!(
            pane_activity(None, None, Some("reconciling"), false),
            RemotePaneActivity::Running
        );
        assert_eq!(
            pane_activity(Some("completed"), None, None, false),
            RemotePaneActivity::Done
        );
        assert_eq!(
            pane_activity(Some("running"), None, Some("cancelled"), false),
            RemotePaneActivity::Idle
        );
        assert_eq!(
            pane_activity(Some("cancelled"), None, Some("cancelled"), false),
            RemotePaneActivity::Idle
        );
        assert_eq!(
            pane_activity(None, None, None, false),
            RemotePaneActivity::Idle
        );

        assert!(pane_interrupted(Some("completed"), None, Some("stopped")));
        assert!(pane_interrupted(None, Some("cancelled"), None));
        assert!(!pane_interrupted(
            Some("completed"),
            None,
            Some("completed")
        ));
    }

    #[test]
    fn pane_projection_states_batches_latest_binding_gates_and_unread() {
        let fixture = Fixture::new();
        let run_id = Uuid::new_v4().to_string();
        let task_id = Uuid::new_v4().to_string();
        let agent_id = Uuid::new_v4().to_string();
        let old_dispatch_id = Uuid::new_v4().to_string();
        let dispatch_id = Uuid::new_v4().to_string();
        let pane_id = Uuid::new_v4().to_string();
        let idle_pane_id = Uuid::new_v4().to_string();
        fixture
            .service
            .control
            .with_connection(|connection| -> rusqlite::Result<()> {
                connection.execute(
                    "INSERT INTO orchestration_runs(id,session_id,goal,status,revision,policy_json,created_at,updated_at) VALUES(?1,?2,'goal','running',0,'{}',1,1)",
                    rusqlite::params![run_id, Uuid::new_v4().to_string()],
                )?;
                connection.execute(
                    "INSERT INTO orchestration_tasks(id,run_id,title,description,status,revision,position,created_at,updated_at) VALUES(?1,?2,'task','','dispatched',0,0,1,2)",
                    rusqlite::params![task_id, run_id],
                )?;
                connection.execute(
                    "INSERT INTO agent_instances(id,provider,workspace_path,status,resumable,generation,created_at,updated_at) VALUES(?1,'pty_cli','C:/workspace','running',0,1,1,2)",
                    rusqlite::params![agent_id],
                )?;
                connection.execute(
                    "INSERT INTO dispatches(id,task_id,attempt,agent_instance_id,status,pane_id,created_at,updated_at) VALUES(?1,?2,1,?3,'failed',?4,1,1)",
                    rusqlite::params![old_dispatch_id, task_id, agent_id, pane_id],
                )?;
                connection.execute(
                    "INSERT INTO dispatches(id,task_id,attempt,agent_instance_id,status,pane_id,created_at,updated_at) VALUES(?1,?2,2,?3,'running',?4,2,2)",
                    rusqlite::params![dispatch_id, task_id, agent_id, pane_id],
                )?;
                connection.execute(
                    "INSERT INTO decision_gates(id,run_id,task_id,dispatch_id,status,gate_type,prompt,options_json,created_at,updated_at) VALUES(?1,?2,?3,?4,'pending','approval','Continue?','[]',2,2)",
                    rusqlite::params![Uuid::new_v4().to_string(), run_id, task_id, dispatch_id],
                )?;
                connection.execute(
                    "INSERT INTO messages(id,run_id,task_id,dispatch_id,sender_kind,message_type,payload_json,unread,created_at) VALUES(?1,?2,?3,?4,'agent','status','{}',1,2)",
                    rusqlite::params![Uuid::new_v4().to_string(), run_id, task_id, dispatch_id],
                )?;
                connection.execute(
                    "INSERT INTO notifications(id,sequence,kind,entity_id,unread,payload_json,created_at) VALUES(?1,1,'agent',?2,1,'{}',2)",
                    rusqlite::params![Uuid::new_v4().to_string(), agent_id],
                )?;
                Ok(())
            })
            .unwrap();

        let states = fixture
            .service
            .pane_projection_states(&[pane_id.clone(), idle_pane_id.clone(), pane_id.clone()])
            .unwrap();
        assert_eq!(states.len(), 2);
        assert_eq!(
            states.get(&pane_id),
            Some(&PaneProjectionState {
                activity: RemotePaneActivity::Waiting,
                unread_count: 2,
                state_updated_at: 2,
                blocked: true,
                interrupted: false,
            })
        );
        assert_eq!(
            states.get(&idle_pane_id),
            Some(&PaneProjectionState {
                activity: RemotePaneActivity::Idle,
                unread_count: 0,
                state_updated_at: 0,
                blocked: false,
                interrupted: false,
            })
        );
    }
}

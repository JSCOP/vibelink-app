use super::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEventRecord {
    pub sequence: u64,
    pub run_id: Option<String>,
    pub domain: String,
    pub event_type: String,
    pub entity_id: Option<String>,
    pub operation_id: Option<String>,
    pub payload: Value,
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventCatchup {
    pub events: Vec<RunEventRecord>,
    pub acknowledged_sequence: u64,
    pub latest_sequence: u64,
    pub has_more: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcknowledgeEventsRequest {
    pub consumer_id: String,
    pub run_id: String,
    pub sequence: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventAcknowledgement {
    pub consumer_id: String,
    pub run_id: String,
    pub acknowledged_sequence: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationRecord {
    pub id: String,
    pub sequence: u64,
    pub kind: String,
    pub entity_id: Option<String>,
    pub unread: bool,
    pub acknowledged_at: Option<u64>,
    pub payload: Value,
    pub created_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskPatch {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<OrchestrationTaskStatus>,
    pub result: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTaskRequest {
    pub run_id: String,
    pub task_id: String,
    pub expected_run_revision: u64,
    pub expected_task_revision: u64,
    pub patch: UpdateTaskPatch,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryTaskRequest {
    pub run_id: String,
    pub task_id: String,
    pub expected_run_revision: u64,
    pub expected_task_revision: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDecisionRequest {
    pub run_id: String,
    pub expected_run_revision: u64,
    #[serde(default)]
    pub payload: Value,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunDecisionResult {
    pub run: RunRecord,
    pub decision: String,
    pub worktrees: Vec<WorktreeAssignment>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartReconciliationRequest {
    pub now_millis: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartReconciliationResult {
    pub reconciled_run_ids: Vec<String>,
    pub resumable_agent_ids: Vec<String>,
    pub blocked_task_ids: Vec<String>,
    pub reset_dispatch_ids: Vec<String>,
    pub timed_out_gate_ids: Vec<String>,
}

impl CoordinatorService {
    pub fn events_after(
        &self,
        run_id: &str,
        consumer_id: &str,
        after_sequence: Option<u64>,
        limit: u32,
    ) -> CoordinatorResult<EventCatchup> {
        let consumer_id = required(consumer_id, "event consumer id")?;
        self.control.with_connection(|connection| {
            read_run(connection, run_id)?;
            let acknowledged_sequence = connection
                .query_row(
                    "SELECT acknowledged_sequence FROM event_acknowledgements WHERE consumer_id=?1 AND run_id=?2",
                    params![consumer_id, run_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?
                .map(nonnegative)
                .unwrap_or(0);
            let cursor = after_sequence.unwrap_or(acknowledged_sequence).max(acknowledged_sequence);
            let latest_sequence = connection
                .query_row(
                    "SELECT COALESCE(MAX(sequence),0) FROM run_events WHERE run_id=?1",
                    [run_id],
                    |row| row.get::<_, i64>(0),
                )
                .map(nonnegative)?;
            let page_size = limit.clamp(1, 1000) as i64;
            let mut statement = connection.prepare(
                "SELECT sequence,run_id,domain,event_type,entity_id,operation_id,payload_json,created_at FROM run_events WHERE run_id=?1 AND sequence>?2 ORDER BY sequence LIMIT ?3",
            )?;
            let events = statement
                .query_map(params![run_id, cursor as i64, page_size], read_event)?
                .collect::<Result<Vec<_>, _>>()?;
            let has_more = events
                .last()
                .map(|event| event.sequence < latest_sequence)
                .unwrap_or(cursor < latest_sequence);
            Ok(EventCatchup {
                events,
                acknowledged_sequence,
                latest_sequence,
                has_more,
            })
        })
    }

    pub fn acknowledge_events(
        &self,
        operation_id: Uuid,
        request: AcknowledgeEventsRequest,
    ) -> CoordinatorResult<EventAcknowledgement> {
        let consumer_id = required(&request.consumer_id, "event consumer id")?;
        self.mutate(
            operation_id,
            "orchestration.events.acknowledge",
            request,
            move |transaction, request| {
                read_run(transaction, &request.run_id)?;
                let latest = transaction
                    .query_row(
                        "SELECT COALESCE(MAX(sequence),0) FROM run_events WHERE run_id=?1",
                        [&request.run_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map(nonnegative)?;
                if request.sequence > latest {
                    return Err(CoordinatorError::InvalidArgument(format!(
                        "cannot acknowledge sequence {} beyond latest {latest}",
                        request.sequence
                    )));
                }
                let now = now_millis();
                transaction.execute(
                    "INSERT INTO event_acknowledgements(consumer_id,run_id,acknowledged_sequence,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(consumer_id,run_id) DO UPDATE SET acknowledged_sequence=MAX(event_acknowledgements.acknowledged_sequence,excluded.acknowledged_sequence),updated_at=excluded.updated_at",
                    params![consumer_id, request.run_id, request.sequence as i64, now as i64],
                )?;
                let acknowledged_sequence = transaction.query_row(
                    "SELECT acknowledged_sequence FROM event_acknowledgements WHERE consumer_id=?1 AND run_id=?2",
                    params![consumer_id, request.run_id],
                    |row| row.get::<_, i64>(0),
                )?;
                Ok(EventAcknowledgement {
                    consumer_id,
                    run_id: request.run_id,
                    acknowledged_sequence: nonnegative(acknowledged_sequence),
                    updated_at: now,
                })
            },
        )
    }

    pub fn notifications_after(
        &self,
        after_sequence: u64,
        limit: u32,
    ) -> CoordinatorResult<Vec<NotificationRecord>> {
        self.control.with_connection(|connection| {
            let mut statement = connection.prepare(
                "SELECT id,sequence,kind,entity_id,unread,acknowledged_at,payload_json,created_at FROM notifications WHERE sequence>?1 ORDER BY sequence LIMIT ?2",
            )?;
            let notifications = statement
                .query_map(
                    params![after_sequence as i64, limit.clamp(1, 1000)],
                    read_notification,
                )?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(notifications)
        })
    }

    pub fn acknowledge_notification(
        &self,
        operation_id: Uuid,
        notification_id: String,
    ) -> CoordinatorResult<NotificationRecord> {
        #[derive(Serialize)]
        struct Request {
            id: String,
        }
        self.mutate(
            operation_id,
            "orchestration.notification.acknowledge",
            Request {
                id: notification_id,
            },
            move |transaction, request| {
                let notification_id = request.id;
                let now = now_millis();
                let changed = transaction.execute(
                    "UPDATE notifications SET unread=0,acknowledged_at=COALESCE(acknowledged_at,?2) WHERE id=?1",
                    params![notification_id, now as i64],
                )?;
                if changed == 0 {
                    return Err(CoordinatorError::NotFound(format!(
                        "notification {notification_id}"
                    )));
                }
                read_notification_by_id(transaction, &notification_id)
            },
        )
    }

    pub fn update_task(
        &self,
        operation_id: Uuid,
        request: UpdateTaskRequest,
    ) -> CoordinatorResult<TaskRecord> {
        self.mutate(
            operation_id,
            "orchestration.task.update",
            request,
            move |transaction, request| {
                let mut run = read_run(transaction, &request.run_id)?;
                require_run_revision(&run, request.expected_run_revision)?;
                let mut task = read_task(transaction, &request.task_id)?;
                if task.run_id != run.id {
                    return Err(CoordinatorError::Conflict(
                        "task does not belong to run".to_string(),
                    ));
                }
                require_task_revision(&task, request.expected_task_revision)?;
                if let Some(title) = request.patch.title {
                    task.title = required(&title, "task title")?;
                }
                if let Some(description) = request.patch.description {
                    task.description = description;
                }
                if let Some(status) = request.patch.status {
                    validate_manual_task_transition(task.status, status)?;
                    task.status = status;
                }
                if let Some(result) = request.patch.result {
                    task.result = Some(result);
                }
                task.revision = task.revision.saturating_add(1);
                task.updated_at = now_millis();
                transaction.execute(
                    "UPDATE orchestration_tasks SET title=?2,description=?3,status=?4,revision=?5,result_json=?6,updated_at=?7 WHERE id=?1",
                    params![task.id,task.title,task.description,task_status_text(task.status),task.revision as i64,task.result.as_ref().map(Value::to_string),task.updated_at as i64],
                )?;
                bump_run_revision(transaction, &mut run)?;
                insert_event(transaction,Some(&run.id),"orchestration","task.updated",Some(&task.id),operation_id,json!({"status": task.status,"revision": task.revision}))?;
                Ok(task)
            },
        )
    }

    pub fn retry_task(
        &self,
        operation_id: Uuid,
        request: RetryTaskRequest,
    ) -> CoordinatorResult<TaskRecord> {
        self.mutate(
            operation_id,
            "orchestration.task.retry",
            request,
            move |transaction, request| {
                let mut run = read_run(transaction, &request.run_id)?;
                require_run_revision(&run, request.expected_run_revision)?;
                let task = read_task(transaction, &request.task_id)?;
                require_task_revision(&task, request.expected_task_revision)?;
                if task.run_id != run.id {
                    return Err(CoordinatorError::Conflict(
                        "task does not belong to run".to_string(),
                    ));
                }
                if !matches!(
                    task.status,
                    OrchestrationTaskStatus::Failed
                        | OrchestrationTaskStatus::Blocked
                        | OrchestrationTaskStatus::Cancelled
                ) {
                    return Err(CoordinatorError::InvalidTransition(format!(
                        "task {} cannot retry from {:?}",
                        task.id, task.status
                    )));
                }
                let dependencies = dependency_statuses(transaction, &task.id)?;
                let next = if dependencies
                    .iter()
                    .all(|status| *status == OrchestrationTaskStatus::Completed)
                {
                    OrchestrationTaskStatus::Ready
                } else {
                    OrchestrationTaskStatus::Pending
                };
                transaction.execute(
                    "UPDATE orchestration_tasks SET status=?2,revision=revision+1,result_json=NULL,updated_at=?3 WHERE id=?1",
                    params![task.id,task_status_text(next),now_millis() as i64],
                )?;
                if run.status.is_terminal() || run.status == RunStatus::Waiting {
                    update_run_status(transaction, &mut run, RunStatus::Running)?;
                } else {
                    bump_run_revision(transaction, &mut run)?;
                }
                insert_event(transaction,Some(&run.id),"orchestration","task.retried",Some(&task.id),operation_id,json!({"status": next}))?;
                read_task(transaction, &task.id)
            },
        )
    }

    pub fn accept_run(
        &self,
        operation_id: Uuid,
        request: RunDecisionRequest,
    ) -> CoordinatorResult<RunDecisionResult> {
        self.record_run_decision(operation_id, request, "accepted")
    }

    pub fn reject_run(
        &self,
        operation_id: Uuid,
        request: RunDecisionRequest,
    ) -> CoordinatorResult<RunDecisionResult> {
        self.record_run_decision(operation_id, request, "rejected")
    }

    fn record_run_decision(
        &self,
        operation_id: Uuid,
        request: RunDecisionRequest,
        decision: &'static str,
    ) -> CoordinatorResult<RunDecisionResult> {
        self.mutate(
            operation_id,
            if decision == "accepted" {
                "orchestration.run.accept"
            } else {
                "orchestration.run.reject"
            },
            request,
            move |transaction, request| {
                let mut run = read_run(transaction, &request.run_id)?;
                require_run_revision(&run, request.expected_run_revision)?;
                if decision == "accepted" {
                    let unfinished: i64 = transaction.query_row(
                        "SELECT COUNT(*) FROM orchestration_tasks WHERE run_id=?1 AND status<>'completed'",
                        [&run.id],
                        |row| row.get(0),
                    )?;
                    if unfinished > 0 || pending_gate_count_for_run(transaction, &run.id)? > 0 {
                        return Err(CoordinatorError::InvalidTransition(
                            "run cannot be accepted before every task and gate is complete".to_string(),
                        ));
                    }
                    if run.status != RunStatus::Completed {
                        update_run_status(transaction, &mut run, RunStatus::Completed)?;
                    } else {
                        bump_run_revision(transaction, &mut run)?;
                    }
                } else {
                    cancel_active_run_entities(transaction, &run.id)?;
                    update_run_status(transaction, &mut run, RunStatus::Cancelled)?;
                }
                let now = now_millis();
                transaction.execute(
                    "INSERT INTO run_decisions(run_id,decision,payload_json,revision,created_at,updated_at) VALUES(?1,?2,?3,0,?4,?4) ON CONFLICT(run_id) DO UPDATE SET decision=excluded.decision,payload_json=excluded.payload_json,revision=run_decisions.revision+1,updated_at=excluded.updated_at",
                    params![run.id,decision,request.payload.to_string(),now as i64],
                )?;
                let worktrees = worktrees_for_run(transaction, &run.id)?;
                insert_event(transaction,Some(&run.id),"orchestration",if decision=="accepted"{"run.accepted"}else{"run.rejected"},Some(&run.id),operation_id,json!({"worktrees": worktrees}))?;
                insert_notification(transaction,if decision=="accepted"{"orchestration.accepted"}else{"orchestration.rejected"},Some(&run.id),json!({"runId":run.id}))?;
                Ok(RunDecisionResult { run, decision: decision.to_string(), worktrees })
            },
        )
    }

    pub fn reconcile_after_restart(
        &self,
        operation_id: Uuid,
        request: RestartReconciliationRequest,
    ) -> CoordinatorResult<RestartReconciliationResult> {
        self.mutate(
            operation_id,
            "orchestration.restart.reconcile",
            request,
            move |transaction, request| {
                let run_ids = {
                    let mut statement = transaction.prepare(
                        "SELECT id FROM orchestration_runs WHERE status IN ('planning','running','waiting','paused') ORDER BY created_at,id",
                    )?;
                    let ids = statement
                        .query_map([], |row| row.get::<_, String>(0))?
                        .collect::<Result<Vec<_>, _>>()?;
                    ids
                };
                let mut reconciled_run_ids = Vec::new();
                let mut resumable_agent_ids = Vec::new();
                let mut blocked_task_ids = Vec::new();
                let mut reset_dispatch_ids = Vec::new();
                let mut timed_out_gate_ids = Vec::new();
                for run_id in run_ids {
                    let mut changed = false;
                    let dispatch_ids = {
                        let mut statement = transaction.prepare("SELECT d.id FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 AND d.status IN ('pending','dispatched','running','waiting') ORDER BY t.position,d.attempt")?;
                        let ids = statement
                            .query_map([&run_id], |row| row.get::<_, String>(0))?
                            .collect::<Result<Vec<_>, _>>()?;
                        ids
                    };
                    for dispatch_id in dispatch_ids {
                        let dispatch = read_dispatch(transaction, &dispatch_id)?;
                        match dispatch.agent_instance_id.as_deref() {
                            None => {
                                transaction.execute("UPDATE dispatches SET status='failed',failure_code='restart_before_launch',updated_at=?2 WHERE id=?1",params![dispatch.id,request.now_millis as i64])?;
                                transaction.execute("UPDATE orchestration_tasks SET status='ready',revision=revision+1,updated_at=?2 WHERE id=?1 AND status='dispatched'",params![dispatch.task_id,request.now_millis as i64])?;
                                reset_dispatch_ids.push(dispatch.id);
                                changed = true;
                            }
                            Some(agent_id) => {
                                let agent = read_agent(transaction, agent_id)?;
                                if agent.resumable {
                                    transaction.execute("UPDATE agent_instances SET status='reconciling',updated_at=?2 WHERE id=?1",params![agent.id,request.now_millis as i64])?;
                                    transaction.execute("UPDATE dispatches SET status='waiting',updated_at=?2 WHERE id=?1",params![dispatch.id,request.now_millis as i64])?;
                                    resumable_agent_ids.push(agent.id);
                                } else {
                                    transaction.execute("UPDATE agent_instances SET status='lost',updated_at=?2 WHERE id=?1",params![agent.id,request.now_millis as i64])?;
                                    transaction.execute("UPDATE dispatches SET status='failed',failure_code='agent_lost',updated_at=?2 WHERE id=?1",params![dispatch.id,request.now_millis as i64])?;
                                    set_task_status(transaction,&dispatch.task_id,OrchestrationTaskStatus::Blocked,Some(json!({"reason":"agent_lost"})))?;
                                    blocked_task_ids.push(dispatch.task_id);
                                }
                                changed = true;
                            }
                        }
                    }
                    let expired_gate_ids = {
                        let mut statement = transaction.prepare("SELECT id FROM decision_gates WHERE run_id=?1 AND status='pending' AND expires_at IS NOT NULL AND expires_at<=?2 ORDER BY created_at,id")?;
                        let ids = statement
                            .query_map(params![run_id, request.now_millis as i64], |row| {
                                row.get::<_, String>(0)
                            })?
                            .collect::<Result<Vec<_>, _>>()?;
                        ids
                    };
                    for gate_id in expired_gate_ids {
                        transaction.execute("UPDATE decision_gates SET status='timeout',updated_at=?2 WHERE id=?1",params![gate_id,request.now_millis as i64])?;
                        timed_out_gate_ids.push(gate_id);
                        changed = true;
                    }
                    if changed {
                        let mut run = read_run(transaction, &run_id)?;
                        bump_run_revision(transaction, &mut run)?;
                        refresh_terminal_run_status(transaction, &mut run)?;
                        insert_event(transaction,Some(&run_id),"orchestration","run.restart_reconciled",Some(&run_id),operation_id,json!({"resumableAgents":resumable_agent_ids,"blockedTasks":blocked_task_ids,"resetDispatches":reset_dispatch_ids}))?;
                        reconciled_run_ids.push(run_id);
                    }
                }
                Ok(RestartReconciliationResult { reconciled_run_ids, resumable_agent_ids, blocked_task_ids, reset_dispatch_ids, timed_out_gate_ids })
            },
        )
    }

    pub fn agents(&self, run_id: &str) -> CoordinatorResult<Vec<AgentInstanceRecord>> {
        self.control.with_connection(|connection| {
            read_run(connection, run_id)?;
            let mut statement = connection.prepare("SELECT DISTINCT a.id FROM agent_instances a JOIN dispatches d ON d.agent_instance_id=a.id JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 ORDER BY a.created_at,a.id")?;
            let ids = statement.query_map([run_id], |row| row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
            ids.into_iter().map(|id| read_agent(connection,&id)).collect()
        })
    }
}

fn validate_manual_task_transition(
    current: OrchestrationTaskStatus,
    next: OrchestrationTaskStatus,
) -> CoordinatorResult<()> {
    if current == next {
        return Ok(());
    }
    let allowed = matches!(
        (current, next),
        (
            OrchestrationTaskStatus::Pending,
            OrchestrationTaskStatus::Ready
        ) | (
            OrchestrationTaskStatus::Ready,
            OrchestrationTaskStatus::Blocked
        ) | (
            OrchestrationTaskStatus::Failed,
            OrchestrationTaskStatus::Ready
        ) | (
            OrchestrationTaskStatus::Blocked,
            OrchestrationTaskStatus::Ready
        ) | (_, OrchestrationTaskStatus::Cancelled)
    );
    if allowed {
        Ok(())
    } else {
        Err(CoordinatorError::InvalidTransition(format!(
            "task cannot transition manually from {current:?} to {next:?}"
        )))
    }
}

fn cancel_active_run_entities(
    transaction: &Transaction<'_>,
    run_id: &str,
) -> CoordinatorResult<()> {
    let now = now_millis();
    transaction.execute("UPDATE orchestration_tasks SET status='cancelled',revision=revision+1,updated_at=?2 WHERE run_id=?1 AND status NOT IN ('completed','failed','blocked','cancelled')",params![run_id,now as i64])?;
    transaction.execute("UPDATE dispatches SET status='cancelled',updated_at=?2 WHERE task_id IN (SELECT id FROM orchestration_tasks WHERE run_id=?1) AND status IN ('pending','dispatched','running','waiting')",params![run_id,now as i64])?;
    transaction.execute("UPDATE agent_instances SET status='cancelled',updated_at=?2 WHERE id IN (SELECT d.agent_instance_id FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 AND d.agent_instance_id IS NOT NULL) AND status IN ('starting','running','waiting','reconciling')",params![run_id,now as i64])?;
    transaction.execute("UPDATE decision_gates SET status='cancelled',updated_at=?2 WHERE run_id=?1 AND status='pending'",params![run_id,now as i64])?;
    Ok(())
}

fn worktrees_for_run(
    connection: &Connection,
    run_id: &str,
) -> CoordinatorResult<Vec<WorktreeAssignment>> {
    let mut statement = connection.prepare("SELECT DISTINCT d.base_revision,d.branch,d.worktree_path FROM dispatches d JOIN orchestration_tasks t ON t.id=d.task_id WHERE t.run_id=?1 AND d.base_revision IS NOT NULL AND d.branch IS NOT NULL AND d.worktree_path IS NOT NULL ORDER BY d.worktree_path")?;
    let worktrees = statement
        .query_map([run_id], |row| {
            Ok(WorktreeAssignment {
                base_revision: row.get(0)?,
                branch: row.get(1)?,
                worktree_path: row.get(2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(worktrees)
}

fn insert_notification(
    transaction: &Transaction<'_>,
    kind: &str,
    entity_id: Option<&str>,
    payload: Value,
) -> CoordinatorResult<NotificationRecord> {
    let sequence = transaction.query_row(
        "SELECT COALESCE(MAX(sequence),0)+1 FROM notifications",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    let id = Uuid::new_v4().to_string();
    let now = now_millis();
    transaction.execute("INSERT INTO notifications(id,sequence,kind,entity_id,unread,payload_json,created_at) VALUES(?1,?2,?3,?4,1,?5,?6)",params![id,sequence,kind,entity_id,payload.to_string(),now as i64])?;
    read_notification_by_id(transaction, &id)
}

fn read_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<RunEventRecord> {
    let payload: String = row.get(6)?;
    Ok(RunEventRecord {
        sequence: nonnegative(row.get(0)?),
        run_id: row.get(1)?,
        domain: row.get(2)?,
        event_type: row.get(3)?,
        entity_id: row.get(4)?,
        operation_id: row.get(5)?,
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        created_at: nonnegative(row.get(7)?),
    })
}

fn read_notification(row: &rusqlite::Row<'_>) -> rusqlite::Result<NotificationRecord> {
    let payload: String = row.get(6)?;
    Ok(NotificationRecord {
        id: row.get(0)?,
        sequence: nonnegative(row.get(1)?),
        kind: row.get(2)?,
        entity_id: row.get(3)?,
        unread: row.get::<_, i64>(4)? != 0,
        acknowledged_at: row.get::<_, Option<i64>>(5)?.map(nonnegative),
        payload: serde_json::from_str(&payload).unwrap_or(Value::Null),
        created_at: nonnegative(row.get(7)?),
    })
}

fn read_notification_by_id(
    connection: &Connection,
    id: &str,
) -> CoordinatorResult<NotificationRecord> {
    connection.query_row("SELECT id,sequence,kind,entity_id,unread,acknowledged_at,payload_json,created_at FROM notifications WHERE id=?1",[id],read_notification).optional()?.ok_or_else(||CoordinatorError::NotFound(format!("notification {id}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane::ControlPlane;
    use std::{fs, path::PathBuf, sync::Arc};

    struct Fixture {
        root: PathBuf,
        service: CoordinatorService,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("vibelink-durable-{}", Uuid::new_v4()));
            let control = Arc::new(ControlPlane::open(&root).expect("control plane"));
            Self {
                root,
                service: CoordinatorService::new(control),
            }
        }

        fn run_with_tasks(
            &self,
            dependencies: bool,
        ) -> (RunRecord, TaskRecord, Option<TaskRecord>) {
            let mut run = self
                .service
                .create_run(
                    Uuid::new_v4(),
                    CreateRunRequest {
                        session_id: Uuid::new_v4().to_string(),
                        goal: "Durable mission".to_string(),
                        policy: RunPolicy { max_concurrent: 2 },
                    },
                )
                .expect("run");
            let first = self
                .service
                .create_task(
                    Uuid::new_v4(),
                    CreateTaskRequest {
                        run_id: run.id.clone(),
                        title: "first".to_string(),
                        description: String::new(),
                        dependencies: Vec::new(),
                        expected_run_revision: run.revision,
                    },
                )
                .expect("first task");
            run = self.service.run(&run.id).expect("run");
            let dependent = dependencies.then(|| {
                self.service
                    .create_task(
                        Uuid::new_v4(),
                        CreateTaskRequest {
                            run_id: run.id.clone(),
                            title: "dependent".to_string(),
                            description: String::new(),
                            dependencies: vec![first.id.clone()],
                            expected_run_revision: run.revision,
                        },
                    )
                    .expect("dependent task")
            });
            run = self.service.run(&run.id).expect("run");
            run = self
                .service
                .start_run(
                    Uuid::new_v4(),
                    RunRevisionRequest {
                        run_id: run.id.clone(),
                        expected_run_revision: run.revision,
                    },
                )
                .expect("start");
            (run, first, dependent)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn restart_reconciliation_resets_unlaunched_dispatch_without_duplication() {
        let fixture = Fixture::new();
        let (run, task, _) = fixture.run_with_tasks(false);
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
        assert_eq!(scheduled.dispatches.len(), 1);
        let operation_id = Uuid::new_v4();
        let first = fixture
            .service
            .reconcile_after_restart(
                operation_id,
                RestartReconciliationRequest { now_millis: 50_000 },
            )
            .expect("reconcile");
        let replay = fixture
            .service
            .reconcile_after_restart(
                operation_id,
                RestartReconciliationRequest { now_millis: 50_000 },
            )
            .expect("replay");
        assert_eq!(first, replay);
        assert_eq!(
            first.reset_dispatch_ids,
            vec![scheduled.dispatches[0].id.clone()]
        );
        assert_eq!(
            fixture
                .service
                .tasks(&run.id)
                .expect("tasks")
                .into_iter()
                .find(|value| value.id == task.id)
                .expect("task")
                .status,
            OrchestrationTaskStatus::Ready
        );
    }

    #[test]
    fn task_update_is_cas_fenced_and_idempotent() {
        let fixture = Fixture::new();
        let (run, task, _) = fixture.run_with_tasks(false);
        let operation_id = Uuid::new_v4();
        let request = UpdateTaskRequest {
            run_id: run.id.clone(),
            task_id: task.id.clone(),
            expected_run_revision: run.revision,
            expected_task_revision: task.revision,
            patch: UpdateTaskPatch {
                title: Some("updated".to_string()),
                ..Default::default()
            },
        };
        let first = fixture
            .service
            .update_task(operation_id, request.clone())
            .expect("update");
        let replay = fixture
            .service
            .update_task(operation_id, request)
            .expect("replay");
        assert_eq!(first, replay);
        let current_run = fixture.service.run(&run.id).expect("run");
        let stale = fixture
            .service
            .update_task(
                Uuid::new_v4(),
                UpdateTaskRequest {
                    run_id: run.id,
                    task_id: task.id,
                    expected_run_revision: current_run.revision,
                    expected_task_revision: 0,
                    patch: UpdateTaskPatch {
                        description: Some("stale".to_string()),
                        ..Default::default()
                    },
                },
            )
            .expect_err("stale task revision");
        assert_eq!(stale.code(), "stale_revision");
    }

    #[test]
    fn dependency_failure_blocks_downstream_task() {
        let fixture = Fixture::new();
        let (run, first, dependent) = fixture.run_with_tasks(true);
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
        for attempt in 0..3 {
            let dispatch = if attempt == 0 {
                scheduled.dispatches[0].clone()
            } else {
                let current = fixture.service.run(&run.id).expect("run");
                fixture
                    .service
                    .schedule_ready(
                        Uuid::new_v4(),
                        ScheduleRequest {
                            run_id: run.id.clone(),
                            expected_run_revision: current.revision,
                        },
                    )
                    .expect("reschedule")
                    .dispatches[0]
                    .clone()
            };
            let first_task = fixture
                .service
                .tasks(&run.id)
                .expect("tasks")
                .into_iter()
                .find(|task| task.id == first.id)
                .expect("first");
            let failure = fixture
                .service
                .record_launch_failure(
                    Uuid::new_v4(),
                    LaunchFailureRequest {
                        dispatch_id: dispatch.id,
                        expected_task_revision: first_task.revision,
                        failure_code: "spawn".to_string(),
                    },
                )
                .expect("failure");
            assert_eq!(failure.circuit_broken, attempt == 2);
        }
        let current = fixture.service.run(&run.id).expect("run");
        fixture
            .service
            .schedule_ready(
                Uuid::new_v4(),
                ScheduleRequest {
                    run_id: run.id.clone(),
                    expected_run_revision: current.revision,
                },
            )
            .expect("block dependent");
        assert_eq!(
            fixture
                .service
                .tasks(&run.id)
                .expect("tasks")
                .into_iter()
                .find(|task| Some(&task.id) == dependent.as_ref().map(|value| &value.id))
                .expect("dependent")
                .status,
            OrchestrationTaskStatus::Blocked
        );
    }

    #[test]
    fn gate_reply_and_event_replay_are_durable() {
        let fixture = Fixture::new();
        let (run, _, _) = fixture.run_with_tasks(false);
        let gate = fixture
            .service
            .create_gate(
                Uuid::new_v4(),
                CreateGateRequest {
                    run_id: run.id.clone(),
                    task_id: None,
                    dispatch_id: None,
                    gate_type: "question".to_string(),
                    prompt: "Choose".to_string(),
                    options: vec!["yes".to_string(), "no".to_string()],
                    expires_at: None,
                    expected_run_revision: run.revision,
                },
            )
            .expect("gate");
        let reply = fixture
            .service
            .post_message(
                Uuid::new_v4(),
                PostMessageRequest {
                    run_id: run.id.clone(),
                    task_id: None,
                    dispatch_id: None,
                    parent_id: None,
                    sender_kind: "user".to_string(),
                    message_type: MessageType::Chat,
                    payload: json!({"text":"yes"}),
                },
            )
            .expect("reply");
        fixture
            .service
            .resolve_gate(
                Uuid::new_v4(),
                ResolveGateRequest {
                    gate_id: gate.gate.id,
                    resolution: json!({"decision":"yes","replyMessageId":reply.id}),
                    expected_run_revision: gate.run.revision,
                },
            )
            .expect("resolve");
        let page = fixture
            .service
            .events_after(&run.id, "desktop", None, 100)
            .expect("events");
        assert!(page
            .events
            .iter()
            .any(|event| event.event_type == "gate.resolved"));
        let acknowledged = fixture
            .service
            .acknowledge_events(
                Uuid::new_v4(),
                AcknowledgeEventsRequest {
                    consumer_id: "desktop".to_string(),
                    run_id: run.id.clone(),
                    sequence: page.latest_sequence,
                },
            )
            .expect("ack");
        assert_eq!(acknowledged.acknowledged_sequence, page.latest_sequence);
        let empty = fixture
            .service
            .events_after(&run.id, "desktop", None, 100)
            .expect("caught up");
        assert!(empty.events.is_empty());
    }
}

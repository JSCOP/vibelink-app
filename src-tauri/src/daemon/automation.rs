#[path = "automation/draft.rs"]
mod draft;
#[path = "automation/import.rs"]
mod import;
#[path = "automation/model.rs"]
mod model;
#[path = "automation/payload.rs"]
mod payload;
#[path = "automation/precheck.rs"]
mod precheck;
#[path = "automation/process_registry.rs"]
pub mod process_registry;
#[path = "automation/runner.rs"]
pub mod runner;
#[cfg(test)]
#[path = "automation/runner_behavior_tests.rs"]
mod runner_behavior_tests;
#[path = "automation/schedule.rs"]
pub mod schedule;
#[path = "automation/store.rs"]
mod store;
#[path = "automation/types.rs"]
mod types;
#[path = "automation/worktree.rs"]
pub mod worktree;

pub use model::{AutomationPrecheckResult, AutomationRecord, AutomationRunRecord};
pub use process_registry::AutomationProcessRegistry;
pub use runner::{AutomationRunner, RunnerOutcome};
pub use worktree::{
    AutomationWorktreeController, CleanupOutcome, CleanupReason, PreparedWorkspace,
};

use crate::{agent_runtime::WorktreeManager, orchestration::CoordinatorService};
use anyhow::{anyhow, bail, Context, Result};
use model::{apply_patch, parse_create};
use rusqlite::{Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::Duration,
};
use store::AutomationStore;
use uuid::Uuid;

pub struct AutomationService {
    connection: Mutex<Connection>,
    coordinator: Arc<CoordinatorService>,
    worktrees: AutomationWorktreeController,
    process_registry: Arc<AutomationProcessRegistry>,
    runner: AutomationRunner,
    draft_root: PathBuf,
}

impl AutomationService {
    pub fn open(
        database_path: &Path,
        artifact_root: PathBuf,
        coordinator: Arc<CoordinatorService>,
    ) -> Result<Self> {
        if let Some(parent) = database_path.parent() {
            fs::create_dir_all(parent).with_context(|| {
                format!("create automation database directory {}", parent.display())
            })?;
        }
        fs::create_dir_all(&artifact_root).with_context(|| {
            format!(
                "create automation artifact directory {}",
                artifact_root.display()
            )
        })?;
        let draft_root = artifact_root.join("drafts");
        fs::create_dir_all(&draft_root).with_context(|| {
            format!("create automation draft directory {}", draft_root.display())
        })?;

        let connection = Connection::open(database_path)
            .with_context(|| format!("open automation database {}", database_path.display()))?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;",
        )?;

        let process_registry = Arc::new(AutomationProcessRegistry::new());
        let runner = AutomationRunner::new(Arc::clone(&process_registry), None);
        let service = Self {
            connection: Mutex::new(connection),
            coordinator,
            worktrees: AutomationWorktreeController::new(WorktreeManager::new(
                artifact_root.join("worktrees"),
            )?),
            process_registry,
            runner,
            draft_root,
        };
        service.reconcile_startup()?;
        Ok(service)
    }

    fn reconcile_startup(&self) -> Result<()> {
        let recovered = {
            let now = now_millis();
            let mut connection = self.lock()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let active = AutomationStore::active_runs(&transaction)?;
            let mut recovered = Vec::with_capacity(active.len());
            for mut run in active {
                let reason = if run.status == "pending" {
                    "VibeLink daemon restarted before Hermes dispatch began; rerun manually."
                        .to_string()
                } else if let Some(identity) = run.runtime_identity.as_ref() {
                    match process_registry::terminate_persisted_process(identity) {
                        Ok(true) => format!(
                            "VibeLink daemon restarted during Hermes execution; exact process {} generation {} was terminated safely. Rerun manually.",
                            identity.pid, identity.generation
                        ),
                        Ok(false) => format!(
                            "VibeLink daemon restarted and Hermes process {} generation {} is no longer active. Rerun manually.",
                            identity.pid, identity.generation
                        ),
                        Err(error) => {
                            tracing::warn!(automation_run_id = %run.id, pid = identity.pid, ?error, "could not safely reconcile persisted automation process identity");
                            continue;
                        }
                    }
                } else {
                    "VibeLink daemon restarted before Hermes process identity was persisted; rerun manually.".to_string()
                };
                let expected_status = run.status.clone();
                run.status = "dispatch_failed".to_string();
                run.error = Some(reason);
                run.finished_at = Some(now);
                if let Some(worktree) = run.worktree.as_mut() {
                    if worktree.disposition == "live" {
                        worktree.disposition = "retained".to_string();
                    }
                }
                recovered.push(AutomationStore::save_run_if_status(
                    &transaction,
                    &run,
                    &expected_status,
                )?);
            }
            transaction.commit()?;
            recovered
        };
        for run in recovered {
            if let Err(error) = self.create_final_notification(&run) {
                tracing::warn!(automation_run_id = %run.id, ?error, "failed to persist recovered automation notification");
            }
        }
        Ok(())
    }

    pub fn list(&self, session_id: Option<&str>) -> Result<Vec<AutomationRecord>> {
        let connection = self.lock()?;
        AutomationStore::list(&connection, session_id)
    }

    pub fn get(&self, id: &str) -> Result<AutomationRecord> {
        let connection = self.lock()?;
        AutomationStore::get(&connection, id)
    }

    pub fn create(&self, session_id: &str, payload: &Value) -> Result<AutomationRecord> {
        let now = now_millis();
        let mut record = parse_create(session_id, payload, now, Uuid::new_v4().to_string())?;
        schedule::validate_schedule(
            &record.schedule_kind,
            &record.schedule_value,
            &record.timezone,
            record.dtstart,
        )?;
        if record.requires_review && record.enabled {
            bail!("automation requiring review cannot be enabled");
        }
        record.next_run_at = if record.enabled {
            schedule::next_after(&record, record.created_at)?
        } else {
            None
        };

        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let inserted = AutomationStore::insert(&transaction, &record)?;
        transaction.commit()?;
        Ok(inserted)
    }

    pub fn update(&self, id: &str, payload: &Value) -> Result<AutomationRecord> {
        let now = now_millis();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = AutomationStore::get(&transaction, id)?;
        let mut updated = apply_patch(&existing, payload, now)?;
        schedule::validate_schedule(
            &updated.schedule_kind,
            &updated.schedule_value,
            &updated.timezone,
            updated.dtstart,
        )?;
        if updated.requires_review && updated.enabled {
            bail!("automation requiring review cannot be enabled");
        }

        let schedule_changed = existing.schedule_kind != updated.schedule_kind
            || existing.schedule_value != updated.schedule_value
            || existing.timezone != updated.timezone
            || existing.dtstart != updated.dtstart;
        updated.next_run_at = if !updated.enabled {
            None
        } else if !existing.enabled || schedule_changed || existing.next_run_at.is_none() {
            schedule::next_after(&updated, updated.updated_at)?
        } else {
            existing.next_run_at
        };

        let saved = AutomationStore::update(&transaction, &updated)?;
        transaction.commit()?;
        Ok(saved)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        AutomationStore::delete(&transaction, id)?;
        transaction.commit()?;
        Ok(())
    }

    pub fn runs(&self, automation_id: &str, limit: u32) -> Result<Vec<AutomationRunRecord>> {
        let connection = self.lock()?;
        AutomationStore::runs(&connection, automation_id, limit)
    }

    pub fn trigger(&self, automation_id: &str) -> Result<AutomationRunRecord> {
        let now = now_millis();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let automation = AutomationStore::get(&transaction, automation_id)?;
        if automation.requires_review {
            bail!("automation must be reviewed and saved before it can run");
        }
        if let Some(active) = AutomationStore::active_run(&transaction, automation_id)? {
            bail!(
                "automation already has active run {} ({})",
                active.id,
                active.status
            );
        }
        let run = AutomationRunRecord {
            id: Uuid::new_v4().to_string(),
            automation_id: automation_id.to_string(),
            run_number: AutomationStore::next_run_number(&transaction, automation_id)?,
            trigger: "manual".to_string(),
            scheduled_for: now,
            status: "pending".to_string(),
            runtime_identity: None,
            worktree: None,
            precheck_result: None,
            output_snapshot: None,
            usage: None,
            error: None,
            started_at: None,
            finished_at: None,
            created_at: now,
        };
        let inserted = AutomationStore::insert_run(&transaction, &run)?;
        transaction.commit()?;
        Ok(inserted)
    }

    pub fn claim_due(&self, now: u64) -> Result<Vec<AutomationRunRecord>> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let records = AutomationStore::due(&transaction, now)?;
        let mut claims = Vec::with_capacity(records.len());

        for record in records {
            transaction.execute_batch("SAVEPOINT automation_due_claim")?;
            match AutomationStore::claim_due(&transaction, &record, now) {
                Ok(run) => {
                    transaction.execute_batch("RELEASE SAVEPOINT automation_due_claim")?;
                    if run.status == "pending" {
                        claims.push(run);
                    }
                }
                Err(error) => {
                    transaction.execute_batch(
                        "ROLLBACK TO SAVEPOINT automation_due_claim; RELEASE SAVEPOINT automation_due_claim",
                    )?;
                    tracing::warn!(
                        automation_id = %record.id,
                        ?error,
                        "failed to claim due automation; continuing scheduler scan"
                    );
                }
            }
        }

        transaction.commit()?;
        Ok(claims)
    }

    pub fn precheck(
        &self,
        record: &AutomationRecord,
        workspace: &Path,
    ) -> AutomationPrecheckResult {
        precheck::run_precheck(record, workspace)
    }

    pub fn execute(
        &self,
        claim: &AutomationRunRecord,
        workspace: &Path,
    ) -> Result<AutomationRunRecord> {
        let automation = self.get(&claim.automation_id)?;
        if automation.requires_review {
            bail!("automation must be reviewed and saved before it can run");
        }
        let dispatch_started_at = now_millis();
        {
            let mut connection = self.lock()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut current = AutomationStore::get_run(&transaction, &claim.id)?;
            if current.automation_id != automation.id {
                bail!(
                    "automation run {} belongs to {}, not {}",
                    current.id,
                    current.automation_id,
                    automation.id
                );
            }
            if current.status == "cancelled" {
                transaction.commit()?;
                return Ok(current);
            }
            if current.status != "pending" {
                bail!(
                    "automation run cannot dispatch from status {}: {}",
                    current.status,
                    current.id
                );
            }
            current.status = "dispatching".to_string();
            current.started_at = Some(dispatch_started_at);
            current.finished_at = None;
            current.error = None;
            let saved = AutomationStore::save_run_if_status(&transaction, &current, "pending")?;
            transaction.commit()?;
            if saved.status != "dispatching" {
                return Ok(saved);
            }
        }

        let prepared =
            match self
                .worktrees
                .prepare(&claim.id, claim.run_number, &automation, workspace)
            {
                Ok(prepared) => prepared,
                Err(error) => {
                    return self.finish_prepare_failure(
                        &claim.id,
                        format!("prepare automation workspace: {error:#}"),
                    )
                }
            };

        let saved = self.persist_prepared_worktree(&claim.id, &prepared)?;
        if saved.status == "cancelled" {
            return self.finish_cancelled(&claim.id, &prepared, None, None, "dispatching");
        }

        let precheck = self.precheck(&automation, &prepared.cwd);
        if !precheck.ok {
            let cleanup = self
                .worktrees
                .cleanup_if_safe(&prepared, CleanupReason::PrecheckFailed);
            return self.persist_terminal_outcome(
                &claim.id,
                "dispatching",
                "skipped_precheck",
                cleanup,
                Some(&precheck),
                None,
                Some(precheck_failure_message(&precheck)),
                now_millis(),
            );
        }

        let saved = self.persist_precheck_result(&claim.id, &precheck)?;
        if saved.status == "cancelled" {
            return self.finish_cancelled(
                &claim.id,
                &prepared,
                Some(&precheck),
                None,
                "dispatching",
            );
        }

        let outcome = self.runner.run(&claim.id, &automation, &prepared.cwd);
        let runner_status = match outcome.status.as_str() {
            "completed"
            | "skipped_unavailable"
            | "skipped_needs_interactive_auth"
            | "dispatch_failed"
            | "cancelled" => outcome.status.clone(),
            unexpected => {
                tracing::error!(
                    run_id = %claim.id,
                    status = unexpected,
                    "automation runner returned a non-canonical status"
                );
                "dispatch_failed".to_string()
            }
        };
        let runner_error = if runner_status == outcome.status {
            outcome.error.clone()
        } else {
            Some(format!(
                "automation runner returned unsupported status: {}",
                outcome.status
            ))
        };

        let saved = self.persist_dispatched_outcome(&claim.id, &outcome, runner_error.clone())?;
        if saved.status == "cancelled" {
            return self.finish_cancelled(
                &claim.id,
                &prepared,
                Some(&precheck),
                Some(&outcome),
                "dispatching",
            );
        }

        let (cleanup_reason, cleanup_was_cancelled) = match runner_status.as_str() {
            "completed" => (CleanupReason::Completed, false),
            "skipped_unavailable" => (CleanupReason::SetupUnavailable, false),
            "skipped_needs_interactive_auth" => (CleanupReason::InteractiveAuth, false),
            "dispatch_failed" => (CleanupReason::DispatchFailed, false),
            "cancelled" => (CleanupReason::Cancelled, true),
            _ => unreachable!("runner status was canonicalized above"),
        };
        let cleanup = self.worktrees.cleanup_if_safe(&prepared, cleanup_reason);
        let saved = self.persist_terminal_outcome(
            &claim.id,
            "dispatched",
            &runner_status,
            cleanup,
            Some(&precheck),
            Some(&outcome),
            runner_error,
            outcome.finished_at,
        )?;

        if saved.status == "cancelled" && !cleanup_was_cancelled {
            return self.finish_cancelled(
                &claim.id,
                &prepared,
                Some(&precheck),
                Some(&outcome),
                "cancelled",
            );
        }
        Ok(saved)
    }

    pub fn execute_and_notify(
        &self,
        claim: &AutomationRunRecord,
        workspace: &Path,
    ) -> Result<AutomationRunRecord> {
        let run = self.execute(claim, workspace)?;
        if model::is_final_status(&run.status) {
            if let Err(error) = self.create_final_notification(&run) {
                tracing::warn!(automation_run_id = %run.id, ?error, "failed to persist automation notification");
            }
        }
        Ok(run)
    }

    fn create_final_notification(&self, run: &AutomationRunRecord) -> Result<()> {
        let automation = self.get(&run.automation_id)?;
        let kind = match run.status.as_str() {
            "completed" => "automation.completed",
            "cancelled" => "automation.cancelled",
            _ => "automation.failed",
        };
        let worktree_path = run.worktree.as_ref().map(|worktree| worktree.path.clone());
        let branch = run
            .worktree
            .as_ref()
            .map(|worktree| worktree.branch.clone());
        let output_summary = run
            .output_snapshot
            .as_ref()
            .and_then(|snapshot| snapshot.final_response.clone());
        self.coordinator
            .create_notification(
                kind,
                &run.id,
                json!({
                    "sessionId": automation.session_id,
                    "automationId": automation.id,
                    "automationName": automation.name,
                    "automationRunId": run.id,
                    "status": run.status,
                    "worktreePath": worktree_path,
                    "branch": branch,
                    "outputSummary": output_summary,
                    "error": run.error,
                }),
            )
            .map(|_| ())
            .map_err(|error| anyhow!("create automation notification: {error}"))
    }

    fn persist_prepared_worktree(
        &self,
        run_id: &str,
        prepared: &PreparedWorkspace,
    ) -> Result<AutomationRunRecord> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut current = AutomationStore::get_run(&transaction, run_id)?;
        if current.status == "cancelled" {
            transaction.commit()?;
            return Ok(current);
        }
        if current.status != "dispatching" {
            bail!(
                "automation run cannot persist prepared workspace from status {}: {}",
                current.status,
                current.id
            );
        }
        current.worktree = Some(prepared.worktree.clone());
        let saved = AutomationStore::save_run_if_status(&transaction, &current, "dispatching")?;
        transaction.commit()?;
        Ok(saved)
    }

    fn persist_precheck_result(
        &self,
        run_id: &str,
        precheck: &AutomationPrecheckResult,
    ) -> Result<AutomationRunRecord> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut current = AutomationStore::get_run(&transaction, run_id)?;
        if current.status == "cancelled" {
            transaction.commit()?;
            return Ok(current);
        }
        if current.status != "dispatching" {
            bail!(
                "automation run cannot persist precheck from status {}: {}",
                current.status,
                current.id
            );
        }
        current.precheck_result = Some(precheck.clone());
        let saved = AutomationStore::save_run_if_status(&transaction, &current, "dispatching")?;
        transaction.commit()?;
        Ok(saved)
    }

    fn persist_dispatched_outcome(
        &self,
        run_id: &str,
        outcome: &RunnerOutcome,
        error: Option<String>,
    ) -> Result<AutomationRunRecord> {
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut current = AutomationStore::get_run(&transaction, run_id)?;
        if current.status == "cancelled" {
            transaction.commit()?;
            return Ok(current);
        }
        if current.status != "dispatching" {
            bail!(
                "automation run cannot persist dispatch from status {}: {}",
                current.status,
                current.id
            );
        }

        current.status = "dispatched".to_string();
        current.runtime_identity = outcome.runtime_identity.clone();
        current.output_snapshot = outcome.output_snapshot.clone();
        current.usage = outcome.usage.clone();
        current.error = error;
        current.started_at = Some(
            current
                .started_at
                .unwrap_or(outcome.started_at)
                .min(outcome.started_at),
        );
        current.finished_at = None;
        let saved = AutomationStore::save_run_if_status(&transaction, &current, "dispatching")?;
        transaction.commit()?;
        Ok(saved)
    }

    fn finish_prepare_failure(&self, run_id: &str, error: String) -> Result<AutomationRunRecord> {
        loop {
            let mut connection = self.lock()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut current = AutomationStore::get_run(&transaction, run_id)?;
            if current.status != "dispatching" && current.status != "cancelled" {
                transaction.commit()?;
                return Ok(current);
            }
            let expected = current.status.clone();
            if expected != "cancelled" {
                current.status = "skipped_precheck".to_string();
                current.error = Some(error.clone());
                current.finished_at = Some(now_millis());
            }
            let intended = current.status.clone();
            let saved = AutomationStore::save_run_if_status(&transaction, &current, &expected)?;
            if model::is_final_status(&saved.status) {
                AutomationStore::prune_final_runs(&transaction, &saved.automation_id)?;
            }
            transaction.commit()?;
            if saved.status == intended || saved.status != "cancelled" {
                return Ok(saved);
            }
        }
    }

    fn finish_cancelled(
        &self,
        run_id: &str,
        prepared: &PreparedWorkspace,
        precheck: Option<&AutomationPrecheckResult>,
        outcome: Option<&RunnerOutcome>,
        expected_status: &str,
    ) -> Result<AutomationRunRecord> {
        let cleanup = self
            .worktrees
            .cleanup_if_safe(prepared, CleanupReason::Cancelled);
        self.persist_terminal_outcome(
            run_id,
            expected_status,
            "cancelled",
            cleanup,
            precheck,
            outcome,
            None,
            now_millis(),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn persist_terminal_outcome(
        &self,
        run_id: &str,
        expected_status: &str,
        terminal_status: &str,
        cleanup: CleanupOutcome,
        precheck: Option<&AutomationPrecheckResult>,
        outcome: Option<&RunnerOutcome>,
        error: Option<String>,
        finished_at: u64,
    ) -> Result<AutomationRunRecord> {
        loop {
            let mut connection = self.lock()?;
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let mut current = AutomationStore::get_run(&transaction, run_id)?;
            if current.status != expected_status && current.status != "cancelled" {
                transaction.commit()?;
                return Ok(current);
            }

            let expected = current.status.clone();
            let cancelled = expected == "cancelled";
            current.status = if cancelled {
                "cancelled".to_string()
            } else {
                terminal_status.to_string()
            };
            current.worktree = Some(cleanup.worktree.clone());
            if let Some(precheck) = precheck {
                current.precheck_result = Some(precheck.clone());
            }
            if let Some(outcome) = outcome {
                current.runtime_identity = outcome.runtime_identity.clone();
                current.output_snapshot = outcome.output_snapshot.clone();
                current.usage = outcome.usage.clone();
                current.started_at = Some(
                    current
                        .started_at
                        .unwrap_or(outcome.started_at)
                        .min(outcome.started_at),
                );
            }
            if !cancelled {
                current.error = error.clone();
                current.finished_at = Some(finished_at);
            }
            if let Some(cleanup_error) = cleanup.error.as_deref() {
                current.error = append_error(
                    current.error.take(),
                    format!("automation worktree cleanup failed: {cleanup_error}"),
                );
            }

            let intended = current.status.clone();
            let saved = AutomationStore::save_run_if_status(&transaction, &current, &expected)?;
            if model::is_final_status(&saved.status) {
                AutomationStore::prune_final_runs(&transaction, &saved.automation_id)?;
            }
            transaction.commit()?;
            if saved.status == intended || saved.status != "cancelled" {
                return Ok(saved);
            }
        }
    }

    pub fn cancel(&self, run_id: &str) -> Result<AutomationRunRecord> {
        self.process_registry.cancel(run_id)?;
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = AutomationStore::get_run(&transaction, run_id)?;
        if existing.status == "cancelled" {
            transaction.commit()?;
            return Ok(existing);
        }
        let cancelled = AutomationStore::cancel_run(&transaction, run_id, now_millis())?;
        AutomationStore::prune_final_runs(&transaction, &cancelled.automation_id)?;
        transaction.commit()?;
        Ok(cancelled)
    }

    pub fn schedule_preview(&self, payload: &Value) -> Result<Value> {
        validate_object(payload, "schedule preview")?;
        let object = payload.as_object().expect("validated object");
        for key in object.keys() {
            if !matches!(
                key.as_str(),
                "scheduleKind" | "scheduleValue" | "timezone" | "dtstart" | "after" | "count"
            ) {
                bail!("unknown schedule preview field '{key}'");
            }
        }
        let required = |key: &str| -> Result<&str> {
            object
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| anyhow!("schedule preview field '{key}' is required"))
        };
        let dtstart =
            match object.get("dtstart") {
                None | Some(Value::Null) => None,
                Some(value) => Some(value.as_u64().ok_or_else(|| {
                    anyhow!("schedule preview dtstart must be an integer or null")
                })?),
            };
        let after = object
            .get("after")
            .map(|value| {
                value
                    .as_u64()
                    .ok_or_else(|| anyhow!("schedule preview after must be an integer"))
            })
            .transpose()?
            .unwrap_or_else(now_millis);
        let count = object
            .get("count")
            .map(|value| {
                value
                    .as_u64()
                    .and_then(|value| usize::try_from(value).ok())
                    .ok_or_else(|| anyhow!("schedule preview count must be an integer"))
            })
            .transpose()?
            .unwrap_or(5);
        Ok(serde_json::to_value(schedule::preview_occurrences(
            required("scheduleKind")?,
            required("scheduleValue")?,
            required("timezone")?,
            dtstart,
            after,
            count,
        )?)?)
    }

    pub fn import_preview(&self, session_id: &str, workspace: &Path) -> Result<Value> {
        validate_session_id(session_id)?;
        let existing = self.list(Some(session_id))?;
        import::preview(workspace, &existing)
    }

    pub fn import(&self, session_id: &str, workspace: &Path, payload: &Value) -> Result<Value> {
        validate_session_id(session_id)?;
        validate_object(payload, "import")?;
        let existing = self.list(Some(session_id))?;
        let (selected, mut skipped) = import::selected(workspace, payload, &existing)?;
        let now = now_millis();
        let mut connection = self.lock()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = AutomationStore::list(&transaction, Some(session_id))?;
        let mut imported = Vec::new();
        for candidate in selected {
            if current.iter().any(|automation| {
                automation.source.as_ref().is_some_and(|source| {
                    source.provider == "hermes" && source.source_id == candidate.source_id
                })
            }) || imported.iter().any(|automation: &AutomationRecord| {
                automation.source.as_ref().is_some_and(|source| {
                    source.provider == "hermes" && source.source_id == candidate.source_id
                })
            }) {
                skipped.push(serde_json::json!({
                    "sourceId": candidate.source_id,
                    "reason": "this Hermes cron job was already imported",
                }));
                continue;
            }
            let record = parse_create(
                session_id,
                &candidate.payload,
                now,
                Uuid::new_v4().to_string(),
            )?;
            schedule::validate_schedule(
                &record.schedule_kind,
                &record.schedule_value,
                &record.timezone,
                record.dtstart,
            )?;
            imported.push(AutomationStore::insert(&transaction, &record)?);
        }
        transaction.commit()?;
        Ok(serde_json::json!({
            "imported": imported,
            "skipped": skipped,
        }))
    }

    pub fn draft_preview(&self, session_id: &str, payload: &Value) -> Result<Value> {
        validate_session_id(session_id)?;
        validate_object(payload, "draft")?;
        let request = draft::parse_request(payload)?;
        let cwd = self.draft_root.join(&request.request_id);
        fs::create_dir(&cwd)
            .with_context(|| format!("create isolated Hermes draft workspace {}", cwd.display()))?;

        let outcome = self
            .runner
            .run_draft(&request.request_id, &request.prompt, &cwd);
        fs::remove_dir_all(&cwd)
            .with_context(|| format!("remove isolated Hermes draft workspace {}", cwd.display()))?;

        match outcome.status.as_str() {
            "completed" => {
                let response = outcome
                    .output_snapshot
                    .as_ref()
                    .and_then(|snapshot| snapshot.final_response.as_deref())
                    .filter(|response| !response.trim().is_empty())
                    .ok_or_else(|| anyhow!("Hermes draft generation returned no final response"))?;
                draft::parse_response(&request.request_id, response)
            }
            "cancelled" => bail!("Hermes draft generation was cancelled"),
            _ => bail!(
                "Hermes draft generation failed: {}",
                outcome
                    .error
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(&outcome.status)
            ),
        }
    }

    pub fn cancel_draft(&self, request_id: &str) -> Result<Value> {
        let request_id = request_id.trim();
        Uuid::parse_str(request_id).context("draft request id must be a UUID")?;
        let cancelled = self.process_registry.cancel(request_id)?;
        Ok(serde_json::json!({
            "id": request_id,
            "cancelled": cancelled,
        }))
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| anyhow!("automation database mutex poisoned"))
    }
}

fn validate_session_id(session_id: &str) -> Result<()> {
    let session_id = session_id.trim();
    if session_id.is_empty() {
        bail!("workspace session id is required");
    }
    Uuid::parse_str(session_id).context("workspace session id must be a UUID")?;
    Ok(())
}

fn validate_object(payload: &Value, label: &str) -> Result<()> {
    if !payload.is_object() {
        bail!("{label} payload must be an object");
    }
    Ok(())
}

fn precheck_failure_message(result: &AutomationPrecheckResult) -> String {
    if let Some(error) = result
        .error
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        return format!("automation precheck failed: {}", error.trim());
    }
    if !result.stderr.trim().is_empty() {
        return format!("automation precheck failed: {}", result.stderr.trim());
    }
    if !result.stdout.trim().is_empty() {
        return format!("automation precheck failed: {}", result.stdout.trim());
    }
    if result.timed_out {
        return "automation precheck timed out".to_string();
    }
    "automation precheck failed".to_string()
}

fn append_error(existing: Option<String>, additional: String) -> Option<String> {
    Some(match existing.filter(|value| !value.trim().is_empty()) {
        Some(existing) => format!("{existing}; {additional}"),
        None => additional,
    })
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod lifecycle_tests {
    use super::*;
    use crate::control_plane::ControlPlane;
    use serde_json::json;

    fn fixture() -> (PathBuf, Arc<CoordinatorService>, AutomationService) {
        let root =
            std::env::temp_dir().join(format!("vibelink-automation-service-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create automation service fixture");
        let control = Arc::new(ControlPlane::open(&root).expect("open control plane"));
        let coordinator = Arc::new(CoordinatorService::new(control));
        let service = AutomationService::open(
            &root.join("control").join("vibelink-control.sqlite3"),
            root.join("automation-artifacts"),
            Arc::clone(&coordinator),
        )
        .expect("open automation service");
        (root, coordinator, service)
    }

    fn create_payload(enabled: bool, requires_review: bool) -> Value {
        json!({
            "name": "Lifecycle review",
            "prompt": "Review the workspace",
            "scheduleKind": "daily",
            "scheduleValue": "09:00",
            "timezone": "UTC",
            "enabled": enabled,
            "requiresReview": requires_review,
        })
    }

    #[test]
    fn review_gate_blocks_enable_and_manual_run_until_saved() {
        let (root, _coordinator, service) = fixture();
        let session_id = Uuid::new_v4().to_string();
        let error = service
            .create(&session_id, &create_payload(true, true))
            .expect_err("unreviewed automation cannot be enabled");
        assert!(error
            .to_string()
            .contains("requiring review cannot be enabled"));

        let imported = service
            .create(&session_id, &create_payload(false, true))
            .expect("create paused review record");
        let error = service
            .trigger(&imported.id)
            .expect_err("unreviewed automation cannot run");
        assert!(error.to_string().contains("reviewed and saved"));

        service
            .update(&imported.id, &json!({"requiresReview": false}))
            .expect("confirm review");
        let pending = service
            .trigger(&imported.id)
            .expect("trigger reviewed automation");
        assert_eq!(pending.status, "pending");
        let error = service
            .trigger(&imported.id)
            .expect_err("second active run must be rejected");
        assert!(error.to_string().contains("already has active run"));
        drop(service);
        drop(_coordinator);
        fs::remove_dir_all(root).expect("remove automation service fixture");
    }

    #[test]
    fn restart_marks_pending_run_failed_and_emits_one_durable_notification() {
        let (root, coordinator, service) = fixture();
        let session_id = Uuid::new_v4().to_string();
        let automation = service
            .create(&session_id, &create_payload(false, false))
            .expect("create automation");
        let pending = service.trigger(&automation.id).expect("create pending run");
        drop(service);

        let reopened = AutomationService::open(
            &root.join("control").join("vibelink-control.sqlite3"),
            root.join("automation-artifacts"),
            Arc::clone(&coordinator),
        )
        .expect("reopen automation service");
        let recovered = reopened
            .runs(&automation.id, 10)
            .expect("read recovered run");
        assert_eq!(recovered[0].id, pending.id);
        assert_eq!(recovered[0].status, "dispatch_failed");
        assert!(recovered[0]
            .error
            .as_deref()
            .is_some_and(|error| error.contains("restarted before Hermes dispatch")));

        let notifications = coordinator
            .notifications_after(0, 10)
            .expect("read notifications");
        assert_eq!(notifications.len(), 1);
        assert_eq!(notifications[0].kind, "automation.failed");
        assert_eq!(
            notifications[0].entity_id.as_deref(),
            Some(pending.id.as_str())
        );

        drop(reopened);
        drop(coordinator);
        fs::remove_dir_all(root).expect("remove automation service fixture");
    }
}

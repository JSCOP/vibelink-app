use super::{
    model::{
        is_active_status, is_final_status, read_automation, read_run, AutomationRecord,
        AutomationRunRecord,
    },
    schedule::next_after,
};
use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Serialize;
use uuid::Uuid;

const AUTOMATION_COLUMNS: &str = "id,session_id,name,prompt,agent,provider,model,use_agent_default_model,toolsets_json,skills_json,max_turns,timeout_seconds,schedule_kind,schedule_value,timezone,dtstart,next_run_at,last_run_at,enabled,requires_review,missed_run_grace_minutes,missed_run_policy,workspace_mode,worktree_storage_json,base_ref,precheck_json,source_provider,source_id,source_hash,source_snapshot_json,created_at,updated_at";
const RUN_COLUMNS: &str = "id,automation_id,run_number,trigger,scheduled_for,status,runtime_identity_json,worktree_json,precheck_result_json,output_snapshot_json,usage_json,error,started_at,finished_at,created_at";
const FINAL_RUN_STATUSES: [&str; 7] = [
    "completed",
    "skipped_precheck",
    "skipped_missed",
    "skipped_unavailable",
    "skipped_needs_interactive_auth",
    "dispatch_failed",
    "cancelled",
];
const FINAL_RUN_STATUSES_SQL: &str = "'completed','skipped_precheck','skipped_missed','skipped_unavailable','skipped_needs_interactive_auth','dispatch_failed','cancelled'";
const RETAIN_FINAL_RUNS: i64 = 100;

pub struct AutomationStore;

impl AutomationStore {
    pub fn list(
        connection: &Connection,
        session_id: Option<&str>,
    ) -> Result<Vec<AutomationRecord>> {
        let sql = match session_id {
            Some(_) => format!(
                "SELECT {AUTOMATION_COLUMNS} FROM automations WHERE session_id=?1 ORDER BY name,id"
            ),
            None => format!("SELECT {AUTOMATION_COLUMNS} FROM automations ORDER BY name,id"),
        };
        let mut statement = connection
            .prepare(&sql)
            .context("prepare automation list")?;
        let records = match session_id {
            Some(session_id) => statement
                .query_map([session_id], read_automation)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
            None => statement
                .query_map([], read_automation)?
                .collect::<rusqlite::Result<Vec<_>>>()?,
        };
        Ok(records)
    }
    pub fn due(connection: &Connection, now: u64) -> Result<Vec<AutomationRecord>> {
        let now = u64_to_i64(now, "automation due-query time")?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {AUTOMATION_COLUMNS} FROM automations WHERE enabled=1 AND requires_review=0 AND next_run_at IS NOT NULL AND next_run_at<=?1 ORDER BY next_run_at,created_at,id"
            ))
            .context("prepare due automation query")?;
        let records = statement
            .query_map([now], read_automation)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
    }

    pub fn get(connection: &Connection, id: &str) -> Result<AutomationRecord> {
        connection
            .query_row(
                &format!("SELECT {AUTOMATION_COLUMNS} FROM automations WHERE id=?1"),
                [id],
                read_automation,
            )
            .optional()?
            .with_context(|| format!("automation not found: {id}"))
    }

    pub fn insert(
        transaction: &Transaction<'_>,
        record: &AutomationRecord,
    ) -> Result<AutomationRecord> {
        let toolsets = to_json(&record.toolsets, "automation toolsets")?;
        let skills = to_json(&record.skills, "automation skills")?;
        let worktree_storage = to_json(&record.worktree_storage, "automation worktree storage")?;
        let precheck = to_json(&record.precheck, "automation precheck")?;
        let (source_provider, source_id, source_hash, source_snapshot) = source_columns(record)?;
        let dtstart = optional_u64_to_i64(record.dtstart, "automation dtstart")?;
        let next_run_at = optional_u64_to_i64(record.next_run_at, "automation next run time")?;
        let last_run_at = optional_u64_to_i64(record.last_run_at, "automation last run time")?;
        let created_at = u64_to_i64(record.created_at, "automation creation time")?;
        let updated_at = u64_to_i64(record.updated_at, "automation update time")?;

        transaction
            .execute(
                "INSERT INTO automations(id,session_id,name,prompt,agent,provider,model,use_agent_default_model,toolsets_json,skills_json,max_turns,timeout_seconds,schedule_kind,schedule_value,timezone,dtstart,next_run_at,last_run_at,enabled,requires_review,missed_run_grace_minutes,missed_run_policy,workspace_mode,worktree_storage_json,base_ref,precheck_json,source_provider,source_id,source_hash,source_snapshot_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?30,?31,?32)",
                params![
                    record.id,
                    record.session_id,
                    record.name,
                    record.prompt,
                    record.agent,
                    record.provider,
                    record.model,
                    bool_sql(record.use_agent_default_model),
                    toolsets,
                    skills,
                    i64::from(record.max_turns),
                    i64::from(record.timeout_seconds),
                    record.schedule_kind,
                    record.schedule_value,
                    record.timezone,
                    dtstart,
                    next_run_at,
                    last_run_at,
                    bool_sql(record.enabled),
                    bool_sql(record.requires_review),
                    i64::from(record.missed_run_grace_minutes),
                    record.missed_run_policy,
                    record.workspace_mode,
                    worktree_storage,
                    record.base_ref,
                    precheck,
                    source_provider,
                    source_id,
                    source_hash,
                    source_snapshot,
                    created_at,
                    updated_at,
                ],
            )
            .with_context(|| source_write_context("insert", record))?;
        Self::get(transaction, &record.id)
    }

    pub fn update(
        transaction: &Transaction<'_>,
        record: &AutomationRecord,
    ) -> Result<AutomationRecord> {
        let toolsets = to_json(&record.toolsets, "automation toolsets")?;
        let skills = to_json(&record.skills, "automation skills")?;
        let worktree_storage = to_json(&record.worktree_storage, "automation worktree storage")?;
        let precheck = to_json(&record.precheck, "automation precheck")?;
        let (source_provider, source_id, source_hash, source_snapshot) = source_columns(record)?;
        let dtstart = optional_u64_to_i64(record.dtstart, "automation dtstart")?;
        let next_run_at = optional_u64_to_i64(record.next_run_at, "automation next run time")?;
        let last_run_at = optional_u64_to_i64(record.last_run_at, "automation last run time")?;
        let updated_at = u64_to_i64(record.updated_at, "automation update time")?;

        let changed = transaction
            .execute(
                "UPDATE automations SET session_id=?2,name=?3,prompt=?4,agent=?5,provider=?6,model=?7,use_agent_default_model=?8,toolsets_json=?9,skills_json=?10,max_turns=?11,timeout_seconds=?12,schedule_kind=?13,schedule_value=?14,timezone=?15,dtstart=?16,next_run_at=?17,last_run_at=?18,enabled=?19,requires_review=?20,missed_run_grace_minutes=?21,missed_run_policy=?22,workspace_mode=?23,worktree_storage_json=?24,base_ref=?25,precheck_json=?26,source_provider=?27,source_id=?28,source_hash=?29,source_snapshot_json=?30,updated_at=?31 WHERE id=?1",
                params![
                    record.id,
                    record.session_id,
                    record.name,
                    record.prompt,
                    record.agent,
                    record.provider,
                    record.model,
                    bool_sql(record.use_agent_default_model),
                    toolsets,
                    skills,
                    i64::from(record.max_turns),
                    i64::from(record.timeout_seconds),
                    record.schedule_kind,
                    record.schedule_value,
                    record.timezone,
                    dtstart,
                    next_run_at,
                    last_run_at,
                    bool_sql(record.enabled),
                    bool_sql(record.requires_review),
                    i64::from(record.missed_run_grace_minutes),
                    record.missed_run_policy,
                    record.workspace_mode,
                    worktree_storage,
                    record.base_ref,
                    precheck,
                    source_provider,
                    source_id,
                    source_hash,
                    source_snapshot,
                    updated_at,
                ],
            )
            .with_context(|| source_write_context("update", record))?;
        if changed == 0 {
            bail!("automation not found: {}", record.id);
        }
        Self::get(transaction, &record.id)
    }

    pub fn delete(transaction: &Transaction<'_>, id: &str) -> Result<usize> {
        let changed = transaction.execute("DELETE FROM automations WHERE id=?1", [id])?;
        if changed == 0 {
            bail!("automation not found: {id}");
        }
        Ok(changed)
    }

    pub fn runs(
        connection: &Connection,
        automation_id: &str,
        limit: u32,
    ) -> Result<Vec<AutomationRunRecord>> {
        let mut statement = connection
            .prepare(&format!(
                "SELECT {RUN_COLUMNS} FROM automation_runs WHERE automation_id=?1 ORDER BY run_number DESC,id DESC LIMIT ?2"
            ))
            .context("prepare automation run list")?;
        let records = statement
            .query_map(
                params![automation_id, i64::from(limit.clamp(1, 500))],
                read_run,
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
    }

    pub fn active_runs(connection: &Connection) -> Result<Vec<AutomationRunRecord>> {
        let mut statement = connection
            .prepare(&format!(
                "SELECT {RUN_COLUMNS} FROM automation_runs WHERE status IN ('pending','dispatching','dispatched') ORDER BY created_at,id"
            ))
            .context("prepare active automation run list")?;
        let records = statement
            .query_map([], read_run)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(records)
    }

    pub fn active_run(
        connection: &Connection,
        automation_id: &str,
    ) -> Result<Option<AutomationRunRecord>> {
        connection
            .query_row(
                &format!(
                    "SELECT {RUN_COLUMNS} FROM automation_runs WHERE automation_id=?1 AND status IN ('pending','dispatching','dispatched') ORDER BY run_number DESC,id DESC LIMIT 1"
                ),
                [automation_id],
                read_run,
            )
            .optional()
            .map_err(Into::into)
    }

    pub fn get_run(connection: &Connection, id: &str) -> Result<AutomationRunRecord> {
        connection
            .query_row(
                &format!("SELECT {RUN_COLUMNS} FROM automation_runs WHERE id=?1"),
                [id],
                read_run,
            )
            .optional()?
            .with_context(|| format!("automation run not found: {id}"))
    }

    pub fn next_run_number(transaction: &Transaction<'_>, automation_id: &str) -> Result<u64> {
        let current = transaction.query_row(
            "SELECT MAX(run_number) FROM automation_runs WHERE automation_id=?1",
            [automation_id],
            |row| row.get::<_, Option<i64>>(0),
        )?;
        let next = current
            .unwrap_or(0)
            .checked_add(1)
            .with_context(|| format!("automation run number exhausted: {automation_id}"))?;
        u64::try_from(next).with_context(|| {
            format!("automation run number is negative for automation {automation_id}: {next}")
        })
    }

    pub fn insert_run(
        transaction: &Transaction<'_>,
        record: &AutomationRunRecord,
    ) -> Result<AutomationRunRecord> {
        let run_number = u64_to_i64(record.run_number, "automation run number")?;
        let scheduled_for = u64_to_i64(record.scheduled_for, "automation scheduled time")?;
        let runtime_identity = optional_json(
            record.runtime_identity.as_ref(),
            "automation runtime identity",
        )?;
        let worktree = optional_json(record.worktree.as_ref(), "automation run worktree")?;
        let precheck_result = optional_json(
            record.precheck_result.as_ref(),
            "automation precheck result",
        )?;
        let output_snapshot = optional_json(
            record.output_snapshot.as_ref(),
            "automation output snapshot",
        )?;
        let usage = optional_json(record.usage.as_ref(), "automation usage")?;
        let started_at = optional_u64_to_i64(record.started_at, "automation run start time")?;
        let finished_at = optional_u64_to_i64(record.finished_at, "automation run finish time")?;
        let created_at = u64_to_i64(record.created_at, "automation run creation time")?;

        transaction
            .execute(
                "INSERT INTO automation_runs(id,automation_id,run_number,trigger,scheduled_for,status,runtime_identity_json,worktree_json,precheck_result_json,output_snapshot_json,usage_json,error,started_at,finished_at,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)",
                params![
                    record.id,
                    record.automation_id,
                    run_number,
                    record.trigger,
                    scheduled_for,
                    record.status,
                    runtime_identity,
                    worktree,
                    precheck_result,
                    output_snapshot,
                    usage,
                    record.error,
                    started_at,
                    finished_at,
                    created_at,
                ],
            )
            .with_context(|| {
                format!(
                    "insert automation run {} number {} for automation {}",
                    record.id, record.run_number, record.automation_id
                )
            })?;
        Self::get_run(transaction, &record.id)
    }

    pub fn save_run_if_status(
        transaction: &Transaction<'_>,
        record: &AutomationRunRecord,
        expected_status: &str,
    ) -> Result<AutomationRunRecord> {
        let runtime_identity = optional_json(
            record.runtime_identity.as_ref(),
            "automation runtime identity",
        )?;
        let worktree = optional_json(record.worktree.as_ref(), "automation run worktree")?;
        let precheck_result = optional_json(
            record.precheck_result.as_ref(),
            "automation precheck result",
        )?;
        let output_snapshot = optional_json(
            record.output_snapshot.as_ref(),
            "automation output snapshot",
        )?;
        let usage = optional_json(record.usage.as_ref(), "automation usage")?;
        let started_at = optional_u64_to_i64(record.started_at, "automation run start time")?;
        let finished_at = optional_u64_to_i64(record.finished_at, "automation run finish time")?;

        transaction
            .execute(
                "UPDATE automation_runs SET status=?2,runtime_identity_json=?3,worktree_json=?4,precheck_result_json=?5,output_snapshot_json=?6,usage_json=?7,error=?8,started_at=?9,finished_at=?10 WHERE id=?1 AND status=?11",
                params![
                    record.id,
                    record.status,
                    runtime_identity,
                    worktree,
                    precheck_result,
                    output_snapshot,
                    usage,
                    record.error,
                    started_at,
                    finished_at,
                    expected_status,
                ],
            )
            .with_context(|| {
                format!(
                    "save automation run {} from status {expected_status}",
                    record.id
                )
            })?;
        Self::get_run(transaction, &record.id)
    }

    pub fn cancel_run(
        transaction: &Transaction<'_>,
        id: &str,
        finished_at: u64,
    ) -> Result<AutomationRunRecord> {
        let existing = Self::get_run(transaction, id)?;
        if !is_active_status(&existing.status) {
            bail!("automation run is not active: {id} ({})", existing.status);
        }
        let finished_at = u64_to_i64(finished_at, "automation cancellation time")?;
        let changed = transaction.execute(
            "UPDATE automation_runs SET status='cancelled',finished_at=?2 WHERE id=?1 AND status IN ('pending','dispatching','dispatched')",
            params![id, finished_at],
        )?;
        if changed == 0 {
            bail!("automation run is no longer active: {id}");
        }
        Self::get_run(transaction, id)
    }

    pub fn claim_due(
        transaction: &Transaction<'_>,
        record: &AutomationRecord,
        now: u64,
    ) -> Result<AutomationRunRecord> {
        let scheduled_for = record
            .next_run_at
            .with_context(|| format!("automation has no scheduled occurrence: {}", record.id))?;
        if scheduled_for > now {
            bail!(
                "automation is not due: {} (scheduled for {scheduled_for}, now {now})",
                record.id
            );
        }

        let source = Self::get(transaction, &record.id)?;
        if !source.enabled || source.next_run_at != Some(scheduled_for) {
            return transaction
                .query_row(
                    &format!(
                        "SELECT {RUN_COLUMNS} FROM automation_runs WHERE automation_id=?1 AND trigger='scheduled' AND scheduled_for=?2 ORDER BY run_number DESC,id DESC LIMIT 1"
                    ),
                    params![record.id, u64_to_i64(scheduled_for, "automation scheduled time")?],
                    read_run,
                )
                .optional()?
                .with_context(|| {
                    format!(
                        "automation occurrence is no longer due: {} at {scheduled_for}",
                        record.id
                    )
                });
        }
        if let Some(active) = Self::active_run(transaction, &source.id)? {
            bail!(
                "automation already has active run {} ({}): {}",
                active.id,
                active.status,
                source.id
            );
        }

        let next_run_at = next_after(&source, now)
            .with_context(|| format!("advance automation schedule: {}", source.id))?;
        let grace_ms = u64::from(source.missed_run_grace_minutes).saturating_mul(60_000);
        let lateness_ms = now.saturating_sub(scheduled_for);
        let missed = lateness_ms > grace_ms;
        let status = if missed { "skipped_missed" } else { "pending" };
        let error = missed.then(|| {
            format!(
                "Scheduled occurrence at {scheduled_for} was missed by {lateness_ms} ms, beyond the configured grace period of {} minutes",
                source.missed_run_grace_minutes
            )
        });
        let run = AutomationRunRecord {
            id: Uuid::new_v4().to_string(),
            automation_id: source.id.clone(),
            run_number: Self::next_run_number(transaction, &source.id)?,
            trigger: "scheduled".to_string(),
            scheduled_for,
            status: status.to_string(),
            runtime_identity: None,
            worktree: None,
            precheck_result: None,
            output_snapshot: None,
            usage: None,
            error,
            started_at: None,
            finished_at: missed.then_some(now),
            created_at: now,
        };

        let changed = transaction.execute(
            "UPDATE automations SET last_run_at=?2,next_run_at=?3,updated_at=?4 WHERE id=?1 AND enabled=1 AND next_run_at=?2",
            params![
                source.id,
                u64_to_i64(scheduled_for, "automation scheduled time")?,
                optional_u64_to_i64(next_run_at, "automation next run time")?,
                u64_to_i64(now, "automation claim time")?,
            ],
        )?;
        if changed == 0 {
            bail!(
                "automation occurrence was claimed concurrently: {} at {scheduled_for}",
                source.id
            );
        }

        let inserted = Self::insert_run(transaction, &run)
            .with_context(|| format!("claim due automation occurrence: {}", source.id))?;
        Self::prune_final_runs(transaction, &source.id)?;
        Ok(inserted)
    }

    pub fn prune_final_runs(transaction: &Transaction<'_>, automation_id: &str) -> Result<usize> {
        debug_assert!(FINAL_RUN_STATUSES.iter().copied().all(is_final_status));
        transaction
            .execute(
                &format!(
                    "DELETE FROM automation_runs WHERE automation_id=?1 AND status IN ({FINAL_RUN_STATUSES_SQL}) AND id IN (SELECT id FROM automation_runs WHERE automation_id=?1 AND status IN ({FINAL_RUN_STATUSES_SQL}) ORDER BY run_number DESC,created_at DESC,id DESC LIMIT -1 OFFSET ?2)"
                ),
                params![automation_id, RETAIN_FINAL_RUNS],
            )
            .with_context(|| format!("prune final automation runs: {automation_id}"))
    }
}

fn source_columns(
    record: &AutomationRecord,
) -> Result<(
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
)> {
    let Some(source) = record.source.as_ref() else {
        return Ok((None, None, None, None));
    };
    Ok((
        Some(source.provider.clone()),
        Some(source.source_id.clone()),
        Some(source.source_hash.clone()),
        Some(to_json(&source.snapshot, "automation source snapshot")?),
    ))
}

fn source_write_context(operation: &str, record: &AutomationRecord) -> String {
    match record.source.as_ref() {
        Some(source) => format!(
            "{operation} automation {} from source {}:{}",
            record.id, source.provider, source.source_id
        ),
        None => format!("{operation} automation {}", record.id),
    }
}

fn to_json<T: Serialize + ?Sized>(value: &T, label: &str) -> Result<String> {
    serde_json::to_string(value).with_context(|| format!("serialize {label}"))
}

fn optional_json<T: Serialize + ?Sized>(value: Option<&T>, label: &str) -> Result<Option<String>> {
    value.map(|value| to_json(value, label)).transpose()
}

fn bool_sql(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn u64_to_i64(value: u64, label: &str) -> Result<i64> {
    i64::try_from(value).with_context(|| format!("{label} exceeds SQLite INTEGER range: {value}"))
}

fn optional_u64_to_i64(value: Option<u64>, label: &str) -> Result<Option<i64>> {
    value.map(|value| u64_to_i64(value, label)).transpose()
}

#[cfg(test)]
mod tests {
    use super::super::model::AutomationPrecheck;
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    const MINUTE: u64 = 60_000;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open automation store database");
        connection
            .execute_batch(
                "PRAGMA foreign_keys = ON;
                 CREATE TABLE automations (
                   id TEXT PRIMARY KEY,
                   session_id TEXT NOT NULL,
                   name TEXT NOT NULL,
                   prompt TEXT NOT NULL,
                   agent TEXT NOT NULL,
                   provider TEXT,
                   model TEXT,
                   use_agent_default_model INTEGER NOT NULL,
                   toolsets_json TEXT NOT NULL,
                   skills_json TEXT NOT NULL,
                   max_turns INTEGER NOT NULL,
                   timeout_seconds INTEGER NOT NULL,
                   schedule_kind TEXT NOT NULL,
                   schedule_value TEXT NOT NULL,
                   timezone TEXT NOT NULL,
                   dtstart INTEGER,
                   next_run_at INTEGER,
                   last_run_at INTEGER,
                   enabled INTEGER NOT NULL,
                   requires_review INTEGER NOT NULL,
                   missed_run_grace_minutes INTEGER NOT NULL,
                   missed_run_policy TEXT NOT NULL,
                   workspace_mode TEXT NOT NULL,
                   worktree_storage_json TEXT NOT NULL,
                   base_ref TEXT,
                   precheck_json TEXT NOT NULL,
                   source_provider TEXT,
                   source_id TEXT,
                   source_hash TEXT,
                   source_snapshot_json TEXT,
                   created_at INTEGER NOT NULL,
                   updated_at INTEGER NOT NULL,
                   UNIQUE(source_provider, source_id)
                 );
                 CREATE TABLE automation_runs (
                   id TEXT PRIMARY KEY,
                   automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
                   run_number INTEGER NOT NULL,
                   trigger TEXT NOT NULL,
                   scheduled_for INTEGER NOT NULL,
                   status TEXT NOT NULL,
                   runtime_identity_json TEXT,
                   worktree_json TEXT,
                   precheck_result_json TEXT,
                   output_snapshot_json TEXT,
                   usage_json TEXT,
                   error TEXT,
                   started_at INTEGER,
                   finished_at INTEGER,
                   created_at INTEGER NOT NULL,
                   UNIQUE(automation_id, run_number)
                 );",
            )
            .expect("create automation store schema");
        connection
    }

    fn interval_record(id: &str, next_run_at: u64, grace_minutes: u32) -> AutomationRecord {
        AutomationRecord {
            id: id.to_string(),
            session_id: "session".into(),
            name: id.to_string(),
            prompt: "run the automation".into(),
            agent: "hermes".into(),
            provider: None,
            model: None,
            use_agent_default_model: true,
            toolsets: vec!["hermes-acp".into()],
            skills: Vec::new(),
            max_turns: 50,
            timeout_seconds: 1_800,
            schedule_kind: "interval".into(),
            schedule_value: "60".into(),
            timezone: "UTC".into(),
            dtstart: Some(0),
            next_run_at: Some(next_run_at),
            last_run_at: None,
            enabled: true,
            requires_review: false,
            missed_run_grace_minutes: grace_minutes,
            missed_run_policy: "run_once_within_grace".into(),
            workspace_mode: "new_per_run".into(),
            worktree_storage: json!({}),
            base_ref: None,
            precheck: AutomationPrecheck {
                command: None,
                timeout_seconds: 60,
                require_workspace: true,
                require_git: false,
            },
            source: None,
            created_at: 0,
            updated_at: 0,
        }
    }

    fn insert_automation(connection: &mut Connection, record: &AutomationRecord) {
        let transaction = connection.transaction().expect("begin automation insert");
        AutomationStore::insert(&transaction, record).expect("insert automation");
        transaction.commit().expect("commit automation insert");
    }

    fn completed_run(automation_id: &str, run_number: u64) -> AutomationRunRecord {
        AutomationRunRecord {
            id: format!("completed-{run_number}"),
            automation_id: automation_id.to_string(),
            run_number,
            trigger: "manual".into(),
            scheduled_for: run_number,
            status: "completed".into(),
            runtime_identity: None,
            worktree: None,
            precheck_result: None,
            output_snapshot: None,
            usage: None,
            error: None,
            started_at: Some(run_number),
            finished_at: Some(run_number),
            created_at: run_number,
        }
    }

    #[test]
    fn duplicate_tick_returns_the_same_claim_without_advancing_twice() {
        let mut connection = connection();
        insert_automation(&mut connection, &interval_record("duplicate", MINUTE, 720));
        let due = AutomationStore::due(&connection, MINUTE).expect("query due automation");
        assert_eq!(due.len(), 1);

        let transaction = connection.transaction().expect("begin due claim");
        let first = AutomationStore::claim_due(&transaction, &due[0], MINUTE)
            .expect("claim first scheduler tick");
        let duplicate = AutomationStore::claim_due(&transaction, &due[0], MINUTE)
            .expect("repeat scheduler tick idempotently");
        assert_eq!(duplicate.id, first.id);
        transaction.commit().expect("commit due claims");

        assert_eq!(
            AutomationStore::runs(&connection, "duplicate", 10)
                .unwrap()
                .len(),
            1
        );
        let source = AutomationStore::get(&connection, "duplicate").unwrap();
        assert_eq!(source.last_run_at, Some(MINUTE));
        assert_eq!(source.next_run_at, Some(2 * MINUTE));
    }

    #[test]
    fn due_occurrence_within_grace_creates_one_pending_catch_up() {
        let mut connection = connection();
        insert_automation(&mut connection, &interval_record("within-grace", MINUTE, 1));
        let now = MINUTE + 5_000;
        let record = AutomationStore::due(&connection, now).unwrap().remove(0);

        let transaction = connection.transaction().unwrap();
        let claim = AutomationStore::claim_due(&transaction, &record, now).unwrap();
        transaction.commit().unwrap();

        assert_eq!(claim.status, "pending");
        assert_eq!(claim.scheduled_for, MINUTE);
        assert_eq!(claim.finished_at, None);
        assert_eq!(claim.error, None);
        let source = AutomationStore::get(&connection, "within-grace").unwrap();
        assert_eq!(source.last_run_at, Some(MINUTE));
        assert_eq!(source.next_run_at, Some(2 * MINUTE));
        assert_eq!(source.updated_at, now);
    }

    #[test]
    fn occurrence_beyond_grace_is_final_skipped_and_retention_is_applied() {
        let mut connection = connection();
        insert_automation(&mut connection, &interval_record("beyond-grace", MINUTE, 1));
        {
            let transaction = connection.transaction().unwrap();
            for run_number in 1..=100 {
                AutomationStore::insert_run(
                    &transaction,
                    &completed_run("beyond-grace", run_number),
                )
                .unwrap();
            }
            transaction.commit().unwrap();
        }
        let now = 3 * MINUTE + 1;
        let record = AutomationStore::due(&connection, now).unwrap().remove(0);

        let transaction = connection.transaction().unwrap();
        let claim = AutomationStore::claim_due(&transaction, &record, now).unwrap();
        transaction.commit().unwrap();

        assert_eq!(claim.run_number, 101);
        assert_eq!(claim.status, "skipped_missed");
        assert_eq!(claim.finished_at, Some(now));
        assert!(claim
            .error
            .as_deref()
            .unwrap()
            .contains("beyond the configured grace"));
        let retained = AutomationStore::runs(&connection, "beyond-grace", 500).unwrap();
        assert_eq!(retained.len(), 100);
        assert!(retained.iter().all(|run| run.run_number != 1));
        let source = AutomationStore::get(&connection, "beyond-grace").unwrap();
        assert_eq!(source.last_run_at, Some(MINUTE));
        assert_eq!(source.next_run_at, Some(4 * MINUTE));
    }

    #[test]
    fn multiple_missed_intervals_collapse_to_one_catch_up() {
        let mut connection = connection();
        insert_automation(&mut connection, &interval_record("collapsed", MINUTE, 720));
        let now = 5 * MINUTE + 1;
        let record = AutomationStore::due(&connection, now).unwrap().remove(0);

        let transaction = connection.transaction().unwrap();
        let claim = AutomationStore::claim_due(&transaction, &record, now).unwrap();
        transaction.commit().unwrap();

        assert_eq!(claim.scheduled_for, MINUTE);
        assert_eq!(claim.status, "pending");
        assert_eq!(
            AutomationStore::runs(&connection, "collapsed", 10)
                .unwrap()
                .len(),
            1
        );
        assert!(AutomationStore::due(&connection, now).unwrap().is_empty());
        assert_eq!(
            AutomationStore::get(&connection, "collapsed")
                .unwrap()
                .next_run_at,
            Some(6 * MINUTE)
        );
    }

    #[test]
    fn one_time_schedule_is_exhausted_after_claim() {
        let mut connection = connection();
        let mut record = interval_record("once", MINUTE, 720);
        record.schedule_kind = "once".into();
        record.schedule_value = "1970-01-01T00:01:00Z".into();
        record.dtstart = None;
        insert_automation(&mut connection, &record);
        let due = AutomationStore::due(&connection, MINUTE).unwrap().remove(0);

        let transaction = connection.transaction().unwrap();
        AutomationStore::claim_due(&transaction, &due, MINUTE).unwrap();
        transaction.commit().unwrap();

        let source = AutomationStore::get(&connection, "once").unwrap();
        assert_eq!(source.last_run_at, Some(MINUTE));
        assert_eq!(source.next_run_at, None);
        assert!(AutomationStore::due(&connection, u64::MAX / 2)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn manual_run_preserves_schedule_and_blocks_overlap_until_final() {
        let mut connection = connection();
        insert_automation(&mut connection, &interval_record("manual", MINUTE, 720));
        let before = AutomationStore::get(&connection, "manual").unwrap();
        let transaction = connection.transaction().unwrap();
        let manual = AutomationRunRecord {
            id: "manual-run".into(),
            automation_id: "manual".into(),
            run_number: AutomationStore::next_run_number(&transaction, "manual").unwrap(),
            trigger: "manual".into(),
            scheduled_for: MINUTE / 2,
            status: "pending".into(),
            runtime_identity: None,
            worktree: None,
            precheck_result: None,
            output_snapshot: None,
            usage: None,
            error: None,
            started_at: None,
            finished_at: None,
            created_at: MINUTE / 2,
        };
        AutomationStore::insert_run(&transaction, &manual).unwrap();
        transaction.commit().unwrap();

        let after_manual = AutomationStore::get(&connection, "manual").unwrap();
        assert_eq!(after_manual.next_run_at, before.next_run_at);
        assert_eq!(after_manual.last_run_at, before.last_run_at);
        assert_eq!(after_manual.updated_at, before.updated_at);

        let due = AutomationStore::due(&connection, MINUTE).unwrap().remove(0);
        let transaction = connection.transaction().unwrap();
        let error = AutomationStore::claim_due(&transaction, &due, MINUTE)
            .expect_err("scheduled occurrence must wait for the manual run");
        assert!(error.to_string().contains("already has active run"));
        transaction.commit().unwrap();

        let transaction = connection.transaction().unwrap();
        let mut completed = manual;
        completed.status = "completed".into();
        completed.finished_at = Some(MINUTE);
        AutomationStore::save_run_if_status(&transaction, &completed, "pending").unwrap();
        transaction.commit().unwrap();

        let transaction = connection.transaction().unwrap();
        let scheduled = AutomationStore::claim_due(&transaction, &due, MINUTE).unwrap();
        transaction.commit().unwrap();
        assert_eq!(scheduled.run_number, 2);
    }
}

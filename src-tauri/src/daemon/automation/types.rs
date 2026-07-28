use rusqlite::{types::Type, Row};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::io;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPrecheck {
    pub command: Option<String>,
    pub timeout_seconds: u32,
    pub require_workspace: bool,
    pub require_git: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationSource {
    pub provider: String,
    pub source_id: String,
    pub source_hash: String,
    pub snapshot: Value,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRuntimeIdentity {
    pub pid: u32,
    pub process_start_time: u64,
    pub generation: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunWorktree {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub instance_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub path: String,
    pub branch: String,
    pub base_revision: String,
    pub disposition: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationPrecheckResult {
    pub ok: bool,
    pub command: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub exit_code: Option<i32>,
    pub timed_out: bool,
    pub duration_ms: u64,
    pub truncated: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationOutputSnapshot {
    pub final_response: Option<String>,
    pub stdout: String,
    pub stderr: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRecord {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub prompt: String,
    pub agent: String,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub use_current_hermes_default: bool,
    pub toolsets: Vec<String>,
    pub skills: Vec<String>,
    pub max_turns: u32,
    pub timeout_seconds: u32,
    pub schedule_kind: String,
    pub schedule_value: String,
    pub timezone: String,
    pub dtstart: Option<u64>,
    pub next_run_at: Option<u64>,
    pub last_run_at: Option<u64>,
    pub enabled: bool,
    pub requires_review: bool,
    pub missed_run_grace_minutes: u32,
    pub missed_run_policy: String,
    pub workspace_mode: String,
    pub worktree_storage: Value,
    pub base_ref: Option<String>,
    pub precheck: AutomationPrecheck,
    pub source: Option<AutomationSource>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRunRecord {
    pub id: String,
    pub automation_id: String,
    pub run_number: u64,
    pub trigger: String,
    pub scheduled_for: u64,
    pub status: String,
    pub runtime_identity: Option<AutomationRuntimeIdentity>,
    pub worktree: Option<AutomationRunWorktree>,
    pub precheck_result: Option<AutomationPrecheckResult>,
    pub output_snapshot: Option<AutomationOutputSnapshot>,
    pub usage: Option<Value>,
    pub error: Option<String>,
    pub started_at: Option<u64>,
    pub finished_at: Option<u64>,
    pub created_at: u64,
}

pub fn is_final_status(status: &str) -> bool {
    matches!(
        status,
        "completed"
            | "skipped_precheck"
            | "skipped_missed"
            | "skipped_unavailable"
            | "skipped_needs_interactive_auth"
            | "dispatch_failed"
            | "cancelled"
    )
}

pub fn is_active_status(status: &str) -> bool {
    matches!(status, "pending" | "dispatching" | "dispatched")
}

pub fn read_automation(row: &Row<'_>) -> rusqlite::Result<AutomationRecord> {
    let source_provider = row.get::<_, Option<String>>(26)?;
    let source_id = row.get::<_, Option<String>>(27)?;
    let source_hash = row.get::<_, Option<String>>(28)?;
    let source_snapshot = row.get::<_, Option<String>>(29)?;

    Ok(AutomationRecord {
        id: row.get(0)?,
        session_id: row.get(1)?,
        name: row.get(2)?,
        prompt: row.get(3)?,
        agent: row.get(4)?,
        provider: row.get(5)?,
        model: row.get(6)?,
        use_current_hermes_default: read_bool(row, 7)?,
        toolsets: read_json(row, 8, "automation toolsets")?,
        skills: read_json(row, 9, "automation skills")?,
        max_turns: read_u32(row, 10, "automation max turns")?,
        timeout_seconds: read_u32(row, 11, "automation timeout seconds")?,
        schedule_kind: row.get(12)?,
        schedule_value: row.get(13)?,
        timezone: row.get(14)?,
        dtstart: read_optional_u64(row, 15, "automation dtstart")?,
        next_run_at: read_optional_u64(row, 16, "automation next run time")?,
        last_run_at: read_optional_u64(row, 17, "automation last run time")?,
        enabled: read_bool(row, 18)?,
        requires_review: read_bool(row, 19)?,
        missed_run_grace_minutes: read_u32(row, 20, "automation missed-run grace")?,
        missed_run_policy: row.get(21)?,
        workspace_mode: row.get(22)?,
        worktree_storage: read_json(row, 23, "automation worktree storage")?,
        base_ref: row.get(24)?,
        precheck: read_json(row, 25, "automation precheck")?,
        source: decode_source(source_provider, source_id, source_hash, source_snapshot)?,
        created_at: read_u64(row, 30, "automation creation time")?,
        updated_at: read_u64(row, 31, "automation update time")?,
    })
}

pub fn read_run(row: &Row<'_>) -> rusqlite::Result<AutomationRunRecord> {
    Ok(AutomationRunRecord {
        id: row.get(0)?,
        automation_id: row.get(1)?,
        run_number: read_u64(row, 2, "automation run number")?,
        trigger: row.get(3)?,
        scheduled_for: read_u64(row, 4, "automation scheduled time")?,
        status: row.get(5)?,
        runtime_identity: read_optional_json(row, 6, "automation runtime identity")?,
        worktree: read_optional_json(row, 7, "automation run worktree")?,
        precheck_result: read_optional_json(row, 8, "automation precheck result")?,
        output_snapshot: read_optional_json(row, 9, "automation output snapshot")?,
        usage: read_optional_json(row, 10, "automation usage")?,
        error: row.get(11)?,
        started_at: read_optional_u64(row, 12, "automation run start time")?,
        finished_at: read_optional_u64(row, 13, "automation run finish time")?,
        created_at: read_u64(row, 14, "automation run creation time")?,
    })
}

fn read_bool(row: &Row<'_>, index: usize) -> rusqlite::Result<bool> {
    Ok(row.get::<_, i64>(index)? != 0)
}

fn read_u32(row: &Row<'_>, index: usize, label: &str) -> rusqlite::Result<u32> {
    let value = row.get::<_, i64>(index)?;
    u32::try_from(value).map_err(|_| integer_conversion_error(index, label, value))
}

fn read_u64(row: &Row<'_>, index: usize, label: &str) -> rusqlite::Result<u64> {
    let value = row.get::<_, i64>(index)?;
    u64::try_from(value).map_err(|_| integer_conversion_error(index, label, value))
}

fn read_optional_u64(row: &Row<'_>, index: usize, label: &str) -> rusqlite::Result<Option<u64>> {
    row.get::<_, Option<i64>>(index)?
        .map(|value| {
            u64::try_from(value).map_err(|_| integer_conversion_error(index, label, value))
        })
        .transpose()
}

fn read_json<T: DeserializeOwned>(row: &Row<'_>, index: usize, label: &str) -> rusqlite::Result<T> {
    let json = row.get::<_, String>(index)?;
    decode_json(index, label, &json)
}

fn read_optional_json<T: DeserializeOwned>(
    row: &Row<'_>,
    index: usize,
    label: &str,
) -> rusqlite::Result<Option<T>> {
    row.get::<_, Option<String>>(index)?
        .map(|json| decode_json(index, label, &json))
        .transpose()
}

fn decode_json<T: DeserializeOwned>(index: usize, label: &str, json: &str) -> rusqlite::Result<T> {
    serde_json::from_str(json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            Type::Text,
            Box::new(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("decode {label}: {error}"),
            )),
        )
    })
}

fn decode_source(
    provider: Option<String>,
    source_id: Option<String>,
    source_hash: Option<String>,
    snapshot_json: Option<String>,
) -> rusqlite::Result<Option<AutomationSource>> {
    match (provider, source_id, source_hash, snapshot_json) {
        (None, None, None, None) => Ok(None),
        (Some(provider), Some(source_id), Some(source_hash), Some(snapshot_json)) => {
            Ok(Some(AutomationSource {
                provider,
                source_id,
                source_hash,
                snapshot: decode_json(29, "automation source snapshot", &snapshot_json)?,
            }))
        }
        _ => Err(rusqlite::Error::FromSqlConversionFailure(
            26,
            Type::Text,
            Box::new(io::Error::new(
                io::ErrorKind::InvalidData,
                "automation source columns must be all present or all null",
            )),
        )),
    }
}

fn integer_conversion_error(index: usize, label: &str, value: i64) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(
        index,
        Type::Integer,
        Box::new(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("{label} is outside its nonnegative integer range: {value}"),
        )),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn statuses_have_disjoint_complete_partitions() {
        for status in ["pending", "dispatching", "dispatched"] {
            assert!(is_active_status(status));
            assert!(!is_final_status(status));
        }
        for status in [
            "completed",
            "skipped_precheck",
            "skipped_missed",
            "skipped_unavailable",
            "skipped_needs_interactive_auth",
            "dispatch_failed",
            "cancelled",
        ] {
            assert!(is_final_status(status));
            assert!(!is_active_status(status));
        }
        assert!(!is_active_status("unknown"));
        assert!(!is_final_status("unknown"));
    }

    #[test]
    fn source_decode_requires_a_complete_quadruple() {
        let source = decode_source(
            Some("hermes".into()),
            Some("job-1".into()),
            Some("sha256".into()),
            Some(r#"{"name":"nightly"}"#.into()),
        )
        .expect("complete source")
        .expect("source present");
        assert_eq!(source.snapshot, json!({ "name": "nightly" }));
        assert!(decode_source(Some("hermes".into()), None, None, None).is_err());
        assert_eq!(decode_source(None, None, None, None).unwrap(), None);
    }
}

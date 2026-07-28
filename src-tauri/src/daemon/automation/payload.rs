use super::types::*;
use crate::worktree_storage::{WorktreeStorage, WorktreeStorageMode, DEFAULT_WORKTREE_FOLDER};
use anyhow::{bail, Result};
use serde_json::{json, Map, Value};
use std::path::Path;

const DEFAULT_MAX_TURNS: u32 = 50;
const DEFAULT_TIMEOUT_SECONDS: u32 = 1_800;
const DEFAULT_MISSED_RUN_GRACE_MINUTES: u32 = 720;
const DEFAULT_PRECHECK_TIMEOUT_SECONDS: u32 = 60;
const MISSED_RUN_POLICY: &str = "run_once_within_grace";

pub fn parse_create(
    session_id: &str,
    payload: &Value,
    now: u64,
    id: impl Into<String>,
) -> Result<AutomationRecord> {
    let object = payload_object(payload)?;
    reject_legacy(object)?;

    let agent = optional_string(object, "agent")?.unwrap_or_else(|| "hermes".to_string());
    validate_agent(&agent)?;
    let schedule_kind = required_string(object, "scheduleKind")?;
    validate_schedule_kind(&schedule_kind)?;
    let workspace_mode =
        optional_string(object, "workspaceMode")?.unwrap_or_else(|| "new_per_run".to_string());
    validate_workspace_mode(&workspace_mode)?;
    let missed_run_policy = optional_string(object, "missedRunPolicy")?
        .unwrap_or_else(|| MISSED_RUN_POLICY.to_string());
    validate_missed_run_policy(&missed_run_policy)?;

    Ok(AutomationRecord {
        id: id.into(),
        session_id: session_id.to_string(),
        name: required_string(object, "name")?,
        prompt: required_string(object, "prompt")?,
        agent,
        provider: nullable_string(object, "provider")?.unwrap_or(None),
        model: nullable_string(object, "model")?.unwrap_or(None),
        use_current_hermes_default: optional_bool(object, "useCurrentHermesDefault")?
            .unwrap_or(true),
        toolsets: optional_string_array(object, "toolsets")?
            .unwrap_or_else(|| vec!["hermes-acp".to_string()]),
        skills: optional_string_array(object, "skills")?.unwrap_or_default(),
        max_turns: bounded_u32(object, "maxTurns", 1, 500)?.unwrap_or(DEFAULT_MAX_TURNS),
        timeout_seconds: bounded_u32(object, "timeoutSeconds", 1, 86_400)?
            .unwrap_or(DEFAULT_TIMEOUT_SECONDS),
        schedule_kind,
        schedule_value: required_string(object, "scheduleValue")?,
        timezone: required_string(object, "timezone")?,
        dtstart: optional_u64(object, "dtstart")?.unwrap_or(None),
        next_run_at: None,
        last_run_at: None,
        enabled: optional_bool(object, "enabled")?.unwrap_or(true),
        requires_review: optional_bool(object, "requiresReview")?.unwrap_or(false),
        missed_run_grace_minutes: bounded_u32(object, "missedRunGraceMinutes", 0, 10_080)?
            .unwrap_or(DEFAULT_MISSED_RUN_GRACE_MINUTES),
        missed_run_policy,
        workspace_mode,
        worktree_storage: parse_worktree_storage(object.get("worktreeStorage"))?,
        base_ref: nullable_nonblank_string(object, "baseRef")?.unwrap_or(None),
        precheck: parse_precheck(object.get("precheck"), None)?,
        source: parse_source(object.get("source"))?.unwrap_or(None),
        created_at: now,
        updated_at: now,
    })
}

pub fn apply_patch(
    existing: &AutomationRecord,
    payload: &Value,
    now: u64,
) -> Result<AutomationRecord> {
    let object = payload_object(payload)?;
    reject_legacy(object)?;
    let mut record = existing.clone();
    record.worktree_storage = parse_worktree_storage(Some(&record.worktree_storage))?;

    if object.contains_key("name") {
        record.name = required_string(object, "name")?;
    }
    if object.contains_key("prompt") {
        record.prompt = required_string(object, "prompt")?;
    }
    if let Some(agent) = optional_string(object, "agent")? {
        validate_agent(&agent)?;
        record.agent = agent;
    }
    if let Some(provider) = nullable_string(object, "provider")? {
        record.provider = provider;
    }
    if let Some(model) = nullable_string(object, "model")? {
        record.model = model;
    }
    if let Some(value) = optional_bool(object, "useCurrentHermesDefault")? {
        record.use_current_hermes_default = value;
    }
    if let Some(value) = optional_string_array(object, "toolsets")? {
        record.toolsets = value;
    }
    if let Some(value) = optional_string_array(object, "skills")? {
        record.skills = value;
    }
    if let Some(value) = bounded_u32(object, "maxTurns", 1, 500)? {
        record.max_turns = value;
    }
    if let Some(value) = bounded_u32(object, "timeoutSeconds", 1, 86_400)? {
        record.timeout_seconds = value;
    }
    if let Some(value) = optional_string(object, "scheduleKind")? {
        validate_schedule_kind(&value)?;
        record.schedule_kind = value;
    }
    if object.contains_key("scheduleValue") {
        record.schedule_value = required_string(object, "scheduleValue")?;
    }
    if object.contains_key("timezone") {
        record.timezone = required_string(object, "timezone")?;
    }
    if let Some(value) = optional_u64(object, "dtstart")? {
        record.dtstart = value;
    }
    if let Some(value) = optional_bool(object, "enabled")? {
        record.enabled = value;
    }
    if let Some(value) = optional_bool(object, "requiresReview")? {
        record.requires_review = value;
    }
    if let Some(value) = bounded_u32(object, "missedRunGraceMinutes", 0, 10_080)? {
        record.missed_run_grace_minutes = value;
    }
    if let Some(value) = optional_string(object, "missedRunPolicy")? {
        validate_missed_run_policy(&value)?;
        record.missed_run_policy = value;
    }
    if let Some(value) = optional_string(object, "workspaceMode")? {
        validate_workspace_mode(&value)?;
        record.workspace_mode = value;
    }
    if let Some(value) = object.get("worktreeStorage") {
        record.worktree_storage = parse_worktree_storage(Some(value))?;
    }
    if let Some(value) = nullable_nonblank_string(object, "baseRef")? {
        record.base_ref = value;
    }
    if object.contains_key("precheck") {
        record.precheck = parse_precheck(object.get("precheck"), Some(&record.precheck))?;
    }
    if let Some(value) = parse_source(object.get("source"))? {
        record.source = value;
    }

    record.updated_at = now;
    Ok(record)
}

fn payload_object(payload: &Value) -> Result<&Map<String, Value>> {
    payload
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("automation payload must be an object"))
}

fn reject_legacy(object: &Map<String, Value>) -> Result<()> {
    if object.contains_key("goal") {
        bail!("legacy automation field 'goal' is not supported; use 'prompt'");
    }
    if object.contains_key("policy") {
        bail!("legacy automation field 'policy' is not supported");
    }
    Ok(())
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String> {
    let value = object
        .get(key)
        .ok_or_else(|| anyhow::anyhow!("automation field '{key}' is required"))?;
    let value = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("automation field '{key}' must be a string"))?
        .trim();
    if value.is_empty() {
        bail!("automation field '{key}' must not be blank");
    }
    Ok(value.to_string())
}

fn optional_string(object: &Map<String, Value>, key: &str) -> Result<Option<String>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let value = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("automation field '{key}' must be a string"))?
        .trim();
    if value.is_empty() {
        bail!("automation field '{key}' must not be blank");
    }
    Ok(Some(value.to_string()))
}

fn nullable_string(object: &Map<String, Value>, key: &str) -> Result<Option<Option<String>>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(None));
    }
    let value = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("automation field '{key}' must be a string or null"))?;
    Ok(Some(Some(value.trim().to_string())))
}

fn optional_bool(object: &Map<String, Value>, key: &str) -> Result<Option<bool>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    value
        .as_bool()
        .map(Some)
        .ok_or_else(|| anyhow::anyhow!("automation field '{key}' must be a boolean"))
}

fn bounded_u32(
    object: &Map<String, Value>,
    key: &str,
    minimum: u32,
    maximum: u32,
) -> Result<Option<u32>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let number = value
        .as_u64()
        .and_then(|value| u32::try_from(value).ok())
        .ok_or_else(|| anyhow::anyhow!("automation field '{key}' must be an integer"))?;
    if !(minimum..=maximum).contains(&number) {
        bail!("automation field '{key}' must be between {minimum} and {maximum}");
    }
    Ok(Some(number))
}

fn optional_u64(object: &Map<String, Value>, key: &str) -> Result<Option<Option<u64>>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(None));
    }
    value
        .as_u64()
        .map(|value| Some(Some(value)))
        .ok_or_else(|| {
            anyhow::anyhow!("automation field '{key}' must be a non-negative integer or null")
        })
}

fn optional_string_array(object: &Map<String, Value>, key: &str) -> Result<Option<Vec<String>>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("automation field '{key}' must be an array"))?;
    let mut parsed = Vec::with_capacity(values.len());
    for value in values {
        let value = value
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("automation field '{key}' must contain only strings"))?
            .trim();
        if value.is_empty() {
            bail!("automation field '{key}' must contain only nonblank strings");
        }
        parsed.push(value.to_string());
    }
    Ok(Some(parsed))
}

fn nullable_nonblank_string(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Option<Option<String>>> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(None));
    }
    let value = value
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("automation field '{key}' must be a string or null"))?
        .trim();
    if value.is_empty() {
        bail!("automation field '{key}' must not be blank");
    }
    Ok(Some(Some(value.to_string())))
}

fn parse_worktree_storage(value: Option<&Value>) -> Result<Value> {
    const FIELDS: [&str; 5] = [
        "mode",
        "drive",
        "folderName",
        "customRoot",
        "groupByRepository",
    ];

    let mut object = match value {
        Some(value) => value.as_object().cloned().ok_or_else(|| {
            anyhow::anyhow!("automation field 'worktreeStorage' must be an object")
        })?,
        None => Map::new(),
    };
    if let Some(field) = object
        .keys()
        .find(|field| !FIELDS.contains(&field.as_str()))
    {
        bail!("automation field 'worktreeStorage' contains unsupported field '{field}'");
    }
    object.entry("mode").or_insert_with(|| json!("appData"));

    let mut storage: WorktreeStorage =
        serde_json::from_value(Value::Object(object)).map_err(|error| {
            anyhow::anyhow!("automation field 'worktreeStorage' is invalid: {error}")
        })?;
    storage.drive = storage.drive.trim().to_ascii_uppercase();
    if !storage.drive.is_empty()
        && (storage.drive.len() != 2
            || !storage.drive.ends_with(':')
            || !storage.drive.as_bytes()[0].is_ascii_alphabetic())
    {
        bail!("automation worktree storage drive must be a single drive letter");
    }

    storage.folder_name = storage.folder_name.trim().to_string();
    if storage.folder_name.is_empty() {
        storage.folder_name = DEFAULT_WORKTREE_FOLDER.to_string();
    } else if storage.folder_name.contains(['/', '\\']) || storage.folder_name.contains("..") {
        bail!("automation worktree storage folderName must be a single folder");
    }

    storage.custom_root = storage.custom_root.trim().to_string();
    if storage.mode == WorktreeStorageMode::Custom {
        if storage.custom_root.is_empty() {
            bail!("automation custom worktree storage requires customRoot");
        }
        if !Path::new(&storage.custom_root).is_absolute() {
            bail!("automation custom worktree storage customRoot must be an absolute path");
        }
    }

    serde_json::to_value(storage)
        .map_err(|error| anyhow::anyhow!("serialize automation worktree storage: {error}"))
}

fn parse_precheck(
    value: Option<&Value>,
    existing: Option<&AutomationPrecheck>,
) -> Result<AutomationPrecheck> {
    let mut parsed = existing.cloned().unwrap_or(AutomationPrecheck {
        command: None,
        timeout_seconds: DEFAULT_PRECHECK_TIMEOUT_SECONDS,
        require_workspace: true,
        require_git: false,
    });
    let Some(value) = value else {
        return Ok(parsed);
    };
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("automation field 'precheck' must be an object"))?;

    if let Some(value) = object.get("command") {
        parsed.command = if value.is_null() {
            None
        } else {
            let command = value
                .as_str()
                .ok_or_else(|| {
                    anyhow::anyhow!("automation precheck command must be a string or null")
                })?
                .trim();
            if command.is_empty() {
                None
            } else {
                Some(command.to_string())
            }
        };
    }
    if let Some(value) = bounded_u32(object, "timeoutSeconds", 1, 600)? {
        parsed.timeout_seconds = value;
    }
    if let Some(value) = optional_bool(object, "requireWorkspace")? {
        parsed.require_workspace = value;
    }
    if let Some(value) = optional_bool(object, "requireGit")? {
        parsed.require_git = value;
    }
    Ok(parsed)
}

fn parse_source(value: Option<&Value>) -> Result<Option<Option<AutomationSource>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(Some(None));
    }
    let object = value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("automation field 'source' must be an object or null"))?;
    let provider = required_string(object, "provider")?;
    if provider != "hermes" {
        bail!("automation source provider must be 'hermes'");
    }
    let source_id = required_string(object, "sourceId")?;
    let source_hash = required_string(object, "sourceHash")?;
    let snapshot = object
        .get("snapshot")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("automation source field 'snapshot' is required"))?;
    Ok(Some(Some(AutomationSource {
        provider,
        source_id,
        source_hash,
        snapshot,
    })))
}

fn validate_agent(agent: &str) -> Result<()> {
    if agent != "hermes" {
        bail!("automation agent must be 'hermes'");
    }
    Ok(())
}

fn validate_schedule_kind(kind: &str) -> Result<()> {
    if !matches!(
        kind,
        "once" | "interval" | "hourly" | "daily" | "weekdays" | "weekly" | "cron"
    ) {
        bail!("unsupported automation schedule kind '{kind}'");
    }
    Ok(())
}

fn validate_workspace_mode(mode: &str) -> Result<()> {
    if !matches!(mode, "new_per_run" | "existing") {
        if matches!(mode, "reuse" | "worktree") {
            bail!("legacy automation workspace mode '{mode}' is not supported");
        }
        bail!("unsupported automation workspace mode '{mode}'");
    }
    Ok(())
}

fn validate_missed_run_policy(policy: &str) -> Result<()> {
    if policy != MISSED_RUN_POLICY {
        bail!("automation missed run policy must be '{MISSED_RUN_POLICY}'");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn minimal_payload() -> Value {
        json!({
            "name": "Daily audit",
            "prompt": "Audit dependencies",
            "scheduleKind": "daily",
            "scheduleValue": "09:00",
            "timezone": "UTC"
        })
    }

    #[test]
    fn create_applies_canonical_defaults() {
        let record = parse_create("session-a", &minimal_payload(), 100, "automation-a")
            .expect("parse create");
        assert_eq!(record.agent, "hermes");
        assert_eq!(record.toolsets, vec!["hermes-acp"]);
        assert!(record.skills.is_empty());
        assert_eq!(record.max_turns, 50);
        assert_eq!(record.timeout_seconds, 1_800);
        assert!(record.use_current_hermes_default);
        assert!(record.enabled);
        assert!(!record.requires_review);
        assert_eq!(record.missed_run_grace_minutes, 720);
        assert_eq!(record.missed_run_policy, "run_once_within_grace");
        assert_eq!(record.workspace_mode, "new_per_run");
        assert_eq!(
            record.worktree_storage,
            json!({
                "mode": "appData",
                "drive": "",
                "folderName": "VibeLinkWorktrees",
                "customRoot": "",
                "groupByRepository": true
            })
        );
        assert_eq!(record.base_ref, None);
        assert_eq!(record.precheck.command, None);
        assert_eq!(record.precheck.timeout_seconds, 60);
        assert!(record.precheck.require_workspace);
        assert!(!record.precheck.require_git);
        assert_eq!(record.created_at, 100);
        assert_eq!(record.updated_at, 100);
    }

    #[test]
    fn accepts_supported_worktree_storage_choices() {
        let custom_root = std::env::temp_dir().join("vibelink-automation-worktrees");
        for storage in [
            json!({"mode":"drive","drive":"E:","folderName":"TeamWorktrees","customRoot":"","groupByRepository":false}),
            json!({"mode":"appData","drive":"","folderName":"VibeLinkWorktrees","customRoot":"","groupByRepository":true}),
            json!({"mode":"custom","drive":"","folderName":"VibeLinkWorktrees","customRoot":custom_root,"groupByRepository":true}),
        ] {
            let mut payload = minimal_payload();
            payload["worktreeStorage"] = storage.clone();
            let record = parse_create("session-a", &payload, 100, "automation-a")
                .expect("parse supported storage");
            assert_eq!(record.worktree_storage, storage);
        }
    }

    #[test]
    fn existing_workspace_mode_accepts_only_canonical_storage_metadata() {
        let mut payload = minimal_payload();
        payload["workspaceMode"] = json!("existing");
        payload["worktreeStorage"] = json!({"mode":"drive"});
        let record = parse_create("session-a", &payload, 100, "automation-a")
            .expect("parse existing workspace mode");
        assert_eq!(record.workspace_mode, "existing");
        assert_eq!(record.worktree_storage["mode"], "drive");
        assert_eq!(record.worktree_storage["folderName"], "VibeLinkWorktrees");
    }

    #[test]
    fn base_ref_accepts_null_or_nonblank_strings_and_rejects_blank_values() {
        let mut payload = minimal_payload();
        payload["baseRef"] = json!("  release/next  ");
        let record = parse_create("session-a", &payload, 100, "automation-a")
            .expect("parse nonblank base ref");
        assert_eq!(record.base_ref.as_deref(), Some("release/next"));

        payload["baseRef"] = Value::Null;
        assert_eq!(
            parse_create("session-a", &payload, 100, "automation-a")
                .expect("parse null base ref")
                .base_ref,
            None
        );

        payload["baseRef"] = json!("   ");
        assert!(parse_create("session-a", &payload, 100, "automation-a").is_err());
        let existing = parse_create("session-a", &minimal_payload(), 100, "automation-a")
            .expect("parse existing");
        assert!(apply_patch(&existing, &json!({"baseRef":"  "}), 200).is_err());
    }

    #[test]
    fn rejects_malformed_unknown_or_unsafe_worktree_storage() {
        for storage in [
            json!([]),
            json!({"mode":"absolute","path":"C:/unsafe"}),
            json!({"mode":"appData","path":"C:/unsafe"}),
            json!({"mode":"drive","drive":"EE:"}),
            json!({"mode":"drive","folderName":"../outside"}),
            json!({"mode":"custom","customRoot":"relative/path"}),
            json!({"mode":"custom","customRoot":""}),
            json!({"mode":"drive","groupByRepository":"yes"}),
        ] {
            let mut payload = minimal_payload();
            payload["worktreeStorage"] = storage;
            assert!(parse_create("session-a", &payload, 100, "automation-a").is_err());
        }
    }

    #[test]
    fn patch_preserves_omitted_fields_and_merges_precheck() {
        let existing = parse_create("session-a", &minimal_payload(), 100, "automation-a")
            .expect("parse create");
        let patched = apply_patch(
            &existing,
            &json!({"name":"Renamed", "precheck":{"requireGit":true}}),
            200,
        )
        .expect("apply patch");
        assert_eq!(patched.name, "Renamed");
        assert_eq!(patched.prompt, existing.prompt);
        assert_eq!(patched.schedule_kind, existing.schedule_kind);
        assert_eq!(patched.precheck.timeout_seconds, 60);
        assert!(patched.precheck.require_workspace);
        assert!(patched.precheck.require_git);
        assert_eq!(patched.created_at, 100);
        assert_eq!(patched.updated_at, 200);
    }

    #[test]
    fn rejects_legacy_modes_and_fields() {
        for payload in [json!({"goal":"legacy"}), json!({"policy":{}})] {
            assert!(apply_patch(
                &parse_create("session-a", &minimal_payload(), 100, "automation-a")
                    .expect("parse create"),
                &payload,
                200
            )
            .is_err());
        }

        for mode in ["reuse", "worktree"] {
            let mut create_payload = minimal_payload();
            create_payload["workspaceMode"] = json!(mode);
            assert!(parse_create("session-a", &create_payload, 100, "automation-a").is_err());
            let existing = parse_create("session-a", &minimal_payload(), 100, "automation-a")
                .expect("parse create");
            assert!(apply_patch(&existing, &json!({"workspaceMode":mode}), 200).is_err());
        }
    }

    #[test]
    fn rejects_invalid_agent_and_incomplete_source() {
        let mut invalid_agent = minimal_payload();
        invalid_agent["agent"] = json!("openclaw");
        assert!(parse_create("session-a", &invalid_agent, 100, "automation-a").is_err());

        let mut incomplete_source = minimal_payload();
        incomplete_source["source"] = json!({
            "provider":"hermes",
            "sourceId":"job-a",
            "snapshot":{}
        });
        assert!(parse_create("session-a", &incomplete_source, 100, "automation-a").is_err());

        let mut invalid_source_provider = minimal_payload();
        invalid_source_provider["source"] = json!({
            "provider":"other",
            "sourceId":"job-a",
            "sourceHash":"hash-a",
            "snapshot":{}
        });
        assert!(parse_create("session-a", &invalid_source_provider, 100, "automation-a").is_err());
    }

    #[test]
    fn rejects_numeric_bounds() {
        for (field, value) in [
            ("maxTurns", json!(0)),
            ("maxTurns", json!(501)),
            ("timeoutSeconds", json!(0)),
            ("timeoutSeconds", json!(86_401)),
            ("missedRunGraceMinutes", json!(10_081)),
        ] {
            let mut payload = minimal_payload();
            payload[field] = value;
            assert!(parse_create("session-a", &payload, 100, "automation-a").is_err());
        }

        let mut precheck = minimal_payload();
        precheck["precheck"] = json!({"timeoutSeconds":601});
        assert!(parse_create("session-a", &precheck, 100, "automation-a").is_err());
    }
    #[test]
    fn validates_skills_accepts_nonblank_and_rejects_blank_entries() {
        let mut valid_payload = minimal_payload();
        valid_payload["skills"] = json!([" review ", "qa"]);
        let record = parse_create("session-a", &valid_payload, 100, "automation-a")
            .expect("parse create with valid skills");
        assert_eq!(record.skills, vec!["review", "qa"]);

        let mut invalid_payload = minimal_payload();
        invalid_payload["skills"] = json!([" review ", "-blocked", "", "qa"]);
        let err = parse_create("session-a", &invalid_payload, 100, "automation-a")
            .expect_err("should reject blank skill entry");
        assert!(
            err.to_string()
                .contains("automation field 'skills' must contain only nonblank strings"),
            "unexpected error message: {err}"
        );
    }
}

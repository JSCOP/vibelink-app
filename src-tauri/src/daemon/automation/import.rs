use super::model::AutomationRecord;
use anyhow::{bail, Context, Result};
use chrono::DateTime;
use chrono_tz::Tz;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    str::FromStr,
};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ImportRequest {
    jobs: Vec<ImportSelection>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportSelection {
    source_id: String,
    source_hash: String,
}

#[derive(Debug)]
pub struct ImportableJob {
    pub source_id: String,
    pub source_hash: String,
    pub payload: Value,
    pub preview: Value,
}

pub struct HermesCronSnapshot {
    pub source_path: PathBuf,
    pub file_hash: String,
    pub jobs: Vec<ImportableJob>,
}

pub fn preview(workspace: &Path, existing: &[AutomationRecord]) -> Result<Value> {
    let snapshot = load(workspace, existing)?;
    Ok(json!({
        "sourcePath": snapshot.source_path.to_string_lossy(),
        "sourceHash": snapshot.file_hash,
        "candidates": snapshot.jobs.into_iter().map(|job| job.preview).collect::<Vec<_>>(),
    }))
}

pub fn selected(
    workspace: &Path,
    payload: &Value,
    existing: &[AutomationRecord],
) -> Result<(Vec<ImportableJob>, Vec<Value>)> {
    let request: ImportRequest =
        serde_json::from_value(payload.clone()).context("invalid Hermes cron import request")?;
    if request.jobs.is_empty() {
        bail!("select at least one Hermes cron job to import");
    }
    let snapshot = load(workspace, existing)?;
    let mut selected = Vec::new();
    let mut skipped = Vec::new();
    for selection in request.jobs {
        let source_id = selection.source_id.trim();
        let source_hash = selection.source_hash.trim();
        if source_id.is_empty() || source_hash.is_empty() {
            bail!("Hermes cron import selection requires sourceId and sourceHash");
        }
        let Some(index) = snapshot
            .jobs
            .iter()
            .position(|job| job.source_id == source_id)
        else {
            skipped.push(json!({"sourceId": source_id, "reason": "job is unavailable, unsupported, or no longer matches this workspace"}));
            continue;
        };
        let job = &snapshot.jobs[index];
        if job.source_hash != source_hash {
            skipped.push(json!({"sourceId": source_id, "reason": "source changed after preview; preview again before importing"}));
            continue;
        }
        if selected
            .iter()
            .any(|candidate: &ImportableJob| candidate.source_id == source_id)
        {
            skipped.push(json!({"sourceId": source_id, "reason": "duplicate selection"}));
            continue;
        }
        selected.push(ImportableJob {
            source_id: job.source_id.clone(),
            source_hash: job.source_hash.clone(),
            payload: job.payload.clone(),
            preview: job.preview.clone(),
        });
    }
    Ok((selected, skipped))
}

fn load(workspace: &Path, existing: &[AutomationRecord]) -> Result<HermesCronSnapshot> {
    let source_path = hermes_home().join("cron").join("jobs.json");
    let bytes = match fs::read(&source_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(HermesCronSnapshot {
                source_path,
                file_hash: sha256(&[]),
                jobs: Vec::new(),
            });
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read Hermes cron jobs {}", source_path.display()));
        }
    };
    let document: Value = serde_json::from_slice(&bytes)
        .with_context(|| format!("parse Hermes cron jobs {}", source_path.display()))?;
    let jobs = match &document {
        Value::Object(object) => object.get("jobs").and_then(Value::as_array),
        Value::Array(jobs) => Some(jobs),
        _ => None,
    }
    .ok_or_else(|| anyhow::anyhow!("Hermes cron jobs file must contain a jobs array"))?;
    let workspace = canonical_workspace(workspace)?;
    let timezone = hermes_timezone();
    let mut candidates = Vec::new();
    for raw in jobs {
        let Some(candidate) = convert_job(raw, &workspace, &timezone, existing)? else {
            continue;
        };
        candidates.push(candidate);
    }
    candidates.sort_by(|left, right| {
        left.preview["name"]
            .as_str()
            .unwrap_or_default()
            .cmp(right.preview["name"].as_str().unwrap_or_default())
            .then_with(|| left.source_id.cmp(&right.source_id))
    });
    Ok(HermesCronSnapshot {
        source_path,
        file_hash: sha256(&bytes),
        jobs: candidates,
    })
}

fn convert_job(
    raw: &Value,
    workspace: &Path,
    timezone: &TimezoneResolution,
    existing: &[AutomationRecord],
) -> Result<Option<ImportableJob>> {
    let Some(job) = raw.as_object() else {
        return Ok(None);
    };
    let source_id = nonblank(job, "id");
    let prompt = nonblank(job, "prompt");
    let workdir = nonblank(job, "workdir");
    if source_id.is_none()
        || prompt.is_none()
        || workdir.is_none()
        || job.get("no_agent").and_then(Value::as_bool) == Some(true)
    {
        return Ok(None);
    }
    let source_id = source_id.expect("checked above");
    let prompt = prompt.expect("checked above");
    let workdir = workdir.expect("checked above");
    let resolved_workdir = match fs::canonicalize(&workdir) {
        Ok(path) => path,
        Err(_) => return Ok(None),
    };
    if !same_path(&resolved_workdir, workspace) {
        return Ok(None);
    }

    let Some(schedule) = job.get("schedule").and_then(Value::as_object) else {
        return Ok(None);
    };
    let Some((schedule_kind, schedule_value)) = convert_schedule(schedule)? else {
        return Ok(None);
    };
    let source_hash = sha256(&serde_json::to_vec(raw).context("serialize Hermes cron source job")?);
    let name = nonblank(job, "name").unwrap_or_else(|| prompt.chars().take(50).collect());
    let provider = nonblank(job, "provider").or_else(|| nonblank(job, "provider_snapshot"));
    let model = nonblank(job, "model").or_else(|| nonblank(job, "model_snapshot"));
    let toolsets = string_array(job.get("enabled_toolsets"))
        .filter(|values| !values.is_empty())
        .unwrap_or_else(|| vec!["hermes-acp".into()]);
    let skills = string_array(job.get("skills"))
        .or_else(|| nonblank(job, "skill").map(|skill| vec![skill]))
        .unwrap_or_default();
    let mut warnings = vec![
        "Imported jobs are paused and require review before they can run.".to_string(),
        "The original Hermes Cron job remains unchanged.".to_string(),
    ];
    if let Some(warning) = timezone.warning.as_ref() {
        warnings.push(warning.clone());
    }
    if job.get("script").is_some_and(|value| !value.is_null()) {
        warnings.push("Hermes script context is not imported.".into());
    }
    if job
        .get("context_from")
        .is_some_and(|value| !value.is_null())
    {
        warnings.push("Hermes chained job context is not imported.".into());
    }
    if job
        .get("deliver")
        .and_then(Value::as_str)
        .is_some_and(|value| value != "local")
    {
        warnings.push(
            "Hermes delivery routing is not imported; VibeLink uses its notification inbox.".into(),
        );
    }
    let existing_automation_id = existing.iter().find_map(|automation| {
        automation.source.as_ref().and_then(|source| {
            (source.provider == "hermes" && source.source_id == source_id)
                .then(|| automation.id.clone())
        })
    });
    let source = json!({
        "provider": "hermes",
        "sourceId": source_id,
        "sourceHash": source_hash,
        "snapshot": raw,
    });
    let payload = json!({
        "name": name,
        "prompt": prompt,
        "provider": provider,
        "model": model,
        "useCurrentHermesDefault": model.is_none(),
        "toolsets": toolsets,
        "skills": skills,
        "maxTurns": 50,
        "timeoutSeconds": 1800,
        "scheduleKind": schedule_kind,
        "scheduleValue": schedule_value,
        "timezone": timezone.name,
        "enabled": false,
        "requiresReview": true,
        "missedRunGraceMinutes": 720,
        "workspaceMode": "new_per_run",
        "worktreeStorage": {"mode": "appData"},
        "precheck": {"command": null, "timeoutSeconds": 60, "requireWorkspace": true, "requireGit": false},
        "source": source,
    });
    let preview = json!({
        "source": payload["source"].clone(),
        "name": payload["name"].clone(),
        "prompt": payload["prompt"].clone(),
        "scheduleKind": payload["scheduleKind"].clone(),
        "scheduleValue": payload["scheduleValue"].clone(),
        "timezone": payload["timezone"].clone(),
        "provider": payload["provider"].clone(),
        "model": payload["model"].clone(),
        "toolsets": payload["toolsets"].clone(),
        "skills": payload["skills"].clone(),
        "maxTurns": payload["maxTurns"].clone(),
        "timeoutSeconds": payload["timeoutSeconds"].clone(),
        "workdir": workdir,
        "warnings": warnings,
        "existingAutomationId": existing_automation_id,
    });
    Ok(Some(ImportableJob {
        source_id,
        source_hash,
        payload,
        preview,
    }))
}

fn convert_schedule(schedule: &Map<String, Value>) -> Result<Option<(String, String)>> {
    let Some(kind) = nonblank(schedule, "kind") else {
        return Ok(None);
    };
    match kind.as_str() {
        "cron" => Ok(nonblank(schedule, "expr").map(|expr| ("cron".into(), expr))),
        "interval" => {
            let Some(minutes) = schedule.get("minutes").and_then(Value::as_u64) else {
                return Ok(None);
            };
            if minutes == 0 {
                return Ok(None);
            }
            Ok(Some(("interval".into(), format!("{minutes}m"))))
        }
        "once" => {
            let Some(run_at) = nonblank(schedule, "run_at") else {
                return Ok(None);
            };
            let instant = DateTime::parse_from_rfc3339(&run_at)
                .with_context(|| format!("parse Hermes one-shot schedule {run_at}"))?;
            let millis = u64::try_from(instant.timestamp_millis())
                .context("Hermes one-shot schedule precedes Unix epoch")?;
            Ok(Some(("once".into(), millis.to_string())))
        }
        _ => Ok(None),
    }
}

struct TimezoneResolution {
    name: String,
    warning: Option<String>,
}

fn hermes_timezone() -> TimezoneResolution {
    let configured = std::env::var("HERMES_TIMEZONE")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            let text = fs::read_to_string(hermes_home().join("config.yaml")).ok()?;
            let value: serde_yaml::Value = serde_yaml::from_str(&text).ok()?;
            value
                .as_mapping()?
                .get(serde_yaml::Value::from("timezone"))?
                .as_str()
                .map(str::to_string)
        });
    match configured.map(|value| value.trim().to_string()) {
        Some(name) if Tz::from_str(&name).is_ok() => TimezoneResolution {
            name,
            warning: None,
        },
        Some(name) => TimezoneResolution {
            name: "UTC".into(),
            warning: Some(format!(
                "Hermes timezone '{name}' is invalid; review the UTC fallback."
            )),
        },
        None => TimezoneResolution {
            name: "UTC".into(),
            warning: Some(
                "Hermes has no configured IANA timezone; review the UTC fallback.".into(),
            ),
        },
    }
}

fn canonical_workspace(workspace: &Path) -> Result<PathBuf> {
    fs::canonicalize(workspace)
        .with_context(|| format!("resolve current workspace {}", workspace.display()))
}

fn same_path(left: &Path, right: &Path) -> bool {
    #[cfg(windows)]
    {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    }
    #[cfg(not(windows))]
    {
        left == right
    }
}

fn nonblank(object: &Map<String, Value>, key: &str) -> Option<String> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

fn string_array(value: Option<&Value>) -> Option<Vec<String>> {
    let values = value?.as_array()?;
    Some(
        values
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn hermes_home() -> PathBuf {
    if let Some(home) = std::env::var("HERMES_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(home);
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            return PathBuf::from(local_app_data).join("hermes");
        }
        if let Some(user_profile) = std::env::var("USERPROFILE")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            return PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join("hermes");
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(home).join(".hermes");
    }
    PathBuf::from(".hermes")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_hermes_schedule_shapes() {
        assert_eq!(
            convert_schedule(json!({"kind":"interval","minutes":15}).as_object().unwrap()).unwrap(),
            Some(("interval".into(), "15m".into()))
        );
        assert_eq!(
            convert_schedule(
                json!({"kind":"cron","expr":"0 9 * * 1-5"})
                    .as_object()
                    .unwrap()
            )
            .unwrap(),
            Some(("cron".into(), "0 9 * * 1-5".into()))
        );
    }

    #[test]
    fn import_request_rejects_unknown_fields() {
        let error = selected(
            Path::new("missing"),
            &json!({"jobs": [], "deleteSource": true}),
            &[],
        )
        .expect_err("unknown field must fail before source access");
        assert!(error
            .to_string()
            .contains("invalid Hermes cron import request"));
    }
}

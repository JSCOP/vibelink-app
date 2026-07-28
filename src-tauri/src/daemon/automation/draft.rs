use super::schedule;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

const MAX_REQUEST_BYTES: usize = 8 * 1024;
const MAX_NAME_BYTES: usize = 160;
const MAX_PROMPT_BYTES: usize = 32 * 1024;
const MAX_PRECHECK_BYTES: usize = 4 * 1024;
const MAX_NOTES: usize = 12;
const MAX_NOTE_BYTES: usize = 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftRequestPayload {
    request_id: Option<String>,
    request: String,
    current: Option<DraftCurrentValues>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DraftCurrentValues {
    name: String,
    prompt: String,
    schedule: DraftSchedule,
    precheck_command: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct DraftSchedule {
    kind: String,
    value: String,
    timezone: String,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GeneratedDraft {
    name: String,
    prompt: String,
    schedule: DraftSchedule,
    precheck_command: Option<String>,
    notes: Vec<String>,
}

#[derive(Debug)]
pub struct DraftRequest {
    pub request_id: String,
    pub prompt: String,
}

pub fn parse_request(payload: &Value) -> Result<DraftRequest> {
    let payload: DraftRequestPayload =
        serde_json::from_value(payload.clone()).context("invalid Hermes draft request")?;
    let request = required_text("draft request", payload.request, MAX_REQUEST_BYTES)?;
    let request_id = match payload.request_id {
        Some(value) => {
            let value = value.trim();
            Uuid::parse_str(value).context("draft request id must be a UUID")?;
            value.to_string()
        }
        None => Uuid::new_v4().to_string(),
    };
    if let Some(current) = payload.current.as_ref() {
        validate_current(current)?;
    }

    let current = payload
        .current
        .map(|value| serde_json::to_string(&value))
        .transpose()
        .context("serialize current automation values")?
        .unwrap_or_else(|| "null".to_string());
    let prompt = format!(
        "You generate a review-only VibeLink Automation draft. This is data transformation, not task execution. Never create, edit, delete, pause, resume, import, or run automations or cron jobs. Never modify files, repositories, configuration, credentials, sessions, or external systems. Return exactly one JSON object and no markdown, commentary, or code fences. Use this exact schema: {{\"name\":string,\"prompt\":string,\"schedule\":{{\"kind\":\"once\"|\"interval\"|\"hourly\"|\"daily\"|\"weekdays\"|\"weekly\"|\"cron\",\"value\":string,\"timezone\":IANA_timezone}},\"precheckCommand\":string|null,\"notes\":string[]}}. Preserve useful current values unless the request asks to change them. `once` value is Unix epoch milliseconds; `interval` is a positive duration such as `30m`; `hourly` is minute 0-59; `daily` and `weekdays` use HH:MM; `weekly` uses weekday@HH:MM; `cron` uses exactly five fields. Notes must identify assumptions requiring user review.\n\nCurrent values JSON:\n{current}\n\nUser request:\n{request}"
    );
    Ok(DraftRequest { request_id, prompt })
}

pub fn parse_response(request_id: &str, response: &str) -> Result<Value> {
    let mut draft: GeneratedDraft = serde_json::from_str(response.trim())
        .context("Hermes draft response must be one JSON object")?;
    draft.name = required_text("draft name", draft.name, MAX_NAME_BYTES)?;
    draft.prompt = required_text("draft prompt", draft.prompt, MAX_PROMPT_BYTES)?;
    draft.schedule.kind = required_text("draft schedule kind", draft.schedule.kind, 32)?;
    draft.schedule.value = required_text("draft schedule value", draft.schedule.value, 512)?;
    draft.schedule.timezone = required_text("draft timezone", draft.schedule.timezone, 128)?;
    schedule::validate_schedule(
        &draft.schedule.kind,
        &draft.schedule.value,
        &draft.schedule.timezone,
        None,
    )
    .context("invalid generated schedule")?;
    if let Some(command) = draft.precheck_command.take() {
        let command = command.trim();
        draft.precheck_command = if command.is_empty() {
            None
        } else {
            if command.len() > MAX_PRECHECK_BYTES {
                bail!("draft precheck command is too long");
            }
            Some(command.to_string())
        };
    }
    if draft.notes.len() > MAX_NOTES {
        bail!("draft notes must contain at most {MAX_NOTES} entries");
    }
    draft.notes = draft
        .notes
        .into_iter()
        .map(|note| required_text("draft note", note, MAX_NOTE_BYTES))
        .collect::<Result<Vec<_>>>()?;

    let mut value = serde_json::to_value(draft).context("serialize Hermes draft preview")?;
    value
        .as_object_mut()
        .expect("generated draft serializes as an object")
        .insert("requestId".into(), Value::String(request_id.to_string()));
    Ok(value)
}

fn validate_current(current: &DraftCurrentValues) -> Result<()> {
    if current.name.len() > MAX_NAME_BYTES {
        bail!("current automation name is too long");
    }
    if current.prompt.len() > MAX_PROMPT_BYTES {
        bail!("current automation prompt is too long");
    }
    if let Some(command) = current.precheck_command.as_deref() {
        if command.len() > MAX_PRECHECK_BYTES {
            bail!("current precheck command is too long");
        }
    }
    schedule::validate_schedule(
        &current.schedule.kind,
        &current.schedule.value,
        &current.schedule.timezone,
        None,
    )
    .context("invalid current schedule")
}

fn required_text(label: &str, value: String, max_bytes: usize) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("{label} is required");
    }
    if value.len() > max_bytes {
        bail!("{label} is too long");
    }
    Ok(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn request_rejects_unknown_fields() {
        let error = parse_request(&json!({"request": "daily review", "save": true}))
            .expect_err("unknown fields must fail");
        assert!(error.to_string().contains("invalid Hermes draft request"));
    }

    #[test]
    fn response_requires_exact_valid_schema() {
        let request_id = Uuid::new_v4().to_string();
        let value = parse_response(
            &request_id,
            r#"{"name":"Review","prompt":"Review open changes","schedule":{"kind":"daily","value":"09:30","timezone":"Asia/Seoul"},"precheckCommand":null,"notes":["Review before saving"]}"#,
        )
        .expect("valid draft");
        assert_eq!(value["requestId"], request_id);
        assert_eq!(value["schedule"]["kind"], "daily");
    }

    #[test]
    fn response_rejects_markdown_or_unknown_fields() {
        assert!(parse_response("id", "```json\n{}\n```").is_err());
        assert!(parse_response(
            "id",
            r#"{"name":"Review","prompt":"Review","schedule":{"kind":"daily","value":"09:30","timezone":"Asia/Seoul"},"precheckCommand":null,"notes":[],"run":true}"#,
        )
        .is_err());
    }
}

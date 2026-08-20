//! Account-scoped agent-config sync (Claude Code, Codex, Hermes, OMP).
//!
//! Model: a portable BASE template per file lives in the user's VibeLink
//! account (`/api/account/config-profiles`); a MACHINE OVERLAY (structured
//! patch keyed by JSON paths, never line numbers) stays on this machine.
//! Applying renders `merge(base, overlay)`, substitutes machine variables,
//! re-parses the result in its own format as an integrity gate, and only then
//! writes atomically with a `.bak` of the previous file. Collecting reverses
//! it: live file → pinned paths captured into the overlay, the rest becomes
//! the shared template with `{{HOME}}`/`{{PROXY_BASE}}` placeholders.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

use super::account::AccountService;

const ACCOUNT_API_ORIGIN: &str = env!("VIBELINK_API_URL");
const PROFILE_NAME: &str = "default";
const CLOUD_PAYLOAD_LIMIT: usize = 2 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum EntryFormat {
    Json,
    Toml,
    Yaml,
    Text,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncEntry {
    id: &'static str,
    /// Target path template with {{HOME}} / {{LOCALAPPDATA}}.
    target: &'static str,
    format: EntryFormat,
    optional: bool,
}

/// What syncs through the account. Directory trees (hooks/commands/skills) are
/// deliberately file-listed per id to keep the cloud payload bounded; large
/// trees (hermes skills) stay on the SSH/dev-config path.
const ENTRIES: &[SyncEntry] = &[
    SyncEntry {
        id: "claude-settings",
        target: "{{HOME}}/.claude/settings.json",
        format: EntryFormat::Json,
        optional: false,
    },
    SyncEntry {
        id: "claude-keybindings",
        target: "{{HOME}}/.claude/keybindings.json",
        format: EntryFormat::Json,
        optional: true,
    },
    SyncEntry {
        id: "claude-installed-plugins",
        target: "{{HOME}}/.claude/plugins/installed_plugins.json",
        format: EntryFormat::Json,
        optional: false,
    },
    SyncEntry {
        id: "claude-marketplaces",
        target: "{{HOME}}/.claude/plugins/known_marketplaces.json",
        format: EntryFormat::Json,
        optional: false,
    },
    SyncEntry {
        id: "codex-config",
        target: "{{HOME}}/.codex/config.toml",
        format: EntryFormat::Toml,
        optional: true,
    },
    SyncEntry {
        id: "codex-agents-md",
        target: "{{HOME}}/.codex/AGENTS.md",
        format: EntryFormat::Text,
        optional: true,
    },
    SyncEntry {
        id: "hermes-config",
        target: "{{LOCALAPPDATA}}/hermes/config.yaml",
        format: EntryFormat::Yaml,
        optional: true,
    },
    SyncEntry {
        id: "hermes-soul",
        target: "{{LOCALAPPDATA}}/hermes/SOUL.md",
        format: EntryFormat::Text,
        optional: true,
    },
    SyncEntry {
        id: "omp-agents-md",
        target: "{{HOME}}/.omp/agent/AGENTS.md",
        format: EntryFormat::Text,
        optional: true,
    },
    SyncEntry {
        id: "omp-rules-md",
        target: "{{HOME}}/.omp/agent/RULES.md",
        format: EntryFormat::Text,
        optional: true,
    },
    SyncEntry {
        id: "omp-append-system",
        target: "{{HOME}}/.omp/agent/APPEND_SYSTEM.md",
        format: EntryFormat::Text,
        optional: true,
    },
    SyncEntry {
        id: "omp-title-system",
        target: "{{HOME}}/.omp/agent/TITLE_SYSTEM.md",
        format: EntryFormat::Text,
        optional: true,
    },
];

// ---------------------------------------------------------------- local state

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct LocalState {
    /// Machine variables substituted into templates ({{PROXY_BASE}} etc.).
    vars: BTreeMap<String, String>,
    /// Per entry id: dot-paths that are machine-local (captured into the
    /// overlay at collect time instead of the shared template).
    pins: BTreeMap<String, Vec<String>>,
    /// Per entry id: this machine's structured overlay (merge-patch document).
    overlays: BTreeMap<String, Value>,
    /// Per entry id: machine-local text appendix (for markdown/text entries).
    text_appendices: BTreeMap<String, String>,
    last_pushed_revision: Option<i64>,
    last_pulled_revision: Option<i64>,
}

fn state_path() -> Result<PathBuf> {
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join("config-sync")
        .join("state.json"))
}

fn load_state() -> Result<LocalState> {
    let path = state_path()?;
    if !path.exists() {
        let mut state = LocalState::default();
        state.vars.insert(
            "PROXY_BASE".to_string(),
            "http://127.0.0.1:8317".to_string(),
        );
        return Ok(state);
    }
    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text).context("parse config-sync state")
}

fn save_state(state: &LocalState) -> Result<()> {
    let path = state_path()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    write_atomic(&path, &serde_json::to_string_pretty(state)?)
}

fn write_atomic(path: &Path, contents: &str) -> Result<()> {
    let tmp = path.with_extension("tmp-write");
    std::fs::write(&tmp, contents)?;
    if path.exists() {
        let backup = PathBuf::from(format!("{}.bak", path.display()));
        std::fs::copy(path, backup)?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn resolve_target(template: &str) -> Result<PathBuf> {
    let home = std::env::var("USERPROFILE").context("USERPROFILE unset")?;
    let local = std::env::var("LOCALAPPDATA").context("LOCALAPPDATA unset")?;
    Ok(PathBuf::from(
        template
            .replace("{{HOME}}", &home)
            .replace("{{LOCALAPPDATA}}", &local)
            .replace('/', "\\"),
    ))
}

// ------------------------------------------------------- portable text layer

/// Live → portable: machine paths and machine vars become placeholders.
fn to_portable(text: &str, vars: &BTreeMap<String, String>) -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let mut result = text.to_string();
    if !home.is_empty() {
        let double = home.replace('\\', "\\\\");
        let forward = home.replace('\\', "/");
        result = result.replace(&double, "{{HOME_ESC}}");
        result = result.replace(&home, "{{HOME}}");
        result = result.replace(&forward, "{{HOME_FWD}}");
    }
    for (name, value) in vars {
        if !value.is_empty() {
            result = result.replace(value, &format!("{{{{{name}}}}}"));
        }
    }
    result
}

/// Portable → live for this machine.
fn from_portable(text: &str, vars: &BTreeMap<String, String>) -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let mut result = text.to_string();
    result = result.replace("{{HOME_ESC}}", &home.replace('\\', "\\\\"));
    result = result.replace("{{HOME_FWD}}", &home.replace('\\', "/"));
    result = result.replace("{{HOME}}", &home);
    for (name, value) in vars {
        result = result.replace(&format!("{{{{{name}}}}}"), value);
    }
    result
}

// ------------------------------------------------------ structured documents

fn parse_document(format: EntryFormat, text: &str) -> Result<Value> {
    match format {
        EntryFormat::Json => serde_json::from_str(text).context("parse JSON"),
        EntryFormat::Toml => {
            let value: toml::Value = toml::from_str(text).context("parse TOML")?;
            serde_json::to_value(value).context("convert TOML")
        }
        EntryFormat::Yaml => {
            let value: serde_yaml::Value = serde_yaml::from_str(text).context("parse YAML")?;
            serde_json::to_value(value).context("convert YAML")
        }
        EntryFormat::Text => Ok(Value::String(text.to_string())),
    }
}

fn serialize_document(format: EntryFormat, value: &Value) -> Result<String> {
    match format {
        EntryFormat::Json => Ok(serde_json::to_string_pretty(value)? + "\n"),
        EntryFormat::Toml => {
            let toml_value: toml::Value =
                serde_json::from_value(value.clone()).context("convert to TOML value")?;
            toml::to_string_pretty(&toml_value).context("serialize TOML")
        }
        EntryFormat::Yaml => {
            let yaml_value: serde_yaml::Value =
                serde_json::from_value(value.clone()).context("convert to YAML value")?;
            serde_yaml::to_string(&yaml_value).context("serialize YAML")
        }
        EntryFormat::Text => value
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| anyhow!("text document must be a string")),
    }
}

/// RFC 7386-style merge: objects merge key-wise, `null` in the overlay deletes
/// the key, everything else (arrays, scalars) replaces. This is what makes a
/// machine-local addition land by STRUCTURE — the overlay names a key path,
/// so template edits (new lines, reordered keys) never displace it.
fn deep_merge(base: &Value, overlay: &Value) -> Value {
    match (base, overlay) {
        (Value::Object(base_map), Value::Object(overlay_map)) => {
            let mut merged = base_map.clone();
            for (key, patch) in overlay_map {
                if patch.is_null() {
                    merged.remove(key);
                } else {
                    let merged_child = match merged.get(key) {
                        Some(existing) => deep_merge(existing, patch),
                        None => patch.clone(),
                    };
                    merged.insert(key.clone(), merged_child);
                }
            }
            Value::Object(merged)
        }
        (_, replacement) => replacement.clone(),
    }
}

fn get_path<'a>(value: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut current = value;
    for segment in path {
        current = current.as_object()?.get(*segment)?;
    }
    Some(current)
}

fn remove_path(value: &mut Value, path: &[&str]) {
    if path.is_empty() {
        return;
    }
    let Some(object) = value.as_object_mut() else {
        return;
    };
    if path.len() == 1 {
        object.remove(path[0]);
        return;
    }
    if let Some(child) = object.get_mut(path[0]) {
        remove_path(child, &path[1..]);
    }
}

fn set_path(value: &mut Value, path: &[&str], leaf: Value) {
    if path.is_empty() {
        *value = leaf;
        return;
    }
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    let object = value.as_object_mut().expect("just ensured object");
    if path.len() == 1 {
        object.insert(path[0].to_string(), leaf);
        return;
    }
    let child = object
        .entry(path[0].to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    set_path(child, &path[1..], leaf);
}

/// Splits `a.b.c` pin paths. Dots inside key names are not supported — pins
/// target well-known config keys, which never contain dots in practice.
fn split_pin(pin: &str) -> Vec<&str> {
    pin.split('.')
        .filter(|segment| !segment.is_empty())
        .collect()
}

// ----------------------------------------------------------------- text tail

const TEXT_MARKER_BEGIN: &str = "<!-- vibelink:machine-local:begin -->";
const TEXT_MARKER_END: &str = "<!-- vibelink:machine-local:end -->";

fn split_text_appendix(text: &str) -> (String, Option<String>) {
    let Some(start) = text.find(TEXT_MARKER_BEGIN) else {
        return (text.to_string(), None);
    };
    let after = &text[start + TEXT_MARKER_BEGIN.len()..];
    let end = after
        .find(TEXT_MARKER_END)
        .map(|index| start + TEXT_MARKER_BEGIN.len() + index);
    let appendix = match end {
        Some(end_index) => text[start + TEXT_MARKER_BEGIN.len()..end_index]
            .trim()
            .to_string(),
        None => after.trim().to_string(),
    };
    let base = text[..start].trim_end().to_string();
    (
        base,
        if appendix.is_empty() {
            None
        } else {
            Some(appendix)
        },
    )
}

fn join_text_appendix(base: &str, appendix: Option<&str>) -> String {
    match appendix {
        Some(appendix) if !appendix.trim().is_empty() => format!(
            "{}\n\n{}\n{}\n{}\n",
            base.trim_end(),
            TEXT_MARKER_BEGIN,
            appendix.trim(),
            TEXT_MARKER_END
        ),
        _ => {
            let mut text = base.trim_end().to_string();
            text.push('\n');
            text
        }
    }
}

// ------------------------------------------------------------------ payloads

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CloudPayload {
    schema: u32,
    files: BTreeMap<String, Value>,
}

fn collect_base_files(state: &mut LocalState) -> Result<BTreeMap<String, Value>> {
    let mut files = BTreeMap::new();
    for entry in ENTRIES {
        let target = resolve_target(entry.target)?;
        if !target.exists() {
            if !entry.optional {
                bail!(
                    "required config missing: {} ({})",
                    entry.id,
                    target.display()
                );
            }
            continue;
        }
        let live_text = std::fs::read_to_string(&target)
            .with_context(|| format!("read {}", target.display()))?;

        if entry.format == EntryFormat::Text {
            let portable = to_portable(&live_text, &state.vars);
            let (base, appendix) = split_text_appendix(&portable);
            match appendix {
                Some(appendix) => {
                    state.text_appendices.insert(entry.id.to_string(), appendix);
                }
                None => {
                    state.text_appendices.remove(entry.id);
                }
            }
            files.insert(
                entry.id.to_string(),
                json!({ "format": "text", "text": base }),
            );
            continue;
        }

        let portable_text = to_portable(&live_text, &state.vars);
        let mut document = parse_document(entry.format, &portable_text)
            .with_context(|| format!("{}: live file failed integrity parse", entry.id))?;

        // Pinned paths are machine-local: capture their live values into the
        // overlay and strip them from the shared template.
        let pins = state.pins.get(entry.id).cloned().unwrap_or_default();
        if !pins.is_empty() {
            let mut overlay = state
                .overlays
                .get(entry.id)
                .cloned()
                .unwrap_or_else(|| Value::Object(Map::new()));
            for pin in &pins {
                let segments = split_pin(pin);
                if segments.is_empty() {
                    continue;
                }
                if let Some(live_value) = get_path(&document, &segments) {
                    set_path(&mut overlay, &segments, live_value.clone());
                }
                remove_path(&mut document, &segments);
            }
            state.overlays.insert(entry.id.to_string(), overlay);
        }

        files.insert(
            entry.id.to_string(),
            json!({ "format": entry.format, "document": document }),
        );
    }
    Ok(files)
}

fn apply_base_files(files: &BTreeMap<String, Value>, state: &LocalState) -> Result<Vec<String>> {
    let mut applied = Vec::new();
    for entry in ENTRIES {
        let Some(stored) = files.get(entry.id) else {
            continue;
        };
        let target = resolve_target(entry.target)?;

        let rendered = if entry.format == EntryFormat::Text {
            let base = stored
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| anyhow!("{}: stored text missing", entry.id))?;
            let appendix = state.text_appendices.get(entry.id).map(String::as_str);
            from_portable(&join_text_appendix(base, appendix), &state.vars)
        } else {
            let base_document = stored
                .get("document")
                .ok_or_else(|| anyhow!("{}: stored document missing", entry.id))?;
            let overlay = state.overlays.get(entry.id);
            let merged = match overlay {
                Some(overlay) if !overlay.is_null() => deep_merge(base_document, overlay),
                _ => base_document.clone(),
            };
            let portable_text = serialize_document(entry.format, &merged)
                .with_context(|| format!("{}: serialize merged document", entry.id))?;
            let live_text = from_portable(&portable_text, &state.vars);
            // Integrity gate: the rendered result must parse in its own format
            // or nothing is written.
            parse_document(entry.format, &live_text)
                .with_context(|| format!("{}: merged result failed integrity parse", entry.id))?;
            live_text
        };

        if rendered.contains("{{") {
            bail!(
                "{}: unresolved placeholder after render; set the machine variable in Config Sync settings",
                entry.id
            );
        }

        let current = std::fs::read_to_string(&target).ok();
        if current.as_deref() == Some(rendered.as_str()) {
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        write_atomic(&target, &rendered)?;
        applied.push(entry.id.to_string());
    }
    Ok(applied)
}

// ---------------------------------------------------------------- cloud http

fn cloud_get(token: &str) -> Result<Option<(i64, CloudPayload)>> {
    let url = format!("{ACCOUNT_API_ORIGIN}/api/account/config-profiles?name={PROFILE_NAME}");
    let agent = ureq::AgentBuilder::new().build();
    match agent
        .get(&url)
        .set("Accept", "application/json")
        .set("Authorization", &format!("Bearer {token}"))
        .call()
    {
        Ok(response) => {
            let body: Value = response.into_json().context("parse profile response")?;
            let revision = body
                .get("revision")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow!("profile response missing revision"))?;
            let payload: CloudPayload = serde_json::from_value(
                body.get("payload")
                    .cloned()
                    .ok_or_else(|| anyhow!("profile response missing payload"))?,
            )
            .context("parse profile payload")?;
            Ok(Some((revision, payload)))
        }
        Err(ureq::Error::Status(404, _)) => Ok(None),
        Err(ureq::Error::Status(401, _)) => bail!("계정 로그인이 필요합니다 (설정 > 계정)"),
        Err(ureq::Error::Status(status, _)) => bail!("config sync service returned HTTP {status}"),
        Err(ureq::Error::Transport(_)) => bail!("config sync service unreachable"),
    }
}

fn cloud_put(token: &str, expected_revision: i64, payload: &CloudPayload) -> Result<i64> {
    let url = format!("{ACCOUNT_API_ORIGIN}/api/account/config-profiles");
    let body = json!({
        "name": PROFILE_NAME,
        "expectedRevision": expected_revision,
        "host": std::env::var("COMPUTERNAME").unwrap_or_default(),
        "payload": payload,
    });
    let encoded = serde_json::to_string(&body)?;
    if encoded.len() > CLOUD_PAYLOAD_LIMIT {
        bail!("config payload exceeds the 2 MiB account cap");
    }
    let agent = ureq::AgentBuilder::new().build();
    match agent
        .put(&url)
        .set("Accept", "application/json")
        .set("Content-Type", "application/json")
        .set("Authorization", &format!("Bearer {token}"))
        .send_string(&encoded)
    {
        Ok(response) => {
            let body: Value = response.into_json().context("parse push response")?;
            body.get("revision")
                .and_then(Value::as_i64)
                .ok_or_else(|| anyhow!("push response missing revision"))
        }
        Err(ureq::Error::Status(409, response)) => {
            let body: Value = response.into_json().unwrap_or(Value::Null);
            let revision = body.get("revision").and_then(Value::as_i64).unwrap_or(-1);
            bail!(
                "다른 PC가 먼저 올렸습니다 (서버 revision {revision}). 먼저 가져오기를 실행하세요."
            )
        }
        Err(ureq::Error::Status(401, _)) => bail!("계정 로그인이 필요합니다 (설정 > 계정)"),
        Err(ureq::Error::Status(status, _)) => bail!("config sync service returned HTTP {status}"),
        Err(ureq::Error::Transport(_)) => bail!("config sync service unreachable"),
    }
}

fn require_token(account: &AccountService) -> Result<String> {
    account
        .session_token()?
        .ok_or_else(|| anyhow!("계정 로그인이 필요합니다 (설정 > 계정)"))
}

// ------------------------------------------------------------------ commands

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncStatus {
    signed_in: bool,
    remote_revision: Option<i64>,
    remote_updated_by: Option<String>,
    last_pushed_revision: Option<i64>,
    last_pulled_revision: Option<i64>,
    vars: BTreeMap<String, String>,
    pins: BTreeMap<String, Vec<String>>,
    entries: Vec<Value>,
}

fn to_string(err: impl std::fmt::Display) -> String {
    format!("{err:#}")
}

#[tauri::command]
pub async fn config_sync_status(
    account: State<'_, Arc<AccountService>>,
) -> Result<ConfigSyncStatus, String> {
    let account = Arc::clone(&account);
    tauri::async_runtime::spawn_blocking(move || -> Result<ConfigSyncStatus> {
        let state = load_state()?;
        let token = account.session_token()?;
        let mut remote_revision = None;
        let mut remote_updated_by = None;
        if let Some(token) = token.as_deref() {
            let url =
                format!("{ACCOUNT_API_ORIGIN}/api/account/config-profiles?name={PROFILE_NAME}");
            if let Ok(response) = ureq::AgentBuilder::new()
                .build()
                .get(&url)
                .set("Authorization", &format!("Bearer {token}"))
                .call()
            {
                if let Ok(body) = response.into_json::<Value>() {
                    remote_revision = body.get("revision").and_then(Value::as_i64);
                    remote_updated_by = body
                        .get("updatedByHost")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
            }
        }
        let entries = ENTRIES
            .iter()
            .map(|entry| {
                let exists = resolve_target(entry.target)
                    .map(|path| path.exists())
                    .unwrap_or(false);
                json!({ "id": entry.id, "target": entry.target, "exists": exists })
            })
            .collect();
        Ok(ConfigSyncStatus {
            signed_in: token.is_some(),
            remote_revision,
            remote_updated_by,
            last_pushed_revision: state.last_pushed_revision,
            last_pulled_revision: state.last_pulled_revision,
            vars: state.vars,
            pins: state.pins,
            entries,
        })
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn config_sync_push(account: State<'_, Arc<AccountService>>) -> Result<i64, String> {
    let account = Arc::clone(&account);
    tauri::async_runtime::spawn_blocking(move || -> Result<i64> {
        let token = require_token(&account)?;
        let mut state = load_state()?;
        let files = collect_base_files(&mut state)?;
        let payload = CloudPayload { schema: 1, files };
        let current = cloud_get(&token)?;
        let expected = current.map(|(revision, _)| revision).unwrap_or(0);
        let revision = cloud_put(&token, expected, &payload)?;
        state.last_pushed_revision = Some(revision);
        save_state(&state)?;
        Ok(revision)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigSyncPullResult {
    pub revision: i64,
    pub applied: Vec<String>,
}

#[tauri::command]
pub async fn config_sync_pull(
    account: State<'_, Arc<AccountService>>,
) -> Result<ConfigSyncPullResult, String> {
    let account = Arc::clone(&account);
    tauri::async_runtime::spawn_blocking(move || -> Result<ConfigSyncPullResult> {
        let token = require_token(&account)?;
        let mut state = load_state()?;
        let Some((revision, payload)) = cloud_get(&token)? else {
            bail!("계정에 저장된 설정이 아직 없습니다. 원본 PC에서 먼저 올리기를 실행하세요.");
        };
        if payload.schema != 1 {
            bail!("unsupported config payload schema {}", payload.schema);
        }
        let applied = apply_base_files(&payload.files, &state)?;
        state.last_pulled_revision = Some(revision);
        save_state(&state)?;
        Ok(ConfigSyncPullResult { revision, applied })
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn config_sync_set_var(name: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let name = name.trim().to_uppercase();
        if name.is_empty()
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
        {
            bail!("variable names are ASCII letters, digits, and underscores");
        }
        let mut state = load_state()?;
        if value.trim().is_empty() {
            state.vars.remove(&name);
        } else {
            state.vars.insert(name, value.trim().to_string());
        }
        save_state(&state)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn config_sync_set_pins(entry_id: String, pins: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        if !ENTRIES.iter().any(|entry| entry.id == entry_id) {
            bail!("unknown config sync entry {entry_id}");
        }
        let mut state = load_state()?;
        let cleaned: Vec<String> = pins
            .into_iter()
            .map(|pin| pin.trim().to_string())
            .filter(|pin| !pin.is_empty())
            .collect();
        if cleaned.is_empty() {
            state.pins.remove(&entry_id);
        } else {
            state.pins.insert(entry_id, cleaned);
        }
        save_state(&state)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_merge_inserts_by_structure_not_position() {
        // The user's scenario: the template gains lines; this machine's extra
        // provider (once "line 2") must still land under providers by key.
        let base = json!({
            "model": { "default": "gpt-5.6" },
            "providers": {
                "cliproxyapi": { "base_url": "{{PROXY_BASE}}/v1" }
            }
        });
        let overlay = json!({
            "providers": {
                "local-only": { "base_url": "http://127.0.0.1:9999" }
            }
        });
        let merged = deep_merge(&base, &overlay);
        assert_eq!(
            merged["providers"]["cliproxyapi"]["base_url"],
            "{{PROXY_BASE}}/v1"
        );
        assert_eq!(
            merged["providers"]["local-only"]["base_url"],
            "http://127.0.0.1:9999"
        );
        assert_eq!(merged["model"]["default"], "gpt-5.6");
    }

    #[test]
    fn deep_merge_null_deletes_and_scalars_replace() {
        let base = json!({ "a": { "b": 1, "c": 2 }, "list": [1, 2] });
        let overlay = json!({ "a": { "b": null }, "list": [9] });
        let merged = deep_merge(&base, &overlay);
        assert!(merged["a"].get("b").is_none());
        assert_eq!(merged["a"]["c"], 2);
        assert_eq!(merged["list"], json!([9]));
    }

    #[test]
    fn pin_capture_roundtrip() {
        let mut document = json!({
            "providers": { "shared": { "x": 1 }, "mine": { "y": 2 } }
        });
        let mut overlay = Value::Object(Map::new());
        let segments = split_pin("providers.mine");
        set_path(
            &mut overlay,
            &segments,
            get_path(&document, &segments).unwrap().clone(),
        );
        remove_path(&mut document, &segments);
        assert!(document["providers"].get("mine").is_none());
        let merged = deep_merge(&document, &overlay);
        assert_eq!(merged["providers"]["mine"]["y"], 2);
        assert_eq!(merged["providers"]["shared"]["x"], 1);
    }

    #[test]
    fn toml_and_yaml_survive_parse_serialize_roundtrip() {
        let toml_text = "title = \"x\"\n[server]\nurl = \"{{PROXY_BASE}}/v1\"\nport = 1400\n";
        let document = parse_document(EntryFormat::Toml, toml_text).expect("parse toml");
        let out = serialize_document(EntryFormat::Toml, &document).expect("serialize toml");
        parse_document(EntryFormat::Toml, &out).expect("roundtrip toml");

        let yaml_text = "model:\n  base_url: '{{PROXY_BASE}}'\n  names:\n    - a\n    - b\n";
        let document = parse_document(EntryFormat::Yaml, yaml_text).expect("parse yaml");
        let out = serialize_document(EntryFormat::Yaml, &document).expect("serialize yaml");
        let reparsed = parse_document(EntryFormat::Yaml, &out).expect("roundtrip yaml");
        assert_eq!(reparsed["model"]["base_url"], "{{PROXY_BASE}}");
    }

    #[test]
    fn text_appendix_markers_split_and_rejoin() {
        let text = "shared line 1\nshared line 2\n\n<!-- vibelink:machine-local:begin -->\nmy local rule\n<!-- vibelink:machine-local:end -->\n";
        let (base, appendix) = split_text_appendix(text);
        assert_eq!(base, "shared line 1\nshared line 2");
        assert_eq!(appendix.as_deref(), Some("my local rule"));
        let joined = join_text_appendix(&base, appendix.as_deref());
        let (base2, appendix2) = split_text_appendix(&joined);
        assert_eq!(base2, base);
        assert_eq!(appendix2, appendix);
    }

    #[test]
    fn portable_roundtrip_restores_home_and_vars() {
        let mut vars = BTreeMap::new();
        vars.insert(
            "PROXY_BASE".to_string(),
            "http://127.0.0.1:8317".to_string(),
        );
        let home = std::env::var("USERPROFILE").unwrap();
        let live = format!(
            "{{\"hook\":\"{}\\\\x.ps1\",\"url\":\"http://127.0.0.1:8317/v1\"}}",
            home.replace('\\', "\\\\")
        );
        let portable = to_portable(&live, &vars);
        assert!(portable.contains("{{HOME_ESC}}"));
        assert!(portable.contains("{{PROXY_BASE}}/v1"));
        assert_eq!(from_portable(&portable, &vars), live);
    }
}

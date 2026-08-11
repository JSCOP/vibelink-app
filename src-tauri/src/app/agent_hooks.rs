use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::{json, Map as JsonMap, Value as JsonValue};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

const HOOK_MARKER: &str = "Managed by VibeLink agent completion hooks";
const KIMI_BLOCK_START: &str = "# >>> VibeLink agent completion hook >>>";
const KIMI_BLOCK_END: &str = "# <<< VibeLink agent completion hook <<<";
const CODEX_TRUST_MARKER: &str = "# Managed by VibeLink agent completion hooks";
const HERMES_PLUGIN_NAME: &str = "vibelink-status";
const HOOK_TIMEOUT_SECONDS: u64 = 5;
const GEMINI_TIMEOUT_MILLISECONDS: u64 = 10_000;

const STOP_EVENT: &[&str] = &["Stop"];
const CLAUDE_EVENTS: &[&str] = &["Stop", "SessionStart"];
const CLAUDE_SESSION_START_EVENT: &[&str] = &["SessionStart"];
const CLAUDE_MEMORY_SCRIPT_STEM: &str = "claude-memory";
const GEMINI_EVENTS: &[&str] = &["AfterAgent"];
const CURSOR_EVENTS: &[&str] = &["stop"];

/// Executable that generated completion hooks must invoke.
///
/// This MUST be the dedicated CLI (`vibelink.exe`), never `current_exe()`.
/// The GUI binary treats every argv it does not recognise as a normal launch,
/// so a hook baking in `app.exe` starts a SECOND full desktop instance on each
/// agent turn. Those instances attach to the same daemon session and refit
/// every pane to their own default 800x600 window, which makes the visible
/// grid oscillate between two column counts ("screen shaking").
fn hook_cli_path() -> Result<PathBuf> {
    super::cli_path::dedicated_cli_path()
}

#[derive(Clone, Copy)]
enum ConfigLocation {
    Home(&'static str),
    EnvOrHome {
        env: &'static str,
        relative: &'static str,
    },
    AppDataOrHome {
        app_data_relative: &'static str,
        home_relative: &'static str,
    },
}

#[derive(Clone, Copy)]
enum WindowsCommandStyle {
    GitBash,
    Direct,
    PowerShell,
}

#[derive(Clone, Copy)]
enum JsonSchema {
    Nested,
    Cursor,
    Antigravity,
    Copilot,
}

#[derive(Clone, Copy)]
struct JsonHookSpec {
    schema: JsonSchema,
    events: &'static [&'static str],
    command_style: WindowsCommandStyle,
    allow_jsonc: bool,
}

#[derive(Clone, Copy)]
enum DropInKind {
    Amp,
    OpenCode,
    MimoCode,
    Pi,
    Omp,
}

#[derive(Clone, Copy)]
enum HookKind {
    Json(JsonHookSpec),
    DropIn(DropInKind),
    KimiToml,
    HermesPlugin,
}

#[derive(Clone, Copy)]
struct AgentHookSpec {
    id: &'static str,
    display_name: &'static str,
    location: ConfigLocation,
    kind: HookKind,
}

const AGENT_HOOK_SPECS: &[AgentHookSpec] = &[
    AgentHookSpec {
        id: "claude",
        display_name: "Claude Code",
        location: ConfigLocation::Home(".claude/settings.json"),
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Nested,
            events: CLAUDE_EVENTS,
            command_style: WindowsCommandStyle::GitBash,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "codex",
        display_name: "Codex",
        location: ConfigLocation::EnvOrHome {
            env: "CODEX_HOME",
            relative: ".codex/hooks.json",
        },
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Nested,
            events: STOP_EVENT,
            command_style: WindowsCommandStyle::Direct,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "gemini",
        display_name: "Gemini CLI",
        location: ConfigLocation::Home(".gemini/settings.json"),
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Nested,
            events: GEMINI_EVENTS,
            command_style: WindowsCommandStyle::PowerShell,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "antigravity",
        display_name: "Antigravity",
        location: ConfigLocation::Home(".gemini/config/hooks.json"),
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Antigravity,
            events: STOP_EVENT,
            command_style: WindowsCommandStyle::Direct,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "amp",
        display_name: "Amp",
        location: ConfigLocation::Home(".config/amp/plugins/vibelink-agent-status.ts"),
        kind: HookKind::DropIn(DropInKind::Amp),
    },
    AgentHookSpec {
        id: "opencode",
        display_name: "OpenCode",
        location: ConfigLocation::Home(".config/opencode/plugins/vibelink-complete.js"),
        kind: HookKind::DropIn(DropInKind::OpenCode),
    },
    AgentHookSpec {
        id: "mimo-code",
        display_name: "MiMo Code",
        location: ConfigLocation::Home(".config/mimocode/plugins/vibelink-complete.js"),
        kind: HookKind::DropIn(DropInKind::MimoCode),
    },
    AgentHookSpec {
        id: "cursor",
        display_name: "Cursor Agent",
        location: ConfigLocation::Home(".cursor/hooks.json"),
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Cursor,
            events: CURSOR_EVENTS,
            command_style: WindowsCommandStyle::PowerShell,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "pi",
        display_name: "Pi",
        location: ConfigLocation::Home(".pi/agent/extensions/vibelink-agent-status.ts"),
        kind: HookKind::DropIn(DropInKind::Pi),
    },
    AgentHookSpec {
        id: "omp",
        display_name: "Oh My Pi",
        location: ConfigLocation::Home(".omp/agent/extensions/vibelink-agent-status.ts"),
        kind: HookKind::DropIn(DropInKind::Omp),
    },
    AgentHookSpec {
        id: "droid",
        display_name: "Factory Droid",
        location: ConfigLocation::Home(".factory/settings.json"),
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Nested,
            events: STOP_EVENT,
            command_style: WindowsCommandStyle::PowerShell,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "command-code",
        display_name: "Command Code",
        location: ConfigLocation::Home(".commandcode/settings.json"),
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Nested,
            events: STOP_EVENT,
            command_style: WindowsCommandStyle::PowerShell,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "grok",
        display_name: "Grok",
        location: ConfigLocation::EnvOrHome {
            env: "GROK_HOME",
            relative: ".grok/hooks/vibelink-status.json",
        },
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Nested,
            events: STOP_EVENT,
            command_style: WindowsCommandStyle::PowerShell,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "copilot",
        display_name: "GitHub Copilot CLI",
        location: ConfigLocation::EnvOrHome {
            env: "COPILOT_HOME",
            relative: ".copilot/hooks/vibelink.json",
        },
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Copilot,
            events: STOP_EVENT,
            command_style: WindowsCommandStyle::PowerShell,
            allow_jsonc: false,
        }),
    },
    AgentHookSpec {
        id: "hermes",
        display_name: "Hermes",
        location: ConfigLocation::EnvOrHome {
            env: "HERMES_HOME",
            relative: ".hermes/config.yaml",
        },
        kind: HookKind::HermesPlugin,
    },
    AgentHookSpec {
        id: "devin",
        display_name: "Devin",
        location: ConfigLocation::AppDataOrHome {
            app_data_relative: "devin/config.json",
            home_relative: ".config/devin/config.json",
        },
        kind: HookKind::Json(JsonHookSpec {
            schema: JsonSchema::Nested,
            events: STOP_EVENT,
            command_style: WindowsCommandStyle::Direct,
            allow_jsonc: true,
        }),
    },
    AgentHookSpec {
        id: "kimi",
        display_name: "Kimi Code",
        location: ConfigLocation::EnvOrHome {
            env: "KIMI_CODE_HOME",
            relative: ".kimi-code/config.toml",
        },
        kind: HookKind::KimiToml,
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookStatus {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    pub config_path: String,
    pub blocked_reason: Option<String>,
}

struct HookInspection {
    installed: bool,
    blocked_reason: Option<String>,
}

pub fn get_managed_agent_hook_statuses(app_data_dir: &Path) -> Vec<AgentHookStatus> {
    AGENT_HOOK_SPECS
        .iter()
        .map(|spec| inspect_status(spec, app_data_dir))
        .collect()
}

pub fn set_agent_hook_enabled_native(
    app_data_dir: &Path,
    agent_id: &str,
    enabled: bool,
) -> Result<AgentHookStatus> {
    let spec = AGENT_HOOK_SPECS
        .iter()
        .find(|spec| spec.id.eq_ignore_ascii_case(agent_id))
        .ok_or_else(|| anyhow!("unsupported agent hook: {agent_id}"))?;

    if enabled {
        install_hook(spec, app_data_dir)?;
    } else {
        uninstall_hook(spec, app_data_dir)?;
    }

    let status = inspect_status(spec, app_data_dir);
    if enabled && !status.installed {
        bail!(
            "{} hook installation did not pass verification{}",
            spec.display_name,
            status
                .blocked_reason
                .as_deref()
                .map(|reason| format!(": {reason}"))
                .unwrap_or_default()
        );
    }
    if !enabled && status.installed {
        bail!(
            "{} hook removal did not pass verification",
            spec.display_name
        );
    }
    Ok(status)
}

fn inspect_status(spec: &AgentHookSpec, app_data_dir: &Path) -> AgentHookStatus {
    let config_path = resolve_config_path(spec);
    let inspection = match inspect_hook(spec, app_data_dir, &config_path) {
        Ok(inspection) => inspection,
        Err(error) => HookInspection {
            installed: false,
            blocked_reason: Some(error.to_string()),
        },
    };
    AgentHookStatus {
        id: spec.id.to_string(),
        display_name: spec.display_name.to_string(),
        installed: inspection.installed,
        config_path: config_path.display().to_string(),
        blocked_reason: inspection.blocked_reason,
    }
}

fn inspect_hook(
    spec: &AgentHookSpec,
    app_data_dir: &Path,
    config_path: &Path,
) -> Result<HookInspection> {
    match spec.kind {
        HookKind::Json(json_spec) => inspect_json_hook(spec, json_spec, app_data_dir, config_path),
        HookKind::DropIn(kind) => inspect_drop_in_hook(spec, kind, config_path),
        HookKind::KimiToml => inspect_kimi_hook(spec, app_data_dir, config_path),
        HookKind::HermesPlugin => inspect_hermes_hook(config_path),
    }
}

fn install_hook(spec: &AgentHookSpec, app_data_dir: &Path) -> Result<()> {
    let config_path = resolve_config_path(spec);
    match spec.kind {
        HookKind::Json(json_spec) => install_json_hook(spec, json_spec, app_data_dir, &config_path),
        HookKind::DropIn(kind) => install_drop_in_hook(spec, kind, &config_path),
        HookKind::KimiToml => install_kimi_hook(spec, app_data_dir, &config_path),
        HookKind::HermesPlugin => install_hermes_hook(&config_path),
    }?;
    remove_legacy_shared_script(spec, app_data_dir)
}

fn uninstall_hook(spec: &AgentHookSpec, app_data_dir: &Path) -> Result<()> {
    let config_path = resolve_config_path(spec);
    match spec.kind {
        HookKind::Json(json_spec) => {
            uninstall_json_hook(spec, json_spec, app_data_dir, &config_path)
        }
        HookKind::DropIn(kind) => uninstall_drop_in_hook(spec, kind, &config_path),
        HookKind::KimiToml => uninstall_kimi_hook(spec, app_data_dir, &config_path),
        HookKind::HermesPlugin => uninstall_hermes_hook(&config_path),
    }?;
    remove_legacy_shared_script(spec, app_data_dir)
}

fn resolve_config_path(spec: &AgentHookSpec) -> PathBuf {
    let home = user_home();
    let app_data = user_app_data();
    match spec.location {
        ConfigLocation::Home(relative) => home.join(relative),
        ConfigLocation::EnvOrHome { env, relative } => std::env::var_os(env)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .map(|root| root.join(file_name_or_relative_for_override(relative)))
            .unwrap_or_else(|| home.join(relative)),
        ConfigLocation::AppDataOrHome {
            app_data_relative,
            home_relative,
        } => app_data
            .map(|root| root.join(app_data_relative))
            .unwrap_or_else(|| home.join(home_relative)),
    }
}

fn file_name_or_relative_for_override(relative: &str) -> &str {
    match relative {
        ".codex/hooks.json" => "hooks.json",
        ".grok/hooks/vibelink-status.json" => "hooks/vibelink-status.json",
        ".copilot/hooks/vibelink.json" => "hooks/vibelink.json",
        ".hermes/config.yaml" => "config.yaml",
        ".kimi-code/config.toml" => "config.toml",
        other => other,
    }
}

fn user_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.home_dir().to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."))
}

fn user_app_data() -> Option<PathBuf> {
    std::env::var_os("APPDATA")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(|| directories::BaseDirs::new().map(|dirs| dirs.config_dir().to_path_buf()))
}

fn script_path(spec: &AgentHookSpec, app_data_dir: &Path) -> PathBuf {
    let extension = if cfg!(windows) {
        if matches!(spec.kind, HookKind::KimiToml) {
            "sh"
        } else if matches!(
            spec.kind,
            HookKind::Json(JsonHookSpec {
                schema: JsonSchema::Copilot,
                ..
            })
        ) {
            "ps1"
        } else {
            "cmd"
        }
    } else {
        "sh"
    };
    app_data_dir
        .join("data")
        .join("agent-hooks")
        .join(format!("{}-complete.{extension}", spec.id))
}

fn claude_memory_script_path(app_data_dir: &Path) -> PathBuf {
    let extension = if cfg!(windows) { "ps1" } else { "sh" };
    app_data_dir
        .join("data")
        .join("agent-hooks")
        .join(format!("{CLAUDE_MEMORY_SCRIPT_STEM}.{extension}"))
}

fn inspect_json_hook(
    spec: &AgentHookSpec,
    json_spec: JsonHookSpec,
    app_data_dir: &Path,
    config_path: &Path,
) -> Result<HookInspection> {
    let config = read_json_config(config_path, json_spec.allow_jsonc)?;
    let completion_events = completion_json_events(spec, json_spec);
    let managed_events = managed_json_event_count(&config, spec, json_spec)?;
    let script = script_path(spec, app_data_dir);
    let script_state = generated_file_state(&script)?;
    if script_state == GeneratedFileState::Conflict {
        bail!("{} exists but is not owned by VibeLink", script.display());
    }

    if managed_events == completion_events.len() && script_state == GeneratedFileState::Managed {
        rewrite_managed_file_if_stale(&script, &render_managed_script(spec)?, true)?;
    }
    let mut installed =
        managed_events == completion_events.len() && script_state == GeneratedFileState::Managed;
    if spec.id == "claude" {
        let memory_script = claude_memory_script_path(app_data_dir);
        let memory_script_state = generated_file_state(&memory_script)?;
        if memory_script_state == GeneratedFileState::Conflict {
            bail!(
                "{} exists but is not owned by VibeLink",
                memory_script.display()
            );
        }
        let memory_events = managed_nested_event_count(
            &config,
            CLAUDE_SESSION_START_EVENT,
            CLAUDE_MEMORY_SCRIPT_STEM,
        )?;
        if memory_events == CLAUDE_SESSION_START_EVENT.len()
            && memory_script_state == GeneratedFileState::Managed
        {
            rewrite_managed_file_if_stale(&memory_script, &render_claude_memory_script()?, true)?;
        }
        installed &= memory_events == CLAUDE_SESSION_START_EVENT.len()
            && memory_script_state == GeneratedFileState::Managed;
    }
    if installed && spec.id == "codex" {
        let group_index = managed_nested_group_index(&config, spec, "Stop")
            .ok_or_else(|| anyhow!("Codex managed Stop hook is missing"))?;
        installed = codex_trust_is_current(config_path, group_index, spec, app_data_dir)?;
    }

    Ok(HookInspection {
        installed,
        blocked_reason: None,
    })
}

fn install_json_hook(
    spec: &AgentHookSpec,
    json_spec: JsonHookSpec,
    app_data_dir: &Path,
    config_path: &Path,
) -> Result<()> {
    let mut config = read_json_config(config_path, json_spec.allow_jsonc)?;
    let old_codex_index = if spec.id == "codex" {
        managed_nested_group_index(&config, spec, "Stop")
    } else {
        None
    };
    let script = script_path(spec, app_data_dir);
    ensure_generated_file_writable(&script)?;
    let memory_script = (spec.id == "claude").then(|| claude_memory_script_path(app_data_dir));
    if let Some(memory_script) = &memory_script {
        ensure_generated_file_writable(memory_script)?;
    }
    write_managed_script(spec, &script)?;
    if let Some(memory_script) = &memory_script {
        write_claude_memory_script(memory_script)?;
    }
    apply_json_hook_config(
        &mut config,
        spec,
        json_spec,
        &managed_command(spec, json_spec, &script),
        true,
    )?;
    if let Some(memory_script) = &memory_script {
        apply_nested_json_for_script(
            &mut config,
            spec,
            CLAUDE_SESSION_START_EVENT,
            &claude_memory_command(memory_script),
            true,
            CLAUDE_MEMORY_SCRIPT_STEM,
        )?;
    }
    write_json_config(config_path, &config)?;

    if spec.id == "codex" {
        let new_index = managed_nested_group_index(&config, spec, "Stop")
            .ok_or_else(|| anyhow!("Codex managed Stop hook was not written"))?;
        update_codex_trust(
            config_path,
            old_codex_index,
            Some(new_index),
            spec,
            app_data_dir,
        )?;
    }
    Ok(())
}

fn uninstall_json_hook(
    spec: &AgentHookSpec,
    json_spec: JsonHookSpec,
    app_data_dir: &Path,
    config_path: &Path,
) -> Result<()> {
    let mut config = read_json_config(config_path, json_spec.allow_jsonc)?;
    let old_codex_index = if spec.id == "codex" {
        managed_nested_group_index(&config, spec, "Stop")
    } else {
        None
    };
    let before = config.clone();
    let script = script_path(spec, app_data_dir);
    apply_json_hook_config(
        &mut config,
        spec,
        json_spec,
        &managed_command(spec, json_spec, &script),
        false,
    )?;
    let memory_script = (spec.id == "claude").then(|| claude_memory_script_path(app_data_dir));
    if let Some(memory_script) = &memory_script {
        apply_nested_json_for_script(
            &mut config,
            spec,
            CLAUDE_SESSION_START_EVENT,
            &claude_memory_command(memory_script),
            false,
            CLAUDE_MEMORY_SCRIPT_STEM,
        )?;
    }
    if config != before {
        write_json_config(config_path, &config)?;
    }
    if spec.id == "codex" {
        update_codex_trust(config_path, old_codex_index, None, spec, app_data_dir)?;
    }
    remove_generated_file_if_managed(&script)?;
    if let Some(memory_script) = &memory_script {
        remove_generated_file_if_managed(memory_script)?;
    }
    Ok(())
}

fn read_json_config(path: &Path, allow_jsonc: bool) -> Result<JsonValue> {
    if !path.exists() {
        return Ok(json!({}));
    }
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    let value = if allow_jsonc {
        parse_jsonc(&text)
    } else {
        serde_json::from_str(&text).map_err(anyhow::Error::from)
    }
    .with_context(|| format!("parse {}", path.display()))?;
    if !value.is_object() {
        bail!("{} root must be a JSON object", path.display());
    }
    Ok(value)
}

fn write_json_config(path: &Path, value: &JsonValue) -> Result<()> {
    ensure_parent(path)?;
    let content = format!("{}\n", serde_json::to_string_pretty(value)?);
    fs::write(path, content).with_context(|| format!("write {}", path.display()))
}

fn apply_json_hook_config(
    config: &mut JsonValue,
    spec: &AgentHookSpec,
    json_spec: JsonHookSpec,
    command: &str,
    install: bool,
) -> Result<()> {
    let events = completion_json_events(spec, json_spec);
    match json_spec.schema {
        JsonSchema::Nested => apply_nested_json(config, spec, events, command, install),
        JsonSchema::Cursor => apply_cursor_json(config, spec, events, command, install),
        JsonSchema::Antigravity => apply_antigravity_json(config, spec, events, command, install),
        JsonSchema::Copilot => apply_copilot_json(config, spec, events, command, install),
    }
}

fn completion_json_events(
    spec: &AgentHookSpec,
    json_spec: JsonHookSpec,
) -> &'static [&'static str] {
    if spec.id == "claude" {
        STOP_EVENT
    } else {
        json_spec.events
    }
}

fn apply_nested_json(
    config: &mut JsonValue,
    spec: &AgentHookSpec,
    events: &[&str],
    command: &str,
    install: bool,
) -> Result<()> {
    apply_nested_json_for_script(
        config,
        spec,
        events,
        command,
        install,
        &format!("{}-complete", spec.id),
    )
}

fn apply_nested_json_for_script(
    config: &mut JsonValue,
    spec: &AgentHookSpec,
    events: &[&str],
    command: &str,
    install: bool,
    script_stem: &str,
) -> Result<()> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| anyhow!("hook config root must be an object"))?;
    if !root.contains_key("hooks") {
        if !install {
            return Ok(());
        }
        root.insert("hooks".to_string(), json!({}));
    }
    let hooks_empty = {
        let hooks = root
            .get_mut("hooks")
            .and_then(JsonValue::as_object_mut)
            .ok_or_else(|| anyhow!("hook config 'hooks' must be an object"))?;
        for event in events {
            let current = hooks.get(*event).cloned().unwrap_or_else(|| json!([]));
            let definitions = current
                .as_array()
                .ok_or_else(|| anyhow!("hook event {event} must be an array"))?;
            let mut next = definitions
                .iter()
                .filter(|definition| !definition_mentions_managed_script(definition, script_stem))
                .cloned()
                .collect::<Vec<_>>();
            if install {
                let timeout = if spec.id == "gemini" {
                    GEMINI_TIMEOUT_MILLISECONDS
                } else {
                    HOOK_TIMEOUT_SECONDS
                };
                next.push(json!({
                    "hooks": [{
                        "type": "command",
                        "command": command,
                        "timeout": timeout,
                    }]
                }));
            }
            if next.is_empty() {
                hooks.remove(*event);
            } else {
                hooks.insert((*event).to_string(), JsonValue::Array(next));
            }
        }
        hooks.is_empty()
    };
    if hooks_empty {
        root.remove("hooks");
    }
    Ok(())
}

fn apply_cursor_json(
    config: &mut JsonValue,
    spec: &AgentHookSpec,
    events: &[&str],
    command: &str,
    install: bool,
) -> Result<()> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| anyhow!("Cursor config root must be an object"))?;
    if install {
        match root.get("version") {
            None => {
                root.insert("version".to_string(), json!(1));
            }
            Some(JsonValue::Number(version)) if version.as_u64() == Some(1) => {}
            Some(_) => bail!("Cursor hooks.json version must be 1"),
        }
    }
    if !root.contains_key("hooks") {
        if !install {
            return Ok(());
        }
        root.insert("hooks".to_string(), json!({}));
    }
    let hooks_empty = {
        let hooks = root
            .get_mut("hooks")
            .and_then(JsonValue::as_object_mut)
            .ok_or_else(|| anyhow!("Cursor hooks must be an object"))?;
        for event in events {
            let current = hooks.get(*event).cloned().unwrap_or_else(|| json!([]));
            let definitions = current
                .as_array()
                .ok_or_else(|| anyhow!("Cursor event {event} must be an array"))?;
            let mut next = definitions
                .iter()
                .filter(|definition| !definition_is_managed(definition, spec))
                .cloned()
                .collect::<Vec<_>>();
            if install {
                next.push(json!({
                    "command": command,
                    "timeout": HOOK_TIMEOUT_SECONDS,
                }));
            }
            if next.is_empty() {
                hooks.remove(*event);
            } else {
                hooks.insert((*event).to_string(), JsonValue::Array(next));
            }
        }
        hooks.is_empty()
    };
    if hooks_empty {
        root.remove("hooks");
    }
    Ok(())
}

fn apply_antigravity_json(
    config: &mut JsonValue,
    spec: &AgentHookSpec,
    events: &[&str],
    command: &str,
    install: bool,
) -> Result<()> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| anyhow!("Antigravity hooks root must be an object"))?;
    if !root.contains_key("vibelink-status") {
        if !install {
            return Ok(());
        }
        root.insert("vibelink-status".to_string(), json!({}));
    }
    let bundle_empty = {
        let bundle = root
            .get_mut("vibelink-status")
            .and_then(JsonValue::as_object_mut)
            .ok_or_else(|| anyhow!("Antigravity vibelink-status bundle must be an object"))?;
        for event in events {
            let current = bundle.get(*event).cloned().unwrap_or_else(|| json!([]));
            let definitions = current
                .as_array()
                .ok_or_else(|| anyhow!("Antigravity event {event} must be an array"))?;
            let mut next = definitions
                .iter()
                .filter(|definition| !definition_is_managed(definition, spec))
                .cloned()
                .collect::<Vec<_>>();
            if install {
                next.push(json!({
                    "command": command,
                    "timeout": HOOK_TIMEOUT_SECONDS,
                }));
            }
            if next.is_empty() {
                bundle.remove(*event);
            } else {
                bundle.insert((*event).to_string(), JsonValue::Array(next));
            }
        }
        bundle.is_empty()
    };
    if bundle_empty {
        root.remove("vibelink-status");
    }
    Ok(())
}

fn apply_copilot_json(
    config: &mut JsonValue,
    spec: &AgentHookSpec,
    events: &[&str],
    command: &str,
    install: bool,
) -> Result<()> {
    let root = config
        .as_object_mut()
        .ok_or_else(|| anyhow!("Copilot hooks root must be an object"))?;
    if install {
        match root.get("version") {
            None => {
                root.insert("version".to_string(), json!(1));
            }
            Some(JsonValue::Number(version)) if version.as_u64() == Some(1) => {}
            Some(_) => bail!("Copilot hooks version must be 1"),
        }
    }
    if !root.contains_key("hooks") {
        if !install {
            return Ok(());
        }
        root.insert("hooks".to_string(), json!({}));
    }
    let hooks_empty = {
        let hooks = root
            .get_mut("hooks")
            .and_then(JsonValue::as_object_mut)
            .ok_or_else(|| anyhow!("Copilot hooks must be an object"))?;
        for event in events {
            let current = hooks.get(*event).cloned().unwrap_or_else(|| json!([]));
            let definitions = current
                .as_array()
                .ok_or_else(|| anyhow!("Copilot event {event} must be an array"))?;
            let mut next = definitions
                .iter()
                .filter(|definition| !definition_is_managed(definition, spec))
                .cloned()
                .collect::<Vec<_>>();
            if install {
                let mut definition = JsonMap::new();
                definition.insert("type".to_string(), json!("command"));
                definition.insert(
                    if cfg!(windows) {
                        "powershell".to_string()
                    } else {
                        "bash".to_string()
                    },
                    json!(command),
                );
                definition.insert("timeoutSec".to_string(), json!(HOOK_TIMEOUT_SECONDS));
                next.push(JsonValue::Object(definition));
            }
            if next.is_empty() {
                hooks.remove(*event);
            } else {
                hooks.insert((*event).to_string(), JsonValue::Array(next));
            }
        }
        hooks.is_empty()
    };
    if hooks_empty {
        root.remove("hooks");
    }
    Ok(())
}

fn managed_json_event_count(
    config: &JsonValue,
    spec: &AgentHookSpec,
    json_spec: JsonHookSpec,
) -> Result<usize> {
    let root = config
        .as_object()
        .ok_or_else(|| anyhow!("hook config root must be an object"))?;
    let event_root = match json_spec.schema {
        JsonSchema::Antigravity => match root.get("vibelink-status") {
            None => return Ok(0),
            Some(value) => value
                .as_object()
                .ok_or_else(|| anyhow!("Antigravity vibelink-status bundle must be an object"))?,
        },
        _ => match root.get("hooks") {
            None => return Ok(0),
            Some(value) => value
                .as_object()
                .ok_or_else(|| anyhow!("hook config 'hooks' must be an object"))?,
        },
    };

    let mut count = 0;
    for event in completion_json_events(spec, json_spec) {
        let Some(value) = event_root.get(*event) else {
            continue;
        };
        let definitions = value
            .as_array()
            .ok_or_else(|| anyhow!("hook event {event} must be an array"))?;
        if definitions
            .iter()
            .any(|definition| definition_is_managed(definition, spec))
        {
            count += 1;
        }
    }
    Ok(count)
}

fn managed_nested_event_count(
    config: &JsonValue,
    events: &[&str],
    script_stem: &str,
) -> Result<usize> {
    let root = config
        .as_object()
        .ok_or_else(|| anyhow!("hook config root must be an object"))?;
    let Some(hooks) = root.get("hooks") else {
        return Ok(0);
    };
    let hooks = hooks
        .as_object()
        .ok_or_else(|| anyhow!("hook config 'hooks' must be an object"))?;
    let mut count = 0;
    for event in events {
        let Some(definitions) = hooks.get(*event) else {
            continue;
        };
        let definitions = definitions
            .as_array()
            .ok_or_else(|| anyhow!("hook event {event} must be an array"))?;
        if definitions
            .iter()
            .any(|definition| definition_mentions_managed_script(definition, script_stem))
        {
            count += 1;
        }
    }
    Ok(count)
}

fn managed_nested_group_index(
    config: &JsonValue,
    spec: &AgentHookSpec,
    event: &str,
) -> Option<usize> {
    config
        .get("hooks")?
        .get(event)?
        .as_array()?
        .iter()
        .position(|definition| definition_is_managed(definition, spec))
}

fn definition_is_managed(definition: &JsonValue, spec: &AgentHookSpec) -> bool {
    definition_mentions_managed_script(definition, &format!("{}-complete", spec.id))
}

fn definition_mentions_managed_script(definition: &JsonValue, script_stem: &str) -> bool {
    let Some(object) = definition.as_object() else {
        return false;
    };
    for key in ["command", "powershell", "bash"] {
        if object
            .get(key)
            .and_then(JsonValue::as_str)
            .is_some_and(|command| command_mentions_script(command, script_stem))
        {
            return true;
        }
    }
    object
        .get("hooks")
        .and_then(JsonValue::as_array)
        .is_some_and(|handlers| {
            handlers.iter().any(|handler| {
                handler
                    .get("command")
                    .and_then(JsonValue::as_str)
                    .is_some_and(|command| command_mentions_script(command, script_stem))
            })
        })
}

fn command_mentions_script(command: &str, script_stem: &str) -> bool {
    let decoded = decode_powershell_encoded_command(command).unwrap_or_default();
    let normalized = format!("{command}\n{decoded}")
        .replace('\\', "/")
        .to_lowercase();
    normalized.contains(&format!("/{}.", script_stem.to_lowercase()))
}

fn managed_command(_spec: &AgentHookSpec, json_spec: JsonHookSpec, script_path: &Path) -> String {
    if !cfg!(windows) {
        return wrap_posix_hook_command(&script_path.to_string_lossy());
    }
    match json_spec.command_style {
        WindowsCommandStyle::GitBash => wrap_windows_git_bash_hook_command(script_path),
        WindowsCommandStyle::Direct => wrap_windows_direct_hook_command(script_path),
        WindowsCommandStyle::PowerShell => wrap_windows_powershell_hook_command(script_path),
    }
}

fn claude_memory_command(script_path: &Path) -> String {
    if cfg!(windows) {
        wrap_windows_powershell_hook_command(script_path)
    } else {
        wrap_posix_hook_command(&script_path.to_string_lossy())
    }
}

fn render_managed_script(spec: &AgentHookSpec) -> Result<String> {
    if cfg!(windows) {
        if spec.id == "antigravity" {
            render_antigravity_batch(spec)
        } else if spec.id == "copilot" {
            render_powershell_script(spec)
        } else if spec.id == "kimi" {
            render_posix_script(spec)
        } else {
            render_batch_script(spec)
        }
    } else {
        render_posix_script(spec)
    }
}

fn write_managed_script(spec: &AgentHookSpec, path: &Path) -> Result<()> {
    ensure_parent(path)?;
    fs::write(path, render_managed_script(spec)?)
        .with_context(|| format!("write {}", path.display()))?;
    set_executable_if_posix(path)?;
    Ok(())
}

fn write_claude_memory_script(path: &Path) -> Result<()> {
    ensure_parent(path)?;
    fs::write(path, render_claude_memory_script()?)
        .with_context(|| format!("write {}", path.display()))?;
    set_executable_if_posix(path)
}

fn render_claude_memory_script() -> Result<String> {
    Ok(render_claude_memory_script_for_cli(&hook_cli_path()?))
}

fn render_claude_memory_script_for_cli(cli: &Path) -> String {
    if cfg!(windows) {
        return format!(
            "# {HOOK_MARKER}\n[Console]::In.ReadToEnd() | Out-Null\nif (-not $env:VIBELINK_SESSION_ID) {{ exit 0 }}\ntry {{\n  $raw = & {} --json memory list --workspace $env:VIBELINK_SESSION_ID --limit 500 2>$null\n  if ($LASTEXITCODE -ne 0) {{ exit 0 }}\n  $payload = $raw | ConvertFrom-Json\n  if ($payload.ok -ne $true) {{ exit 0 }}\n  $count = @($payload.result.entries).Count\n  if ($count -gt 0) {{\n    [Console]::Out.WriteLine('VibeLink workspace memory has {{0}} entries. Run `vibelink memory search --query \"<terms>\"` before investigating anything non-trivial here.' -f $count)\n  }}\n}} catch {{ }}\nexit 0\n",
            quote_powershell(&cli.to_string_lossy()),
        );
    }

    format!(
        "#!/bin/sh\n# {HOOK_MARKER}\ncat >/dev/null\n[ -n \"$VIBELINK_SESSION_ID\" ] || exit 0\noutput=$({} memory list --workspace \"$VIBELINK_SESSION_ID\" --limit 500 2>/dev/null) || exit 0\ncount=$(printf '%s\\n' \"$output\" | grep -c '^      \"id\":' 2>/dev/null) || exit 0\ncase \"$count\" in ''|*[!0-9]*) exit 0 ;; esac\n[ \"$count\" -gt 0 ] || exit 0\nprintf 'VibeLink workspace memory has %s entries. Run `vibelink memory search --query \"<terms>\"` before investigating anything non-trivial here.\\n' \"$count\"\nexit 0\n",
        quote_posix(&cli.to_string_lossy())
    )
}

fn render_batch_script(spec: &AgentHookSpec) -> Result<String> {
    let cli = hook_cli_path()?;
    let output = if spec.id == "gemini" {
        "echo {}\r\n"
    } else {
        ""
    };
    Ok(format!(
        "@echo off\r\nrem {HOOK_MARKER}\r\n\"%SystemRoot%\\System32\\more.com\" >nul 2>nul\r\nif not \"%VIBELINK_SESSION_ID%\"==\"\" if not \"%VIBELINK_PANE_ID%\"==\"\" \"{}\" terminal complete --workspace \"%VIBELINK_SESSION_ID%\" --pane \"%VIBELINK_PANE_ID%\" --agent-id \"{}\" >nul 2>nul\r\n{output}exit /b 0\r\n",
        cli.display(),
        spec.id,
    ))
}

fn render_powershell_script(spec: &AgentHookSpec) -> Result<String> {
    let cli = hook_cli_path()?;
    Ok(format!(
        "# {HOOK_MARKER}\n[Console]::In.ReadToEnd() | Out-Null\nif ($env:VIBELINK_SESSION_ID -and $env:VIBELINK_PANE_ID) {{\n  & {} terminal complete --workspace $env:VIBELINK_SESSION_ID --pane $env:VIBELINK_PANE_ID --agent-id {} *> $null\n}}\nexit 0\n",
        quote_powershell(&cli.to_string_lossy()),
        quote_powershell(spec.id),
    ))
}

fn render_antigravity_batch(spec: &AgentHookSpec) -> Result<String> {
    let cli = hook_cli_path()?;
    let powershell = format!(
        "$raw=[Console]::In.ReadToEnd(); Write-Output '{{\"decision\":\"\"}}'; try {{ $payload=if ([string]::IsNullOrWhiteSpace($raw)) {{ @{{}} }} else {{ $raw | ConvertFrom-Json }} }} catch {{ exit 0 }}; if ($payload.fullyIdle -eq $false -or $payload.fully_idle -eq $false) {{ exit 0 }}; if ($env:VIBELINK_SESSION_ID -and $env:VIBELINK_PANE_ID) {{ & {} terminal complete --workspace $env:VIBELINK_SESSION_ID --pane $env:VIBELINK_PANE_ID --agent-id {} *> $null }}; exit 0",
        quote_powershell(&cli.to_string_lossy()),
        quote_powershell(spec.id),
    );
    Ok(format!(
        "@echo off\r\nrem {HOOK_MARKER}\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}\r\nexit /b 0\r\n",
        encode_powershell_command(&powershell)
    ))
}

fn render_posix_script(spec: &AgentHookSpec) -> Result<String> {
    let cli = hook_cli_path()?;
    let cli_path = if cfg!(windows) {
        to_git_bash_path(&cli.to_string_lossy())
    } else {
        cli.to_string_lossy().to_string()
    };
    let mut lines = vec![
        "#!/bin/sh".to_string(),
        format!("# {HOOK_MARKER}"),
        "payload=$(cat)".to_string(),
    ];
    if spec.id == "antigravity" {
        lines.push("printf '{\"decision\":\"\"}\\n'".to_string());
        lines.push("case \"$payload\" in".to_string());
        lines.push("  *'\"fullyIdle\":false'*|*'\"fullyIdle\": false'*|*'\"fully_idle\":false'*|*'\"fully_idle\": false'*) exit 0 ;;".to_string());
        lines.push("esac".to_string());
    }
    lines.push(
        "if [ -n \"$VIBELINK_SESSION_ID\" ] && [ -n \"$VIBELINK_PANE_ID\" ]; then".to_string(),
    );
    lines.push(format!(
        "  {} terminal complete --workspace \"$VIBELINK_SESSION_ID\" --pane \"$VIBELINK_PANE_ID\" --agent-id {} >/dev/null 2>&1 || true",
        quote_posix(&cli_path),
        quote_posix(spec.id),
    ));
    lines.push("fi".to_string());
    if spec.id == "gemini" {
        lines.push("printf '{}\\n'".to_string());
    }
    lines.push("exit 0".to_string());
    lines.push(String::new());
    Ok(lines.join("\n"))
}

fn inspect_drop_in_hook(
    spec: &AgentHookSpec,
    kind: DropInKind,
    path: &Path,
) -> Result<HookInspection> {
    match generated_file_state(path)? {
        GeneratedFileState::Absent => Ok(HookInspection {
            installed: false,
            blocked_reason: None,
        }),
        GeneratedFileState::Managed => {
            rewrite_managed_file_if_stale(path, &render_drop_in_hook(spec, kind)?, false)?;
            Ok(HookInspection {
                installed: true,
                blocked_reason: None,
            })
        }
        GeneratedFileState::Conflict => {
            bail!("{} exists but is not owned by VibeLink", path.display())
        }
    }
}

fn render_drop_in_hook(spec: &AgentHookSpec, kind: DropInKind) -> Result<String> {
    let cli = hook_cli_path()?;
    Ok(match kind {
        DropInKind::Amp => render_amp_plugin(&cli, spec.id),
        DropInKind::OpenCode | DropInKind::MimoCode => render_opencode_plugin(&cli, spec.id),
        DropInKind::Pi | DropInKind::Omp => render_pi_extension(&cli, spec.id),
    })
}

fn install_drop_in_hook(spec: &AgentHookSpec, kind: DropInKind, path: &Path) -> Result<()> {
    ensure_generated_file_writable(path)?;
    let source = render_drop_in_hook(spec, kind)?;
    ensure_parent(path)?;
    fs::write(path, source).with_context(|| format!("write {}", path.display()))?;
    if matches!(kind, DropInKind::Omp) {
        remove_legacy_omp_pre_hook()?;
    }
    Ok(())
}

fn uninstall_drop_in_hook(_spec: &AgentHookSpec, kind: DropInKind, path: &Path) -> Result<()> {
    remove_generated_file_if_managed(path)?;
    if matches!(kind, DropInKind::Omp) {
        remove_legacy_omp_pre_hook()?;
    }
    Ok(())
}

fn render_amp_plugin(cli: &Path, agent_id: &str) -> String {
    format!(
        "import {{ execFile }} from 'node:child_process'\nimport type {{ PluginAPI }} from '@ampcode/plugin'\n\n// {HOOK_MARKER}\nconst cliPath = {}\nconst agentId = {}\n\nfunction reportCompletion(): void {{\n  if (!process.env.VIBELINK_SESSION_ID || !process.env.VIBELINK_PANE_ID) return\n  try {{\n    const child = execFile(cliPath, ['terminal', 'complete', '--workspace', process.env.VIBELINK_SESSION_ID, '--pane', process.env.VIBELINK_PANE_ID, '--agent-id', agentId], {{ windowsHide: true }})\n    child.unref()\n  }} catch {{}}\n}}\n\nexport default function (amp: PluginAPI) {{\n  amp.on('agent.end', (event) => {{\n    if (event?.status === 'cancelled') return\n    reportCompletion()\n  }})\n}}\n",
        json_string(&cli.to_string_lossy()),
        json_string(agent_id),
    )
}

fn remove_legacy_shared_script(spec: &AgentHookSpec, current_app_data_dir: &Path) -> Result<()> {
    let Some(roaming) = user_app_data() else {
        return Ok(());
    };
    let legacy = roaming
        .join("vibelink")
        .join("VibeLink")
        .join("data")
        .join("agent-hooks")
        .join(format!("{}-complete.cmd", spec.id));
    if legacy != script_path(spec, current_app_data_dir) {
        remove_generated_file_if_managed(&legacy)?;
    }
    Ok(())
}

fn render_opencode_plugin(cli: &Path, agent_id: &str) -> String {
    format!(
        "// {HOOK_MARKER}\nimport {{ spawn }} from 'node:child_process'\n\nconst cliPath = {}\nconst agentId = {}\n\nfunction reportCompletion() {{\n  if (!process.env.VIBELINK_SESSION_ID || !process.env.VIBELINK_PANE_ID) return\n  try {{\n    const child = spawn(cliPath, ['terminal', 'complete', '--workspace', process.env.VIBELINK_SESSION_ID, '--pane', process.env.VIBELINK_PANE_ID, '--agent-id', agentId], {{ detached: true, stdio: 'ignore', windowsHide: true }})\n    child.unref()\n  }} catch {{}}\n}}\n\nexport const VibeLinkCompletion = async ({{ client }}) => ({{\n  event: async ({{ event }}) => {{\n    if (event.type !== 'session.idle') return\n    const sessionID = event.properties?.sessionID\n    if (!sessionID) return\n    try {{\n      const response = await client.session.get({{ path: {{ id: sessionID }} }})\n      const session = response?.data ?? response\n      if (session?.parentID) return\n    }} catch {{\n      return\n    }}\n    reportCompletion()\n  }},\n}})\n",
        json_string(&cli.to_string_lossy()),
        json_string(agent_id),
    )
}

fn render_pi_extension(cli: &Path, agent_id: &str) -> String {
    format!(
        "import {{ execFile }} from 'node:child_process'\n\n// {HOOK_MARKER}\nconst cliPath = {}\nconst agentId = {}\n\nfunction reportCompletion() {{\n  if (!process.env.VIBELINK_SESSION_ID || !process.env.VIBELINK_PANE_ID) return\n  try {{\n    const child = execFile(cliPath, ['terminal', 'complete', '--workspace', process.env.VIBELINK_SESSION_ID, '--pane', process.env.VIBELINK_PANE_ID, '--agent-id', agentId], {{ windowsHide: true }})\n    child.unref()\n  }} catch {{}}\n}}\n\nexport default function (pi) {{\n  let pending = null\n  let settledSupported = false\n\n  const clearPending = () => {{\n    clearTimeout(pending)\n    pending = null\n  }}\n\n  const reportWhenIdle = (ctx) => {{\n    clearPending()\n    const check = () => {{\n      if (typeof ctx?.isIdle === 'function' && !ctx.isIdle()) {{\n        pending = setTimeout(check, 125)\n        return\n      }}\n      pending = null\n      reportCompletion()\n    }}\n    pending = setTimeout(check, 0)\n  }}\n\n  pi.on('agent_start', clearPending)\n  pi.on('session_shutdown', clearPending)\n  pi.on('agent_settled', (_event, _ctx) => {{\n    settledSupported = true\n    clearPending()\n    reportCompletion()\n  }})\n  pi.on('agent_end', (event, ctx) => {{\n    if (event?.reason === 'reload' || settledSupported) return\n    reportWhenIdle(ctx)\n  }})\n}}\n",
        json_string(&cli.to_string_lossy()),
        json_string(agent_id),
    )
}

fn remove_legacy_omp_pre_hook() -> Result<()> {
    let path = user_home().join(".omp/agent/hooks/pre/vibelink-complete.ts");
    remove_generated_file_if_managed(&path)
}

fn inspect_kimi_hook(
    spec: &AgentHookSpec,
    app_data_dir: &Path,
    config_path: &Path,
) -> Result<HookInspection> {
    let text = if config_path.exists() {
        fs::read_to_string(config_path)
            .with_context(|| format!("read {}", config_path.display()))?
    } else {
        String::new()
    };
    let block = extract_kimi_block(&text)?;
    let script = script_path(spec, app_data_dir);
    let script_state = generated_file_state(&script)?;
    if script_state == GeneratedFileState::Conflict {
        bail!("{} exists but is not owned by VibeLink", script.display());
    }
    let expected_command = kimi_command(&script);
    let installed = block.is_some_and(|block| block.contains(&expected_command))
        && script_state == GeneratedFileState::Managed;
    if installed {
        rewrite_managed_file_if_stale(&script, &render_managed_script(spec)?, true)?;
    }
    Ok(HookInspection {
        installed,
        blocked_reason: None,
    })
}

fn install_kimi_hook(spec: &AgentHookSpec, app_data_dir: &Path, config_path: &Path) -> Result<()> {
    let script = script_path(spec, app_data_dir);
    ensure_generated_file_writable(&script)?;
    write_managed_script(spec, &script)?;
    let text = if config_path.exists() {
        fs::read_to_string(config_path)
            .with_context(|| format!("read {}", config_path.display()))?
    } else {
        String::new()
    };
    let (mut clean, _) = remove_kimi_blocks(&text)?;
    if !clean.is_empty() && !clean.ends_with('\n') {
        clean.push('\n');
    }
    if !clean.is_empty() && !clean.ends_with("\n\n") {
        clean.push('\n');
    }
    clean.push_str(KIMI_BLOCK_START);
    clean.push('\n');
    clean.push_str("[[hooks]]\n");
    clean.push_str("event = \"Stop\"\n");
    clean.push_str(&format!(
        "command = \"{}\"\n",
        escape_toml_basic(&kimi_command(&script))
    ));
    clean.push_str(KIMI_BLOCK_END);
    clean.push('\n');
    ensure_parent(config_path)?;
    fs::write(config_path, clean).with_context(|| format!("write {}", config_path.display()))
}

fn uninstall_kimi_hook(
    spec: &AgentHookSpec,
    app_data_dir: &Path,
    config_path: &Path,
) -> Result<()> {
    if config_path.exists() {
        let text = fs::read_to_string(config_path)
            .with_context(|| format!("read {}", config_path.display()))?;
        let (clean, changed) = remove_kimi_blocks(&text)?;
        if changed {
            fs::write(config_path, clean)
                .with_context(|| format!("write {}", config_path.display()))?;
        }
    }
    remove_generated_file_if_managed(&script_path(spec, app_data_dir))
}

fn extract_kimi_block(text: &str) -> Result<Option<&str>> {
    let Some(start) = text.find(KIMI_BLOCK_START) else {
        return Ok(None);
    };
    let Some(end_relative) = text[start..].find(KIMI_BLOCK_END) else {
        bail!("Kimi config contains an unterminated VibeLink hook block");
    };
    let end = start + end_relative + KIMI_BLOCK_END.len();
    Ok(Some(&text[start..end]))
}

fn remove_kimi_blocks(text: &str) -> Result<(String, bool)> {
    let mut output = text.to_string();
    let mut changed = false;
    while let Some(start) = output.find(KIMI_BLOCK_START) {
        let Some(end_relative) = output[start..].find(KIMI_BLOCK_END) else {
            bail!("Kimi config contains an unterminated VibeLink hook block");
        };
        let mut end = start + end_relative + KIMI_BLOCK_END.len();
        if output[end..].starts_with("\r\n") {
            end += 2;
        } else if output[end..].starts_with('\n') {
            end += 1;
        }
        output.replace_range(start..end, "");
        changed = true;
    }
    Ok((output, changed))
}

fn kimi_command(script: &Path) -> String {
    let path = if cfg!(windows) {
        to_git_bash_path(&script.to_string_lossy())
    } else {
        script.to_string_lossy().to_string()
    };
    wrap_posix_hook_command(&path)
}

fn inspect_hermes_hook(config_path: &Path) -> Result<HookInspection> {
    let plugin_dir = hermes_plugin_dir(config_path)?;
    let manifest = plugin_dir.join("plugin.yaml");
    let init = plugin_dir.join("__init__.py");
    let manifest_state = generated_file_state(&manifest)?;
    let init_state = generated_file_state(&init)?;
    for (path, state) in [(&manifest, manifest_state), (&init, init_state)] {
        if state == GeneratedFileState::Conflict {
            bail!("{} exists but is not owned by VibeLink", path.display());
        }
    }
    let config = read_hermes_config(config_path)?;
    let enabled = hermes_plugin_enabled(&config)?;
    let installed = enabled
        && manifest_state == GeneratedFileState::Managed
        && init_state == GeneratedFileState::Managed;
    if installed {
        rewrite_managed_file_if_stale(&manifest, &render_hermes_manifest(), false)?;
        let cli = hook_cli_path()?;
        rewrite_managed_file_if_stale(&init, &render_hermes_plugin(&cli), false)?;
    }
    Ok(HookInspection {
        installed,
        blocked_reason: None,
    })
}

fn install_hermes_hook(config_path: &Path) -> Result<()> {
    let plugin_dir = hermes_plugin_dir(config_path)?;
    let manifest = plugin_dir.join("plugin.yaml");
    let init = plugin_dir.join("__init__.py");
    ensure_generated_file_writable(&manifest)?;
    ensure_generated_file_writable(&init)?;
    fs::create_dir_all(&plugin_dir).with_context(|| format!("create {}", plugin_dir.display()))?;
    fs::write(&manifest, render_hermes_manifest())
        .with_context(|| format!("write {}", manifest.display()))?;
    let cli = hook_cli_path()?;
    fs::write(&init, render_hermes_plugin(&cli))
        .with_context(|| format!("write {}", init.display()))?;
    let mut config = read_hermes_config(config_path)?;
    set_hermes_plugin_enabled(&mut config, true)?;
    write_hermes_config(config_path, &config)
}

fn uninstall_hermes_hook(config_path: &Path) -> Result<()> {
    let plugin_dir = hermes_plugin_dir(config_path)?;
    remove_generated_file_if_managed(&plugin_dir.join("plugin.yaml"))?;
    remove_generated_file_if_managed(&plugin_dir.join("__init__.py"))?;
    remove_empty_dir(&plugin_dir)?;
    if config_path.exists() {
        let mut config = read_hermes_config(config_path)?;
        set_hermes_plugin_enabled(&mut config, false)?;
        write_hermes_config(config_path, &config)?;
    }
    Ok(())
}

fn hermes_plugin_dir(config_path: &Path) -> Result<PathBuf> {
    let home = config_path
        .parent()
        .ok_or_else(|| anyhow!("Hermes config path has no parent"))?;
    Ok(home.join("plugins").join(HERMES_PLUGIN_NAME))
}

fn read_hermes_config(path: &Path) -> Result<serde_yaml::Value> {
    if !path.exists() {
        return Ok(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    }
    let text = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if text.trim().is_empty() {
        return Ok(serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    }
    let value: serde_yaml::Value =
        serde_yaml::from_str(&text).with_context(|| format!("parse {}", path.display()))?;
    if !value.is_mapping() {
        bail!("Hermes config.yaml root must be a mapping");
    }
    Ok(value)
}

fn write_hermes_config(path: &Path, value: &serde_yaml::Value) -> Result<()> {
    ensure_parent(path)?;
    let mut text = serde_yaml::to_string(value)?;
    if !text.ends_with('\n') {
        text.push('\n');
    }
    fs::write(path, text).with_context(|| format!("write {}", path.display()))
}

fn hermes_plugin_enabled(config: &serde_yaml::Value) -> Result<bool> {
    let Some(root) = config.as_mapping() else {
        bail!("Hermes config.yaml root must be a mapping");
    };
    let Some(plugins_value) = root.get(serde_yaml::Value::String("plugins".to_string())) else {
        return Ok(false);
    };
    let plugins = plugins_value
        .as_mapping()
        .ok_or_else(|| anyhow!("Hermes plugins must be a mapping"))?;
    let enabled = yaml_string_list(plugins, "enabled")?.unwrap_or_default();
    let disabled = yaml_string_list(plugins, "disabled")?.unwrap_or_default();
    Ok(enabled.iter().any(|name| name == HERMES_PLUGIN_NAME)
        && !disabled.iter().any(|name| name == HERMES_PLUGIN_NAME))
}

fn set_hermes_plugin_enabled(config: &mut serde_yaml::Value, enabled: bool) -> Result<()> {
    let root = config
        .as_mapping_mut()
        .ok_or_else(|| anyhow!("Hermes config.yaml root must be a mapping"))?;
    let plugins_key = serde_yaml::Value::String("plugins".to_string());
    if !root.contains_key(&plugins_key) {
        root.insert(
            plugins_key.clone(),
            serde_yaml::Value::Mapping(serde_yaml::Mapping::new()),
        );
    }
    let plugins = root
        .get_mut(&plugins_key)
        .and_then(serde_yaml::Value::as_mapping_mut)
        .ok_or_else(|| anyhow!("Hermes plugins must be a mapping"))?;
    let mut enabled_names = yaml_string_list(plugins, "enabled")?.unwrap_or_default();
    let mut disabled_names = yaml_string_list(plugins, "disabled")?.unwrap_or_default();
    if enabled {
        enabled_names.push(HERMES_PLUGIN_NAME.to_string());
        enabled_names.sort();
        enabled_names.dedup();
        disabled_names.retain(|name| name != HERMES_PLUGIN_NAME);
    } else {
        enabled_names.retain(|name| name != HERMES_PLUGIN_NAME);
    }
    plugins.insert(
        serde_yaml::Value::String("enabled".to_string()),
        serde_yaml::Value::Sequence(
            enabled_names
                .into_iter()
                .map(serde_yaml::Value::String)
                .collect(),
        ),
    );
    if plugins.contains_key(serde_yaml::Value::String("disabled".to_string())) || enabled {
        plugins.insert(
            serde_yaml::Value::String("disabled".to_string()),
            serde_yaml::Value::Sequence(
                disabled_names
                    .into_iter()
                    .map(serde_yaml::Value::String)
                    .collect(),
            ),
        );
    }
    Ok(())
}

fn yaml_string_list(mapping: &serde_yaml::Mapping, key: &str) -> Result<Option<Vec<String>>> {
    let Some(value) = mapping.get(serde_yaml::Value::String(key.to_string())) else {
        return Ok(None);
    };
    let sequence = value
        .as_sequence()
        .ok_or_else(|| anyhow!("Hermes plugins.{key} must be a string list"))?;
    sequence
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_string)
                .ok_or_else(|| anyhow!("Hermes plugins.{key} must be a string list"))
        })
        .collect::<Result<Vec<_>>>()
        .map(Some)
}

fn render_hermes_manifest() -> String {
    format!(
        "# {HOOK_MARKER}\nname: {HERMES_PLUGIN_NAME}\nversion: 1.0.0\ndescription: \"Reports completed Hermes turns to VibeLink.\"\nauthor: \"VibeLink\"\nkind: standalone\nprovides_hooks:\n  - pre_llm_call\n  - post_llm_call\n  - pre_tool_call\n  - on_session_end\n"
    )
}

fn render_hermes_plugin(cli: &Path) -> String {
    format!(
        "# {HOOK_MARKER}\nfrom __future__ import annotations\n\nimport os\nimport subprocess\nimport threading\nfrom typing import Any\n\nCLI_PATH = {}\nAGENT_ID = \"hermes\"\n_lock = threading.Lock()\n_timer: threading.Timer | None = None\n_reported = False\n\ndef _cancel_pending(*_args: Any, **_kwargs: Any) -> None:\n    global _timer, _reported\n    with _lock:\n        timer = _timer\n        _timer = None\n        _reported = False\n    if timer is not None:\n        timer.cancel()\n\ndef _report_completion() -> None:\n    global _timer, _reported\n    with _lock:\n        if _reported:\n            return\n        _reported = True\n        _timer = None\n    session_id = os.environ.get(\"VIBELINK_SESSION_ID\", \"\")\n    pane_id = os.environ.get(\"VIBELINK_PANE_ID\", \"\")\n    if not session_id or not pane_id:\n        return\n    try:\n        subprocess.Popen(\n            [CLI_PATH, \"terminal\", \"complete\", \"--workspace\", session_id, \"--pane\", pane_id, \"--agent-id\", AGENT_ID],\n            stdin=subprocess.DEVNULL,\n            stdout=subprocess.DEVNULL,\n            stderr=subprocess.DEVNULL,\n            creationflags=getattr(subprocess, \"CREATE_NO_WINDOW\", 0),\n        )\n    except OSError:\n        pass\n\ndef _schedule_completion(**_kwargs: Any) -> None:\n    global _timer\n    with _lock:\n        if _timer is not None:\n            _timer.cancel()\n        _timer = threading.Timer(0.75, _report_completion)\n        _timer.daemon = True\n        _timer.start()\n\ndef _session_end(**_kwargs: Any) -> None:\n    _cancel_pending()\n    _report_completion()\n\ndef register(ctx: Any) -> None:\n    ctx.register_hook(\"pre_llm_call\", _cancel_pending)\n    ctx.register_hook(\"pre_tool_call\", _cancel_pending)\n    ctx.register_hook(\"post_llm_call\", _schedule_completion)\n    ctx.register_hook(\"on_session_end\", _session_end)\n",
        json_string(&cli.to_string_lossy()),
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum GeneratedFileState {
    Absent,
    Managed,
    Conflict,
}

fn generated_file_state(path: &Path) -> Result<GeneratedFileState> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return Ok(GeneratedFileState::Absent);
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Ok(GeneratedFileState::Conflict);
    }
    let content = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    Ok(if content_is_vibelink_managed(&content) {
        GeneratedFileState::Managed
    } else {
        GeneratedFileState::Conflict
    })
}
fn content_is_vibelink_managed(content: &str) -> bool {
    content.contains(HOOK_MARKER)
        || (content.contains("vibelink-agent-hook v")
            && (content.contains("generated by VibeLink")
                || content.contains("retired compatibility launcher")))
}

fn rewrite_managed_file_if_stale(path: &Path, expected: &str, executable: bool) -> Result<()> {
    if generated_file_state(path)? != GeneratedFileState::Managed {
        return Ok(());
    }
    let current = fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
    if current == expected {
        return Ok(());
    }
    fs::write(path, expected).with_context(|| format!("rewrite {}", path.display()))?;
    if executable {
        set_executable_if_posix(path)?;
    }
    Ok(())
}

fn ensure_generated_file_writable(path: &Path) -> Result<()> {
    if generated_file_state(path)? == GeneratedFileState::Conflict {
        bail!(
            "{} already exists and is not owned by VibeLink",
            path.display()
        );
    }
    Ok(())
}

fn remove_generated_file_if_managed(path: &Path) -> Result<()> {
    if generated_file_state(path)? == GeneratedFileState::Managed {
        fs::remove_file(path).with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

fn remove_empty_dir(path: &Path) -> Result<()> {
    if path.is_dir()
        && fs::read_dir(path)
            .with_context(|| format!("read {}", path.display()))?
            .next()
            .is_none()
    {
        fs::remove_dir(path).with_context(|| format!("remove {}", path.display()))?;
    }
    Ok(())
}

fn ensure_parent(path: &Path) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).with_context(|| format!("create {}", parent.display()))
}

fn set_executable_if_posix(_path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(_path)?.permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(_path, permissions)?;
    }
    Ok(())
}

fn wrap_posix_hook_command(path: &str) -> String {
    let quoted = quote_posix(path);
    format!("if [ -f {quoted} ] && [ -r {quoted} ]; then /bin/sh {quoted}; else cat >/dev/null; fi")
}

fn wrap_windows_git_bash_hook_command(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    if normalized.chars().all(is_git_bash_safe_char) {
        let quoted = quote_posix(&normalized);
        format!("if [ -f {quoted} ]; then {quoted}; else cat >/dev/null; fi")
    } else {
        wrap_windows_powershell_hook_command(path)
    }
}

fn wrap_windows_direct_hook_command(path: &Path) -> String {
    let value = path.to_string_lossy();
    if value.chars().all(is_windows_direct_safe_char) {
        value.to_string()
    } else {
        wrap_windows_powershell_hook_command(path)
    }
}

fn wrap_windows_powershell_hook_command(path: &Path) -> String {
    let quoted = quote_powershell(&path.to_string_lossy());
    let command = format!(
        "if (Test-Path -LiteralPath {quoted} -PathType Leaf) {{ & {quoted}; exit $LASTEXITCODE }}; [Console]::In.ReadToEnd() | Out-Null; exit 0"
    );
    let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    let powershell = format!(
        "{}/System32/WindowsPowerShell/v1.0/powershell.exe",
        system_root.replace('\\', "/")
    );
    format!(
        "{powershell} -NoProfile -ExecutionPolicy Bypass -EncodedCommand {}",
        encode_powershell_command(&command)
    )
}

fn encode_powershell_command(command: &str) -> String {
    let bytes = command
        .encode_utf16()
        .flat_map(u16::to_le_bytes)
        .collect::<Vec<_>>();
    BASE64_STANDARD.encode(bytes)
}

fn decode_powershell_encoded_command(command: &str) -> Option<String> {
    let marker = "-EncodedCommand";
    let index = command
        .to_ascii_lowercase()
        .find(&marker.to_ascii_lowercase())?;
    let encoded = command[index + marker.len()..].split_whitespace().next()?;
    let bytes = BASE64_STANDARD.decode(encoded).ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units = bytes
        .chunks_exact(2)
        .map(|chunk| u16::from_le_bytes([chunk[0], chunk[1]]))
        .collect::<Vec<_>>();
    String::from_utf16(&units).ok()
}

fn quote_posix(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn quote_powershell(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn is_git_bash_safe_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || "_.:/~-".contains(character)
}

fn is_windows_direct_safe_char(character: char) -> bool {
    character.is_ascii_alphanumeric() || "_.:\\~-".contains(character)
}

fn to_git_bash_path(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let bytes = normalized.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b':' && bytes[2] == b'/' {
        format!(
            "/{}/{}",
            (bytes[0] as char).to_ascii_lowercase(),
            &normalized[3..]
        )
    } else {
        normalized
    }
}

fn json_string(value: &str) -> String {
    serde_json::to_string(value).expect("serialize string")
}

fn escape_toml_basic(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

fn parse_jsonc(input: &str) -> Result<JsonValue> {
    let without_comments = strip_json_comments(input.as_bytes())?;
    let without_trailing_commas = strip_trailing_json_commas(&without_comments);
    serde_json::from_slice(&without_trailing_commas).map_err(anyhow::Error::from)
}

fn strip_json_comments(input: &[u8]) -> Result<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < input.len() {
        let byte = input[index];
        if in_string {
            output.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            output.push(byte);
            index += 1;
            continue;
        }
        if byte == b'/' && input.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < input.len() && input[index] != b'\n' {
                index += 1;
            }
            continue;
        }
        if byte == b'/' && input.get(index + 1) == Some(&b'*') {
            index += 2;
            let mut closed = false;
            while index + 1 < input.len() {
                if input[index] == b'\n' {
                    output.push(b'\n');
                }
                if input[index] == b'*' && input[index + 1] == b'/' {
                    index += 2;
                    closed = true;
                    break;
                }
                index += 1;
            }
            if !closed {
                bail!("unterminated JSONC block comment");
            }
            continue;
        }
        output.push(byte);
        index += 1;
    }
    Ok(output)
}

fn strip_trailing_json_commas(input: &[u8]) -> Vec<u8> {
    let mut output = Vec::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    let mut escaped = false;
    while index < input.len() {
        let byte = input[index];
        if in_string {
            output.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            in_string = true;
            output.push(byte);
            index += 1;
            continue;
        }
        if byte == b',' {
            let mut lookahead = index + 1;
            while lookahead < input.len() && input[lookahead].is_ascii_whitespace() {
                lookahead += 1;
            }
            if matches!(input.get(lookahead), Some(b'}' | b']')) {
                index += 1;
                continue;
            }
        }
        output.push(byte);
        index += 1;
    }
    output
}

fn codex_config_toml_path(hooks_path: &Path) -> Result<PathBuf> {
    let parent = hooks_path
        .parent()
        .ok_or_else(|| anyhow!("Codex hooks path has no parent"))?;
    Ok(parent.join("config.toml"))
}

fn codex_trust_is_current(
    hooks_path: &Path,
    group_index: usize,
    spec: &AgentHookSpec,
    app_data_dir: &Path,
) -> Result<bool> {
    let trust_path = codex_config_toml_path(hooks_path)?;
    if !trust_path.exists() {
        return Ok(false);
    }
    let command = managed_command(
        spec,
        match spec.kind {
            HookKind::Json(json_spec) => json_spec,
            _ => unreachable!(),
        },
        &script_path(spec, app_data_dir),
    );
    let key = codex_trust_key(hooks_path, group_index);
    let expected_hash = codex_trusted_hash(&command);
    let text = fs::read_to_string(&trust_path)
        .with_context(|| format!("read {}", trust_path.display()))?;
    Ok(
        read_codex_trust_block(&text, &key).is_some_and(|(enabled, hash)| {
            enabled != Some(false) && hash.as_deref() == Some(expected_hash.as_str())
        }),
    )
}

fn update_codex_trust(
    hooks_path: &Path,
    old_index: Option<usize>,
    new_index: Option<usize>,
    spec: &AgentHookSpec,
    app_data_dir: &Path,
) -> Result<()> {
    let trust_path = codex_config_toml_path(hooks_path)?;
    let mut text = if trust_path.exists() {
        fs::read_to_string(&trust_path).with_context(|| format!("read {}", trust_path.display()))?
    } else {
        String::new()
    };
    let mut remove_keys = BTreeSet::new();
    if let Some(index) = old_index {
        remove_keys.insert(codex_trust_key(hooks_path, index));
    }
    if let Some(index) = new_index {
        remove_keys.insert(codex_trust_key(hooks_path, index));
    }
    text = remove_codex_trust_blocks(&text, &remove_keys);

    if let Some(index) = new_index {
        let command = managed_command(
            spec,
            match spec.kind {
                HookKind::Json(json_spec) => json_spec,
                _ => unreachable!(),
            },
            &script_path(spec, app_data_dir),
        );
        let key = codex_trust_key(hooks_path, index);
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        if !text.is_empty() && !text.ends_with("\n\n") {
            text.push('\n');
        }
        text.push_str(CODEX_TRUST_MARKER);
        text.push('\n');
        text.push_str(&format!(
            "[hooks.state.\"{}\"]\nenabled = true\ntrusted_hash = \"{}\"\n",
            escape_toml_basic(&key),
            codex_trusted_hash(&command)
        ));
    }
    ensure_parent(&trust_path)?;
    fs::write(&trust_path, text).with_context(|| format!("write {}", trust_path.display()))
}

fn codex_trust_key(hooks_path: &Path, group_index: usize) -> String {
    format!("{}:stop:{group_index}:0", hooks_path.to_string_lossy())
}

fn codex_trusted_hash(command: &str) -> String {
    let identity = json!({
        "event_name": "stop",
        "hooks": [{
            "async": false,
            "command": command,
            "timeout": HOOK_TIMEOUT_SECONDS,
            "type": "command",
        }],
    });
    let serialized = serde_json::to_string(&identity).expect("serialize Codex hook identity");
    format!("sha256:{:x}", Sha256::digest(serialized.as_bytes()))
}

fn read_codex_trust_block(text: &str, key: &str) -> Option<(Option<bool>, Option<String>)> {
    let lines = text.lines().collect::<Vec<_>>();
    let start = lines
        .iter()
        .position(|line| toml_trust_header_matches(line.trim(), key))?;
    let mut enabled = None;
    let mut hash = None;
    for line in lines.iter().skip(start + 1) {
        let trimmed = line.trim();
        if trimmed.starts_with('[') && trimmed.ends_with(']') {
            break;
        }
        if let Some(value) = trimmed.strip_prefix("enabled =") {
            enabled = match value.trim() {
                "true" => Some(true),
                "false" => Some(false),
                _ => enabled,
            };
        }
        if let Some(value) = trimmed.strip_prefix("trusted_hash =") {
            hash = parse_toml_quoted(value.trim());
        }
    }
    Some((enabled, hash))
}

fn remove_codex_trust_blocks(text: &str, keys: &BTreeSet<String>) -> String {
    if keys.is_empty() {
        return text.to_string();
    }
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let lines = text.lines().collect::<Vec<_>>();
    let mut output: Vec<&str> = Vec::with_capacity(lines.len());
    let mut index = 0;
    while index < lines.len() {
        let trimmed = lines[index].trim();
        let matches = keys
            .iter()
            .any(|key| toml_trust_header_matches(trimmed, key));
        if !matches {
            output.push(lines[index]);
            index += 1;
            continue;
        }
        if output
            .last()
            .is_some_and(|line| line.trim() == CODEX_TRUST_MARKER)
        {
            output.pop();
        }
        index += 1;
        while index < lines.len() {
            let candidate = lines[index].trim();
            if candidate.starts_with('[') && candidate.ends_with(']') {
                break;
            }
            index += 1;
        }
    }
    let mut result = output.join(newline);
    if text.ends_with('\n') && !result.ends_with('\n') {
        result.push_str(newline);
    }
    result
}

fn toml_trust_header_matches(header: &str, key: &str) -> bool {
    header == format!("[hooks.state.'{key}']")
        || header == format!("[hooks.state.\"{}\"]", escape_toml_basic(key))
}

fn parse_toml_quoted(value: &str) -> Option<String> {
    if let Some(inner) = value
        .strip_prefix('"')
        .and_then(|value| value.strip_suffix('"'))
    {
        return Some(inner.replace("\\\"", "\"").replace("\\\\", "\\"));
    }
    value
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: &str) -> &'static AgentHookSpec {
        AGENT_HOOK_SPECS
            .iter()
            .find(|spec| spec.id == id)
            .expect("agent hook spec")
    }
    fn rendered_completion_artifact(spec: &AgentHookSpec) -> String {
        let mut source = match spec.kind {
            HookKind::Json(_) | HookKind::KimiToml => {
                render_managed_script(spec).expect("render managed script")
            }
            HookKind::DropIn(kind) => render_drop_in_hook(spec, kind).expect("render drop-in hook"),
            HookKind::HermesPlugin => {
                let cli = hook_cli_path().expect("resolve hook cli");
                render_hermes_plugin(&cli)
            }
        };
        if cfg!(windows) && spec.id == "antigravity" {
            source = decode_powershell_encoded_command(&source)
                .expect("decode Antigravity completion command");
        }
        source
    }

    fn contains_cli_flag(source: &str, flag: &str) -> bool {
        source.match_indices(flag).any(|(index, _)| {
            let before = source[..index].chars().next_back();
            let after = source[index + flag.len()..].chars().next();
            let is_name_character = |character: char| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
            };
            before.is_none_or(|character| !is_name_character(character))
                && after.is_none_or(|character| !is_name_character(character))
        })
    }

    #[test]
    fn supported_hook_agents_match_orca_event_source_parity() {
        assert_eq!(
            AGENT_HOOK_SPECS
                .iter()
                .map(|spec| spec.id)
                .collect::<Vec<_>>(),
            vec![
                "claude",
                "codex",
                "gemini",
                "antigravity",
                "amp",
                "opencode",
                "mimo-code",
                "cursor",
                "pi",
                "omp",
                "droid",
                "command-code",
                "grok",
                "copilot",
                "hermes",
                "devin",
                "kimi",
            ]
        );
    }

    #[test]
    fn nested_json_install_and_remove_preserve_foreign_content() {
        let spec = spec("claude");
        let HookKind::Json(json_spec) = spec.kind else {
            panic!("json spec");
        };
        let mut config = json!({
            "theme": "dark",
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "user-hook"}]}],
                "PreToolUse": [{"matcher": ".*", "hooks": []}]
            }
        });
        apply_json_hook_config(
            &mut config,
            spec,
            json_spec,
            "C:\\VibeLink\\claude-complete.cmd",
            true,
        )
        .expect("install");
        assert_eq!(config["theme"], "dark");
        assert_eq!(config["hooks"]["Stop"].as_array().unwrap().len(), 2);
        apply_json_hook_config(
            &mut config,
            spec,
            json_spec,
            "C:\\VibeLink\\claude-complete.cmd",
            false,
        )
        .expect("remove");
        assert_eq!(config["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            config["hooks"]["Stop"][0]["hooks"][0]["command"],
            "user-hook"
        );
        assert!(config["hooks"].get("PreToolUse").is_some());
        assert_eq!(json_spec.events, CLAUDE_EVENTS);
    }

    #[test]
    fn claude_install_and_remove_manage_stop_and_session_start() {
        let root = std::env::temp_dir().join(format!(
            "vibelink-claude-hook-roundtrip-{}",
            uuid::Uuid::new_v4()
        ));
        let app_data = root.join("app-data");
        let config_path = root.join("settings.json");
        let claude = spec("claude");
        let HookKind::Json(json_spec) = claude.kind else {
            panic!("Claude JSON spec");
        };
        write_json_config(
            &config_path,
            &json!({
                "theme": "dark",
                "hooks": {
                    "Stop": [{"hooks": [{"type": "command", "command": "user-stop"}]}],
                    "SessionStart": [{"hooks": [{"type": "command", "command": "user-start"}]}],
                    "PreToolUse": [{"matcher": ".*", "hooks": []}]
                }
            }),
        )
        .expect("write Claude fixture");

        install_json_hook(claude, json_spec, &app_data, &config_path)
            .expect("install Claude hooks");
        let installed = read_json_config(&config_path, false).expect("read installed config");
        assert_eq!(installed["hooks"]["Stop"].as_array().unwrap().len(), 2);
        assert_eq!(
            installed["hooks"]["SessionStart"].as_array().unwrap().len(),
            2
        );
        // Windows wraps the command as `-EncodedCommand <base64>`, so the script
        // path is not a substring of it. Identify the managed entry exactly the
        // way install and uninstall do.
        let session_start = installed["hooks"]["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .find(|definition| {
                definition_mentions_managed_script(definition, CLAUDE_MEMORY_SCRIPT_STEM)
            })
            .expect("managed SessionStart hook");
        assert_eq!(session_start["hooks"][0]["type"], "command");
        assert_eq!(session_start["hooks"][0]["timeout"], 5);
        assert!(
            inspect_json_hook(claude, json_spec, &app_data, &config_path)
                .expect("inspect installed Claude hooks")
                .installed
        );

        uninstall_json_hook(claude, json_spec, &app_data, &config_path)
            .expect("remove Claude hooks");
        let restored = read_json_config(&config_path, false).expect("read restored config");
        assert_eq!(restored["theme"], "dark");
        assert_eq!(restored["hooks"]["Stop"].as_array().unwrap().len(), 1);
        assert_eq!(
            restored["hooks"]["Stop"][0]["hooks"][0]["command"],
            "user-stop"
        );
        assert_eq!(
            restored["hooks"]["SessionStart"].as_array().unwrap().len(),
            1
        );
        assert_eq!(
            restored["hooks"]["SessionStart"][0]["hooks"][0]["command"],
            "user-start"
        );
        assert!(restored["hooks"].get("PreToolUse").is_some());
        assert!(
            !inspect_json_hook(claude, json_spec, &app_data, &config_path)
                .expect("inspect removed Claude hooks")
                .installed
        );
        assert!(!app_data
            .join("data")
            .join("agent-hooks")
            .join(if cfg!(windows) {
                "claude-memory.ps1"
            } else {
                "claude-memory.sh"
            })
            .exists());

        fs::remove_dir_all(&root).expect("remove Claude hook fixtures");
    }

    #[test]
    fn claude_memory_script_is_silent_outside_vibelink_and_prints_one_nudge_inside() {
        use std::process::{Command, Stdio};

        let root = std::env::temp_dir().join(format!(
            "vibelink-claude-memory-script-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).expect("create Claude memory script fixtures");
        let fake_cli = root.join(if cfg!(windows) {
            "fake-vibelink.cmd"
        } else {
            "fake-vibelink"
        });
        let fake_output = if cfg!(windows) {
            "@echo off\r\necho {\"version\":1,\"ok\":true,\"result\":{\"entries\":[{\"id\":\"one\"},{\"id\":\"two\"}]}}\r\nexit /b 0\r\n"
        } else {
            "#!/bin/sh\nprintf '%s\\n' '{' '  \"entries\": [' '    {' '      \"id\": \"one\"' '    },' '    {' '      \"id\": \"two\"' '    }' '  ]' '}'\n"
        };
        fs::write(&fake_cli, fake_output).expect("write fake VibeLink CLI");
        set_executable_if_posix(&fake_cli).expect("make fake VibeLink CLI executable");

        let script = root.join(if cfg!(windows) {
            "claude-memory.ps1"
        } else {
            "claude-memory.sh"
        });
        fs::write(&script, render_claude_memory_script_for_cli(&fake_cli))
            .expect("write Claude memory script");
        set_executable_if_posix(&script).expect("make Claude memory script executable");

        let run = |session_id: Option<&str>| {
            let mut command = if cfg!(windows) {
                let mut command = Command::new("powershell.exe");
                command.args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"]);
                command.arg(&script);
                command
            } else {
                let mut command = Command::new("/bin/sh");
                command.arg(&script);
                command
            };
            command
                .stdin(Stdio::null())
                .env_remove("VIBELINK_SESSION_ID");
            if let Some(session_id) = session_id {
                command.env("VIBELINK_SESSION_ID", session_id);
            }
            command.output().expect("run Claude memory script")
        };

        let outside = run(None);
        assert!(outside.status.success());
        assert!(outside.stdout.is_empty());

        let inside = run(Some("workspace-1"));
        assert!(inside.status.success());
        let stdout = String::from_utf8(inside.stdout).expect("Claude memory stdout is UTF-8");
        assert_eq!(stdout.lines().count(), 1);
        assert_eq!(
            stdout.trim_end(),
            "VibeLink workspace memory has 2 entries. Run `vibelink memory search --query \"<terms>\"` before investigating anything non-trivial here."
        );

        fs::remove_dir_all(&root).expect("remove Claude memory script fixtures");
    }

    #[test]
    fn jsonc_parser_accepts_comments_and_trailing_commas() {
        let value = parse_jsonc(
            r#"{
              // user preference
              "read_config_from": { "claude": false, },
              /* existing config */
              "hooks": {},
            }"#,
        )
        .expect("parse jsonc");
        assert_eq!(value["read_config_from"]["claude"], false);
    }

    #[test]
    fn kimi_marker_block_round_trip_preserves_user_toml() {
        let original =
            "model = \"moonshot\"\n\n[[hooks]]\nevent = \"PreToolUse\"\ncommand = \"user-hook\"\n";
        let managed = format!(
            "{original}\n{KIMI_BLOCK_START}\n[[hooks]]\nevent = \"Stop\"\ncommand = \"managed\"\n{KIMI_BLOCK_END}\n"
        );
        let (clean, changed) = remove_kimi_blocks(&managed).expect("remove block");
        assert!(changed);
        assert_eq!(clean, format!("{original}\n"));
    }

    #[test]
    fn omp_extension_waits_for_settled_idle_instead_of_pre_hook_guessing() {
        let source = render_pi_extension(Path::new("C:/VibeLink/app.exe"), "omp");
        assert!(source.contains("agent_settled"));
        assert!(source.contains("ctx.isIdle()"));
        assert!(source.contains("agent_end"));
        assert!(!source.contains("input:pre"));
    }

    /// Generated hooks must invoke the dedicated CLI, never the GUI binary.
    /// Pointing a hook at the desktop executable starts an extra full instance
    /// per agent turn; every instance attaches to the same daemon session and
    /// refits the shared panes to its own window, which is what made the live
    /// terminal grid visibly oscillate between two column counts.
    #[test]
    fn generated_hooks_invoke_the_dedicated_cli_binary() {
        let cli = hook_cli_path().expect("resolve hook cli");
        let name = cli
            .file_name()
            .and_then(|name| name.to_str())
            .expect("cli file name");
        assert_eq!(
            name,
            if cfg!(windows) {
                "vibelink.exe"
            } else {
                "vibelink"
            }
        );

        let script = render_batch_script(spec("codex")).expect("batch script");
        assert!(script.contains(&cli.display().to_string()));
        assert!(script.contains("terminal complete"));
    }
    #[test]
    fn every_generated_completion_command_matches_the_dedicated_cli_contract() {
        for spec in AGENT_HOOK_SPECS {
            let source = rendered_completion_artifact(spec);
            for flag in ["--workspace", "--pane", "--agent-id"] {
                assert!(
                    contains_cli_flag(&source, flag),
                    "{} generated hook is missing {flag}: {source}",
                    spec.id
                );
            }
            for legacy_flag in ["--session", "--agent"] {
                assert!(
                    !contains_cli_flag(&source, legacy_flag),
                    "{} generated hook still uses {legacy_flag}: {source}",
                    spec.id
                );
            }

            crate::dedicated_cli::parse_args([
                "terminal",
                "complete",
                "--workspace",
                "workspace-1",
                "--pane",
                "pane-1",
                "--agent-id",
                spec.id,
            ])
            .unwrap_or_else(|error| {
                panic!(
                    "{} generated completion argv must satisfy the dedicated CLI contract: {}",
                    spec.id, error.message
                )
            });
        }
    }

    #[test]
    fn antigravity_script_rejects_non_idle_stop() {
        let source = render_antigravity_batch(spec("antigravity")).expect("script");
        let decoded = decode_powershell_encoded_command(&source).expect("decode command");
        assert!(decoded.contains("fullyIdle"));
        assert!(decoded.contains("fully_idle"));
        assert!(decoded.contains("decision"));
    }

    #[test]
    fn codex_trust_hash_matches_known_codex_identity() {
        let command =
            r"C:\Users\js\AppData\Roaming\vibelink\VibeLink\data\agent-hooks\codex-complete.cmd";
        assert_eq!(
            codex_trusted_hash(command),
            "sha256:8996547192dd91473e5ab39c7de531237455cc6d107c79d6ee47849e90e008da"
        );
    }

    #[test]
    fn generated_drop_in_never_overwrites_unowned_file() {
        let dir = std::env::temp_dir().join(format!(
            "vibelink-agent-hook-conflict-{}",
            uuid::Uuid::new_v4()
        ));
        let path = dir.join("plugin.ts");
        fs::create_dir_all(&dir).expect("create temp dir");
        fs::write(&path, "user plugin").expect("write user plugin");
        assert!(ensure_generated_file_writable(&path).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), "user plugin");
        fs::remove_dir_all(&dir).expect("remove temp dir");
    }
    #[test]
    fn status_inspection_repairs_stale_managed_drop_in() {
        let dir = std::env::temp_dir().join(format!(
            "vibelink-agent-hook-stale-{}",
            uuid::Uuid::new_v4()
        ));
        let path = dir.join("plugin.ts");
        fs::create_dir_all(&dir).expect("create temp dir");
        fs::write(
            &path,
            format!(
                "// {HOOK_MARKER}\nconst argv = ['terminal', 'complete', '--session', 'old-workspace', '--pane', 'old-pane', '--agent', 'amp']\n"
            ),
        )
        .expect("write stale managed plugin");

        let amp = spec("amp");
        let HookKind::DropIn(kind) = amp.kind else {
            panic!("Amp drop-in spec");
        };
        assert!(
            inspect_drop_in_hook(amp, kind, &path)
                .expect("inspect stale managed plugin")
                .installed
        );
        assert_eq!(
            fs::read_to_string(&path).expect("read repaired plugin"),
            render_drop_in_hook(amp, kind).expect("render current plugin")
        );

        fs::remove_dir_all(&dir).expect("remove temp dir");
    }

    #[test]
    fn legacy_generated_hooks_are_migratable() {
        assert!(content_is_vibelink_managed(
            "// vibelink-agent-hook v3 - generated by VibeLink. Safe to delete."
        ));
        assert!(content_is_vibelink_managed(
            "rem vibelink-agent-hook v2 - retired compatibility launcher."
        ));
        assert!(!content_is_vibelink_managed("user-authored hook"));
    }

    #[test]
    fn all_seventeen_hook_integrations_round_trip_in_temp_tree() {
        let root = std::env::temp_dir().join(format!(
            "vibelink-agent-hook-roundtrip-{}",
            uuid::Uuid::new_v4()
        ));
        let app_data = root.join("app-data");

        for spec in AGENT_HOOK_SPECS {
            let config_path = root.join("configs").join(format!("{}-config", spec.id));
            match spec.kind {
                HookKind::Json(json_spec) => {
                    let mut initial = json!({ "userSetting": "keep" });
                    if matches!(json_spec.schema, JsonSchema::Cursor | JsonSchema::Copilot) {
                        initial["version"] = json!(1);
                    }
                    write_json_config(&config_path, &initial).expect("write fixture config");
                    install_json_hook(spec, json_spec, &app_data, &config_path)
                        .expect("install JSON hook");
                    let script = script_path(spec, &app_data);
                    fs::write(
                        &script,
                        format!("rem {HOOK_MARKER}\nterminal complete --session old --pane old --agent {}\n", spec.id),
                    )
                    .expect("write stale managed script");
                    assert!(
                        inspect_json_hook(spec, json_spec, &app_data, &config_path)
                            .expect("inspect JSON hook")
                            .installed,
                        "{} should install",
                        spec.id
                    );
                    assert_eq!(
                        fs::read_to_string(&script).expect("read repaired managed script"),
                        render_managed_script(spec).expect("render current managed script"),
                    );
                    uninstall_json_hook(spec, json_spec, &app_data, &config_path)
                        .expect("remove JSON hook");
                    let restored = read_json_config(&config_path, json_spec.allow_jsonc)
                        .expect("read restored config");
                    assert_eq!(restored["userSetting"], "keep");
                    assert_eq!(
                        managed_json_event_count(&restored, spec, json_spec)
                            .expect("count managed events"),
                        0
                    );
                    assert!(!script_path(spec, &app_data).exists());
                }
                HookKind::DropIn(kind) => {
                    if matches!(kind, DropInKind::Omp) {
                        let cli = std::env::current_exe().expect("resolve test executable");
                        ensure_parent(&config_path).expect("create plugin parent");
                        fs::write(&config_path, render_pi_extension(&cli, spec.id))
                            .expect("write OMP fixture extension");
                    } else {
                        install_drop_in_hook(spec, kind, &config_path)
                            .expect("install drop-in hook");
                    }
                    fs::write(
                        &config_path,
                        format!("// {HOOK_MARKER}\nconst argv = ['terminal', 'complete', '--session', 'old', '--pane', 'old', '--agent', '{}']\n", spec.id),
                    )
                    .expect("write stale managed drop-in");
                    assert!(
                        inspect_drop_in_hook(spec, kind, &config_path)
                            .expect("inspect drop-in hook")
                            .installed
                    );
                    assert_eq!(
                        fs::read_to_string(&config_path).expect("read repaired drop-in"),
                        render_drop_in_hook(spec, kind).expect("render current drop-in"),
                    );
                    remove_generated_file_if_managed(&config_path).expect("remove drop-in hook");
                    assert!(!config_path.exists());
                }
                HookKind::KimiToml => {
                    ensure_parent(&config_path).expect("create Kimi config parent");
                    fs::write(&config_path, "model = \"moonshot\"\n").expect("write Kimi fixture");
                    install_kimi_hook(spec, &app_data, &config_path).expect("install Kimi hook");
                    let script = script_path(spec, &app_data);
                    fs::write(
                        &script,
                        format!("# {HOOK_MARKER}\nterminal complete --session old --pane old --agent {}\n", spec.id),
                    )
                    .expect("write stale Kimi script");
                    assert!(
                        inspect_kimi_hook(spec, &app_data, &config_path)
                            .expect("inspect Kimi hook")
                            .installed
                    );
                    assert_eq!(
                        fs::read_to_string(&script).expect("read repaired Kimi script"),
                        render_managed_script(spec).expect("render current Kimi script"),
                    );
                    uninstall_kimi_hook(spec, &app_data, &config_path).expect("remove Kimi hook");
                    let restored = fs::read_to_string(&config_path).expect("read Kimi config");
                    assert!(restored.contains("model = \"moonshot\""));
                    assert!(!restored.contains(KIMI_BLOCK_START));
                }
                HookKind::HermesPlugin => {
                    ensure_parent(&config_path).expect("create Hermes config parent");
                    fs::write(
                        &config_path,
                        "model: test-model\nplugins:\n  enabled:\n    - user-plugin\n  disabled: []\n",
                    )
                    .expect("write Hermes fixture");
                    install_hermes_hook(&config_path).expect("install Hermes hook");
                    let plugin_dir = hermes_plugin_dir(&config_path).expect("Hermes plugin dir");
                    let manifest = plugin_dir.join("plugin.yaml");
                    let init = plugin_dir.join("__init__.py");
                    fs::write(&manifest, format!("# {HOOK_MARKER}\nversion: old\n"))
                        .expect("write stale Hermes manifest");
                    fs::write(
                        &init,
                        format!("# {HOOK_MARKER}\nargv = ['terminal', 'complete', '--session', 'old', '--pane', 'old', '--agent', 'hermes']\n"),
                    )
                    .expect("write stale Hermes plugin");
                    assert!(
                        inspect_hermes_hook(&config_path)
                            .expect("inspect Hermes hook")
                            .installed
                    );
                    assert_eq!(
                        fs::read_to_string(&manifest).expect("read repaired Hermes manifest"),
                        render_hermes_manifest(),
                    );
                    let cli = hook_cli_path().expect("resolve hook cli");
                    assert_eq!(
                        fs::read_to_string(&init).expect("read repaired Hermes plugin"),
                        render_hermes_plugin(&cli),
                    );
                    uninstall_hermes_hook(&config_path).expect("remove Hermes hook");
                    let restored = fs::read_to_string(&config_path).expect("read Hermes config");
                    assert!(restored.contains("model: test-model"));
                    assert!(restored.contains("user-plugin"));
                    assert!(!restored.contains(HERMES_PLUGIN_NAME));
                }
            }
        }

        fs::remove_dir_all(&root).expect("remove hook roundtrip fixtures");
    }
}

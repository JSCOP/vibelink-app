//! Agent completion hooks.
//!
//! VibeLink learns that an AI coding agent finished a turn by asking the agent
//! itself rather than guessing from terminal bytes. Config-driven agents get a
//! launcher script under our OWN app-data directory. Drop-in agents invoke the
//! dedicated VibeLink CLI directly so no intermediary console window is created.
//!
//! Three properties are load-bearing and every future edit must preserve them:
//!
//! 1. **Non-destructive.** We never replace an agent's config wholesale. JSON
//!    hook arrays are appended to, and entries are owned by the exact generated
//!    launcher path (with [`HOOK_MARKER`] retained for legacy cleanup). Uninstall
//!    removes only those entries and leaves the user's own hooks and other tools'
//!    hooks untouched. A config we cannot parse is reported and left alone.
//! 2. **Reversible.** `uninstall` removes our config entries, direct drop-in
//!    modules, legacy VibeLink entries, and generated launchers.
//! 3. **Inert outside VibeLink.** Every hook keys off `VIBELINK_PANE_ID`, which
//!    only exists inside a VibeLink PTY. Running the same agent in Windows
//!    Terminal finds no pane id and exits 0 immediately.
//!
//! Correlation reuses the `VIBELINK_*` variables the daemon already injects at
//! the PTY boundary, so an agent started by TYPING `omp` inside a plain `pwsh`
//! pane still reports against the right pane. That is the whole reason this
//! subsystem exists: profile-based detection cannot see such a pane.

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

/// Stamped into generated launchers/drop-ins and recognized in legacy config
/// entries so upgrades and uninstall remove only VibeLink-owned artifacts.
pub const HOOK_MARKER: &str = "vibelink-agent-hook";

/// Bumped when generated hook contents change so install can refresh stale
/// artifacts in place.
const HOOK_SCRIPT_VERSION: u32 = 2;

/// How a given agent is told about our hook script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HookInstallKind {
    /// Agent reads a JSON hook registry and runs commands listed per event.
    JsonHooks,
    /// Agent discovers executable files dropped in a hooks directory. Install is
    /// a file write and uninstall is a file delete, so the agent's own config is
    /// never touched at all.
    DropInDirectory,
}

#[derive(Clone, Copy)]
struct AgentHookSpec {
    id: &'static str,
    display_name: &'static str,
    kind: HookInstallKind,
    /// Config file (or drop-in directory) relative to the user's home.
    target: &'static str,
    /// Events we subscribe to, for the config-driven kinds.
    completion_events: &'static [&'static str],
}

/// Agents we can receive completion signals from.
///
/// OMP is the important entry: it discovers hook FILES from
/// `~/.omp/agent/hooks/pre/`, so we install by writing one file and uninstall by
/// deleting it. Its config never mentions VibeLink.
const AGENT_HOOK_SPECS: &[AgentHookSpec] = &[
    AgentHookSpec {
        id: "claude",
        display_name: "Claude Code",
        kind: HookInstallKind::JsonHooks,
        target: ".claude/settings.json",
        // Only the main-thread Stop event means the user's turn is finished.
        // SubagentStop can fire while the parent is still actively working.
        completion_events: &["Stop"],
    },
    AgentHookSpec {
        id: "codex",
        display_name: "Codex",
        kind: HookInstallKind::JsonHooks,
        // Current Codex versions merge this lifecycle registry with every other
        // hook source, unlike the legacy single-owner `notify` config slot.
        target: ".codex/hooks.json",
        completion_events: &["Stop"],
    },
    AgentHookSpec {
        id: "omp",
        display_name: "Oh My Pi",
        kind: HookInstallKind::DropInDirectory,
        target: ".omp/agent/hooks/pre",
        completion_events: &["turn_end"],
    },
    AgentHookSpec {
        id: "opencode",
        display_name: "OpenCode",
        kind: HookInstallKind::DropInDirectory,
        target: ".config/opencode/plugins",
        completion_events: &["session.idle"],
    },
];

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentHookStatus {
    pub id: String,
    pub display_name: String,
    /// Whether our hook is currently installed for this agent.
    pub installed: bool,
    /// Whether the agent's config/hook location exists at all. A missing
    /// location is not an error: we create it on install.
    pub config_present: bool,
    /// Absolute path we install into, shown in Settings so the user can audit
    /// exactly what we touch.
    pub config_path: String,
    /// Set when the config exists but we refuse to touch it (for example
    /// malformed JSON). Install is blocked rather than risking user data.
    pub blocked_reason: Option<String>,
}

fn home_dir() -> Result<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
        .context("could not resolve the user home directory")
}

/// Directory holding our generated launcher scripts. It lives under VibeLink's
/// own app data, never inside an agent's directory.
///
/// `VIBELINK_AGENT_HOOK_DIR` overrides the location. Tests use it to redirect
/// the whole subsystem into a sandbox, because `ProjectDirs` resolves Windows
/// known-folders and ignores a reassigned `APPDATA`.
fn script_dir() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("VIBELINK_AGENT_HOOK_DIR") {
        return Ok(PathBuf::from(value));
    }
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join("agent-hooks"))
}

fn script_path(agent_id: &str) -> Result<PathBuf> {
    let name = if cfg!(windows) {
        format!("{agent_id}-complete.cmd")
    } else {
        format!("{agent_id}-complete.sh")
    };
    Ok(script_dir()?.join(name))
}

fn spec_for(agent_id: &str) -> Result<&'static AgentHookSpec> {
    AGENT_HOOK_SPECS
        .iter()
        .find(|spec| spec.id == agent_id)
        .with_context(|| format!("unknown agent hook id '{agent_id}'"))
}

/// Absolute path of the VibeLink CLI the hook calls back into.
///
/// This is the dedicated `vibelink.exe` sidecar, NOT the GUI `app.exe`: the GUI
/// binary has no CLI subcommand routing and would simply open a window. Debug
/// and release builds ship different sidecars bound to different daemon
/// flavors, so every installed hook bakes in the exact one that installed it.
fn cli_exe() -> Result<PathBuf> {
    crate::app::cli_path::dedicated_cli_path()
}

/// Body of the generated launcher.
///
/// The `VIBELINK_PANE_ID` guard is what makes this safe to leave installed: the
/// variable is injected only by our PTY spawn, so the same agent run from any
/// other terminal falls straight through to the stdin drain and exits 0. We must
/// always consume stdin, because agents that pipe a JSON payload will error if
/// the hook exits without reading it.
fn render_script(agent_id: &str, exe: &Path) -> String {
    if cfg!(windows) {
        format!(
            "@echo off\r\n\
             rem {marker} v{version} - generated by VibeLink. Safe to delete.\r\n\
             setlocal\r\n\
             if \"%VIBELINK_PANE_ID%\"==\"\" goto :drain\r\n\
             if \"%VIBELINK_SESSION_ID%\"==\"\" goto :drain\r\n\
             \"{exe}\" terminal complete --pane \"%VIBELINK_PANE_ID%\" \
             --workspace \"%VIBELINK_SESSION_ID%\" --agent-id {agent} >nul 2>&1\r\n\
             :drain\r\n\
             \"%SystemRoot%\\System32\\more.com\" >nul 2>nul\r\n\
             exit /b 0\r\n",
            marker = HOOK_MARKER,
            version = HOOK_SCRIPT_VERSION,
            exe = exe.display(),
            agent = agent_id,
        )
    } else {
        format!(
            "#!/bin/sh\n\
             # {marker} v{version} - generated by VibeLink. Safe to delete.\n\
             if [ -n \"$VIBELINK_PANE_ID\" ] && [ -n \"$VIBELINK_SESSION_ID\" ]; then\n\
             \x20 \"{exe}\" terminal complete --pane \"$VIBELINK_PANE_ID\" \
             --workspace \"$VIBELINK_SESSION_ID\" --agent-id {agent} >/dev/null 2>&1\n\
             fi\n\
             cat >/dev/null 2>&1 || true\n\
             exit 0\n",
            marker = HOOK_MARKER,
            version = HOOK_SCRIPT_VERSION,
            exe = exe.display(),
            agent = agent_id,
        )
    }
}

fn write_script(agent_id: &str) -> Result<PathBuf> {
    let path = script_path(agent_id)?;
    let dir = path
        .parent()
        .context("hook script path has no parent directory")?;
    fs::create_dir_all(dir)
        .with_context(|| format!("could not create hook script directory {}", dir.display()))?;
    let body = render_script(agent_id, &cli_exe()?);
    fs::write(&path, body)
        .with_context(|| format!("could not write hook script {}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(&path)?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms)?;
    }
    Ok(path)
}

fn remove_script(agent_id: &str) -> Result<()> {
    let path = script_path(agent_id)?;
    if path.exists() {
        fs::remove_file(&path)
            .with_context(|| format!("could not remove hook script {}", path.display()))?;
    }
    Ok(())
}

fn script_is_current(agent_id: &str) -> Result<bool> {
    let path = script_path(agent_id)?;
    if !path.exists() {
        return Ok(false);
    }
    let body = fs::read_to_string(path)?;
    Ok(body.contains(HOOK_MARKER)
        && body.contains(&format!("v{HOOK_SCRIPT_VERSION}"))
        && body.contains("terminal complete"))
}

/// Read a JSON config, returning `None` when the file does not exist yet and an
/// error when it exists but cannot be parsed. Refusing to proceed on a parse
/// error is deliberate: silently replacing an unreadable config would destroy
/// user configuration.
fn read_json_config(path: &Path) -> Result<Option<Map<String, Value>>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw =
        fs::read_to_string(path).with_context(|| format!("could not read {}", path.display()))?;
    if raw.trim().is_empty() {
        return Ok(Some(Map::new()));
    }
    let parsed: Value = serde_json::from_str(&raw)
        .with_context(|| format!("{} is not valid JSON", path.display()))?;
    match parsed {
        Value::Object(map) => Ok(Some(map)),
        _ => anyhow::bail!("{} does not contain a JSON object", path.display()),
    }
}

fn write_json_config(path: &Path, config: &Map<String, Value>) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .with_context(|| format!("could not create {}", parent.display()))?;
    }
    let body = serde_json::to_string_pretty(&Value::Object(config.clone()))?;
    fs::write(path, format!("{body}\n"))
        .with_context(|| format!("could not write {}", path.display()))
}

fn hook_command_matches(handler: &Value, script: &Path) -> bool {
    let expected = script.display().to_string();
    handler.get(HOOK_MARKER).is_some()
        || ["command", "commandWindows", "command_windows"]
            .iter()
            .filter_map(|key| handler.get(*key).and_then(Value::as_str))
            .any(|command| command == expected || command.contains(HOOK_MARKER))
}

/// True when a JSON lifecycle-hook entry is one VibeLink authored. New entries
/// are identified by the exact generated launcher path; the marker fallback
/// also recognizes entries written by older VibeLink builds.
fn is_our_json_hook_entry(entry: &Value, script: &Path) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| hooks.iter().any(|hook| hook_command_matches(hook, script)))
}

fn json_hook_entry(spec: &AgentHookSpec, script: &Path) -> Value {
    let command = script.display().to_string();
    let mut handler = serde_json::json!({
        "type": "command",
        "command": command,
        "timeout": 5,
    });
    if spec.id == "codex" {
        handler["commandWindows"] = Value::String(script.display().to_string());
    }
    serde_json::json!({ "hooks": [handler] })
}

/// Append our entry to each completion event, replacing only a previous
/// VibeLink entry. Every foreign event and handler remains in place.
fn apply_json_hooks(
    config: &mut Map<String, Value>,
    spec: &AgentHookSpec,
    owned_script: &Path,
    install_script: Option<&Path>,
) {
    let entry = config
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    let Some(hooks) = entry.as_object_mut() else {
        return;
    };

    for event in spec.completion_events {
        let entries = hooks
            .entry((*event).to_string())
            .or_insert_with(|| Value::Array(Vec::new()));
        let Some(list) = entries.as_array_mut() else {
            continue;
        };
        list.retain(|entry| !is_our_json_hook_entry(entry, owned_script));
        if let Some(script) = install_script {
            list.push(json_hook_entry(spec, script));
        }
        if list.is_empty() {
            hooks.remove(*event);
        }
    }

    if hooks.is_empty() {
        config.remove("hooks");
    }
}

fn json_hooks_blocked_reason(path: &Path, spec: &AgentHookSpec) -> Option<String> {
    let config = match read_json_config(path) {
        Err(error) => return Some(error.to_string()),
        Ok(Some(config)) => config,
        Ok(None) => return None,
    };
    let Some(hooks) = config.get("hooks") else {
        return None;
    };
    let Some(hooks) = hooks.as_object() else {
        return Some(format!(
            "{} has a non-object hooks value; VibeLink will not replace it.",
            path.display()
        ));
    };
    spec.completion_events.iter().find_map(|event| {
        hooks
            .get(*event)
            .filter(|entries| !entries.is_array())
            .map(|_| {
                format!(
                    "{} has a non-array {event} hook list; VibeLink will not replace it.",
                    path.display()
                )
            })
    })
}

fn remove_owned_json_events(config: &mut Map<String, Value>, events: &[&str], script: &Path) {
    let Some(hooks) = config.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    for event in events {
        let Some(entries) = hooks.get_mut(*event).and_then(Value::as_array_mut) else {
            continue;
        };
        entries.retain(|entry| !is_our_json_hook_entry(entry, script));
        if entries.is_empty() {
            hooks.remove(*event);
        }
    }
    if hooks.is_empty() {
        config.remove("hooks");
    }
}

fn remove_legacy_artifacts(home: &Path, spec: &AgentHookSpec, script: &Path) -> Result<()> {
    if spec.id == "claude" {
        let path = home.join(spec.target);
        if let Ok(Some(mut config)) = read_json_config(&path) {
            let before = config.clone();
            remove_owned_json_events(&mut config, &["SubagentStop"], script);
            if config != before {
                write_json_config(&path, &config)?;
            }
        }
    } else if spec.id == "codex" {
        let path = home.join(".codex/config.toml");
        if path.exists() {
            let raw = fs::read_to_string(&path)?;
            if raw.lines().any(|line| line.contains(HOOK_MARKER)) {
                let mut cleaned = raw
                    .lines()
                    .filter(|line| !line.contains(HOOK_MARKER))
                    .collect::<Vec<_>>()
                    .join("\n");
                if raw.ends_with('\n') {
                    cleaned.push('\n');
                }
                fs::write(path, cleaned)?;
            }
        }
    } else if spec.id == "opencode" {
        let path = home.join(".config/opencode/plugin/vibelink-complete.js");
        if path.exists() {
            fs::remove_file(path)?;
        }
    }
    Ok(())
}

/// Drop-in agents (OMP, OpenCode) need no config edit at all: the agent scans a
/// directory, so the presence of our file IS the installation.
fn drop_in_path(spec: &AgentHookSpec) -> Result<PathBuf> {
    let name = match spec.id {
        "opencode" => "vibelink-complete.js",
        _ => "vibelink-complete.ts",
    };
    Ok(home_dir()?.join(spec.target).join(name))
}

/// Body for a drop-in hook module.
///
/// OMP and OpenCode invoke this JavaScript inside their own runtime, so they do
/// not need the stdin-draining command script used by config-driven hooks.
/// Calling the dedicated CLI directly also lets us suppress Windows console
/// allocation. `detached: true` is deliberately forbidden here: with Windows
/// Terminal as the default console host it creates a visible terminal for every
/// completion event.
fn render_drop_in(spec: &AgentHookSpec, exe: &Path) -> String {
    let exe_literal = exe.display().to_string().replace('\\', "\\\\");
    let launch = format!(
        "    if (!process.env.VIBELINK_PANE_ID || !process.env.VIBELINK_SESSION_ID) return;\n    spawn(\"{exe_literal}\", [\"terminal\", \"complete\", \"--pane\", process.env.VIBELINK_PANE_ID, \"--workspace\", process.env.VIBELINK_SESSION_ID, \"--agent-id\", \"{agent}\"], {{ stdio: \"ignore\", windowsHide: true }}).unref();\n",
        agent = spec.id,
    );
    match spec.id {
        "opencode" => format!(
            "// {HOOK_MARKER} v{HOOK_SCRIPT_VERSION} - generated by VibeLink. Safe to delete.\nimport {{ spawn }} from \"node:child_process\";\nexport const VibeLinkComplete = async () => ({{\n  event: async ({{ event }}) => {{\n    if (event.type !== \"session.idle\") return;\n{launch}  }},\n}});\n",
        ),
        _ => format!(
            "// {HOOK_MARKER} v{HOOK_SCRIPT_VERSION} - generated by VibeLink. Safe to delete.\nimport {{ spawn }} from \"node:child_process\";\nexport default function hook(pi) {{\n  pi.on(\"{event}\", async () => {{\n{launch}  }});\n}}\n",
            event = spec.completion_events[0],
        ),
    }
}

/// Whether our hook is currently installed for `spec`.
fn detect_installed(spec: &AgentHookSpec) -> Result<bool> {
    let home = home_dir()?;
    match spec.kind {
        HookInstallKind::DropInDirectory => {
            let path = drop_in_path(spec)?;
            if !path.exists() {
                return Ok(false);
            }
            let body = fs::read_to_string(path)?;
            Ok(body.contains(HOOK_MARKER)
                && body.contains(&format!("v{HOOK_SCRIPT_VERSION}"))
                && body.contains("VIBELINK_PANE_ID")
                && body.contains("VIBELINK_SESSION_ID")
                && body.contains("windowsHide: true")
                && !body.contains("detached: true")
                && body.contains("\"terminal\", \"complete\"")
                && spec
                    .completion_events
                    .iter()
                    .all(|event| body.contains(event)))
        }
        HookInstallKind::JsonHooks => {
            if !script_is_current(spec.id)? {
                return Ok(false);
            }
            let path = home.join(spec.target);
            let Some(config) = read_json_config(&path)? else {
                return Ok(false);
            };
            let Some(hooks) = config.get("hooks").and_then(Value::as_object) else {
                return Ok(false);
            };
            let script = script_path(spec.id)?;
            Ok(spec.completion_events.iter().all(|event| {
                hooks
                    .get(*event)
                    .and_then(Value::as_array)
                    .is_some_and(|list| {
                        list.iter()
                            .any(|entry| is_our_json_hook_entry(entry, &script))
                    })
            }))
        }
    }
}

fn blocked_reason(spec: &AgentHookSpec) -> Option<String> {
    match spec.kind {
        HookInstallKind::JsonHooks => {
            json_hooks_blocked_reason(&home_dir().ok()?.join(spec.target), spec)
        }
        HookInstallKind::DropInDirectory => None,
    }
}

pub fn status() -> Result<Vec<AgentHookStatus>> {
    let home = home_dir()?;
    AGENT_HOOK_SPECS
        .iter()
        .map(|spec| {
            let config_path = match spec.kind {
                HookInstallKind::DropInDirectory => drop_in_path(spec)?,
                _ => home.join(spec.target),
            };
            Ok(AgentHookStatus {
                id: spec.id.to_string(),
                display_name: spec.display_name.to_string(),
                installed: detect_installed(spec).unwrap_or(false),
                config_present: config_path.exists(),
                config_path: config_path.display().to_string(),
                blocked_reason: blocked_reason(spec),
            })
        })
        .collect()
}

pub fn install(agent_id: &str) -> Result<AgentHookStatus> {
    let spec = spec_for(agent_id)?;
    if let Some(reason) = blocked_reason(spec) {
        anyhow::bail!(reason);
    }
    let home = home_dir()?;
    let owned_script = script_path(agent_id)?;
    remove_legacy_artifacts(&home, spec, &owned_script)?;

    match spec.kind {
        HookInstallKind::JsonHooks => {
            let script = write_script(agent_id)?;
            let path = home.join(spec.target);
            let mut config = read_json_config(&path)?.unwrap_or_default();
            apply_json_hooks(&mut config, spec, &script, Some(&script));
            write_json_config(&path, &config)?;
        }
        HookInstallKind::DropInDirectory => {
            remove_script(agent_id)?;
            let path = drop_in_path(spec)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, render_drop_in(spec, &cli_exe()?))?;
        }
    }

    current_status(spec)
}

pub fn uninstall(agent_id: &str) -> Result<AgentHookStatus> {
    let spec = spec_for(agent_id)?;
    let home = home_dir()?;

    let script = script_path(spec.id)?;
    remove_legacy_artifacts(&home, spec, &script)?;
    match spec.kind {
        HookInstallKind::JsonHooks => {
            let path = home.join(spec.target);
            // A config we cannot parse is left exactly as-is; removing our
            // launcher below still makes any surviving reference harmless.
            if let Ok(Some(mut config)) = read_json_config(&path) {
                apply_json_hooks(&mut config, spec, &script, None);
                write_json_config(&path, &config)?;
            }
        }
        HookInstallKind::DropInDirectory => {
            let path = drop_in_path(spec)?;
            if path.exists() {
                fs::remove_file(&path)?;
            }
        }
    }

    remove_script(agent_id)?;
    current_status(spec)
}

fn current_status(spec: &AgentHookSpec) -> Result<AgentHookStatus> {
    let home = home_dir()?;
    let config_path = match spec.kind {
        HookInstallKind::DropInDirectory => drop_in_path(spec)?,
        _ => home.join(spec.target),
    };
    Ok(AgentHookStatus {
        id: spec.id.to_string(),
        display_name: spec.display_name.to_string(),
        installed: detect_installed(spec).unwrap_or(false),
        config_present: config_path.exists(),
        config_path: config_path.display().to_string(),
        blocked_reason: blocked_reason(spec),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(id: &str) -> &'static AgentHookSpec {
        spec_for(id).unwrap_or_else(|error| panic!("{id} spec: {error}"))
    }

    #[test]
    fn json_hook_round_trip_preserves_foreign_events() {
        let original = serde_json::json!({
            "model": "opus[1m]",
            "permissions": { "defaultMode": "bypassPermissions" },
            "hooks": {
                "UserPromptSubmit": [
                    {"hooks": [{"type": "command", "command": "other-tool-hook.cmd"}]}
                ],
                "Stop": [
                    {"hooks": [{"type": "command", "command": "other-tool-hook.cmd", "timeout": 10}]}
                ],
                "SubagentStop": [
                    {"hooks": [{"type": "command", "command": "other-tool-hook.cmd"}]}
                ]
            }
        });
        let mut config = original.as_object().expect("object").clone();
        let script = Path::new("C:/vl/claude-complete.cmd");

        apply_json_hooks(&mut config, spec("claude"), script, Some(script));

        let stop = config["hooks"]["Stop"].as_array().expect("Stop");
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "other-tool-hook.cmd");
        assert!(is_our_json_hook_entry(&stop[1], script));
        assert_eq!(
            config["hooks"]["SubagentStop"],
            original["hooks"]["SubagentStop"]
        );

        apply_json_hooks(&mut config, spec("claude"), script, None);
        assert_eq!(Value::Object(config), original);
    }

    #[test]
    fn filesystem_round_trip_leaves_no_residue() {
        let sandbox = std::env::temp_dir().join(format!("vibelink-hooks-{}", uuid::Uuid::new_v4()));
        let home = sandbox.join("home");
        let claude = home.join(".claude/settings.json");
        fs::create_dir_all(claude.parent().expect("claude dir")).expect("create claude dir");
        let original_claude = serde_json::json!({
            "model": "opus",
            "hooks": { "Stop": [{"hooks": [{"type": "command", "command": "other.cmd"}]}] }
        });
        fs::write(
            &claude,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&original_claude).expect("json")
            ),
        )
        .expect("seed claude settings");

        let codex_hooks = home.join(".codex/hooks.json");
        fs::create_dir_all(codex_hooks.parent().expect("codex dir")).expect("create codex dir");
        let original_codex_hooks = serde_json::json!({
            "description": "other hooks",
            "hooks": {
                "Stop": [{"hooks": [{"type": "command", "command": "other-codex.cmd"}]}],
                "PreToolUse": [{"matcher": "Bash", "hooks": [{"type": "command", "command": "policy.cmd"}]}]
            }
        });
        fs::write(
            &codex_hooks,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&original_codex_hooks).expect("json")
            ),
        )
        .expect("seed codex hooks");
        let codex_config = home.join(".codex/config.toml");
        fs::write(&codex_config, "notify = [\"other-notify.cmd\"]\n").expect("seed codex config");

        let previous_home = std::env::var_os("USERPROFILE");
        let previous_dir = std::env::var_os("VIBELINK_AGENT_HOOK_DIR");
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("VIBELINK_AGENT_HOOK_DIR", sandbox.join("agent-hooks"));

        let agents = ["claude", "codex", "omp", "opencode"];
        for agent in agents {
            install(agent).unwrap_or_else(|error| panic!("install {agent}: {error}"));
            assert!(
                detect_installed(spec(agent)).unwrap_or(false),
                "{agent} must be detected"
            );
        }
        assert!(render_drop_in(spec("omp"), &cli_exe().expect("cli")).contains("turn_end"));
        assert!(!script_path("omp").expect("omp script").exists());
        assert!(!script_path("opencode").expect("opencode script").exists());
        assert_eq!(
            drop_in_path(spec("opencode"))
                .expect("path")
                .parent()
                .and_then(Path::file_name),
            Some(std::ffi::OsStr::new("plugins"))
        );

        for agent in agents {
            uninstall(agent).unwrap_or_else(|error| panic!("uninstall {agent}: {error}"));
        }

        let claude_after: Value =
            serde_json::from_str(&fs::read_to_string(&claude).expect("claude")).expect("json");
        let codex_after: Value =
            serde_json::from_str(&fs::read_to_string(&codex_hooks).expect("codex")).expect("json");
        assert_eq!(claude_after, original_claude);
        assert_eq!(codex_after, original_codex_hooks);
        assert_eq!(
            fs::read_to_string(&codex_config).expect("config"),
            "notify = [\"other-notify.cmd\"]\n"
        );
        assert!(!drop_in_path(spec("omp")).expect("path").exists());
        assert!(!drop_in_path(spec("opencode")).expect("path").exists());
        for agent in agents {
            assert!(
                !script_path(agent).expect("script").exists(),
                "{agent} launcher residue"
            );
        }

        match previous_home {
            Some(value) => std::env::set_var("USERPROFILE", value),
            None => std::env::remove_var("USERPROFILE"),
        }
        match previous_dir {
            Some(value) => std::env::set_var("VIBELINK_AGENT_HOOK_DIR", value),
            None => std::env::remove_var("VIBELINK_AGENT_HOOK_DIR"),
        }
        let _ = fs::remove_dir_all(&sandbox);
    }

    #[test]
    fn json_hook_install_is_idempotent_and_removes_only_ours() {
        let mut config: Map<String, Value> = serde_json::from_str(
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"other-tool"}]}]}}"#,
        )
        .expect("seed config");
        let script = Path::new("C:/vl/codex-complete.cmd");

        apply_json_hooks(&mut config, spec("codex"), script, Some(script));
        apply_json_hooks(&mut config, spec("codex"), script, Some(script));
        let stop = config["hooks"]["Stop"].as_array().expect("Stop array");
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "other-tool");
        assert!(is_our_json_hook_entry(&stop[1], script));
        assert_eq!(
            stop[1]["hooks"][0]["commandWindows"],
            script.display().to_string()
        );

        apply_json_hooks(&mut config, spec("codex"), script, None);
        let stop = config["hooks"]["Stop"].as_array().expect("Stop array");
        assert_eq!(stop.len(), 1);
        assert_eq!(stop[0]["hooks"][0]["command"], "other-tool");
    }

    #[test]
    fn uninstall_from_clean_json_config_leaves_no_hook_table() {
        let mut config = Map::new();
        let script = Path::new("C:/vl/hook.cmd");
        apply_json_hooks(&mut config, spec("claude"), script, Some(script));
        apply_json_hooks(&mut config, spec("claude"), script, None);
        assert!(
            config.get("hooks").is_none(),
            "empty hooks table: {config:?}"
        );
    }

    #[test]
    fn scripts_no_op_without_a_vibelink_pane() {
        let script = render_script("omp", Path::new("C:/vl/app.exe"));
        assert!(
            script.contains("VIBELINK_PANE_ID"),
            "the pane guard is what keeps the hook inert outside VibeLink"
        );
        assert!(script.contains(HOOK_MARKER));
    }

    #[test]
    fn drop_in_modules_guard_on_pane_id() {
        for id in ["omp", "opencode"] {
            let spec = spec_for(id).expect("spec");
            let body = render_drop_in(spec, Path::new("C:/vl/vibelink.exe"));
            assert!(
                body.contains("VIBELINK_PANE_ID"),
                "{id} must guard on pane id"
            );
            assert!(body.contains(HOOK_MARKER), "{id} must be identifiable");
        }
    }

    #[test]
    fn drop_in_modules_launch_cli_without_detached_console() {
        for id in ["omp", "opencode"] {
            let body = render_drop_in(spec(id), Path::new("C:/vl/vibelink.exe"));
            assert!(
                body.contains("windowsHide: true"),
                "{id} must suppress Windows console allocation"
            );
            assert!(
                !body.contains("detached: true"),
                "{id} must not create a detached console process group"
            );
            assert!(
                body.contains("\"terminal\", \"complete\""),
                "{id} must call the dedicated CLI directly"
            );
        }
    }

    #[test]
    fn specs_follow_current_agent_hook_locations_and_turn_events() {
        let claude = spec_for("claude").expect("claude");
        assert_eq!(claude.target, ".claude/settings.json");
        assert_eq!(claude.completion_events, &["Stop"]);

        let codex = spec_for("codex").expect("codex");
        assert_eq!(codex.target, ".codex/hooks.json");
        assert_eq!(codex.completion_events, &["Stop"]);

        let omp = spec_for("omp").expect("omp");
        assert_eq!(omp.target, ".omp/agent/hooks/pre");
        assert_eq!(omp.completion_events, &["turn_end"]);
        let omp_module = render_drop_in(omp, Path::new("C:/vl/vibelink.exe"));
        assert!(omp_module.contains("pi.on(\"turn_end\""));
        assert!(!omp_module.contains("session_stop"));

        let opencode = spec_for("opencode").expect("opencode");
        assert_eq!(opencode.target, ".config/opencode/plugins");
        assert_eq!(opencode.completion_events, &["session.idle"]);
    }
}

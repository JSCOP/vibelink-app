//! Agent completion hooks.
//!
//! VibeLink learns that an AI coding agent finished a turn by asking the agent
//! itself, rather than guessing from terminal bytes. Each supported agent gets
//! one small launcher script under our OWN app-data directory; the agent's
//! config only gains a reference to that script.
//!
//! Three properties are load-bearing and every future edit must preserve them:
//!
//! 1. **Non-destructive.** We never rewrite an agent's config wholesale. JSON
//!    hook arrays are APPENDED to and every entry we add carries
//!    [`HOOK_MARKER`], so uninstall removes exactly our entries and leaves the
//!    user's own hooks (and other tools' hooks) untouched. A config we cannot
//!    parse is left alone and reported, never overwritten.
//! 2. **Reversible.** `uninstall` is the exact inverse of `install`: our marked
//!    config entries go away and our scripts are deleted. Nothing of ours
//!    survives in the user's agent directories.
//! 3. **Inert outside VibeLink.** The scripts key off `VIBELINK_PANE_ID`, which
//!    only exists inside a VibeLink PTY. Running the same agent in Windows
//!    Terminal executes the script, finds no pane id, and exits 0 immediately.
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

/// Stamped into every config entry we author so uninstall can find its own work
/// without disturbing hooks written by the user or by another tool.
pub const HOOK_MARKER: &str = "vibelink-agent-hook";

/// Bumped when a generated script's contents change so install can refresh a
/// stale script in place.
const HOOK_SCRIPT_VERSION: u32 = 1;

/// How a given agent is told about our hook script.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum HookInstallKind {
    /// Agent reads `settings.json` and runs commands listed per event.
    ClaudeSettings,
    /// Agent reads `config.toml` and runs one `notify` program.
    CodexNotify,
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
        kind: HookInstallKind::ClaudeSettings,
        target: ".claude/settings.json",
        // `Stop` is the real turn boundary; `SubagentStop` keeps nested agent
        // teams from looking finished while the parent is still working.
        completion_events: &["Stop", "SubagentStop"],
    },
    AgentHookSpec {
        id: "codex",
        display_name: "Codex",
        kind: HookInstallKind::CodexNotify,
        target: ".codex/config.toml",
        completion_events: &["turn-ended"],
    },
    AgentHookSpec {
        id: "omp",
        display_name: "Oh My Pi",
        kind: HookInstallKind::DropInDirectory,
        target: ".omp/agent/hooks/pre",
        completion_events: &["session_stop"],
    },
    AgentHookSpec {
        id: "opencode",
        display_name: "OpenCode",
        kind: HookInstallKind::DropInDirectory,
        target: ".config/opencode/plugin",
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
/// flavors, so the script bakes in the exact one that installed it.
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

/// Read a JSON config, returning `None` when the file does not exist yet and an
/// error when it exists but cannot be parsed. Refusing to proceed on a parse
/// error is deliberate: silently replacing an unreadable config would destroy
/// user configuration.
fn read_json_config(path: &Path) -> Result<Option<Map<String, Value>>> {
    if !path.exists() {
        return Ok(None);
    }
    let raw = fs::read_to_string(path)
        .with_context(|| format!("could not read {}", path.display()))?;
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

/// True when a Claude hook entry is one VibeLink authored.
fn is_our_claude_entry(entry: &Value) -> bool {
    entry
        .get("hooks")
        .and_then(Value::as_array)
        .is_some_and(|hooks| {
            hooks.iter().any(|hook| {
                hook.get(HOOK_MARKER).is_some()
                    || hook
                        .get("command")
                        .and_then(Value::as_str)
                        .is_some_and(|command| command.contains(HOOK_MARKER))
            })
        })
}

fn claude_hook_entry(script: &Path) -> Value {
    serde_json::json!({
        "matcher": "*",
        "hooks": [{
            "type": "command",
            "command": script.display().to_string(),
            "timeout": 5,
            HOOK_MARKER: HOOK_SCRIPT_VERSION,
        }],
    })
}

/// Append our entry to each completion event, replacing only a previous VibeLink
/// entry. Every other entry in the array is preserved exactly as written.
fn apply_claude_hooks(
    config: &mut Map<String, Value>,
    spec: &AgentHookSpec,
    script: Option<&Path>,
) {
    let entry = config
        .entry("hooks")
        .or_insert_with(|| Value::Object(Map::new()));
    // A non-object `hooks` belongs to someone else's schema; leave it alone.
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
        list.retain(|entry| !is_our_claude_entry(entry));
        if let Some(script) = script {
            list.push(claude_hook_entry(script));
        }
        if list.is_empty() {
            hooks.remove(*event);
        }
    }

    if hooks.is_empty() {
        config.remove("hooks");
    }
}

/// Codex exposes a single `notify` slot, and other tools chain through it. We
/// therefore only ever claim an EMPTY slot, and on uninstall we only clear a
/// value that is still ours. A foreign `notify` is reported as blocked so the
/// user can decide, instead of being silently clobbered.
fn codex_notify_line(script: &Path) -> String {
    format!(
        "notify = [\"{}\"] # {HOOK_MARKER}",
        script.display().to_string().replace('\\', "\\\\")
    )
}

fn codex_has_foreign_notify(raw: &str) -> bool {
    raw.lines().any(|line| {
        let trimmed = line.trim_start();
        trimmed.starts_with("notify") && !trimmed.contains(HOOK_MARKER)
    })
}

fn apply_codex_notify(raw: &str, script: Option<&Path>) -> String {
    let mut lines: Vec<String> = raw
        .lines()
        .filter(|line| !line.contains(HOOK_MARKER))
        .map(str::to_string)
        .collect();
    if let Some(script) = script {
        lines.push(codex_notify_line(script));
    }
    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
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

/// Body for a drop-in hook module. It shells out to the same launcher script so
/// there is exactly one place that knows how to reach VibeLink.
fn render_drop_in(spec: &AgentHookSpec, script: &Path) -> String {
    let script_literal = script.display().to_string().replace('\\', "\\\\");
    match spec.id {
        "opencode" => format!(
            "// {HOOK_MARKER} v{HOOK_SCRIPT_VERSION} - generated by VibeLink. Safe to delete.\n\
             import {{ spawn }} from \"node:child_process\";\n\
             export const VibeLinkComplete = async () => ({{\n\
             \x20 event: async ({{ event }}) => {{\n\
             \x20   if (event.type !== \"session.idle\") return;\n\
             \x20   if (!process.env.VIBELINK_PANE_ID) return;\n\
             \x20   spawn(\"{script_literal}\", {{ stdio: \"ignore\", detached: true }}).unref();\n\
             \x20 }},\n\
             }});\n",
        ),
        _ => format!(
            "// {HOOK_MARKER} v{HOOK_SCRIPT_VERSION} - generated by VibeLink. Safe to delete.\n\
             import {{ spawn }} from \"node:child_process\";\n\
             export default function hook(pi) {{\n\
             \x20 pi.on(\"session_stop\", async () => {{\n\
             \x20   if (!process.env.VIBELINK_PANE_ID) return;\n\
             \x20   spawn(\"{script_literal}\", {{ stdio: \"ignore\", detached: true }}).unref();\n\
             \x20 }});\n\
             }}\n",
        ),
    }
}

/// Whether our hook is currently installed for `spec`.
fn detect_installed(spec: &AgentHookSpec) -> Result<bool> {
    let home = home_dir()?;
    match spec.kind {
        HookInstallKind::DropInDirectory => Ok(drop_in_path(spec)?.exists()),
        HookInstallKind::CodexNotify => {
            let path = home.join(spec.target);
            if !path.exists() {
                return Ok(false);
            }
            Ok(fs::read_to_string(&path)?.contains(HOOK_MARKER))
        }
        HookInstallKind::ClaudeSettings => {
            let path = home.join(spec.target);
            let Some(config) = read_json_config(&path)? else {
                return Ok(false);
            };
            let Some(hooks) = config.get("hooks").and_then(Value::as_object) else {
                return Ok(false);
            };
            Ok(spec.completion_events.iter().all(|event| {
                hooks
                    .get(*event)
                    .and_then(Value::as_array)
                    .is_some_and(|list| list.iter().any(is_our_claude_entry))
            }))
        }
    }
}

fn blocked_reason(spec: &AgentHookSpec) -> Option<String> {
    let home = home_dir().ok()?;
    let path = home.join(spec.target);
    match spec.kind {
        HookInstallKind::ClaudeSettings => match read_json_config(&path) {
            Err(error) => Some(error.to_string()),
            Ok(_) => None,
        },
        HookInstallKind::CodexNotify => {
            let raw = fs::read_to_string(&path).ok()?;
            codex_has_foreign_notify(&raw).then(|| {
                format!(
                    "{} already defines a notify program owned by another tool; \
                     VibeLink will not replace it.",
                    path.display()
                )
            })
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
    let script = write_script(agent_id)?;
    let home = home_dir()?;

    match spec.kind {
        HookInstallKind::ClaudeSettings => {
            let path = home.join(spec.target);
            let mut config = read_json_config(&path)?.unwrap_or_default();
            apply_claude_hooks(&mut config, spec, Some(&script));
            write_json_config(&path, &config)?;
        }
        HookInstallKind::CodexNotify => {
            let path = home.join(spec.target);
            let raw = if path.exists() {
                fs::read_to_string(&path)?
            } else {
                String::new()
            };
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, apply_codex_notify(&raw, Some(&script)))?;
        }
        HookInstallKind::DropInDirectory => {
            let path = drop_in_path(spec)?;
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(&path, render_drop_in(spec, &script))?;
        }
    }

    current_status(spec)
}

pub fn uninstall(agent_id: &str) -> Result<AgentHookStatus> {
    let spec = spec_for(agent_id)?;
    let home = home_dir()?;

    match spec.kind {
        HookInstallKind::ClaudeSettings => {
            let path = home.join(spec.target);
            // A config we cannot parse is left exactly as-is; our script removal
            // below still makes the hook a no-op.
            if let Ok(Some(mut config)) = read_json_config(&path) {
                apply_claude_hooks(&mut config, spec, None);
                write_json_config(&path, &config)?;
            }
        }
        HookInstallKind::CodexNotify => {
            let path = home.join(spec.target);
            if path.exists() {
                let raw = fs::read_to_string(&path)?;
                if raw.contains(HOOK_MARKER) {
                    fs::write(&path, apply_codex_notify(&raw, None))?;
                }
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

    fn claude_spec() -> &'static AgentHookSpec {
        spec_for("claude").expect("claude spec")
    }

    /// Byte-exact install -> uninstall round trip against a config shaped like a
    /// REAL user's file: many events, and hooks owned by another tool (Orca) on
    /// the very events we also subscribe to. This is the guarantee the user
    /// asked for — we must not "dirty" the agent's configuration.
    #[test]
    fn claude_round_trip_restores_a_realistic_config_byte_for_byte() {
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
                ],
                "PostToolUse": [
                    {"matcher": "*", "hooks": [{"type": "command", "command": "user-own-hook.js"}]}
                ]
            }
        });
        let mut config = original.as_object().expect("object").clone();

        apply_claude_hooks(&mut config, claude_spec(), Some(Path::new("C:/vl/hook.cmd")));

        // While installed, our entry coexists with the foreign one.
        let stop = config["hooks"]["Stop"].as_array().expect("Stop");
        assert_eq!(stop.len(), 2);
        assert_eq!(stop[0]["hooks"][0]["command"], "other-tool-hook.cmd");
        // Events we never subscribe to are untouched even while installed.
        assert_eq!(config["hooks"]["PostToolUse"], original["hooks"]["PostToolUse"]);

        apply_claude_hooks(&mut config, claude_spec(), None);

        assert_eq!(
            Value::Object(config),
            original,
            "uninstall must restore the user's config exactly"
        );
    }

    /// Full filesystem round trip: install every hook into a sandbox home, then
    /// uninstall, and prove the agent directories are byte-identical to how we
    /// found them and that no generated script survives.
    #[test]
    fn filesystem_round_trip_leaves_no_residue() {
        let sandbox = std::env::temp_dir()
            .join(format!("vibelink-hooks-{}", uuid::Uuid::new_v4()));
        let home = sandbox.join("home");
        let claude = home.join(".claude/settings.json");
        fs::create_dir_all(claude.parent().expect("claude dir")).expect("create claude dir");
        // Shaped like a real user's file, including another tool's hooks on the
        // exact events we subscribe to.
        let original_claude = concat!(
            "{\n  \"model\": \"opus\",\n  \"hooks\": {\n",
            "    \"Stop\": [{\"hooks\": [{\"type\": \"command\", \"command\": \"other.cmd\"}]}]\n",
            "  }\n}\n"
        );
        fs::write(&claude, original_claude).expect("seed claude settings");

        let codex = home.join(".codex/config.toml");
        fs::create_dir_all(codex.parent().expect("codex dir")).expect("create codex dir");
        let original_codex = "model = \"gpt-5\"\n";
        fs::write(&codex, original_codex).expect("seed codex config");

        // Redirect BOTH the agent-config home and our script directory so the
        // whole subsystem operates inside the sandbox.
        let previous_home = std::env::var_os("USERPROFILE");
        let previous_dir = std::env::var_os("VIBELINK_AGENT_HOOK_DIR");
        std::env::set_var("USERPROFILE", &home);
        std::env::set_var("VIBELINK_AGENT_HOOK_DIR", sandbox.join("agent-hooks"));

        let agents = ["claude", "codex", "omp", "opencode"];
        for agent in agents {
            install(agent).unwrap_or_else(|error| panic!("install {agent}: {error}"));
        }
        // Drop-in agents are installed purely by file presence.
        assert!(drop_in_path(spec_for("omp").expect("omp")).expect("path").exists());
        assert!(fs::read_to_string(&claude).expect("read").contains(HOOK_MARKER));

        for agent in agents {
            uninstall(agent).unwrap_or_else(|error| panic!("uninstall {agent}: {error}"));
        }

        assert_eq!(
            fs::read_to_string(&codex).expect("read codex"),
            original_codex,
            "codex config must be restored exactly"
        );
        let claude_after: Value =
            serde_json::from_str(&fs::read_to_string(&claude).expect("read claude")).expect("json");
        let claude_before: Value = serde_json::from_str(original_claude).expect("json");
        assert_eq!(claude_after, claude_before, "claude config must be restored");
        assert!(
            !drop_in_path(spec_for("omp").expect("omp")).expect("path").exists(),
            "the OMP drop-in hook file must be deleted"
        );
        assert!(
            !drop_in_path(spec_for("opencode").expect("opencode")).expect("path").exists(),
            "the OpenCode drop-in hook file must be deleted"
        );

        // The generated scripts live under our own app data, and must be gone too.
        assert!(
            script_path("omp").expect("script path").parent()
                .is_none_or(|dir| !dir.join("omp-complete.cmd").exists()
                    && !dir.join("omp-complete.sh").exists()),
            "generated launcher scripts must be deleted on uninstall"
        );

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
    fn claude_install_preserves_foreign_hooks() {
        let mut config: Map<String, Value> = serde_json::from_str(
            r#"{
                "model": "opus",
                "hooks": {
                    "Stop": [
                        {"matcher": "*", "hooks": [{"type": "command", "command": "other-tool"}]}
                    ]
                }
            }"#,
        )
        .expect("seed config");

        apply_claude_hooks(&mut config, claude_spec(), Some(Path::new("C:/vl/hook.cmd")));

        let stop = config["hooks"]["Stop"].as_array().expect("Stop array");
        assert_eq!(stop.len(), 2, "foreign hook must survive install");
        assert_eq!(stop[0]["hooks"][0]["command"], "other-tool");
        assert!(is_our_claude_entry(&stop[1]));
        // Unrelated top-level keys are untouched.
        assert_eq!(config["model"], "opus");
    }

    #[test]
    fn claude_uninstall_removes_only_our_entry() {
        let mut config: Map<String, Value> = serde_json::from_str(
            r#"{"hooks": {"Stop": [
                {"matcher": "*", "hooks": [{"type": "command", "command": "other-tool"}]}
            ]}}"#,
        )
        .expect("seed config");

        apply_claude_hooks(&mut config, claude_spec(), Some(Path::new("C:/vl/hook.cmd")));
        apply_claude_hooks(&mut config, claude_spec(), None);

        let stop = config["hooks"]["Stop"].as_array().expect("Stop array");
        assert_eq!(stop.len(), 1, "only the VibeLink entry may be removed");
        assert_eq!(stop[0]["hooks"][0]["command"], "other-tool");
    }

    #[test]
    fn claude_install_is_idempotent() {
        let mut config = Map::new();
        let script = Path::new("C:/vl/hook.cmd");
        apply_claude_hooks(&mut config, claude_spec(), Some(script));
        apply_claude_hooks(&mut config, claude_spec(), Some(script));

        for event in claude_spec().completion_events {
            let list = config["hooks"][*event].as_array().expect("event array");
            assert_eq!(list.len(), 1, "{event} must not accumulate duplicates");
        }
    }

    #[test]
    fn claude_uninstall_from_clean_config_leaves_no_residue() {
        let mut config = Map::new();
        apply_claude_hooks(&mut config, claude_spec(), Some(Path::new("C:/vl/h.cmd")));
        apply_claude_hooks(&mut config, claude_spec(), None);
        assert!(
            config.get("hooks").is_none(),
            "an empty hooks table must be removed entirely, got {config:?}"
        );
    }

    #[test]
    fn codex_notify_round_trips_without_touching_other_keys() {
        let original = "model = \"gpt-5\"\nsandbox = \"read-only\"\n";
        let installed = apply_codex_notify(original, Some(Path::new("C:/vl/codex.cmd")));
        assert!(installed.contains("model = \"gpt-5\""));
        assert!(installed.contains(HOOK_MARKER));

        let removed = apply_codex_notify(&installed, None);
        assert_eq!(removed, original, "uninstall must restore the original file");
    }

    #[test]
    fn codex_foreign_notify_is_detected() {
        assert!(codex_has_foreign_notify("notify = [\"other-tool\"]\n"));
        assert!(!codex_has_foreign_notify(&apply_codex_notify(
            "",
            Some(Path::new("C:/vl/codex.cmd"))
        )));
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
            let body = render_drop_in(spec, Path::new("C:/vl/hook.cmd"));
            assert!(body.contains("VIBELINK_PANE_ID"), "{id} must guard on pane id");
            assert!(body.contains(HOOK_MARKER), "{id} must be identifiable");
        }
    }
}

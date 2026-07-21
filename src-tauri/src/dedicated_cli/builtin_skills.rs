use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const BUILTIN_SKILL_VERSION: &str = "1.0.0";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BuiltinSkillDefinition {
    pub id: &'static str,
    pub version: &'static str,
    pub name: &'static str,
    pub category: &'static str,
    pub description: &'static str,
    pub required_capabilities: &'static [&'static str],
    pub content: &'static str,
}

const CLI_CONTENT: &str = r#"# VibeLink CLI

Use the dedicated `vibelink` console program. Do not invoke GUI executable compatibility modes.

## Contract

- Use `--json` for automation. Stdout is one versioned result or error envelope; diagnostics and 15-second wait keepalives are stderr-only.
- Scope explicitly with `--workspace`, `--pane`, `--agent`, `--page`, `--tab`, `--app`, or `--window`. An ambiguous selector is an error; never fall back to the focused target.
- Mutations carry an operation UUID automatically. Supply `--operation-id <uuid>` when retrying the same operation and `--expected-revision <n>` for compare-and-swap updates.
- Recover `not_found`, `stale_target`, and `ambiguous_selector` by listing targets and selecting a unique stable ID. Do not guess.

## Command families

`vibelink status`
`vibelink workspace list|create|show|open|sleep|wake|delete`
`vibelink terminal list|show|read|send|wait|create|split|close`
`vibelink orchestration ...`
`vibelink automation list|create|update|delete|run|runs|precheck`
`vibelink browser ...`
`vibelink computer ...`
`vibelink skill list|show|apply|delete|doctor`
`vibelink remote status|pair|devices|revoke`
`vibelink mcp serve`

Treat `denied_capability`, `conflict`, `timeout`, and `unavailable_runtime` as explicit outcomes. Never parse human diagnostics from stderr as command results.
"#;

const ORCHESTRATION_CONTENT: &str = r#"# VibeLink Orchestration

The desktop Control Plane owns missions, tasks, dependencies, dispatches, messages, gates, revisions, and replay. Agents report through the dedicated CLI or workspace-bound MCP tools; terminal focus is never lifecycle authority.

## Commands

Use `vibelink orchestration run` to submit a mission. Inspect with `check`, `inbox`, `task-list`, `dispatch-show`, and `gate-list`. Communicate with `send`, `reply`, and `ask`. Coordinators create and update DAG nodes through `task-create` and `task-update`, dispatch ready work through `dispatch`, and stop a mission with `run-stop`. Use `gate-create` and `gate-resolve` for approvals. `reset` is explicit and policy-gated.

## Lifecycle identity

Preserve `VIBELINK_RUN_ID`, `VIBELINK_TASK_ID`, `VIBELINK_DISPATCH_ID`, `VIBELINK_AGENT_INSTANCE_ID`, `VIBELINK_SESSION_ID`, and the exact worktree path. A `worker_done` or `merge_ready` report is valid only for the active task, dispatch, agent instance, and pane/process generation.

`worker_done` records a result; it never authorizes merge. Merge into the user's branch, destructive cleanup, deployment, publishing, purchases, authenticated business actions, and sensitive computer actions require an explicit decision gate.

On a revision conflict, reload the run/task and retry with a new operation ID unless the prior operation's outcome is unknown; in that case retry the same operation ID. On stale dispatch identity, stop and reconcile rather than selecting a focused terminal.
"#;

const BROWSER_CONTENT: &str = r#"# VibeLink Browser

Browser authority lives in the desktop BrowserManager and its native WebView2 provider. Use stable page/tab/profile IDs and the browser capability granted to this workspace.

## Workflow

1. Select or create the intended profile/tab.
2. Navigate and obtain a fresh `vibelink browser snapshot`.
3. Act with snapshot-scoped refs using `click`, `double-click`, `fill`, `type`, `select`, `check`, `focus`, `clear`, `keypress`, `hover`, `drag`, `upload`, `scroll`, or `scroll-into-view`.
4. Verify with `wait`, a new snapshot, `get`/`is`, screenshot, console, or network inspection.

Refs are valid only for their page, navigation generation, and snapshot. A stale backend node may recover once only when role, name, and duplicate ordinal resolve uniquely. Otherwise accept `stale_ref`, obtain a new snapshot, and never click a guessed match.

Basic control does not imply permission to evaluate arbitrary script, export cookies, mutate storage, download files, access local files, or perform authenticated/destructive website actions. Those operations require their own capability or approval. Never print cookies, passwords, tokens, or private account data.
"#;

const COMPUTER_CONTENT: &str = r#"# VibeLink Computer Use

Computer use is performed by the restartable native Windows provider, not by renderer scripts. Observe before acting and retain the app/window generation from the latest snapshot.

Use `vibelink computer capabilities`, `list-apps`, `list-windows`, and `get-app-state` to select a unique target. Actions are `click`, `perform-secondary-action`, `scroll`, `drag`, `type-text`, `press-key`, `hotkey`, `paste-text`, and `set-value`; inspect prior outcomes with `action-history`.

Prefer semantic UI Automation actions. Coordinate fallback is allowed only for a visible element frame from the same current window generation. High-risk actions use a one-shot lease: call `approval-create` with the exact action and snapshot-scoped target, show the reason, call `approval-resolve --decision approve` only after explicit authorization, then repeat the action with `--approval-id`. Use `--no-screenshot` when pixels are unnecessary. `--restore-window` permits one explicit recovery attempt; never create a silent focus-stealing loop.

Password, PIN, OTP, and secret values are redacted. Windows Security, password managers, UAC secure desktop, configured sensitive apps, and higher-integrity processes are blocked or return typed denial. Never elevate automatically. Sensitive or externally destructive actions require an explicit gate, and a provider restart never repeats the prior action automatically.
"#;

const MOBILE_REMOTE_CONTENT: &str = r#"# VibeLink Mobile Remote

Remote access is direct-first and flavor/device scoped. Pairing keys, not Moobang account sessions, authorize a remote device. Inspect with `vibelink remote status` and `devices`; use `pair` only for a user-approved invite and `revoke` for an exact device ID.

Device grants are explicit: `terminal.view`, `terminal.input`, `orchestration.view`, `orchestration.control`, `browser.view`, `browser.control`, `files.view`, `git.write`, `computer.observe`, `computer.control`, and `admin`. Never infer one grant from another.

Terminal mirror/readable modes must not resize desktop PTYs. Only explicit mobile mode may hold one bounded pane lease, and it must release on mode, pane, or workspace change, background, disconnect, revocation, unmount, and termination reconciliation.

Control/event sequence gaps require domain resync. Browser video may use latest-frame-wins only with dropped-frame accounting. Push payloads are opaque and contain no prompt or result text; reconnect over the authenticated encrypted channel to fetch authorized details. Never expose pairing secrets, resume credentials, pins, tokens, or remote content in CLI output or logs.
"#;

pub const BUILTIN_SKILLS: &[BuiltinSkillDefinition] = &[
    BuiltinSkillDefinition {
        id: "vibelink-cli",
        version: BUILTIN_SKILL_VERSION,
        name: "VibeLink CLI",
        category: "Workspace",
        description: "Use the dedicated typed VibeLink command surface safely and predictably.",
        required_capabilities: &[],
        content: CLI_CONTENT,
    },
    BuiltinSkillDefinition {
        id: "vibelink-orchestration",
        version: BUILTIN_SKILL_VERSION,
        name: "VibeLink Orchestration",
        category: "Planning",
        description: "Coordinate durable runs, DAG tasks, dispatches, messages, and gates.",
        required_capabilities: &["orchestration.view"],
        content: ORCHESTRATION_CONTENT,
    },
    BuiltinSkillDefinition {
        id: "vibelink-browser",
        version: BUILTIN_SKILL_VERSION,
        name: "VibeLink Browser",
        category: "Browser",
        description: "Operate native browser pages with snapshot-scoped references and explicit risk gates.",
        required_capabilities: &["browser.view"],
        content: BROWSER_CONTENT,
    },
    BuiltinSkillDefinition {
        id: "vibelink-computer-use",
        version: BUILTIN_SKILL_VERSION,
        name: "VibeLink Computer Use",
        category: "Computer",
        description: "Observe and control Windows apps through the guarded native provider.",
        required_capabilities: &["computer.observe"],
        content: COMPUTER_CONTENT,
    },
    BuiltinSkillDefinition {
        id: "vibelink-mobile-remote",
        version: BUILTIN_SKILL_VERSION,
        name: "VibeLink Mobile Remote",
        category: "Remote",
        description: "Use paired mobile remote access without weakening grants, sequence, or PTY geometry rules.",
        required_capabilities: &["admin"],
        content: MOBILE_REMOTE_CONTENT,
    },
];

pub fn builtin_skills() -> &'static [BuiltinSkillDefinition] {
    BUILTIN_SKILLS
}

pub fn builtin_skill(id: &str) -> Option<&'static BuiltinSkillDefinition> {
    BUILTIN_SKILLS.iter().find(|skill| skill.id == id)
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SkillSource {
    Builtin,
    Global,
    Workspace,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillContent {
    pub id: String,
    pub source: SkillSource,
    pub content: String,
}

pub fn resolve_skill_precedence(
    entries: impl IntoIterator<Item = SkillContent>,
) -> Vec<SkillContent> {
    let mut resolved = BTreeMap::<String, SkillContent>::new();
    for entry in entries {
        match resolved.get(&entry.id) {
            Some(existing) if existing.source > entry.source => {}
            _ => {
                resolved.insert(entry.id.clone(), entry);
            }
        }
    }
    resolved.into_values().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_ids_versions_and_content_are_complete() {
        let ids = builtin_skills()
            .iter()
            .map(|skill| skill.id)
            .collect::<Vec<_>>();
        assert_eq!(
            ids,
            [
                "vibelink-cli",
                "vibelink-orchestration",
                "vibelink-browser",
                "vibelink-computer-use",
                "vibelink-mobile-remote",
            ]
        );
        assert!(builtin_skills()
            .iter()
            .all(|skill| skill.version == "1.0.0" && skill.content.len() > 500));
        assert!(builtin_skill("vibelink-cli")
            .expect("CLI skill")
            .content
            .contains("Stdout is one versioned result or error envelope"));
        assert!(builtin_skill("vibelink-orchestration")
            .expect("orchestration skill")
            .content
            .contains("worker_done"));
        assert!(builtin_skill("vibelink-browser")
            .expect("browser skill")
            .content
            .contains("stale_ref"));
        assert!(builtin_skill("vibelink-computer-use")
            .expect("computer skill")
            .content
            .contains("Never elevate automatically"));
        assert!(builtin_skill("vibelink-mobile-remote")
            .expect("remote skill")
            .content
            .contains("must not resize desktop PTYs"));
    }

    #[test]
    fn workspace_content_overrides_global_and_builtin_content() {
        let resolved = resolve_skill_precedence([
            SkillContent {
                id: "same".to_string(),
                source: SkillSource::Global,
                content: "global".to_string(),
            },
            SkillContent {
                id: "same".to_string(),
                source: SkillSource::Builtin,
                content: "builtin".to_string(),
            },
            SkillContent {
                id: "same".to_string(),
                source: SkillSource::Workspace,
                content: "workspace".to_string(),
            },
        ]);
        assert_eq!(resolved.len(), 1);
        assert_eq!(resolved[0].content, "workspace");
    }
}

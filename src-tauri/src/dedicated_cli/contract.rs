use super::{CliError, Command, OperationArguments, SelectorSet};
use serde::Serialize;
use std::collections::BTreeSet;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RiskLevel {
    ReadOnly,
    Mutating,
    HighRisk,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ValueKind {
    String,
    Integer,
    UnsignedInteger,
    Uuid,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OptionSpec {
    pub name: &'static str,
    pub kind: ValueKind,
    pub required: bool,
    pub repeatable: bool,
}

impl OptionSpec {
    pub const fn string(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::String,
            required: false,
            repeatable: false,
        }
    }

    pub const fn required_string(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::String,
            required: true,
            repeatable: false,
        }
    }

    pub const fn integer(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::Integer,
            required: false,
            repeatable: false,
        }
    }

    pub const fn unsigned(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::UnsignedInteger,
            required: false,
            repeatable: false,
        }
    }

    pub const fn required_unsigned(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::UnsignedInteger,
            required: true,
            repeatable: false,
        }
    }

    pub const fn uuid(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::Uuid,
            required: false,
            repeatable: false,
        }
    }

    pub const fn required_uuid(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::Uuid,
            required: true,
            repeatable: false,
        }
    }

    pub const fn repeated(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::String,
            required: false,
            repeatable: true,
        }
    }

    pub const fn required_repeated(name: &'static str) -> Self {
        Self {
            name,
            kind: ValueKind::String,
            required: true,
            repeatable: true,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandContract {
    pub domain: &'static str,
    pub action: &'static str,
    pub description: &'static str,
    pub selectors: &'static [&'static str],
    pub options: Vec<OptionSpec>,
    pub switches: &'static [&'static str],
    pub positional_max: Option<usize>,
    pub positional_satisfies: Option<&'static str>,
    pub requires_expected_revision: bool,
    pub risk: RiskLevel,
}

const NONE: &[&str] = &[];
const WORKSPACE: &[&str] = &["workspace"];
const WORKSPACE_PANE: &[&str] = &["workspace", "pane"];
const WORKSPACE_PAGE_TAB: &[&str] = &["workspace", "page", "tab"];
const APP_WINDOW: &[&str] = &["app", "window"];

macro_rules! contract {
    ($domain:literal, $action:literal, $description:literal, $selectors:expr, $options:expr, $switches:expr, $max:expr, $positional:expr, $revision:expr, $risk:ident) => {
        CommandContract {
            domain: $domain,
            action: $action,
            description: $description,
            selectors: $selectors,
            options: ($options).to_vec(),
            switches: $switches,
            positional_max: $max,
            positional_satisfies: $positional,
            requires_expected_revision: $revision,
            risk: RiskLevel::$risk,
        }
    };
}

pub fn command_contracts() -> Vec<CommandContract> {
    use OptionSpec as O;
    let mut contracts = vec![
        contract!(
            "workspace",
            "list",
            "List workspaces for the selected flavor.",
            NONE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "workspace",
            "create",
            "Create a workspace.",
            NONE,
            &[O::required_string("name"), O::string("folder")],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "workspace",
            "show",
            "Show one uniquely selected workspace.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "workspace",
            "open",
            "Open a workspace in the desktop UI.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "workspace",
            "sleep",
            "Suspend one workspace without deleting it.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "workspace",
            "wake",
            "Resume one suspended workspace.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "workspace",
            "delete",
            "Delete one workspace after explicit selection.",
            WORKSPACE,
            &[],
            &["confirm"],
            Some(0),
            None,
            false,
            HighRisk
        ),
        contract!(
            "terminal",
            "list",
            "List panes in a workspace.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "terminal",
            "show",
            "Show one uniquely selected pane.",
            WORKSPACE_PANE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "terminal",
            "read",
            "Read bounded pane scrollback.",
            WORKSPACE_PANE,
            &[O::unsigned("max-bytes")],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "terminal",
            "send",
            "Send text to a pane.",
            WORKSPACE_PANE,
            &[O::required_string("text")],
            &["enter"],
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "terminal",
            "wait",
            "Wait for pane output, exit, or matching text using daemon events.",
            WORKSPACE_PANE,
            &[O::string("text"), O::unsigned("after-sequence")],
            &["exit"],
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "terminal",
            "create",
            "Create a pane in a workspace.",
            WORKSPACE,
            &[
                O::required_string("program"),
                O::string("cwd"),
                O::string("title")
            ],
            NONE,
            None,
            None,
            false,
            Mutating
        ),
        contract!(
            "terminal",
            "split",
            "Create a split pane in a workspace.",
            WORKSPACE_PANE,
            &[
                O::required_string("program"),
                O::string("cwd"),
                O::string("title")
            ],
            NONE,
            None,
            None,
            false,
            Mutating
        ),
        contract!(
            "terminal",
            "close",
            "Close one uniquely selected pane.",
            WORKSPACE_PANE,
            &[],
            &["confirm"],
            Some(0),
            None,
            false,
            HighRisk
        ),
        contract!(
            "terminal",
            "complete",
            "Report that the agent in a pane finished a turn (used by agent hooks).",
            WORKSPACE_PANE,
            &[O::string("agent-id")],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "orchestration",
            "send",
            "Send a message to a run or task.",
            WORKSPACE,
            &[
                O::string("run-id"),
                O::string("task-id"),
                O::string("dispatch-id"),
                O::required_string("message")
            ],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "orchestration",
            "check",
            "Read a run, optionally waiting for a revision change.",
            NONE,
            &[O::required_string("run-id"), O::unsigned("after-revision")],
            &["wait"],
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "orchestration",
            "reply",
            "Reply to a threaded orchestration message.",
            NONE,
            &[
                O::required_string("run-id"),
                O::required_string("parent-id"),
                O::string("task-id"),
                O::string("dispatch-id"),
                O::required_string("message")
            ],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "orchestration",
            "inbox",
            "List durable run messages.",
            NONE,
            &[O::required_string("run-id"), O::unsigned("after-sequence")],
            &["wait"],
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "orchestration",
            "task-create",
            "Create a DAG task.",
            NONE,
            &[
                O::required_string("run-id"),
                O::required_string("title"),
                O::string("description"),
                O::repeated("dependency")
            ],
            NONE,
            Some(0),
            None,
            true,
            Mutating
        ),
        contract!(
            "orchestration",
            "task-list",
            "List tasks for a run.",
            NONE,
            &[O::required_string("run-id")],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "orchestration",
            "task-update",
            "Update a task using revision fencing.",
            WORKSPACE,
            &[
                O::required_string("task-id"),
                O::required_string("status"),
                O::string("commit-message"),
                O::string("result-summary")
            ],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "orchestration",
            "dispatch",
            "Schedule and launch ready work.",
            WORKSPACE,
            &[
                O::required_string("run-id"),
                O::required_string("command"),
                O::string("profile"),
                O::string("worktree"),
                O::string("base-revision"),
                O::string("branch")
            ],
            NONE,
            Some(0),
            None,
            true,
            HighRisk
        ),
        contract!(
            "orchestration",
            "dispatch-show",
            "Show one dispatch.",
            NONE,
            &[
                O::required_string("run-id"),
                O::required_string("dispatch-id")
            ],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "orchestration",
            "ask",
            "Create a blocking decision gate.",
            NONE,
            &[
                O::required_string("run-id"),
                O::string("task-id"),
                O::string("dispatch-id"),
                O::required_string("prompt"),
                O::repeated("option")
            ],
            NONE,
            Some(0),
            None,
            true,
            Mutating
        ),
        contract!(
            "orchestration",
            "run",
            "Create and start an orchestration run.",
            WORKSPACE,
            &[O::required_string("goal")],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "orchestration",
            "run-stop",
            "Cancel an orchestration run.",
            NONE,
            &[O::required_string("run-id")],
            &["confirm"],
            Some(0),
            None,
            true,
            HighRisk
        ),
        contract!(
            "orchestration",
            "gate-create",
            "Create an explicit decision gate.",
            NONE,
            &[
                O::required_string("run-id"),
                O::string("task-id"),
                O::string("dispatch-id"),
                O::string("type"),
                O::required_string("prompt"),
                O::repeated("option")
            ],
            NONE,
            Some(0),
            None,
            true,
            Mutating
        ),
        contract!(
            "orchestration",
            "gate-resolve",
            "Resolve an explicit decision gate.",
            NONE,
            &[
                O::required_string("gate-id"),
                O::required_string("resolution")
            ],
            &["confirm"],
            Some(0),
            None,
            true,
            HighRisk
        ),
        contract!(
            "orchestration",
            "gate-list",
            "List gates for a run.",
            NONE,
            &[O::required_string("run-id")],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "orchestration",
            "reset",
            "Request a gated orchestration reset.",
            NONE,
            &[O::required_string("run-id")],
            &["confirm"],
            Some(0),
            None,
            true,
            HighRisk
        ),
        contract!(
            "automation",
            "list",
            "List automations.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "automation",
            "create",
            "Create a scheduled automation from one JSON payload.",
            WORKSPACE,
            &[O::required_string("json")],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "automation",
            "update",
            "Update an automation from one JSON payload.",
            NONE,
            &[O::required_uuid("id"), O::required_string("json")],
            NONE,
            Some(1),
            Some("id"),
            false,
            Mutating
        ),
        contract!(
            "automation",
            "delete",
            "Delete an automation.",
            NONE,
            &[O::required_uuid("id")],
            &["confirm"],
            Some(1),
            Some("id"),
            false,
            HighRisk
        ),
        contract!(
            "automation",
            "run",
            "Run an automation now.",
            NONE,
            &[O::required_uuid("id")],
            NONE,
            Some(1),
            Some("id"),
            false,
            Mutating
        ),
        contract!(
            "automation",
            "runs",
            "List retained automation runs.",
            NONE,
            &[O::required_uuid("id"), O::unsigned("limit")],
            NONE,
            Some(1),
            Some("id"),
            false,
            ReadOnly
        ),
        contract!(
            "automation",
            "schedule-preview",
            "Preview deterministic automation schedule occurrences.",
            NONE,
            &[O::required_string("json")],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "automation",
            "precheck",
            "Run automation prechecks without launching an agent.",
            NONE,
            &[O::required_uuid("id")],
            NONE,
            Some(1),
            Some("id"),
            false,
            ReadOnly
        ),
        contract!(
            "automation",
            "cancel",
            "Cancel an active automation run.",
            NONE,
            &[O::required_uuid("id")],
            NONE,
            Some(1),
            Some("id"),
            false,
            Mutating
        ),
        contract!(
            "automation",
            "import-preview",
            "Preview matching Hermes cron jobs without changing them.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "automation",
            "import",
            "Import reviewed Hermes cron jobs from one JSON payload.",
            WORKSPACE,
            &[O::required_string("json")],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "automation",
            "draft-preview",
            "Generate a review-only Hermes automation draft from one JSON payload.",
            WORKSPACE,
            &[O::required_string("json")],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "automation",
            "draft-cancel",
            "Cancel an active review-only Hermes automation draft.",
            NONE,
            &[O::required_uuid("id")],
            NONE,
            Some(0),
            None,
            false,
            Mutating
        ),
        contract!(
            "computer",
            "capabilities",
            "Read computer-use provider capabilities and health.",
            NONE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "computer",
            "list-apps",
            "List controllable applications.",
            NONE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "computer",
            "list-windows",
            "List windows, optionally by process id.",
            NONE,
            &[O::unsigned("process-id")],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "computer",
            "get-app-state",
            "Observe one app/window with a snapshot-scoped identity.",
            APP_WINDOW,
            &[],
            &["no-screenshot", "restore-window"],
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "computer",
            "approval-create",
            "Create a one-shot approval lease for a high-risk computer action.",
            APP_WINDOW,
            &[
                O::required_string("action"),
                O::required_uuid("snapshot-id"),
                O::required_unsigned("window-generation"),
                O::unsigned("element-index"),
                O::integer("x"),
                O::integer("y"),
                O::integer("delta-x"),
                O::integer("delta-y"),
                O::integer("to-x"),
                O::integer("to-y"),
                O::string("text"),
                O::repeated("key"),
                O::string("value")
            ],
            &["confirm"],
            Some(0),
            None,
            false,
            HighRisk
        ),
        contract!(
            "computer",
            "approval-resolve",
            "Approve or deny a pending one-shot computer action lease.",
            NONE,
            &[
                O::required_uuid("approval-id"),
                O::required_string("decision")
            ],
            &["confirm"],
            Some(0),
            None,
            false,
            HighRisk
        ),
        contract!(
            "computer",
            "approval-list",
            "List recent computer-use approval leases.",
            NONE,
            &[O::unsigned("limit")],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "computer",
            "action-history",
            "List recent computer-use actions and outcomes.",
            NONE,
            &[O::unsigned("limit")],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        computer_action("click", "Invoke or click a current snapshot target.", &[]),
        computer_action(
            "perform-secondary-action",
            "Perform a current target's secondary action.",
            &[],
        ),
        computer_action(
            "scroll",
            "Scroll a current snapshot target.",
            &[O::integer("delta-x"), O::integer("delta-y")],
        ),
        computer_action(
            "drag",
            "Drag a current snapshot target.",
            &[O::required_string("to-x"), O::required_string("to-y")],
        ),
        computer_action(
            "type-text",
            "Type text into a current snapshot target.",
            &[O::required_string("text")],
        ),
        computer_action(
            "press-key",
            "Press one key against a current snapshot target.",
            &[O::required_string("key")],
        ),
        computer_action(
            "hotkey",
            "Press a key chord against a current snapshot target.",
            &[O::repeated("key")],
        ),
        computer_action(
            "paste-text",
            "Paste explicit text into a current snapshot target.",
            &[O::required_string("text")],
        ),
        computer_action(
            "set-value",
            "Set a semantic value on a current snapshot target.",
            &[O::required_string("value")],
        ),
        contract!(
            "skill",
            "list",
            "List built-in and persisted skills by precedence.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "skill",
            "show",
            "Show one skill after workspace/global/builtin resolution.",
            WORKSPACE,
            &[O::string("id"), O::string("scope")],
            NONE,
            Some(1),
            Some("id"),
            false,
            ReadOnly
        ),
        contract!(
            "skill",
            "apply",
            "Persist a skill or apply a versioned built-in guide.",
            WORKSPACE,
            &[
                O::string("id"),
                O::string("scope"),
                O::string("name"),
                O::string("category"),
                O::string("description"),
                O::string("content"),
                O::repeated("capability")
            ],
            &["enable", "disable"],
            Some(1),
            Some("id"),
            false,
            Mutating
        ),
        contract!(
            "skill",
            "delete",
            "Delete a persisted skill; built-ins remain read-only.",
            WORKSPACE,
            &[O::string("id"), O::string("scope")],
            &["confirm"],
            Some(1),
            Some("id"),
            false,
            HighRisk
        ),
        contract!(
            "skill",
            "doctor",
            "Inspect skill persistence and precedence health.",
            WORKSPACE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "remote",
            "status",
            "Read remote server and protocol status.",
            NONE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "remote",
            "configure",
            "Configure remote server state explicitly.",
            NONE,
            &[O::unsigned("port")],
            &["enable", "disable", "enable-lan", "disable-lan"],
            Some(0),
            None,
            false,
            HighRisk
        ),
        contract!(
            "remote",
            "pair",
            "Create a short-lived pairing invite.",
            NONE,
            &[O::unsigned("port")],
            &["enable", "enable-lan", "confirm"],
            Some(0),
            None,
            false,
            HighRisk
        ),
        contract!(
            "remote",
            "devices",
            "List paired remote devices without secrets.",
            NONE,
            &[],
            NONE,
            Some(0),
            None,
            false,
            ReadOnly
        ),
        contract!(
            "remote",
            "revoke",
            "Revoke one exact remote device.",
            NONE,
            &[O::string("device-id")],
            &["confirm"],
            Some(1),
            Some("device-id"),
            false,
            HighRisk
        ),
    ];
    contracts.extend(browser_contracts());
    contracts
}

fn browser_contracts() -> Vec<CommandContract> {
    use OptionSpec as O;
    use RiskLevel::{HighRisk, Mutating, ReadOnly};
    vec![
        browser_action(
            "navigate",
            "Navigate a selected browser page.",
            &[O::string("url")],
            NONE,
            Some(1),
            Mutating,
        ),
        browser_action(
            "snapshot",
            "Capture a bounded accessibility snapshot.",
            &[],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "screenshot",
            "Capture a viewport screenshot artifact.",
            &[],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "full-screenshot",
            "Capture a full-page screenshot artifact.",
            &[],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "pdf",
            "Capture a PDF artifact.",
            &[],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action("back", "Navigate backward.", &[], NONE, Some(0), Mutating),
        browser_action("forward", "Navigate forward.", &[], NONE, Some(0), Mutating),
        browser_action(
            "reload",
            "Reload the selected page.",
            &[],
            &["ignore-cache"],
            Some(0),
            Mutating,
        ),
        browser_action(
            "wait",
            "Wait for a bounded interval.",
            &[O::unsigned("ms")],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "click",
            "Click a uniquely selected DOM element.",
            &[O::required_string("selector")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "double-click",
            "Double-click a uniquely selected DOM element.",
            &[O::required_string("selector")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "fill",
            "Replace a selected element value.",
            &[O::required_string("selector"), O::required_string("text")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "type",
            "Append text to a selected element value.",
            &[O::required_string("selector"), O::required_string("text")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "select",
            "Select a value in a selected element.",
            &[O::required_string("selector"), O::required_string("value")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "check",
            "Set the checked state of a selected element.",
            &[O::required_string("selector"), O::string("value")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "focus",
            "Focus a selected element.",
            &[O::required_string("selector")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "clear",
            "Clear a selected element value.",
            &[O::required_string("selector")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "select-all",
            "Select all text in a selected element.",
            &[O::required_string("selector")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "keypress",
            "Dispatch a key to the selected page.",
            &[O::required_string("key")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "hover",
            "Hover a selected element.",
            &[O::required_string("selector")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "drag",
            "Drag a selected element to page coordinates.",
            &[
                O::required_string("selector"),
                O::required_string("to-x"),
                O::required_string("to-y"),
            ],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "upload",
            "Upload contained workspace files to a selected input.",
            &[O::required_string("selector"), O::required_repeated("file")],
            &["confirm"],
            Some(0),
            HighRisk,
        ),
        browser_action(
            "scroll",
            "Dispatch a page scroll.",
            &[O::string("x"), O::string("y")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "scroll-into-view",
            "Scroll a selected element into view.",
            &[O::required_string("selector")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "find",
            "Find text on the selected page.",
            &[O::required_string("text")],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "get",
            "Read one safe property from a selected element.",
            &[O::required_string("selector"), O::string("property")],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "is",
            "Test one safe state on a selected element.",
            &[O::required_string("selector"), O::string("state")],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "mouse",
            "Dispatch an explicit page mouse event.",
            &[
                O::string("type"),
                O::required_string("x"),
                O::required_string("y"),
                O::string("button"),
            ],
            &["confirm"],
            Some(0),
            HighRisk,
        ),
        browser_action(
            "highlight",
            "Highlight a selected element.",
            &[O::required_string("selector")],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "download",
            "Enable downloads to the canonical artifact directory.",
            &[],
            &["confirm"],
            Some(0),
            HighRisk,
        ),
        browser_action(
            "tabs",
            "List embedded browser targets.",
            &[],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "profiles",
            "List embedded browser profiles.",
            &[],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "cookies",
            "Read browser cookies with an explicit capability grant.",
            &[],
            &["confirm"],
            Some(0),
            HighRisk,
        ),
        browser_action(
            "storage",
            "Read page storage with an explicit capability grant.",
            &[],
            &["confirm"],
            Some(0),
            HighRisk,
        ),
        browser_action(
            "viewport",
            "Set viewport metrics.",
            &[
                O::unsigned("width"),
                O::unsigned("height"),
                O::string("scale"),
            ],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "device-mode",
            "Set mobile device metrics.",
            &[
                O::unsigned("width"),
                O::unsigned("height"),
                O::string("scale"),
            ],
            NONE,
            Some(0),
            Mutating,
        ),
        browser_action(
            "console",
            "Collect bounded browser console events.",
            &[O::unsigned("ms")],
            NONE,
            Some(0),
            ReadOnly,
        ),
        browser_action(
            "network",
            "Collect bounded browser network events.",
            &[O::unsigned("ms")],
            NONE,
            Some(0),
            ReadOnly,
        ),
    ]
}

fn browser_action(
    action: &'static str,
    description: &'static str,
    extra: &[OptionSpec],
    switches: &'static [&'static str],
    positional_max: Option<usize>,
    risk: RiskLevel,
) -> CommandContract {
    let mut options = vec![
        OptionSpec::repeated("grant"),
        OptionSpec::repeated("workspace-root"),
    ];
    options.extend_from_slice(extra);
    CommandContract {
        domain: "browser",
        action,
        description,
        selectors: WORKSPACE_PAGE_TAB,
        options,
        switches,
        positional_max,
        positional_satisfies: None,
        requires_expected_revision: false,
        risk,
    }
}

fn computer_action(
    action: &'static str,
    description: &'static str,
    extra: &[OptionSpec],
) -> CommandContract {
    let mut options = vec![
        OptionSpec::required_uuid("snapshot-id"),
        OptionSpec::required_unsigned("window-generation"),
        OptionSpec::unsigned("element-index"),
        OptionSpec::integer("x"),
        OptionSpec::integer("y"),
        OptionSpec::uuid("approval-id"),
    ];
    options.extend_from_slice(extra);
    CommandContract {
        domain: "computer",
        action,
        description,
        selectors: APP_WINDOW,
        options,
        switches: &["confirm"],
        positional_max: Some(0),
        positional_satisfies: None,
        requires_expected_revision: false,
        risk: RiskLevel::HighRisk,
    }
}

pub fn find_contract(domain: &str, action: &str) -> Option<CommandContract> {
    command_contracts()
        .into_iter()
        .find(|contract| contract.domain == domain && contract.action == action)
}

pub fn validate_invocation(
    command: &Command,
    expected_revision: Option<u64>,
) -> Result<(), CliError> {
    let Some((domain, action, selectors, arguments)) = command_parts(command) else {
        return Ok(());
    };
    let contract = find_contract(domain, action)
        .ok_or_else(|| CliError::invalid(format!("no command contract for {domain} {action}")))?;
    validate_against_contract(contract, selectors, arguments, expected_revision)
}

fn command_parts(
    command: &Command,
) -> Option<(
    &'static str,
    &'static str,
    &SelectorSet,
    &OperationArguments,
)> {
    macro_rules! parts {
        ($domain:literal, $command:expr) => {{
            let command = $command;
            Some((
                $domain,
                command.action.as_str(),
                &command.selectors,
                &command.arguments,
            ))
        }};
    }
    match command {
        Command::Workspace(command) => parts!("workspace", command),
        Command::Terminal(command) => parts!("terminal", command),
        Command::Orchestration(command) => parts!("orchestration", command),
        Command::Automation(command) => parts!("automation", command),
        Command::Browser(command) => parts!("browser", command),
        Command::Computer(command) => parts!("computer", command),
        Command::Skill(command) => parts!("skill", command),
        Command::Remote(command) => parts!("remote", command),
        Command::Status | Command::Mcp(_) => None,
    }
}

fn validate_against_contract(
    contract: CommandContract,
    selectors: &SelectorSet,
    arguments: &OperationArguments,
    expected_revision: Option<u64>,
) -> Result<(), CliError> {
    let supplied_selectors = supplied_selectors(selectors);
    for selector in &supplied_selectors {
        if !contract.selectors.contains(selector) {
            return Err(CliError::invalid(format!(
                "--{selector} is not valid for {} {}",
                contract.domain, contract.action
            )));
        }
    }

    for (name, values) in &arguments.options {
        let spec = contract
            .options
            .iter()
            .find(|spec| spec.name == name)
            .ok_or_else(|| {
                CliError::invalid(format!(
                    "--{name} is not valid for {} {}",
                    contract.domain, contract.action
                ))
            })?;
        if !spec.repeatable && values.len() > 1 {
            return Err(CliError::invalid(format!(
                "--{name} may be supplied only once"
            )));
        }
        for value in values {
            validate_value(spec.kind, name, value)?;
        }
    }

    for switch in &arguments.switches {
        if !contract.switches.contains(&switch.as_str()) {
            return Err(CliError::invalid(format!(
                "--{switch} is not valid for {} {}",
                contract.domain, contract.action
            )));
        }
    }

    for spec in contract.options.iter().filter(|spec| spec.required) {
        let positional_supplies =
            contract.positional_satisfies == Some(spec.name) && !arguments.positionals.is_empty();
        if !arguments.options.contains_key(spec.name) && !positional_supplies {
            return Err(CliError::invalid(format!(
                "--{} is required for {} {}",
                spec.name, contract.domain, contract.action
            )));
        }
    }
    if let Some(max) = contract.positional_max {
        if arguments.positionals.len() > max {
            return Err(CliError::invalid(format!(
                "{} {} accepts at most {max} positional argument(s)",
                contract.domain, contract.action
            )));
        }
    }
    if contract.positional_satisfies.is_some()
        && arguments.positionals.is_empty()
        && contract
            .positional_satisfies
            .is_some_and(|name| !arguments.options.contains_key(name))
    {
        return Err(CliError::invalid(format!(
            "{} id is required for {} {}",
            contract.positional_satisfies.unwrap_or("resource"),
            contract.domain,
            contract.action
        )));
    }
    if let Some(pos_name) = contract.positional_satisfies {
        if !arguments.positionals.is_empty() && arguments.options.contains_key(pos_name) {
            return Err(CliError::invalid(format!(
                "cannot specify both positional {pos_name} and --{pos_name}"
            )));
        }
    }
    if contract.requires_expected_revision && expected_revision.is_none() {
        return Err(CliError::invalid(format!(
            "--expected-revision is required for {} {}",
            contract.domain, contract.action
        )));
    }
    for (left, right) in [("enable", "disable"), ("enable-lan", "disable-lan")] {
        if arguments.switches.contains(left) && arguments.switches.contains(right) {
            return Err(CliError::invalid(format!(
                "--{left} and --{right} are mutually exclusive"
            )));
        }
    }
    Ok(())
}

fn validate_value(kind: ValueKind, name: &str, value: &str) -> Result<(), CliError> {
    let valid = match kind {
        ValueKind::String => true,
        ValueKind::Integer => value.parse::<i64>().is_ok(),
        ValueKind::UnsignedInteger => value.parse::<u64>().is_ok(),
        ValueKind::Uuid => uuid::Uuid::parse_str(value).is_ok(),
    };
    if valid {
        Ok(())
    } else {
        Err(CliError::invalid(format!(
            "--{name} has an invalid {} value",
            match kind {
                ValueKind::String => "string",
                ValueKind::Integer => "integer",
                ValueKind::UnsignedInteger => "unsigned integer",
                ValueKind::Uuid => "UUID",
            }
        )))
    }
}

fn supplied_selectors(selectors: &SelectorSet) -> BTreeSet<&'static str> {
    let mut supplied = BTreeSet::new();
    if selectors.workspace.is_some() {
        supplied.insert("workspace");
    }
    if selectors.pane.is_some() {
        supplied.insert("pane");
    }
    if selectors.agent.is_some() {
        supplied.insert("agent");
    }
    if selectors.page.is_some() {
        supplied.insert("page");
    }
    if selectors.tab.is_some() {
        supplied.insert("tab");
    }
    if selectors.app.is_some() {
        supplied.insert("app");
    }
    if selectors.window.is_some() {
        supplied.insert("window");
    }
    supplied
}

pub fn contract_for_command(command: &Command) -> Option<CommandContract> {
    let (domain, action, _, _) = command_parts(command)?;
    find_contract(domain, action)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedicated_cli::parse_args;
    use uuid::Uuid;

    #[test]
    fn contracts_cover_all_non_browser_actions() {
        for args in [
            vec!["workspace", "list"],
            vec!["terminal", "send", "--text", "hello"],
            vec!["orchestration", "task-list", "--run-id", "run"],
            vec!["automation", "list"],
            vec!["computer", "list-apps"],
            vec!["skill", "list"],
            vec!["remote", "status"],
        ] {
            parse_args(args).expect("contract parses representative command");
        }
    }

    #[test]
    fn required_and_typed_options_fail_before_ipc() {
        assert!(parse_args(["workspace", "create"]).is_err());
        assert!(parse_args(["computer", "list-windows", "--process-id", "abc"]).is_err());
        assert!(parse_args(["remote", "status", "--token", "secret"]).is_err());
    }

    #[test]
    fn terminal_complete_round_trips_through_the_daemon_wire_format() {
        // The agent-completion hooks call this command, so a serialization gap
        // here silently breaks every hook while the CLI still reports success.
        let invocation = parse_args([
            "terminal",
            "complete",
            "--workspace",
            "ws-1",
            "--pane",
            "pane-1",
            "--agent-id",
            "omp",
        ])
        .expect("terminal complete must parse");

        let json = serde_json::to_string(&invocation.command).expect("serialize");
        let decoded: crate::dedicated_cli::Command =
            serde_json::from_str(&json).expect("daemon must decode the same bytes");
        assert_eq!(decoded, invocation.command);
    }

    #[test]
    fn revision_fenced_commands_require_expected_revision() {
        let error = parse_args([
            "orchestration",
            "task-create",
            "--run-id",
            "run",
            "--title",
            "task",
        ])
        .expect_err("revision required");
        assert!(error.message.contains("--expected-revision"));
    }
    #[test]
    fn positional_and_option_id_conflicts_fail_contract_validation() {
        let uuid_str = Uuid::new_v4().to_string();
        let error = parse_args(["automation", "cancel", &uuid_str, "--id", &uuid_str])
            .expect_err("positional and --id conflict");
        assert!(error
            .message
            .contains("cannot specify both positional id and --id"));
    }
}

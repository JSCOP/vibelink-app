use super::{client::Flavor, error::CliError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const COMMAND_SCHEMA_VERSION: u16 = 1;
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;
/// A `browser wait` blocks in the daemon for up to its `--ms`; these mirror the
/// bounds `browser_page` enforces so the outer request deadline always outlives
/// the condition it is waiting on.
pub const BROWSER_WAIT_DEFAULT_MS: u64 = 10_000;
pub const BROWSER_WAIT_MAX_MS: u64 = 60_000;
pub const BROWSER_WAIT_TIMEOUT_MARGIN_MS: u64 = 5_000;

macro_rules! action_enum {
    ($name:ident { $($variant:ident => $token:literal),+ $(,)? }) => {
        #[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
        #[serde(rename_all = "kebab-case")]
        pub enum $name { $($variant),+ }

        impl $name {
            pub(crate) fn parse(token: &str) -> Option<Self> {
                match token {
                    $($token => Some(Self::$variant),)+
                    _ => None,
                }
            }

            /// Every token this domain accepts. An agent that guesses a wrong
            /// action gets the list back instead of having to read this source
            /// or brute-force names one process at a time.
            pub(crate) const ALL: &'static [&'static str] = &[$($token),+];

            pub fn as_str(self) -> &'static str {
                match self { $(Self::$variant => $token,)+ }
            }
        }
    };
}

action_enum!(WorkspaceAction {
    List => "list",
    Create => "create",
    Show => "show",
    Open => "open",
    Sleep => "sleep",
    Wake => "wake",
    Delete => "delete",
});

action_enum!(WorktreeAction {
    List => "list",
    Show => "show",
    Current => "current",
    Create => "create",
    Import => "import",
    Move => "move",
    PreflightRemove => "preflight-remove",
    Remove => "remove",
    Set => "set",
    Checkpoint => "checkpoint",
    Comment => "comment",
});

action_enum!(TerminalAction {
    List => "list",
    Show => "show",
    Read => "read",
    Send => "send",
    Wait => "wait",
    Create => "create",
    Split => "split",
    Close => "close",
    // Reported by the agent-completion hook scripts, which run as an ordinary
    // child of the pane and identify themselves through VIBELINK_PANE_ID.
    Complete => "complete",
});

action_enum!(OrchestrationAction {
    Send => "send",
    Check => "check",
    Reply => "reply",
    Inbox => "inbox",
    TaskCreate => "task-create",
    TaskList => "task-list",
    TaskUpdate => "task-update",
    Dispatch => "dispatch",
    DispatchShow => "dispatch-show",
    Ask => "ask",
    Run => "run",
    RunStop => "run-stop",
    GateCreate => "gate-create",
    GateResolve => "gate-resolve",
    GateList => "gate-list",
    Reset => "reset",
});

action_enum!(AutomationAction {
    List => "list",
    Create => "create",
    Update => "update",
    Delete => "delete",
    Run => "run",
    Runs => "runs",
    Precheck => "precheck",
    SchedulePreview => "schedule-preview",
    Cancel => "cancel",
    ImportPreview => "import-preview",
    Import => "import",
    DraftPreview => "draft-preview",
    DraftCancel => "draft-cancel",
});

action_enum!(BrowserAction {
    NewTab => "new-tab",
    Navigate => "navigate",
    Snapshot => "snapshot",
    Screenshot => "screenshot",
    FullScreenshot => "full-screenshot",
    Pdf => "pdf",
    Back => "back",
    Forward => "forward",
    Reload => "reload",
    Wait => "wait",
    Click => "click",
    DoubleClick => "double-click",
    Fill => "fill",
    Type => "type",
    Select => "select",
    Check => "check",
    Focus => "focus",
    Clear => "clear",
    SelectAll => "select-all",
    Keypress => "keypress",
    Hover => "hover",
    Drag => "drag",
    Upload => "upload",
    Scroll => "scroll",
    ScrollIntoView => "scroll-into-view",
    Find => "find",
    Get => "get",
    Is => "is",
    Mouse => "mouse",
    Highlight => "highlight",
    Download => "download",
    Tabs => "tabs",
    Profiles => "profiles",
    Chrome => "chrome",
    Cookies => "cookies",
    Storage => "storage",
    Viewport => "viewport",
    DeviceMode => "device-mode",
    Console => "console",
    Network => "network",
});

action_enum!(ComputerAction {
    Capabilities => "capabilities",
    ListApps => "list-apps",
    ListWindows => "list-windows",
    GetAppState => "get-app-state",
    ApprovalCreate => "approval-create",
    ApprovalResolve => "approval-resolve",
    ApprovalList => "approval-list",
    ActionHistory => "action-history",
    Click => "click",
    PerformSecondaryAction => "perform-secondary-action",
    Scroll => "scroll",
    Drag => "drag",
    TypeText => "type-text",
    PressKey => "press-key",
    Hotkey => "hotkey",
    PasteText => "paste-text",
    SetValue => "set-value",
});

action_enum!(SkillAction {
    List => "list",
    Show => "show",
    Apply => "apply",
    Delete => "delete",
    Doctor => "doctor",
});

action_enum!(MemoryAction {
    List => "list",
    Search => "search",
    Add => "add",
    Remove => "remove",
});

action_enum!(RemoteAction {
    Status => "status",
    Configure => "configure",
    Pair => "pair",
    Devices => "devices",
    Revoke => "revoke",
});

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum McpAction {
    Serve,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectorSet {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tab: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub window: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationArguments {
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub options: BTreeMap<String, Vec<String>>,
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub switches: BTreeSet<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub positionals: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionCommand<A> {
    pub action: A,
    #[serde(default, skip_serializing_if = "selectors_are_empty")]
    pub selectors: SelectorSet,
    #[serde(default, skip_serializing_if = "arguments_are_empty")]
    pub arguments: OperationArguments,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "domain", content = "request", rename_all = "lowercase")]
pub enum Command {
    Status,
    Workspace(ActionCommand<WorkspaceAction>),
    Worktree(ActionCommand<WorktreeAction>),
    Terminal(ActionCommand<TerminalAction>),
    Orchestration(ActionCommand<OrchestrationAction>),
    Automation(ActionCommand<AutomationAction>),
    Browser(ActionCommand<BrowserAction>),
    Computer(ActionCommand<ComputerAction>),
    Skill(ActionCommand<SkillAction>),
    Memory(ActionCommand<MemoryAction>),
    Remote(ActionCommand<RemoteAction>),
    Mcp(McpAction),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Invocation {
    pub json: bool,
    pub flavor: Option<Flavor>,
    pub timeout_ms: u64,
    pub operation_id: Uuid,
    pub expected_revision: Option<u64>,
    pub command: Command,
}

/// Top-level command domains this parser accepts.
///
/// The GUI binary consults this to REFUSE a CLI invocation instead of falling
/// through to a normal desktop launch. A generated agent-completion hook that
/// still points at the desktop executable would otherwise start an extra full
/// instance on every agent turn; each one attaches to the same daemon session
/// and refits the shared panes to its own window geometry, which makes the live
/// terminal grid oscillate between two column counts.
pub const COMMAND_DOMAINS: &[&str] = &[
    "status",
    "workspace",
    "terminal",
    "orchestration",
    "automation",
    "browser",
    "computer",
    "skill",
    "memory",
    "remote",
    "mcp",
];

/// Whether `argument` names a CLI command domain rather than a launch argument.
pub fn is_command_domain(argument: &str) -> bool {
    COMMAND_DOMAINS.contains(&argument)
}

pub fn parse_args(
    args: impl IntoIterator<Item = impl Into<String>>,
) -> Result<Invocation, CliError> {
    let raw = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let (tokens, mut globals) = extract_globals(raw)?;
    let domain = tokens
        .first()
        .ok_or_else(|| CliError::invalid(format!("missing command\n{}", usage())))?;

    let command = match domain.as_str() {
        "status" => {
            if tokens.len() != 1 {
                return Err(CliError::invalid(
                    "status does not accept command arguments",
                ));
            }
            Command::Status
        }
        "workspace" => parse_action_command(
            &tokens,
            "workspace",
            WorkspaceAction::ALL,
            WorkspaceAction::parse,
        )
        .map(Command::Workspace)?,
        "worktree" => parse_action_command(
            &tokens,
            "worktree",
            WorktreeAction::ALL,
            WorktreeAction::parse,
        )
        .map(Command::Worktree)?,
        "terminal" => parse_action_command(
            &tokens,
            "terminal",
            TerminalAction::ALL,
            TerminalAction::parse,
        )
        .map(Command::Terminal)?,
        "orchestration" => parse_action_command(
            &tokens,
            "orchestration",
            OrchestrationAction::ALL,
            OrchestrationAction::parse,
        )
        .map(Command::Orchestration)?,
        "automation" => parse_action_command(
            &tokens,
            "automation",
            AutomationAction::ALL,
            AutomationAction::parse,
        )
        .map(Command::Automation)?,
        "browser" => parse_action_command(
            &tokens,
            "browser",
            BrowserAction::ALL,
            BrowserAction::parse,
        )
        .map(Command::Browser)?,
        "computer" => parse_action_command(
            &tokens,
            "computer",
            ComputerAction::ALL,
            ComputerAction::parse,
        )
        .map(Command::Computer)?,
        "skill" => parse_action_command(&tokens, "skill", SkillAction::ALL, SkillAction::parse)
            .map(Command::Skill)?,
        "memory" => parse_action_command(&tokens, "memory", MemoryAction::ALL, MemoryAction::parse)
            .map(Command::Memory)?,
        "remote" => parse_action_command(&tokens, "remote", RemoteAction::ALL, RemoteAction::parse)
            .map(Command::Remote)?,
        "mcp" => {
            if tokens.get(1).map(String::as_str) != Some("serve") || tokens.len() != 2 {
                return Err(CliError::invalid("usage: vibelink mcp serve"));
            }
            Command::Mcp(McpAction::Serve)
        }
        other => {
            return Err(CliError::invalid(format!(
                "unknown command domain '{other}'\n{}",
                usage()
            )))
        }
    };

    super::contract::validate_invocation(&command, globals.expected_revision)?;
    // A conditional `browser wait` blocks for its own `--ms`, which the 10 s
    // default request timeout would cut short long before the condition can
    // settle or legitimately time out. Derive the outer deadline from `--ms`
    // unless the caller pinned one explicitly.
    if !globals.timeout_explicit {
        if let Command::Browser(browser) = &command {
            if browser.action == BrowserAction::Wait {
                let wait_ms = browser
                    .arguments
                    .options
                    .get("ms")
                    .and_then(|values| values.last())
                    .and_then(|value| value.parse::<u64>().ok())
                    .unwrap_or(BROWSER_WAIT_DEFAULT_MS)
                    .min(BROWSER_WAIT_MAX_MS);
                globals.timeout_ms = wait_ms + BROWSER_WAIT_TIMEOUT_MARGIN_MS;
            }
        }
    }

    Ok(Invocation {
        json: globals.json,
        flavor: globals.flavor,
        timeout_ms: globals.timeout_ms,
        operation_id: globals.operation_id.unwrap_or_else(Uuid::new_v4),
        expected_revision: globals.expected_revision,
        command,
    })
}

#[derive(Default)]
struct ParsedGlobals {
    json: bool,
    flavor: Option<Flavor>,
    timeout_ms: u64,
    timeout_explicit: bool,
    operation_id: Option<Uuid>,
    expected_revision: Option<u64>,
}

fn extract_globals(raw: Vec<String>) -> Result<(Vec<String>, ParsedGlobals), CliError> {
    let mut globals = ParsedGlobals {
        timeout_ms: DEFAULT_TIMEOUT_MS,
        ..ParsedGlobals::default()
    };
    let automation_json_action_index = raw
        .windows(2)
        .position(|pair| {
            pair[0] == "automation"
                && matches!(
                    pair[1].as_str(),
                    "create" | "update" | "schedule-preview" | "import" | "draft-preview"
                )
        })
        .map(|domain_index| domain_index + 1);
    let mut tokens = Vec::with_capacity(raw.len());
    let mut index = 0;
    while index < raw.len() {
        let token = &raw[index];
        if token == "--" {
            tokens.extend_from_slice(&raw[index..]);
            break;
        }
        let (name, inline_value) = split_flag(token);
        match name {
            "--json"
                if automation_json_action_index
                    .is_some_and(|action_index| index > action_index) =>
            {
                tokens.push(token.clone());
            }
            "--json" => {
                if inline_value.is_some() {
                    return Err(CliError::invalid("global --json does not take a value"));
                }
                if globals.json {
                    return Err(CliError::invalid("global --json may be supplied only once"));
                }
                globals.json = true;
            }
            "--flavor" => {
                ensure_unset(globals.flavor.is_none(), "--flavor")?;
                let value = flag_value(&raw, &mut index, inline_value, "--flavor")?;
                globals.flavor = Some(Flavor::parse(&value)?);
            }
            "--request-timeout-seconds" => {
                ensure_unset(!globals.timeout_explicit, "--request-timeout-seconds")?;
                globals.timeout_explicit = true;
                let value =
                    flag_value(&raw, &mut index, inline_value, "--request-timeout-seconds")?;
                let seconds = value.parse::<u64>().map_err(|_| {
                    CliError::invalid("--request-timeout-seconds must be an integer")
                })?;
                // 900 rather than 600 so a caller can always outlast a backend
                // command that itself times out at 600 s: the client must observe
                // the real result, not give up during process-tree cleanup and
                // response serialization.
                if !(1..=900).contains(&seconds) {
                    return Err(CliError::invalid(
                        "--request-timeout-seconds must be between 1 and 900",
                    ));
                }
                globals.timeout_ms = seconds * 1_000;
            }
            "--operation-id" => {
                ensure_unset(globals.operation_id.is_none(), "--operation-id")?;
                let value = flag_value(&raw, &mut index, inline_value, "--operation-id")?;
                globals.operation_id = Some(
                    Uuid::parse_str(&value)
                        .map_err(|_| CliError::invalid("--operation-id must be a UUID"))?,
                );
            }
            "--expected-revision" => {
                ensure_unset(globals.expected_revision.is_none(), "--expected-revision")?;
                let value = flag_value(&raw, &mut index, inline_value, "--expected-revision")?;
                globals.expected_revision = Some(value.parse::<u64>().map_err(|_| {
                    CliError::invalid("--expected-revision must be an unsigned integer")
                })?);
            }
            _ => tokens.push(token.clone()),
        }
        index += 1;
    }
    Ok((tokens, globals))
}

/// `known` is the domain's full action list, echoed on every action error so a
/// caller discovers the surface from the error itself. `vibelink browser` with
/// no action is the intended way to ask "what can this do?".
fn parse_action_command<A>(
    tokens: &[String],
    domain: &str,
    known: &[&str],
    parse_action: impl Fn(&str) -> Option<A>,
) -> Result<ActionCommand<A>, CliError> {
    let actions = || format!("\n{domain} actions: {}", known.join(", "));
    let action_token = tokens
        .get(1)
        .ok_or_else(|| CliError::invalid(format!("missing {domain} action{}", actions())))?;
    let action = parse_action(action_token).ok_or_else(|| {
        CliError::invalid(format!(
            "unknown {domain} action '{action_token}'{}",
            actions()
        ))
    })?;
    let (mut selectors, mut arguments) = parse_operation_arguments(&tokens[2..])?;
    // `--agent` is normally a selector, but memory add stores it as origin metadata.
    if domain == "memory" {
        if let Some(agent) = selectors.agent.take() {
            arguments.options.insert("agent".to_string(), vec![agent]);
        }
    }
    Ok(ActionCommand {
        action,
        selectors,
        arguments,
    })
}

fn parse_operation_arguments(
    tokens: &[String],
) -> Result<(SelectorSet, OperationArguments), CliError> {
    let mut selectors = SelectorSet::default();
    let mut arguments = OperationArguments::default();
    let mut index = 0;
    while index < tokens.len() {
        let token = &tokens[index];
        if token == "--" {
            arguments
                .positionals
                .extend_from_slice(&tokens[index + 1..]);
            break;
        }
        if !token.starts_with("--") {
            arguments.positionals.push(token.clone());
            index += 1;
            continue;
        }
        let (name, inline_value) = split_flag(token);
        if is_switch(name) {
            if inline_value.is_some() {
                return Err(CliError::invalid(format!("{name} does not take a value")));
            }
            if !arguments.switches.insert(trim_flag(name).to_string()) {
                return Err(CliError::invalid(format!(
                    "{name} may be supplied only once"
                )));
            }
            index += 1;
            continue;
        }
        let value = flag_value(tokens, &mut index, inline_value, name)?;
        match name {
            "--workspace" => set_selector(&mut selectors.workspace, value, name)?,
            "--pane" => set_selector(&mut selectors.pane, value, name)?,
            "--worktree" => set_selector(&mut selectors.worktree, value, name)?,
            "--agent" => set_selector(&mut selectors.agent, value, name)?,
            "--page" => set_selector(&mut selectors.page, value, name)?,
            "--tab" => set_selector(&mut selectors.tab, value, name)?,
            "--app" => set_selector(&mut selectors.app, value, name)?,
            "--window" => set_selector(&mut selectors.window, value, name)?,
            _ => arguments
                .options
                .entry(trim_flag(name).to_string())
                .or_default()
                .push(value),
        }
        index += 1;
    }
    Ok((selectors, arguments))
}

fn split_flag(token: &str) -> (&str, Option<String>) {
    match token.split_once('=') {
        Some((name, value)) if name.starts_with("--") => (name, Some(value.to_string())),
        _ => (token, None),
    }
}

fn flag_value(
    tokens: &[String],
    index: &mut usize,
    inline_value: Option<String>,
    flag: &str,
) -> Result<String, CliError> {
    let value = match inline_value {
        Some(value) => value,
        None => {
            *index += 1;
            tokens
                .get(*index)
                .filter(|value| !value.starts_with("--"))
                .cloned()
                .ok_or_else(|| CliError::invalid(format!("{flag} requires a value")))?
        }
    };
    if value.trim().is_empty() {
        return Err(CliError::invalid(format!("{flag} cannot be empty")));
    }
    Ok(value)
}

fn set_selector(target: &mut Option<String>, value: String, flag: &str) -> Result<(), CliError> {
    ensure_unset(target.is_none(), flag)?;
    *target = Some(value);
    Ok(())
}

fn ensure_unset(unset: bool, flag: &str) -> Result<(), CliError> {
    if unset {
        Ok(())
    } else {
        Err(CliError::invalid(format!(
            "{flag} may be supplied only once"
        )))
    }
}

fn trim_flag(flag: &str) -> &str {
    flag.trim_start_matches("--")
}

fn is_switch(flag: &str) -> bool {
    matches!(
        flag,
        "--enter"
            | "--no-screenshot"
            | "--restore-window"
            | "--incognito"
            | "--full"
            | "--force"
            | "--recursive"
            | "--wait"
            | "--exit"
            | "--all"
            | "--confirm"
            | "--ignore-cache"
            | "--install"
            | "--copy-profile"
            | "--unpair"
            | "--refresh"
            | "--enable"
            | "--disable"
            | "--enable-lan"
            | "--disable-lan"
            | "--include-external"
            | "--include-hidden"
            | "--fetch"
            | "--delete-branch"
            | "--clear-parent"
            | "--clear-comment"
            | "--clear-review-target"
            | "--no-parent"
            | "--pin"
    )
}

fn selectors_are_empty(selectors: &SelectorSet) -> bool {
    selectors == &SelectorSet::default()
}

fn arguments_are_empty(arguments: &OperationArguments) -> bool {
    arguments == &OperationArguments::default()
}

pub fn usage() -> &'static str {
    "usage: vibelink [--json] [--flavor dev|prod] [--request-timeout-seconds N] [--operation-id UUID] [--expected-revision N] <status|workspace|worktree|terminal|orchestration|automation|browser|computer|skill|memory|remote|mcp> ..."
}

#[cfg(test)]
#[path = "command_tests.rs"]
mod tests;

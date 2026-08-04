use super::{client::Flavor, error::CliError};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

pub const COMMAND_SCHEMA_VERSION: u16 = 1;
pub const DEFAULT_TIMEOUT_MS: u64 = 10_000;

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
    let (tokens, globals) = extract_globals(raw)?;
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
        "workspace" => parse_action_command(&tokens, "workspace", WorkspaceAction::parse)
            .map(Command::Workspace)?,
        "worktree" => parse_action_command(&tokens, "worktree", WorktreeAction::parse)
            .map(Command::Worktree)?,
        "terminal" => parse_action_command(&tokens, "terminal", TerminalAction::parse)
            .map(Command::Terminal)?,
        "orchestration" => {
            parse_action_command(&tokens, "orchestration", OrchestrationAction::parse)
                .map(Command::Orchestration)?
        }
        "automation" => parse_action_command(&tokens, "automation", AutomationAction::parse)
            .map(Command::Automation)?,
        "browser" => {
            parse_action_command(&tokens, "browser", BrowserAction::parse).map(Command::Browser)?
        }
        "computer" => parse_action_command(&tokens, "computer", ComputerAction::parse)
            .map(Command::Computer)?,
        "skill" => {
            parse_action_command(&tokens, "skill", SkillAction::parse).map(Command::Skill)?
        }
        "remote" => {
            parse_action_command(&tokens, "remote", RemoteAction::parse).map(Command::Remote)?
        }
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
    let mut timeout_seen = false;
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
                ensure_unset(!timeout_seen, "--request-timeout-seconds")?;
                timeout_seen = true;
                let value =
                    flag_value(&raw, &mut index, inline_value, "--request-timeout-seconds")?;
                let seconds = value.parse::<u64>().map_err(|_| {
                    CliError::invalid("--request-timeout-seconds must be an integer")
                })?;
                if !(1..=600).contains(&seconds) {
                    return Err(CliError::invalid(
                        "--request-timeout-seconds must be between 1 and 600",
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

fn parse_action_command<A>(
    tokens: &[String],
    domain: &str,
    parse_action: impl Fn(&str) -> Option<A>,
) -> Result<ActionCommand<A>, CliError> {
    let action_token = tokens
        .get(1)
        .ok_or_else(|| CliError::invalid(format!("missing {domain} action")))?;
    let action = parse_action(action_token)
        .ok_or_else(|| CliError::invalid(format!("unknown {domain} action '{action_token}'")))?;
    let (selectors, arguments) = parse_operation_arguments(&tokens[2..])?;
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
    )
}

fn selectors_are_empty(selectors: &SelectorSet) -> bool {
    selectors == &SelectorSet::default()
}

fn arguments_are_empty(arguments: &OperationArguments) -> bool {
    arguments == &OperationArguments::default()
}

pub fn usage() -> &'static str {
    "usage: vibelink [--json] [--flavor dev|prod] [--request-timeout-seconds N] [--operation-id UUID] [--expected-revision N] <status|workspace|worktree|terminal|orchestration|automation|browser|computer|skill|remote|mcp> ..."
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_stable_command_family() {
        let cases = [
            (vec!["status"], "status"),
            (vec!["workspace", "list"], "workspace"),
            (vec!["terminal", "read", "--pane", "p1"], "terminal"),
            (
                vec!["orchestration", "task-list", "--run-id", "run-1"],
                "orchestration",
            ),
            (vec!["automation", "list"], "automation"),
            (vec!["browser", "snapshot", "--page", "page-1"], "browser"),
            (
                vec!["computer", "get-app-state", "--app", "Notepad"],
                "computer",
            ),
            (vec!["skill", "doctor"], "skill"),
            (vec!["remote", "devices"], "remote"),
            (vec!["mcp", "serve"], "mcp"),
            (vec!["worktree", "current"], "worktree"),
        ];
        for (args, expected_domain) in cases {
            let invocation = parse_args(args).expect("parse command family");
            let value = serde_json::to_value(invocation.command).expect("serialize command");
            assert_eq!(value["domain"], expected_domain);
        }
    }

    #[test]
    fn parses_every_published_action() {
        let command_tree: &[(&str, &[&str])] = &[
            (
                "workspace",
                &["list", "create", "show", "open", "sleep", "wake", "delete"],
            ),
            (
                "worktree",
                &[
                    "list",
                    "show",
                    "current",
                    "create",
                    "import",
                    "move",
                    "preflight-remove",
                    "remove",
                    "set",
                    "checkpoint",
                    "comment",
                ],
            ),
            (
                "terminal",
                &[
                    "list", "show", "read", "send", "wait", "create", "split", "close",
                ],
            ),
            (
                "orchestration",
                &[
                    "send",
                    "check",
                    "reply",
                    "inbox",
                    "task-create",
                    "task-list",
                    "task-update",
                    "dispatch",
                    "dispatch-show",
                    "ask",
                    "run",
                    "run-stop",
                    "gate-create",
                    "gate-resolve",
                    "gate-list",
                    "reset",
                ],
            ),
            (
                "automation",
                &[
                    "list",
                    "create",
                    "update",
                    "delete",
                    "run",
                    "runs",
                    "precheck",
                    "schedule-preview",
                    "cancel",
                    "import-preview",
                    "import",
                    "draft-preview",
                    "draft-cancel",
                ],
            ),
            (
                "browser",
                &[
                    "navigate",
                    "snapshot",
                    "screenshot",
                    "full-screenshot",
                    "pdf",
                    "back",
                    "forward",
                    "reload",
                    "wait",
                    "click",
                    "double-click",
                    "fill",
                    "type",
                    "select",
                    "check",
                    "focus",
                    "clear",
                    "select-all",
                    "keypress",
                    "hover",
                    "drag",
                    "upload",
                    "scroll",
                    "scroll-into-view",
                    "find",
                    "get",
                    "is",
                    "mouse",
                    "highlight",
                    "download",
                    "tabs",
                    "profiles",
                    "cookies",
                    "storage",
                    "viewport",
                    "device-mode",
                    "console",
                    "network",
                ],
            ),
            (
                "computer",
                &[
                    "capabilities",
                    "list-apps",
                    "list-windows",
                    "get-app-state",
                    "approval-create",
                    "approval-resolve",
                    "approval-list",
                    "action-history",
                    "click",
                    "perform-secondary-action",
                    "scroll",
                    "drag",
                    "type-text",
                    "press-key",
                    "hotkey",
                    "paste-text",
                    "set-value",
                ],
            ),
            ("skill", &["list", "show", "apply", "delete", "doctor"]),
            ("remote", &["status", "pair", "devices", "revoke"]),
        ];
        for (domain, actions) in command_tree {
            for action in *actions {
                let mut args = vec![(*domain).to_string(), (*action).to_string()];
                if let Some(contract) = crate::dedicated_cli::find_contract(domain, action) {
                    for option in contract.options.iter().filter(|option| option.required) {
                        args.push(format!("--{}", option.name));
                        args.push(
                            option
                                .enum_values
                                .first()
                                .copied()
                                .map(str::to_string)
                                .unwrap_or_else(|| match option.kind {
                                    crate::dedicated_cli::ValueKind::Uuid => {
                                        Uuid::nil().to_string()
                                    }
                                    crate::dedicated_cli::ValueKind::Integer
                                    | crate::dedicated_cli::ValueKind::UnsignedInteger => {
                                        "1".to_string()
                                    }
                                    crate::dedicated_cli::ValueKind::String => "value".to_string(),
                                }),
                        );
                    }
                    if let Some(id) = contract.positional_satisfies {
                        if !args.iter().any(|value| value == &format!("--{id}")) {
                            args.extend([format!("--{id}"), "value".to_string()]);
                        }
                    }
                    if contract.requires_expected_revision {
                        args.extend(["--expected-revision".to_string(), "1".to_string()]);
                    }
                    if contract.domain == "worktree" && contract.action == "remove" {
                        args.push("--confirm".to_string());
                    }
                }
                parse_args(args)
                    .unwrap_or_else(|error| panic!("{domain} {action} did not parse: {error}"));
            }
        }
    }

    #[test]
    fn parses_global_contract_and_typed_selectors() {
        let operation_id = Uuid::new_v4();
        let invocation = parse_args([
            "terminal",
            "send",
            "--workspace",
            "alpha",
            "--pane=pane-1",
            "--text",
            "hello",
            "--enter",
            "--json",
            "--operation-id",
            &operation_id.to_string(),
            "--expected-revision=7",
            "--request-timeout-seconds",
            "15",
            "--flavor",
            "prod",
        ])
        .expect("parse invocation");
        assert!(invocation.json);
        assert_eq!(invocation.flavor, Some(Flavor::Prod));
        assert_eq!(invocation.timeout_ms, 15_000);
        let Command::Terminal(command) = invocation.command else {
            panic!("expected terminal command")
        };
        assert_eq!(command.action, TerminalAction::Send);
        assert_eq!(command.selectors.workspace.as_deref(), Some("alpha"));
        assert_eq!(command.selectors.pane.as_deref(), Some("pane-1"));
        assert_eq!(command.arguments.options["text"], ["hello"]);
        assert!(command.arguments.switches.contains("enter"));
    }
    #[test]
    fn automation_payload_json_does_not_consume_global_json_output() {
        let payload = r#"{"requestId":"33e7e588-9842-44c1-94e7-c77819718d11","request":"test"}"#;
        let invocation = parse_args([
            "--json",
            "automation",
            "draft-preview",
            "--workspace",
            "workspace-1",
            "--json",
            payload,
            "--request-timeout-seconds",
            "15",
        ])
        .expect("parse automation draft JSON payload");
        assert!(invocation.json);
        assert_eq!(invocation.timeout_ms, 15_000);
        let Command::Automation(command) = invocation.command else {
            panic!("expected automation command")
        };
        assert_eq!(command.action, AutomationAction::DraftPreview);
        assert_eq!(command.arguments.options["json"], [payload]);
    }

    #[test]
    fn automation_schedule_preview_keeps_json_payload() {
        let payload = r#"{"scheduleKind":"daily","scheduleValue":"09:00","timezone":"UTC"}"#;
        let invocation = parse_args(["automation", "schedule-preview", "--json", payload])
            .expect("parse automation schedule preview JSON payload");
        let Command::Automation(command) = invocation.command else {
            panic!("expected automation command")
        };
        assert_eq!(command.action, AutomationAction::SchedulePreview);
        assert_eq!(command.arguments.options["json"], [payload]);
    }
    #[test]
    fn automation_v4_actions_parse_and_require_json_or_id() {
        let run_id = Uuid::new_v4().to_string();
        let cancel_inv =
            parse_args(["automation", "cancel", &run_id]).expect("parse cancel positional");
        let Command::Automation(cancel_cmd) = cancel_inv.command else {
            panic!("expected automation")
        };
        assert_eq!(cancel_cmd.action, AutomationAction::Cancel);
        assert_eq!(
            cancel_cmd.arguments.positionals.as_slice(),
            std::slice::from_ref(&run_id)
        );

        let cancel_opt_inv =
            parse_args(["automation", "cancel", "--id", &run_id]).expect("parse cancel --id");
        let Command::Automation(cancel_opt_cmd) = cancel_opt_inv.command else {
            panic!("expected automation")
        };
        assert_eq!(cancel_opt_cmd.action, AutomationAction::Cancel);
        assert_eq!(cancel_opt_cmd.arguments.options["id"], [run_id]);

        let import_preview_inv =
            parse_args(["automation", "import-preview", "--workspace", "ws-1"])
                .expect("parse import-preview");
        let Command::Automation(import_preview_cmd) = import_preview_inv.command else {
            panic!("expected automation")
        };
        assert_eq!(import_preview_cmd.action, AutomationAction::ImportPreview);
        assert_eq!(
            import_preview_cmd.selectors.workspace.as_deref(),
            Some("ws-1")
        );

        let import_payload = r#"{"jobs":[]}"#;
        let import_inv = parse_args([
            "automation",
            "import",
            "--workspace",
            "ws-1",
            "--json",
            import_payload,
        ])
        .expect("parse import");
        let Command::Automation(import_cmd) = import_inv.command else {
            panic!("expected automation")
        };
        assert_eq!(import_cmd.action, AutomationAction::Import);
        assert_eq!(import_cmd.arguments.options["json"], [import_payload]);

        let draft_payload =
            r#"{"requestId":"33e7e588-9842-44c1-94e7-c77819718d11","request":"test"}"#;
        let draft_inv = parse_args([
            "automation",
            "draft-preview",
            "--workspace",
            "ws-1",
            "--json",
            draft_payload,
        ])
        .expect("parse draft-preview");
        let Command::Automation(draft_cmd) = draft_inv.command else {
            panic!("expected automation")
        };
        assert_eq!(draft_cmd.action, AutomationAction::DraftPreview);
        assert_eq!(draft_cmd.arguments.options["json"], [draft_payload]);

        let draft_request_id = Uuid::new_v4().to_string();
        let draft_cancel_inv =
            parse_args(["automation", "draft-cancel", "--id", &draft_request_id])
                .expect("parse draft-cancel");
        let Command::Automation(draft_cancel_cmd) = draft_cancel_inv.command else {
            panic!("expected automation")
        };
        assert_eq!(draft_cancel_cmd.action, AutomationAction::DraftCancel);
        assert_eq!(draft_cancel_cmd.arguments.options["id"], [draft_request_id]);

        assert!(parse_args(["automation", "create", "--workspace", "ws-1"]).is_err());
        assert!(parse_args(["automation", "update", "--id", &Uuid::new_v4().to_string()]).is_err());
        assert!(parse_args(["automation", "import", "--workspace", "ws-1"]).is_err());
        assert!(parse_args(["automation", "draft-preview", "--workspace", "ws-1"]).is_err());
        assert!(parse_args(["automation", "draft-cancel"]).is_err());
        assert!(parse_args(["automation", "draft-cancel", "--id", "not-a-uuid"]).is_err());
    }

    #[test]
    fn automation_rejects_legacy_goal_and_command_flags() {
        assert!(parse_args([
            "automation",
            "create",
            "--workspace",
            "ws-1",
            "--goal",
            "do task"
        ])
        .is_err());
        assert!(parse_args([
            "automation",
            "create",
            "--workspace",
            "ws-1",
            "--command",
            "run"
        ])
        .is_err());
    }

    #[test]
    fn rejects_unknown_actions_and_duplicate_selectors() {
        assert!(parse_args(["workspace", "guess"]).is_err());
        let error = parse_args(["terminal", "read", "--pane", "one", "--pane", "two"])
            .expect_err("duplicate selector");
        assert_eq!(
            error.code,
            crate::dedicated_cli::ErrorCode::InvalidArguments
        );
    }

    #[test]
    fn worktree_grammar_uses_exact_instance_and_parent_flags() {
        let instance_id = Uuid::new_v4().to_string();
        let operation = parse_args([
            "worktree",
            "remove",
            "--worktree",
            "worktree-1",
            "--expected-instance-id",
            instance_id.as_str(),
            "--acknowledge-blocker",
            "dirty",
            "--confirm",
        ])
        .expect("parse exact removal grammar");
        let Command::Worktree(command) = operation.command else {
            panic!("expected worktree command")
        };
        assert_eq!(
            command.arguments.options["expected-instance-id"],
            [instance_id.as_str()]
        );
        assert!(parse_args([
            "worktree",
            "remove",
            "--worktree",
            "worktree-1",
            "--instance",
            instance_id.as_str(),
            "--confirm",
        ])
        .is_err());
        assert!(parse_args([
            "worktree",
            "create",
            "--repo",
            ".",
            "--name",
            "child",
            "--parent-worktree",
            "parent",
            "--no-parent",
        ])
        .is_err());
    }

    #[test]
    fn action_serialization_is_stable_kebab_case() {
        let invocation = parse_args([
            "orchestration",
            "gate-resolve",
            "--gate-id",
            "gate-1",
            "--resolution",
            "approve",
            "--expected-revision",
            "1",
        ])
        .expect("parse gate resolve");
        let json = serde_json::to_value(invocation.command).expect("serialize command");
        assert_eq!(json["request"]["action"], "gate-resolve");
    }

    /// `COMMAND_DOMAINS` gates whether the GUI binary refuses an argv, so it
    /// must stay in sync with what the parser actually accepts. A domain the
    /// parser knows but this list omits would let a hook boot a second desktop
    /// instance again; the extra instance then refits the shared panes to its
    /// own window and the live terminal grid visibly shakes.
    #[test]
    fn command_domains_cover_every_domain_the_parser_accepts() {
        for domain in COMMAND_DOMAINS {
            assert!(is_command_domain(domain));
            let error = parse_args([*domain]).err();
            // Each domain must be RECOGNISED: it either parses or fails for a
            // reason other than "unknown command domain".
            if let Some(error) = error {
                assert!(
                    !error.to_string().contains("unknown command domain"),
                    "{domain} is listed but the parser does not know it"
                );
            }
        }

        assert!(parse_args(["definitely-not-a-domain"])
            .expect_err("unknown domain rejected")
            .to_string()
            .contains("unknown command domain"));
    }

    #[test]
    fn ordinary_launch_arguments_are_not_command_domains() {
        for argument in ["", "--daemon", "vibelink://open", "C:/some/path", "--flag"] {
            assert!(!is_command_domain(argument));
        }
    }
}

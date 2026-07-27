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
            "--json" => {
                if inline_value.is_some() {
                    return Err(CliError::invalid("--json does not take a value"));
                }
                if globals.json {
                    return Err(CliError::invalid("--json may be supplied only once"));
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
    )
}

fn selectors_are_empty(selectors: &SelectorSet) -> bool {
    selectors == &SelectorSet::default()
}

fn arguments_are_empty(arguments: &OperationArguments) -> bool {
    arguments == &OperationArguments::default()
}

pub fn usage() -> &'static str {
    "usage: vibelink [--json] [--flavor dev|prod] [--request-timeout-seconds N] [--operation-id UUID] [--expected-revision N] <status|workspace|terminal|orchestration|automation|browser|computer|skill|remote|mcp> ..."
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
                    "list", "create", "update", "delete", "run", "runs", "precheck",
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
                        args.push(match option.kind {
                            crate::dedicated_cli::ValueKind::Uuid => Uuid::nil().to_string(),
                            crate::dedicated_cli::ValueKind::Integer
                            | crate::dedicated_cli::ValueKind::UnsignedInteger => "1".to_string(),
                            crate::dedicated_cli::ValueKind::String => "value".to_string(),
                        });
                    }
                    if let Some(id) = contract.positional_satisfies {
                        if !args.iter().any(|value| value == &format!("--{id}")) {
                            args.extend([format!("--{id}"), "value".to_string()]);
                        }
                    }
                    if contract.requires_expected_revision {
                        args.extend(["--expected-revision".to_string(), "1".to_string()]);
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
        assert_eq!(invocation.operation_id, operation_id);
        assert_eq!(invocation.expected_revision, Some(7));
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
    fn request_timeout_does_not_consume_automation_timeout() {
        let invocation = parse_args([
            "automation",
            "create",
            "--workspace",
            "workspace-1",
            "--name",
            "nightly",
            "--schedule-kind",
            "daily",
            "--schedule-value",
            "02:00",
            "--command",
            "vibelink status",
            "--timeout-seconds",
            "3600",
            "--request-timeout-seconds",
            "15",
        ])
        .expect("parse automation timeout");
        assert_eq!(invocation.timeout_ms, 15_000);
        let Command::Automation(command) = invocation.command else {
            panic!("expected automation command")
        };
        assert_eq!(command.arguments.options["timeout-seconds"], ["3600"]);
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
}

use super::{
    client::{ControlSocketClient, ControlSocketConfig, Flavor},
    command::{
        parse_args, ActionCommand, Command, Invocation, OrchestrationAction, TerminalAction,
        WorktreeAction, COMMAND_SCHEMA_VERSION,
    },
    contract::{contract_for_command, RiskLevel},
    error::CliError,
    output::OutputStreams,
};
use crate::daemon::paths;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    env,
    io::Write,
    thread,
    time::{Duration, Instant},
};

pub trait ControlExecutor {
    fn execute(&mut self, invocation: Invocation) -> Result<Value, CliError>;

    fn execute_with_progress(
        &mut self,
        invocation: Invocation,
        progress: &mut dyn FnMut(&str) -> Result<(), CliError>,
    ) -> Result<Value, CliError> {
        let _ = progress;
        self.execute(invocation)
    }
}

pub trait McpRunner {
    fn serve(&mut self) -> Result<(), CliError>;
}

impl<F> McpRunner for F
where
    F: FnMut() -> Result<(), CliError>,
{
    fn serve(&mut self) -> Result<(), CliError> {
        self()
    }
}

#[derive(Default)]
pub struct SocketExecutor;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliControlRequest {
    pub schema_version: u16,
    pub operation_id: uuid::Uuid,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_revision: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller_cwd: Option<String>,
    pub command: Command,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CliControlCommand {
    kind: &'static str,
    request: CliControlRequest,
}

impl ControlExecutor for SocketExecutor {
    fn execute(&mut self, invocation: Invocation) -> Result<Value, CliError> {
        self.execute_with_progress(invocation, &mut |_| Ok(()))
    }

    fn execute_with_progress(
        &mut self,
        mut invocation: Invocation,
        progress: &mut dyn FnMut(&str) -> Result<(), CliError>,
    ) -> Result<Value, CliError> {
        apply_environment_scope(&mut invocation.command);
        if contract_for_command(&invocation.command)
            .is_some_and(|contract| contract.risk == RiskLevel::HighRisk)
        {
            progress("high-risk VibeLink operation: verify the selected stable IDs and approval boundary")?;
        }
        let timeout = Duration::from_millis(invocation.timeout_ms);
        let config = ControlSocketConfig::detect(invocation.flavor, timeout)?;
        let socket_name = config.socket_name();
        let flavor = config.flavor;
        match invocation.command.clone() {
            Command::Status => {
                ControlSocketClient::connect(config)?.ping()?;
                Ok(status_result(flavor, socket_name))
            }
            Command::Terminal(command) if command.action == TerminalAction::Wait => {
                terminal_wait(config, invocation, command, progress)
            }
            Command::Orchestration(command)
                if command.arguments.switches.contains("wait")
                    && matches!(
                        command.action,
                        OrchestrationAction::Check | OrchestrationAction::Inbox
                    ) =>
            {
                orchestration_wait(config, invocation, progress)
            }
            command => {
                let operation_id = invocation.operation_id;
                let response_contract = command.clone();
                let command_json =
                    control_command_json(operation_id, invocation.expected_revision, command)?;
                let result = ControlSocketClient::connect(config)?
                    .execute_json(operation_id, command_json)?;
                apply_result_contract(&response_contract, result)
            }
        }
    }
}

fn status_result(flavor: Flavor, socket_name: String) -> Value {
    let flavor_name = flavor.as_str();
    json!({
        "state": "running",
        "flavor": flavor,
        "socket": socket_name,
        "hostRuntime": paths::host_runtime_for_flavor(flavor_name),
        "hostProtected": paths::host_protected_for_flavor(flavor_name),
        "hostWindowTitle": paths::app_name_for_flavor(flavor_name),
        "version": env!("CARGO_PKG_VERSION"),
    })
}

fn apply_result_contract(command: &Command, mut result: Value) -> Result<Value, CliError> {
    let Command::Terminal(command) = command else {
        return Ok(result);
    };
    if command.action != TerminalAction::Read {
        return Ok(result);
    }
    let Some(max_bytes) = command
        .arguments
        .options
        .get("max-bytes")
        .and_then(|values| values.first())
        .and_then(|value| value.parse::<usize>().ok())
    else {
        return Ok(result);
    };
    let max_bytes = max_bytes.clamp(1, 1024 * 1024);
    let Some(text) = result.get("text").and_then(Value::as_str) else {
        return Ok(result);
    };
    if text.len() <= max_bytes {
        return Ok(result);
    }
    let total_bytes = text.len();
    let mut start = total_bytes - max_bytes;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    let bounded = text[start..].to_string();
    let object = result
        .as_object_mut()
        .ok_or_else(|| CliError::internal("terminal read response must be an object"))?;
    object.insert("text".to_string(), Value::String(bounded));
    object.insert("truncated".to_string(), Value::Bool(true));
    object.insert("totalBytes".to_string(), json!(total_bytes));
    Ok(result)
}

fn control_command_json(
    operation_id: uuid::Uuid,
    expected_revision: Option<u64>,
    command: Command,
) -> Result<String, CliError> {
    serde_json::to_string(&CliControlCommand {
        kind: "cli",
        request: CliControlRequest {
            schema_version: COMMAND_SCHEMA_VERSION,
            operation_id,
            expected_revision,
            caller_cwd: Some(canonical_caller_cwd()?),
            command,
        },
    })
    .map_err(|error| CliError::internal(format!("serialize control request: {error}")))
}

fn canonical_caller_cwd() -> Result<String, CliError> {
    let cwd = env::current_dir()
        .map_err(|error| CliError::internal(format!("read caller cwd: {error}")))?;
    let canonical = cwd
        .canonicalize()
        .map_err(|error| CliError::internal(format!("canonicalize caller cwd: {error}")))?;
    Ok(canonical.to_string_lossy().to_string())
}

fn apply_environment_scope(command: &mut Command) {
    let workspace = env::var("VIBELINK_SESSION_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    let pane = env::var("VIBELINK_PANE_ID")
        .ok()
        .filter(|value| !value.trim().is_empty());
    macro_rules! scope {
        ($command:expr) => {{
            if $command.selectors.workspace.is_none() {
                $command.selectors.workspace = workspace.clone();
            }
            if $command.selectors.pane.is_none() {
                $command.selectors.pane = pane.clone();
            }
        }};
    }
    match command {
        Command::Workspace(command) => {
            if command.selectors.workspace.is_none() {
                command.selectors.workspace = workspace;
            }
        }
        Command::Worktree(command) if command.action == WorktreeAction::Create => {
            if command.selectors.workspace.is_none() {
                command.selectors.workspace = workspace;
            }
        }
        Command::Terminal(command) => scope!(command),
        Command::Orchestration(command) => scope!(command),
        Command::Automation(command) => scope!(command),
        Command::Browser(command) => scope!(command),
        Command::Computer(command) => scope!(command),
        Command::Skill(command) => scope!(command),
        Command::Memory(command) => scope!(command),
        Command::Remote(command) => scope!(command),
        Command::Status | Command::Worktree(_) | Command::Mcp(_) => {}
    }
}

fn terminal_wait(
    config: ControlSocketConfig,
    invocation: Invocation,
    mut command: ActionCommand<TerminalAction>,
    progress: &mut dyn FnMut(&str) -> Result<(), CliError>,
) -> Result<Value, CliError> {
    let timeout = Duration::from_millis(invocation.timeout_ms);
    let started = Instant::now();
    let mut next_keepalive = Duration::from_secs(15);
    let mut client = ControlSocketClient::connect(config)?;
    client.authenticate()?;
    let expected_text = command
        .arguments
        .options
        .get("text")
        .and_then(|values| values.first())
        .cloned();
    let exit_only = command.arguments.switches.contains("exit");
    let mut after_sequence = command
        .arguments
        .options
        .get("after-sequence")
        .and_then(|values| values.first())
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let mut req = 1;
    loop {
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(CliError::timeout(format!(
                "terminal wait timed out after {}ms",
                timeout.as_millis()
            )));
        }
        if elapsed >= next_keepalive {
            progress("still waiting for sequenced terminal event")?;
            next_keepalive = next_keepalive.saturating_add(Duration::from_secs(15));
        }
        command.arguments.options.insert(
            "after-sequence".to_string(),
            vec![after_sequence.to_string()],
        );
        let response = execute_query(&mut client, req, Command::Terminal(command.clone()))?;
        req = req.saturating_add(1);
        let sequence = response
            .get("sequence")
            .and_then(Value::as_u64)
            .unwrap_or(after_sequence);
        let matched = response
            .get("matched")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let alive = response
            .get("alive")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let has_gap = response.get("gap").is_some_and(|gap| !gap.is_null());
        if !alive
            || (!exit_only
                && (matched || (expected_text.is_none() && (sequence > after_sequence || has_gap))))
        {
            return Ok(response);
        }
        after_sequence = sequence.max(after_sequence);
        thread::sleep(Duration::from_millis(250));
    }
}

fn execute_query(
    client: &mut ControlSocketClient,
    req: u64,
    command: Command,
) -> Result<Value, CliError> {
    let operation_id = uuid::Uuid::new_v4();
    let json = control_command_json(operation_id, None, command)?;
    client.execute_json_in_place(req, operation_id, json)
}

fn orchestration_wait(
    config: ControlSocketConfig,
    mut invocation: Invocation,
    progress: &mut dyn FnMut(&str) -> Result<(), CliError>,
) -> Result<Value, CliError> {
    let timeout = Duration::from_millis(invocation.timeout_ms);
    let started = Instant::now();
    let mut next_keepalive = Duration::from_secs(15);
    let Command::Orchestration(command) = &mut invocation.command else {
        unreachable!()
    };
    command.arguments.switches.remove("wait");
    let mut client = ControlSocketClient::connect(config)?;
    client.authenticate()?;
    let baseline = execute_query(&mut client, 1, invocation.command.clone())?;
    let mut req = 2;
    loop {
        let elapsed = started.elapsed();
        if elapsed >= timeout {
            return Err(CliError::timeout(format!(
                "orchestration wait timed out after {}ms",
                timeout.as_millis()
            )));
        }
        if elapsed >= next_keepalive {
            progress("still waiting for orchestration state change")?;
            next_keepalive = next_keepalive.saturating_add(Duration::from_secs(15));
        }
        thread::sleep(Duration::from_millis(250));
        let current = execute_query(&mut client, req, invocation.command.clone())?;
        req = req.saturating_add(1);
        if current != baseline {
            return Ok(current);
        }
    }
}

pub fn run_with_io<Out, Err>(
    args: impl IntoIterator<Item = impl Into<String>>,
    executor: &mut impl ControlExecutor,
    mcp: &mut impl McpRunner,
    stdout: Out,
    stderr: Err,
) -> i32
where
    Out: Write,
    Err: Write,
{
    let raw = args.into_iter().map(Into::into).collect::<Vec<_>>();
    let json_requested = raw
        .iter()
        .any(|token| token == "--json" || token.starts_with("--json="));
    let mut streams = OutputStreams::new(stdout, stderr);
    let invocation = match parse_args(raw) {
        Ok(invocation) => invocation,
        Err(error) => {
            let _ = streams.failure(&error, json_requested);
            return error.exit_code();
        }
    };

    if matches!(&invocation.command, Command::Mcp(_)) {
        return match mcp.serve() {
            Ok(()) => 0,
            Err(error) => {
                let _ = streams.failure(&error, false);
                error.exit_code()
            }
        };
    }

    let json_mode = invocation.json;
    match executor.execute_with_progress(invocation, &mut |message| streams.diagnostic(message)) {
        Ok(result) => match streams.success(&result, json_mode) {
            Ok(()) => 0,
            Err(error) => error.exit_code(),
        },
        Err(error) => {
            let _ = streams.failure(&error, json_mode);
            error.exit_code()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dedicated_cli::ErrorCode;

    struct FakeExecutor {
        result: Result<Value, CliError>,
    }

    impl ControlExecutor for FakeExecutor {
        fn execute(&mut self, _invocation: Invocation) -> Result<Value, CliError> {
            self.result.clone()
        }
    }

    #[test]
    fn control_request_roundtrip_preserves_operation_and_revision() {
        let invocation = parse_args([
            "workspace",
            "delete",
            "--workspace",
            "workspace-1",
            "--expected-revision",
            "9",
        ])
        .expect("parse request");
        let request = CliControlRequest {
            schema_version: COMMAND_SCHEMA_VERSION,
            operation_id: invocation.operation_id,
            expected_revision: invocation.expected_revision,
            caller_cwd: Some("C:/caller/repository".to_string()),
            command: invocation.command,
        };
        let json = serde_json::to_value(&request).expect("serialize request");
        assert_eq!(json["schemaVersion"], 1);
        assert_eq!(json["expectedRevision"], 9);
        assert_eq!(json["callerCwd"], "C:/caller/repository");
        assert_eq!(json["command"]["domain"], "workspace");
        assert_eq!(
            serde_json::from_value::<CliControlRequest>(json).expect("deserialize request"),
            request
        );
    }

    #[test]
    fn caller_cwd_is_defaulted_for_older_control_requests() {
        let invocation = parse_args(["worktree", "current"]).expect("parse current");
        let request = CliControlRequest {
            schema_version: COMMAND_SCHEMA_VERSION,
            operation_id: invocation.operation_id,
            expected_revision: None,
            caller_cwd: None,
            command: invocation.command,
        };
        let mut json = serde_json::to_value(&request).expect("serialize");
        json.as_object_mut().expect("object").remove("callerCwd");
        let decoded: CliControlRequest = serde_json::from_value(json).expect("deserialize");
        assert_eq!(decoded.caller_cwd, None);
    }

    #[test]
    fn status_exposes_release_host_protection_and_dev_target_identity() {
        let release = status_result(Flavor::Prod, "prod-socket".to_string());
        assert_eq!(release["hostRuntime"], "release");
        assert_eq!(release["hostProtected"], true);
        assert_eq!(release["hostWindowTitle"], "VibeLink");

        let development = status_result(Flavor::Dev, "dev-socket".to_string());
        assert_eq!(development["hostRuntime"], "development");
        assert_eq!(development["hostProtected"], false);
        assert_eq!(development["hostWindowTitle"], "VibeLink Dev");
    }

    #[test]
    fn terminal_read_result_is_utf8_safely_bounded() {
        let invocation = parse_args(["terminal", "read", "--pane", "pane-1", "--max-bytes", "6"])
            .expect("parse terminal read");
        let bounded = apply_result_contract(
            &invocation.command,
            json!({ "paneId": "pane-1", "text": "가나다abc" }),
        )
        .expect("bound result");
        assert_eq!(bounded["text"], "다abc");
        assert_eq!(bounded["truncated"], true);
        assert_eq!(bounded["totalBytes"], 12);
    }

    #[test]
    fn json_mode_keeps_diagnostics_off_stdout() {
        let mut executor = FakeExecutor {
            result: Err(CliError::new(ErrorCode::Conflict, "revision changed")),
        };
        let mut mcp = || Ok(());
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let exit = run_with_io(
            ["workspace", "delete", "--workspace", "one", "--json"],
            &mut executor,
            &mut mcp,
            &mut stdout,
            &mut stderr,
        );
        assert_eq!(exit, 6);
        assert_eq!(
            String::from_utf8(stdout).expect("stdout utf8"),
            "{\"version\":1,\"ok\":false,\"error\":{\"code\":\"conflict\",\"message\":\"revision changed\"}}\n"
        );
        assert!(stderr.is_empty());
    }

    #[test]
    fn mcp_mode_never_emits_cli_envelopes() {
        let mut executor = FakeExecutor {
            result: Ok(json!({})),
        };
        let mut mcp = || Err(CliError::unavailable("MCP unavailable"));
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let exit = run_with_io(
            ["mcp", "serve"],
            &mut executor,
            &mut mcp,
            &mut stdout,
            &mut stderr,
        );
        assert_eq!(exit, 3);
        assert!(stdout.is_empty());
        assert!(String::from_utf8(stderr)
            .expect("stderr utf8")
            .contains("MCP unavailable"));
    }
}

use super::{
    agents::{self, AgentSpec, PromptDelivery},
    model::{AutomationOutputSnapshot, AutomationRecord, AutomationRuntimeIdentity},
    process_registry::AutomationProcessRegistry,
};
use serde_json::Value;
use std::ffi::OsString;
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Command, ExitStatus, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

const HERMES_BIN: &str = if cfg!(windows) {
    "hermes.exe"
} else {
    "hermes"
};
const MAX_CAPTURE_BYTES: usize = 256 * 1024;
const MAX_STREAM_BYTES: usize = MAX_CAPTURE_BYTES / 2;
const MAX_USAGE_BYTES: u64 = 1024 * 1024;
const WAIT_POLL_INTERVAL: Duration = Duration::from_millis(25);
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static USAGE_FILE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

const DEFAULT_TOOLSETS: &[&str] = &[
    "web",
    "terminal",
    "file",
    "vision",
    "todo",
    "memory",
    "session_search",
    "code_execution",
    "delegation",
];
const ALLOWED_TOOLSETS: &[&str] = &[
    "web",
    "search",
    "vision",
    "terminal",
    "file",
    "todo",
    "memory",
    "session_search",
    "code_execution",
    "delegation",
    "debugging",
];

#[derive(Clone, Debug)]
struct ConfiguredModel {
    provider: String,
    model: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct RunnerOutcome {
    pub status: String,
    pub runtime_identity: Option<AutomationRuntimeIdentity>,
    pub output_snapshot: Option<AutomationOutputSnapshot>,
    pub usage: Option<Value>,
    pub error: Option<String>,
    pub started_at: u64,
    pub finished_at: u64,
}

#[derive(Debug)]
pub(crate) struct AutomationTerminalLaunch {
    pub program: OsString,
    pub args: Vec<OsString>,
    pub env: Vec<(OsString, OsString)>,
    pub env_remove: Vec<OsString>,
    pub stdin_prompt: Option<String>,
    pub label: &'static str,
    pub timeout: Duration,
    pub(crate) usage_path: PathBuf,
    pub(crate) started_at: u64,
}

pub(crate) enum AutomationTerminalResult {
    Exited(Option<i32>),
    Cancelled,
    TimedOut,
    Failed(String),
}

#[derive(Clone)]
pub struct AutomationRunner {
    registry: Arc<AutomationProcessRegistry>,
    executable: Option<PathBuf>,
    #[cfg(test)]
    prefix_args: Vec<OsString>,
}

impl AutomationRunner {
    pub fn new(registry: Arc<AutomationProcessRegistry>, executable: Option<PathBuf>) -> Self {
        Self {
            registry,
            executable,
            #[cfg(test)]
            prefix_args: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(crate) fn new_with_prefix(
        registry: Arc<AutomationProcessRegistry>,
        executable: PathBuf,
        prefix_args: Vec<OsString>,
    ) -> Self {
        Self {
            registry,
            executable: Some(executable),
            prefix_args,
        }
    }

    fn build_command(
        &self,
        executable: &Path,
        automation: &AutomationRecord,
        spec: &AgentSpec,
        cwd: &Path,
        usage_path: &Path,
    ) -> (Command, Option<String>) {
        let mut command = Command::new(executable);
        #[cfg(test)]
        command.args(&self.prefix_args);
        let stdin_prompt = configure_command(&mut command, automation, spec, cwd, usage_path);
        (command, stdin_prompt)
    }

    pub fn run(&self, run_id: &str, automation: &AutomationRecord, cwd: &Path) -> RunnerOutcome {
        let launch = match self.prepare_terminal(run_id, automation, cwd) {
            Ok(launch) => launch,
            Err(outcome) => return outcome,
        };
        let AutomationTerminalLaunch {
            program,
            args,
            env,
            env_remove,
            stdin_prompt,
            label,
            timeout,
            usage_path,
            started_at,
        } = launch;
        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(if stdin_prompt.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(env);
        for key in env_remove {
            command.env_remove(key);
        }
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        self.execute_command(
            run_id,
            label,
            timeout,
            usage_path,
            command,
            stdin_prompt,
            started_at,
        )
    }

    pub(crate) fn prepare_terminal(
        &self,
        run_id: &str,
        automation: &AutomationRecord,
        cwd: &Path,
    ) -> Result<AutomationTerminalLaunch, RunnerOutcome> {
        let started_at = now_millis();
        let Some(spec) = agents::spec(&automation.agent) else {
            return Err(RunnerOutcome::new(
                "skipped_unavailable",
                None,
                None,
                None,
                Some(format!(
                    "automation agent '{}' is not supported by this VibeLink build",
                    automation.agent
                )),
                started_at,
            ));
        };
        let executable = self.resolve_executable(spec).map_err(|error| {
            RunnerOutcome::new(
                "skipped_unavailable",
                None,
                None,
                None,
                Some(error),
                started_at,
            )
        })?;
        if !cwd.is_dir() {
            return Err(unavailable_cwd(cwd, started_at));
        }
        if !automation.use_agent_default_model
            && automation
                .model
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
        {
            return Err(RunnerOutcome::new(
                "skipped_unavailable",
                None,
                None,
                None,
                Some(format!(
                    "automation has no pinned {} model; select a model or use the agent default",
                    spec.display_name
                )),
                started_at,
            ));
        }

        let usage_path = usage_file_path(run_id);
        let (command, stdin_prompt) =
            self.build_command(&executable, automation, spec, cwd, &usage_path);
        Ok(AutomationTerminalLaunch {
            program: command.get_program().to_owned(),
            args: command.get_args().map(OsString::from).collect(),
            env: command
                .get_envs()
                .filter_map(|(key, value)| value.map(|value| (key.to_owned(), value.to_owned())))
                .collect(),
            env_remove: command
                .get_envs()
                .filter_map(|(key, value)| value.is_none().then(|| key.to_owned()))
                .collect(),
            stdin_prompt,
            label: spec.display_name,
            timeout: Duration::from_secs(u64::from(automation.timeout_seconds)),
            usage_path,
            started_at,
        })
    }

    pub(crate) fn finish_terminal(
        &self,
        launch: AutomationTerminalLaunch,
        result: AutomationTerminalResult,
        output: &[u8],
        runtime_identity: Option<AutomationRuntimeIdentity>,
    ) -> RunnerOutcome {
        let snapshot = terminal_output_snapshot(output);
        let usage = read_usage(&launch.usage_path);
        let _ = fs::remove_file(&launch.usage_path);
        match result {
            AutomationTerminalResult::Exited(exit_code) => finish_exit_code(
                launch.label,
                exit_code,
                runtime_identity,
                snapshot,
                usage,
                launch.started_at,
            ),
            AutomationTerminalResult::Cancelled => RunnerOutcome::new(
                "cancelled",
                runtime_identity,
                snapshot,
                usage.ok().flatten(),
                None,
                launch.started_at,
            ),
            AutomationTerminalResult::TimedOut => RunnerOutcome::new(
                "dispatch_failed",
                runtime_identity,
                snapshot,
                usage.ok().flatten(),
                Some(format!(
                    "{} exceeded its hard timeout of {} seconds",
                    launch.label,
                    launch.timeout.as_secs()
                )),
                launch.started_at,
            ),
            AutomationTerminalResult::Failed(error) => RunnerOutcome::new(
                "dispatch_failed",
                runtime_identity,
                snapshot,
                usage.ok().flatten(),
                Some(error),
                launch.started_at,
            ),
        }
    }

    pub fn run_draft(&self, request_id: &str, prompt: &str, cwd: &Path) -> RunnerOutcome {
        let started_at = now_millis();
        let executable = match self.resolve_executable(hermes_spec()) {
            Ok(value) => value,
            Err(error) => {
                return RunnerOutcome::new(
                    "skipped_unavailable",
                    None,
                    None,
                    None,
                    Some(error),
                    started_at,
                )
            }
        };
        if !cwd.is_dir() {
            return unavailable_cwd(cwd, started_at);
        }
        let configured_model = match read_configured_model() {
            Ok(Some(value)) => value,
            Ok(None) => {
                return RunnerOutcome::new(
                    "skipped_unavailable",
                    None,
                    None,
                    None,
                    Some("Hermes has no configured model for draft generation".into()),
                    started_at,
                )
            }
            Err(error) => {
                return RunnerOutcome::new(
                    "skipped_unavailable",
                    None,
                    None,
                    None,
                    Some(error),
                    started_at,
                )
            }
        };

        let usage_path = usage_file_path(request_id);
        let mut command = Command::new(&executable);
        #[cfg(test)]
        command.args(&self.prefix_args);
        configure_draft_command(&mut command, prompt, cwd, &usage_path, &configured_model);
        self.execute_command(
            request_id,
            "Hermes draft preview",
            Duration::from_secs(120),
            usage_path,
            command,
            None,
            started_at,
        )
    }

    fn execute_command(
        &self,
        run_id: &str,
        label: &str,
        timeout: Duration,
        usage_path: PathBuf,
        mut command: Command,
        stdin_prompt: Option<String>,
        started_at: u64,
    ) -> RunnerOutcome {
        let executable = command.get_program().to_owned();
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let _ = fs::remove_file(&usage_path);
                let (status, message) = classify_spawn_error(Path::new(&executable), &error);
                return RunnerOutcome::new(status, None, None, None, Some(message), started_at);
            }
        };

        // Why: prompts delivered over stdin must be written and the pipe closed
        // before the child is handed to the registry, otherwise the agent waits
        // on stdin forever and only ends at the hard timeout.
        if let Some(prompt) = stdin_prompt {
            if let Some(mut stdin) = child.stdin.take() {
                let write_result = stdin
                    .write_all(prompt.as_bytes())
                    .and_then(|()| stdin.flush());
                drop(stdin);
                if let Err(error) = write_result {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = fs::remove_file(&usage_path);
                    return RunnerOutcome::new(
                        "dispatch_failed",
                        None,
                        None,
                        None,
                        Some(format!("write {label} prompt to agent stdin: {error}")),
                        started_at,
                    );
                }
            }
        }

        let stdout_capture = Arc::new(Mutex::new(BoundedCapture::default()));
        let stderr_capture = Arc::new(Mutex::new(BoundedCapture::default()));
        let stdout_thread = child
            .stdout
            .take()
            .map(|s| capture_stream(s, Arc::clone(&stdout_capture)));
        let stderr_thread = child
            .stderr
            .take()
            .map(|s| capture_stream(s, Arc::clone(&stderr_capture)));
        let registered = match self.registry.register(run_id, child) {
            Ok(value) => value,
            Err(error) => {
                join_capture(stdout_thread);
                join_capture(stderr_thread);
                let snapshot = output_snapshot(&stdout_capture, &stderr_capture);
                let _ = fs::remove_file(&usage_path);
                return RunnerOutcome::new(
                    "dispatch_failed",
                    None,
                    snapshot,
                    None,
                    Some(format!("register {label} process ownership: {error}")),
                    started_at,
                );
            }
        };
        let runtime_identity = Some(registered.runtime_identity());
        let wait_started = Instant::now();
        let wait_result = loop {
            if registered.was_cancelled() {
                break WaitResult::Cancelled;
            }
            match registered.try_wait() {
                Ok(Some(status)) => break WaitResult::Exited(status),
                Ok(None) if wait_started.elapsed() < timeout => thread::sleep(WAIT_POLL_INTERVAL),
                Ok(None) => break WaitResult::TimedOut(registered.terminate_and_wait().err()),
                Err(error) => {
                    break WaitResult::Failed(error, registered.terminate_and_wait().err())
                }
            }
        };

        join_capture(stdout_thread);
        join_capture(stderr_thread);
        let snapshot = output_snapshot(&stdout_capture, &stderr_capture);
        let usage = read_usage(&usage_path);
        let _ = fs::remove_file(&usage_path);
        match wait_result {
            WaitResult::Cancelled => RunnerOutcome::new(
                "cancelled",
                runtime_identity,
                snapshot,
                usage.ok().flatten(),
                None,
                started_at,
            ),
            WaitResult::TimedOut(termination_error) => {
                let mut error = format!(
                    "{label} exceeded its hard timeout of {} seconds",
                    timeout.as_secs()
                );
                if let Some(termination_error) = termination_error {
                    error.push_str(&format!(
                        "; process termination failed: {termination_error}"
                    ));
                }
                RunnerOutcome::new(
                    "dispatch_failed",
                    runtime_identity,
                    snapshot,
                    usage.ok().flatten(),
                    Some(error),
                    started_at,
                )
            }
            WaitResult::Failed(wait_error, termination_error) => {
                let mut error = format!("wait for {label}: {wait_error}");
                if let Some(termination_error) = termination_error {
                    error.push_str(&format!(
                        "; process termination failed: {termination_error}"
                    ));
                }
                RunnerOutcome::new(
                    "dispatch_failed",
                    runtime_identity,
                    snapshot,
                    usage.ok().flatten(),
                    Some(error),
                    started_at,
                )
            }
            WaitResult::Exited(status) => {
                finish_exited(label, status, runtime_identity, snapshot, usage, started_at)
            }
        }
    }

    fn resolve_executable(&self, spec: &AgentSpec) -> Result<PathBuf, String> {
        if let Some(executable) = self.executable.as_ref() {
            return resolve_program_local(executable).ok_or_else(|| {
                format!(
                    "{} executable is unavailable: {}",
                    spec.display_name,
                    executable.display()
                )
            });
        }
        if spec.id == "hermes" {
            if let Some(hermes) = resolve_hermes_install() {
                return Ok(hermes);
            }
        }
        spec.resolve(resolve_program_local).ok_or_else(|| {
            format!(
                "{} CLI is unavailable on PATH; install it or pick another agent",
                spec.display_name
            )
        })
    }
}

fn hermes_spec() -> &'static AgentSpec {
    agents::spec("hermes").expect("hermes agent spec is always present")
}

/// Hermes ships inside a managed virtualenv that is often not on PATH, so its
/// sibling `hermes-acp` shim and the two known install roots are checked first.
fn resolve_hermes_install() -> Option<PathBuf> {
    if let Some(acp) = resolve_program_local(Path::new("hermes-acp")) {
        let companion = acp.with_file_name(HERMES_BIN);
        if companion.is_file() {
            return Some(companion);
        }
    }
    #[cfg(windows)]
    {
        let local_app_data = std::env::var("LOCALAPPDATA").ok();
        let user_profile = std::env::var("USERPROFILE").ok();
        let candidates = [
            local_app_data.map(|p| {
                PathBuf::from(p)
                    .join("hermes/hermes-agent/venv/Scripts")
                    .join(HERMES_BIN)
            }),
            user_profile.map(|p| {
                PathBuf::from(p)
                    .join(".hermes/hermes-agent/venv/Scripts")
                    .join(HERMES_BIN)
            }),
        ];
        for candidate in candidates.into_iter().flatten() {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
fn resolve_program_local(program: &Path) -> Option<PathBuf> {
    if program.components().count() > 1 {
        return program.is_file().then(|| program.to_path_buf());
    }

    let path_var = std::env::var_os("PATH")?;
    let paths = std::env::split_paths(&path_var);

    #[cfg(windows)]
    {
        let has_extension = program.extension().is_some();
        let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let exts: Vec<&str> = pathext.split(';').filter(|s| !s.is_empty()).collect();

        for dir in paths {
            let candidate = dir.join(program);
            if has_extension && candidate.is_file() {
                return Some(candidate);
            }
            for ext in &exts {
                let mut candidate_ext = candidate.clone();
                let ext_name = ext.trim_start_matches('.');
                candidate_ext.set_extension(ext_name);
                if candidate_ext.is_file() {
                    return Some(candidate_ext);
                }
            }
        }
    }

    #[cfg(not(windows))]
    {
        for dir in paths {
            let candidate = dir.join(program);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }

    None
}

impl RunnerOutcome {
    fn new(
        status: &str,
        runtime_identity: Option<AutomationRuntimeIdentity>,
        output_snapshot: Option<AutomationOutputSnapshot>,
        usage: Option<Value>,
        error: Option<String>,
        started_at: u64,
    ) -> Self {
        Self {
            status: status.into(),
            runtime_identity,
            output_snapshot,
            usage,

            error,
            started_at,
            finished_at: now_millis(),
        }
    }
}

fn unavailable_cwd(cwd: &Path, started_at: u64) -> RunnerOutcome {
    RunnerOutcome::new(
        "skipped_unavailable",
        None,
        None,
        None,
        Some(format!(
            "automation working directory is unavailable: {}",
            cwd.display()
        )),
        started_at,
    )
}

enum WaitResult {
    Exited(ExitStatus),
    Cancelled,
    TimedOut(Option<io::Error>),
    Failed(io::Error, Option<io::Error>),
}

/// Build the unattended argv/env for one agent run. Returns the prompt when the
/// selected agent takes it over stdin instead of argv.
fn configure_command(
    command: &mut Command,
    automation: &AutomationRecord,
    spec: &AgentSpec,
    cwd: &Path,
    usage_path: &Path,
) -> Option<String> {
    let prompt = unattended_prompt(&automation.prompt);
    let stdin_prompt = matches!(spec.prompt_delivery, PromptDelivery::Stdin);
    command
        .current_dir(cwd)
        .stdin(if stdin_prompt {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .args(spec.headless_args)
        // Why: every supported CLI treats a TTY-less run differently; forcing
        // plain output keeps the captured snapshot free of ANSI control bytes.
        .env("NO_COLOR", "1")
        .env("TERM", "dumb")
        .env("CI", "1")
        .env("VIBELINK_AUTOMATION", "1")
        .env_remove("FORCE_COLOR")
        .env_remove("VIBELINK_SESSION_ID")
        .env_remove("VIBELINK_PANE_ID");
    if !stdin_prompt {
        command.arg(&prompt);
    }
    if let Some(variable) = spec.max_turns_env {
        command.env(variable, automation.max_turns.to_string());
    }
    if spec.supports_hermes_extensions {
        command
            .arg("--usage-file")
            .arg(usage_path)
            .arg("--toolsets")
            .arg(unattended_toolsets(&automation.toolsets).join(","))
            .env("HERMES_ACCEPT_HOOKS", "1")
            .env("HERMES_YOLO_MODE", "1")
            .env("HERMES_SESSION_SOURCE", "vibelink-automation")
            .env_remove("HERMES_INTERACTIVE")
            .env_remove("HERMES_DESKTOP")
            .env_remove("HERMES_KANBAN_TASK")
            .env_remove("HERMES_KANBAN_ROLE");
        for skill in automation
            .skills
            .iter()
            .map(|v| v.trim())
            .filter(|v| !v.is_empty() && !v.starts_with('-'))
        {
            command.arg("--skills").arg(skill);
        }
    }
    command.args(spec.unattended_args);
    if !automation.use_agent_default_model {
        if let Some(model) =
            spec.model_argument(automation.provider.as_deref(), automation.model.as_deref())
        {
            command.arg("--model").arg(model);
        }
        // Why: only Hermes accepts a separate provider flag; opencode folds the
        // provider into the model value and the rest resolve it from config.
        if spec.supports_hermes_extensions {
            if let Some(provider) = automation
                .provider
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
            {
                command.arg("--provider").arg(provider);
            }
        }
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    stdin_prompt.then_some(prompt)
}

fn configure_draft_command(
    command: &mut Command,
    prompt: &str,
    cwd: &Path,
    usage_path: &Path,
    configured_model: &ConfiguredModel,
) {
    command
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .arg("--oneshot")
        .arg(prompt)
        .arg("--usage-file")
        .arg(usage_path)
        .arg("--toolsets")
        .arg("search")
        .arg("--safe-mode")
        .arg("--model")
        .arg(&configured_model.model)
        .env("HERMES_MAX_ITERATIONS", "2")
        .env("HERMES_SESSION_SOURCE", "vibelink-automation-draft")
        .env_remove("HERMES_ACCEPT_HOOKS")
        .env_remove("HERMES_YOLO_MODE")
        .env_remove("HERMES_INTERACTIVE")
        .env_remove("HERMES_DESKTOP")
        .env_remove("HERMES_KANBAN_TASK")
        .env_remove("HERMES_KANBAN_ROLE")
        .env_remove("VIBELINK_SESSION_ID")
        .env_remove("VIBELINK_PANE_ID");
    if !configured_model.provider.is_empty() {
        command.arg("--provider").arg(&configured_model.provider);
    }
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn read_configured_model() -> Result<Option<ConfiguredModel>, String> {
    let config_path = hermes_home().join("config.yaml");
    let text = fs::read_to_string(&config_path).map_err(|error| {
        format!(
            "read Hermes model config {}: {error}",
            config_path.display()
        )
    })?;
    let value: serde_yaml::Value = serde_yaml::from_str(&text).map_err(|error| {
        format!(
            "parse Hermes model config {}: {error}",
            config_path.display()
        )
    })?;
    let Some(model_value) = value
        .as_mapping()
        .and_then(|mapping| mapping.get(serde_yaml::Value::from("model")))
    else {
        return Ok(None);
    };
    let configured = match model_value {
        serde_yaml::Value::Mapping(model) => {
            let provider = model
                .get(serde_yaml::Value::from("provider"))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let model = model
                .get(serde_yaml::Value::from("default"))
                .or_else(|| model.get(serde_yaml::Value::from("model")))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            model.map(|model| ConfiguredModel {
                provider: provider.to_string(),
                model: model.to_string(),
            })
        }
        serde_yaml::Value::String(model) => {
            let model = model.trim();
            (!model.is_empty()).then(|| ConfiguredModel {
                provider: String::new(),
                model: model.to_string(),
            })
        }
        _ => None,
    };
    Ok(configured)
}

fn hermes_home() -> PathBuf {
    if let Some(home) = std::env::var("HERMES_HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(home);
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var("LOCALAPPDATA")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            return PathBuf::from(local_app_data).join("hermes");
        }
        if let Some(user_profile) = std::env::var("USERPROFILE")
            .ok()
            .filter(|value| !value.trim().is_empty())
        {
            return PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join("hermes");
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var("HOME")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        return PathBuf::from(home).join(".hermes");
    }
    PathBuf::from(".hermes")
}

fn unattended_prompt(prompt: &str) -> String {
    format!(
        "You are running as a VibeLink unattended automation. Work only inside the current run workspace. Do not create, edit, pause, resume, or trigger schedules or cron jobs. Do not use messaging platforms, project/workspace switching, browser automation, interactive login, CAPTCHA, device-code authentication, or secret prompts. Do not request clarification; make a safe reasonable assumption when possible and report any blocker in the final response. Do not modify your own agent configuration, credentials, plugins, hooks, or installed skills. Never merge into, delete, or otherwise mutate the base worktree automatically.\n\nUser automation prompt:\n{}",
        prompt.trim()
    )
}

fn unattended_toolsets(requested: &[String]) -> Vec<String> {
    let mut selected = Vec::new();
    for name in requested.iter().map(|v| v.trim().to_ascii_lowercase()) {
        if name == "hermes-acp" {
            for value in DEFAULT_TOOLSETS {
                push_unique(&mut selected, value);
            }
        } else if ALLOWED_TOOLSETS.contains(&name.as_str()) {
            push_unique(&mut selected, &name);
        }
    }
    if selected.is_empty() {
        for value in DEFAULT_TOOLSETS {
            push_unique(&mut selected, value);
        }
    }
    selected
}

fn push_unique(values: &mut Vec<String>, value: &str) {
    if !values.iter().any(|existing| existing == value) {
        values.push(value.into());
    }
}

fn finish_exited(
    label: &str,
    status: ExitStatus,
    runtime_identity: Option<AutomationRuntimeIdentity>,
    snapshot: Option<AutomationOutputSnapshot>,
    usage: Result<Option<Value>, String>,
    started_at: u64,
) -> RunnerOutcome {
    finish_exit_code(
        label,
        status.code(),
        runtime_identity,
        snapshot,
        usage,
        started_at,
    )
}

fn finish_exit_code(
    label: &str,
    exit_code: Option<i32>,
    runtime_identity: Option<AutomationRuntimeIdentity>,
    snapshot: Option<AutomationOutputSnapshot>,
    usage: Result<Option<Value>, String>,
    started_at: u64,
) -> RunnerOutcome {
    let combined = snapshot
        .as_ref()
        .map(|value| format!("{}\n{}", value.stdout, value.stderr))
        .unwrap_or_default();
    if exit_code != Some(0) {
        let mapped = if needs_interactive_auth(&combined) {
            "skipped_needs_interactive_auth"
        } else if setup_unavailable(&combined) {
            "skipped_unavailable"
        } else {
            "dispatch_failed"
        };
        let code = exit_code
            .map(|value| value.to_string())
            .unwrap_or_else(|| "terminated by signal".into());
        return RunnerOutcome::new(
            mapped,
            runtime_identity,
            snapshot,
            usage.ok().flatten(),
            Some(format!("{label} exited with {code}")),
            started_at,
        );
    }
    let has_response = snapshot
        .as_ref()
        .and_then(|value| value.final_response.as_deref())
        .is_some_and(|value| !value.trim().is_empty());
    if !has_response {
        return RunnerOutcome::new(
            "dispatch_failed",
            runtime_identity,
            snapshot,
            usage.ok().flatten(),
            Some(format!(
                "{label} exited successfully but produced no final response"
            )),
            started_at,
        );
    }
    match usage {
        Ok(usage) => RunnerOutcome::new(
            "completed",
            runtime_identity,
            snapshot,
            usage,
            None,
            started_at,
        ),
        Err(error) => RunnerOutcome::new(
            "dispatch_failed",
            runtime_identity,
            snapshot,
            None,
            Some(error),
            started_at,
        ),
    }
}

fn classify_spawn_error(executable: &Path, error: &io::Error) -> (&'static str, String) {
    if error.kind() == io::ErrorKind::NotFound {
        (
            "skipped_unavailable",
            format!("Hermes executable is unavailable: {}", executable.display()),
        )
    } else {
        (
            "dispatch_failed",
            format!("start Hermes executable {}: {error}", executable.display()),
        )
    }
}

fn needs_interactive_auth(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    [
        "captcha",
        "device code",
        "device-code",
        "open a browser",
        "browser to authenticate",
        "authentication required",
        "not authenticated",
        "login required",
        "log in to",
        "sign in to",
        "reauthenticate",
        "run hermes auth",
        "api key is required",
        "missing api key",
        "no usable credential",
        "credential required",
        "oauth authorization",
    ]
    .iter()
    .any(|needle| output.contains(needle))
}

fn setup_unavailable(output: &str) -> bool {
    let output = output.to_ascii_lowercase();
    [
        "run hermes setup",
        "hermes is not configured",
        "no provider configured",
        "provider is not configured",
        "model is not configured",
        "no model configured",
    ]
    .iter()
    .any(|needle| output.contains(needle))
}

#[derive(Default)]
struct BoundedCapture {
    bytes: Vec<u8>,
    truncated: bool,
}
impl BoundedCapture {
    fn append(&mut self, chunk: &[u8]) {
        if chunk.len() >= MAX_STREAM_BYTES {
            self.bytes.clear();
            self.bytes
                .extend_from_slice(&chunk[chunk.len() - MAX_STREAM_BYTES..]);
            self.truncated = true;
            return;
        }
        self.bytes.extend_from_slice(chunk);
        if self.bytes.len() > MAX_STREAM_BYTES {
            let excess = self.bytes.len() - MAX_STREAM_BYTES;
            self.bytes.drain(..excess);
            self.truncated = true;
        }
    }
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

fn capture_stream(
    mut stream: impl Read + Send + 'static,
    capture: Arc<Mutex<BoundedCapture>>,
) -> thread::JoinHandle<()> {
    thread::Builder::new()
        .name("vibelink-automation-output".into())
        .spawn(move || {
            let mut chunk = [0_u8; 8192];
            loop {
                match stream.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(read) => match capture.lock() {
                        Ok(mut value) => value.append(&chunk[..read]),
                        Err(_) => break,
                    },
                }
            }
        })
        .expect("spawn bounded automation output reader")
}

fn join_capture(handle: Option<thread::JoinHandle<()>>) {
    if let Some(handle) = handle {
        let _ = handle.join();
    }
}

fn output_snapshot(
    stdout: &Arc<Mutex<BoundedCapture>>,
    stderr: &Arc<Mutex<BoundedCapture>>,
) -> Option<AutomationOutputSnapshot> {
    let stdout = stdout.lock().ok()?;
    let stderr = stderr.lock().ok()?;
    let stdout_text = stdout.text();
    let stderr_text = stderr.text();
    if stdout_text.is_empty() && stderr_text.is_empty() && !stdout.truncated && !stderr.truncated {
        return None;
    }
    Some(AutomationOutputSnapshot {
        final_response: (!stdout_text.trim().is_empty()).then(|| stdout_text.trim().to_string()),
        stdout: stdout_text,
        stderr: stderr_text,
        truncated: stdout.truncated || stderr.truncated,
    })
}

fn terminal_output_snapshot(output: &[u8]) -> Option<AutomationOutputSnapshot> {
    if output.is_empty() {
        return None;
    }
    let truncated = output.len() > MAX_CAPTURE_BYTES;
    let output = if truncated {
        &output[output.len() - MAX_CAPTURE_BYTES..]
    } else {
        output
    };
    let text = crate::mcp::strip_ansi(&String::from_utf8_lossy(output)).into_owned();
    Some(AutomationOutputSnapshot {
        final_response: (!text.trim().is_empty()).then(|| text.trim().to_string()),
        stdout: text,
        stderr: String::new(),
        truncated,
    })
}

fn read_usage(path: &Path) -> Result<Option<Value>, String> {
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("read Hermes usage metadata: {error}")),
    };
    if metadata.len() > MAX_USAGE_BYTES {
        return Err(format!(
            "Hermes usage output exceeded the {MAX_USAGE_BYTES} byte limit"
        ));
    }
    let bytes = fs::read(path).map_err(|error| format!("read Hermes usage output: {error}"))?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("parse Hermes usage output: {error}"))
}

fn usage_file_path(run_id: &str) -> PathBuf {
    let safe_id: String = run_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .take(64)
        .collect();
    let sequence = USAGE_FILE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    std::env::temp_dir().join(format!(
        "vibelink-automation-usage-{safe_id}-{}-{sequence}.json",
        std::process::id()
    ))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::super::model::AutomationPrecheck;
    use super::*;

    fn automation_record() -> AutomationRecord {
        AutomationRecord {
            id: "automation".into(),
            session_id: "session".into(),
            name: "Runner test".into(),
            prompt: "Verify the runner argv".into(),
            agent: "hermes".into(),
            provider: Some("provider".into()),
            model: Some("model".into()),
            use_agent_default_model: false,
            toolsets: vec!["hermes-acp".into()],
            skills: vec!["review".into()],
            max_turns: 7,
            timeout_seconds: 30,
            schedule_kind: "once".into(),
            schedule_value: "2030-01-01T00:00:00Z".into(),
            timezone: "UTC".into(),
            dtstart: None,
            next_run_at: None,
            last_run_at: None,
            enabled: true,
            requires_review: false,
            missed_run_grace_minutes: 720,
            missed_run_policy: "run_once_within_grace".into(),
            workspace_mode: "existing".into(),
            worktree_storage: serde_json::json!({}),
            base_ref: None,
            precheck: AutomationPrecheck {
                command: None,
                timeout_seconds: 5,
                require_workspace: true,
                require_git: false,
            },
            source: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn test_prefix_args_precede_the_same_hermes_args() {
        let registry = Arc::new(AutomationProcessRegistry::new());
        let executable = PathBuf::from("powershell.exe");
        let prefix_args = vec![
            OsString::from("-NoLogo"),
            OsString::from("-NoProfile"),
            OsString::from("-NonInteractive"),
            OsString::from("-File"),
            OsString::from("fake-hermes.ps1"),
            OsString::from("--"),
        ];
        let automation = automation_record();
        let cwd = Path::new("workspace");
        let usage_path = Path::new("usage.json");
        let production = AutomationRunner::new(Arc::clone(&registry), Some(executable.clone()));
        let prefixed = AutomationRunner::new_with_prefix(registry, executable, prefix_args.clone());

        let spec = hermes_spec();
        let production_args = production
            .build_command(
                Path::new("powershell.exe"),
                &automation,
                spec,
                cwd,
                usage_path,
            )
            .0
            .get_args()
            .map(OsString::from)
            .collect::<Vec<_>>();
        let prefixed_args = prefixed
            .build_command(
                Path::new("powershell.exe"),
                &automation,
                spec,
                cwd,
                usage_path,
            )
            .0
            .get_args()
            .map(OsString::from)
            .collect::<Vec<_>>();

        assert_eq!(&prefixed_args[..prefix_args.len()], prefix_args.as_slice());
        assert_eq!(
            &prefixed_args[prefix_args.len()..],
            production_args.as_slice()
        );
        assert_eq!(production_args.first(), Some(&OsString::from("--oneshot")));
    }

    #[test]
    fn draft_command_is_isolated_and_search_only() {
        let mut command = Command::new("hermes.exe");
        configure_draft_command(
            &mut command,
            "return json",
            Path::new("draft-workspace"),
            Path::new("usage.json"),
            &ConfiguredModel {
                provider: "openai-codex".into(),
                model: "gpt-5.5".into(),
            },
        );
        let args = command
            .get_args()
            .map(|value| value.to_string_lossy().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            args,
            [
                "--oneshot",
                "return json",
                "--usage-file",
                "usage.json",
                "--toolsets",
                "search",
                "--safe-mode",
                "--model",
                "gpt-5.5",
                "--provider",
                "openai-codex",
            ]
        );
        assert!(!args
            .iter()
            .any(|value| matches!(value.as_str(), "--yolo" | "--accept-hooks" | "--skills")));
        let envs = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().to_string(),
                    value.map(|value| value.to_string_lossy().to_string()),
                )
            })
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(envs.get("HERMES_MAX_ITERATIONS"), Some(&Some("2".into())));
        assert_eq!(envs.get("HERMES_ACCEPT_HOOKS"), Some(&None));
        assert_eq!(envs.get("HERMES_YOLO_MODE"), Some(&None));
    }

    #[test]
    fn safe_toolset_filter_denies_interactive_and_messaging_surfaces() {
        let requested = [
            "hermes-acp",
            "cronjob",
            "clarify",
            "browser",
            "project",
            "hermes-discord",
            "all",
        ]
        .into_iter()
        .map(str::to_string)
        .collect::<Vec<_>>();
        let filtered = unattended_toolsets(&requested).join(",");
        assert!(filtered.contains("terminal"));
        for forbidden in [
            "hermes-acp",
            "cronjob",
            "clarify",
            "browser",
            "project",
            "discord",
            "all",
            "*",
        ] {
            assert!(!filtered.contains(forbidden));
        }
    }

    #[test]
    fn interactive_auth_output_is_classified() {
        assert!(needs_interactive_auth(
            "Authentication required. Run hermes auth add, then open a browser."
        ));
    }

    #[test]
    fn bounded_capture_preserves_tail_and_truncation() {
        let mut capture = BoundedCapture::default();
        capture.append(&vec![b'x'; MAX_STREAM_BYTES + 17]);
        assert_eq!(capture.bytes.len(), MAX_STREAM_BYTES);
        assert!(capture.truncated);
    }

    // Process-level fake-Hermes cases are exercised by the integration module with the
    // executable override: success/usage, nonzero, timeout, missing executable, auth,
    #[test]
    fn resolve_program_local_explicit_path() {
        let temp_dir = std::env::temp_dir();
        let dummy_file = temp_dir.join("test_dummy_hermes_bin.exe");
        let _ = fs::write(&dummy_file, b"test");
        let resolved = resolve_program_local(&dummy_file);
        let _ = fs::remove_file(&dummy_file);
        assert_eq!(resolved, Some(dummy_file));
    }

    #[test]
    fn resolve_program_local_nonexistent_returns_none() {
        assert_eq!(
            resolve_program_local(Path::new("nonexistent_binary_xyz_123.exe")),
            None
        );
    }
    // model/provider omission and override, and the denylist all use this public seam.
}

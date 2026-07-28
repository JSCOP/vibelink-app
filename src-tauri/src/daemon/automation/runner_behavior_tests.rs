use super::{
    model::parse_create,
    process_registry::AutomationProcessRegistry,
    runner::{AutomationRunner, RunnerOutcome},
};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;
use windows::Win32::{
    Foundation::{CloseHandle, WAIT_TIMEOUT},
    System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
};

const FINAL_RESPONSE: &str = r#"{"finalResponse":"automation complete"}"#;
const STDERR_MARKER: &str = "fake-hermes-stderr-marker";

struct TestDirectory(PathBuf);

impl TestDirectory {
    fn new(label: &str) -> Self {
        let path = std::env::temp_dir().join(format!(
            "vibelink-runner-{label}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&path).expect("create runner behavior test directory");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct FakeHermes {
    directory: TestDirectory,
    registry: Arc<AutomationProcessRegistry>,
    runner: AutomationRunner,
}

impl FakeHermes {
    fn new(label: &str, mode: &str) -> Self {
        let directory = TestDirectory::new(label);
        let script = directory.path().join("fake-hermes.ps1");
        fs::write(&script, FAKE_HERMES_SCRIPT).expect("write fake Hermes script");
        fs::write(directory.path().join("mode.txt"), mode).expect("write fake Hermes mode");

        let registry = Arc::new(AutomationProcessRegistry::new());
        let runner = AutomationRunner::new_with_prefix(
            Arc::clone(&registry),
            powershell_executable(),
            vec![
                OsString::from("-NoLogo"),
                OsString::from("-NoProfile"),
                OsString::from("-NonInteractive"),
                OsString::from("-ExecutionPolicy"),
                OsString::from("Bypass"),
                OsString::from("-File"),
                script.into_os_string(),
                OsString::from("--"),
            ],
        );
        Self {
            directory,
            registry,
            runner,
        }
    }

    fn run(&self, run_id: &str, automation: &super::AutomationRecord) -> RunnerOutcome {
        self.runner.run(run_id, automation, self.directory.path())
    }

    fn capture(&self) -> Value {
        let bytes = fs::read(self.directory.path().join("capture.json"))
            .expect("read captured fake Hermes invocation");
        serde_json::from_slice(&bytes).expect("parse captured fake Hermes invocation")
    }

    fn spawned_pid(&self) -> u32 {
        fs::read_to_string(self.directory.path().join("pid.txt"))
            .expect("read fake Hermes pid")
            .trim()
            .parse()
            .expect("parse fake Hermes pid")
    }
}

#[test]
fn success_captures_response_usage_stderr_and_exact_pinned_invocation() {
    let fake = FakeHermes::new("success-pinned", "success");
    let prompt = r#"Audit "quoted" input; $(Write-Error nope) & keep literal"#;
    let automation = canonical_record(json!({
        "prompt": prompt,
        "provider": "openai-codex",
        "model": "gpt-5.6",
        "useAgentDefaultModel": false,
        "toolsets": [
            "hermes-acp",
            "cronjob",
            "clarify",
            "browser",
            "search",
            "debugging",
            "terminal"
        ],
        "skills": [" review ", "-blocked", "qa"],
        "maxTurns": 17
    }));

    let outcome = fake.run("success-pinned", &automation);

    assert_eq!(outcome.status, "completed");
    assert!(outcome.runtime_identity.is_some());
    assert_eq!(outcome.error, None);
    let snapshot = outcome.output_snapshot.expect("completed output snapshot");
    assert_eq!(snapshot.final_response.as_deref(), Some(FINAL_RESPONSE));
    assert_eq!(snapshot.stdout.trim(), FINAL_RESPONSE);
    assert_eq!(snapshot.stderr.trim(), STDERR_MARKER);
    assert!(!snapshot.truncated);
    assert_eq!(
        outcome.usage,
        Some(json!({
            "inputTokens": 12,
            "outputTokens": 34,
            "totalTokens": 46
        }))
    );

    let capture = fake.capture();
    assert_eq!(capture["maxTurns"], "17");
    let args = captured_args(&capture);
    assert_eq!(args.len(), 16, "unexpected complete Hermes argv: {args:?}");
    let usage_path = args[3].clone();
    assert_eq!(
        args,
        vec![
            "--oneshot".to_string(),
            unattended_prompt(prompt),
            "--usage-file".to_string(),
            usage_path,
            "--toolsets".to_string(),
            "web,terminal,file,vision,todo,memory,session_search,code_execution,delegation,search,debugging".to_string(),
            "--skills".to_string(),
            "review".to_string(),
            "--skills".to_string(),
            "qa".to_string(),
            "--accept-hooks".to_string(),
            "--yolo".to_string(),
            "--model".to_string(),
            "gpt-5.6".to_string(),
            "--provider".to_string(),
            "openai-codex".to_string(),
        ]
    );
    assert!(!fake
        .registry
        .cancel("success-pinned")
        .expect("query registry"));
}

#[test]
fn current_default_omits_model_and_provider_from_real_child_argv() {
    let fake = FakeHermes::new("success-default", "success");
    let automation = canonical_record(json!({
        "prompt": "Use the configured Hermes default",
        "provider": "must-not-be-forwarded",
        "model": "must-not-be-forwarded",
        "useAgentDefaultModel": true,
        "toolsets": ["search", "cronjob"],
        "skills": [],
        "maxTurns": 9
    }));

    let outcome = fake.run("success-default", &automation);

    assert_eq!(outcome.status, "completed");
    let capture = fake.capture();
    assert_eq!(capture["maxTurns"], "9");
    let args = captured_args(&capture);
    assert_eq!(args.len(), 8, "unexpected complete Hermes argv: {args:?}");
    assert_eq!(args[0], "--oneshot");
    assert_eq!(args[1], unattended_prompt(&automation.prompt));
    assert_eq!(args[2], "--usage-file");
    assert_eq!(
        &args[4..],
        ["--toolsets", "search", "--accept-hooks", "--yolo"]
    );
    assert!(!args.iter().any(|value| value == "--model"));
    assert!(!args.iter().any(|value| value == "--provider"));
}

#[test]
fn nonzero_exit_is_dispatch_failed_with_captured_stderr() {
    let fake = FakeHermes::new("nonzero", "nonzero");
    let outcome = fake.run("nonzero", &canonical_record(json!({})));

    assert_eq!(outcome.status, "dispatch_failed");
    assert!(outcome.runtime_identity.is_some());
    assert_eq!(
        outcome.error.as_deref(),
        Some("Hermes one-shot exited with 7")
    );
    let snapshot = outcome.output_snapshot.expect("nonzero output snapshot");
    assert!(snapshot.stderr.contains("intentional nonzero exit"));
    assert!(!fake.registry.cancel("nonzero").expect("query registry"));
}

#[test]
fn timeout_is_bounded_and_leaves_no_owned_process_alive() {
    let fake = FakeHermes::new("timeout", "timeout");
    let automation = canonical_record(json!({"timeoutSeconds": 1}));
    let started = Instant::now();

    let outcome = fake.run("timeout", &automation);
    let elapsed = started.elapsed();

    assert_eq!(outcome.status, "dispatch_failed");
    assert!(outcome.runtime_identity.is_some());
    assert!(outcome
        .error
        .as_deref()
        .is_some_and(|error| error.contains("hard timeout of 1 seconds")));
    assert!(
        elapsed >= Duration::from_millis(800),
        "timeout returned too early: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(5),
        "timeout was not bounded: {elapsed:?}"
    );
    let pid = fake.spawned_pid();
    assert!(
        wait_until(Duration::from_secs(2), || !process_is_alive(pid)),
        "timed-out owned process survived runner completion"
    );
    assert!(!fake.registry.cancel("timeout").expect("query registry"));
}

#[test]
fn missing_executable_is_skipped_unavailable_without_spawning() {
    let directory = TestDirectory::new("missing");
    let registry = Arc::new(AutomationProcessRegistry::new());
    let missing = directory.path().join("missing-hermes.exe");
    let runner =
        AutomationRunner::new_with_prefix(Arc::clone(&registry), missing.clone(), Vec::new());

    let outcome = runner.run("missing", &canonical_record(json!({})), directory.path());

    assert_eq!(outcome.status, "skipped_unavailable");
    assert_eq!(outcome.runtime_identity, None);
    assert_eq!(outcome.output_snapshot, None);
    assert!(outcome
        .error
        .as_deref()
        .is_some_and(|error| error.contains(&missing.display().to_string())));
    assert!(!registry.cancel("missing").expect("query registry"));
}

#[test]
fn interactive_auth_failure_is_classified_for_user_action() {
    let fake = FakeHermes::new("interactive", "interactive");
    let outcome = fake.run("interactive", &canonical_record(json!({})));

    assert_eq!(outcome.status, "skipped_needs_interactive_auth");
    assert!(outcome.runtime_identity.is_some());
    assert!(outcome
        .output_snapshot
        .as_ref()
        .is_some_and(|snapshot| snapshot.stderr.contains("Authentication required")));
    assert_eq!(
        outcome.error.as_deref(),
        Some("Hermes one-shot exited with 7")
    );
}

#[test]
fn oversized_child_output_sets_truncation_flag_and_preserves_final_tail() {
    let fake = FakeHermes::new("truncate", "truncate");
    let outcome = fake.run("truncate", &canonical_record(json!({})));

    assert_eq!(outcome.status, "completed");
    let snapshot = outcome.output_snapshot.expect("truncated output snapshot");
    assert!(snapshot.truncated);
    assert!(snapshot.stdout.len() <= 128 * 1024);
    assert!(
        snapshot.stdout.ends_with("TRUNCATED_FINAL_RESPONSE\r\n")
            || snapshot.stdout.ends_with("TRUNCATED_FINAL_RESPONSE\n")
    );
    assert!(snapshot
        .final_response
        .as_deref()
        .is_some_and(|response| response.ends_with("TRUNCATED_FINAL_RESPONSE")));
}

/// Each non-Hermes agent must be launched in its own documented headless mode
/// with no Hermes-only flags leaking in, and the prompt must reach it exactly
/// once — as argv for the argv agents, over stdin for opencode.
#[test]
fn every_agent_runs_headless_with_only_its_own_flags() {
    let prompt = "Audit the workspace";
    let guarded = unattended_prompt(prompt);
    let expected_argv: [(&str, Vec<String>); 4] = [
        (
            "omp",
            vec![
                "--print".into(),
                guarded.clone(),
                "--auto-approve".into(),
                "--no-session".into(),
            ],
        ),
        (
            "claude",
            vec![
                "--print".into(),
                guarded.clone(),
                "--permission-mode".into(),
                "bypassPermissions".into(),
            ],
        ),
        (
            "codex",
            vec![
                "exec".into(),
                "--skip-git-repo-check".into(),
                "--color".into(),
                "never".into(),
                guarded.clone(),
                "--dangerously-bypass-approvals-and-sandbox".into(),
            ],
        ),
        // opencode receives the prompt on stdin, so it never appears in argv.
        ("opencode", vec!["run".into(), "--auto".into()]),
    ];

    for (agent, expected) in expected_argv {
        let fake = FakeHermes::new(&format!("agent-{agent}"), "success");
        let record = canonical_record(json!({ "agent": agent, "prompt": prompt }));

        let outcome = fake.run(&format!("agent-{agent}"), &record);
        assert_eq!(outcome.status, "completed", "{agent} did not complete");

        let capture = fake.capture();
        assert_eq!(captured_args(&capture), expected, "unexpected {agent} argv");

        let stdin = capture["stdin"].as_str().unwrap_or("");
        if agent == "opencode" {
            assert_eq!(
                stdin.trim_end(),
                guarded,
                "opencode prompt did not arrive on stdin"
            );
        } else {
            assert!(
                stdin.is_empty(),
                "{agent} unexpectedly received stdin: {stdin:?}"
            );
        }

        for hermes_only in [
            "--usage-file",
            "--toolsets",
            "--accept-hooks",
            "--yolo",
            "--skills",
        ] {
            assert!(
                !expected.iter().any(|value| value == hermes_only),
                "{agent} received Hermes-only flag {hermes_only}"
            );
        }
    }
}

#[test]
fn opencode_qualifies_a_pinned_model_and_omits_the_provider_flag() {
    let fake = FakeHermes::new("opencode-model", "success");
    let record = canonical_record(json!({
        "agent": "opencode",
        "provider": "anthropic",
        "model": "claude-sonnet-4",
        "useAgentDefaultModel": false
    }));

    let outcome = fake.run("opencode-model", &record);

    assert_eq!(outcome.status, "completed");
    let args = captured_args(&fake.capture());
    assert_eq!(
        args,
        vec!["run", "--auto", "--model", "anthropic/claude-sonnet-4"]
    );
    assert!(!args.iter().any(|value| value == "--provider"));
}

#[test]
fn an_unsupported_agent_is_skipped_without_spawning() {
    let fake = FakeHermes::new("unsupported", "success");
    let mut record = canonical_record(json!({}));
    record.agent = "openclaw".to_string();

    let outcome = fake.run("unsupported", &record);

    assert_eq!(outcome.status, "skipped_unavailable");
    assert_eq!(outcome.runtime_identity, None);
    assert!(outcome
        .error
        .as_deref()
        .is_some_and(|error| error.contains("openclaw")));
}

fn canonical_record(overrides: Value) -> super::AutomationRecord {
    let mut payload = json!({
        "name": "Runner behavior test",
        "prompt": "Run the offline fixture",
        "scheduleKind": "daily",
        "scheduleValue": "09:00",
        "timezone": "UTC"
    });
    let object = payload.as_object_mut().expect("canonical payload object");
    for (key, value) in overrides
        .as_object()
        .expect("runner behavior overrides object")
    {
        object.insert(key.clone(), value.clone());
    }
    parse_create(
        "session-runner-tests",
        &payload,
        1,
        Uuid::new_v4().to_string(),
    )
    .expect("build canonical automation record")
}

fn captured_args(capture: &Value) -> Vec<String> {
    capture["args"]
        .as_array()
        .expect("captured argv array")
        .iter()
        .map(|value| value.as_str().expect("captured argv string").to_string())
        .collect()
}

fn unattended_prompt(prompt: &str) -> String {
    format!(
        "You are running as a VibeLink unattended automation. Work only inside the current run workspace. Do not create, edit, pause, resume, or trigger schedules or cron jobs. Do not use messaging platforms, project/workspace switching, browser automation, interactive login, CAPTCHA, device-code authentication, or secret prompts. Do not request clarification; make a safe reasonable assumption when possible and report any blocker in the final response. Do not modify your own agent configuration, credentials, plugins, hooks, or installed skills. Never merge into, delete, or otherwise mutate the base worktree automatically.\n\nUser automation prompt:\n{}",
        prompt.trim()
    )
}

fn powershell_executable() -> PathBuf {
    let system_root = std::env::var_os("SystemRoot").expect("SystemRoot is set on Windows");
    let executable = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    assert!(
        executable.is_file(),
        "PowerShell is unavailable at {}",
        executable.display()
    );
    executable
}

fn process_is_alive(pid: u32) -> bool {
    let Ok(handle) = (unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }) else {
        return false;
    };
    let alive = unsafe { WaitForSingleObject(handle, 0) } == WAIT_TIMEOUT;
    let _ = unsafe { CloseHandle(handle) };
    alive
}

fn wait_until(timeout: Duration, condition: impl Fn() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if condition() {
            return true;
        }
        thread::sleep(Duration::from_millis(20));
    }
    condition()
}

const FAKE_HERMES_SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$remaining = @($args)
if ($remaining.Count -gt 0 -and $remaining[0] -eq '--') {
    $remaining = @($remaining | Select-Object -Skip 1)
}
$root = (Get-Location).Path
$utf8 = New-Object System.Text.UTF8Encoding($false)
$stdin = ''
if (-not [Console]::IsInputRedirected) {
    $stdin = ''
} else {
    $stdin = [Console]::In.ReadToEnd()
}
$capture = [ordered]@{
    args = @($remaining)
    maxTurns = $env:HERMES_MAX_ITERATIONS
    stdin = $stdin
}
[IO.File]::WriteAllText(
    (Join-Path $root 'capture.json'),
    ($capture | ConvertTo-Json -Compress -Depth 4),
    $utf8
)
[IO.File]::WriteAllText((Join-Path $root 'pid.txt'), [string]$PID, $utf8)
$mode = [IO.File]::ReadAllText((Join-Path $root 'mode.txt')).Trim()
$usagePath = $null
for ($index = 0; $index -lt $remaining.Count - 1; $index++) {
    if ($remaining[$index] -eq '--usage-file') {
        $usagePath = $remaining[$index + 1]
        break
    }
}
# Only Hermes passes --usage-file; other agents legitimately have none.
function Write-Usage {
    if ($null -eq $usagePath) {
        return
    }
    $usage = [ordered]@{
        inputTokens = 12
        outputTokens = 34
        totalTokens = 46
    } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($usagePath, $usage, $utf8)
}
switch ($mode) {
    'success' {
        Write-Usage
        [Console]::Out.WriteLine('{"finalResponse":"automation complete"}')
        [Console]::Error.WriteLine('fake-hermes-stderr-marker')
        exit 0
    }
    'nonzero' {
        [Console]::Error.WriteLine('intentional nonzero exit')
        exit 7
    }
    'timeout' {
        Start-Sleep -Seconds 10
        [Console]::Out.WriteLine('timeout process unexpectedly survived')
        exit 0
    }
    'interactive' {
        [Console]::Error.WriteLine('Authentication required. Run hermes auth, then open a browser to authenticate with 2FA.')
        exit 7
    }
    'truncate' {
        Write-Usage
        [Console]::Out.Write(('x' * (300 * 1024)))
        [Console]::Out.WriteLine('TRUNCATED_FINAL_RESPONSE')
        exit 0
    }
    default {
        [Console]::Error.WriteLine("unknown fake Hermes mode: $mode")
        exit 9
    }
}
"#;

use super::model::{AutomationPrecheckResult, AutomationRecord};
use std::{
    io::{self, Read},
    path::Path,
    process::{Child, Command, ExitStatus, Stdio},
    thread,
    time::{Duration, Instant},
};

const OUTPUT_LIMIT: usize = 64 * 1024;
const MAX_TIMEOUT_SECONDS: u64 = 600;
#[cfg(windows)]
const TERMINATE_WAIT_MS: u32 = 5_000;

pub fn run_precheck(record: &AutomationRecord, workspace: &Path) -> AutomationPrecheckResult {
    let started = Instant::now();
    let command = record
        .precheck
        .command
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    if record.precheck.require_workspace && !workspace.is_dir() {
        return failed(
            command,
            started,
            format!("required workspace does not exist: {}", workspace.display()),
        );
    }
    if record.precheck.require_git && (!workspace.is_dir() || !has_git_metadata(workspace)) {
        return failed(
            command,
            started,
            format!(
                "required Git worktree was not found: {}",
                workspace.display()
            ),
        );
    }
    let Some(command) = command else {
        return AutomationPrecheckResult {
            ok: true,
            command: None,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            timed_out: false,
            duration_ms: elapsed_ms(started),
            truncated: false,
            error: None,
        };
    };
    if !workspace.is_dir() {
        return failed(
            Some(command),
            started,
            format!("precheck workspace does not exist: {}", workspace.display()),
        );
    }

    let timeout = Duration::from_secs(
        u64::from(record.precheck.timeout_seconds).clamp(1, MAX_TIMEOUT_SECONDS),
    );
    match execute(&command, workspace, timeout) {
        Ok(output) => {
            let error = if output.timed_out {
                Some(format!(
                    "precheck command timed out after {} seconds",
                    timeout.as_secs()
                ))
            } else if output.status.success() {
                None
            } else {
                Some(match output.status.code() {
                    Some(code) => format!("precheck command exited with code {code}"),
                    None => "precheck command exited without an exit code".to_string(),
                })
            };
            AutomationPrecheckResult {
                ok: error.is_none(),
                command: Some(command),
                stdout: String::from_utf8_lossy(&output.stdout.bytes).into_owned(),
                stderr: String::from_utf8_lossy(&output.stderr.bytes).into_owned(),
                exit_code: output.status.code(),
                timed_out: output.timed_out,
                duration_ms: elapsed_ms(started),
                truncated: output.stdout.truncated || output.stderr.truncated,
                error,
            }
        }
        Err(error) => failed(Some(command), started, error),
    }
}

fn failed(command: Option<String>, started: Instant, error: String) -> AutomationPrecheckResult {
    AutomationPrecheckResult {
        ok: false,
        command,
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        timed_out: false,
        duration_ms: elapsed_ms(started),
        truncated: false,
        error: Some(error),
    }
}

fn elapsed_ms(started: Instant) -> u64 {
    u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX)
}

// This intentionally avoids spawning Git: requirement failures must not launch any process.
// A normal checkout has .git/HEAD; a linked worktree has a gitdir file pointing at a HEAD.
fn has_git_metadata(workspace: &Path) -> bool {
    workspace.ancestors().any(|ancestor| {
        let marker = ancestor.join(".git");
        if marker.is_dir() {
            return marker.join("HEAD").is_file();
        }
        let Ok(contents) = std::fs::read_to_string(&marker) else {
            return false;
        };
        let Some(target) = contents.trim().strip_prefix("gitdir:") else {
            return false;
        };
        let target = Path::new(target.trim());
        let target = if target.is_absolute() {
            target.to_path_buf()
        } else {
            ancestor.join(target)
        };
        target.is_dir() && target.join("HEAD").is_file()
    })
}

struct Output {
    status: ExitStatus,
    timed_out: bool,
    stdout: Capture,
    stderr: Capture,
}

#[derive(Default)]
struct Capture {
    bytes: Vec<u8>,
    truncated: bool,
}

fn execute(command: &str, workspace: &Path, timeout: Duration) -> Result<Output, String> {
    let mut child = shell(command, workspace)
        .spawn()
        .map_err(|error| format!("failed to spawn precheck command: {error}"))?;

    #[cfg(windows)]
    let mut job = Some(WindowsJob::assign(&child).map_err(|error| {
        terminate_fallback(&mut child);
        format!("failed to own precheck process tree: {error}")
    })?);

    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            #[cfg(windows)]
            terminate(&mut child, &mut job);
            #[cfg(not(windows))]
            terminate_fallback(&mut child);
            return Err("precheck stdout pipe was unavailable".to_string());
        }
    };
    let stderr = match child.stderr.take() {
        Some(stderr) => stderr,
        None => {
            #[cfg(windows)]
            terminate(&mut child, &mut job);
            #[cfg(not(windows))]
            terminate_fallback(&mut child);
            return Err("precheck stderr pipe was unavailable".to_string());
        }
    };
    let stdout_reader = match reader("vibelink-precheck-stdout", stdout) {
        Ok(reader) => reader,
        Err(error) => {
            #[cfg(windows)]
            terminate(&mut child, &mut job);
            #[cfg(not(windows))]
            terminate_fallback(&mut child);
            return Err(format!("failed to start stdout capture: {error}"));
        }
    };
    let stderr_reader = match reader("vibelink-precheck-stderr", stderr) {
        Ok(reader) => reader,
        Err(error) => {
            #[cfg(windows)]
            terminate(&mut child, &mut job);
            #[cfg(not(windows))]
            terminate_fallback(&mut child);
            let _ = stdout_reader.join();
            return Err(format!("failed to start stderr capture: {error}"));
        }
    };

    let deadline = Instant::now() + timeout;
    let (mut status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(status)) => break (Some(status), false),
            Ok(None) if Instant::now() >= deadline => break (None, true),
            Ok(None) => thread::sleep(Duration::from_millis(25)),
            Err(error) => {
                #[cfg(windows)]
                terminate(&mut child, &mut job);
                #[cfg(not(windows))]
                terminate_fallback(&mut child);
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "failed while waiting for precheck command: {error}"
                ));
            }
        }
    };

    #[cfg(windows)]
    terminate(&mut child, &mut job);
    #[cfg(not(windows))]
    if timed_out {
        terminate_fallback(&mut child);
    }
    if status.is_none() {
        status = child.wait().ok();
    }
    let stdout = join_reader(stdout_reader, "stdout")?;
    let stderr = join_reader(stderr_reader, "stderr")?;
    Ok(Output {
        status: status.ok_or_else(|| "precheck ended without an exit status".to_string())?,
        timed_out,
        stdout,
        stderr,
    })
}

#[cfg(windows)]
fn shell(command: &str, workspace: &Path) -> Command {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
    let mut shell = Command::new("powershell.exe");
    shell
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    shell
}

#[cfg(not(windows))]
fn shell(command: &str, workspace: &Path) -> Command {
    let mut shell = Command::new("sh");
    shell
        .args(["-c", command])
        .current_dir(workspace)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    shell
}

fn reader(
    name: &str,
    stream: impl Read + Send + 'static,
) -> io::Result<thread::JoinHandle<io::Result<Capture>>> {
    thread::Builder::new()
        .name(name.to_string())
        .spawn(move || capture(stream))
}

fn capture(mut stream: impl Read) -> io::Result<Capture> {
    let mut output = Capture::default();
    let mut buffer = [0; 8192];
    loop {
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            return Ok(output);
        }
        let retained = count.min(OUTPUT_LIMIT.saturating_sub(output.bytes.len()));
        output.bytes.extend_from_slice(&buffer[..retained]);
        output.truncated |= retained < count;
    }
}

fn join_reader(
    reader: thread::JoinHandle<io::Result<Capture>>,
    label: &str,
) -> Result<Capture, String> {
    match reader.join() {
        Ok(Ok(output)) => Ok(output),
        Ok(Err(error)) => Err(format!("failed to capture precheck {label}: {error}")),
        Err(_) => Err(format!("precheck {label} capture panicked")),
    }
}

fn terminate_fallback(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn terminate(child: &mut Child, job: &mut Option<WindowsJob>) {
    let owned = job
        .take()
        .is_some_and(|job| job.terminate_and_wait(child).is_ok());
    if !owned {
        terminate_fallback(child);
    }
}

#[cfg(windows)]
struct WindowsJob(WindowsOwnedHandle);

#[cfg(windows)]
impl WindowsJob {
    fn assign(child: &Child) -> Result<Self, String> {
        use std::{ffi::c_void, mem::size_of, os::windows::io::AsRawHandle};
        use windows::{
            core::PCWSTR,
            Win32::{
                Foundation::HANDLE,
                System::JobObjects::{
                    AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
                    SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
                    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
                },
            },
        };

        let handle =
            unsafe { CreateJobObjectW(None, PCWSTR::null()) }.map_err(|error| error.to_string())?;
        let job = Self(WindowsOwnedHandle(handle));
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                job.0 .0,
                JobObjectExtendedLimitInformation,
                &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|error| error.to_string())?;
        unsafe { AssignProcessToJobObject(job.0 .0, HANDLE(child.as_raw_handle())) }
            .map_err(|error| error.to_string())?;
        Ok(job)
    }

    fn terminate_and_wait(self, child: &Child) -> Result<(), String> {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::{
            Foundation::{HANDLE, WAIT_OBJECT_0},
            System::{JobObjects::TerminateJobObject, Threading::WaitForSingleObject},
        };

        unsafe { TerminateJobObject(self.0 .0, 1) }.map_err(|error| error.to_string())?;
        let wait = unsafe { WaitForSingleObject(HANDLE(child.as_raw_handle()), TERMINATE_WAIT_MS) };
        if wait != WAIT_OBJECT_0 {
            return Err("timed out waiting for the exact precheck process to exit".to_string());
        }
        Ok(())
    }
}

#[cfg(windows)]
struct WindowsOwnedHandle(windows::Win32::Foundation::HANDLE);

#[cfg(windows)]
impl Drop for WindowsOwnedHandle {
    fn drop(&mut self) {
        use windows::Win32::Foundation::CloseHandle;
        if !self.0.is_invalid() {
            let _ = unsafe { CloseHandle(self.0) };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::model::AutomationPrecheck;
    use super::*;
    use serde_json::json;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("vibelink-precheck-{}", Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn record(command: Option<String>) -> AutomationRecord {
        AutomationRecord {
            id: "a".into(),
            session_id: "s".into(),
            name: "test".into(),
            prompt: "test".into(),
            agent: "hermes".into(),
            provider: None,
            model: None,
            use_agent_default_model: true,
            toolsets: vec!["hermes-acp".into()],
            skills: vec![],
            max_turns: 20,
            timeout_seconds: 1800,
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
            worktree_storage: json!({}),
            base_ref: None,
            precheck: AutomationPrecheck {
                command,
                timeout_seconds: 5,
                require_workspace: true,
                require_git: false,
            },
            source: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[cfg(windows)]
    fn marker(path: &Path) -> String {
        format!("echo spawned>\"{}\"", path.display())
    }
    #[cfg(not(windows))]
    fn marker(path: &Path) -> String {
        format!("printf spawned > '{}'", path.display())
    }

    #[test]
    fn missing_workspace_fails_without_spawning() {
        let root = TestDir::new();
        let marker_path = root.path().join("marker");
        let result = run_precheck(
            &record(Some(marker(&marker_path))),
            &root.path().join("missing"),
        );
        assert!(!result.ok);
        assert_eq!(result.exit_code, None);
        assert!(!marker_path.exists());
    }

    #[test]
    fn require_git_fails_without_spawning() {
        let workspace = TestDir::new();
        let marker_path = workspace.path().join("marker");
        let mut automation = record(Some(marker(&marker_path)));
        automation.precheck.require_git = true;
        let result = run_precheck(&automation, workspace.path());
        assert!(!result.ok);
        assert!(result.error.as_deref().unwrap().contains("Git"));
        assert!(!marker_path.exists());
    }

    #[test]
    fn success_captures_stdout_and_stderr() {
        let workspace = TestDir::new();
        #[cfg(windows)]
        let command = "Write-Output stdout-line; [Console]::Error.WriteLine('stderr-line')";
        #[cfg(not(windows))]
        let command = "printf 'stdout-line\\n'; printf 'stderr-line\\n' >&2";
        let result = run_precheck(&record(Some(command.into())), workspace.path());
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.exit_code, Some(0));
        assert!(result.stdout.contains("stdout-line"));
        assert!(result.stderr.contains("stderr-line"));
    }

    #[test]
    fn nonzero_exit_is_structured() {
        let workspace = TestDir::new();
        #[cfg(windows)]
        let command = "[Console]::Error.WriteLine('failed'); exit 7";
        #[cfg(not(windows))]
        let command = "printf 'failed\\n' >&2; exit 7";
        let result = run_precheck(&record(Some(command.into())), workspace.path());
        assert!(!result.ok);
        assert_eq!(result.exit_code, Some(7));
        assert!(result.stderr.contains("failed"));
    }

    #[cfg(windows)]
    #[test]
    fn timeout_terminates_owned_descendant() {
        use sysinfo::{Pid, ProcessesToUpdate, System};
        let workspace = TestDir::new();
        let pid_file = workspace.path().join("child.pid");
        let path = pid_file.display().to_string().replace('\'', "''");
        let command = format!(
            "$PID | Set-Content -NoNewline -LiteralPath '{}'; Start-Sleep 30",
            path
        );
        let mut automation = record(Some(command));
        automation.precheck.timeout_seconds = 2;
        let result = run_precheck(&automation, workspace.path());
        assert!(result.timed_out);
        let pid = fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let mut system = System::new();
            system.refresh_processes(ProcessesToUpdate::All, true);
            if system.process(Pid::from_u32(pid)).is_none() {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "owned descendant survived timeout"
            );
            thread::sleep(Duration::from_millis(50));
        }
    }
}

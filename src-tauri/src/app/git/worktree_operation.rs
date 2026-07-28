use super::exec::CREATE_NO_WINDOW;
use serde::{Deserialize, Serialize};
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use thiserror::Error;
use uuid::Uuid;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

pub(crate) const GIT_READ_TIMEOUT: Duration = Duration::from_secs(30);
pub(crate) const GIT_FETCH_TIMEOUT: Duration = Duration::from_secs(120);
pub(crate) const GIT_WORKTREE_TIMEOUT: Duration = Duration::from_secs(180);
pub(crate) const GIT_SPARSE_TIMEOUT: Duration = Duration::from_secs(60);
pub(crate) const SETUP_TIMEOUT: Duration = Duration::from_secs(900);
const CHILD_POLL_INTERVAL: Duration = Duration::from_millis(25);
const CHILD_REAP_TIMEOUT: Duration = Duration::from_secs(5);
const OUTPUT_TAIL_BYTES: u64 = 64 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeCommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub current_dir: PathBuf,
    pub timeout: Duration,
    pub read_only: bool,
}

impl WorktreeCommandSpec {
    pub(crate) fn git(
        repository: impl Into<PathBuf>,
        args: impl IntoIterator<Item = impl Into<String>>,
        timeout: Duration,
        read_only: bool,
    ) -> Self {
        let repository = repository.into();
        let mut git_args = vec![
            "-C".to_string(),
            repository.to_string_lossy().to_string(),
            "-c".to_string(),
            "core.quotepath=false".to_string(),
        ];
        git_args.extend(args.into_iter().map(Into::into));
        Self {
            program: "git".to_string(),
            args: git_args,
            current_dir: repository,
            timeout,
            read_only,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCommandOutput {
    pub exit_code: Option<i32>,
    pub stdout_tail: String,
    pub stderr_tail: String,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub elapsed_millis: u64,
}

impl WorktreeCommandOutput {
    pub(crate) fn success(&self) -> bool {
        self.exit_code == Some(0)
    }
}
impl std::fmt::Display for WorktreeCommandOutput {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "exit={:?}; stdout tail={:?}; stderr tail={:?}; stdout truncated={}; stderr truncated={}",
            self.exit_code,
            self.stdout_tail,
            self.stderr_tail,
            self.stdout_truncated,
            self.stderr_truncated
        )
    }
}

#[derive(Debug, Error)]
pub(crate) enum WorktreeCommandFailure {
    #[error("worktree operation was cancelled; {output}")]
    Cancelled { output: WorktreeCommandOutput },
    #[error("command timed out after {timeout_millis} ms; {output}")]
    TimedOut {
        timeout_millis: u64,
        output: WorktreeCommandOutput,
    },
    #[error("failed to spawn command: {message}")]
    Spawn { message: String },
    #[error("command exited unsuccessfully: {message}; {output}")]
    Exit {
        message: String,
        output: WorktreeCommandOutput,
    },
}

impl WorktreeCommandFailure {
    pub(crate) fn output(&self) -> Option<&WorktreeCommandOutput> {
        match self {
            Self::Cancelled { output }
            | Self::TimedOut { output, .. }
            | Self::Exit { output, .. } => Some(output),
            Self::Spawn { .. } => None,
        }
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        matches!(self, Self::Cancelled { .. })
    }
}

pub(crate) trait WorktreeCommandRunner: Send + Sync {
    fn run(
        &self,
        spec: &WorktreeCommandSpec,
        cancellation: &WorktreeCancellation,
    ) -> Result<WorktreeCommandOutput, WorktreeCommandFailure>;
}

pub(crate) trait WorktreeClock: Send + Sync {
    fn now(&self) -> Duration;
    fn sleep(&self, duration: Duration);
}

#[derive(Debug)]
pub(crate) struct MonotonicWorktreeClock {
    origin: Instant,
}

impl Default for MonotonicWorktreeClock {
    fn default() -> Self {
        Self {
            origin: Instant::now(),
        }
    }
}

impl WorktreeClock for MonotonicWorktreeClock {
    fn now(&self) -> Duration {
        self.origin.elapsed()
    }

    fn sleep(&self, duration: Duration) {
        std::thread::sleep(duration);
    }
}

#[derive(Clone, Debug, Default)]
pub(crate) struct WorktreeCancellation {
    cancelled: Arc<AtomicBool>,
}

impl WorktreeCancellation {
    pub(crate) fn from_flag(cancelled: Arc<AtomicBool>) -> Self {
        Self { cancelled }
    }

    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    pub(crate) fn check(&self) -> Result<(), WorktreeCommandFailure> {
        if self.is_cancelled() {
            Err(WorktreeCommandFailure::Cancelled {
                output: WorktreeCommandOutput::default(),
            })
        } else {
            Ok(())
        }
    }
}

pub(crate) struct NativeWorktreeCommandRunner {
    clock: Arc<dyn WorktreeClock>,
}

impl Default for NativeWorktreeCommandRunner {
    fn default() -> Self {
        Self {
            clock: Arc::new(MonotonicWorktreeClock::default()),
        }
    }
}

impl NativeWorktreeCommandRunner {
    #[cfg(test)]
    pub(crate) fn with_clock(clock: Arc<dyn WorktreeClock>) -> Self {
        Self { clock }
    }
}

impl WorktreeCommandRunner for NativeWorktreeCommandRunner {
    fn run(
        &self,
        spec: &WorktreeCommandSpec,
        cancellation: &WorktreeCancellation,
    ) -> Result<WorktreeCommandOutput, WorktreeCommandFailure> {
        cancellation.check()?;
        let stdout_path = operation_temp_path("stdout");
        let stderr_path = operation_temp_path("stderr");
        let stdout = create_temp_output(&stdout_path)?;
        let stderr = match create_temp_output(&stderr_path) {
            Ok(file) => file,
            Err(error) => {
                let _ = std::fs::remove_file(&stdout_path);
                return Err(error);
            }
        };

        let started = self.clock.now();
        let mut command = Command::new(&spec.program);
        command
            .args(&spec.args)
            .current_dir(&spec.current_dir)
            .env("GIT_TERMINAL_PROMPT", "0")
            .stdin(Stdio::null())
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr));
        if spec.read_only {
            command.env("GIT_OPTIONAL_LOCKS", "0");
        }
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                cleanup_temp_outputs(&stdout_path, &stderr_path);
                return Err(WorktreeCommandFailure::Spawn {
                    message: error.to_string(),
                });
            }
        };

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    let output = collect_output(
                        &stdout_path,
                        &stderr_path,
                        status.code(),
                        self.clock.now().saturating_sub(started),
                    );
                    cleanup_temp_outputs(&stdout_path, &stderr_path);
                    let output = output?;
                    if status.success() {
                        return Ok(output);
                    }
                    let message = failure_message(&output);
                    return Err(WorktreeCommandFailure::Exit { message, output });
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = terminate_and_reap_exact_child(child, self.clock.as_ref());
                    cleanup_temp_outputs(&stdout_path, &stderr_path);
                    return Err(WorktreeCommandFailure::Spawn {
                        message: format!("failed to query child status: {error}"),
                    });
                }
            }

            if cancellation.is_cancelled() {
                let code = match terminate_and_reap_exact_child(child, self.clock.as_ref()) {
                    Ok(code) => code,
                    Err(error) => {
                        cleanup_temp_outputs(&stdout_path, &stderr_path);
                        return Err(error);
                    }
                };
                let output = collect_output(
                    &stdout_path,
                    &stderr_path,
                    code,
                    self.clock.now().saturating_sub(started),
                );
                cleanup_temp_outputs(&stdout_path, &stderr_path);
                return Err(WorktreeCommandFailure::Cancelled { output: output? });
            }
            if self.clock.now().saturating_sub(started) >= spec.timeout {
                let code = match terminate_and_reap_exact_child(child, self.clock.as_ref()) {
                    Ok(code) => code,
                    Err(error) => {
                        cleanup_temp_outputs(&stdout_path, &stderr_path);
                        return Err(error);
                    }
                };
                let output = collect_output(
                    &stdout_path,
                    &stderr_path,
                    code,
                    self.clock.now().saturating_sub(started),
                );
                cleanup_temp_outputs(&stdout_path, &stderr_path);
                return Err(WorktreeCommandFailure::TimedOut {
                    timeout_millis: duration_millis(spec.timeout),
                    output: output?,
                });
            }
            self.clock.sleep(CHILD_POLL_INTERVAL);
        }
    }
}

fn create_temp_output(path: &Path) -> Result<File, WorktreeCommandFailure> {
    OpenOptions::new()
        .create_new(true)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| WorktreeCommandFailure::Spawn {
            message: format!("create operation output file {}: {error}", path.display()),
        })
}

fn operation_temp_path(kind: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "vibelink-worktree-{}-{kind}.tmp",
        Uuid::new_v4().simple()
    ))
}

fn terminate_and_reap_exact_child(
    mut child: Child,
    clock: &dyn WorktreeClock,
) -> Result<Option<i32>, WorktreeCommandFailure> {
    let _ = child.kill();
    let deadline = clock.now().saturating_add(CHILD_REAP_TIMEOUT);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.code()),
            Ok(None) if clock.now() < deadline => clock.sleep(CHILD_POLL_INTERVAL),
            Ok(None) => {
                return Err(WorktreeCommandFailure::Spawn {
                    message: "exact child did not exit within the bounded reap timeout".to_string(),
                })
            }
            Err(error) => {
                return Err(WorktreeCommandFailure::Spawn {
                    message: format!("failed to reap exact child: {error}"),
                })
            }
        }
    }
}

fn collect_output(
    stdout_path: &Path,
    stderr_path: &Path,
    exit_code: Option<i32>,
    elapsed: Duration,
) -> Result<WorktreeCommandOutput, WorktreeCommandFailure> {
    let (stdout_tail, stdout_truncated) = read_bounded_tail(stdout_path)?;
    let (stderr_tail, stderr_truncated) = read_bounded_tail(stderr_path)?;
    Ok(WorktreeCommandOutput {
        exit_code,
        stdout_tail,
        stderr_tail,
        stdout_truncated,
        stderr_truncated,
        elapsed_millis: duration_millis(elapsed),
    })
}

fn read_bounded_tail(path: &Path) -> Result<(String, bool), WorktreeCommandFailure> {
    let mut file = File::open(path).map_err(|error| WorktreeCommandFailure::Spawn {
        message: format!("open operation output file {}: {error}", path.display()),
    })?;
    let length = file
        .metadata()
        .map_err(|error| WorktreeCommandFailure::Spawn {
            message: format!("stat operation output file {}: {error}", path.display()),
        })?
        .len();
    let truncated = length > OUTPUT_TAIL_BYTES;
    if truncated {
        file.seek(SeekFrom::Start(length - OUTPUT_TAIL_BYTES))
            .map_err(|error| WorktreeCommandFailure::Spawn {
                message: format!("seek operation output file {}: {error}", path.display()),
            })?;
    }
    let mut bytes = Vec::with_capacity(length.min(OUTPUT_TAIL_BYTES) as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| WorktreeCommandFailure::Spawn {
            message: format!("read operation output file {}: {error}", path.display()),
        })?;
    Ok((String::from_utf8_lossy(&bytes).into_owned(), truncated))
}

fn failure_message(output: &WorktreeCommandOutput) -> String {
    let stderr = output.stderr_tail.trim();
    if !stderr.is_empty() {
        stderr.to_string()
    } else {
        format!("exit code {:?}", output.exit_code)
    }
}

fn cleanup_temp_outputs(stdout: &Path, stderr: &Path) {
    let _ = std::fs::remove_file(stdout);
    let _ = std::fs::remove_file(stderr);
}

fn duration_millis(duration: Duration) -> u64 {
    duration.as_millis().min(u64::MAX as u128) as u64
}

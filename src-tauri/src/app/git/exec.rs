use anyhow::{anyhow, bail, Result};
use std::collections::HashMap;
use std::ffi::OsStr;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Output, Stdio};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::Duration;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
pub(crate) const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const MAX_GIT_STDIN_BYTES: usize = 8 * 1024 * 1024;

pub(crate) static REPO_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

pub(crate) fn git_read<I, S>(repo: &str, args: I) -> Result<Vec<u8>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_command(repo, args, true).output()?;
    output_stdout(output)
}

pub(crate) fn git_read_allow_fail<I, S>(repo: &str, args: I) -> Result<Option<Vec<u8>>>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let output = git_command(repo, args, true).output()?;
    if output.status.success() {
        Ok(Some(output.stdout))
    } else {
        Ok(None)
    }
}

pub(crate) fn git_read_output<I, S>(repo: &str, args: I) -> Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Ok(git_command(repo, args, true).output()?)
}

pub(crate) fn git_exit_status<I, S>(repo: &str, args: I) -> Result<ExitStatus>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    Ok(git_command(repo, args, true).status()?)
}

pub(crate) fn git_write<I, S>(repo: &str, args: I) -> Result<Vec<u8>>
where
    I: IntoIterator<Item = S> + Clone,
    S: AsRef<OsStr>,
{
    let output = git_write_output(repo, args)?;
    output_stdout(output)
}

pub(crate) fn git_write_output<I, S>(repo: &str, args: I) -> Result<Output>
where
    I: IntoIterator<Item = S> + Clone,
    S: AsRef<OsStr>,
{
    git_write_output_with_env(repo, args, &[])
}

pub(crate) fn git_write_stdin<I, S>(repo: &str, args: I, input: &[u8]) -> Result<Output>
where
    I: IntoIterator<Item = S> + Clone,
    S: AsRef<OsStr>,
{
    if input.len() > MAX_GIT_STDIN_BYTES {
        bail!("git stdin payload exceeds {MAX_GIT_STDIN_BYTES} bytes")
    }
    let lock = repo_lock(repo);
    let _guard = lock
        .lock()
        .map_err(|_| anyhow!("git repository mutation lock is poisoned"))?;
    let mut output = run_write_stdin(repo, args.clone(), input)?;
    if !output.status.success() && String::from_utf8_lossy(&output.stderr).contains("index.lock") {
        std::thread::sleep(Duration::from_millis(200));
        output = run_write_stdin(repo, args, input)?;
    }
    Ok(output)
}

pub(crate) fn git_write_output_with_env<I, S>(
    repo: &str,
    args: I,
    env: &[(&str, &str)],
) -> Result<Output>
where
    I: IntoIterator<Item = S> + Clone,
    S: AsRef<OsStr>,
{
    let lock = repo_lock(repo);
    let _guard = lock
        .lock()
        .map_err(|_| anyhow!("git repository mutation lock is poisoned"))?;

    let mut output = run_write(repo, args.clone(), env)?;
    if !output.status.success() && String::from_utf8_lossy(&output.stderr).contains("index.lock") {
        std::thread::sleep(Duration::from_millis(200));
        output = run_write(repo, args, env)?;
    }
    Ok(output)
}

pub(crate) fn git_command<I, S>(repo: &str, args: I, read_only: bool) -> Command
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(repo)
        .arg("-c")
        .arg("core.quotepath=false")
        .env("GIT_TERMINAL_PROMPT", "0");
    if read_only {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    command.args(args);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

pub(crate) fn stderr_or_status(output: &Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        stderr
    }
}

pub(crate) fn ensure_success(output: Output) -> Result<Vec<u8>> {
    output_stdout(output)
}

fn run_write_stdin<I, S>(repo: &str, args: I, input: &[u8]) -> Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = git_command(repo, args, false);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn()?;
    child
        .stdin
        .take()
        .ok_or_else(|| anyhow!("git stdin unavailable"))?
        .write_all(input)?;
    Ok(child.wait_with_output()?)
}

fn run_write<I, S>(repo: &str, args: I, env: &[(&str, &str)]) -> Result<Output>
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut command = git_command(repo, args, false);
    command.envs(env.iter().copied());
    Ok(command.output()?)
}

fn output_stdout(output: Output) -> Result<Vec<u8>> {
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(anyhow!(stderr_or_status(&output)))
    }
}

fn repo_lock(repo: &str) -> Arc<Mutex<()>> {
    let key = Path::new(repo)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(repo));
    let mut locks = REPO_LOCKS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    #[test]
    fn repository_lock_serializes_mutations() {
        let repo = std::env::temp_dir().join(format!("vibelink-lock-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&repo).expect("create repo");
        let repo_string = repo.to_string_lossy().to_string();
        let first = repo_lock(&repo_string);
        let guard = first.lock().expect("lock repo");
        let (tx, rx) = mpsc::channel();
        let thread_repo = repo_string.clone();
        let started = Instant::now();
        let thread = std::thread::spawn(move || {
            let lock = repo_lock(&thread_repo);
            let _guard = lock.lock().expect("lock repo in thread");
            tx.send(started.elapsed()).expect("send elapsed");
        });
        std::thread::sleep(Duration::from_millis(100));
        assert!(rx.try_recv().is_err());
        drop(guard);
        assert!(rx.recv().expect("receive elapsed") >= Duration::from_millis(100));
        thread.join().expect("join thread");
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }
}

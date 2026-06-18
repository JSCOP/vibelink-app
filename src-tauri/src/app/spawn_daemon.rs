use crate::{
    daemon::paths,
    protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, Req},
};
use anyhow::{anyhow, bail, Context, Result};
use interprocess::{
    local_socket::{prelude::*, GenericNamespaced, Name},
    ConnectWaitMode,
};
use std::{
    fs,
    io::{self, Read, Write},
    path::Path,
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

pub type DaemonStream = LocalSocketStream;

const STARTUP_PING_REQ: Req = 0;
const STARTUP_PING_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const DAEMON_STARTUP_TIMEOUT: Duration = Duration::from_secs(5);
const DAEMON_READY_DELAY: Duration = Duration::from_millis(100);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum StartupAttemptErrorKind {
    Connect,
    Unhealthy,
}

#[derive(Debug)]
struct StartupAttemptError {
    kind: StartupAttemptErrorKind,
    message: String,
}

impl StartupAttemptError {
    fn connect(err: anyhow::Error) -> Self {
        Self {
            kind: StartupAttemptErrorKind::Connect,
            message: err.to_string(),
        }
    }

    fn unhealthy(err: anyhow::Error) -> Self {
        Self {
            kind: StartupAttemptErrorKind::Unhealthy,
            message: err.to_string(),
        }
    }

    fn should_recover_stale_daemon(&self) -> bool {
        self.kind == StartupAttemptErrorKind::Unhealthy
    }
}

impl std::fmt::Display for StartupAttemptError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub fn ensure_daemon() -> Result<DaemonStream> {
    let mut last_error = match connect_ready_daemon() {
        Ok(stream) => return Ok(stream),
        Err(err) => {
            if should_recover_stale_daemon(&err, false, false) {
                let _ = recover_recorded_stale_daemon()?;
            }
            Some(err.to_string())
        }
    };

    let mut spawned_daemon = Some(spawn_daemon_process()?);

    let deadline = Instant::now() + DAEMON_STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        match connect_ready_daemon() {
            Ok(stream) => return Ok(stream),
            Err(err) => {
                let should_retry = should_retry_startup_attempt(&err, true);
                last_error = Some(err.to_string());
                if !should_retry {
                    break;
                }
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                thread::sleep(DAEMON_READY_DELAY.min(remaining));
            }
        }
    }

    if let Some(mut child) = spawned_daemon.take() {
        let child_pid = child.id();
        terminate_spawned_daemon(&mut child);
        if let Ok(daemon_paths) = paths::daemon_paths() {
            let _ = remove_pid_file_if_matching(&daemon_paths.pid, child_pid);
        }
    }

    Err(anyhow!(
        "daemon did not become ready within {}ms after startup ping: {}",
        DAEMON_STARTUP_TIMEOUT.as_millis(),
        last_error.unwrap_or_else(|| "no connection attempt was made".to_string())
    ))
}

pub fn connect_daemon() -> io::Result<DaemonStream> {
    connect_daemon_with_timeout(socket_name()?, STARTUP_CONNECT_TIMEOUT)
}

fn connect_daemon_with_timeout(name: Name<'static>, timeout: Duration) -> io::Result<DaemonStream> {
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("awt-daemon-connect".to_string())
        .spawn(move || {
            let result = interprocess::local_socket::ConnectOptions::new()
                .name(name)
                .wait_mode(ConnectWaitMode::Timeout(timeout))
                .connect_sync();
            let _ = tx.send(result);
        })
        .map_err(|err| io::Error::new(err.kind(), format!("spawn daemon connector: {err}")))?;

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            format!("daemon connect timed out after {}ms", timeout.as_millis()),
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => Err(io::Error::new(
            io::ErrorKind::ConnectionAborted,
            "daemon connector stopped before returning a stream",
        )),
    }
}

fn connect_ready_daemon() -> std::result::Result<DaemonStream, StartupAttemptError> {
    let stream = connect_daemon()
        .context("connect daemon")
        .map_err(StartupAttemptError::connect)?;
    probe_daemon(stream)
        .context("probe daemon startup ping")
        .map_err(StartupAttemptError::unhealthy)
}

fn probe_daemon(stream: DaemonStream) -> Result<DaemonStream> {
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("awt-daemon-probe".to_string())
        .spawn(move || {
            let mut stream = stream;
            let result = ping_daemon_io(&mut stream).map(|()| stream);
            let _ = tx.send(result);
        })
        .context("spawn daemon startup probe")?;

    match rx.recv_timeout(STARTUP_PING_TIMEOUT) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => bail!(
            "daemon startup ping timed out after {}ms",
            STARTUP_PING_TIMEOUT.as_millis()
        ),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            bail!("daemon startup probe stopped before returning a stream")
        }
    }
}

fn ping_daemon_io<S>(stream: &mut S) -> Result<()>
where
    S: Read + Write,
{
    write_frame(
        stream,
        &ClientToDaemon::Ping {
            req: STARTUP_PING_REQ,
        },
    )
    .context("write startup ping")?;
    match read_frame::<_, DaemonToClient>(stream).context("read startup pong")? {
        DaemonToClient::Pong { req } if req == STARTUP_PING_REQ => Ok(()),
        DaemonToClient::Error { message, .. } => bail!("daemon rejected startup ping: {message}"),
        other => bail!("unexpected startup ping response: {other:?}"),
    }
}

fn should_recover_stale_daemon(
    err: &StartupAttemptError,
    daemon_spawned_by_this_startup: bool,
    already_recovered: bool,
) -> bool {
    err.should_recover_stale_daemon() && !daemon_spawned_by_this_startup && !already_recovered
}

fn should_retry_startup_attempt(
    err: &StartupAttemptError,
    daemon_spawned_by_this_startup: bool,
) -> bool {
    match err.kind {
        StartupAttemptErrorKind::Connect => true,
        StartupAttemptErrorKind::Unhealthy => daemon_spawned_by_this_startup,
    }
}

pub fn socket_name() -> io::Result<Name<'static>> {
    paths::socket_name_string().to_ns_name::<GenericNamespaced>()
}

pub fn shutdown_daemon() -> Result<bool> {
    let daemon_paths = paths::daemon_paths()?;

    // Try graceful shutdown via protocol message first.
    if graceful_shutdown(&daemon_paths.pid)? {
        return Ok(true);
    }

    // Fall back to forceful termination.
    shutdown_daemon_from_pid_file(&daemon_paths.pid)
}

const SHUTDOWN_REQ: Req = u64::MAX;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

fn graceful_shutdown(pid_path: &Path) -> Result<bool> {
    // Only attempt if daemon is running.
    if read_daemon_pid(pid_path)?.is_none() {
        return Ok(false);
    }

    let stream = match connect_daemon() {
        Ok(stream) => stream,
        Err(_) => return Ok(false),
    };

    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("awt-shutdown".to_string())
        .spawn(move || {
            let mut stream = stream;
            let result = (|| -> Result<()> {
                write_frame(&mut stream, &ClientToDaemon::Shutdown { req: SHUTDOWN_REQ })?;
                match read_frame::<_, DaemonToClient>(&mut stream)? {
                    DaemonToClient::Reply { req, .. } if req == SHUTDOWN_REQ => Ok(()),
                    DaemonToClient::Error { message, .. } => bail!("shutdown rejected: {message}"),
                    _ => bail!("unexpected shutdown response"),
                }
            })();
            let _ = tx.send(result);
        })?;

    match rx.recv_timeout(SHUTDOWN_TIMEOUT) {
        Ok(Ok(())) => {
            let _ = fs::remove_file(pid_path);
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn shutdown_daemon_from_pid_file(path: &Path) -> Result<bool> {
    let Some(pid) = read_daemon_pid(path)? else {
        return Ok(false);
    };

    terminate_daemon_pid(pid).with_context(|| format!("terminate daemon pid {pid}"))?;
    let _ = fs::remove_file(path);
    thread::sleep(DAEMON_READY_DELAY);
    Ok(true)
}

fn recover_recorded_stale_daemon() -> Result<bool> {
    let daemon_paths = paths::daemon_paths()?;
    shutdown_daemon_from_pid_file(&daemon_paths.pid)
}

fn read_daemon_pid(path: &Path) -> Result<Option<u32>> {
    match fs::read_to_string(path) {
        Ok(contents) => parse_daemon_pid(&contents),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(err).with_context(|| format!("read daemon pid file {}", path.display())),
    }
}

fn parse_daemon_pid(contents: &str) -> Result<Option<u32>> {
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    let pid = trimmed
        .parse::<u32>()
        .with_context(|| format!("invalid daemon pid {trimmed:?}"))?;
    if pid == 0 {
        bail!("invalid daemon pid 0");
    }
    Ok(Some(pid))
}

#[cfg(windows)]
fn terminate_daemon_pid(pid: u32) -> Result<()> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("run taskkill for stale daemon")?;
    if status.success() {
        Ok(())
    } else {
        bail!("taskkill exited with {status}");
    }
}

#[cfg(not(windows))]
fn terminate_daemon_pid(pid: u32) -> Result<()> {
    let status = Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("run kill for stale daemon")?;
    if status.success() {
        Ok(())
    } else {
        bail!("kill exited with {status}");
    }
}

fn spawn_daemon_process() -> Result<Child> {
    match spawn_configured_daemon(true) {
        Ok(child) => Ok(child),
        Err(err) if should_retry_without_breakaway(&err) => spawn_configured_daemon(false),
        Err(err) => Err(err),
    }
}

fn terminate_spawned_daemon(child: &mut Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn remove_pid_file_if_matching(path: &Path, pid: u32) -> Result<bool> {
    let Some(recorded_pid) = read_daemon_pid(path)? else {
        return Ok(false);
    };
    if recorded_pid != pid {
        return Ok(false);
    }
    fs::remove_file(path)
        .with_context(|| format!("remove stale daemon pid file {}", path.display()))?;
    Ok(true)
}

fn spawn_configured_daemon(include_breakaway: bool) -> Result<Child> {
    let exe = std::env::current_exe().context("resolve current executable")?;
    let mut command = Command::new(exe);
    command
        .arg("--daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    configure_detached(&mut command, include_breakaway);
    command.spawn().context("spawn detached daemon")
}

#[cfg(windows)]
fn should_retry_without_breakaway(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        cause
            .downcast_ref::<io::Error>()
            .is_some_and(|err| err.kind() == io::ErrorKind::PermissionDenied)
    })
}

#[cfg(not(windows))]
fn should_retry_without_breakaway(_err: &anyhow::Error) -> bool {
    false
}

#[cfg(windows)]
fn configure_detached(command: &mut Command, include_breakaway: bool) {
    use std::os::windows::process::CommandExt;
    command.creation_flags(windows_creation_flags(include_breakaway));
}

#[cfg(not(windows))]
fn configure_detached(command: &mut Command, _include_breakaway: bool) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
pub(crate) const fn windows_creation_flags(include_breakaway: bool) -> u32 {
    let base = 0x0800_0000 | 0x0000_0008 | 0x0000_0200;
    if include_breakaway {
        base | 0x0100_0000
    } else {
        base
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{read_frame, write_frame};
    use std::io::{Cursor, Read, Result as IoResult, Write};

    struct ScriptedStream {
        read: Cursor<Vec<u8>>,
        written: Vec<u8>,
    }

    impl ScriptedStream {
        fn with_response(response: DaemonToClient) -> Self {
            let mut read_bytes = Vec::new();
            write_frame(&mut read_bytes, &response).expect("encode scripted response");
            Self {
                read: Cursor::new(read_bytes),
                written: Vec::new(),
            }
        }

        fn written_message(&self) -> ClientToDaemon {
            read_frame(&mut Cursor::new(self.written.clone())).expect("decode written request")
        }
    }

    impl Read for ScriptedStream {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            self.read.read(buf)
        }
    }

    impl Write for ScriptedStream {
        fn write(&mut self, buf: &[u8]) -> IoResult<usize> {
            self.written.extend_from_slice(buf);
            Ok(buf.len())
        }

        fn flush(&mut self) -> IoResult<()> {
            Ok(())
        }
    }

    #[test]
    fn ping_probe_writes_ping_and_requires_matching_pong() {
        let mut stream = ScriptedStream::with_response(DaemonToClient::Pong {
            req: STARTUP_PING_REQ,
        });

        ping_daemon_io(&mut stream).expect("matching pong should pass startup probe");

        assert_eq!(
            stream.written_message(),
            ClientToDaemon::Ping {
                req: STARTUP_PING_REQ
            }
        );
    }

    #[test]
    fn ping_probe_rejects_non_matching_response() {
        let mut stream = ScriptedStream::with_response(DaemonToClient::Pong {
            req: STARTUP_PING_REQ + 1,
        });

        let err =
            ping_daemon_io(&mut stream).expect_err("mismatched pong must reject stale daemon");

        assert!(err.to_string().contains("unexpected startup ping response"));
    }

    #[cfg(windows)]
    #[test]
    fn windows_detached_flags_match_process_contract() {
        assert_eq!(
            windows_creation_flags(true),
            0x0800_0000 | 0x0000_0008 | 0x0000_0200 | 0x0100_0000
        );
        assert_eq!(
            windows_creation_flags(false),
            0x0800_0000 | 0x0000_0008 | 0x0000_0200
        );
    }

    #[cfg(windows)]
    #[test]
    fn breakaway_fallback_is_limited_to_permission_denied() {
        let denied: anyhow::Result<()> = Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "job does not allow breakaway",
        ))
        .context("spawn detached daemon");
        let not_found = anyhow::Error::new(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "missing exe",
        ));

        let denied = denied.expect_err("permission denied error");

        assert!(should_retry_without_breakaway(&denied));
        assert!(!should_retry_without_breakaway(&not_found));
    }

    #[test]
    fn parse_daemon_pid_accepts_trimmed_positive_pid() {
        assert_eq!(parse_daemon_pid(" 42\n").expect("parse pid"), Some(42));
        assert_eq!(parse_daemon_pid("\n").expect("empty pid"), None);
    }

    #[test]
    fn parse_daemon_pid_rejects_zero_and_invalid_values() {
        assert!(parse_daemon_pid("0").is_err());
        assert!(parse_daemon_pid("not-a-pid").is_err());
    }

    #[test]
    fn shutdown_missing_pid_file_is_noop() {
        let path = std::env::temp_dir().join(format!(
            "awt-missing-daemon-{}-{}.pid",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));

        assert!(!shutdown_daemon_from_pid_file(&path).expect("missing pid is ok"));
    }

    #[test]
    fn stale_recovery_is_limited_to_unhealthy_existing_daemon() {
        let connect_error = StartupAttemptError::connect(anyhow!("connect failed"));
        let unhealthy_error = StartupAttemptError::unhealthy(anyhow!("probe failed"));

        assert!(!connect_error.should_recover_stale_daemon());
        assert!(unhealthy_error.should_recover_stale_daemon());
    }

    #[test]
    fn spawned_daemon_cleanup_removes_only_matching_pid_file() {
        let path = std::env::temp_dir().join(format!(
            "awt-spawned-daemon-{}-{}.pid",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::write(&path, "42").expect("write pid");

        assert!(!remove_pid_file_if_matching(&path, 7).expect("non-matching pid check"));
        assert!(path.exists());
        assert!(remove_pid_file_if_matching(&path, 42).expect("matching pid check"));
        assert!(!path.exists());
    }

    #[test]
    fn stale_recovery_does_not_kill_daemon_spawned_by_current_startup() {
        let unhealthy_error = StartupAttemptError::unhealthy(anyhow!("probe failed"));

        assert!(should_recover_stale_daemon(&unhealthy_error, false, false));
        assert!(!should_recover_stale_daemon(&unhealthy_error, true, false));
        assert!(!should_recover_stale_daemon(&unhealthy_error, false, true));
    }

    #[test]
    fn unhealthy_probe_after_spawn_keeps_retrying_until_deadline() {
        let unhealthy_error = StartupAttemptError::unhealthy(anyhow!("probe timed out"));

        assert!(should_retry_startup_attempt(&unhealthy_error, true));
        assert!(!should_retry_startup_attempt(&unhealthy_error, false));
    }

    #[test]
    fn socket_name_converts_to_namespaced_socket_name() {
        let name = socket_name().expect("namespaced socket name");

        assert!(format!("{name:?}").contains("awt-daemon"));
    }
}

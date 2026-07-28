use crate::{
    daemon::paths,
    protocol::{
        daemon_auth_proof, read_frame, write_frame, ClientKind, ClientToDaemon, DaemonToClient,
        Req, DAEMON_AUTH_REQUIRED, DAEMON_PROTOCOL_MISMATCH, DAEMON_PROTOCOL_VERSION,
    },
};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use interprocess::{
    local_socket::{prelude::*, GenericNamespaced, Name},
    ConnectWaitMode,
};
use keyring::Entry;
use rand::{rngs::OsRng, RngCore};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

pub type DaemonStream = LocalSocketStream;
const IPC_SECRET_LEN: usize = 32;
const IPC_SECRET_ACCOUNT: &str = "daemon-ipc-secret-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AuthenticatedDaemon {
    pub policy_epoch: u64,
    pub lease_until_unix_ms: i64,
}

fn ipc_secret_service() -> &'static str {
    if paths::app_flavor() == "dev" {
        "com.vibelink.desktop.dev.daemon-ipc"
    } else {
        "com.vibelink.desktop.daemon-ipc"
    }
}

fn ipc_secret_entry() -> Result<Entry> {
    Entry::new(ipc_secret_service(), IPC_SECRET_ACCOUNT)
        .context("open daemon IPC secret in Windows Credential Manager")
}

pub(crate) fn load_or_create_ipc_secret() -> Result<[u8; IPC_SECRET_LEN]> {
    let entry = ipc_secret_entry()?;
    match entry.get_password() {
        Ok(encoded) => decode_ipc_secret(&encoded),
        Err(keyring::Error::NoEntry) => {
            let mut secret = [0_u8; IPC_SECRET_LEN];
            OsRng.fill_bytes(&mut secret);
            entry
                .set_password(&URL_SAFE_NO_PAD.encode(secret))
                .context("store daemon IPC secret in Windows Credential Manager")?;
            Ok(secret)
        }
        Err(error) => {
            Err(anyhow!(error).context("load daemon IPC secret from Windows Credential Manager"))
        }
    }
}

pub(crate) fn load_ipc_secret() -> Result<[u8; IPC_SECRET_LEN]> {
    let encoded = ipc_secret_entry()?
        .get_password()
        .context("load daemon IPC secret from Windows Credential Manager")?;
    decode_ipc_secret(&encoded)
}

fn decode_ipc_secret(encoded: &str) -> Result<[u8; IPC_SECRET_LEN]> {
    let decoded = URL_SAFE_NO_PAD
        .decode(encoded)
        .context("decode daemon IPC secret")?;
    decoded
        .try_into()
        .map_err(|value: Vec<u8>| anyhow!("invalid daemon IPC secret length {}", value.len()))
}
pub fn authenticate_daemon_stream<S: Read + Write>(
    stream: &mut S,
    client_kind: ClientKind,
    secret: &[u8; IPC_SECRET_LEN],
) -> Result<AuthenticatedDaemon> {
    authenticate_daemon_stream_with_client_id(stream, client_kind, secret, Uuid::new_v4())
}

fn authenticate_daemon_stream_with_client_id<S: Read + Write>(
    stream: &mut S,
    client_kind: ClientKind,
    secret: &[u8; IPC_SECRET_LEN],
    client_id: Uuid,
) -> Result<AuthenticatedDaemon> {
    write_frame(
        stream,
        &ClientToDaemon::Hello {
            protocol_version: DAEMON_PROTOCOL_VERSION,
            client_id,
            client_kind,
        },
    )
    .context("write daemon hello")?;
    let (boot_id, nonce, expires_at_unix_ms) = match read_frame::<_, DaemonToClient>(stream)
        .context("read daemon challenge")?
    {
        DaemonToClient::Challenge {
            protocol_version,
            boot_id,
            nonce,
            expires_at_unix_ms,
        } if protocol_version == DAEMON_PROTOCOL_VERSION => (boot_id, nonce, expires_at_unix_ms),
        DaemonToClient::Challenge { .. } => bail!(DAEMON_PROTOCOL_MISMATCH),
        DaemonToClient::Error { message, .. } => bail!(message),
        other => bail!("unexpected daemon challenge response: {other:?}"),
    };
    let now_unix_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;
    if now_unix_ms > expires_at_unix_ms {
        bail!(DAEMON_AUTH_REQUIRED);
    }
    let proof = daemon_auth_proof(
        secret,
        DAEMON_PROTOCOL_VERSION,
        boot_id,
        &nonce,
        client_id,
        client_kind,
    );
    write_frame(stream, &ClientToDaemon::Authenticate { client_id, proof })
        .context("write daemon authentication")?;
    match read_frame::<_, DaemonToClient>(stream).context("read daemon authentication result")? {
        DaemonToClient::Authenticated {
            policy_epoch,
            lease_until_unix_ms,
        } => Ok(AuthenticatedDaemon {
            policy_epoch,
            lease_until_unix_ms,
        }),
        DaemonToClient::Error { message, .. } => bail!(message),
        other => bail!("unexpected daemon authentication response: {other:?}"),
    }
}

const STARTUP_PING_REQ: Req = 0;
const STARTUP_PING_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_AUTH_TIMEOUT: Duration = Duration::from_secs(2);
const STARTUP_CONNECT_TIMEOUT: Duration = Duration::from_millis(500);
const DAEMON_STARTUP_TIMEOUT: Duration = Duration::from_secs(15);
const DAEMON_READY_DELAY: Duration = Duration::from_millis(100);
const RECORDED_UNHEALTHY_RECOVERY_DELAY: Duration = Duration::from_secs(3);
#[cfg(windows)]
const DAEMON_BIN_DIR: &str = "daemon-bin";
#[cfg(windows)]
const DAEMON_EXE_PREFIX: &str = "app-daemon";
enum SpawnedDaemon {
    Standard(Child),
    #[cfg(windows)]
    Reparented(ReparentedDaemon),
}

impl SpawnedDaemon {
    fn id(&self) -> u32 {
        match self {
            Self::Standard(child) => child.id(),
            #[cfg(windows)]
            Self::Reparented(child) => child.pid,
        }
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        match self {
            Self::Standard(child) => child.try_wait(),
            #[cfg(windows)]
            Self::Reparented(child) => child.try_wait(),
        }
    }

    fn kill(&mut self) -> io::Result<()> {
        match self {
            Self::Standard(child) => child.kill(),
            #[cfg(windows)]
            Self::Reparented(child) => child.kill(),
        }
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        match self {
            Self::Standard(child) => child.wait(),
            #[cfg(windows)]
            Self::Reparented(child) => child.wait(),
        }
    }
}

#[cfg(windows)]
struct ReparentedDaemon {
    process: windows_sys::Win32::Foundation::HANDLE,
    pid: u32,
}

#[cfg(windows)]
impl ReparentedDaemon {
    fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        use std::os::windows::process::ExitStatusExt;
        use windows_sys::Win32::{
            Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::{GetExitCodeProcess, WaitForSingleObject},
        };

        match unsafe { WaitForSingleObject(self.process, 0) } {
            WAIT_TIMEOUT => Ok(None),
            WAIT_OBJECT_0 => {
                let mut code = 0;
                if unsafe { GetExitCodeProcess(self.process, &mut code) } == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some(ExitStatus::from_raw(code)))
            }
            _ => Err(io::Error::last_os_error()),
        }
    }

    fn kill(&self) -> io::Result<()> {
        if unsafe { windows_sys::Win32::System::Threading::TerminateProcess(self.process, 1) } == 0
        {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn wait(&self) -> io::Result<ExitStatus> {
        use std::os::windows::process::ExitStatusExt;
        use windows_sys::Win32::{
            Foundation::WAIT_OBJECT_0,
            System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE},
        };

        if unsafe { WaitForSingleObject(self.process, INFINITE) } != WAIT_OBJECT_0 {
            return Err(io::Error::last_os_error());
        }
        let mut code = 0;
        if unsafe { GetExitCodeProcess(self.process, &mut code) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(ExitStatus::from_raw(code))
    }
}

#[cfg(windows)]
impl Drop for ReparentedDaemon {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.process);
        }
    }
}

#[derive(Debug, Default)]
pub(super) struct StartupRecoveryBudget {
    unrecorded_recovery_attempted: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RecordedDaemonState {
    Missing,
    Dead,
    Alive,
}

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
    ensure_daemon_for(ClientKind::App)
}

pub fn ensure_daemon_for(client_kind: ClientKind) -> Result<DaemonStream> {
    let mut recovery = StartupRecoveryBudget::default();
    ensure_daemon_with_recovery_for(&mut recovery, client_kind)
}

pub(super) fn ensure_daemon_with_recovery_for(
    recovery: &mut StartupRecoveryBudget,
    client_kind: ClientKind,
) -> Result<DaemonStream> {
    let mut unhealthy_since = None;
    let mut last_error = match connect_ready_daemon(client_kind) {
        Ok(stream) => return Ok(stream),
        Err(mut err) => {
            if err.kind == StartupAttemptErrorKind::Connect {
                thread::sleep(DAEMON_READY_DELAY);
                match connect_ready_daemon(client_kind) {
                    Ok(stream) => return Ok(stream),
                    Err(retry_err) => err = retry_err,
                }
            }
            track_unhealthy_error(&err, &mut unhealthy_since);
            recover_stale_daemon_for_error(&err, false, false, recovery, unhealthy_since)?;
            Some(err.to_string())
        }
    };

    let mut spawned_daemon = Some(spawn_daemon_process()?);

    let deadline = Instant::now() + DAEMON_STARTUP_TIMEOUT;
    while Instant::now() < deadline {
        if let Some(child) = spawned_daemon.as_mut() {
            if let Some(status) = child
                .try_wait()
                .context("poll spawned daemon startup status")?
            {
                last_error = Some(format!(
                    "spawned daemon exited before becoming ready: {status}"
                ));
                if recover_unrecorded_after_spawn_exit(recovery)? {
                    spawned_daemon = Some(spawn_daemon_process()?);
                    continue;
                }
                spawned_daemon = None;
            }
        }

        match connect_ready_daemon(client_kind) {
            Ok(stream) => return Ok(stream),
            Err(err) => {
                track_unhealthy_error(&err, &mut unhealthy_since);
                let should_retry = should_retry_startup_attempt(&err, spawned_daemon.is_some());
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
        let _ = terminate_daemon_pid(child_pid);
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
    connect_authenticated_daemon(ClientKind::App).map_err(|error| {
        let message = error.to_string();
        let kind = if message.contains("timed out") {
            io::ErrorKind::TimedOut
        } else if message.contains(DAEMON_AUTH_REQUIRED) {
            io::ErrorKind::PermissionDenied
        } else {
            io::ErrorKind::ConnectionAborted
        };
        io::Error::new(kind, message)
    })
}

pub fn connect_authenticated_daemon(client_kind: ClientKind) -> Result<DaemonStream> {
    let mut stream = connect_daemon_with_timeout(socket_name()?, STARTUP_CONNECT_TIMEOUT)
        .context("connect daemon")?;
    let secret = load_ipc_secret()?;
    authenticate_daemon_stream(&mut stream, client_kind, &secret)?;
    Ok(stream)
}

fn connect_daemon_with_timeout(name: Name<'static>, timeout: Duration) -> io::Result<DaemonStream> {
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name("vibelink-daemon-connect".to_string())
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

fn connect_ready_daemon(
    client_kind: ClientKind,
) -> std::result::Result<DaemonStream, StartupAttemptError> {
    let stream = connect_daemon_with_timeout(
        socket_name().map_err(|error| StartupAttemptError::connect(error.into()))?,
        STARTUP_CONNECT_TIMEOUT,
    )
    .context("connect daemon")
    .map_err(StartupAttemptError::connect)?;
    let stream = authenticate_daemon(stream, client_kind)
        .context("authenticate daemon")
        .map_err(StartupAttemptError::unhealthy)?;
    probe_daemon(stream)
        .context("probe daemon startup ping")
        .map_err(StartupAttemptError::unhealthy)
}

fn authenticate_daemon(stream: DaemonStream, client_kind: ClientKind) -> Result<DaemonStream> {
    run_daemon_step_with_timeout(
        stream,
        STARTUP_AUTH_TIMEOUT,
        "vibelink-daemon-authenticate",
        "daemon authentication",
        move |stream| {
            let secret = load_ipc_secret()?;
            authenticate_daemon_stream(stream, client_kind, &secret).map(|_| ())
        },
    )
}

fn probe_daemon(stream: DaemonStream) -> Result<DaemonStream> {
    run_daemon_step_with_timeout(
        stream,
        STARTUP_PING_TIMEOUT,
        "vibelink-daemon-probe",
        "daemon startup ping",
        ping_daemon_io,
    )
}

fn run_daemon_step_with_timeout<S, F>(
    mut stream: S,
    timeout: Duration,
    thread_name: &'static str,
    operation: &'static str,
    step: F,
) -> Result<S>
where
    S: Send + 'static,
    F: FnOnce(&mut S) -> Result<()> + Send + 'static,
{
    let (tx, rx) = mpsc::sync_channel(1);
    thread::Builder::new()
        .name(thread_name.to_string())
        .spawn(move || {
            let result = step(&mut stream).map(|()| stream);
            let _ = tx.send(result);
        })
        .with_context(|| format!("spawn {operation}"))?;

    match rx.recv_timeout(timeout) {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => {
            bail!("{operation} timed out after {}ms", timeout.as_millis())
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            bail!("{operation} stopped before returning a stream")
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

fn recover_stale_daemon_for_error(
    err: &StartupAttemptError,
    daemon_spawned_by_this_startup: bool,
    recorded_recovery_attempted: bool,
    recovery: &mut StartupRecoveryBudget,
    unhealthy_since: Option<Instant>,
) -> Result<bool> {
    if should_recover_stale_daemon(
        err,
        daemon_spawned_by_this_startup,
        recorded_recovery_attempted,
    ) {
        let recovered = recover_recorded_stale_daemon()?;
        if recovered {
            return Ok(true);
        }
    }

    let daemon_paths = paths::daemon_paths()?;
    let recorded_state = recorded_daemon_state(&daemon_paths.pid)?;
    let unhealthy_elapsed = unhealthy_since.map(|since| since.elapsed());
    if should_recover_unrecorded_stale_daemon(
        err,
        daemon_spawned_by_this_startup,
        recovery.unrecorded_recovery_attempted,
        recorded_state,
        unhealthy_elapsed,
    ) {
        return recover_unrecorded_once(recovery);
    }
    Ok(false)
}

fn recover_unrecorded_after_spawn_exit(recovery: &mut StartupRecoveryBudget) -> Result<bool> {
    let daemon_paths = paths::daemon_paths()?;
    let recorded_state = recorded_daemon_state(&daemon_paths.pid)?;
    if should_recover_unrecorded_after_spawn_exit(
        recovery.unrecorded_recovery_attempted,
        recorded_state,
    ) {
        return recover_unrecorded_once(recovery);
    }
    Ok(false)
}

fn recover_unrecorded_once(recovery: &mut StartupRecoveryBudget) -> Result<bool> {
    if recovery.unrecorded_recovery_attempted {
        return Ok(false);
    }
    recovery.unrecorded_recovery_attempted = true;
    recover_unrecorded_stale_daemon()
}

fn track_unhealthy_error(err: &StartupAttemptError, unhealthy_since: &mut Option<Instant>) {
    if err.kind == StartupAttemptErrorKind::Unhealthy {
        unhealthy_since.get_or_insert_with(Instant::now);
    } else {
        *unhealthy_since = None;
    }
}

fn should_recover_unrecorded_stale_daemon(
    err: &StartupAttemptError,
    daemon_spawned_by_this_startup: bool,
    already_recovered: bool,
    recorded_state: RecordedDaemonState,
    unhealthy_elapsed: Option<Duration>,
) -> bool {
    if daemon_spawned_by_this_startup || already_recovered {
        return false;
    }
    match (recorded_state, err.kind) {
        (
            RecordedDaemonState::Dead,
            StartupAttemptErrorKind::Connect | StartupAttemptErrorKind::Unhealthy,
        )
        | (RecordedDaemonState::Missing, StartupAttemptErrorKind::Unhealthy) => true,
        (RecordedDaemonState::Alive, StartupAttemptErrorKind::Unhealthy) => {
            unhealthy_elapsed.is_some_and(|elapsed| elapsed >= RECORDED_UNHEALTHY_RECOVERY_DELAY)
        }
        _ => false,
    }
}

fn should_recover_unrecorded_after_spawn_exit(
    already_recovered: bool,
    recorded_state: RecordedDaemonState,
) -> bool {
    !already_recovered
        && matches!(
            recorded_state,
            RecordedDaemonState::Missing | RecordedDaemonState::Dead
        )
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

/// Stops the daemon without marking a deliberate quit. Used by daemon
/// RESTART, where the panes are expected to be reconstructed immediately.
pub fn shutdown_daemon() -> Result<bool> {
    shutdown_daemon_with(false)
}

/// Stops the daemon and records a deliberate application quit, so the next
/// start does not cold-restore these workspaces.
pub fn shutdown_daemon_clean() -> Result<bool> {
    shutdown_daemon_with(true)
}

fn shutdown_daemon_with(clean_exit: bool) -> Result<bool> {
    let daemon_paths = paths::daemon_paths()?;

    // Try graceful shutdown via protocol message first.
    if graceful_shutdown(&daemon_paths.pid, clean_exit)? {
        return Ok(true);
    }

    // Fall back to forceful termination.
    shutdown_daemon_from_pid_file(&daemon_paths.pid)
}

const SHUTDOWN_REQ: Req = u64::MAX;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(3);

fn graceful_shutdown(pid_path: &Path, clean_exit: bool) -> Result<bool> {
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
        .name("vibelink-shutdown".to_string())
        .spawn(move || {
            let mut stream = stream;
            let result = (|| -> Result<()> {
                write_frame(
                    &mut stream,
                    &ClientToDaemon::Shutdown {
                        req: SHUTDOWN_REQ,
                        clean_exit,
                    },
                )?;
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

#[cfg(windows)]
fn recover_unrecorded_stale_daemon() -> Result<bool> {
    let pids = find_unrecorded_daemon_pids()?;
    for pid in &pids {
        terminate_daemon_pid(*pid)
            .with_context(|| format!("terminate unrecorded daemon pid {pid}"))?;
    }
    if !pids.is_empty() {
        thread::sleep(Duration::from_millis(500));
    }
    Ok(!pids.is_empty())
}

#[cfg(not(windows))]
fn recover_unrecorded_stale_daemon() -> Result<bool> {
    Ok(false)
}

#[cfg(windows)]
fn find_unrecorded_daemon_pids() -> Result<Vec<u32>> {
    let exe = std::env::current_exe().context("resolve current executable for daemon recovery")?;
    let daemon_paths = paths::daemon_paths()?;
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            include_str!("find_daemon_pids.ps1"),
        ])
        .env("VIBELINK_DAEMON_EXE", exe)
        .env(
            "VIBELINK_DAEMON_DIR",
            daemon_bin_dir(&daemon_paths.data_dir),
        )
        .env("VIBELINK_APP_FLAVOR", paths::app_flavor())
        .stdin(Stdio::null())
        .output()
        .context("list unrecorded daemon processes")?;

    if !output.status.success() {
        bail!(
            "list unrecorded daemon processes exited with {}",
            output.status
        );
    }

    let stdout =
        String::from_utf8(output.stdout).context("parse daemon process list output as utf8")?;
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| {
            line.parse::<u32>()
                .with_context(|| format!("invalid daemon pid {line:?}"))
        })
        .collect()
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

fn recorded_daemon_state(path: &Path) -> Result<RecordedDaemonState> {
    let Some(pid) = read_daemon_pid(path)? else {
        return Ok(RecordedDaemonState::Missing);
    };
    if process_exists(pid)? {
        Ok(RecordedDaemonState::Alive)
    } else {
        Ok(RecordedDaemonState::Dead)
    }
}

#[cfg(windows)]
fn terminate_daemon_pid(pid: u32) -> Result<()> {
    let output = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .output()
        .context("run taskkill for stale daemon")?;
    if output.status.success() {
        return Ok(());
    }
    if termination_attempt_completed(false, windows_process_exists(pid)?) {
        return Ok(());
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    bail!(
        "taskkill exited with {}: {}{}",
        output.status,
        stdout.trim(),
        stderr.trim()
    );
}

#[cfg(windows)]
fn windows_process_exists(pid: u32) -> Result<bool> {
    let output = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-Command",
            "$targetPid = [uint32]$env:VIBELINK_PID; if (Get-CimInstance Win32_Process -Filter \"ProcessId = $targetPid\") { 'exists' } else { 'missing' }",
        ])
        .env("VIBELINK_PID", pid.to_string())
        .stdin(Stdio::null())
        .output()
        .context("check whether daemon pid still exists")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "process existence check exited with {}: {}",
            output.status,
            stderr.trim()
        );
    }

    let stdout = String::from_utf8(output.stdout).context("parse process existence output")?;
    match stdout.trim() {
        "exists" => Ok(true),
        "missing" => Ok(false),
        other => bail!("unexpected process existence output {other:?}"),
    }
}

#[cfg(windows)]
fn process_exists(pid: u32) -> Result<bool> {
    windows_process_exists(pid)
}

#[cfg(not(windows))]
fn process_exists(pid: u32) -> Result<bool> {
    let status = Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .context("check whether daemon pid still exists")?;
    Ok(status.success())
}

fn termination_attempt_completed(
    command_succeeded: bool,
    process_exists_after_attempt: bool,
) -> bool {
    command_succeeded || !process_exists_after_attempt
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

fn spawn_daemon_process() -> Result<SpawnedDaemon> {
    match spawn_configured_daemon(true) {
        Ok(child) => Ok(child),
        Err(err) if should_retry_without_breakaway(&err) => spawn_configured_daemon(false),
        Err(err) => Err(err),
    }
}

fn terminate_spawned_daemon(child: &mut SpawnedDaemon) {
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

fn spawn_configured_daemon(include_breakaway: bool) -> Result<SpawnedDaemon> {
    let exe = daemon_executable().context("prepare daemon executable")?;
    #[cfg(windows)]
    if current_redirection_trust_enforced() {
        match spawn_reparented_daemon(&exe, include_breakaway) {
            Ok(child) => return Ok(child),
            Err(err) => tracing::warn!(
                ?err,
                "failed to shed inherited RedirectionGuard for daemon spawn"
            ),
        }
    }

    let mut command = Command::new(exe);
    command
        .arg("--daemon")
        // The app keeps WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS set for its own
        // WebView2 environment (see `app::run`); the daemon must not inherit
        // its debugging port.
        .env_remove("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

    configure_detached(&mut command, include_breakaway);
    command
        .spawn()
        .map(SpawnedDaemon::Standard)
        .context("spawn detached daemon")
}

fn daemon_executable() -> Result<PathBuf> {
    let source = std::env::current_exe().context("resolve current executable")?;
    #[cfg(windows)]
    {
        prepare_daemon_executable(&source)
    }
    #[cfg(not(windows))]
    {
        Ok(source)
    }
}

#[cfg(windows)]
fn prepare_daemon_executable(source: &Path) -> Result<PathBuf> {
    let daemon_paths = paths::daemon_paths()?;
    prepare_daemon_executable_in(source, &daemon_paths.data_dir)
}

#[cfg(windows)]
fn prepare_daemon_executable_in(source: &Path, data_dir: &Path) -> Result<PathBuf> {
    let identity = executable_identity(source)?;
    let dir = daemon_bin_dir(data_dir);
    fs::create_dir_all(&dir)
        .with_context(|| format!("create daemon executable directory {}", dir.display()))?;
    let target = daemon_copy_path(&dir, &identity);

    if !target.exists() {
        copy_daemon_executable(source, &target)?;
    }
    cleanup_old_daemon_executables(&dir, &target);

    Ok(target)
}

#[cfg(windows)]
fn daemon_bin_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(DAEMON_BIN_DIR)
}

#[cfg(windows)]
fn daemon_copy_path(dir: &Path, identity: &str) -> PathBuf {
    dir.join(format!(
        "{}-{}-{}.exe",
        DAEMON_EXE_PREFIX,
        paths::app_flavor(),
        identity
    ))
}

#[cfg(windows)]
fn copy_daemon_executable(source: &Path, target: &Path) -> Result<()> {
    let target_name = target
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| anyhow!("daemon executable target has no file name"))?;
    let temp = target.with_file_name(format!(
        "{target_name}.tmp-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));

    fs::copy(source, &temp).with_context(|| {
        format!(
            "copy daemon executable {} to {}",
            source.display(),
            temp.display()
        )
    })?;

    match fs::rename(&temp, target) {
        Ok(()) => Ok(()),
        Err(err) if target.exists() => {
            let _ = fs::remove_file(&temp);
            let _ = err;
            Ok(())
        }
        Err(err) => {
            let _ = fs::remove_file(&temp);
            Err(err).with_context(|| {
                format!(
                    "activate daemon executable copy {} as {}",
                    temp.display(),
                    target.display()
                )
            })
        }
    }
}

#[cfg(windows)]
fn cleanup_old_daemon_executables(dir: &Path, current: &Path) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let prefix = format!("{}-{}-", DAEMON_EXE_PREFIX, paths::app_flavor());

    for entry in entries.flatten() {
        let path = entry.path();
        if path == current {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if file_name.starts_with(&prefix) && file_name.ends_with(".exe") {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(windows)]
fn executable_identity(path: &Path) -> Result<String> {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let mut file = fs::File::open(path)
        .with_context(|| format!("open executable for hashing {}", path.display()))?;
    let mut hash = OFFSET;
    let mut len = 0_u64;
    let mut buf = [0_u8; 64 * 1024];

    loop {
        let read = file
            .read(&mut buf)
            .with_context(|| format!("read executable for hashing {}", path.display()))?;
        if read == 0 {
            break;
        }
        len += read as u64;
        for byte in &buf[..read] {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(PRIME);
        }
    }

    Ok(format!("{len:016x}-{hash:016x}"))
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
fn current_redirection_trust_enforced() -> bool {
    unsafe {
        redirection_trust_enforced(windows_sys::Win32::System::Threading::GetCurrentProcess())
            .unwrap_or(false)
    }
}

#[cfg(windows)]
unsafe fn redirection_trust_enforced(
    process: windows_sys::Win32::Foundation::HANDLE,
) -> io::Result<bool> {
    use std::{ffi::c_void, mem::size_of};
    use windows_sys::Win32::System::Threading::GetProcessMitigationPolicy;

    const PROCESS_REDIRECTION_TRUST_POLICY: i32 = 16;
    let mut flags = 0u32;
    if GetProcessMitigationPolicy(
        process,
        PROCESS_REDIRECTION_TRUST_POLICY,
        &mut flags as *mut u32 as *mut c_void,
        size_of::<u32>(),
    ) == 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(flags & 1 != 0)
}

#[cfg(windows)]
fn spawn_reparented_daemon(exe: &Path, include_breakaway: bool) -> Result<SpawnedDaemon> {
    use std::{
        ffi::c_void,
        mem::{size_of, zeroed},
        os::windows::ffi::OsStrExt,
        ptr::{null, null_mut},
    };
    use windows_sys::Win32::{
        Foundation::{CloseHandle, HANDLE},
        System::Threading::{
            CreateProcessW, DeleteProcThreadAttributeList, InitializeProcThreadAttributeList,
            OpenProcess, UpdateProcThreadAttribute, EXTENDED_STARTUPINFO_PRESENT,
            LPPROC_THREAD_ATTRIBUTE_LIST, PROCESS_CREATE_PROCESS, PROCESS_INFORMATION,
            PROCESS_QUERY_LIMITED_INFORMATION, PROC_THREAD_ATTRIBUTE_PARENT_PROCESS,
            STARTUPINFOEXW,
        },
        UI::WindowsAndMessaging::{GetShellWindow, GetWindowThreadProcessId},
    };

    let shell = unsafe { GetShellWindow() };
    if shell.is_null() {
        bail!("desktop shell window is unavailable");
    }
    let mut shell_pid = 0;
    unsafe { GetWindowThreadProcessId(shell, &mut shell_pid) };
    if shell_pid == 0 {
        bail!("desktop shell process is unavailable");
    }

    let parent = unsafe {
        OpenProcess(
            PROCESS_CREATE_PROCESS | PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            shell_pid,
        )
    };
    if parent.is_null() {
        return Err(io::Error::last_os_error()).context("open desktop shell process");
    }

    let result = (|| -> Result<SpawnedDaemon> {
        if unsafe { redirection_trust_enforced(parent) }? {
            bail!("desktop shell also enforces RedirectionGuard");
        }

        let mut attribute_bytes = 0usize;
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut attribute_bytes);
        }
        if attribute_bytes == 0 {
            return Err(io::Error::last_os_error()).context("measure process attribute list");
        }
        let words = attribute_bytes.div_ceil(size_of::<usize>());
        let mut attribute_storage = vec![0usize; words];
        let attribute_list = attribute_storage.as_mut_ptr() as LPPROC_THREAD_ATTRIBUTE_LIST;
        if unsafe { InitializeProcThreadAttributeList(attribute_list, 1, 0, &mut attribute_bytes) }
            == 0
        {
            return Err(io::Error::last_os_error()).context("initialize process attribute list");
        }

        let spawn_result = (|| -> Result<SpawnedDaemon> {
            let parent_value: HANDLE = parent;
            if unsafe {
                UpdateProcThreadAttribute(
                    attribute_list,
                    0,
                    PROC_THREAD_ATTRIBUTE_PARENT_PROCESS as usize,
                    &parent_value as *const HANDLE as *const c_void,
                    size_of::<HANDLE>(),
                    null_mut(),
                    null(),
                )
            } == 0
            {
                return Err(io::Error::last_os_error()).context("set daemon parent process");
            }

            let mut startup: STARTUPINFOEXW = unsafe { zeroed() };
            startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
            startup.lpAttributeList = attribute_list;
            let mut process_info: PROCESS_INFORMATION = unsafe { zeroed() };
            let application = exe
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            let mut command_line = Vec::with_capacity(application.len() + 12);
            command_line.push(b'"' as u16);
            command_line.extend(exe.as_os_str().encode_wide());
            command_line.extend([b'"' as u16, b' ' as u16]);
            command_line.extend("--daemon".encode_utf16());
            command_line.push(0);

            let created = unsafe {
                CreateProcessW(
                    application.as_ptr(),
                    command_line.as_mut_ptr(),
                    null(),
                    null(),
                    0,
                    windows_creation_flags(include_breakaway) | EXTENDED_STARTUPINFO_PRESENT,
                    null(),
                    null(),
                    &startup.StartupInfo,
                    &mut process_info,
                )
            };
            if created == 0 {
                return Err(io::Error::last_os_error())
                    .context("create daemon with desktop shell parent");
            }
            unsafe { CloseHandle(process_info.hThread) };
            Ok(SpawnedDaemon::Reparented(ReparentedDaemon {
                process: process_info.hProcess,
                pid: process_info.dwProcessId,
            }))
        })();

        unsafe { DeleteProcThreadAttributeList(attribute_list) };
        spawn_result
    })();

    unsafe { CloseHandle(parent) };
    result
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
    use crate::protocol::{constant_time_eq, read_frame, write_frame};
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

        fn with_responses(responses: &[DaemonToClient]) -> Self {
            let mut read_bytes = Vec::new();
            for response in responses {
                write_frame(&mut read_bytes, response).expect("encode scripted response");
            }
            Self {
                read: Cursor::new(read_bytes),
                written: Vec::new(),
            }
        }

        fn written_messages(&self) -> Vec<ClientToDaemon> {
            let mut cursor = Cursor::new(self.written.clone());
            let mut messages = Vec::new();
            while cursor.position() < cursor.get_ref().len() as u64 {
                messages.push(read_frame(&mut cursor).expect("decode written request"));
            }
            messages
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
    fn authenticated_client_sends_valid_current_proof() {
        let secret = [0x44_u8; 32];
        let client_id = Uuid::new_v4();
        let boot_id = Uuid::new_v4();
        let nonce = [0x33_u8; 32];
        let challenge = DaemonToClient::Challenge {
            protocol_version: DAEMON_PROTOCOL_VERSION,
            boot_id,
            nonce,
            expires_at_unix_ms: unix_time_millis_for_test() + 3_000,
        };
        let authenticated = DaemonToClient::Authenticated {
            policy_epoch: 8,
            lease_until_unix_ms: unix_time_millis_for_test() + 90_000,
        };
        let mut stream = ScriptedStream::with_responses(&[challenge, authenticated]);

        let result = authenticate_daemon_stream_with_client_id(
            &mut stream,
            ClientKind::Cli,
            &secret,
            client_id,
        )
        .expect("valid proof accepted");
        let messages = stream.written_messages();

        assert_eq!(result.policy_epoch, 8);
        assert_eq!(
            messages[0],
            ClientToDaemon::Hello {
                protocol_version: DAEMON_PROTOCOL_VERSION,
                client_id,
                client_kind: ClientKind::Cli,
            }
        );
        let ClientToDaemon::Authenticate {
            client_id: proof_client_id,
            proof,
        } = messages[1]
        else {
            panic!("second frame must authenticate");
        };
        assert_eq!(proof_client_id, client_id);
        assert!(constant_time_eq(
            &proof,
            &daemon_auth_proof(
                &secret,
                DAEMON_PROTOCOL_VERSION,
                boot_id,
                &nonce,
                client_id,
                ClientKind::Cli,
            )
        ));
    }

    #[test]
    fn authenticated_client_rejects_expired_challenge_without_sending_proof() {
        let challenge = DaemonToClient::Challenge {
            protocol_version: DAEMON_PROTOCOL_VERSION,
            boot_id: Uuid::new_v4(),
            nonce: [5_u8; 32],
            expires_at_unix_ms: unix_time_millis_for_test() - 1,
        };
        let mut stream = ScriptedStream::with_responses(&[challenge]);
        let error = authenticate_daemon_stream_with_client_id(
            &mut stream,
            ClientKind::App,
            &[6_u8; 32],
            Uuid::new_v4(),
        )
        .expect_err("expired challenge must fail");

        assert_eq!(error.to_string(), DAEMON_AUTH_REQUIRED);
        assert_eq!(stream.written_messages().len(), 1);
    }

    fn unix_time_millis_for_test() -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64
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

    #[test]
    fn daemon_step_timeout_returns_without_waiting_for_blocked_io() {
        let started = Instant::now();
        let error = run_daemon_step_with_timeout(
            (),
            Duration::from_millis(25),
            "vibelink-daemon-timeout-test",
            "daemon timeout test",
            |_| {
                thread::sleep(Duration::from_millis(500));
                Ok(())
            },
        )
        .expect_err("blocked daemon step must time out");

        assert!(error.to_string().contains("timed out after 25ms"));
        assert!(started.elapsed() < Duration::from_millis(250));
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
    fn failed_termination_is_complete_when_pid_already_exited() {
        assert!(termination_attempt_completed(false, false));
        assert!(!termination_attempt_completed(false, true));
        assert!(termination_attempt_completed(true, true));
    }

    #[test]
    fn shutdown_missing_pid_file_is_noop() {
        let path = std::env::temp_dir().join(format!(
            "vibelink-missing-daemon-{}-{}.pid",
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
            "vibelink-spawned-daemon-{}-{}.pid",
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
    fn unrecorded_recovery_requires_stale_process_evidence() {
        let connect_error = StartupAttemptError::connect(anyhow!("connect failed"));
        let unhealthy_error = StartupAttemptError::unhealthy(anyhow!("probe failed"));

        assert!(!should_recover_unrecorded_stale_daemon(
            &connect_error,
            false,
            false,
            RecordedDaemonState::Missing,
            None,
        ));
        assert!(should_recover_unrecorded_stale_daemon(
            &connect_error,
            false,
            false,
            RecordedDaemonState::Dead,
            None,
        ));
        assert!(should_recover_unrecorded_stale_daemon(
            &unhealthy_error,
            false,
            false,
            RecordedDaemonState::Missing,
            None,
        ));
        assert!(!should_recover_unrecorded_stale_daemon(
            &unhealthy_error,
            false,
            false,
            RecordedDaemonState::Alive,
            Some(RECORDED_UNHEALTHY_RECOVERY_DELAY - Duration::from_millis(1)),
        ));
        assert!(should_recover_unrecorded_stale_daemon(
            &unhealthy_error,
            false,
            false,
            RecordedDaemonState::Alive,
            Some(RECORDED_UNHEALTHY_RECOVERY_DELAY),
        ));
        assert!(!should_recover_unrecorded_stale_daemon(
            &unhealthy_error,
            true,
            false,
            RecordedDaemonState::Dead,
            None,
        ));
        assert!(!should_recover_unrecorded_stale_daemon(
            &unhealthy_error,
            false,
            true,
            RecordedDaemonState::Dead,
            None,
        ));
    }

    #[test]
    fn unrecorded_recovery_after_spawn_exit_accepts_missing_or_dead_pid_record() {
        assert!(should_recover_unrecorded_after_spawn_exit(
            false,
            RecordedDaemonState::Dead
        ));
        assert!(should_recover_unrecorded_after_spawn_exit(
            false,
            RecordedDaemonState::Missing
        ));
        assert!(!should_recover_unrecorded_after_spawn_exit(
            true,
            RecordedDaemonState::Dead
        ));
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

        assert!(format!("{name:?}").contains(&format!("vibelink-{}-daemon", paths::app_flavor())));
    }

    #[cfg(windows)]
    #[test]
    fn daemon_executable_copy_uses_data_dir_instead_of_source_exe() {
        let temp = std::env::temp_dir().join(format!(
            "vibelink-daemon-copy-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let source = temp.join("target").join("debug").join("app.exe");
        let data_dir = temp.join("data");
        fs::create_dir_all(source.parent().expect("source parent")).expect("create source dir");
        fs::write(&source, b"fake exe bytes").expect("write source exe");

        let daemon_exe =
            prepare_daemon_executable_in(&source, &data_dir).expect("prepare daemon exe");

        assert!(daemon_exe.starts_with(daemon_bin_dir(&data_dir)));
        assert_ne!(daemon_exe, source);
        assert_eq!(
            fs::read(&daemon_exe).expect("read copied daemon exe"),
            b"fake exe bytes"
        );
        assert!(daemon_exe
            .file_name()
            .and_then(|name| name.to_str())
            .expect("daemon exe file name")
            .starts_with(&format!("{}-{}-", DAEMON_EXE_PREFIX, paths::app_flavor())));

        let _ = fs::remove_dir_all(temp);
    }

    #[cfg(windows)]
    #[test]
    fn executable_identity_changes_with_executable_bytes() {
        let temp = std::env::temp_dir().join(format!(
            "vibelink-daemon-identity-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&temp).expect("create temp dir");
        let source = temp.join("app.exe");

        fs::write(&source, b"one").expect("write first exe");
        let first = executable_identity(&source).expect("hash first exe");
        fs::write(&source, b"two").expect("write second exe");
        let second = executable_identity(&source).expect("hash second exe");

        assert_ne!(first, second);

        let _ = fs::remove_dir_all(temp);
    }
}

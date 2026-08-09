use super::*;

pub fn run() {
    if let Err(err) = run_inner() {
        eprintln!("daemon failed: {err:#}");
    }
}

#[allow(clippy::incompatible_msrv)]
fn run_inner() -> Result<()> {
    let paths = paths::daemon_paths()?;
    let app_flavor = paths::app_flavor();
    init_logging(&paths.log);

    let lock_file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&paths.lock)?;

    if let Err(err) = lock_file.try_lock() {
        info!(?err, "another daemon owns the lock");
        return Ok(());
    }

    let _pid_file = PidFileGuard::create(paths.pid.clone())?;

    // Bind the bundled ConPTY before the first pane spawns; otherwise
    // portable-pty's bare `LoadLibrary("conpty.dll")` picks up whatever install
    // happens to be on PATH.
    conpty::ensure_bundled_conpty();

    let state = Arc::new(Mutex::new(DaemonState::new()));
    reconstruct_sessions(Arc::clone(&state), &paths.sessions)?;
    let mut startup_pane_cleanup = StartupPaneCleanup::new(Arc::clone(&state));
    let control = Arc::new(ControlPlane::open(&paths.data_dir)?);
    let worktree_registry = Arc::new(WorktreeRegistry::new(Arc::clone(&control)));
    let worktree_lifecycle = Arc::new(WorktreeLifecycleService::native(Arc::clone(
        &worktree_registry,
    )));
    let coordinator = Arc::new(CoordinatorService::new(Arc::clone(&control)));
    let worktrees = Arc::new(WorktreeManager::new(
        paths
            .data_dir
            .join("automation-artifacts")
            .join("worktrees"),
        Arc::clone(&worktree_registry),
    )?);
    reconcile_orchestration_startup(&state, &coordinator, &worktrees)?;
    let automation = Arc::new(AutomationService::open(
        &paths
            .data_dir
            .join("control")
            .join("vibelink-control.sqlite3"),
        paths.data_dir.join("automation-artifacts"),
        Arc::clone(&worktree_registry),
    )?);
    let computer_host_executable = std::env::var_os("VIBELINK_COMPUTER_HOST_EXE")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::current_exe().ok().and_then(|path| {
                path.parent()
                    .map(|parent| parent.join("vibelink-computer-host.exe"))
            })
        })
        .context("resolve computer-use host executable")?;
    let computer = start_computer_host(
        WindowsProcessSpawner::new(paths.data_dir.join("computer-artifacts"), app_flavor),
        computer_host_executable,
    )?;
    let remote = Arc::new(RemoteServer::new(paths.data_dir.clone())?);
    remote.start_if_enabled()?;

    let ipc_secret = Arc::new(load_or_create_ipc_secret()?);
    let boot_id = Uuid::new_v4();
    let policy_heartbeat = Arc::new(Mutex::new(PolicyHeartbeat::default()));
    let connections = Arc::new(Mutex::new(std::collections::HashMap::new()));
    let sessions_path = Arc::new(paths.sessions.clone());
    crate::dedicated_cli::browser_extension::start_for_daemon(&sessions_path);
    let shutdown = Arc::new(AtomicBool::new(false));
    start_automation_scheduler(
        Arc::clone(&automation),
        Arc::clone(&state),
        Arc::clone(&shutdown),
        Arc::clone(&sessions_path),
        Arc::clone(&worktree_lifecycle),
        Arc::clone(&worktrees),
    )?;
    start_remote_pane_lease_expiry_sweep(Arc::clone(&state), Arc::clone(&shutdown))?;
    spawn_policy_monitor(
        Arc::clone(&state),
        Arc::clone(&sessions_path),
        Arc::clone(&connections),
        Arc::clone(&policy_heartbeat),
        Arc::clone(&shutdown),
    )?;
    start_lifecycle_monitor(
        Arc::clone(&state),
        Arc::clone(&sessions_path),
        Arc::clone(&connections),
        Arc::clone(&automation),
        Arc::clone(&remote),
        Arc::clone(&shutdown),
    )?;
    let socket_name = paths::socket_name_string();
    let name = socket_name.as_str().to_ns_name::<GenericNamespaced>()?;
    let listener = ListenerOptions::new().name(name).create_sync()?;
    info!(socket_name, app_flavor, data_dir = ?paths.data_dir, "daemon listening");
    startup_pane_cleanup.disarm();

    for stream in listener.incoming() {
        if shutdown.load(Ordering::Acquire) {
            break;
        }
        match stream {
            Ok(stream) => {
                let state = Arc::clone(&state);
                let sessions_path = Arc::clone(&sessions_path);
                let shutdown = Arc::clone(&shutdown);
                let control = Arc::clone(&control);
                let coordinator = Arc::clone(&coordinator);
                let worktree_registry = Arc::clone(&worktree_registry);
                let worktree_lifecycle = Arc::clone(&worktree_lifecycle);
                let computer = computer.clone();
                let automation = Arc::clone(&automation);
                let worktrees = Arc::clone(&worktrees);
                let remote = Arc::clone(&remote);
                let ipc_secret = Arc::clone(&ipc_secret);
                let policy_heartbeat = Arc::clone(&policy_heartbeat);
                let connections = Arc::clone(&connections);
                thread::Builder::new()
                    .name("vibelink-daemon-client".to_string())
                    .spawn(move || {
                        handle_connection(
                            stream,
                            state,
                            sessions_path,
                            control,
                            coordinator,
                            worktree_registry,
                            worktree_lifecycle,
                            worktrees,
                            automation,
                            remote,
                            shutdown,
                            computer,
                            boot_id,
                            ipc_secret,
                            policy_heartbeat,
                            connections,
                        )
                    })?;
            }
            Err(err) => warn!(?err, "failed to accept daemon client"),
        }
    }

    info!("daemon shutting down, preserving restorable panes");
    if let Err(err) = persist_restorable_panes_and_kill_all(&state, &sessions_path) {
        warn!(?err, "failed to persist state during shutdown");
    }
    drop(lock_file);

    Ok(())
}

/// Sweeps pane process trees the daemon still parents without owning, and ends
/// a daemon that has nothing left to serve. See `daemon::lifecycle`.
fn start_lifecycle_monitor(
    state: SharedState,
    sessions_path: Arc<PathBuf>,
    connections: SharedConnections,
    automation: Arc<AutomationService>,
    remote: Arc<RemoteServer>,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    let config = lifecycle::LifecycleConfig::from_env();
    thread::Builder::new()
        .name("vibelink-daemon-lifecycle".to_string())
        .spawn(move || {
            let mut tracker = lifecycle::IdleTracker::new(Instant::now(), config);
            let mut sys = sysinfo::System::new();
            let daemon_pid = std::process::id();
            while !wait_for_daemon_shutdown(&shutdown, config.sweep_interval) {
                sweep_orphan_pane_processes(&state, &mut sys, daemon_pid);
                let activity = collect_daemon_activity(&state, &connections, &automation, &remote);
                if let Some(reason) = tracker.observe(activity, Instant::now()) {
                    info!(
                        reason = reason.as_str(),
                        "daemon has nothing left to serve; shutting down"
                    );
                    shutdown.store(true, Ordering::Release);
                    exit_daemon_process(&state, &sessions_path);
                }
            }
        })?;
    Ok(())
}

/// Terminates shell processes that are still parented by this daemon while no
/// live pane owns them. Console hosts are left alone: they belong to a pseudo
/// console, not to a pane root PID, and exit with it.
fn sweep_orphan_pane_processes(state: &SharedState, sys: &mut sysinfo::System, daemon_pid: u32) {
    let live_roots: HashSet<u32> = lock_state(state)
        .resource_targets()
        .into_iter()
        .filter_map(|(_, _, pid)| pid)
        .collect();
    let children = lifecycle::daemon_children(sys, daemon_pid);
    for pid in lifecycle::orphan_pane_pids(&children, &live_roots) {
        warn!(
            orphan_pid = pid,
            "terminating pane process tree without a live pane owner"
        );
        proc::kill_process_tree(pid);
    }
}

/// A probe failure must read as busy so a transient error can never terminate a
/// working daemon.
fn collect_daemon_activity(
    state: &SharedState,
    connections: &SharedConnections,
    automation: &AutomationService,
    remote: &RemoteServer,
) -> lifecycle::DaemonActivity {
    let scheduled_automations = match automation.list(None) {
        Ok(records) => records
            .iter()
            .filter(|record| record.next_run_at.is_some())
            .count(),
        Err(error) => {
            warn!(
                ?error,
                "failed to read automations; treating daemon as busy"
            );
            1
        }
    };
    lifecycle::DaemonActivity {
        clients: lock_mutex(connections).len(),
        live_panes: lock_state(state).resource_targets().len(),
        scheduled_automations,
        remote_running: remote.status().running,
    }
}

/// Persists restorable panes, drops the PID record, and ends the process. The
/// accept loop blocks on the listener, so exiting is what unblocks the daemon.
pub(super) fn exit_daemon_process(state: &SharedState, sessions_path: &Path) -> ! {
    if let Err(err) = persist_restorable_panes_and_kill_all(state, sessions_path) {
        warn!(?err, "failed to persist state during shutdown");
    }
    if let Ok(paths) = paths::daemon_paths() {
        let _ = fs::remove_file(paths.pid);
    }
    std::process::exit(0);
}

fn start_automation_scheduler(
    automation: Arc<AutomationService>,
    state: SharedState,
    shutdown: Arc<AtomicBool>,
    sessions_path: Arc<PathBuf>,
    worktree_lifecycle: Arc<WorktreeLifecycleService>,
    worktrees: Arc<WorktreeManager>,
) -> Result<()> {
    thread::Builder::new()
        .name("vibelink-automation-scheduler".to_string())
        .spawn(move || {
            automation_scheduler_loop(&shutdown, || {
                run_automation_scheduler_tick(
                    &automation,
                    &state,
                    &sessions_path,
                    &worktree_lifecycle,
                    &worktrees,
                );
            });
        })?;
    Ok(())
}

fn automation_scheduler_loop<F>(shutdown: &AtomicBool, mut tick: F)
where
    F: FnMut(),
{
    while !shutdown.load(Ordering::Acquire) {
        tick();
        if wait_for_daemon_shutdown(shutdown, AUTOMATION_SCHEDULER_INTERVAL) {
            break;
        }
    }
}

fn wait_for_daemon_shutdown(shutdown: &AtomicBool, timeout: Duration) -> bool {
    if shutdown.load(Ordering::Acquire) {
        return true;
    }

    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return shutdown.load(Ordering::Acquire);
        }
        thread::sleep(remaining.min(AUTOMATION_SCHEDULER_SHUTDOWN_POLL_INTERVAL));
        if shutdown.load(Ordering::Acquire) {
            return true;
        }
    }
}

fn run_automation_scheduler_tick(
    automation: &Arc<AutomationService>,
    state: &SharedState,
    sessions_path: &Arc<PathBuf>,
    worktree_lifecycle: &Arc<WorktreeLifecycleService>,
    worktrees: &Arc<WorktreeManager>,
) {
    let claims = match automation.claim_due(orchestration_now_millis()) {
        Ok(claims) => claims,
        Err(error) => {
            warn!(?error, "automation scheduler scan failed");
            return;
        }
    };

    for claim in claims {
        let workspace = automation
            .get(&claim.automation_id)
            .ok()
            .and_then(|record| automation_workspace(state, &record.session_id).ok())
            .unwrap_or_else(|| PathBuf::from("__vibelink_missing_workspace__"));
        let automation = Arc::clone(automation);
        let state = Arc::clone(state);
        let sessions_path = Arc::clone(sessions_path);
        let worktree_lifecycle = Arc::clone(worktree_lifecycle);
        let worktrees = Arc::clone(worktrees);
        let spawn_run_id = claim.id.clone();
        let execution_run_id = spawn_run_id.clone();
        let thread_name = format!(
            "vibelink-automation-{}",
            spawn_run_id.get(..8).unwrap_or(&spawn_run_id)
        );
        if let Err(error) = thread::Builder::new().name(thread_name).spawn(move || {
            if let Err(error) = automation.execute_with_worktree_and_runner(
                &claim,
                &workspace,
                |record, claim, workspace, planned| {
                    provision_automation_worktree(
                        &state,
                        &sessions_path,
                        &worktree_lifecycle,
                        &worktrees,
                        record,
                        claim,
                        workspace,
                        planned,
                    )
                },
                |runner, claim, record, prepared| {
                    run_automation_in_visible_terminal(
                        &automation,
                        runner,
                        &state,
                        &sessions_path,
                        claim,
                        record,
                        prepared,
                    )
                },
            ) {
                error!(automation_run_id = %execution_run_id, ?error, "automation run failed");
            }
        }) {
            error!(automation_run_id = %spawn_run_id, ?error, "failed to spawn automation run thread");
        }
    }
}

fn start_remote_pane_lease_expiry_sweep(
    state: SharedState,
    shutdown: Arc<AtomicBool>,
) -> Result<()> {
    thread::Builder::new()
        .name("vibelink-pane-lease-expiry".to_string())
        .spawn(move || {
            while !shutdown.load(Ordering::Acquire) {
                thread::sleep(REMOTE_PANE_LEASE_SWEEP_INTERVAL);
                if shutdown.load(Ordering::Acquire) {
                    break;
                }
                let transitions =
                    lock_state(&state).expire_remote_pane_leases(orchestration_now_millis());
                process_pane_lease_transitions(&state, transitions);
            }
        })?;
    Ok(())
}

fn start_computer_host(
    spawner: WindowsProcessSpawner,
    executable_path: PathBuf,
) -> Result<SharedComputerHost> {
    let (tx, rx) = bounded::<ComputerHostCall>(64);
    thread::Builder::new()
        .name("vibelink-computer-host-owner".to_string())
        .spawn(move || {
            let mut supervisor = ProviderHostSupervisor::new(spawner, executable_path);
            while let Ok(call) = rx.recv() {
                let result = supervisor.request(call.operation_id, call.request);
                let _ = call.reply.send(result);
            }
        })?;
    Ok(tx)
}

pub(super) fn request_computer_host(
    computer: &SharedComputerHost,
    operation_id: Uuid,
    request: HostRequest,
) -> Result<HostResponseBody> {
    let (reply, response) = bounded(1);
    computer
        .send(ComputerHostCall {
            operation_id,
            request,
            reply,
        })
        .context("computer-use host actor is unavailable")?;
    response
        .recv()
        .context("computer-use host actor stopped")?
        .map_err(anyhow::Error::from)
}

pub(super) struct PidFileGuard {
    path: PathBuf,
}

impl PidFileGuard {
    pub(super) fn create(path: PathBuf) -> Result<Self> {
        fs::write(&path, std::process::id().to_string())?;
        Ok(Self { path })
    }
}

impl Drop for PidFileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub(super) const DAEMON_LOG_ROTATE_LIMIT: u64 = 8 * 1024 * 1024;

pub(super) fn rotate_daemon_log(log_path: &Path) {
    if fs::metadata(log_path).is_ok_and(|metadata| metadata.len() > DAEMON_LOG_ROTATE_LIMIT) {
        let rotated = log_path.with_extension("log.1");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(log_path, rotated);
    }
}

struct RotatingLogWriter {
    path: PathBuf,
    file: Mutex<Option<std::fs::File>>,
    len: std::sync::atomic::AtomicU64,
}

impl RotatingLogWriter {
    fn open(path: &Path) -> io::Result<Self> {
        let (file, len) = Self::open_file(path)?;
        Ok(Self {
            path: path.to_path_buf(),
            file: Mutex::new(Some(file)),
            len: std::sync::atomic::AtomicU64::new(len),
        })
    }

    fn open_file(path: &Path) -> io::Result<(std::fs::File, u64)> {
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        let len = file.metadata()?.len();
        Ok((file, len))
    }

    fn write_event(&self, event: &[u8]) {
        let event_len = event.len() as u64;
        let mut file = lock_mutex(&self.file);
        if self
            .len
            .load(Ordering::Relaxed)
            .saturating_add(event_len)
            > DAEMON_LOG_ROTATE_LIMIT
        {
            if let Err(error) = self.rotate(&mut file) {
                eprintln!("failed to rotate daemon log {}: {error}", self.path.display());
                return;
            }
        }

        if file.is_none() {
            match Self::open_file(&self.path) {
                Ok((reopened, len)) => {
                    *file = Some(reopened);
                    self.len.store(len, Ordering::Relaxed);
                }
                Err(error) => {
                    eprintln!("failed to reopen daemon log {}: {error}", self.path.display());
                    return;
                }
            }
        }

        let Some(current) = file.as_mut() else {
            return;
        };
        if let Err(error) = current.write_all(event) {
            if let Ok(metadata) = current.metadata() {
                self.len.store(metadata.len(), Ordering::Relaxed);
            }
            eprintln!("failed to write daemon log {}: {error}", self.path.display());
            return;
        }
        self.len.fetch_add(event_len, Ordering::Relaxed);
    }

    fn rotate(&self, file: &mut Option<std::fs::File>) -> io::Result<()> {
        // Verify that the current path is still writable before releasing the live handle.
        drop(OpenOptions::new().create(true).append(true).open(&self.path)?);
        if let Some(current) = file.as_mut() {
            current.flush()?;
        }
        drop(file.take());

        let rotated = self.path.with_extension("log.1");
        match fs::remove_file(&rotated) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        fs::rename(&self.path, &rotated)?;

        match Self::open_file(&self.path) {
            Ok((new_file, len)) => {
                *file = Some(new_file);
                self.len.store(len, Ordering::Relaxed);
                Ok(())
            }
            Err(error) => {
                if let Err(restore_error) = fs::rename(&rotated, &self.path) {
                    eprintln!(
                        "failed to restore daemon log {} after rotation error: {restore_error}",
                        self.path.display()
                    );
                }
                Err(error)
            }
        }
    }
}

struct BufferedLogEvent<'a> {
    writer: &'a RotatingLogWriter,
    event: Vec<u8>,
}

impl Write for BufferedLogEvent<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.event.extend_from_slice(buffer);
        Ok(buffer.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for BufferedLogEvent<'_> {
    fn drop(&mut self) {
        if !self.event.is_empty() {
            self.writer.write_event(&self.event);
        }
    }
}

impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for RotatingLogWriter {
    type Writer = BufferedLogEvent<'a>;

    fn make_writer(&'a self) -> Self::Writer {
        BufferedLogEvent {
            writer: self,
            event: Vec::new(),
        }
    }
}

fn init_logging(log_path: &Path) {
    rotate_daemon_log(log_path);

    let Ok(writer) = RotatingLogWriter::open(log_path) else {
        return;
    };

    let _ = tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .with_writer(writer)
        .try_init();
}

#[cfg(test)]
mod rotating_log_tests {
    use super::*;
    use std::io::{Read as _, Seek as _, SeekFrom, Write as _};
    use tracing_subscriber::fmt::MakeWriter as _;

    #[test]
    fn daemon_log_rotates_while_running() {
        let root = std::env::temp_dir().join(format!("vibelink-runtime-log-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create runtime log test directory");
        let log = root.join("daemon.log");
        let first_event = b"first event\n";
        let second_event = b"second event\n";
        std::fs::File::create(&log)
            .expect("create current log")
            .set_len(DAEMON_LOG_ROTATE_LIMIT - first_event.len() as u64)
            .expect("grow current log");
        fs::write(log.with_extension("log.1"), b"old").expect("write old generation");
        let writer = RotatingLogWriter::open(&log).expect("open rotating log writer");

        {
            let mut event = writer.make_writer();
            event.write_all(first_event).expect("write first event");
        }
        {
            let mut event = writer.make_writer();
            event.write_all(second_event).expect("write second event");
        }

        let rotated = log.with_extension("log.1");
        let rotated_len = fs::metadata(&rotated).expect("rotated log exists").len();
        let current_len = fs::metadata(&log).expect("current log exists").len();
        let mut rotated_tail = vec![0; first_event.len()];
        let mut rotated_file = std::fs::File::open(&rotated).expect("open rotated log");
        rotated_file
            .seek(SeekFrom::End(-(first_event.len() as i64)))
            .expect("seek to first event");
        rotated_file
            .read_exact(&mut rotated_tail)
            .expect("read first event");

        assert_eq!(rotated_tail.as_slice(), first_event);
        let current = fs::read(&log).expect("read current log");
        assert_eq!(current.as_slice(), second_event);
        assert!(rotated_len + current_len <= DAEMON_LOG_ROTATE_LIMIT * 2);

        drop(writer);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn daemon_log_drops_events_when_rotation_fails() {
        let root = std::env::temp_dir().join(format!("vibelink-runtime-log-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).expect("create runtime log test directory");
        let log = root.join("daemon.log");
        std::fs::File::create(&log)
            .expect("create current log")
            .set_len(DAEMON_LOG_ROTATE_LIMIT)
            .expect("grow current log");
        fs::create_dir(log.with_extension("log.1")).expect("block rotated log removal");
        let writer = RotatingLogWriter::open(&log).expect("open rotating log writer");

        writer.write_event(b"first dropped event\n");
        writer.write_event(b"second dropped event\n");

        assert_eq!(
            fs::metadata(&log).expect("current log exists").len(),
            DAEMON_LOG_ROTATE_LIMIT
        );

        drop(writer);
        let _ = fs::remove_dir_all(root);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ExactProcessObservation {
    Running,
    Gone,
    Reused,
}

pub(super) fn orchestration_now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub(super) fn process_start_time(root_pid: u32) -> Option<u64> {
    let mut system = sysinfo::System::new();
    system.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    system
        .process(sysinfo::Pid::from_u32(root_pid))
        .map(sysinfo::Process::start_time)
}

fn observe_exact_process(root_pid: u32, started_at: u64) -> ExactProcessObservation {
    match process_start_time(root_pid) {
        None => ExactProcessObservation::Gone,
        Some(current) if current == started_at => ExactProcessObservation::Running,
        Some(_) => ExactProcessObservation::Reused,
    }
}

fn processes_for_pane_identity(pane_id: Uuid) -> Vec<(u32, u64)> {
    let expected = format!("VIBELINK_PANE_ID={pane_id}");
    let mut system = sysinfo::System::new();
    system.refresh_processes_specifics(
        sysinfo::ProcessesToUpdate::All,
        true,
        sysinfo::ProcessRefreshKind::everything(),
    );
    let matches = system
        .processes()
        .iter()
        .filter(|&(_pid, process)| {
            process
                .environ()
                .iter()
                .any(|entry| entry.to_string_lossy() == expected)
        })
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                process.start_time(),
                process.parent().map(|parent| parent.as_u32()),
            )
        })
        .collect::<Vec<_>>();
    matches
        .iter()
        .filter(|(_, _, parent)| {
            parent.is_none_or(|parent| !matches.iter().any(|(pid, _, _)| *pid == parent))
        })
        .map(|(pid, started_at, _)| (*pid, *started_at))
        .collect()
}

pub(super) fn kill_pane_processes_until_exit(pane_id: Uuid) -> bool {
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let roots = processes_for_pane_identity(pane_id);
        if roots.is_empty() {
            return true;
        }
        for (root_pid, _) in roots {
            crate::daemon::proc::kill_process_tree(root_pid);
        }
        if std::time::Instant::now() >= deadline {
            return processes_for_pane_identity(pane_id).is_empty();
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub(super) fn cleanup_dispatch_target(
    state: &SharedState,
    coordinator: &CoordinatorService,
    worktrees: &WorktreeManager,
    target: &DispatchCleanupTarget,
    reason: &str,
) -> (Option<DispatchResourceRecord>, Vec<String>) {
    let mut resource = target.resources.clone().unwrap_or_else(|| {
        let repository_root = automation_workspace(state, &target.session_id)
            .ok()
            .and_then(|workspace| worktrees.authority(&workspace).ok())
            .map(|authority| authority.repository_root_string());
        DispatchResourceRecord {
            session_id: target.session_id.clone(),
            repository_root,
            relative_prefix: String::new(),
            launch_path: None,
            agent_instance_id: target.dispatch.agent_instance_id.clone(),
            pane_id: target.dispatch.pane_id.clone(),
            root_pid: None,
            process_started_at: None,
            process_generation: target.dispatch.process_generation,
            worktree: target.dispatch.worktree.clone(),
            pane_disposition: if target.dispatch.pane_id.is_some() {
                ResourceDisposition::Live
            } else {
                ResourceDisposition::NotCreated
            },
            worktree_disposition: if target.dispatch.worktree.is_some() {
                ResourceDisposition::Retained
            } else {
                ResourceDisposition::NotCreated
            },
            cleanup_reason: None,
            cleanup_error: None,
        }
    });
    let mut errors = Vec::new();
    if target.resources.is_none()
        && target.dispatch.pane_id.is_none()
        && target.dispatch.worktree.is_none()
    {
        return (Some(resource), errors);
    }
    match coordinator.mark_dispatch_resource_disposition(
        &target.dispatch.id,
        None,
        None,
        false,
        false,
        Some(reason),
        None,
    ) {
        Ok(updated) => resource = updated,
        Err(error) => {
            let message = format!(
                "failed to persist cleanup ownership for dispatch {}: {}",
                target.dispatch.id, error
            );
            resource.pane_disposition = ResourceDisposition::CleanupFailed;
            resource.cleanup_reason = Some(reason.to_string());
            resource.cleanup_error = Some(bounded_launch_error(&message));
            return (Some(resource), vec![message]);
        }
    }

    if let Some(pane_id_text) = resource
        .pane_id
        .clone()
        .or_else(|| target.dispatch.pane_id.clone())
    {
        let pane_error_start = errors.len();
        match (
            Uuid::parse_str(&target.session_id),
            Uuid::parse_str(&pane_id_text),
        ) {
            (Ok(session_id), Ok(pane_id)) => {
                let live_root = lock_state(state)
                    .resource_targets()
                    .into_iter()
                    .find(|(owner_session, owner_pane, _)| {
                        *owner_session == session_id && *owner_pane == pane_id
                    })
                    .and_then(|(_, _, root_pid)| root_pid);
                let root_identity_changed = live_root.is_some()
                    && resource.root_pid.is_some()
                    && live_root != resource.root_pid;
                if root_identity_changed {
                    errors.push(format!(
                        "pane {pane_id} root process identity changed; refusing cleanup"
                    ));
                } else {
                    if live_root.is_some() {
                        let (pane, lease_transition) = {
                            let mut guard = lock_state(state);
                            match guard.close_pane(session_id, pane_id) {
                                Ok(pane) => {
                                    let lease = guard.cleanup_remote_pane_lease_on_exit(pane_id);
                                    (pane, lease)
                                }
                                Err(error) => {
                                    errors.push(format!("pane {pane_id} cleanup failed: {error}"));
                                    (None, None)
                                }
                            }
                        };
                        if let Some(transition) = lease_transition {
                            process_pane_lease_transition(state, transition);
                        }
                        if let Some(mut pane) = pane {
                            if let Err(error) = pane.kill() {
                                errors.push(format!("pane {pane_id} cleanup failed: {error}"));
                            }
                        }
                    } else if let (Some(root_pid), Some(started_at)) =
                        (resource.root_pid, resource.process_started_at)
                    {
                        if observe_exact_process(root_pid, started_at)
                            == ExactProcessObservation::Running
                        {
                            crate::daemon::proc::kill_process_tree(root_pid);
                        }
                    }

                    let identity_roots = processes_for_pane_identity(pane_id);
                    if identity_roots.is_empty()
                        && resource.process_started_at.is_none()
                        && resource
                            .root_pid
                            .is_some_and(|root_pid| process_start_time(root_pid).is_some())
                    {
                        errors.push(format!(
                            "pane {pane_id} has no durable process start identity; refusing PID-only cleanup"
                        ));
                    }
                    if !kill_pane_processes_until_exit(pane_id) {
                        errors.push(format!(
                            "pane {pane_id} process trees remained alive after cleanup"
                        ));
                    }
                    if let (Some(root_pid), Some(started_at)) =
                        (resource.root_pid, resource.process_started_at)
                    {
                        if observe_exact_process(root_pid, started_at)
                            == ExactProcessObservation::Running
                        {
                            errors.push(format!(
                                "pane {pane_id} exact root process {root_pid} remained alive after cleanup"
                            ));
                        }
                    }
                }
            }
            _ => errors.push(format!("invalid durable pane identity {pane_id_text}")),
        }

        let pane_error =
            (errors.len() > pane_error_start).then(|| errors[pane_error_start..].join("; "));
        resource.pane_disposition = if pane_error.is_some() {
            ResourceDisposition::CleanupFailed
        } else {
            ResourceDisposition::Cleaned
        };
        if pane_error.is_none() {
            resource.pane_id = None;
            resource.root_pid = None;
            resource.process_started_at = None;
        }
        if let Ok(updated) = coordinator.mark_dispatch_resource_disposition(
            &target.dispatch.id,
            Some(resource.pane_disposition),
            None,
            pane_error.is_none(),
            false,
            Some(reason),
            pane_error.as_deref(),
        ) {
            resource = updated;
        }
    }

    (Some(resource), errors)
}

pub(super) fn cleanup_run_resources(
    state: &SharedState,
    coordinator: &CoordinatorService,
    worktrees: &WorktreeManager,
    run_id: &str,
    reason: &str,
) -> Result<(Vec<DispatchResourceRecord>, Vec<String>)> {
    let mut resources = Vec::new();
    let mut errors = Vec::new();
    for target in coordinator.cleanup_targets_for_run(run_id)? {
        let (resource, mut target_errors) =
            cleanup_dispatch_target(state, coordinator, worktrees, &target, reason);
        if let Some(resource) = resource {
            resources.push(resource);
        }
        errors.append(&mut target_errors);
    }
    Ok((resources, errors))
}

fn reconcile_orchestration_startup(
    state: &SharedState,
    coordinator: &CoordinatorService,
    worktrees: &WorktreeManager,
) -> Result<()> {
    let mut resources = Vec::new();
    let mut cleanup_errors = Vec::new();
    for target in coordinator.active_cleanup_targets()? {
        let retained_reason = target
            .resources
            .as_ref()
            .and_then(|resource| resource.cleanup_reason.as_deref())
            .filter(|reason| {
                matches!(
                    *reason,
                    "cancel"
                        | "reject"
                        | "gate_reject"
                        | "merge_applied"
                        | "launch_failure"
                        | "retry_cleanup"
                )
            });
        let cleanup_reason = retained_reason.unwrap_or("daemon_restart");
        let (resource, mut errors) =
            cleanup_dispatch_target(state, coordinator, worktrees, &target, cleanup_reason);
        if let Some(resource) = resource {
            resources.push(resource);
        }
        cleanup_errors.append(&mut errors);
    }
    require_workers_stopped(&resources, &cleanup_errors)
        .map_err(|error| anyhow::anyhow!("{}: {}", error.code, error.message))?;
    coordinator.reconcile_daemon_restart(Uuid::new_v4(), orchestration_now_millis())?;
    Ok(())
}

pub(super) fn reconstruct_sessions(state: SharedState, sessions_path: &Path) -> Result<()> {
    let mut panes_to_restore = Vec::new();
    let mut persisted_history: HashMap<Uuid, HashSet<Uuid>> = HashMap::new();
    for persisted in load_sessions(sessions_path)? {
        let session_id = persisted.id;
        let workspace_folder = persisted.workspace_folder;
        let sleeping = persisted.sleeping;
        // Orca parity (`HistoryReader.hasRestorableHistory`): a workspace shut
        // down deliberately is NOT reconstructed. Only an unclean exit --
        // crash, machine reboot, or force kill -- leaves `clean_exit` false and
        // therefore rebuilds its panes. This is what makes "close, then open"
        // predictable instead of always resurrecting the previous screen.
        let restorable = !sleeping && !persisted.clean_exit;
        let owned_panes = persisted_history.entry(session_id).or_default();
        for cfg in persisted.panes {
            owned_panes.insert(cfg.pane_id);
            if restorable && cfg.restore_on_start {
                panes_to_restore.push((session_id, workspace_folder.clone(), cfg));
            }
        }
        if persisted.clean_exit {
            // The stale bytes would otherwise be replayed into whatever pane
            // later reuses this id.
            if let Err(error) = remove_session_history(sessions_path, session_id) {
                warn!(?error, %session_id, "failed to drop history after clean exit");
            }
        }
        lock_state(&state).insert_session(
            crate::protocol::SessionMeta {
                id: session_id,
                name: persisted.name,
                pane_count: 0,
                created_at: persisted.created_at,
                workspace_folder,
            },
            persisted.layout_json,
            sleeping,
            persisted.clean_exit,
        );
    }

    for (session_id, workspace_folder, mut cfg) in panes_to_restore {
        if cfg
            .cwd
            .as_deref()
            .is_some_and(|cwd| !Path::new(cwd).is_dir())
        {
            let fallback = workspace_folder.filter(|folder| Path::new(folder).is_dir());
            warn!(
                pane_id = %cfg.pane_id,
                old_cwd = ?cfg.cwd,
                fallback_cwd = ?fallback,
                "restored pane working directory no longer exists"
            );
            cfg.cwd = fallback;
        }
        let pane_id = cfg.pane_id;
        let scrollback = match load_pane_history(sessions_path, session_id, pane_id) {
            Ok(scrollback) => scrollback,
            Err(error) => {
                warn!(?error, %session_id, %pane_id, "failed to load terminal history");
                Vec::new()
            }
        };
        if let Err(error) = restore_pane_for_session(
            Arc::clone(&state),
            sessions_path.to_path_buf(),
            session_id,
            cfg,
            scrollback,
        ) {
            warn!(?error, %session_id, %pane_id, "failed to cold-restore pane");
            let _ = remove_pane_history(sessions_path, session_id, pane_id);
        }
    }
    // Scrollback is normally dropped on an explicit close or a clean exit, so a
    // crash or a lost session record used to leak its history files forever.
    match prune_orphan_history(sessions_path, &persisted_history) {
        Ok(pruned) if !pruned.is_empty() => info!(
            sessions = pruned.sessions,
            panes = pruned.panes,
            "pruned terminal history without a persisted owner"
        ),
        Ok(_) => {}
        Err(error) => warn!(?error, "failed to prune orphaned terminal history"),
    }
    persist_state(&state, sessions_path)
}

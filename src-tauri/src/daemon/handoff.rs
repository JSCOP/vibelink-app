//! Daemon replacement handoff: the lock, the identity files, and the startup
//! stopwatch that shows where a slow start went.
//!
//! Replacing a daemon overlaps two processes. The outgoing one acknowledges the
//! shutdown request before it persists panes, kills their process trees, and
//! releases `daemon.lock`; the incoming one is spawned on that acknowledgement.
//! Everything here exists so that overlap resolves into a handoff instead of
//! into "no daemon at all", which the app can only report as a failed launch.

use super::*;

/// How long an incoming daemon waits for the outgoing one to release the lock
/// during a replacement handoff. Comfortably longer than a teardown (one state
/// persist plus one job-object terminate per pane), well inside the app's
/// startup budget.
pub(super) const LOCK_HANDOFF_TIMEOUT: Duration = Duration::from_secs(5);
const LOCK_HANDOFF_POLL: Duration = Duration::from_millis(50);

#[allow(clippy::incompatible_msrv)]
pub(super) fn acquire_daemon_lock(lock_file: &std::fs::File, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        match lock_file.try_lock() {
            Ok(()) => return true,
            Err(err) if Instant::now() >= deadline => {
                warn!(?err, "daemon lock still held after the handoff wait");
                return false;
            }
            Err(_) => thread::sleep(LOCK_HANDOFF_POLL),
        }
    }
}

/// Removes the pid and identity files only while they still describe THIS
/// process. A replacement overlaps: the successor can already have recorded
/// itself by the time the outgoing daemon finishes killing panes, and deleting
/// its files there left the next app start with no identity to compare against
/// — which reads as "stale" and costs the user another daemon replacement.
pub(super) fn remove_own_identity_files(pid_path: &Path, info_path: &Path) {
    let own_pid = std::process::id();
    let recorded_pid = fs::read_to_string(pid_path)
        .ok()
        .and_then(|contents| contents.trim().parse::<u32>().ok());
    if recorded_pid != Some(own_pid) {
        return;
    }
    let _ = fs::remove_file(pid_path);
    if paths::read_daemon_info(info_path).is_none_or(|info| info.pid == own_pid) {
        let _ = fs::remove_file(info_path);
    }
}

pub(super) struct PidFileGuard {
    path: PathBuf,
    info: PathBuf,
}

impl PidFileGuard {
    pub(super) fn create(path: PathBuf) -> Result<Self> {
        fs::write(&path, std::process::id().to_string())?;
        let mut info_name = path
            .file_stem()
            .unwrap_or_else(|| OsStr::new("daemon"))
            .to_os_string();
        info_name.push("-info.json");
        let info = path.with_file_name(info_name);
        Ok(Self { path, info })
    }
}

impl Drop for PidFileGuard {
    fn drop(&mut self) {
        remove_own_identity_files(&self.path, &self.info);
    }
}

/// Startup phase stopwatch. The daemon binds its socket LAST, so everything
/// before that is time the app spends staring at an unreachable daemon with a
/// frozen window. Logging each phase makes a slow start readable from
/// `daemon.log` instead of guessable from a rebuild.
pub(super) struct StartupPhases {
    started: Instant,
    last: Instant,
}

impl StartupPhases {
    pub(super) fn new() -> Self {
        let now = Instant::now();
        Self {
            started: now,
            last: now,
        }
    }

    pub(super) fn mark(&mut self, phase: &'static str) {
        let now = Instant::now();
        let ms = now.duration_since(self.last).as_millis() as u64;
        self.last = now;
        info!(phase, ms, "daemon startup phase");
    }

    pub(super) fn total_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

#[cfg(test)]
mod handoff_tests {
    use super::*;

    fn temp_path(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("vibelink-{label}-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).expect("create handoff test directory");
        path
    }

    fn open_lock(path: &Path) -> std::fs::File {
        OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .expect("open daemon lock")
    }

    /// The outgoing daemon answers the shutdown request before it releases the
    /// lock, so the incoming daemon regularly arrives while the lock is still
    /// held. Conceding there left the app with no daemon at all.
    #[test]
    #[allow(clippy::incompatible_msrv)]
    fn an_incoming_daemon_waits_out_the_outgoing_lock_holder() {
        let root = temp_path("handoff-lock");
        let lock_path = root.join("daemon.lock");
        let outgoing = open_lock(&lock_path);
        outgoing.lock().expect("outgoing daemon holds the lock");

        let releaser = thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            outgoing
                .unlock()
                .expect("outgoing daemon releases the lock");
        });

        let incoming = open_lock(&lock_path);
        assert!(acquire_daemon_lock(&incoming, Duration::from_secs(5)));

        releaser.join().expect("release thread");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[allow(clippy::incompatible_msrv)]
    fn a_lock_that_is_never_released_still_gives_up() {
        let root = temp_path("handoff-stuck");
        let lock_path = root.join("daemon.lock");
        let holder = open_lock(&lock_path);
        holder.lock().expect("hold the lock");

        let incoming = open_lock(&lock_path);
        assert!(!acquire_daemon_lock(&incoming, Duration::from_millis(150)));

        holder.unlock().expect("release the lock");
        let _ = fs::remove_dir_all(root);
    }

    /// A replacement overlaps: deleting the identity files unconditionally let
    /// the outgoing daemon erase the successor's, and an app that finds no
    /// identity treats the running daemon as stale and replaces it again.
    #[test]
    fn an_exiting_daemon_never_deletes_a_successor_identity() {
        let root = temp_path("handoff-identity");
        let pid_path = root.join("daemon.pid");
        let info_path = root.join("daemon-info.json");
        let successor_pid = std::process::id() + 1;
        fs::write(&pid_path, successor_pid.to_string()).expect("write successor pid");
        let successor = paths::DaemonInfo {
            version: "0.6.7".to_string(),
            exe: PathBuf::from("successor.exe"),
            pid: successor_pid,
            contract: paths::daemon_contract().to_string(),
        };
        fs::write(
            &info_path,
            serde_json::to_vec(&successor).expect("serialize successor info"),
        )
        .expect("write successor info");

        remove_own_identity_files(&pid_path, &info_path);

        assert!(pid_path.exists(), "successor pid file was deleted");
        assert_eq!(paths::read_daemon_info(&info_path), Some(successor));

        // Its own records still go.
        fs::write(&pid_path, std::process::id().to_string()).expect("write own pid");
        fs::write(
            &info_path,
            serde_json::to_vec(&paths::DaemonInfo {
                pid: std::process::id(),
                ..paths::read_daemon_info(&info_path).expect("existing info")
            })
            .expect("serialize own info"),
        )
        .expect("write own info");

        remove_own_identity_files(&pid_path, &info_path);

        assert!(!pid_path.exists());
        assert!(!info_path.exists());

        let _ = fs::remove_dir_all(root);
    }
}

//! Daemon lifecycle guards: orphaned pane-process sweeps and idle shutdown.
//!
//! The daemon deliberately outlives the GUI (`sessionRestore: resume`), so
//! nothing used to bound its lifetime: pane process trees from earlier GUI
//! generations kept accumulating under one long-lived daemon, and a daemon
//! whose owner crashed before connecting stayed resident forever.
//!
//! Orca solves the same problem in `src/main/daemon/daemon-server.ts`
//! (`INITIAL_ADOPTION_TIMEOUT_MS` self-termination plus idle shutdown once every
//! client disconnected and no PTY session remains). VibeLink adds the same two
//! guards here, plus a sweep for shell processes the daemon still parents but no
//! live pane owns.

use std::collections::HashSet;
use std::time::Duration;

use sysinfo::{Pid, ProcessesToUpdate, System};

pub(crate) const DEFAULT_SWEEP_INTERVAL: Duration = Duration::from_secs(30);
pub(crate) const DEFAULT_IDLE_GRACE: Duration = Duration::from_secs(300);
/// Orca parity: `DaemonServer.INITIAL_ADOPTION_TIMEOUT_MS` is two minutes.
pub(crate) const DEFAULT_ADOPTION_TIMEOUT: Duration = Duration::from_secs(120);

const ENV_IDLE_SHUTDOWN: &str = "VIBELINK_DAEMON_IDLE_SHUTDOWN";
const ENV_IDLE_GRACE_SECS: &str = "VIBELINK_DAEMON_IDLE_GRACE_SECS";
const ENV_ADOPTION_TIMEOUT_SECS: &str = "VIBELINK_DAEMON_ADOPTION_TIMEOUT_SECS";
const ENV_SWEEP_INTERVAL_SECS: &str = "VIBELINK_DAEMON_SWEEP_INTERVAL_SECS";

/// Console hosts are started by `conpty.dll` inside the daemon process and exit
/// with their pseudo console, so they are never swept as if they were shells.
/// Terminating one directly would kill the console of a live pane.
const CONSOLE_HOST_IMAGES: [&str; 2] = ["openconsole.exe", "conhost.exe"];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct LifecycleConfig {
    pub sweep_interval: Duration,
    pub idle_grace: Duration,
    pub adoption_timeout: Duration,
    pub idle_shutdown_enabled: bool,
}

impl Default for LifecycleConfig {
    fn default() -> Self {
        Self {
            sweep_interval: DEFAULT_SWEEP_INTERVAL,
            idle_grace: DEFAULT_IDLE_GRACE,
            adoption_timeout: DEFAULT_ADOPTION_TIMEOUT,
            idle_shutdown_enabled: true,
        }
    }
}

impl LifecycleConfig {
    pub fn from_env() -> Self {
        Self::from_lookup(|key| std::env::var(key).ok())
    }

    fn from_lookup<F>(lookup: F) -> Self
    where
        F: Fn(&str) -> Option<String>,
    {
        let mut config = Self::default();
        if let Some(raw) = lookup(ENV_IDLE_SHUTDOWN) {
            config.idle_shutdown_enabled = !matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            );
        }
        if let Some(secs) = lookup(ENV_IDLE_GRACE_SECS).and_then(|raw| parse_secs(&raw)) {
            config.idle_grace = secs;
        }
        if let Some(secs) = lookup(ENV_ADOPTION_TIMEOUT_SECS).and_then(|raw| parse_secs(&raw)) {
            config.adoption_timeout = secs;
        }
        if let Some(secs) = lookup(ENV_SWEEP_INTERVAL_SECS).and_then(|raw| parse_secs(&raw)) {
            config.sweep_interval = secs.max(Duration::from_secs(1));
        }
        config
    }
}

fn parse_secs(raw: &str) -> Option<Duration> {
    raw.trim().parse::<u64>().ok().map(Duration::from_secs)
}

/// Everything that keeps a daemon alive. Any non-zero field means "not idle";
/// an unreadable input must be reported as busy so a probe failure can never
/// terminate a working daemon.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub(crate) struct DaemonActivity {
    pub clients: usize,
    pub live_panes: usize,
    pub scheduled_automations: usize,
    pub remote_running: bool,
}

impl DaemonActivity {
    fn is_idle(&self) -> bool {
        self.clients == 0
            && self.live_panes == 0
            && self.scheduled_automations == 0
            && !self.remote_running
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ShutdownReason {
    /// No client ever connected; the spawning GUI/CLI died before adoption.
    NeverAdopted,
    /// Adopted earlier, but every client disconnected and nothing is left to serve.
    Idle,
}

impl ShutdownReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NeverAdopted => "never-adopted",
            Self::Idle => "idle",
        }
    }
}

/// Tracks adoption and idleness in monotonic ticks. `now` is injected so the
/// decision logic is testable without sleeping.
pub(crate) struct IdleTracker<T> {
    started: T,
    adoption_timeout: Duration,
    idle_grace: Duration,
    enabled: bool,
    adopted: bool,
    idle_since: Option<T>,
}

impl<T: Copy + std::ops::Sub<T, Output = Duration>> IdleTracker<T> {
    pub fn new(started: T, config: LifecycleConfig) -> Self {
        Self {
            started,
            adoption_timeout: config.adoption_timeout,
            idle_grace: config.idle_grace,
            enabled: config.idle_shutdown_enabled,
            adopted: false,
            idle_since: None,
        }
    }

    pub fn observe(&mut self, activity: DaemonActivity, now: T) -> Option<ShutdownReason> {
        if activity.clients > 0 {
            self.adopted = true;
            self.idle_since = None;
            return None;
        }
        if !self.enabled {
            return None;
        }
        if !self.adopted {
            // A pane means the daemon is doing real work even without a client
            // (CLI-driven runs), so only a completely empty daemon expires.
            if activity.live_panes == 0 && now - self.started >= self.adoption_timeout {
                return Some(ShutdownReason::NeverAdopted);
            }
            return None;
        }
        if !activity.is_idle() {
            self.idle_since = None;
            return None;
        }
        let since = *self.idle_since.get_or_insert(now);
        (now - since >= self.idle_grace).then_some(ShutdownReason::Idle)
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ChildProcess {
    pub pid: u32,
    pub name: String,
}

fn is_console_host(name: &str) -> bool {
    let lowered = name.to_ascii_lowercase();
    CONSOLE_HOST_IMAGES.contains(&lowered.as_str())
}

/// Shell processes the daemon still parents while no live pane claims them.
/// Console hosts are excluded because they belong to a pseudo console, not to a
/// pane root PID, and they exit on their own when that console closes.
pub(crate) fn orphan_pane_pids(children: &[ChildProcess], live_roots: &HashSet<u32>) -> Vec<u32> {
    children
        .iter()
        .filter(|child| !is_console_host(&child.name) && !live_roots.contains(&child.pid))
        .map(|child| child.pid)
        .collect()
}

/// Direct children of `daemon_pid` in the refreshed snapshot.
pub(crate) fn daemon_children(sys: &mut System, daemon_pid: u32) -> Vec<ChildProcess> {
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let parent = Pid::from_u32(daemon_pid);
    sys.processes()
        .iter()
        .filter(|(_, process)| process.parent() == Some(parent))
        .map(|(pid, process)| ChildProcess {
            pid: pid.as_u32(),
            name: process.name().to_string_lossy().to_string(),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn child(pid: u32, name: &str) -> ChildProcess {
        ChildProcess {
            pid,
            name: name.to_string(),
        }
    }

    #[test]
    fn console_hosts_and_live_pane_roots_are_never_swept() {
        let children = vec![
            child(10, "pwsh.exe"),
            child(11, "OpenConsole.exe"),
            child(12, "pwsh.exe"),
            child(13, "conhost.exe"),
        ];
        let live: HashSet<u32> = [10].into_iter().collect();

        assert_eq!(orphan_pane_pids(&children, &live), vec![12]);
    }

    #[test]
    fn a_daemon_without_children_has_nothing_to_sweep() {
        assert!(orphan_pane_pids(&[], &HashSet::new()).is_empty());
    }

    #[test]
    fn unadopted_daemon_expires_only_after_the_adoption_timeout() {
        let start = Instant::now();
        let config = LifecycleConfig {
            adoption_timeout: Duration::from_secs(120),
            ..LifecycleConfig::default()
        };
        let mut tracker = IdleTracker::new(start, config);

        assert_eq!(
            tracker.observe(DaemonActivity::default(), start + Duration::from_secs(119)),
            None
        );
        assert_eq!(
            tracker.observe(DaemonActivity::default(), start + Duration::from_secs(120)),
            Some(ShutdownReason::NeverAdopted)
        );
    }

    #[test]
    fn an_unadopted_daemon_with_live_panes_keeps_running() {
        let start = Instant::now();
        let mut tracker = IdleTracker::new(start, LifecycleConfig::default());

        let activity = DaemonActivity {
            live_panes: 1,
            ..DaemonActivity::default()
        };
        assert_eq!(
            tracker.observe(activity, start + Duration::from_secs(600)),
            None
        );
    }

    #[test]
    fn idle_shutdown_requires_the_full_grace_window_after_the_last_client() {
        let start = Instant::now();
        let config = LifecycleConfig {
            idle_grace: Duration::from_secs(300),
            ..LifecycleConfig::default()
        };
        let mut tracker = IdleTracker::new(start, config);
        let connected = DaemonActivity {
            clients: 1,
            ..DaemonActivity::default()
        };

        assert_eq!(tracker.observe(connected, start), None);
        assert_eq!(
            tracker.observe(DaemonActivity::default(), start + Duration::from_secs(10)),
            None
        );
        assert_eq!(
            tracker.observe(DaemonActivity::default(), start + Duration::from_secs(309)),
            None
        );
        assert_eq!(
            tracker.observe(DaemonActivity::default(), start + Duration::from_secs(310)),
            Some(ShutdownReason::Idle)
        );
    }

    #[test]
    fn a_reconnecting_client_restarts_the_idle_window() {
        let start = Instant::now();
        let config = LifecycleConfig {
            idle_grace: Duration::from_secs(60),
            ..LifecycleConfig::default()
        };
        let mut tracker = IdleTracker::new(start, config);
        let connected = DaemonActivity {
            clients: 1,
            ..DaemonActivity::default()
        };

        tracker.observe(connected, start);
        tracker.observe(DaemonActivity::default(), start + Duration::from_secs(30));
        tracker.observe(connected, start + Duration::from_secs(40));
        assert_eq!(
            tracker.observe(DaemonActivity::default(), start + Duration::from_secs(90)),
            None
        );
        assert_eq!(
            tracker.observe(DaemonActivity::default(), start + Duration::from_secs(150)),
            Some(ShutdownReason::Idle)
        );
    }

    #[test]
    fn panes_scheduled_automations_and_remote_all_keep_the_daemon_alive() {
        let start = Instant::now();
        let config = LifecycleConfig {
            idle_grace: Duration::from_secs(1),
            ..LifecycleConfig::default()
        };
        let busy_states = [
            DaemonActivity {
                live_panes: 1,
                ..DaemonActivity::default()
            },
            DaemonActivity {
                scheduled_automations: 1,
                ..DaemonActivity::default()
            },
            DaemonActivity {
                remote_running: true,
                ..DaemonActivity::default()
            },
        ];

        for activity in busy_states {
            let mut tracker = IdleTracker::new(start, config);
            tracker.observe(
                DaemonActivity {
                    clients: 1,
                    ..DaemonActivity::default()
                },
                start,
            );
            assert_eq!(
                tracker.observe(activity, start + Duration::from_secs(600)),
                None,
                "{activity:?} must keep the daemon alive"
            );
        }
    }

    #[test]
    fn disabled_idle_shutdown_never_terminates_the_daemon() {
        let start = Instant::now();
        let config = LifecycleConfig {
            idle_shutdown_enabled: false,
            idle_grace: Duration::from_secs(1),
            adoption_timeout: Duration::from_secs(1),
            ..LifecycleConfig::default()
        };
        let mut tracker = IdleTracker::new(start, config);

        assert_eq!(
            tracker.observe(DaemonActivity::default(), start + Duration::from_secs(3600)),
            None
        );
    }

    #[test]
    fn env_overrides_replace_the_defaults() {
        let config = LifecycleConfig::from_lookup(|key| match key {
            ENV_IDLE_SHUTDOWN => Some("0".to_string()),
            ENV_IDLE_GRACE_SECS => Some("15".to_string()),
            ENV_ADOPTION_TIMEOUT_SECS => Some("7".to_string()),
            ENV_SWEEP_INTERVAL_SECS => Some("0".to_string()),
            _ => None,
        });

        assert!(!config.idle_shutdown_enabled);
        assert_eq!(config.idle_grace, Duration::from_secs(15));
        assert_eq!(config.adoption_timeout, Duration::from_secs(7));
        assert_eq!(config.sweep_interval, Duration::from_secs(1));
    }

    #[test]
    fn unparsable_env_values_keep_the_defaults() {
        let config = LifecycleConfig::from_lookup(|key| match key {
            ENV_IDLE_GRACE_SECS => Some("soon".to_string()),
            _ => None,
        });

        assert_eq!(config.idle_grace, DEFAULT_IDLE_GRACE);
        assert!(config.idle_shutdown_enabled);
    }
}

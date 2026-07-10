use anyhow::{anyhow, Result};
use directories::ProjectDirs;
use std::{env, fs, path::PathBuf};

const PROD_APP_NAME: &str = "VibeLink";
const DEV_APP_NAME: &str = "VibeLink Dev";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonPaths {
    pub data_dir: PathBuf,
    pub sessions: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
    pub pid: PathBuf,
}

pub fn daemon_paths() -> Result<DaemonPaths> {
    let project_dirs = ProjectDirs::from("com", "vibelink", project_app_name())
        .ok_or_else(|| anyhow!("could not resolve project data directory"))?;
    let data_dir = project_dirs.data_dir().to_path_buf();
    fs::create_dir_all(&data_dir)?;

    Ok(DaemonPaths {
        sessions: data_dir.join("sessions.json"),
        lock: data_dir.join("daemon.lock"),
        log: data_dir.join("daemon.log"),
        pid: data_dir.join("daemon.pid"),
        data_dir,
    })
}

pub fn socket_name_string() -> String {
    socket_name_for_user(&current_username())
}

pub fn socket_name_for_user(username: &str) -> String {
    socket_name_for_user_and_flavor(username, app_flavor())
}

pub fn app_flavor() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "prod"
    }
}

fn project_app_name() -> &'static str {
    if cfg!(debug_assertions) {
        DEV_APP_NAME
    } else {
        PROD_APP_NAME
    }
}

fn socket_name_for_user_and_flavor(username: &str, flavor: &str) -> String {
    format!(
        "vibelink-{flavor}-daemon-{:016x}",
        fnv1a64(username.as_bytes())
    )
}

fn current_username() -> String {
    env::var("USERNAME")
        .or_else(|_| env::var("USER"))
        .unwrap_or_else(|_| "unknown".to_string())
}

fn fnv1a64(bytes: &[u8]) -> u64 {
    const OFFSET: u64 = 0xcbf29ce484222325;
    const PRIME: u64 = 0x100000001b3;

    let mut hash = OFFSET;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(PRIME);
    }
    hash
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_names_are_prefixed_and_user_scoped() {
        let alice = socket_name_for_user("alice");
        let alice_again = socket_name_for_user("alice");
        let bob = socket_name_for_user("bob");

        assert!(alice.starts_with(&format!("vibelink-{}-daemon-", app_flavor())));
        assert_eq!(alice, alice_again);
        assert_ne!(alice, bob);
    }

    #[test]
    fn socket_names_are_flavor_scoped() {
        let dev = socket_name_for_user_and_flavor("alice", "dev");
        let prod = socket_name_for_user_and_flavor("alice", "prod");

        assert_ne!(dev, prod);
        assert!(dev.starts_with("vibelink-dev-daemon-"));
        assert!(prod.starts_with("vibelink-prod-daemon-"));
    }

    #[test]
    fn daemon_paths_use_project_data_dir() {
        let paths = daemon_paths().expect("project dirs available");

        assert!(paths
            .data_dir
            .to_string_lossy()
            .contains(project_app_name()));
        assert!(paths.sessions.ends_with("sessions.json"));
        assert!(paths.lock.ends_with("daemon.lock"));
        assert!(paths.log.ends_with("daemon.log"));
        assert!(paths.pid.ends_with("daemon.pid"));
    }
}

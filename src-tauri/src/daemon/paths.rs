use anyhow::{anyhow, Result};
use directories::ProjectDirs;
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use std::process::Command;
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
};

pub(crate) const PROD_APP_NAME: &str = "VibeLink";
pub(crate) const DEV_APP_NAME: &str = "VibeLink Dev";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonPaths {
    pub data_dir: PathBuf,
    pub sessions: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
    pub pid: PathBuf,
    pub info: PathBuf,
    pub auth_token: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonInfo {
    pub version: String,
    pub exe: PathBuf,
    pub pid: u32,
    /// Fingerprint of the daemon-side sources this daemon was built from
    /// (`VIBELINK_DAEMON_CONTRACT`). The app replaces a running daemon when
    /// this differs from its own, NOT when the app version differs: the GUI and
    /// the daemon ship in one executable, so a frontend-only release must not
    /// take the user's terminal panes down with it. An info file written before
    /// this field existed reads back empty and is therefore always replaced
    /// once.
    #[serde(default)]
    pub contract: String,
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
        info: data_dir.join("daemon-info.json"),
        auth_token: data_dir.join("daemon-auth.token"),
        data_dir,
    })
}

pub fn read_daemon_info(path: &Path) -> Option<DaemonInfo> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Fingerprint of the daemon-side sources this build was compiled from, as
/// computed by `build.rs`. Two builds that share it run the same daemon
/// behaviour even when their app versions differ.
pub fn daemon_contract() -> &'static str {
    env!("VIBELINK_DAEMON_CONTRACT")
}

pub fn socket_name_string() -> String {
    socket_name_for_identity(&current_user_sid())
}

pub fn socket_name_for_user(username: &str) -> String {
    socket_name_for_identity(username)
}

pub fn app_flavor() -> &'static str {
    if cfg!(debug_assertions) {
        "dev"
    } else {
        "prod"
    }
}

pub(crate) fn host_runtime_for_flavor(flavor: &str) -> &'static str {
    if flavor == "dev" {
        "development"
    } else {
        "release"
    }
}

pub(crate) fn host_protected_for_flavor(flavor: &str) -> bool {
    flavor != "dev"
}

pub(crate) fn app_name_for_flavor(flavor: &str) -> &'static str {
    if flavor == "dev" {
        DEV_APP_NAME
    } else {
        PROD_APP_NAME
    }
}

fn project_app_name() -> &'static str {
    app_name_for_flavor(app_flavor())
}

fn socket_name_for_identity(identity: &str) -> String {
    socket_name_for_user_and_flavor(identity, app_flavor())
}

fn socket_name_for_user_and_flavor(identity: &str, flavor: &str) -> String {
    format!(
        "vibelink-{flavor}-daemon-{:016x}",
        fnv1a64(identity.as_bytes())
    )
}

pub fn current_user_sid() -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        if let Ok(output) = Command::new("whoami.exe")
            .args(["/user", "/fo", "csv", "/nh"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if output.status.success() {
                let text = String::from_utf8_lossy(&output.stdout);
                if let Some(sid) = text
                    .split(',')
                    .map(|part| part.trim().trim_matches('"'))
                    .find(|part| part.starts_with("S-1-"))
                {
                    return sid.to_string();
                }
            }
        }
    }
    env::var("USERDOMAIN")
        .ok()
        .zip(env::var("USERNAME").ok())
        .map(|(domain, user)| format!("{domain}\\{user}"))
        .or_else(|| env::var("USER").ok())
        .unwrap_or_else(|| "unknown".to_string())
}

pub fn load_or_create_boot_token(path: &Path) -> Result<String> {
    if let Ok(token) = fs::read_to_string(path) {
        let token = token.trim().to_string();
        if token.len() == 64 && token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            restrict_token_acl(path)?;
            return Ok(token);
        }
    }
    let mut bytes = [0_u8; 32];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut bytes);
    let token = bytes
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let temporary = path.with_extension("token.tmp");
    let mut file = fs::OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)?;
    file.write_all(token.as_bytes())?;
    file.sync_all()?;
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temporary, path)?;
    restrict_token_acl(path)?;
    Ok(token)
}

pub fn daemon_auth_material() -> Result<(String, String)> {
    let paths = daemon_paths()?;
    let token = fs::read_to_string(&paths.auth_token)?;
    Ok((token.trim().to_string(), current_user_sid()))
}

#[cfg(windows)]
fn restrict_token_acl(path: &Path) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let sid = current_user_sid();
    let status = Command::new("icacls.exe")
        .arg(path)
        .args(["/inheritance:r", "/grant:r", &format!("*{sid}:F")])
        .creation_flags(CREATE_NO_WINDOW)
        .status()?;
    if !status.success() {
        anyhow::bail!("failed to restrict daemon authentication token ACL");
    }
    Ok(())
}

#[cfg(not(windows))]
fn restrict_token_acl(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    Ok(())
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
    fn runtime_identity_is_flavor_scoped() {
        assert_eq!(host_runtime_for_flavor("dev"), "development");
        assert_eq!(host_runtime_for_flavor("prod"), "release");
        assert!(!host_protected_for_flavor("dev"));
        assert!(host_protected_for_flavor("prod"));
        assert_eq!(app_name_for_flavor("dev"), "VibeLink Dev");
        assert_eq!(app_name_for_flavor("prod"), "VibeLink");
    }

    #[test]
    fn daemon_info_read_handles_missing_corrupt_and_valid_files() {
        let path = std::env::temp_dir().join(format!(
            "vibelink-daemon-info-{}-{}.json",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let expected = DaemonInfo {
            version: "0.5.24".to_string(),
            exe: PathBuf::from(r"C:\VibeLink\daemon-bin\app-daemon-prod-current.exe"),
            pid: 35_588,
            contract: "0004a1-1122334455667788".to_string(),
        };

        assert_eq!(read_daemon_info(&path), None);
        fs::write(&path, b"{not-json").expect("write corrupt daemon info");
        assert_eq!(read_daemon_info(&path), None);
        fs::write(
            &path,
            serde_json::to_vec(&expected).expect("serialize daemon info"),
        )
        .expect("write daemon info");
        assert_eq!(read_daemon_info(&path), Some(expected));

        // An info file written before the contract field existed must still
        // parse; it reads back empty so the app replaces that daemon once.
        fs::write(
            &path,
            br#"{"version":"0.6.0","exe":"C:\\old.exe","pid":11}"#,
        )
        .expect("write legacy daemon info");
        assert_eq!(
            read_daemon_info(&path).map(|info| info.contract),
            Some(String::new())
        );

        let _ = fs::remove_file(path);
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
        assert!(paths.info.ends_with("daemon-info.json"));
        assert!(paths.auth_token.ends_with("daemon-auth.token"));
    }
}

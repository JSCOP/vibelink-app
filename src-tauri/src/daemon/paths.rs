use anyhow::{anyhow, Result};
use directories::ProjectDirs;
use std::{
    env, fs,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

const PROD_APP_NAME: &str = "VibeLink";
const DEV_APP_NAME: &str = "VibeLink Dev";

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DaemonPaths {
    pub data_dir: PathBuf,
    pub sessions: PathBuf,
    pub lock: PathBuf,
    pub log: PathBuf,
    pub pid: PathBuf,
    pub auth_token: PathBuf,
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
        auth_token: data_dir.join("daemon-auth.token"),
        data_dir,
    })
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

fn project_app_name() -> &'static str {
    if cfg!(debug_assertions) {
        DEV_APP_NAME
    } else {
        PROD_APP_NAME
    }
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
        assert!(paths.auth_token.ends_with("daemon-auth.token"));
    }
}

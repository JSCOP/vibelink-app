use anyhow::{Context, Result};
use serde::Serialize;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const VERSION_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Copy)]
struct AgentProbe {
    id: &'static str,
    display_name: &'static str,
    binaries: &'static [&'static str],
    login_hint: &'static str,
    auth_file: Option<&'static str>,
}

const AGENT_PROBES: [AgentProbe; 4] = [
    AgentProbe {
        id: "claude",
        display_name: "Claude Code",
        binaries: &["claude"],
        login_hint: "claude",
        auth_file: Some(".claude/.credentials.json"),
    },
    AgentProbe {
        id: "codex",
        display_name: "Codex",
        binaries: &["codex"],
        login_hint: "codex login",
        auth_file: Some(".codex/auth.json"),
    },
    AgentProbe {
        id: "omp",
        display_name: "Oh My Pi",
        binaries: &["omp"],
        login_hint: "omp",
        auth_file: None,
    },
    AgentProbe {
        id: "opencode",
        display_name: "OpenCode",
        binaries: &["opencode"],
        login_hint: "opencode auth login",
        auth_file: None,
    },
];

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCliStatus {
    pub id: String,
    pub display_name: String,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub auth: AuthState,
    pub login_hint: String,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthState {
    LoggedIn,
    LoggedOut,
    Unknown,
}

#[tauri::command]
pub async fn agent_cli_status() -> Result<Vec<AgentCliStatus>, String> {
    tauri::async_runtime::spawn_blocking(agent_cli_status_native)
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())
}

pub fn agent_cli_status_native() -> Result<Vec<AgentCliStatus>> {
    AGENT_PROBES.iter().map(probe_agent).collect()
}

fn probe_agent(probe: &AgentProbe) -> Result<AgentCliStatus> {
    let path = probe
        .binaries
        .iter()
        .find_map(|binary| crate::daemon::pty::resolve_program(binary));
    let installed = path.is_some();
    let version = path
        .as_deref()
        .and_then(|path| run_version_probe(Path::new(path), VERSION_TIMEOUT).ok())
        .and_then(first_non_empty_line);
    let auth = probe.auth_file.map_or(AuthState::Unknown, |relative| {
        user_home()
            .map(|home| home.join(relative))
            .filter(|path| path.is_file())
            .map(|_| AuthState::LoggedIn)
            .unwrap_or(AuthState::Unknown)
    });

    Ok(AgentCliStatus {
        id: probe.id.to_string(),
        display_name: probe.display_name.to_string(),
        installed,
        path,
        version,
        auth,
        login_hint: probe.login_hint.to_string(),
    })
}

fn run_version_probe(program: &Path, timeout: Duration) -> Result<String> {
    let mut command = command_for_program(program);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .with_context(|| format!("run {} --version", program.display()))?;
    let deadline = Instant::now() + timeout;
    loop {
        if child.try_wait()?.is_some() {
            let output = child.wait_with_output()?;
            let stdout = String::from_utf8_lossy(&output.stdout);
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Ok(if stdout.trim().is_empty() {
                stderr.trim().to_string()
            } else {
                stdout.trim().to_string()
            });
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            anyhow::bail!("version probe timed out");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
}

fn command_for_program(program: &Path) -> Command {
    #[cfg(windows)]
    if program
        .extension()
        .and_then(OsStr::to_str)
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("cmd") || extension.eq_ignore_ascii_case("bat")
        })
    {
        let mut command =
            Command::new(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
        command.arg("/D").arg("/S").arg("/C").arg(program);
        return command;
    }
    Command::new(program)
}

fn first_non_empty_line(output: String) -> Option<String> {
    output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
}

fn user_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

#[cfg(test)]
fn resolve_from_path(program: &str, path: &OsStr, extensions: &[&str]) -> Option<PathBuf> {
    std::env::split_paths(path).find_map(|dir| {
        let direct = dir.join(program);
        if direct.is_file() {
            return Some(direct);
        }
        extensions
            .iter()
            .map(|extension| dir.join(format!("{program}{extension}")))
            .find(|candidate| candidate.is_file())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_table_has_supported_agents_and_login_hints() {
        assert_eq!(
            AGENT_PROBES.map(|probe| probe.id),
            ["claude", "codex", "omp", "opencode"]
        );
        assert_eq!(AGENT_PROBES[1].login_hint, "codex login");
        assert_eq!(AGENT_PROBES[3].login_hint, "opencode auth login");
    }

    #[test]
    fn fake_path_resolves_windows_command_stub() {
        let dir =
            std::env::temp_dir().join(format!("vibelink-agent-path-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create fake path");
        let stub = dir.join("claude.cmd");
        std::fs::write(&stub, "@echo claude 1.0").expect("write stub");
        let path = std::env::join_paths([&dir]).expect("join path");

        assert_eq!(
            resolve_from_path("claude", &path, &[".exe", ".cmd", ".bat"]),
            Some(stub)
        );
        std::fs::remove_dir_all(dir).expect("cleanup fake path");
    }

    #[cfg(windows)]
    #[test]
    fn version_probe_times_out_and_stops_owned_child() {
        let command =
            PathBuf::from(std::env::var_os("COMSPEC").unwrap_or_else(|| "cmd.exe".into()));
        let mut child = Command::new(&command)
            .args(["/D", "/S", "/C", "ping -n 3 127.0.0.1 >NUL"])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .expect("spawn timeout child");
        let deadline = Instant::now() + Duration::from_millis(20);
        while Instant::now() < deadline && child.try_wait().expect("poll child").is_none() {
            std::thread::sleep(Duration::from_millis(2));
        }
        if child.try_wait().expect("poll after timeout").is_none() {
            child.kill().expect("kill owned child");
        }
        let status = child.wait().expect("reap owned child");
        assert!(!status.success());
    }
}

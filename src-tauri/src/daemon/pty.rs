use crate::daemon::{paths, scrollback::ScrollbackRing};
use crate::protocol::{PaneConfig, PaneMeta};
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    env,
    ffi::OsString,
    io::{Read, Write},
    path::PathBuf,
    process::Command,
    sync::{Arc, Mutex, OnceLock},
};
use uuid::Uuid;

pub const DEFAULT_SCROLLBACK_CAP: usize = 1024 * 1024;
const TERMINAL_CAPABILITY_ENV: [(&str, &str); 5] = [
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("FORCE_COLOR", "1"),
    ("CLICOLOR_FORCE", "1"),
    ("TERM_PROGRAM", "AgenticWorkspaceTerminal"),
];

pub type SharedChild = Arc<Mutex<Box<dyn Child + Send + Sync>>>;
pub type SharedKiller = Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>;

pub struct SpawnedPane {
    pub pane: Pane,
    pub reader: Box<dyn Read + Send>,
}

pub struct Pane {
    pub id: Uuid,
    pub config: PaneConfig,
    pub alive: bool,
    child: SharedChild,
    killer: SharedKiller,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    master: Box<dyn MasterPty + Send>,
    scrollback: ScrollbackRing,
}

impl Pane {
    pub fn spawn(mut config: PaneConfig) -> Result<SpawnedPane> {
        config.cols = config.cols.max(1);
        config.rows = config.rows.max(1);
        config.env = with_runtime_agent_env(with_terminal_capability_env(config.env));

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: config.rows,
            cols: config.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut command = command_builder(&config);
        for arg in &config.args {
            command.arg(arg);
        }
        if let Some(cwd) = &config.cwd {
            command.cwd(cwd);
        }
        #[cfg(windows)]
        if let Some(path) = windows_effective_path() {
            command.env("PATH", path);
        }
        // AWT owns a real PTY; inherited process-manager color suppression must not
        // make terminal apps render monochrome. Explicit pane env below can still
        // re-add these for users who intentionally want no color.
        command.env_remove("NO_COLOR");
        command.env_remove("NODE_DISABLE_COLORS");
        for (key, value) in &config.env {
            command.env(key, value);
        }

        let child = pair
            .slave
            .spawn_command(command)
            .context("spawn pty command")?;
        let killer = child.clone_killer();
        let reader = pair.master.try_clone_reader().context("clone pty reader")?;
        let writer = pair.master.take_writer().context("take pty writer")?;

        Ok(SpawnedPane {
            pane: Pane {
                id: config.pane_id,
                config,
                alive: true,
                child: Arc::new(Mutex::new(child)),
                killer: Arc::new(Mutex::new(killer)),
                writer: Arc::new(Mutex::new(writer)),
                master: pair.master,
                scrollback: ScrollbackRing::new(DEFAULT_SCROLLBACK_CAP),
            },
            reader,
        })
    }

    pub fn meta(&self) -> PaneMeta {
        PaneMeta {
            id: self.id,
            config: self.config.clone(),
            alive: self.alive,
        }
    }

    pub fn write(&self, bytes: &[u8]) -> Result<()> {
        let mut writer = self.writer.lock().expect("pty writer mutex poisoned");
        writer.write_all(bytes)?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
    }

    pub fn kill(&mut self) -> Result<()> {
        self.alive = false;
        self.killer
            .lock()
            .expect("pty child killer mutex poisoned")
            .kill()?;
        Ok(())
    }

    pub fn child(&self) -> SharedChild {
        Arc::clone(&self.child)
    }

    pub fn push_scrollback(&mut self, bytes: &[u8]) {
        self.scrollback.push(bytes);
    }

    pub fn scrollback_snapshot(&self) -> Vec<u8> {
        self.scrollback.snapshot()
    }

    #[cfg(test)]
    pub(crate) fn for_test(config: PaneConfig, alive: bool) -> Self {
        Self {
            id: config.pane_id,
            config,
            alive,
            child: Arc::new(Mutex::new(
                Box::new(FakeChild) as Box<dyn Child + Send + Sync>
            )),
            killer: Arc::new(Mutex::new(
                Box::new(FakeChild) as Box<dyn ChildKiller + Send + Sync>
            )),
            writer: Arc::new(Mutex::new(
                Box::new(std::io::sink()) as Box<dyn Write + Send>
            )),
            master: Box::new(FakeMaster),
            scrollback: ScrollbackRing::new(DEFAULT_SCROLLBACK_CAP),
        }
    }
}

#[cfg(test)]
#[derive(Debug)]
struct FakeChild;

#[cfg(test)]
impl portable_pty::ChildKiller for FakeChild {
    fn kill(&mut self) -> std::io::Result<()> {
        Ok(())
    }

    fn clone_killer(&self) -> Box<dyn portable_pty::ChildKiller + Send + Sync> {
        Box::new(FakeChild)
    }
}

#[cfg(test)]
impl Child for FakeChild {
    fn try_wait(&mut self) -> std::io::Result<Option<portable_pty::ExitStatus>> {
        Ok(Some(portable_pty::ExitStatus::with_exit_code(0)))
    }

    fn wait(&mut self) -> std::io::Result<portable_pty::ExitStatus> {
        Ok(portable_pty::ExitStatus::with_exit_code(0))
    }

    fn process_id(&self) -> Option<u32> {
        None
    }

    #[cfg(windows)]
    fn as_raw_handle(&self) -> Option<std::os::windows::io::RawHandle> {
        None
    }
}

#[cfg(test)]
struct FakeMaster;

#[cfg(test)]
impl MasterPty for FakeMaster {
    fn resize(&self, _size: PtySize) -> Result<()> {
        Ok(())
    }

    fn get_size(&self) -> Result<PtySize> {
        Ok(PtySize::default())
    }

    fn try_clone_reader(&self) -> Result<Box<dyn Read + Send>> {
        Ok(Box::new(std::io::empty()))
    }

    fn take_writer(&self) -> Result<Box<dyn Write + Send>> {
        Ok(Box::new(std::io::sink()))
    }
}

fn command_builder(config: &PaneConfig) -> CommandBuilder {
    CommandBuilder::new(command_program(config, default_shell))
}

fn with_terminal_capability_env(env: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut next = env;
    for (key, value) in TERMINAL_CAPABILITY_ENV {
        if !next.iter().any(|(existing, _)| existing.eq_ignore_ascii_case(key)) {
            next.push((key.to_string(), value.to_string()));
        }
    }
    next
}

fn with_runtime_agent_env(env: Vec<(String, String)>) -> Vec<(String, String)> {
    let mut next: Vec<_> = env
        .into_iter()
        .filter(|(key, _)| {
            !key.eq_ignore_ascii_case("AWT_APP_EXE") && !key.eq_ignore_ascii_case("AWT_APP_FLAVOR")
        })
        .collect();
    if let Ok(exe) = env::current_exe() {
        next.push((
            "AWT_APP_EXE".to_string(),
            exe.to_string_lossy().into_owned(),
        ));
    }
    next.push((
        "AWT_APP_FLAVOR".to_string(),
        paths::app_flavor().to_string(),
    ));
    next
}

pub(crate) fn inject_pane_identity(env: Vec<(String, String)>, session_id: Uuid, pane_id: Uuid) -> Vec<(String, String)> {
    let mut next: Vec<_> = env
        .into_iter()
        .filter(|(key, _)| {
            !key.eq_ignore_ascii_case("AWT_SESSION_ID") && !key.eq_ignore_ascii_case("AWT_PANE_ID")
        })
        .collect();
    next.push(("AWT_SESSION_ID".to_string(), session_id.to_string()));
    next.push(("AWT_PANE_ID".to_string(), pane_id.to_string()));
    next
}

pub(crate) fn command_program<F>(config: &PaneConfig, default: F) -> String
where
    F: FnOnce() -> String,
{
    config
        .shell
        .as_deref()
        .map(resolve_program)
        .unwrap_or_else(|| Some(default()))
        .unwrap_or_else(|| config.shell.clone().expect("shell is present"))
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        resolve_program("pwsh.exe")
            .or_else(|| resolve_program("powershell.exe"))
            .or_else(|| resolve_program("cmd.exe"))
            .unwrap_or_else(|| "cmd.exe".to_string())
    }

    #[cfg(not(windows))]
    {
        if let Ok(shell) = std::env::var("SHELL") {
            if !shell.is_empty() {
                return shell;
            }
        }
        if std::path::Path::new("/bin/bash").exists() {
            "/bin/bash".to_string()
        } else {
            "/bin/sh".to_string()
        }
    }
}

#[cfg(windows)]
fn resolve_program(program: &str) -> Option<String> {
    let path = PathBuf::from(program);
    if path.components().count() > 1 {
        return path.is_file().then(|| program.to_string());
    }

    program_on_path(program)
        .or_else(|| known_windows_program(program))
        .map(|path| path.to_string_lossy().into_owned())
}

#[cfg(not(windows))]
fn resolve_program(program: &str) -> Option<String> {
    Some(program.to_string())
}

#[cfg(windows)]
fn program_on_path(program: &str) -> Option<PathBuf> {
    let has_extension = PathBuf::from(program).extension().is_some();
    let extensions = if has_extension {
        Vec::new()
    } else {
        windows_path_extensions()
    };

    windows_effective_path().and_then(|path| {
        std::env::split_paths(&path).find_map(|dir| {
            let direct = dir.join(program);
            if direct.is_file() {
                return Some(direct);
            }
            extensions
                .iter()
                .map(|extension| dir.join(format!("{program}{extension}")))
                .find(|candidate| candidate.is_file())
        })
    })
}

#[cfg(windows)]
fn windows_path_extensions() -> Vec<String> {
    std::env::var_os("PATHEXT")
        .map(|value| {
            value
                .to_string_lossy()
                .split(';')
                .filter_map(normalize_path_extension)
                .collect::<Vec<_>>()
        })
        .filter(|extensions| !extensions.is_empty())
        .unwrap_or_else(|| [".COM", ".EXE", ".BAT", ".CMD"].map(String::from).to_vec())
}

#[cfg(windows)]
fn normalize_path_extension(extension: &str) -> Option<String> {
    let trimmed = extension.trim();
    if trimmed.is_empty() {
        None
    } else if trimmed.starts_with('.') {
        Some(trimmed.to_string())
    } else {
        Some(format!(".{trimmed}"))
    }
}

#[cfg(windows)]
fn known_windows_program(program: &str) -> Option<PathBuf> {
    let lower = program.to_ascii_lowercase();
    match lower.as_str() {
        "pwsh" | "pwsh.exe" => [
            PathBuf::from(r"C:\Program Files\PowerShell\7\pwsh.exe"),
            PathBuf::from(r"C:\Program Files (x86)\PowerShell\7\pwsh.exe"),
        ]
        .into_iter()
        .find(|path| path.is_file()),
        "powershell" | "powershell.exe" => {
            system_root_program(r"System32\WindowsPowerShell\v1.0\powershell.exe")
        }
        "cmd" | "cmd.exe" => std::env::var_os("COMSPEC")
            .map(PathBuf::from)
            .filter(|path| path.is_file())
            .or_else(|| system_root_program(r"System32\cmd.exe")),
        "ssh" | "ssh.exe" => system_root_program(r"System32\OpenSSH\ssh.exe"),
        _ => None,
    }
}

#[cfg(windows)]
fn system_root_program(relative: &str) -> Option<PathBuf> {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .map(|root| root.join(relative))
        .filter(|path| path.is_file())
}

#[cfg(windows)]
fn windows_effective_path() -> Option<OsString> {
    static PATH: OnceLock<Option<OsString>> = OnceLock::new();
    PATH.get_or_init(build_windows_effective_path).clone()
}

#[cfg(windows)]
fn build_windows_effective_path() -> Option<OsString> {
    let mut paths = Vec::new();
    push_path_list(&mut paths, env::var("PATH").ok().as_deref());
    push_path_list(
        &mut paths,
        read_registry_string(
            r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment",
            "Path",
        )
        .as_deref(),
    );
    push_path_list(
        &mut paths,
        read_registry_string(r"HKCU\Environment", "Path").as_deref(),
    );

    if let Ok(appdata) = env::var("APPDATA") {
        push_path(&mut paths, format!(r"{appdata}\npm"));
    }
    if let Ok(localappdata) = env::var("LOCALAPPDATA") {
        push_path(&mut paths, format!(r"{localappdata}\pnpm"));
    }
    if let Ok(userprofile) = env::var("USERPROFILE") {
        push_path(&mut paths, format!(r"{userprofile}\.cargo\bin"));
    }

    (!paths.is_empty()).then(|| OsString::from(paths.join(";")))
}

#[cfg(windows)]
fn push_path_list(paths: &mut Vec<String>, value: Option<&str>) {
    if let Some(value) = value {
        for path in value.split(';') {
            push_path(paths, expand_env_vars(path.trim()));
        }
    }
}

#[cfg(windows)]
fn push_path(paths: &mut Vec<String>, path: String) {
    let normalized = path.trim().trim_matches('"');
    if normalized.is_empty() {
        return;
    }
    if paths
        .iter()
        .any(|existing| existing.eq_ignore_ascii_case(normalized))
    {
        return;
    }
    paths.push(normalized.to_string());
}

#[cfg(windows)]
fn read_registry_string(hive: &str, value: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;

    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let output = Command::new("reg.exe")
        .args(["query", hive, "/v", value])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .find_map(|line| parse_registry_value_line(line, value))
}

#[cfg(windows)]
fn parse_registry_value_line(line: &str, value: &str) -> Option<String> {
    let trimmed = line.trim();
    if !trimmed.get(..value.len())?.eq_ignore_ascii_case(value) {
        return None;
    }
    let rest = trimmed[value.len()..].trim_start();
    let rest = rest
        .strip_prefix("REG_EXPAND_SZ")
        .or_else(|| rest.strip_prefix("REG_SZ"))?
        .trim_start();
    Some(expand_env_vars(rest))
}

#[cfg(windows)]
fn expand_env_vars(value: &str) -> String {
    let mut expanded = String::with_capacity(value.len());
    let mut rest = value;
    while let Some(start) = rest.find('%') {
        expanded.push_str(&rest[..start]);
        let after_start = &rest[start + 1..];
        let Some(end) = after_start.find('%') else {
            expanded.push('%');
            expanded.push_str(after_start);
            return expanded;
        };
        let key = &after_start[..end];
        if let Ok(replacement) = env::var(key) {
            expanded.push_str(&replacement);
        } else {
            expanded.push('%');
            expanded.push_str(key);
            expanded.push('%');
        }
        rest = &after_start[end + 1..];
    }
    expanded.push_str(rest);
    expanded
}

#[cfg(not(windows))]
fn program_on_path(_program: &str) -> Option<PathBuf> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_shell_wins_over_default_shell() {
        let cfg = test_config(Some("custom-shell"));

        assert_eq!(
            command_program(&cfg, || "fallback-shell".to_string()),
            "custom-shell"
        );
    }

    #[cfg(windows)]
    #[test]
    fn registry_path_lines_are_expanded() {
        let userprofile = env::var("USERPROFILE").expect("USERPROFILE set");

        assert_eq!(
            parse_registry_value_line(
                r"    Path    REG_EXPAND_SZ    %USERPROFILE%\AppData\Roaming\npm",
                "Path"
            ),
            Some(format!(r"{userprofile}\AppData\Roaming\npm"))
        );
    }

    #[cfg(windows)]
    #[test]
    fn push_path_deduplicates_case_insensitively() {
        let mut paths = Vec::new();

        push_path(&mut paths, r"C:\Tools".to_string());
        push_path(&mut paths, r"c:\tools".to_string());

        assert_eq!(paths, vec![r"C:\Tools".to_string()]);
    }

    #[test]
    fn default_shell_fallback_is_used_when_shell_missing() {
        let cfg = test_config(None);

        assert_eq!(
            command_program(&cfg, || "fallback-shell".to_string()),
            "fallback-shell"
        );
    }

    #[test]
    fn terminal_capability_env_adds_color_defaults_without_overriding_user_values() {
        let entries = with_terminal_capability_env(vec![
            ("TERM".to_string(), "xterm-direct".to_string()),
            ("OTHER".to_string(), "value".to_string()),
        ]);

        assert!(entries.contains(&("TERM".to_string(), "xterm-direct".to_string())));
        assert!(entries.contains(&("COLORTERM".to_string(), "truecolor".to_string())));
        assert!(entries.contains(&("FORCE_COLOR".to_string(), "1".to_string())));
        assert!(entries.contains(&("CLICOLOR_FORCE".to_string(), "1".to_string())));
        assert!(entries.contains(&("TERM_PROGRAM".to_string(), "AgenticWorkspaceTerminal".to_string())));
        assert!(entries.contains(&("OTHER".to_string(), "value".to_string())));
        assert_eq!(entries.iter().filter(|(key, _)| key.eq_ignore_ascii_case("TERM")).count(), 1);
    }

    #[test]
    fn runtime_agent_env_records_current_binary_and_flavor() {
        let entries = with_runtime_agent_env(vec![
            ("AWT_APP_EXE".to_string(), "wrong.exe".to_string()),
            ("OTHER".to_string(), "value".to_string()),
        ]);

        let expected_exe = env::current_exe()
            .expect("current exe")
            .to_string_lossy()
            .into_owned();

        assert!(entries.contains(&("OTHER".to_string(), "value".to_string())));
        assert!(entries.contains(&("AWT_APP_EXE".to_string(), expected_exe)));
        assert!(entries.contains(&(
            "AWT_APP_FLAVOR".to_string(),
            paths::app_flavor().to_string()
        )));
        assert!(!entries.contains(&("AWT_APP_EXE".to_string(), "wrong.exe".to_string())));
    }

    #[test]
    fn inject_pane_identity_records_session_and_pane() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let entries = inject_pane_identity(vec![
            ("awt_session_id".to_string(), "wrong-session".to_string()),
            ("AWT_PANE_ID".to_string(), "wrong-pane".to_string()),
            ("OTHER".to_string(), "value".to_string()),
        ], session_id, pane_id);

        assert!(entries.contains(&("OTHER".to_string(), "value".to_string())));
        assert!(entries.contains(&("AWT_SESSION_ID".to_string(), session_id.to_string())));
        assert!(entries.contains(&("AWT_PANE_ID".to_string(), pane_id.to_string())));
        assert_eq!(entries.iter().filter(|(key, _)| key.eq_ignore_ascii_case("AWT_SESSION_ID")).count(), 1);
        assert_eq!(entries.iter().filter(|(key, _)| key.eq_ignore_ascii_case("AWT_PANE_ID")).count(), 1);
    }

    #[test]
    fn kill_does_not_wait_for_child_lock() {
        let pane = Pane::for_test(test_config(Some("cmd.exe")), true);
        let child = pane.child();
        let guard = child.lock().expect("test child mutex poisoned");
        let (tx, rx) = std::sync::mpsc::channel();

        let handle = std::thread::spawn(move || {
            let mut pane = pane;
            let result = pane.kill().map(|_| ());
            let _ = tx.send(result);
        });

        let result = rx.recv_timeout(std::time::Duration::from_millis(100));
        drop(guard);
        handle.join().expect("kill thread panicked");

        assert!(result.expect("kill blocked on child lock").is_ok());
    }

    fn test_config(shell: Option<&str>) -> PaneConfig {
        PaneConfig {
            pane_id: Uuid::new_v4(),
            shell: shell.map(str::to_string),
            args: vec![],
            cwd: None,
            env: vec![],
            title: None,
            icon: None,
            cols: 80,
            rows: 24,
        }
    }
}

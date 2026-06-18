use crate::daemon::scrollback::ScrollbackRing;
use crate::protocol::{PaneConfig, PaneMeta};
use anyhow::{Context, Result};
use portable_pty::{native_pty_system, Child, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::{Arc, Mutex},
};
use uuid::Uuid;

pub const DEFAULT_SCROLLBACK_CAP: usize = 1024 * 1024;

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

    pub fn mark_exited(&mut self) {
        self.alive = false;
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
    std::env::var_os("PATH").and_then(|path| {
        std::env::split_paths(&path)
            .map(|dir| dir.join(program))
            .find(|candidate| candidate.is_file())
    })
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

#[cfg(not(windows))]
fn program_on_path(_program: &str) -> bool {
    false
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

    #[test]
    fn default_shell_fallback_is_used_when_shell_missing() {
        let cfg = test_config(None);

        assert_eq!(
            command_program(&cfg, || "fallback-shell".to_string()),
            "fallback-shell"
        );
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
            cols: 80,
            rows: 24,
        }
    }
}

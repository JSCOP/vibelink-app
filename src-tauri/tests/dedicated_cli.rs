#![allow(dead_code, unused_imports)]

#[path = "../src/browser/mod.rs"]
mod browser;
#[path = "../src/control_plane.rs"]
mod control_plane;
#[path = "../src/daemon/paths.rs"]
pub mod daemon_paths;
#[path = "../src/dedicated_cli/mod.rs"]
pub mod dedicated_cli;
#[path = "../src/protocol.rs"]
mod protocol;
#[path = "../src/runtime_ports.rs"]
mod runtime_ports;
#[path = "../src/storage.rs"]
mod storage;
#[path = "../src/app/spawn_daemon.rs"]
pub mod spawn_daemon;
pub mod daemon {
    pub use crate::daemon_paths as paths;
}

pub mod app {
    pub use crate::spawn_daemon;
}

pub mod mcp {
    pub fn run(_args: impl IntoIterator<Item = String>) -> anyhow::Result<()> {
        Ok(())
    }
}

use dedicated_cli::{
    builtin_skills, parse_args, resolve_selector, ControlSocketConfig, Flavor, SelectorCandidate,
};

#[test]
fn public_modules_compose_without_gui_or_legacy_cli() {
    let invocation = parse_args([
        "orchestration",
        "run",
        "--workspace",
        "workspace-1",
        "--goal",
        "ship typed CLI",
        "--json",
    ])
    .expect("parse dedicated CLI invocation");
    assert!(invocation.json);
    assert_eq!(builtin_skills().len(), 5);

    let candidates = [SelectorCandidate::new(
        "workspace-1",
        "workspace-1",
        "Primary",
    )];
    assert_eq!(
        *resolve_selector("workspace", "Primary", &candidates).expect("resolve workspace"),
        "workspace-1"
    );
}

#[test]
fn dedicated_cli_discovers_the_daemon_sid_socket_for_current_flavor() {
    let config = ControlSocketConfig::detect(Some(Flavor::Dev), std::time::Duration::from_secs(1))
        .expect("detect control socket");
    assert_eq!(config.socket_name(), daemon_paths::socket_name_string());
}
#[cfg(windows)]
#[test]
fn install_script_copies_and_uninstalls_without_touching_path() {
    use std::process::Command;

    let root = std::env::temp_dir().join(format!("vibelink-cli-install-{}", uuid::Uuid::new_v4()));
    let source = std::env::current_exe().expect("current test executable");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("scripts")
        .join("install-cli.ps1");
    let install = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-SourcePath")
        .arg(&source)
        .arg("-InstallDirectory")
        .arg(&root)
        .args(["-Flavor", "dev", "-NoPathUpdate", "-SkipSmoke", "-PassThru"])
        .output()
        .expect("run CLI installer");
    assert!(
        install.status.success(),
        "installer failed: {}",
        String::from_utf8_lossy(&install.stderr)
    );
    assert!(root.join("vibelink.exe").is_file());

    let uninstall = Command::new("powershell.exe")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"])
        .arg(&script)
        .arg("-InstallDirectory")
        .arg(&root)
        .args([
            "-Flavor",
            "dev",
            "-NoPathUpdate",
            "-SkipSmoke",
            "-Uninstall",
            "-PassThru",
        ])
        .output()
        .expect("run CLI uninstaller");
    assert!(
        uninstall.status.success(),
        "uninstaller failed: {}",
        String::from_utf8_lossy(&uninstall.stderr)
    );
    assert!(!root.join("vibelink.exe").exists());
    let _ = std::fs::remove_dir_all(root);
}

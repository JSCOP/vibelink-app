pub mod agent_runtime;
pub mod app;
#[path = "daemon/automation.rs"]
pub mod automation;
pub mod browser;
pub mod computer_use;
pub mod control_plane;
pub mod daemon;
pub mod dedicated_cli;
pub mod orchestration;
pub mod persistence;
pub mod protocol;
pub mod remote;
pub mod worktree_storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {}

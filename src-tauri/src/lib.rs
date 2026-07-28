pub mod agent_runtime;
#[path = "daemon/automation.rs"]
pub mod automation;
pub mod browser;
pub mod control_plane;
pub mod dedicated_cli;
pub mod orchestration;
pub mod protocol;
pub mod worktree_storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {}

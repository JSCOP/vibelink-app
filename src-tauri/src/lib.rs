pub mod agent_runtime;
pub mod app;
pub use daemon::automation;
pub mod browser;
pub mod computer_use;
pub mod control_plane;
pub mod daemon;
pub mod dedicated_cli;
pub mod mcp;
pub mod orchestration;
pub mod persistence;
pub mod protocol;
pub mod remote;
pub mod runtime_ports;
pub mod storage;
pub mod worktree_storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {}

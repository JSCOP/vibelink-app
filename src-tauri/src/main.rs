// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod agent_runtime;
mod app;
mod browser;
mod computer_use;
mod control_plane;
mod daemon;
mod dedicated_cli;
mod orchestration;
mod persistence;
mod protocol;
mod remote;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--daemon") {
        daemon::run();
    } else {
        app::run();
    }
}

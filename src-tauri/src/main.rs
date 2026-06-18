// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod daemon;
mod protocol;

fn main() {
    if std::env::args().any(|arg| arg == "--daemon") {
        daemon::run();
    } else {
        app::run();
    }
}

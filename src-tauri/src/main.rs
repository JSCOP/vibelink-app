// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod daemon;
mod mcp;
mod protocol;

fn main() {
    if std::env::args().any(|arg| arg == "--daemon") {
        daemon::run();
    } else if std::env::args().any(|arg| arg == "--mcp") {
        if let Err(err) = mcp::run() {
            eprintln!("MCP server error: {}", err);
            std::process::exit(1);
        }
    } else {
        app::run();
    }
}

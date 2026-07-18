// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod cli;
mod daemon;
mod mcp;
mod protocol;
mod remote;
mod storage;

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    match args.get(1).map(String::as_str) {
        Some("--daemon") => daemon::run(),
        Some("cli") => {
            if let Err(err) = cli::run(args.into_iter().skip(1)) {
                eprintln!("CLI error: {err}");
                std::process::exit(1);
            }
        }
        Some("mcp") => {
            if let Err(err) = mcp::run(args.into_iter().skip(1)) {
                eprintln!("MCP error: {err}");
                std::process::exit(1);
            }
        }
        _ => app::run(),
    }
}

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
    let first = std::env::args().nth(1);
    match first.as_deref() {
        Some("--daemon") => daemon::run(),
        // Anything that looks like a CLI invocation MUST NOT start a desktop
        // window. `app.exe` used to treat every unrecognised argv as a plain
        // launch, so a stale agent-completion hook baking in `app.exe` spawned
        // a SECOND full GUI per agent turn. Each extra instance attached to the
        // same daemon session and refit every pane to its own default window,
        // making the live grid oscillate between two column counts.
        Some(domain) if dedicated_cli::is_command_domain(domain) => {
            eprintln!(
                "'{domain}' is a VibeLink CLI command; run it through vibelink.exe, not app.exe"
            );
            std::process::exit(2);
        }
        _ => app::run(),
    }
}

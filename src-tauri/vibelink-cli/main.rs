#![allow(dead_code, unused_imports)]

#[path = "../src/agent_runtime/mod.rs"]
mod agent_runtime;
#[path = "../src/app/mod.rs"]
mod app;
#[path = "../src/browser/mod.rs"]
mod browser;
#[path = "../src/computer_use/mod.rs"]
mod computer_use;
#[path = "../src/control_plane.rs"]
mod control_plane;
#[path = "../src/daemon/mod.rs"]
mod daemon;
#[path = "../src/dedicated_cli/mod.rs"]
mod dedicated_cli;
#[path = "../src/mcp/mod.rs"]
mod mcp;
#[path = "../src/orchestration/mod.rs"]
mod orchestration;
#[path = "../src/persistence.rs"]
mod persistence;
#[path = "../src/protocol.rs"]
mod protocol;
#[path = "../src/remote/mod.rs"]
mod remote;
#[path = "../src/storage.rs"]
mod storage;
#[path = "../src/worktree_storage.rs"]
mod worktree_storage;

use dedicated_cli::{run_with_io, CliError, SocketExecutor};

fn main() {
    let mut executor = SocketExecutor;
    let mut mcp = || {
        mcp::run(["mcp".to_string(), "serve".to_string()])
            .map_err(|error| CliError::internal(error.to_string()))
    };
    let exit_code = run_with_io(
        std::env::args().skip(1),
        &mut executor,
        &mut mcp,
        std::io::stdout(),
        std::io::stderr(),
    );
    if exit_code != 0 {
        std::process::exit(exit_code);
    }
}

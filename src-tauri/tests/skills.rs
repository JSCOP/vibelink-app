#![allow(dead_code, unused_imports)]

#[path = "../src/browser/mod.rs"]
mod browser;
#[path = "../src/control_plane.rs"]
mod control_plane;
#[path = "../src/daemon/paths.rs"]
pub mod daemon_paths;
#[path = "../src/dedicated_cli/mod.rs"]
mod dedicated_cli;
#[path = "../src/protocol.rs"]
mod protocol;

pub mod daemon {
    pub use crate::daemon_paths as paths;
}

#[path = "../src/app/skills.rs"]
mod skills;

use anyhow::{Context, Result};
use std::path::PathBuf;

pub fn dedicated_cli_path() -> Result<PathBuf> {
    let executable = std::env::current_exe().context("resolve VibeLink executable")?;
    let directory = executable
        .parent()
        .context("VibeLink executable has no parent directory")?;
    Ok(directory.join(if cfg!(windows) {
        "vibelink.exe"
    } else {
        "vibelink"
    }))
}

pub fn computer_host_path() -> Result<PathBuf> {
    let executable = std::env::current_exe().context("resolve VibeLink executable")?;
    let directory = executable
        .parent()
        .context("VibeLink executable has no parent directory")?;
    Ok(directory.join(if cfg!(windows) {
        "vibelink-computer-host.exe"
    } else {
        "vibelink-computer-host"
    }))
}

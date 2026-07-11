mod audio;
mod engine;
mod inject;
mod model;
mod mute;
mod protocol;
mod server;
mod state;

use std::path::PathBuf;

use anyhow::{Context, Result};
use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::protocol::SidecarConfig;
use crate::state::SharedState;

#[derive(Debug, Parser)]
#[command(
    name = "vibelink-voice-sidecar",
    about = "VibeLink local voice-to-text sidecar"
)]
struct Cli {
    #[arg(long)]
    port: u16,
    #[arg(long)]
    token: String,
    #[arg(long)]
    models_dir: PathBuf,
}

fn main() -> Result<()> {
    init_tracing();
    let cli = Cli::parse();
    let state = SharedState::new(SidecarConfig::default(), cli.models_dir)
        .context("failed to initialize voice sidecar state")?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .context("failed to create Tokio runtime")?;
    runtime.block_on(server::run("127.0.0.1", cli.port, state, cli.token))
}

fn init_tracing() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let _ = tracing_subscriber::fmt().with_env_filter(filter).try_init();
}

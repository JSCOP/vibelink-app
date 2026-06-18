#![allow(dead_code)]

#[path = "../src/daemon/paths.rs"]
mod paths;
#[path = "../src/protocol.rs"]
mod protocol;

use anyhow::{bail, Result};
use interprocess::local_socket::{prelude::*, ConnectOptions, GenericNamespaced};
use protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, ReplyResult};

fn main() -> Result<()> {
    let name = paths::socket_name_string().to_ns_name::<GenericNamespaced>()?;
    let mut stream = ConnectOptions::new().name(name).connect_sync()?;
    write_frame(&mut stream, &ClientToDaemon::ListSessions { req: 1 })?;
    match read_frame::<_, DaemonToClient>(&mut stream)? {
        DaemonToClient::Reply {
            result: ReplyResult::Sessions(sessions),
            ..
        } => {
            let leaked_smoke: Vec<_> = sessions
                .iter()
                .filter(|session| session.name == "Smoke" && session.pane_count > 0)
                .collect();
            if leaked_smoke.is_empty() {
                println!("no persisted Smoke panes will be reconstructed");
                Ok(())
            } else {
                bail!("Smoke sessions would reconstruct panes on startup: {leaked_smoke:?}")
            }
        }
        other => bail!("unexpected list response: {other:?}"),
    }
}

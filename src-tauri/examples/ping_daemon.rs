#![allow(dead_code)]

#[path = "../src/daemon/paths.rs"]
mod paths;
#[path = "../src/protocol.rs"]
mod protocol;

use anyhow::{bail, Result};
use interprocess::local_socket::{prelude::*, ConnectOptions, GenericNamespaced};
use protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient};

fn main() -> Result<()> {
    let name = paths::socket_name_string().to_ns_name::<GenericNamespaced>()?;
    let mut stream = ConnectOptions::new().name(name).connect_sync()?;
    write_frame(&mut stream, &ClientToDaemon::Ping { req: 1 })?;
    match read_frame::<_, DaemonToClient>(&mut stream)? {
        DaemonToClient::Pong { req: 1 } => Ok(()),
        other => bail!("unexpected daemon response: {other:?}"),
    }
}

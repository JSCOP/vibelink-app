#![allow(dead_code)]

#[path = "../src/control_plane.rs"]
mod control_plane;
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
    write_frame(&mut stream, &ClientToDaemon::Shutdown { req: 1 })?;
    match read_frame::<_, DaemonToClient>(&mut stream)? {
        DaemonToClient::Reply {
            req: 1,
            result: ReplyResult::Ok,
        } => {
            println!("daemon accepted graceful shutdown");
            Ok(())
        }
        other => bail!("unexpected shutdown response: {other:?}"),
    }
}

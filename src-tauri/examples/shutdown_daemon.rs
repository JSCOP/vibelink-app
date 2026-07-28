#![allow(dead_code)]

use anyhow::{bail, Result};
use app_lib::{
    app::spawn_daemon,
    protocol::{read_frame, write_frame, ClientKind, ClientToDaemon, DaemonToClient, ReplyResult},
};

fn main() -> Result<()> {
    let mut stream = spawn_daemon::ensure_daemon_for(ClientKind::Shutdown)?;
    write_frame(
        &mut stream,
        &ClientToDaemon::Shutdown {
            req: 1,
            clean_exit: false,
        },
    )?;
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

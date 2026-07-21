#![allow(dead_code)]

#[path = "../src/control_plane.rs"]
mod control_plane;
#[path = "../src/daemon/paths.rs"]
mod paths;
#[path = "../src/protocol.rs"]
mod protocol;

use anyhow::{bail, Result};
use control_plane::{ControlCommand, ControlResponse};
use interprocess::local_socket::{prelude::*, ConnectOptions, GenericNamespaced};
use protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, ReplyResult};
use uuid::Uuid;

fn main() -> Result<()> {
    let name = paths::socket_name_string().to_ns_name::<GenericNamespaced>()?;
    let mut stream = ConnectOptions::new().name(name).connect_sync()?;
    write_frame(
        &mut stream,
        &ClientToDaemon::Hello {
            client_id: Uuid::new_v4(),
        },
    )?;

    let session_id = Uuid::new_v4().to_string();
    let operation_id = Uuid::new_v4();
    let create = ControlCommand::TaskCreate {
        session_id: session_id.clone(),
        title: "Control plane smoke".to_string(),
        description: Some("daemon-owned SQLite RPC".to_string()),
    };
    let first = control(&mut stream, 1, operation_id, create.clone())?;
    let replay = control(&mut stream, 2, operation_id, create)?;
    let (ControlResponse::Task(first), ControlResponse::Task(replay)) = (first, replay) else {
        bail!("task create did not return task responses");
    };
    if first.id != replay.id {
        bail!("idempotent replay created a different task");
    }

    let board = control(
        &mut stream,
        3,
        Uuid::new_v4(),
        ControlCommand::BoardRead {
            session_id: session_id.clone(),
        },
    )?;
    let ControlResponse::Board(board) = board else {
        bail!("board read did not return a board");
    };
    if board.revision != 1 || board.task_order != vec![first.id.clone()] {
        bail!("unexpected board after create: {board:?}");
    }

    control(
        &mut stream,
        4,
        Uuid::new_v4(),
        ControlCommand::TaskDelete {
            session_id: session_id.clone(),
            task_id: first.id,
        },
    )?;
    let after = control(
        &mut stream,
        5,
        Uuid::new_v4(),
        ControlCommand::BoardRead { session_id },
    )?;
    let ControlResponse::Board(after) = after else {
        bail!("final board read did not return a board");
    };
    if after.revision != 2 || !after.task_order.is_empty() {
        bail!("control smoke cleanup did not persist: {after:?}");
    }

    println!("control plane smoke passed: idempotency, revision, cleanup");
    Ok(())
}

fn control(
    stream: &mut interprocess::local_socket::Stream,
    req: u64,
    operation_id: Uuid,
    command: ControlCommand,
) -> Result<ControlResponse> {
    write_frame(
        stream,
        &ClientToDaemon::Control {
            req,
            operation_id,
            command_json: serde_json::to_string(&command)?,
        },
    )?;
    loop {
        match read_frame::<_, DaemonToClient>(stream)? {
            DaemonToClient::Reply {
                req: reply_req,
                result: ReplyResult::Control(response_json),
            } if reply_req == req => return Ok(serde_json::from_str(&response_json)?),
            DaemonToClient::Error {
                req: Some(reply_req),
                message,
            } if reply_req == req => bail!(message),
            _ => continue,
        }
    }
}

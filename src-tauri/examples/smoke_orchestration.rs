#![allow(dead_code)]

#[path = "../src/daemon/paths.rs"]
mod paths;
#[path = "../src/protocol.rs"]
mod protocol;

use anyhow::{bail, Result};
use interprocess::local_socket::{prelude::*, ConnectOptions, GenericNamespaced};
use protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, ReplyResult};
use serde_json::{json, Value};
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

    let operation_id = Uuid::new_v4();
    let payload = json!({
        "sessionId": Uuid::new_v4().to_string(),
        "goal": "Verify orchestration daemon authority",
        "policy": { "maxConcurrent": 2 }
    });
    let first = orchestration(&mut stream, 1, operation_id, "run.create", &payload)?;
    let replay = orchestration(&mut stream, 2, operation_id, "run.create", &payload)?;
    let first_id = first["data"]["id"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("missing run id"))?;
    if replay["data"]["id"] != first_id {
        bail!("idempotent orchestration replay returned a different run");
    }

    let conflict = orchestration(
        &mut stream,
        3,
        operation_id,
        "run.create",
        &json!({
            "sessionId": Uuid::new_v4().to_string(),
            "goal": "Different request",
            "policy": { "maxConcurrent": 1 }
        }),
    )?;
    if conflict["ok"] != false || conflict["error"]["code"] != "conflict" {
        bail!("operation conflict did not return typed error: {conflict}");
    }

    let run = orchestration(
        &mut stream,
        4,
        Uuid::new_v4(),
        "run.get",
        &json!({ "id": first_id }),
    )?;
    if run["data"]["goal"] != "Verify orchestration daemon authority" {
        bail!("run query returned unexpected data: {run}");
    }

    println!("orchestration smoke passed: daemon RPC, idempotency, typed conflict");
    Ok(())
}

fn orchestration(
    stream: &mut interprocess::local_socket::Stream,
    req: u64,
    operation_id: Uuid,
    method: &str,
    payload: &Value,
) -> Result<Value> {
    write_frame(
        stream,
        &ClientToDaemon::Orchestration {
            req,
            operation_id,
            method: method.to_string(),
            payload_json: serde_json::to_string(payload)?,
        },
    )?;
    loop {
        match read_frame::<_, DaemonToClient>(stream)? {
            DaemonToClient::Reply {
                req: reply_req,
                result: ReplyResult::Orchestration(response_json),
            } if reply_req == req => return Ok(serde_json::from_str(&response_json)?),
            DaemonToClient::Error {
                req: Some(reply_req),
                message,
            } if reply_req == req => bail!(message),
            _ => continue,
        }
    }
}

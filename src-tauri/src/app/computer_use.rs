use super::{license::LicenseService, spawn_daemon};
use crate::protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, ReplyResult};
use anyhow::{bail, Context, Result};
use interprocess::local_socket::prelude::*;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

#[tauri::command]
pub async fn computer_request(
    license: State<'_, Arc<LicenseService>>,
    operation_id: String,
    request_json: String,
) -> Result<String, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        let operation_id =
            Uuid::parse_str(&operation_id).context("invalid computer operation id")?;
        request_computer(operation_id, &request_json)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

fn request_computer(operation_id: Uuid, request_json: &str) -> Result<String> {
    let stream = spawn_daemon::connect_daemon().or_else(|_| spawn_daemon::ensure_daemon())?;
    let (mut reader, mut writer) = stream.split();
    write_frame(
        &mut writer,
        &ClientToDaemon::Hello {
            client_id: Uuid::new_v4(),
        },
    )?;
    let req = 1;
    write_frame(
        &mut writer,
        &ClientToDaemon::Computer {
            req,
            operation_id,
            request_json: request_json.to_string(),
        },
    )?;
    loop {
        match read_frame::<_, DaemonToClient>(&mut reader)? {
            DaemonToClient::Reply {
                req: reply_req,
                result: ReplyResult::Computer(response_json),
            } if reply_req == req => return Ok(response_json),
            DaemonToClient::Error {
                req: Some(reply_req),
                message,
            } if reply_req == req => bail!(message),
            _ => continue,
        }
    }
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

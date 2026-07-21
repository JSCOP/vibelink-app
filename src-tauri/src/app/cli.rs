use super::license::LicenseService;
use crate::dedicated_cli::{parse_args, ControlExecutor, SocketExecutor};
use serde_json::Value;
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub async fn cli_request(
    license: State<'_, Arc<LicenseService>>,
    args: Vec<String>,
) -> Result<Value, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        let invocation = parse_args(args).map_err(to_string)?;
        let mut executor = SocketExecutor;
        executor.execute(invocation).map_err(to_string)
    })
    .await
    .map_err(to_string)?
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

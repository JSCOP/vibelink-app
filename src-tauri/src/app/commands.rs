use super::daemon_client::{parse_uuid, DaemonClient, TerminalEvent};
use crate::protocol::{ClientToDaemon, PaneConfig, PaneMeta, ReplyResult, SessionMeta};
use tauri::{ipc::Channel, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedSession {
    pub layout_json: Option<String>,
    pub panes: Vec<PaneMeta>,
}

#[tauri::command]
pub async fn ping(client: State<'_, DaemonClient>) -> Result<(), String> {
    client.ping().map_err(to_string)
}

#[tauri::command]
pub async fn init_terminal_output(
    client: State<'_, DaemonClient>,
    channel: Channel<TerminalEvent>,
) -> Result<(), String> {
    client.set_output_channel(channel);
    Ok(())
}

#[tauri::command]
pub async fn list_sessions(client: State<'_, DaemonClient>) -> Result<Vec<SessionMeta>, String> {
    match client
        .request_reply(|req| ClientToDaemon::ListSessions { req })
        .map_err(to_string)?
    {
        ReplyResult::Sessions(sessions) => Ok(sessions),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn create_session(
    client: State<'_, DaemonClient>,
    name: String,
) -> Result<SessionMeta, String> {
    match client
        .request_reply(|req| ClientToDaemon::CreateSession { req, name })
        .map_err(to_string)?
    {
        ReplyResult::SessionCreated(meta) => Ok(meta),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn rename_session(
    client: State<'_, DaemonClient>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::RenameSession {
        req,
        session_id,
        name,
    }))
}

#[tauri::command]
pub async fn delete_session(
    client: State<'_, DaemonClient>,
    session_id: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::DeleteSession { req, session_id }))
}

#[tauri::command]
pub async fn attach_session(
    client: State<'_, DaemonClient>,
    session_id: String,
) -> Result<AttachedSession, String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    match client
        .request_reply(|req| ClientToDaemon::AttachSession { req, session_id })
        .map_err(to_string)?
    {
        ReplyResult::Attached { layout_json, panes } => Ok(AttachedSession { layout_json, panes }),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn detach_session(
    client: State<'_, DaemonClient>,
    session_id: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::DetachSession { session_id })
        .map_err(to_string)
}

#[tauri::command]
pub async fn save_layout(
    client: State<'_, DaemonClient>,
    session_id: String,
    layout_json: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::SaveLayout {
            session_id,
            layout_json,
        })
        .map_err(to_string)
}

#[tauri::command]
pub async fn spawn_pane(
    client: State<'_, DaemonClient>,
    session_id: String,
    cfg: PaneConfig,
) -> Result<PaneMeta, String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    match client
        .request_reply(|req| ClientToDaemon::SpawnPane {
            req,
            session_id,
            cfg,
        })
        .map_err(to_string)?
    {
        ReplyResult::PaneSpawned(meta) => Ok(meta),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn attach_pane(client: State<'_, DaemonClient>, pane_id: String) -> Result<(), String> {
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::AttachPane { pane_id })
        .map_err(to_string)
}

#[tauri::command]
pub async fn write_pane(
    client: State<'_, DaemonClient>,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::WritePane {
            pane_id,
            data: data.into_bytes(),
        })
        .map_err(to_string)
}

#[tauri::command]
pub async fn resize_pane(
    client: State<'_, DaemonClient>,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::ResizePane {
            pane_id,
            cols,
            rows,
        })
        .map_err(to_string)
}

#[tauri::command]
pub async fn set_pane_title(
    client: State<'_, DaemonClient>,
    pane_id: String,
    title: String,
) -> Result<(), String> {
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::SetPaneTitle {
        req,
        pane_id,
        title,
    }))
}

#[tauri::command]
pub async fn close_pane(client: State<'_, DaemonClient>, pane_id: String) -> Result<(), String> {
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::ClosePane { req, pane_id }))
}

fn expect_ok(result: anyhow::Result<ReplyResult>) -> Result<(), String> {
    match result.map_err(to_string)? {
        ReplyResult::Ok => Ok(()),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

fn to_string(err: anyhow::Error) -> String {
    err.to_string()
}

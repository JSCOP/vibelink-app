use super::daemon_client::{parse_uuid, DaemonClient, TerminalEvent};
use super::license::LicenseService;
use crate::protocol::{ClientToDaemon, PaneConfig, PaneMeta, ReplyResult, SessionMeta};
use crate::remote::{PairingPayload, RemoteServer, RemoteStatus};
use serde_json::Value;
use std::sync::Arc;
use tauri::{ipc::Channel, State};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedSession {
    pub layout_json: Option<String>,
    pub panes: Vec<PaneMeta>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceProc {
    pub pid: u32,
    pub mem_bytes: u64,
    pub process_count: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePane {
    pub session_id: String,
    pub pane_id: String,
    pub root_pid: Option<u32>,
    pub mem_bytes: u64,
    pub process_count: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshotDto {
    pub daemon: ResourceProc,
    pub app: ResourceProc,
    pub panes: Vec<ResourcePane>,
    pub total_mem_bytes: u64,
}

#[tauri::command]
pub async fn ping(client: State<'_, DaemonClient>) -> Result<(), String> {
    client.ping().map_err(to_string)
}

#[tauri::command]
pub async fn set_keep_terminals_alive_on_close(
    prefs: State<'_, super::KeepAlivePrefs>,
    value: bool,
) -> Result<(), String> {
    prefs.0.store(value, std::sync::atomic::Ordering::Release);
    Ok(())
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
pub fn terminal_ws_port(client: State<'_, DaemonClient>) -> u16 {
    client.ws_port()
}

#[tauri::command]
pub fn remote_get_status(remote: State<'_, Arc<RemoteServer>>) -> RemoteStatus {
    remote.status()
}

#[tauri::command]
pub async fn remote_set_enabled(
    remote: State<'_, Arc<RemoteServer>>,
    enabled: bool,
) -> Result<RemoteStatus, String> {
    remote.set_enabled(enabled).map_err(to_string)
}

#[tauri::command]
pub async fn remote_set_port(
    remote: State<'_, Arc<RemoteServer>>,
    port: u16,
) -> Result<RemoteStatus, String> {
    remote.set_port(port).map_err(to_string)
}

#[tauri::command]
pub async fn remote_create_pairing(
    remote: State<'_, Arc<RemoteServer>>,
) -> Result<PairingPayload, String> {
    remote.create_pairing().map_err(to_string)
}

#[tauri::command]
pub async fn remote_revoke_device(
    remote: State<'_, Arc<RemoteServer>>,
    device_id: String,
) -> Result<(), String> {
    remote.revoke_device(&device_id).map_err(to_string)
}

#[tauri::command]
pub async fn remote_regenerate_identity(
    remote: State<'_, Arc<RemoteServer>>,
) -> Result<RemoteStatus, String> {
    remote.regenerate_identity().map_err(to_string)
}

#[tauri::command]
pub async fn set_remote_appearance(
    remote: State<'_, Arc<RemoteServer>>,
    appearance: Value,
    workspace_order: Vec<String>,
    workspace_alerts: std::collections::HashMap<String, usize>,
) -> Result<(), String> {
    remote.set_appearance(appearance, workspace_order, workspace_alerts);
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
pub async fn resource_snapshot(
    client: State<'_, DaemonClient>,
) -> Result<ResourceSnapshotDto, String> {
    let data = match client
        .request_reply(|req| ClientToDaemon::ResourceSnapshot { req })
        .map_err(to_string)?
    {
        ReplyResult::ResourceSnapshot(data) => data,
        other => return Err(format!("unexpected daemon response: {other:?}")),
    };

    let mut sys = sysinfo::System::new();
    sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
    let app_pid = std::process::id();
    let (app_mem_bytes, app_process_count) = crate::daemon::proc::tree_metrics(&sys, app_pid);
    let panes: Vec<_> = data
        .panes
        .into_iter()
        .map(|pane| ResourcePane {
            session_id: pane.session_id.to_string(),
            pane_id: pane.pane_id.to_string(),
            root_pid: pane.root_pid,
            mem_bytes: pane.mem_bytes,
            process_count: pane.process_count,
        })
        .collect();
    let pane_mem_bytes = panes.iter().map(|pane| pane.mem_bytes).sum::<u64>();
    let total_mem_bytes = data.daemon_mem_bytes + app_mem_bytes + pane_mem_bytes;

    Ok(ResourceSnapshotDto {
        daemon: ResourceProc {
            pid: data.daemon_pid,
            mem_bytes: data.daemon_mem_bytes,
            process_count: 1,
        },
        app: ResourceProc {
            pid: app_pid,
            mem_bytes: app_mem_bytes,
            process_count: app_process_count,
        },
        panes,
        total_mem_bytes,
    })
}

#[tauri::command]
pub async fn restart_daemon(client: State<'_, DaemonClient>) -> Result<(), String> {
    let client = client.inner().clone();
    tauri::async_runtime::spawn_blocking(move || client.restart())
        .await
        .map_err(|err| err.to_string())?
        .map_err(to_string)
}

#[tauri::command]
pub async fn create_session(
    client: State<'_, DaemonClient>,
    name: String,
    workspace_folder: Option<String>,
) -> Result<SessionMeta, String> {
    match client
        .request_reply(|req| ClientToDaemon::CreateSession {
            req,
            name,
            workspace_folder,
        })
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
            attach: true,
        })
        .map_err(to_string)?
    {
        ReplyResult::PaneSpawned(meta) => Ok(meta),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn attach_pane(
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::AttachPane {
            session_id,
            pane_id,
        })
        .map_err(to_string)
}

#[tauri::command]
pub async fn write_pane(
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::WritePane {
            session_id,
            pane_id,
            data: data.into_bytes(),
        })
        .map_err(to_string)
}

#[tauri::command]
pub async fn resize_pane(
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::ResizePane {
            session_id,
            pane_id,
            cols,
            rows,
        })
        .map_err(to_string)
}

#[tauri::command]
pub async fn set_pane_title(
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
    title: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::SetPaneTitle {
        req,
        session_id,
        pane_id,
        title,
    }))
}

#[tauri::command]
pub async fn set_pane_role(
    client: State<'_, DaemonClient>,
    license: State<'_, Arc<LicenseService>>,
    session_id: String,
    pane_id: String,
    role: Option<String>,
) -> Result<(), String> {
    license.require_pro_cached().map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::SetPaneRole {
        req,
        session_id,
        pane_id,
        role,
    }))
}

#[tauri::command]
pub async fn close_pane(
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::ClosePane {
        req,
        session_id,
        pane_id,
    }))
}

#[tauri::command]
pub async fn clear_session(
    client: State<'_, DaemonClient>,
    session_id: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::ClearSession { req, session_id }))
}

#[tauri::command]
pub async fn list_installed_fonts() -> Result<Vec<String>, String> {
    list_fonts_native().map_err(to_string)
}

#[cfg(windows)]
fn list_fonts_native() -> anyhow::Result<Vec<String>> {
    use std::collections::BTreeSet;
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    let mut fonts = BTreeSet::new();
    for hive in [
        r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
        r"HKCU\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Fonts",
    ] {
        let output = Command::new("reg.exe")
            .args(["query", hive])
            .creation_flags(CREATE_NO_WINDOW)
            .output()?;
        if !output.status.success() {
            continue;
        }
        for line in String::from_utf8_lossy(&output.stdout).lines() {
            if let Some(font) = parse_font_registry_line(line) {
                fonts.insert(font);
            }
        }
    }
    Ok(fonts.into_iter().collect())
}

#[cfg(not(windows))]
fn list_fonts_native() -> anyhow::Result<Vec<String>> {
    Ok(Vec::new())
}

#[cfg(windows)]
fn parse_font_registry_line(line: &str) -> Option<String> {
    let name = line.split("REG_").next()?.trim();
    if name.is_empty() || name.starts_with("HKEY_") {
        return None;
    }
    let family = name
        .split(" & ")
        .next()
        .unwrap_or(name)
        .split('(')
        .next()
        .unwrap_or(name)
        .trim();
    (!family.is_empty()).then(|| family.to_string())
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

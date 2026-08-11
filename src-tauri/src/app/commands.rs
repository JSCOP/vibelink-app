use super::daemon_client::{parse_uuid, DaemonClient, TerminalEvent};
use super::{authorization::Capability, entitlement::EntitlementSupervisor};
use crate::protocol::{
    AttentionSnapshotData, ClientToDaemon, DesktopSelection, PaneCommandOrigin, PaneConfig,
    PaneMeta, RemotePaneLeaseAdminReclaimRequest, RemotePaneLeaseResult, ReplyResult, SessionMeta,
    TerminalSnapshot,
};
use crate::remote::{PairingPayload, RemotePaneLeaseStatus, RemoteStatus};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, LazyLock, Mutex},
};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{ipc::Channel, AppHandle, Manager as _, State};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
static RESOURCE_SYSTEM: LazyLock<Mutex<System>> = LazyLock::new(|| Mutex::new(System::new()));

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedSession {
    pub layout_json: Option<String>,
    pub panes: Vec<PaneMeta>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshotResult {
    pub session_id: String,
    pub pane_id: String,
    pub pane_generation: String,
    pub output_sequence: String,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub data_base64: String,
}

impl From<TerminalSnapshot> for TerminalSnapshotResult {
    fn from(snapshot: TerminalSnapshot) -> Self {
        Self {
            session_id: snapshot.session_id.to_string(),
            pane_id: snapshot.pane_id.to_string(),
            pane_generation: snapshot.pane_generation.to_string(),
            output_sequence: snapshot.output_sequence.to_string(),
            cols: snapshot.cols,
            rows: snapshot.rows,
            alive: snapshot.alive,
            data_base64: BASE64_STANDARD.encode(snapshot.data),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceProcess {
    pub pid: u32,
    pub name: String,
    pub cpu_percent_x10: u32,
    pub mem_bytes: u64,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceProc {
    pub pid: u32,
    pub cpu_percent_x10: u32,
    pub mem_bytes: u64,
    pub process_count: u32,
    pub processes: Vec<ResourceProcess>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourcePane {
    pub session_id: String,
    pub pane_id: String,
    pub root_pid: Option<u32>,
    pub title: Option<String>,
    pub role: Option<String>,
    pub cpu_percent_x10: u32,
    pub mem_bytes: u64,
    pub process_count: u32,
    pub processes: Vec<ResourceProcess>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshotDto {
    pub daemon: ResourceProc,
    pub app: ResourceProc,
    pub panes: Vec<ResourcePane>,
    pub total_cpu_percent_x10: u32,
    pub total_mem_bytes: u64,
}

fn cpu_percent_x10(value: f32) -> u32 {
    if !value.is_finite() || value <= 0.0 {
        return 0;
    }
    (value * 10.0).round().min(u32::MAX as f32) as u32
}

fn process_resource(sys: &System, pid: u32, include_name: bool) -> Option<ResourceProcess> {
    let process = sys.process(Pid::from_u32(pid))?;
    Some(ResourceProcess {
        pid,
        name: if include_name {
            process.name().to_string_lossy().into_owned()
        } else {
            String::new()
        },
        cpu_percent_x10: cpu_percent_x10(process.cpu_usage()),
        mem_bytes: process.memory(),
    })
}

fn tree_resources(sys: &System, root_pid: u32, include_names: bool) -> Vec<ResourceProcess> {
    crate::daemon::proc::tree_pids(sys, root_pid)
        .into_iter()
        .filter_map(|pid| process_resource(sys, pid, include_names))
        .collect()
}

fn resource_totals(
    processes: &[ResourceProcess],
    fallback_mem_bytes: u64,
    fallback_process_count: u32,
) -> (u32, u64, u32) {
    if processes.is_empty() {
        return (0, fallback_mem_bytes, fallback_process_count);
    }
    (
        processes.iter().fold(0u32, |total, process| {
            total.saturating_add(process.cpu_percent_x10)
        }),
        processes.iter().fold(0u64, |total, process| {
            total.saturating_add(process.mem_bytes)
        }),
        processes.len() as u32,
    )
}

fn resource_proc(
    pid: u32,
    processes: Vec<ResourceProcess>,
    fallback_mem_bytes: u64,
    fallback_process_count: u32,
    include_details: bool,
) -> ResourceProc {
    let (cpu_percent_x10, mem_bytes, process_count) =
        resource_totals(&processes, fallback_mem_bytes, fallback_process_count);
    ResourceProc {
        pid,
        cpu_percent_x10,
        mem_bytes,
        process_count,
        processes: if include_details {
            processes
        } else {
            Vec::new()
        },
    }
}

#[tauri::command]
pub async fn ping(client: State<'_, DaemonClient>) -> Result<(), String> {
    client.ping().map_err(to_string)
}

/// Pull after the WebView mounts so startup cannot race an event listener.
/// Taking once also keeps a reload from resurrecting an old notice.
#[tauri::command]
pub fn take_daemon_replacement() -> Option<super::spawn_daemon::DaemonReplacement> {
    super::spawn_daemon::take_daemon_replacement()
}

/// Mirrors `settings.sessionRestore` / `settings.minimizeToTrayOnClose` into
/// native state, because `RunEvent::Exit` cannot call into the WebView.
#[tauri::command]
pub async fn set_exit_behavior(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    prefs: State<'_, super::ExitPrefs>,
    stop_terminals: bool,
    minimize_to_tray: bool,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    prefs.set_clean(stop_terminals);
    prefs.set_minimize_to_tray(minimize_to_tray);
    Ok(())
}

/// Hides the main window to the tray. Returns `false` when tray minimize is
/// disabled, so the caller proceeds with a real quit.
#[tauri::command]
pub async fn hide_to_tray(
    app: tauri::AppHandle,
    prefs: State<'_, super::ExitPrefs>,
) -> Result<bool, String> {
    if !prefs.minimizes_to_tray() {
        return Ok(false);
    }
    let Some(window) = tauri::Manager::get_webview_window(&app, "main") else {
        return Ok(false);
    };
    window.hide().map_err(|error| error.to_string())?;
    Ok(true)
}

#[tauri::command]
pub async fn init_terminal_output(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    channel: Channel<TerminalEvent>,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::TerminalRead)
        .map_err(to_string)?;
    client.set_output_channel(channel);
    Ok(())
}

#[tauri::command]
pub fn terminal_ws_port(client: State<'_, DaemonClient>) -> u16 {
    client.ws_port()
}

#[tauri::command]
pub fn terminal_ws_token(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
) -> Result<String, String> {
    supervisor
        .authorize(Capability::TerminalRead)
        .map_err(to_string)?;
    Ok(client.ws_token())
}

#[tauri::command]
pub fn webview_render_mode() -> &'static str {
    crate::app::webview_renderer::resolved_renderer_mode()
}

#[tauri::command]
pub fn remote_get_status(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
) -> Result<RemoteStatus, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(&client, json!({ "action": "status" }))
}

#[tauri::command]
pub fn remote_get_pane_lease(
    client: State<'_, DaemonClient>,
    pane_id: String,
) -> Result<Option<RemotePaneLeaseStatus>, String> {
    remote_request(&client, json!({ "action": "paneLease", "paneId": pane_id }))
}

#[tauri::command]
pub fn remote_reclaim_pane_lease(
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    match client
        .request_reply(|req| ClientToDaemon::RemotePaneLeaseAdminReclaim {
            req,
            request: RemotePaneLeaseAdminReclaimRequest {
                session_id,
                pane_id,
            },
        })
        .map_err(to_string)?
    {
        ReplyResult::RemotePaneLease(RemotePaneLeaseResult::Reclaimed { .. }) => Ok(()),
        other => Err(format!(
            "unexpected daemon response to remote pane lease reclaim: {other:?}"
        )),
    }
}

#[tauri::command]
pub async fn remote_set_enabled(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    enabled: bool,
) -> Result<RemoteStatus, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(
        &client,
        json!({ "action": "setEnabled", "enabled": enabled }),
    )
}

#[tauri::command]
pub async fn remote_set_port(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    port: u16,
) -> Result<RemoteStatus, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(&client, json!({ "action": "setPort", "port": port }))
}

#[tauri::command]
pub async fn remote_set_lan_enabled(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    lan_enabled: bool,
) -> Result<RemoteStatus, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(
        &client,
        json!({ "action": "setLanEnabled", "lanEnabled": lan_enabled }),
    )
}

#[tauri::command]
pub async fn remote_create_pairing(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
) -> Result<PairingPayload, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(&client, json!({ "action": "createPairing" }))
}

#[tauri::command]
pub async fn remote_create_pairing_v2(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
) -> Result<PairingPayload, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(&client, json!({ "action": "createPairingV2" }))
}

#[tauri::command]
pub async fn remote_revoke_device(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    device_id: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(
        &client,
        json!({ "action": "revokeDevice", "deviceId": device_id }),
    )
}

#[tauri::command]
pub async fn remote_regenerate_identity(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
) -> Result<RemoteStatus, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(&client, json!({ "action": "regenerateIdentity" }))
}

fn remote_firewall_port(client: &DaemonClient, requested_port: Option<u16>) -> Result<u16, String> {
    let port = match requested_port {
        Some(port) => port,
        None => {
            let status: RemoteStatus = remote_request(client, json!({ "action": "status" }))?;
            status.port
        }
    };
    crate::remote::firewall::validate_port(port).map_err(to_string)
}

#[tauri::command]
pub async fn remote_firewall_status(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    port: Option<u16>,
) -> Result<bool, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    let port = remote_firewall_port(&client, port)?;
    crate::remote::firewall::is_configured(port).map_err(to_string)
}

#[tauri::command]
pub async fn remote_setup_firewall(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    port: Option<u16>,
) -> Result<bool, String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    let port = remote_firewall_port(&client, port)?;
    crate::remote::firewall::setup(port).map_err(to_string)?;
    crate::remote::firewall::is_configured(port).map_err(to_string)
}

#[tauri::command]
pub async fn set_remote_appearance(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    appearance: Value,
    workspace_order: Vec<String>,
    workspace_alerts: std::collections::HashMap<String, usize>,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::RemoteConnect)
        .map_err(to_string)?;
    remote_request(
        &client,
        json!({
            "action": "setAppearance",
            "appearance": appearance,
            "workspaceOrder": workspace_order,
            "workspaceAlerts": workspace_alerts,
        }),
    )
}

#[tauri::command]
pub async fn set_desktop_selection(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    workspace_id: Option<String>,
    pane_id: Option<String>,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    let workspace_id = workspace_id
        .as_deref()
        .map(parse_uuid)
        .transpose()
        .map_err(to_string)?;
    let pane_id = pane_id
        .as_deref()
        .map(parse_uuid)
        .transpose()
        .map_err(to_string)?;
    expect_ok(
        client.request_reply(|req| ClientToDaemon::SetDesktopSelection {
            req,
            selection: DesktopSelection {
                workspace_id,
                pane_id,
            },
        }),
    )
}

fn remote_request<T: DeserializeOwned>(client: &DaemonClient, request: Value) -> Result<T, String> {
    match client
        .request_reply(|req| ClientToDaemon::Remote {
            req,
            request_json: request.to_string(),
        })
        .map_err(to_string)?
    {
        ReplyResult::Remote(response_json) => {
            serde_json::from_str(&response_json).map_err(|error| error.to_string())
        }
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn list_sessions(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
) -> Result<Vec<SessionMeta>, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    match client
        .request_reply(|req| ClientToDaemon::ListSessions { req })
        .map_err(to_string)?
    {
        ReplyResult::Sessions(sessions) => Ok(sessions),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn agent_hook_status(
    app: AppHandle,
) -> Result<Vec<crate::app::agent_hooks::AgentHookStatus>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(crate::app::agent_hooks::get_managed_agent_hook_statuses(
        &app_data_dir,
    ))
}

#[tauri::command]
pub async fn set_agent_hook_enabled(
    app: AppHandle,
    agent_id: String,
    enabled: bool,
) -> Result<crate::app::agent_hooks::AgentHookStatus, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    crate::app::agent_hooks::set_agent_hook_enabled_native(&app_data_dir, &agent_id, enabled)
        .map_err(to_string)
}

#[tauri::command]
pub async fn attention_snapshot(
    client: State<'_, DaemonClient>,
) -> Result<AttentionSnapshotData, String> {
    match client
        .request_reply(|req| ClientToDaemon::AttentionSnapshot { req })
        .map_err(to_string)?
    {
        ReplyResult::AttentionSnapshot(data) => Ok(data),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn resource_snapshot(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    include_details: Option<bool>,
) -> Result<ResourceSnapshotDto, String> {
    supervisor
        .authorize(Capability::TerminalRead)
        .map_err(to_string)?;
    let include_details = include_details.unwrap_or(false);
    let data = match client
        .request_reply(|req| ClientToDaemon::ResourceSnapshot { req })
        .map_err(to_string)?
    {
        ReplyResult::ResourceSnapshot(data) => data,
        other => return Err(format!("unexpected daemon response: {other:?}")),
    };

    let pane_details: HashMap<String, (Option<String>, Option<String>)> = if include_details {
        match client.request_reply(|req| ClientToDaemon::RemoteWorkspaceProjection {
            req,
            workspace_id: None,
        }) {
            Ok(ReplyResult::RemoteWorkspaceProjection(projection)) => projection
                .panes
                .into_iter()
                .map(|pane| {
                    let title = (!pane.title.trim().is_empty()).then_some(pane.title);
                    let role = (!pane.role.trim().is_empty()).then_some(pane.role);
                    (pane.id, (title, role))
                })
                .collect(),
            _ => HashMap::new(),
        }
    } else {
        HashMap::new()
    };

    let mut sys = RESOURCE_SYSTEM
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_memory().with_cpu(),
    );

    let app_pid = std::process::id();
    let daemon_tree_pids: HashSet<_> = crate::daemon::proc::tree_pids(&sys, data.daemon_pid)
        .into_iter()
        .collect();
    let app_processes = tree_resources(&sys, app_pid, include_details)
        .into_iter()
        .filter(|process| !daemon_tree_pids.contains(&process.pid))
        .collect();
    let app = resource_proc(app_pid, app_processes, 0, 0, include_details);
    let daemon_processes = process_resource(&sys, data.daemon_pid, include_details)
        .into_iter()
        .collect();
    let daemon = resource_proc(
        data.daemon_pid,
        daemon_processes,
        data.daemon_mem_bytes,
        1,
        include_details,
    );

    let panes: Vec<_> = data
        .panes
        .into_iter()
        .map(|pane| {
            let pane_id = pane.pane_id.to_string();
            let (title, role) = pane_details.get(&pane_id).cloned().unwrap_or((None, None));
            let processes = pane
                .root_pid
                .map(|pid| tree_resources(&sys, pid, include_details))
                .unwrap_or_default();
            let (cpu_percent_x10, mem_bytes, process_count) =
                resource_totals(&processes, pane.mem_bytes, pane.process_count);
            ResourcePane {
                session_id: pane.session_id.to_string(),
                pane_id,
                root_pid: pane.root_pid,
                title,
                role,
                cpu_percent_x10,
                mem_bytes,
                process_count,
                processes: if include_details {
                    processes
                } else {
                    Vec::new()
                },
            }
        })
        .collect();
    let total_cpu_percent_x10 = app
        .cpu_percent_x10
        .saturating_add(daemon.cpu_percent_x10)
        .saturating_add(panes.iter().fold(0u32, |total, pane| {
            total.saturating_add(pane.cpu_percent_x10)
        }));
    let total_mem_bytes = app
        .mem_bytes
        .saturating_add(daemon.mem_bytes)
        .saturating_add(
            panes
                .iter()
                .fold(0u64, |total, pane| total.saturating_add(pane.mem_bytes)),
        );

    Ok(ResourceSnapshotDto {
        daemon,
        app,
        panes,
        total_cpu_percent_x10,
        total_mem_bytes,
    })
}

/// Stop ONE process (and its descendants) inside a terminal pane's tree.
///
/// Ownership gate: the PID must still be inside the daemon-reported pane tree,
/// so the resource manager can never terminate the app, the daemon, or an
/// unrelated user process. Killing the pane root ends that terminal, which is
/// what the confirmation in the UI says.
#[tauri::command]
pub async fn kill_pane_process(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    pane_id: String,
    pid: u32,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    let data = match client
        .request_reply(|req| ClientToDaemon::ResourceSnapshot { req })
        .map_err(to_string)?
    {
        ReplyResult::ResourceSnapshot(data) => data,
        other => return Err(format!("unexpected daemon response: {other:?}")),
    };
    let root_pid = data
        .panes
        .iter()
        .find(|pane| pane.pane_id == pane_id)
        .and_then(|pane| pane.root_pid)
        .ok_or_else(|| "terminal has no running process".to_string())?;
    // ponytail: two PID-only snapshots per click (~20 ms each) — merge into one
    // proc helper only if this ever runs in a loop.
    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    if !crate::daemon::proc::tree_pids(&sys, root_pid).contains(&pid) {
        return Err(format!("process {pid} is not part of this terminal"));
    }
    crate::daemon::proc::kill_process_tree(pid);
    Ok(())
}

#[tauri::command]
pub async fn restart_daemon(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let client = client.inner().clone();
    tauri::async_runtime::spawn_blocking(move || client.restart())
        .await
        .map_err(|err| err.to_string())?
        .map_err(to_string)
}

#[tauri::command]
pub async fn create_session(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    name: String,
    workspace_folder: Option<String>,
) -> Result<SessionMeta, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
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
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    name: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::RenameSession {
        req,
        session_id,
        name,
    }))
}

#[tauri::command]
pub async fn set_session_workspace_folder(
    client: State<'_, DaemonClient>,
    session_id: String,
    workspace_folder: String,
) -> Result<(), String> {
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let workspace_folder = workspace_folder.trim().to_string();
    if workspace_folder.is_empty() {
        return Err("workspace folder is required".to_string());
    }
    if !std::path::Path::new(&workspace_folder).is_dir() {
        return Err(format!(
            "workspace folder does not exist: {workspace_folder}"
        ));
    }
    expect_ok(
        client.request_reply(|req| ClientToDaemon::SetSessionWorkspaceFolder {
            req,
            session_id,
            workspace_folder,
        }),
    )
}

#[tauri::command]
pub async fn delete_session(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::DeleteSession { req, session_id }))
}

#[tauri::command]
pub async fn attach_session(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
) -> Result<AttachedSession, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
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
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::TerminalRead)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::DetachSession { session_id })
        .map_err(to_string)
}

#[tauri::command]
pub async fn save_layout(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    layout_json: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
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
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    cfg: PaneConfig,
) -> Result<PaneMeta, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
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
pub async fn cancel_pane_spawn(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::CancelPaneSpawn {
        req,
        session_id,
        pane_id,
    }))
}

#[tauri::command]
pub async fn attach_pane(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::TerminalRead)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::AttachPane {
        req,
        session_id,
        pane_id,
    }))
}

#[tauri::command]
pub async fn subscribe_pane(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
) -> Result<TerminalSnapshotResult, String> {
    supervisor
        .authorize(Capability::TerminalRead)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    match client
        .request_reply(|req| ClientToDaemon::SubscribePane {
            req,
            session_id,
            pane_id,
        })
        .map_err(to_string)?
    {
        ReplyResult::TerminalSnapshot(snapshot) => Ok(snapshot.into()),
        other => Err(format!("unexpected daemon response: {other:?}")),
    }
}

#[tauri::command]
pub async fn write_pane(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::TerminalWrite)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::WritePane {
        req,
        session_id,
        pane_id,
        data: data.into_bytes(),
        origin: PaneCommandOrigin::Desktop,
    }))
}

#[tauri::command]
pub async fn resize_pane(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::TerminalWrite)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    client
        .send(ClientToDaemon::ResizePane {
            session_id,
            pane_id,
            cols,
            rows,
            origin: PaneCommandOrigin::Desktop,
        })
        .map_err(to_string)
}

/// Hand the daemon a snapshot of what this pane's terminal actually renders, so
/// a later reattach restores that screen instead of re-parsing raw PTY bytes at
/// a geometry they were never produced at.
#[tauri::command]
pub async fn set_pane_snapshot(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
    data: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::TerminalWrite)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    let pane_id = parse_uuid(&pane_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::SetPaneSnapshot {
        req,
        session_id,
        pane_id,
        data: data.into_bytes(),
    }))
}

#[tauri::command]
pub async fn set_pane_title(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
    title: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
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
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    session_id: String,
    pane_id: String,
    role: Option<String>,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
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
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    pane_id: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
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
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_id = parse_uuid(&session_id).map_err(to_string)?;
    expect_ok(client.request_reply(|req| ClientToDaemon::ClearSession { req, session_id }))
}

#[tauri::command]
pub async fn list_installed_fonts(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
) -> Result<Vec<String>, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
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

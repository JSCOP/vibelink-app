use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io::{self, Read, Write};
use thiserror::Error;
use uuid::Uuid;

pub type Req = u64;
pub const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

pub const REMOTE_PANE_LEASE_TTL_MS: u64 = 15_000;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub pane_generation: u64,
    pub output_sequence: u64,
    pub cols: u16,
    pub rows: u16,
    pub alive: bool,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSelection {
    pub workspace_id: Option<Uuid>,
    pub pane_id: Option<Uuid>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RemotePaneActivity {
    Idle,
    Running,
    Waiting,
    Done,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceProjectionWorkspace {
    pub id: String,
    pub name: String,
    pub pane_count: u32,
    pub workspace_folder: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceProjectionPane {
    pub activity: RemotePaneActivity,
    pub alive: bool,
    pub cols: u16,
    pub desktop_active: bool,
    pub group_id: String,
    pub group_order: u32,
    pub id: String,
    pub last_output_at: u64,
    pub order: u32,
    pub pane_generation: u64,
    pub role: String,
    pub rows: u16,
    pub tab_order: u32,
    pub title: String,
    pub unread_count: u32,
    pub workspace_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteWorkspaceProjection {
    pub workspaces: Vec<RemoteWorkspaceProjectionWorkspace>,
    pub attached_workspace_id: Option<String>,
    pub panes: Vec<RemoteWorkspaceProjectionPane>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PaneCommandOrigin {
    #[default]
    Desktop,
    Remote {
        owner_connection_id: Uuid,
        device_id: String,
        lease_id: Option<Uuid>,
        revision: Option<u64>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLease {
    pub lease_id: Uuid,
    pub owner_connection_id: Uuid,
    pub device_id: String,
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub pane_generation: u64,
    pub revision: u64,
    pub original_cols: u16,
    pub original_rows: u16,
    pub target_cols: u16,
    pub target_rows: u16,
    pub viewport_revision: u64,
    pub expires_at: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseClaimRequest {
    pub owner_connection_id: Uuid,
    pub device_id: String,
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub cols: u16,
    pub rows: u16,
    pub viewport_revision: u64,
    pub lease_id: Option<Uuid>,
    pub revision: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseRenewRequest {
    pub owner_connection_id: Uuid,
    pub device_id: String,
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub lease_id: Uuid,
    pub revision: u64,
    pub viewport_revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseReleaseRequest {
    pub owner_connection_id: Uuid,
    pub device_id: String,
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub lease_id: Uuid,
    pub revision: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseStatusRequest {
    pub pane_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseAdminReclaimRequest {
    pub session_id: Uuid,
    pub pane_id: Uuid,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteConnectionCleanupRequest {
    pub owner_connection_id: Uuid,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemotePaneLeaseEventReason {
    Claimed,
    TargetUpdated,
    Renewed,
    Released,
    AdminReclaimed,
    Expired,
    ConnectionClosed,
    PaneExited,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemotePaneLeaseRestorationStatus {
    Restored,
    PaneMissing,
    GenerationMismatch,
    ResizeFailed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseRestoration {
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub pane_generation: u64,
    pub cols: u16,
    pub rows: u16,
    pub status: RemotePaneLeaseRestorationStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemotePaneLeaseEventKind {
    Claimed,
    Updated,
    Released,
    Lost,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseEvent {
    pub kind: RemotePaneLeaseEventKind,
    pub reason: RemotePaneLeaseEventReason,
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub leased: bool,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
    pub lease_id: Uuid,
    pub owner_connection_id: Uuid,
    pub device_id: String,
    pub pane_generation: u64,
    pub revision: u64,
    pub original_cols: u16,
    pub original_rows: u16,
    pub target_cols: u16,
    pub target_rows: u16,
    pub viewport_revision: u64,
    pub expires_at: u64,
    pub restoration: Option<RemotePaneLeaseRestoration>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePaneLeaseReleaseOutcome {
    pub lease: RemotePaneLease,
    pub restoration: RemotePaneLeaseRestoration,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RemotePaneLeaseStaleReason {
    LeaseId,
    Revision,
    Owner,
    Device,
    Session,
    PaneGeneration,
    Missing,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "outcome",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum RemotePaneLeaseResult {
    Claimed {
        lease: RemotePaneLease,
    },
    Updated {
        lease: RemotePaneLease,
    },
    Renewed {
        lease: RemotePaneLease,
    },
    Released {
        release: RemotePaneLeaseReleaseOutcome,
    },
    Reclaimed {
        release: RemotePaneLeaseReleaseOutcome,
    },
    Status {
        lease: Option<RemotePaneLease>,
    },
    Cleanup {
        releases: Vec<RemotePaneLeaseReleaseOutcome>,
    },
    Busy {
        lease: RemotePaneLease,
    },
    Stale {
        lease: Option<RemotePaneLease>,
        reason: RemotePaneLeaseStaleReason,
    },
}

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("frame io error: {0}")]
    Io(#[from] io::Error),
    #[error("frame encode error: {0}")]
    Encode(#[from] rmp_serde::encode::Error),
    #[error("frame decode error: {0}")]
    Decode(#[from] rmp_serde::decode::Error),
    #[error("frame too large: {len} bytes")]
    FrameTooLarge { len: u32 },
}

pub type FrameResult<T> = Result<T, FrameError>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBrowserHostRequest {
    pub request_id: Uuid,
    pub operation_id: Uuid,
    pub method: String,
    pub payload_json: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteBrowserHostResponse {
    pub request_id: Uuid,
    pub result_json: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ClientToDaemon {
    Hello {
        client_id: Uuid,
    },
    Authenticate {
        req: Req,
        client_id: Uuid,
        boot_token: String,
        process_id: u32,
        user_sid: String,
    },
    RegisterBrowserHost,
    Ping {
        req: Req,
    },
    ListSessions {
        req: Req,
    },
    RemoteWorkspaceProjection {
        req: Req,
        workspace_id: Option<Uuid>,
    },
    SetDesktopSelection {
        req: Req,
        selection: DesktopSelection,
    },
    CreateSession {
        req: Req,
        name: String,
        workspace_folder: Option<String>,
    },
    RenameSession {
        req: Req,
        session_id: Uuid,
        name: String,
    },
    SetSessionWorkspaceFolder {
        req: Req,
        session_id: Uuid,
        workspace_folder: String,
    },
    DeleteSession {
        req: Req,
        session_id: Uuid,
    },
    AttachSession {
        req: Req,
        session_id: Uuid,
    },
    DetachSession {
        session_id: Uuid,
    },
    SaveLayout {
        session_id: Uuid,
        layout_json: String,
    },
    SpawnPane {
        req: Req,
        session_id: Uuid,
        cfg: PaneConfig,
        /// Attach the requesting client to the pane atomically at spawn, so
        /// output streams to it live from the first byte and a later
        /// `AttachPane` does not need a snapshot replay.
        #[serde(default)]
        attach: bool,
    },
    AttachPane {
        session_id: Uuid,
        pane_id: Uuid,
    },
    SubscribePane {
        req: Req,
        session_id: Uuid,
        pane_id: Uuid,
    },
    DetachPane {
        session_id: Uuid,
        pane_id: Uuid,
    },
    WritePane {
        session_id: Uuid,
        pane_id: Uuid,
        data: Vec<u8>,
        #[serde(default)]
        origin: PaneCommandOrigin,
    },
    ResizePane {
        session_id: Uuid,
        pane_id: Uuid,
        cols: u16,
        rows: u16,
        #[serde(default)]
        origin: PaneCommandOrigin,
    },
    NotifySessionChanged {
        session_id: Uuid,
    },
    SetPaneTitle {
        req: Req,
        session_id: Uuid,
        pane_id: Uuid,
        title: String,
    },
    SetPaneRole {
        req: Req,
        session_id: Uuid,
        pane_id: Uuid,
        role: Option<String>,
    },
    ClosePane {
        req: Req,
        session_id: Uuid,
        pane_id: Uuid,
    },
    ClearSession {
        req: Req,
        session_id: Uuid,
    },
    Shutdown {
        req: Req,
    },
    GetScrollback {
        req: Req,
        session_id: Uuid,
        pane_id: Uuid,
    },
    TaskEvent {
        req: Req,
        session_id: Uuid,
        event: TaskSignal,
    },
    Control {
        req: Req,
        operation_id: Uuid,
        command_json: String,
    },
    Orchestration {
        req: Req,
        operation_id: Uuid,
        method: String,
        payload_json: String,
    },
    Cli {
        req: Req,
        operation_id: Uuid,
        request_json: String,
    },
    Computer {
        req: Req,
        operation_id: Uuid,
        request_json: String,
    },
    Remote {
        req: Req,
        request_json: String,
    },
    RemoteBrowser {
        req: Req,
        operation_id: Uuid,
        method: String,
        payload_json: String,
    },
    RemoteBrowserResponse {
        response: RemoteBrowserHostResponse,
    },
    RemotePaneLeaseClaim {
        req: Req,
        request: RemotePaneLeaseClaimRequest,
    },
    RemotePaneLeaseRenew {
        req: Req,
        request: RemotePaneLeaseRenewRequest,
    },
    RemotePaneLeaseRelease {
        req: Req,
        request: RemotePaneLeaseReleaseRequest,
    },
    RemotePaneLeaseStatus {
        req: Req,
        request: RemotePaneLeaseStatusRequest,
    },
    RemotePaneLeaseAdminReclaim {
        req: Req,
        request: RemotePaneLeaseAdminReclaimRequest,
    },
    RemoteConnectionCleanup {
        req: Req,
        request: RemoteConnectionCleanupRequest,
    },
    ResourceSnapshot {
        req: Req,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DaemonToClient {
    Pong {
        req: Req,
    },
    Reply {
        req: Req,
        result: ReplyResult,
    },
    Error {
        req: Option<Req>,
        message: String,
    },
    Output {
        pane_id: Uuid,
        data: Vec<u8>,
    },
    PaneExited {
        pane_id: Uuid,
        exit_code: Option<i32>,
    },
    PaneResized {
        session_id: Uuid,
        pane_id: Uuid,
        cols: u16,
        rows: u16,
    },
    SessionChanged {
        session_id: Uuid,
    },
    TaskEvent {
        session_id: Uuid,
        event: TaskSignal,
    },
    RemotePaneLease {
        event: RemotePaneLeaseEvent,
    },
    RemoteBrowserRequest {
        request: RemoteBrowserHostRequest,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum TaskSignal {
    Done {
        #[serde(rename = "taskId")]
        task_id: String,
        #[serde(rename = "commitMsg")]
        commit_msg: Option<String>,
        #[serde(rename = "resultSummary")]
        result_summary: Option<String>,
        #[serde(rename = "paneId")]
        pane_id: Option<Uuid>,
    },
    Note {
        #[serde(rename = "taskId")]
        task_id: String,
        message: String,
        #[serde(rename = "paneId")]
        pane_id: Option<Uuid>,
    },
    AgentPrompt {
        prompt: String,
    },
    BoardChanged {},
    PaneConfigured {
        #[serde(rename = "paneId")]
        pane_id: Uuid,
        title: Option<String>,
        role: Option<String>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReplyResult {
    Sessions(Vec<SessionMeta>),
    SessionCreated(SessionMeta),
    Attached {
        layout_json: Option<String>,
        panes: Vec<PaneMeta>,
    },
    PaneSpawned(PaneMeta),
    RemoteWorkspaceProjection(RemoteWorkspaceProjection),
    ScrollbackData(Vec<u8>),
    TerminalSnapshot(TerminalSnapshot),
    Ok,
    Control(String),
    Orchestration(String),
    Cli(String),
    Computer(String),
    Remote(String),
    Browser(String),
    RemotePaneLease(RemotePaneLeaseResult),
    ResourceSnapshot(ResourceSnapshotData),
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneConfig {
    pub pane_id: Uuid,
    pub shell: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
    pub title: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub role: Option<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: Uuid,
    pub name: String,
    pub pane_count: usize,
    pub created_at: i64,
    pub workspace_folder: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneMeta {
    pub id: Uuid,
    pub config: PaneConfig,
    pub alive: bool,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneResource {
    pub session_id: Uuid,
    pub pane_id: Uuid,
    pub root_pid: Option<u32>,
    pub mem_bytes: u64,
    pub process_count: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshotData {
    pub daemon_pid: u32,
    pub daemon_mem_bytes: u64,
    pub panes: Vec<PaneResource>,
}

pub fn write_frame<W, T>(writer: &mut W, msg: &T) -> FrameResult<()>
where
    W: Write,
    T: Serialize + ?Sized,
{
    let bytes = rmp_serde::to_vec(msg)?;
    if bytes.len() > MAX_FRAME_LEN {
        return Err(FrameError::FrameTooLarge {
            len: bytes.len() as u32,
        });
    }

    writer.write_all(&(bytes.len() as u32).to_be_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

pub fn read_frame<R, T>(reader: &mut R) -> FrameResult<T>
where
    R: Read,
    T: DeserializeOwned,
{
    let mut len_buf = [0_u8; 4];
    reader.read_exact(&mut len_buf)?;
    let len = u32::from_be_bytes(len_buf);
    if len as usize > MAX_FRAME_LEN {
        return Err(FrameError::FrameTooLarge { len });
    }

    const READ_CHUNK_LEN: usize = 64 * 1024;
    let len = len as usize;
    let mut bytes = Vec::with_capacity(len.min(READ_CHUNK_LEN));
    let mut remaining = len;
    while remaining > 0 {
        let chunk_len = remaining.min(READ_CHUNK_LEN);
        let start = bytes.len();
        bytes.resize(start + chunk_len, 0);
        reader.read_exact(&mut bytes[start..])?;
        remaining -= chunk_len;
    }
    Ok(rmp_serde::from_slice(&bytes)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frame_roundtrip_preserves_spawn_pane_message() {
        let pane_id = Uuid::new_v4();
        let session_id = Uuid::new_v4();
        let message = ClientToDaemon::SpawnPane {
            req: 42,
            session_id,
            cfg: PaneConfig {
                pane_id,
                shell: Some("pwsh.exe".to_string()),
                args: vec!["-NoLogo".to_string()],
                cwd: Some("E:/work".to_string()),
                env: vec![("TERM".to_string(), "xterm-256color".to_string())],
                title: Some("main".to_string()),
                icon: Some("sparkles".to_string()),
                profile_id: Some("codex".to_string()),
                role: Some("Reviewer".to_string()),
                cols: 120,
                rows: 32,
            },
            attach: true,
        };

        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode frame");

        let decoded: ClientToDaemon = read_frame(&mut Cursor::new(bytes)).expect("decode frame");

        assert_eq!(decoded, message);
    }

    #[test]
    fn frame_roundtrip_preserves_session_workspace_folder() {
        let message = ClientToDaemon::CreateSession {
            req: 7,
            name: "Repo".to_string(),
            workspace_folder: Some("C:\\".to_string()),
        };

        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode frame");

        let decoded: ClientToDaemon = read_frame(&mut Cursor::new(bytes)).expect("decode frame");

        assert_eq!(decoded, message);
    }

    #[test]
    fn frame_roundtrip_preserves_task_event() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let message = ClientToDaemon::TaskEvent {
            req: 8,
            session_id,
            event: TaskSignal::Done {
                task_id: "task-123".to_string(),
                commit_msg: Some("finished task".to_string()),
                result_summary: Some("finished task successfully".to_string()),
                pane_id: Some(pane_id),
            },
        };

        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode frame");

        let decoded: ClientToDaemon = read_frame(&mut Cursor::new(bytes)).expect("decode frame");

        assert_eq!(decoded, message);
    }

    #[test]
    fn frame_roundtrip_preserves_session_changed_notification() {
        let session_id = Uuid::new_v4();
        let message = DaemonToClient::SessionChanged { session_id };

        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode frame");

        let decoded: DaemonToClient = read_frame(&mut Cursor::new(bytes)).expect("decode frame");

        assert_eq!(decoded, message);
    }

    #[test]
    fn frame_roundtrip_preserves_resource_snapshot_reply() {
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let message = DaemonToClient::Reply {
            req: 9,
            result: ReplyResult::ResourceSnapshot(ResourceSnapshotData {
                daemon_pid: 1234,
                daemon_mem_bytes: 64 * 1024 * 1024,
                panes: vec![PaneResource {
                    session_id,
                    pane_id,
                    root_pid: Some(4321),
                    mem_bytes: 128 * 1024 * 1024,
                    process_count: 3,
                }],
            }),
        };

        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode frame");

        let decoded: DaemonToClient = read_frame(&mut Cursor::new(bytes)).expect("decode frame");

        assert_eq!(decoded, message);
    }

    #[test]
    fn frame_roundtrip_preserves_control_json_reply() {
        let response = crate::control_plane::ControlResponse::Task(crate::control_plane::Task {
            id: "task-1".to_string(),
            session_id: Uuid::new_v4().to_string(),
            title: "Control".to_string(),
            description: String::new(),
            status: crate::control_plane::TaskStatus::Pending,
            status_timestamps: std::collections::HashMap::from([(
                crate::control_plane::TaskStatus::Pending,
                123,
            )]),
            assigned_pane_id: None,
            assigned_role: None,
            baseline_ref: None,
            worktree_path: None,
            commit_message: None,
            result_summary: None,
            created_at: 123,
            updated_at: 123,
        });
        let message = DaemonToClient::Reply {
            req: 10,
            result: ReplyResult::Control(serde_json::to_string(&response).expect("control JSON")),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode control frame");
        let decoded: DaemonToClient =
            read_frame(&mut Cursor::new(bytes)).expect("decode control frame");
        assert_eq!(decoded, message);
    }
    #[test]
    fn frame_roundtrip_preserves_daemon_authentication() {
        let message = ClientToDaemon::Authenticate {
            req: 42,
            client_id: Uuid::new_v4(),
            boot_token: "a".repeat(64),
            process_id: 1234,
            user_sid: "S-1-5-21-1000".to_string(),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode authentication frame");
        let decoded: ClientToDaemon =
            read_frame(&mut Cursor::new(bytes)).expect("decode authentication frame");
        assert_eq!(decoded, message);
    }

    #[test]
    fn frame_roundtrip_preserves_typed_browser_host_messages() {
        let request = RemoteBrowserHostRequest {
            request_id: Uuid::new_v4(),
            operation_id: Uuid::new_v4(),
            method: "navigate".to_string(),
            payload_json: serde_json::json!({
                "workspaceId": Uuid::new_v4().to_string(),
                "pageId": Uuid::new_v4().to_string(),
                "url": "https://example.test"
            })
            .to_string(),
        };
        let message = ClientToDaemon::RemoteBrowser {
            req: 43,
            operation_id: request.operation_id,
            method: request.method.clone(),
            payload_json: request.payload_json.clone(),
        };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode browser host request");
        let decoded: ClientToDaemon =
            read_frame(&mut Cursor::new(bytes)).expect("decode browser host request");
        assert_eq!(decoded, message);

        let response = DaemonToClient::RemoteBrowserRequest { request };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &response).expect("encode browser host dispatch");
        let decoded: DaemonToClient =
            read_frame(&mut Cursor::new(bytes)).expect("decode browser host dispatch");
        assert_eq!(decoded, response);
    }
    #[test]
    fn read_frame_rejects_frames_larger_than_cap() {
        let mut bytes = ((MAX_FRAME_LEN as u32) + 1).to_be_bytes().to_vec();
        bytes.extend_from_slice(&[0; 8]);

        let err = read_frame::<_, DaemonToClient>(&mut Cursor::new(bytes))
            .expect_err("oversized frame must fail");

        assert!(
            matches!(err, FrameError::FrameTooLarge { len } if len == (MAX_FRAME_LEN as u32) + 1)
        );
    }
}

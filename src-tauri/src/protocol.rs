use chrono::{DateTime, Utc};
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::{self, Read, Write};
use thiserror::Error;
use uuid::Uuid;

pub type Req = u64;
pub const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;
pub const DAEMON_PROTOCOL_VERSION: u32 = 1;
pub const DAEMON_AUTH_REQUIRED: &str = "AUTH_REQUIRED";
pub const DAEMON_PROTOCOL_MISMATCH: &str = "DAEMON_PROTOCOL_MISMATCH";
pub const DAEMON_AUTH_DOMAIN: &[u8] = b"vibelink-daemon-auth-v1\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthorizationStateWire {
    Trial,
    TrialExpired,
    ValidOnline,
    Unlicensed,
    ConfigurationError,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationLease {
    pub state: AuthorizationStateWire,
    pub entitled: bool,
    pub observed_at: DateTime<Utc>,
    pub lease_until: DateTime<Utc>,
    pub offline_grace_until: Option<DateTime<Utc>>,
    pub policy_epoch: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ClientKind {
    App,
    Cli,
    Mcp,
    Remote,
    StartupProbe,
    Shutdown,
}

impl ClientKind {
    const fn proof_tag(self) -> u8 {
        match self {
            Self::App => 1,
            Self::Cli => 2,
            Self::Mcp => 3,
            Self::Remote => 4,
            Self::StartupProbe => 5,
            Self::Shutdown => 6,
        }
    }
}

pub fn daemon_auth_proof(
    secret: &[u8; 32],
    protocol_version: u32,
    boot_id: Uuid,
    nonce: &[u8; 32],
    client_id: Uuid,
    client_kind: ClientKind,
) -> [u8; 32] {
    let mut message = Vec::with_capacity(DAEMON_AUTH_DOMAIN.len() + 4 + 16 + 32 + 16 + 1);
    message.extend_from_slice(DAEMON_AUTH_DOMAIN);
    message.extend_from_slice(&protocol_version.to_be_bytes());
    message.extend_from_slice(boot_id.as_bytes());
    message.extend_from_slice(nonce);
    message.extend_from_slice(client_id.as_bytes());
    message.push(client_kind.proof_tag());
    hmac_sha256(secret, &message)
}

pub fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0_u8;
    for (&left, &right) in left.iter().zip(right) {
        difference |= left ^ right;
    }
    difference == 0
}

fn hmac_sha256(key: &[u8], message: &[u8]) -> [u8; 32] {
    const BLOCK_LEN: usize = 64;
    let mut key_block = [0_u8; BLOCK_LEN];
    if key.len() > BLOCK_LEN {
        key_block[..32].copy_from_slice(&Sha256::digest(key));
    } else {
        key_block[..key.len()].copy_from_slice(key);
    }

    let mut inner_pad = [0x36_u8; BLOCK_LEN];
    let mut outer_pad = [0x5c_u8; BLOCK_LEN];
    for index in 0..BLOCK_LEN {
        inner_pad[index] ^= key_block[index];
        outer_pad[index] ^= key_block[index];
    }

    let mut inner = Sha256::new();
    inner.update(inner_pad);
    inner.update(message);
    let inner_digest = inner.finalize();

    let mut outer = Sha256::new();
    outer.update(outer_pad);
    outer.update(inner_digest);
    outer.finalize().into()
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
pub enum ClientToDaemon {
    Hello {
        protocol_version: u32,
        client_id: Uuid,
        client_kind: ClientKind,
    },
    Authenticate {
        client_id: Uuid,
        proof: [u8; 32],
    },
    Ping {
        req: Req,
    },
    AuthorizationHeartbeat {
        snapshot: AuthorizationLease,
    },
    ListSessions {
        req: Req,
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
        req: Req,
        session_id: Uuid,
        pane_id: Uuid,
    },
    WritePane {
        req: Req,
        session_id: Uuid,
        pane_id: Uuid,
        data: Vec<u8>,
    },
    ResizePane {
        session_id: Uuid,
        pane_id: Uuid,
        cols: u16,
        rows: u16,
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
    ResourceSnapshot {
        req: Req,
    },
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum DaemonToClient {
    Challenge {
        protocol_version: u32,
        boot_id: Uuid,
        nonce: [u8; 32],
        expires_at_unix_ms: i64,
    },
    Authenticated {
        policy_epoch: u64,
        lease_until_unix_ms: i64,
    },
    AuthorizationChanged {
        code: String,
        policy_epoch: u64,
    },
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
    ScrollbackData(Vec<u8>),
    Ok,
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
    fn admission_messages_and_valid_proof_round_trip() {
        let secret = [0x42; 32];
        let boot_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let nonce = [0x24; 32];
        let proof = daemon_auth_proof(
            &secret,
            DAEMON_PROTOCOL_VERSION,
            boot_id,
            &nonce,
            client_id,
            ClientKind::Cli,
        );
        let message = ClientToDaemon::Authenticate { client_id, proof };
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &message).expect("encode admission frame");
        let decoded: ClientToDaemon = read_frame(&mut Cursor::new(bytes)).expect("decode frame");

        assert_eq!(decoded, message);
        assert!(constant_time_eq(
            &proof,
            &daemon_auth_proof(
                &secret,
                DAEMON_PROTOCOL_VERSION,
                boot_id,
                &nonce,
                client_id,
                ClientKind::Cli,
            )
        ));
    }

    #[test]
    fn admission_proof_binds_secret_version_nonce_identity_and_kind() {
        let secret = [7_u8; 32];
        let boot_id = Uuid::new_v4();
        let client_id = Uuid::new_v4();
        let nonce = [9_u8; 32];
        let proof = daemon_auth_proof(
            &secret,
            DAEMON_PROTOCOL_VERSION,
            boot_id,
            &nonce,
            client_id,
            ClientKind::App,
        );

        assert!(!constant_time_eq(
            &proof,
            &daemon_auth_proof(
                &[8_u8; 32],
                DAEMON_PROTOCOL_VERSION,
                boot_id,
                &nonce,
                client_id,
                ClientKind::App,
            )
        ));
        assert!(!constant_time_eq(
            &proof,
            &daemon_auth_proof(
                &secret,
                DAEMON_PROTOCOL_VERSION + 1,
                boot_id,
                &nonce,
                client_id,
                ClientKind::App,
            )
        ));
        assert!(!constant_time_eq(
            &proof,
            &daemon_auth_proof(
                &secret,
                DAEMON_PROTOCOL_VERSION,
                boot_id,
                &[10_u8; 32],
                client_id,
                ClientKind::App,
            )
        ));
        assert!(!constant_time_eq(
            &proof,
            &daemon_auth_proof(
                &secret,
                DAEMON_PROTOCOL_VERSION,
                boot_id,
                &nonce,
                client_id,
                ClientKind::Mcp,
            )
        ));
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

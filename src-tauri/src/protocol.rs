use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::io::{self, Read, Write};
use thiserror::Error;
use uuid::Uuid;

pub type Req = u64;
pub const MAX_FRAME_LEN: usize = 16 * 1024 * 1024;

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
        client_id: Uuid,
    },
    Ping {
        req: Req,
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
    },
    AttachPane {
        pane_id: Uuid,
    },
    WritePane {
        pane_id: Uuid,
        data: Vec<u8>,
    },
    ResizePane {
        pane_id: Uuid,
        cols: u16,
        rows: u16,
    },
    SetPaneTitle {
        req: Req,
        pane_id: Uuid,
        title: String,
    },
    ClosePane {
        req: Req,
        pane_id: Uuid,
    },
    Shutdown {
        req: Req,
    },
    GetScrollback {
        req: Req,
        session_id: Uuid,
        pane_id: Uuid,
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

    let mut bytes = vec![0_u8; len as usize];
    reader.read_exact(&mut bytes)?;
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
                cols: 120,
                rows: 32,
            },
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

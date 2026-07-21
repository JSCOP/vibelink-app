use crate::protocol::{PaneMeta, SessionMeta};
use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PROTOCOL_VERSION: u16 = 1;
pub const SUBPROTOCOL: &str = "vibelink-remote-v1";

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AuthRequest {
    Pair { code: String, device_name: String },
    Token { device_id: String, token: String },
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ClientMessage {
    Hello {
        protocol_version: u16,
        auth: AuthRequest,
    },
    ListWorkspaces {
        #[serde(default)]
        req_id: Option<u64>,
    },
    AttachWorkspace {
        session_id: String,
        #[serde(default)]
        req_id: Option<u64>,
    },
    DetachWorkspace {
        session_id: String,
        #[serde(default)]
        req_id: Option<u64>,
    },
    WritePane {
        pane_id: String,
        data: String,
        #[serde(default)]
        req_id: Option<u64>,
    },
    RefreshPane {
        pane_id: String,
        #[serde(default)]
        req_id: Option<u64>,
    },
    ClaimPane {
        pane_id: String,
        cols: u16,
        rows: u16,
        #[serde(default)]
        req_id: Option<u64>,
    },
    ReleasePane {
        pane_id: String,
        #[serde(default)]
        req_id: Option<u64>,
    },
    Ping {
        #[serde(default)]
        req_id: Option<u64>,
    },
    #[serde(other)]
    Unknown,
}
impl ClientMessage {
    pub fn req_id(&self) -> Option<u64> {
        match self {
            Self::ListWorkspaces { req_id }
            | Self::AttachWorkspace { req_id, .. }
            | Self::DetachWorkspace { req_id, .. }
            | Self::WritePane { req_id, .. }
            | Self::RefreshPane { req_id, .. }
            | Self::ClaimPane { req_id, .. }
            | Self::ReleasePane { req_id, .. }
            | Self::Ping { req_id } => *req_id,
            Self::Hello { .. } | Self::Unknown => None,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDto {
    pub id: String,
    pub name: String,
    pub pane_count: usize,
    pub created_at: i64,
    pub workspace_folder: Option<String>,
    pub alert_count: usize,
}

impl WorkspaceDto {
    pub fn from_session(value: SessionMeta, alert_count: usize) -> Self {
        Self {
            id: value.id.to_string(),
            name: value.name,
            pane_count: value.pane_count,
            created_at: value.created_at,
            workspace_folder: value.workspace_folder,
            alert_count,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneDto {
    pub id: String,
    pub title: String,
    pub cols: u16,
    pub rows: u16,
}

impl From<&PaneMeta> for PaneDto {
    fn from(value: &PaneMeta) -> Self {
        Self {
            id: value.id.to_string(),
            title: value
                .config
                .title
                .clone()
                .or_else(|| value.config.shell.clone())
                .unwrap_or_else(|| "Shell".to_string()),
            cols: value.config.cols,
            rows: value.config.rows,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ServerMessage {
    Authed {
        device_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        device_token: Option<String>,
        desktop_name: String,
        protocol_version: u16,
        app_version: String,
        capabilities: Vec<String>,
    },
    Error {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        req_id: Option<u64>,
    },
    Workspaces {
        workspaces: Vec<WorkspaceDto>,
        #[serde(skip_serializing_if = "Option::is_none")]
        req_id: Option<u64>,
    },
    WorkspaceAttached {
        session_id: String,
        panes: Vec<PaneDto>,
        #[serde(skip_serializing_if = "Option::is_none")]
        req_id: Option<u64>,
    },
    PanesChanged {
        session_id: String,
        panes: Vec<PaneDto>,
    },
    PaneResized {
        pane_id: String,
        cols: u16,
        rows: u16,
    },
    PaneLease {
        pane_id: String,
        leased: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        cols: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        rows: Option<u16>,
        #[serde(skip_serializing_if = "Option::is_none")]
        req_id: Option<u64>,
    },
    PaneExited {
        pane_id: String,
    },
    PaneBuffer {
        pane_id: String,
        data_b64: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        req_id: Option<u64>,
    },
    Appearance {
        payload: Value,
    },
    Pong {
        #[serde(skip_serializing_if = "Option::is_none")]
        req_id: Option<u64>,
    },
}

pub fn frame_pane_output(pane_id: &str, bytes: &[u8]) -> Vec<u8> {
    let id = pane_id.as_bytes();
    let id_len = u16::try_from(id.len()).expect("pane id length fits u16");
    let mut frame = Vec::with_capacity(2 + id.len() + bytes.len());
    frame.extend_from_slice(&id_len.to_be_bytes());
    frame.extend_from_slice(id);
    frame.extend_from_slice(bytes);
    frame
}

pub fn encode_buffer(bytes: &[u8]) -> String {
    STANDARD.encode(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_frame_matches_desktop_layout() {
        let frame = frame_pane_output("pane-1", b"hello");
        assert_eq!(&frame[..2], &(6_u16.to_be_bytes()));
        assert_eq!(&frame[2..8], b"pane-1");
        assert_eq!(&frame[8..], b"hello");
    }

    #[test]
    fn client_messages_use_camel_case_contract() {
        let parsed: ClientMessage = serde_json::from_str(
            r#"{"type":"hello","protocolVersion":1,"auth":{"mode":"pair","code":"12345678","deviceName":"Phone"}}"#,
        )
        .expect("parse hello");
        assert!(matches!(
            parsed,
            ClientMessage::Hello {
                protocol_version: 1,
                ..
            }
        ));
    }

    #[test]
    fn pane_lease_messages_and_unknown_types_are_additive() {
        let claim: ClientMessage =
            serde_json::from_str(r#"{"type":"claimPane","paneId":"pane-1","cols":52,"rows":38}"#)
                .expect("parse pane claim");
        assert!(matches!(
            claim,
            ClientMessage::ClaimPane {
                pane_id,
                cols: 52,
                rows: 38,
                req_id: None,
            } if pane_id == "pane-1"
        ));

        let release: ClientMessage =
            serde_json::from_str(r#"{"type":"releasePane","paneId":"pane-1"}"#)
                .expect("parse pane release");
        assert!(matches!(
            release,
            ClientMessage::ReleasePane { pane_id, req_id: None } if pane_id == "pane-1"
        ));

        let unknown: ClientMessage =
            serde_json::from_str(r#"{"type":"futureThing"}"#).expect("parse unknown message");
        assert!(matches!(unknown, ClientMessage::Unknown));
    }

    #[test]
    fn authed_capabilities_may_be_empty() {
        let value = serde_json::to_value(ServerMessage::Authed {
            device_id: "device-1".into(),
            device_token: None,
            desktop_name: "Desktop".into(),
            protocol_version: 1,
            app_version: "0.0.0".into(),
            capabilities: Vec::new(),
        })
        .expect("serialize authed");
        assert_eq!(value["capabilities"], serde_json::json!([]));
    }

    #[test]
    fn workspace_alert_count_uses_camel_case_contract() {
        let workspace = WorkspaceDto::from_session(
            SessionMeta {
                id: uuid::Uuid::new_v4(),
                name: "VibeLink".into(),
                pane_count: 2,
                created_at: 1,
                workspace_folder: None,
            },
            3,
        );
        let value = serde_json::to_value(workspace).expect("serialize workspace");
        assert_eq!(value["alertCount"], 3);
    }
}

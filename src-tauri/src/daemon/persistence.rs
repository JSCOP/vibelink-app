use crate::{
    persistence::{load_json_or_default, write_json_atomic},
    protocol::PaneConfig,
};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PersistedSession {
    pub id: Uuid,
    pub name: String,
    pub created_at: i64,
    pub layout_json: Option<String>,
    #[serde(default)]
    pub workspace_folder: Option<String>,
    #[serde(default)]
    pub sleeping: bool,
    pub panes: Vec<PaneConfig>,
}

pub fn load_sessions(path: &Path) -> Result<Vec<PersistedSession>> {
    load_json_or_default(path, "sessions")
}

pub fn save_sessions(path: &Path, sessions: &[PersistedSession]) -> Result<()> {
    write_json_atomic(path, &sessions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load_sessions_preserves_panes() {
        let path = std::env::temp_dir().join(format!("vibelink-sessions-{}.json", Uuid::new_v4()));
        let session = PersistedSession {
            id: Uuid::new_v4(),
            name: "Workspace".to_string(),
            created_at: 123,
            layout_json: Some("{\"grid\":true}".to_string()),
            workspace_folder: None,
            sleeping: false,
            panes: vec![PaneConfig {
                pane_id: Uuid::new_v4(),
                shell: Some("cmd.exe".to_string()),
                args: vec!["/K".to_string()],
                cwd: Some("E:/work".to_string()),
                env: vec![("A".to_string(), "B".to_string())],
                title: Some("shell".to_string()),
                icon: None,
                profile_id: None,
                role: None,
                cols: 100,
                rows: 40,
            }],
        };

        save_sessions(&path, &[session.clone()]).expect("save sessions");
        let loaded = load_sessions(&path).expect("load sessions");
        let _ = std::fs::remove_file(path);

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, session.id);
        assert_eq!(loaded[0].name, session.name);
        assert_eq!(loaded[0].layout_json, session.layout_json);
        assert_eq!(loaded[0].panes, session.panes);
    }

    #[test]
    fn save_and_load_sessions_preserves_workspace_folder() {
        let path =
            std::env::temp_dir().join(format!("vibelink-session-cwd-{}.json", Uuid::new_v4()));
        let session = PersistedSession {
            id: Uuid::new_v4(),
            name: "Repo".to_string(),
            created_at: 123,
            layout_json: None,
            workspace_folder: Some("C:\\".to_string()),
            sleeping: true,
            panes: Vec::new(),
        };

        save_sessions(&path, &[session.clone()]).expect("save sessions");
        let loaded = load_sessions(&path).expect("load sessions");
        let _ = std::fs::remove_file(path);

        assert_eq!(loaded, vec![session]);
    }

    #[test]
    fn save_sessions_replaces_existing_file() {
        let path =
            std::env::temp_dir().join(format!("replace-vibelink-sessions-{}.json", Uuid::new_v4()));
        std::fs::write(&path, "[]").expect("seed sessions file");
        let session = PersistedSession {
            id: Uuid::new_v4(),
            name: "Workspace".to_string(),
            created_at: 123,
            layout_json: None,
            workspace_folder: None,
            sleeping: false,
            panes: Vec::new(),
        };

        save_sessions(&path, &[session.clone()]).expect("replace existing sessions file");
        let loaded = load_sessions(&path).expect("load replaced sessions file");
        let _ = std::fs::remove_file(path);

        assert_eq!(loaded, vec![session]);
    }

    #[test]
    fn save_sessions_is_atomic() {
        let path =
            std::env::temp_dir().join(format!("atomic-vibelink-sessions-{}.json", Uuid::new_v4()));
        let tmp = path.with_extension("tmp");
        let session = PersistedSession {
            id: Uuid::new_v4(),
            name: "Workspace".to_string(),
            created_at: 123,
            layout_json: None,
            workspace_folder: Some("E:/work".to_string()),
            sleeping: false,
            panes: Vec::new(),
        };

        save_sessions(&path, &[session.clone()]).expect("atomic save sessions");
        let loaded = load_sessions(&path).expect("load atomic sessions");

        assert_eq!(loaded, vec![session]);
        assert!(!tmp.exists());

        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(tmp);
    }

    #[test]
    fn missing_sessions_file_loads_empty() {
        let path =
            std::env::temp_dir().join(format!("missing-vibelink-sessions-{}.json", Uuid::new_v4()));

        assert_eq!(load_sessions(&path).expect("load missing"), Vec::new());
    }

    #[test]
    fn load_sessions_preserves_persisted_panes() {
        let path =
            std::env::temp_dir().join(format!("legacy-vibelink-sessions-{}.json", Uuid::new_v4()));
        let session_id = Uuid::new_v4();
        let pane_id = Uuid::new_v4();
        let json = format!(
            r#"[{{"id":"{session_id}","name":"Smoke","createdAt":123,"layoutJson":null,"panes":[{{"paneId":"{pane_id}","shell":"cmd.exe","args":["/C","echo stale"],"cwd":null,"env":[],"title":"stale","cols":80,"rows":24}}]}}]"#
        );
        std::fs::write(&path, json).expect("write legacy sessions");

        let loaded = load_sessions(&path).expect("load legacy sessions");
        let _ = std::fs::remove_file(path);

        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].panes.len(), 1);
        assert_eq!(loaded[0].panes[0].pane_id, pane_id);
    }
}

use crate::protocol::PaneConfig;
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::Path,
};
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
    pub panes: Vec<PaneConfig>,
}

pub fn load_sessions(path: &Path) -> Result<Vec<PersistedSession>> {
    match fs::read_to_string(path) {
        Ok(json) => serde_json::from_str(&json).context("parse sessions.json"),
        Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(err) => Err(err).context("read sessions.json"),
    }
}

pub fn save_sessions(path: &Path, sessions: &[PersistedSession]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).context("create sessions directory")?;
    }
    let json = serde_json::to_string_pretty(sessions).context("serialize sessions.json")?;
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp).context("create sessions temp file")?;
        file.write_all(json.as_bytes())
            .context("write sessions temp file")?;
        file.flush().context("flush sessions temp file")?;
        file.sync_all().context("fsync sessions temp file")?;
    }
    fs::rename(&tmp, path).context("rename sessions temp file")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load_sessions_preserves_panes() {
        let path = std::env::temp_dir().join(format!("awt-sessions-{}.json", Uuid::new_v4()));
        let session = PersistedSession {
            id: Uuid::new_v4(),
            name: "Workspace".to_string(),
            created_at: 123,
            layout_json: Some("{\"grid\":true}".to_string()),
            workspace_folder: None,
            panes: vec![PaneConfig {
                pane_id: Uuid::new_v4(),
                shell: Some("cmd.exe".to_string()),
                args: vec!["/K".to_string()],
                cwd: Some("E:/work".to_string()),
                env: vec![("A".to_string(), "B".to_string())],
                title: Some("shell".to_string()),
                icon: None,
                profile_id: None,
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
        let path = std::env::temp_dir().join(format!("awt-session-cwd-{}.json", Uuid::new_v4()));
        let session = PersistedSession {
            id: Uuid::new_v4(),
            name: "Repo".to_string(),
            created_at: 123,
            layout_json: None,
            workspace_folder: Some("C:\\".to_string()),
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
            std::env::temp_dir().join(format!("replace-awt-sessions-{}.json", Uuid::new_v4()));
        std::fs::write(&path, "[]").expect("seed sessions file");
        let session = PersistedSession {
            id: Uuid::new_v4(),
            name: "Workspace".to_string(),
            created_at: 123,
            layout_json: None,
            workspace_folder: None,
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
            std::env::temp_dir().join(format!("atomic-awt-sessions-{}.json", Uuid::new_v4()));
        let tmp = path.with_extension("tmp");
        let session = PersistedSession {
            id: Uuid::new_v4(),
            name: "Workspace".to_string(),
            created_at: 123,
            layout_json: None,
            workspace_folder: Some("E:/work".to_string()),
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
            std::env::temp_dir().join(format!("missing-awt-sessions-{}.json", Uuid::new_v4()));

        assert_eq!(load_sessions(&path).expect("load missing"), Vec::new());
    }

    #[test]
    fn load_sessions_preserves_persisted_panes() {
        let path =
            std::env::temp_dir().join(format!("legacy-awt-sessions-{}.json", Uuid::new_v4()));
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

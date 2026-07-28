use crate::{
    protocol::PaneConfig,
    storage::{
        load_with_recovery, parse_json, require_supported_schema, write_json, DocumentError,
    },
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
    /// Orca-parity clean-exit marker. `true` means the previous run shut this
    /// workspace down deliberately, so its panes must NOT be cold-restored on
    /// the next daemon start. Only an unclean exit (crash, reboot, kill)
    /// leaves this `false` and therefore restorable.
    #[serde(default)]
    pub clean_exit: bool,
    pub panes: Vec<PaneConfig>,
}

const SESSION_SCHEMA_VERSION: u64 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionDocument {
    #[serde(default = "session_schema_version")]
    schema_version: u64,
    #[serde(default)]
    sessions: Vec<PersistedSession>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionDocumentRef<'a> {
    schema_version: u64,
    sessions: &'a [PersistedSession],
}

#[derive(Deserialize)]
#[serde(untagged)]
enum StoredSessions {
    Document(SessionDocument),
    Legacy(Vec<PersistedSession>),
}

fn session_schema_version() -> u64 {
    SESSION_SCHEMA_VERSION
}

fn parse_sessions(bytes: &[u8]) -> std::result::Result<Vec<PersistedSession>, DocumentError> {
    match parse_json::<StoredSessions>(bytes)? {
        StoredSessions::Document(document) => {
            require_supported_schema(document.schema_version, SESSION_SCHEMA_VERSION)?;
            Ok(document.sessions)
        }
        StoredSessions::Legacy(sessions) => Ok(sessions),
    }
}

pub fn load_sessions(path: &Path) -> Result<Vec<PersistedSession>> {
    Ok(load_with_recovery(path, Vec::new(), parse_sessions)?.value)
}

pub fn save_sessions(path: &Path, sessions: &[PersistedSession]) -> Result<()> {
    write_json(
        path,
        &SessionDocumentRef {
            schema_version: SESSION_SCHEMA_VERSION,
            sessions,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        time::{Duration, SystemTime},
    };

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vibelink-sessions-{label}-{}.json", Uuid::new_v4()))
    }

    fn sibling_with_suffix(path: &Path, suffix: &str) -> PathBuf {
        let mut value = path.as_os_str().to_os_string();
        value.push(suffix);
        PathBuf::from(value)
    }

    fn backup_path(path: &Path) -> PathBuf {
        sibling_with_suffix(path, ".bak")
    }

    fn temporary_path(path: &Path) -> PathBuf {
        sibling_with_suffix(path, ".tmp")
    }

    fn cleanup(path: &Path) {
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(backup_path(path));
        let _ = fs::remove_file(temporary_path(path));
        let Some(parent) = path.parent() else {
            return;
        };
        let Some(file_name) = path.file_name().map(|name| name.to_string_lossy()) else {
            return;
        };
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.flatten() {
                let candidate = entry.file_name();
                let candidate = candidate.to_string_lossy();
                if candidate.starts_with(file_name.as_ref()) && candidate.contains(".corrupt-") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    fn sample_session(name: &str) -> PersistedSession {
        PersistedSession {
            id: Uuid::new_v4(),
            name: name.to_string(),
            created_at: 123,
            layout_json: Some("{\"grid\":true}".to_string()),
            workspace_folder: Some("E:/work".to_string()),
            sleeping: false,
            clean_exit: false,
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
                restore_on_start: true,
                cols: 100,
                rows: 40,
            }],
        }
    }

    fn quarantined_files(path: &Path) -> Vec<PathBuf> {
        let parent = path.parent().expect("sessions parent");
        let file_name = path.file_name().expect("sessions name").to_string_lossy();
        fs::read_dir(parent)
            .expect("read sessions parent")
            .flatten()
            .filter_map(|entry| {
                let candidate = entry.file_name();
                let candidate = candidate.to_string_lossy();
                (candidate.starts_with(file_name.as_ref()) && candidate.contains(".corrupt-"))
                    .then(|| entry.path())
            })
            .collect()
    }

    #[test]
    fn versioned_round_trip_preserves_session_pane_layout_and_workspace_fields() {
        let path = test_path("round-trip");
        let session = sample_session("Workspace");

        save_sessions(&path, std::slice::from_ref(&session)).expect("save sessions");
        let loaded = load_sessions(&path).expect("load sessions");
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read stored sessions"))
                .expect("parse stored sessions");

        assert_eq!(loaded, vec![session]);
        assert_eq!(stored["schemaVersion"], SESSION_SCHEMA_VERSION);
        assert!(stored["sessions"].is_array());
        cleanup(&path);
    }

    #[test]
    fn legacy_root_array_still_loads() {
        let path = test_path("legacy");
        let session = sample_session("Legacy");
        fs::write(
            &path,
            serde_json::to_vec(std::slice::from_ref(&session)).expect("serialize legacy sessions"),
        )
        .expect("write legacy sessions");

        assert_eq!(
            load_sessions(&path).expect("load legacy sessions"),
            vec![session]
        );
        cleanup(&path);
    }

    #[test]
    fn truncated_primary_recovers_valid_backup() {
        let path = test_path("backup-recovery");
        let first = sample_session("First");
        let second = sample_session("Second");
        save_sessions(&path, std::slice::from_ref(&first)).expect("save first sessions");
        save_sessions(&path, std::slice::from_ref(&second)).expect("save second sessions");
        fs::write(&path, b"{").expect("truncate primary");

        assert_eq!(
            load_sessions(&path).expect("recover sessions"),
            vec![first.clone()]
        );
        assert_eq!(
            load_sessions(&path).expect("reload restored sessions"),
            vec![first]
        );
        assert_eq!(quarantined_files(&path).len(), 1);
        cleanup(&path);
    }

    #[test]
    fn invalid_primary_and_backup_start_empty_after_quarantine() {
        let path = test_path("invalid-both");
        fs::write(&path, b"{").expect("write invalid primary");
        fs::write(backup_path(&path), b"[").expect("write invalid backup");

        assert!(load_sessions(&path)
            .expect("load safe empty sessions")
            .is_empty());
        assert!(!path.exists());
        assert!(!backup_path(&path).exists());
        assert_eq!(quarantined_files(&path).len(), 2);
        cleanup(&path);
    }

    #[test]
    fn stale_temp_is_removed_before_loading_sessions() {
        let path = test_path("stale-temp");
        let session = sample_session("Stored");
        save_sessions(&path, std::slice::from_ref(&session)).expect("save sessions");
        let temporary = temporary_path(&path);
        fs::write(&temporary, b"stale partial write").expect("write stale temp");
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .expect("open stale temp")
            .set_modified(SystemTime::now() - Duration::from_secs(10 * 60 + 1))
            .expect("age stale temp");

        assert_eq!(
            load_sessions(&path).expect("load with stale temp"),
            vec![session]
        );
        assert!(!temporary.exists());
        cleanup(&path);
    }

    #[test]
    fn newer_schema_errors_without_overwriting_sessions() {
        let path = test_path("newer-schema");
        fs::write(&path, br#"{"schemaVersion":2,"sessions":[]}"#)
            .expect("write newer sessions schema");

        let error = load_sessions(&path).expect_err("reject newer sessions schema");
        assert!(error.to_string().contains("unsupported storage schema 2"));
        assert!(!path.exists());
        assert_eq!(quarantined_files(&path).len(), 1);
        cleanup(&path);
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
        assert!(!loaded[0].panes[0].restore_on_start);
    }
}

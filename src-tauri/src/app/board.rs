use super::{
    authorization::Capability, daemon_client::DaemonClient, entitlement::EntitlementSupervisor,
};
use crate::{
    protocol::{ClientToDaemon, ReplyResult, TaskSignal},
    storage::{
        load_with_recovery, parse_json, require_supported_schema, write_json, DocumentError,
    },
};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, LazyLock, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
use uuid::Uuid;

static BOARD_LOCKS: LazyLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const BOARD_SCHEMA_VERSION: u64 = 1;

fn board_schema_version() -> u64 {
    BOARD_SCHEMA_VERSION
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDoc {
    #[serde(default = "board_schema_version")]
    pub schema_version: u64,
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub tasks: HashMap<String, Task>,
    #[serde(default)]
    pub task_order: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<Brief>,
}

impl Default for BoardDoc {
    fn default() -> Self {
        Self {
            schema_version: BOARD_SCHEMA_VERSION,
            revision: 0,
            tasks: HashMap::new(),
            task_order: Vec::new(),
            brief: None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Brief {
    pub purpose: String,
    pub notes: String,
    pub updated_at: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    Pending,
    Assigned,
    InProgress,
    Done,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: String,
    pub session_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: TaskStatus,
    #[serde(default)]
    pub status_timestamps: HashMap<TaskStatus, u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_pane_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assigned_role: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub baseline_ref: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub commit_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskPatch {
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub title: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub description: Option<Option<String>>,
    #[serde(default)]
    pub status: Option<TaskStatus>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub assigned_pane_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub assigned_role: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub baseline_ref: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub worktree_path: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub commit_message: Option<Option<String>>,
    #[serde(default, deserialize_with = "double_option::deserialize")]
    pub result_summary: Option<Option<String>>,
}

mod double_option {
    use serde::{Deserialize, Deserializer};

    pub fn deserialize<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
    where
        D: Deserializer<'de>,
        T: Deserialize<'de>,
    {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

#[tauri::command]
pub async fn board_read(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    session_id: String,
) -> Result<String, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || board_read_native(&session_id))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn board_write(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    json: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_for_write = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || board_write_native(&session_for_write, &json))
        .await
        .map_err(to_string)?
        .map_err(to_string)?;
    emit_board_changed(&client, &session_id).map_err(to_string)
}

#[tauri::command]
pub async fn board_task_create(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    title: String,
    description: Option<String>,
) -> Result<Task, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_for_write = session_id.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        board_task_create_native(&session_for_write, &title, description.as_deref())
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)?;
    emit_board_changed(&client, &session_id).map_err(to_string)?;
    Ok(task)
}

#[tauri::command]
pub async fn board_task_update(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    task_id: String,
    patch: TaskPatch,
) -> Result<Task, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_for_write = session_id.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        board_task_update_native(&session_for_write, &task_id, patch)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)?;
    emit_board_changed(&client, &session_id).map_err(to_string)?;
    Ok(task)
}

#[tauri::command]
pub async fn board_task_delete(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    task_id: String,
) -> Result<(), String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_for_write = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        board_task_delete_native(&session_for_write, &task_id)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)?;
    emit_board_changed(&client, &session_id).map_err(to_string)
}

#[tauri::command]
pub async fn board_task_done(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    task_id: String,
    commit_msg: Option<String>,
    result_summary: Option<String>,
) -> Result<Task, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_for_write = session_id.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        board_task_done_native(&session_for_write, &task_id, commit_msg, result_summary)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)?;
    emit_board_changed(&client, &session_id).map_err(to_string)?;
    Ok(task)
}

#[tauri::command]
pub async fn board_task_note(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    task_id: String,
    message: String,
) -> Result<Task, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_for_write = session_id.clone();
    let task = tauri::async_runtime::spawn_blocking(move || {
        board_task_note_native(&session_for_write, &task_id, &message)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)?;
    emit_board_changed(&client, &session_id).map_err(to_string)?;
    Ok(task)
}

#[tauri::command]
pub async fn board_brief_get(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    session_id: String,
) -> Result<Option<Brief>, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || board_brief_get_native(&session_id))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn board_brief_set(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    purpose: String,
    notes: String,
) -> Result<Brief, String> {
    supervisor
        .authorize(Capability::WorkspaceMutate)
        .map_err(to_string)?;
    let session_for_write = session_id.clone();
    let brief = tauri::async_runtime::spawn_blocking(move || {
        board_brief_set_native(&session_for_write, purpose, notes)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)?;
    emit_board_changed(&client, &session_id).map_err(to_string)?;
    Ok(brief)
}

pub fn board_read_native(session_id: &str) -> Result<String> {
    serde_json::to_string(&read_board_doc(session_id)?).map_err(Into::into)
}

pub fn board_doc_native(session_id: &str) -> Result<BoardDoc> {
    read_board_doc(session_id)
}

pub fn board_write_native(session_id: &str, json: &str) -> Result<()> {
    let mut incoming = parse_board_doc(json)?;
    mutate_board(session_id, move |current| {
        incoming.revision = current.revision;
        *current = incoming;
        Ok(())
    })
}

pub fn board_task_create_native(
    session_id: &str,
    title: &str,
    description: Option<&str>,
) -> Result<Task> {
    let title = title.trim();
    if title.is_empty() {
        bail!("task title is required");
    }
    let session_id = session_id.to_string();
    mutate_board(&session_id.clone(), move |board| {
        let now = current_millis();
        let task = Task {
            id: Uuid::new_v4().to_string(),
            session_id,
            title: title.to_string(),
            description: description.unwrap_or_default().to_string(),
            status: TaskStatus::Pending,
            status_timestamps: HashMap::from([(TaskStatus::Pending, now)]),
            assigned_pane_id: None,
            assigned_role: None,
            baseline_ref: None,
            worktree_path: None,
            commit_message: None,
            result_summary: None,
            created_at: now,
            updated_at: now,
        };
        board.task_order.push(task.id.clone());
        board.tasks.insert(task.id.clone(), task.clone());
        Ok(task)
    })
}

pub fn board_task_update_native(session_id: &str, task_id: &str, patch: TaskPatch) -> Result<Task> {
    mutate_board(session_id, |board| {
        let task = board
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| anyhow!("task not found: {task_id}"))?;
        apply_task_patch(task, patch)?;
        Ok(task.clone())
    })
}

pub fn board_task_delete_native(session_id: &str, task_id: &str) -> Result<()> {
    mutate_board(session_id, |board| {
        if board.tasks.remove(task_id).is_none() {
            bail!("task not found: {task_id}");
        }
        board.task_order.retain(|id| id != task_id);
        Ok(())
    })
}

pub fn board_task_done_native(
    session_id: &str,
    task_id: &str,
    commit_msg: Option<String>,
    result_summary: Option<String>,
) -> Result<Task> {
    board_task_update_native(
        session_id,
        task_id,
        TaskPatch {
            status: Some(TaskStatus::Done),
            commit_message: commit_msg.map(Some),
            result_summary: result_summary.map(Some),
            ..TaskPatch::default()
        },
    )
}

pub fn board_task_note_native(session_id: &str, task_id: &str, message: &str) -> Result<Task> {
    let note = message.trim();
    if note.is_empty() {
        bail!("task note is required");
    }
    mutate_board(session_id, |board| {
        let task = board
            .tasks
            .get_mut(task_id)
            .ok_or_else(|| anyhow!("task not found: {task_id}"))?;
        task.result_summary = Some(
            [task.result_summary.as_deref(), Some(note)]
                .into_iter()
                .flatten()
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n"),
        );
        if task.status != TaskStatus::Done {
            task.status = TaskStatus::InProgress;
            task.status_timestamps
                .insert(TaskStatus::InProgress, current_millis());
        }
        task.updated_at = current_millis();
        Ok(task.clone())
    })
}

pub fn board_brief_get_native(session_id: &str) -> Result<Option<Brief>> {
    Ok(read_board_doc(session_id)?.brief)
}

pub fn board_brief_set_native(session_id: &str, purpose: String, notes: String) -> Result<Brief> {
    mutate_board(session_id, |board| {
        let brief = Brief {
            purpose: purpose.trim().to_string(),
            notes: notes.trim().to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        board.brief = Some(brief.clone());
        Ok(brief)
    })
}

pub fn board_path(session_id: &str) -> Result<PathBuf> {
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join("kanban")
        .join(format!("{}.json", sanitize_session_id(session_id))))
}

fn mutate_board<T>(
    session_id: &str,
    mutation: impl FnOnce(&mut BoardDoc) -> Result<T>,
) -> Result<T> {
    let lock = board_lock(session_id);
    let _guard = lock.lock().expect("board session mutex poisoned");
    let path = board_path(session_id)?;
    mutate_board_path(&path, mutation)
}

fn mutate_board_path<T>(
    path: &Path,
    mutation: impl FnOnce(&mut BoardDoc) -> Result<T>,
) -> Result<T> {
    let mut board = read_board_doc_from_path(path)?;
    let result = mutation(&mut board)?;
    board.revision = board.revision.saturating_add(1);
    write_board_doc_to_path(path, &board)?;
    Ok(result)
}

fn board_lock(session_id: &str) -> Arc<Mutex<()>> {
    let mut locks = BOARD_LOCKS.lock().expect("board locks mutex poisoned");
    Arc::clone(
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(()))),
    )
}

fn read_board_doc(session_id: &str) -> Result<BoardDoc> {
    read_board_doc_from_path(&board_path(session_id)?)
}

fn read_board_doc_from_path(path: &Path) -> Result<BoardDoc> {
    Ok(load_with_recovery(path, BoardDoc::default(), parse_board_doc_bytes)?.value)
}

fn parse_board_doc(json: &str) -> Result<BoardDoc> {
    parse_board_doc_bytes(json.as_bytes()).map_err(|error| match error {
        DocumentError::Invalid(error) => error.context("parse board JSON"),
        DocumentError::UnsupportedSchema { found, supported } => {
            anyhow!("unsupported storage schema {found}; supported through {supported}")
        }
    })
}

fn parse_board_doc_bytes(bytes: &[u8]) -> std::result::Result<BoardDoc, DocumentError> {
    let mut board: BoardDoc = parse_json(bytes)?;
    require_supported_schema(board.schema_version, BOARD_SCHEMA_VERSION)?;
    board.task_order.retain(|id| board.tasks.contains_key(id));
    let mut missing = board
        .tasks
        .values()
        .filter(|task| !board.task_order.contains(&task.id))
        .map(|task| task.id.clone())
        .collect::<Vec<_>>();
    missing.sort_by_key(|id| {
        board
            .tasks
            .get(id)
            .map(|task| task.created_at)
            .unwrap_or_default()
    });
    board.task_order.extend(missing);
    Ok(board)
}

fn write_board_doc_to_path(path: &Path, board: &BoardDoc) -> Result<()> {
    write_json(path, board)
}

fn apply_task_patch(task: &mut Task, patch: TaskPatch) -> Result<()> {
    if let Some(title) = patch.title {
        let title = title.unwrap_or_default().trim().to_string();
        if title.is_empty() {
            bail!("task title is required");
        }
        task.title = title;
    }
    if let Some(description) = patch.description {
        task.description = description.unwrap_or_default();
    }
    if let Some(status) = patch.status {
        if status != task.status {
            task.status = status;
            task.status_timestamps.insert(status, current_millis());
        }
    }
    apply_optional_string(&mut task.assigned_pane_id, patch.assigned_pane_id);
    apply_optional_string(&mut task.assigned_role, patch.assigned_role);
    apply_optional_string(&mut task.baseline_ref, patch.baseline_ref);
    apply_optional_string(&mut task.worktree_path, patch.worktree_path);
    apply_optional_string(&mut task.commit_message, patch.commit_message);
    apply_optional_string(&mut task.result_summary, patch.result_summary);
    task.updated_at = current_millis();
    Ok(())
}

fn apply_optional_string(target: &mut Option<String>, patch: Option<Option<String>>) {
    if let Some(value) = patch {
        *target = value.and_then(|value| {
            let trimmed = value.trim().to_string();
            (!trimmed.is_empty()).then_some(trimmed)
        });
    }
}

fn emit_board_changed(client: &DaemonClient, session_id: &str) -> Result<()> {
    let session_id = Uuid::parse_str(session_id).context("invalid board session id")?;
    match client.request_reply(|req| ClientToDaemon::TaskEvent {
        req,
        session_id,
        event: TaskSignal::BoardChanged {},
    })? {
        ReplyResult::Ok => Ok(()),
        other => bail!("unexpected daemon response: {other:?}"),
    }
}

fn current_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn sanitize_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>()
}

fn to_string(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::{Path, PathBuf},
        time::Duration,
    };

    fn test_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vibelink-board-{label}-{}.json", Uuid::new_v4()))
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

    fn quarantined_files(path: &Path) -> Vec<PathBuf> {
        let parent = path.parent().expect("board parent");
        let file_name = path.file_name().expect("board name").to_string_lossy();
        fs::read_dir(parent)
            .expect("read board parent")
            .flatten()
            .filter_map(|entry| {
                let candidate = entry.file_name();
                let candidate = candidate.to_string_lossy();
                (candidate.starts_with(file_name.as_ref()) && candidate.contains(".corrupt-"))
                    .then(|| entry.path())
            })
            .collect()
    }

    fn sample_task(id: &str, title: &str, created_at: u64) -> Task {
        Task {
            id: id.to_string(),
            session_id: "session-1".to_string(),
            title: title.to_string(),
            description: String::new(),
            status: TaskStatus::Pending,
            status_timestamps: HashMap::from([(TaskStatus::Pending, created_at)]),
            assigned_pane_id: None,
            assigned_role: None,
            baseline_ref: None,
            worktree_path: None,
            commit_message: None,
            result_summary: None,
            created_at,
            updated_at: created_at,
        }
    }

    fn sample_board(revision: u64, title: &str) -> BoardDoc {
        let task = sample_task("task-1", title, 1);
        BoardDoc {
            schema_version: BOARD_SCHEMA_VERSION,
            revision,
            task_order: vec![task.id.clone()],
            tasks: HashMap::from([(task.id.clone(), task)]),
            brief: Some(Brief {
                purpose: "Ship safely".to_string(),
                notes: "Keep state durable".to_string(),
                updated_at: "2026-07-19T00:00:00Z".to_string(),
            }),
        }
    }

    #[test]
    fn task_mutations_increment_revision_and_write_schema_v1() {
        let path = test_path("round-trip");
        let session_id = Uuid::new_v4().to_string();
        let task = mutate_board_path(&path, |board| {
            let task = sample_task("task-1", "Ship it", current_millis());
            let mut task = task;
            task.session_id = session_id.clone();
            board.task_order.push(task.id.clone());
            board.tasks.insert(task.id.clone(), task.clone());
            Ok(task)
        })
        .expect("create task");
        assert_eq!(task.status, TaskStatus::Pending);

        mutate_board_path(&path, |board| {
            let task = board.tasks.get_mut("task-1").expect("task");
            apply_task_patch(
                task,
                TaskPatch {
                    status: Some(TaskStatus::InProgress),
                    ..TaskPatch::default()
                },
            )?;
            Ok(())
        })
        .expect("update task");
        mutate_board_path(&path, |board| {
            let task = board.tasks.get_mut("task-1").expect("task");
            task.result_summary = Some("note".to_string());
            task.status = TaskStatus::Done;
            task.status_timestamps
                .insert(TaskStatus::Done, current_millis());
            Ok(())
        })
        .expect("finish task");

        let reloaded = read_board_doc_from_path(&path).expect("reload board");
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).expect("read board file"))
                .expect("parse board file");
        assert_eq!(reloaded.schema_version, BOARD_SCHEMA_VERSION);
        assert_eq!(reloaded.revision, 3);
        assert_eq!(reloaded.tasks["task-1"].status, TaskStatus::Done);
        assert_eq!(
            reloaded.tasks["task-1"].result_summary.as_deref(),
            Some("note")
        );
        assert_eq!(stored["schemaVersion"], BOARD_SCHEMA_VERSION);
        cleanup(&path);
    }

    #[test]
    fn legacy_revisionless_board_defaults_schema_and_normalizes_task_order() {
        let path = test_path("legacy");
        fs::write(
            &path,
            r#"{"tasks":{"task-1":{"id":"task-1","sessionId":"session-1","title":"Old","description":"","status":"pending","statusTimestamps":{"pending":1},"createdAt":1,"updatedAt":1}},"taskOrder":["missing"]}"#,
        )
        .expect("seed legacy board");

        let board = read_board_doc_from_path(&path).expect("read legacy board");
        assert_eq!(board.schema_version, BOARD_SCHEMA_VERSION);
        assert_eq!(board.revision, 0);
        assert_eq!(board.task_order, vec!["task-1"]);
        cleanup(&path);
    }

    #[test]
    fn truncated_primary_recovers_valid_board_backup() {
        let path = test_path("backup-recovery");
        let first = sample_board(7, "First");
        let second = sample_board(8, "Second");
        write_board_doc_to_path(&path, &first).expect("write first board");
        write_board_doc_to_path(&path, &second).expect("write second board");
        fs::write(&path, b"{").expect("truncate board primary");

        let recovered = read_board_doc_from_path(&path).expect("recover board");
        assert_eq!(recovered.revision, first.revision);
        assert_eq!(recovered.tasks["task-1"].title, "First");
        let restored = read_board_doc_from_path(&path).expect("reload restored board");
        assert_eq!(restored.tasks["task-1"].title, "First");
        assert_eq!(quarantined_files(&path).len(), 1);
        cleanup(&path);
    }

    #[test]
    fn invalid_primary_and_backup_start_empty_board_after_quarantine() {
        let path = test_path("invalid-both");
        fs::write(&path, b"{").expect("write invalid board primary");
        fs::write(backup_path(&path), b"[").expect("write invalid board backup");

        let board = read_board_doc_from_path(&path).expect("load safe empty board");
        assert_eq!(board.schema_version, BOARD_SCHEMA_VERSION);
        assert_eq!(board.revision, 0);
        assert!(board.tasks.is_empty());
        assert!(board.task_order.is_empty());
        assert!(!path.exists());
        assert!(!backup_path(&path).exists());
        assert_eq!(quarantined_files(&path).len(), 2);
        cleanup(&path);
    }

    #[test]
    fn stale_temp_is_removed_before_loading_board() {
        let path = test_path("stale-temp");
        let board = sample_board(4, "Stored");
        write_board_doc_to_path(&path, &board).expect("write board");
        let temporary = temporary_path(&path);
        fs::write(&temporary, b"stale partial write").expect("write stale board temp");
        fs::OpenOptions::new()
            .write(true)
            .open(&temporary)
            .expect("open stale board temp")
            .set_modified(SystemTime::now() - Duration::from_secs(10 * 60 + 1))
            .expect("age stale board temp");

        let loaded = read_board_doc_from_path(&path).expect("load board with stale temp");
        assert_eq!(loaded.revision, board.revision);
        assert!(!temporary.exists());
        cleanup(&path);
    }

    #[test]
    fn newer_schema_errors_without_overwriting_board() {
        let path = test_path("newer-schema");
        fs::write(
            &path,
            br#"{"schemaVersion":2,"revision":99,"tasks":{},"taskOrder":[]}"#,
        )
        .expect("write newer board schema");

        let error = read_board_doc_from_path(&path).expect_err("reject newer board schema");
        assert!(error.to_string().contains("unsupported storage schema 2"));
        assert!(!path.exists());
        assert_eq!(quarantined_files(&path).len(), 1);
        cleanup(&path);
    }
}

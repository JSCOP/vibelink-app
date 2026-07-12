use super::{daemon_client::DaemonClient, license::LicenseService};
use crate::protocol::{ClientToDaemon, ReplyResult, TaskSignal};
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

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardDoc {
    #[serde(default)]
    pub revision: u64,
    #[serde(default)]
    pub tasks: HashMap<String, Task>,
    #[serde(default)]
    pub task_order: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<Brief>,
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
    license: State<'_, Arc<LicenseService>>,
    session_id: String,
) -> Result<String, String> {
    license.require_pro_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || board_read_native(&session_id))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn board_write(
    license: State<'_, Arc<LicenseService>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    json: String,
) -> Result<(), String> {
    license.require_pro_cached().map_err(to_string)?;
    let session_for_write = session_id.clone();
    tauri::async_runtime::spawn_blocking(move || board_write_native(&session_for_write, &json))
        .await
        .map_err(to_string)?
        .map_err(to_string)?;
    emit_board_changed(&client, &session_id).map_err(to_string)
}

#[tauri::command]
pub async fn board_task_create(
    license: State<'_, Arc<LicenseService>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    title: String,
    description: Option<String>,
) -> Result<Task, String> {
    license.require_pro_cached().map_err(to_string)?;
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
    license: State<'_, Arc<LicenseService>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    task_id: String,
    patch: TaskPatch,
) -> Result<Task, String> {
    license.require_pro_cached().map_err(to_string)?;
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
    license: State<'_, Arc<LicenseService>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    task_id: String,
) -> Result<(), String> {
    license.require_pro_cached().map_err(to_string)?;
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
    license: State<'_, Arc<LicenseService>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    task_id: String,
    commit_msg: Option<String>,
    result_summary: Option<String>,
) -> Result<Task, String> {
    license.require_pro_cached().map_err(to_string)?;
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
    license: State<'_, Arc<LicenseService>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    task_id: String,
    message: String,
) -> Result<Task, String> {
    license.require_pro_cached().map_err(to_string)?;
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
    license: State<'_, Arc<LicenseService>>,
    session_id: String,
) -> Result<Option<Brief>, String> {
    license.require_pro_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || board_brief_get_native(&session_id))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn board_brief_set(
    license: State<'_, Arc<LicenseService>>,
    client: State<'_, DaemonClient>,
    session_id: String,
    purpose: String,
    notes: String,
) -> Result<Brief, String> {
    license.require_pro_cached().map_err(to_string)?;
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
    match std::fs::read_to_string(path) {
        Ok(contents) => parse_board_doc(&contents),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(BoardDoc::default()),
        Err(err) => Err(err.into()),
    }
}

fn parse_board_doc(json: &str) -> Result<BoardDoc> {
    if json.trim().is_empty() {
        return Ok(BoardDoc::default());
    }
    let mut board: BoardDoc = serde_json::from_str(json).context("parse board JSON")?;
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
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(board)?)?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("replace board file {}", path.display()))?;
    Ok(())
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

    fn test_path() -> PathBuf {
        std::env::temp_dir().join(format!("vibelink-board-{}.json", Uuid::new_v4()))
    }

    #[test]
    fn task_mutations_increment_revision_and_round_trip() {
        let path = test_path();
        let session_id = Uuid::new_v4().to_string();
        let task = mutate_board_path(&path, |board| {
            let now = current_millis();
            let task = Task {
                id: "task-1".to_string(),
                session_id: session_id.clone(),
                title: "Ship it".to_string(),
                description: String::new(),
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
        assert_eq!(reloaded.revision, 3);
        assert_eq!(reloaded.tasks["task-1"].status, TaskStatus::Done);
        assert_eq!(
            reloaded.tasks["task-1"].result_summary.as_deref(),
            Some("note")
        );
        std::fs::remove_file(path).expect("cleanup board");
    }

    #[test]
    fn revisionless_board_is_normalized() {
        let path = test_path();
        std::fs::write(
            &path,
            r#"{"tasks":{"task-1":{"id":"task-1","sessionId":"session-1","title":"Old","description":"","status":"pending","statusTimestamps":{"pending":1},"createdAt":1,"updatedAt":1}},"taskOrder":["task-1"]}"#,
        )
        .expect("seed board");
        let board = read_board_doc_from_path(&path).expect("read legacy board");
        assert_eq!(board.revision, 0);
        assert_eq!(board.task_order, vec!["task-1"]);
        std::fs::remove_file(path).expect("cleanup board");
    }
}

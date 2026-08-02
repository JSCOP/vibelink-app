use super::{
    authorization::Capability, daemon_client::DaemonClient, entitlement::EntitlementSupervisor,
    spawn_daemon,
};
use crate::{
    control_plane::{ControlCommand, ControlResponse},
    protocol::{read_frame, write_frame, ClientToDaemon, DaemonToClient, ReplyResult, TaskSignal},
};
use anyhow::{bail, Context, Result};
use interprocess::local_socket::prelude::*;
use std::sync::Arc;
use tauri::State;
use uuid::Uuid;

pub use crate::control_plane::{BoardDoc, Brief, Task, TaskPatch, TaskStatus};

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
    serde_json::to_string(&board_doc_native(session_id)?).map_err(Into::into)
}

pub fn board_doc_native(session_id: &str) -> Result<BoardDoc> {
    match request_control(ControlCommand::BoardRead {
        session_id: session_id.to_string(),
    })? {
        ControlResponse::Board(board) => Ok(board),
        other => bail!("unexpected control response: {other:?}"),
    }
}

pub fn board_write_native(session_id: &str, json: &str) -> Result<()> {
    let board: BoardDoc = serde_json::from_str(json).context("parse board JSON")?;
    let expected_revision = board.revision;
    match request_control(ControlCommand::BoardWrite {
        session_id: session_id.to_string(),
        board,
        expected_revision,
    })? {
        ControlResponse::Ack => Ok(()),
        other => bail!("unexpected control response: {other:?}"),
    }
}

pub fn board_task_create_native(
    session_id: &str,
    title: &str,
    description: Option<&str>,
) -> Result<Task> {
    task_response(request_control(ControlCommand::TaskCreate {
        session_id: session_id.to_string(),
        title: title.to_string(),
        description: description.map(str::to_string),
    })?)
}

pub fn board_task_update_native(session_id: &str, task_id: &str, patch: TaskPatch) -> Result<Task> {
    task_response(request_control(ControlCommand::TaskUpdate {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        patch,
    })?)
}

pub fn board_task_delete_native(session_id: &str, task_id: &str) -> Result<()> {
    match request_control(ControlCommand::TaskDelete {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
    })? {
        ControlResponse::Ack => Ok(()),
        other => bail!("unexpected control response: {other:?}"),
    }
}

pub fn board_task_done_native(
    session_id: &str,
    task_id: &str,
    commit_msg: Option<String>,
    result_summary: Option<String>,
) -> Result<Task> {
    task_response(request_control(ControlCommand::TaskDone {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        commit_msg,
        result_summary,
    })?)
}

pub fn board_task_note_native(session_id: &str, task_id: &str, message: &str) -> Result<Task> {
    task_response(request_control(ControlCommand::TaskNote {
        session_id: session_id.to_string(),
        task_id: task_id.to_string(),
        message: message.to_string(),
    })?)
}

pub fn board_brief_get_native(session_id: &str) -> Result<Option<Brief>> {
    match request_control(ControlCommand::BriefGet {
        session_id: session_id.to_string(),
    })? {
        ControlResponse::Brief(brief) => Ok(brief),
        other => bail!("unexpected control response: {other:?}"),
    }
}

pub fn board_brief_set_native(session_id: &str, purpose: String, notes: String) -> Result<Brief> {
    match request_control(ControlCommand::BriefSet {
        session_id: session_id.to_string(),
        purpose,
        notes,
    })? {
        ControlResponse::Brief(Some(brief)) => Ok(brief),
        other => bail!("unexpected control response: {other:?}"),
    }
}

fn task_response(response: ControlResponse) -> Result<Task> {
    match response {
        ControlResponse::Task(task) => Ok(task),
        other => bail!("unexpected control response: {other:?}"),
    }
}

fn request_control(command: ControlCommand) -> Result<ControlResponse> {
    let stream = spawn_daemon::connect_daemon().or_else(|_| spawn_daemon::ensure_daemon())?;
    let (mut reader, mut writer) = stream.split();
    let req = 1;
    write_frame(
        &mut writer,
        &ClientToDaemon::Control {
            req,
            operation_id: Uuid::new_v4(),
            command_json: serde_json::to_string(&command)?,
        },
    )?;
    loop {
        match read_frame::<_, DaemonToClient>(&mut reader)? {
            DaemonToClient::Reply {
                req: reply_req,
                result: ReplyResult::Control(response_json),
            } if reply_req == req => {
                return serde_json::from_str(&response_json).context("parse control response")
            }
            DaemonToClient::Error {
                req: Some(reply_req),
                message,
            } if reply_req == req => bail!(message),
            _ => continue,
        }
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

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane::ControlPlane;
    use std::{collections::HashSet, fs, path::PathBuf, sync::Barrier, thread};

    fn test_data_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vibelink-board-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn concurrent_task_mutations_preserve_both_writes_without_legacy_temp_files() {
        let directory = test_data_dir("concurrent-writes");
        let plane = Arc::new(ControlPlane::open(&directory).expect("open control plane"));
        let session_id = Uuid::new_v4().to_string();
        let start = Arc::new(Barrier::new(3));

        let writers = ["First task", "Second task"].map(|title| {
            let plane = Arc::clone(&plane);
            let session_id = session_id.clone();
            let start = Arc::clone(&start);
            thread::spawn(move || {
                start.wait();
                plane.execute(
                    Uuid::new_v4(),
                    ControlCommand::TaskCreate {
                        session_id,
                        title: title.to_string(),
                        description: None,
                    },
                )
            })
        });

        start.wait();
        for writer in writers {
            assert!(matches!(
                writer.join().expect("join board writer"),
                Ok(ControlResponse::Task(_))
            ));
        }

        let ControlResponse::Board(board) = plane
            .execute(
                Uuid::new_v4(),
                ControlCommand::BoardRead {
                    session_id: session_id.clone(),
                },
            )
            .expect("read concurrent board")
        else {
            panic!("board response");
        };
        let titles = board
            .tasks
            .values()
            .map(|task| task.title.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(titles, HashSet::from(["First task", "Second task"]));
        assert_eq!(board.task_order.len(), 2);
        assert_eq!(board.revision, 2);

        let legacy_path = directory.join("kanban").join(format!("{session_id}.json"));
        assert!(!legacy_path.exists());
        assert!(!legacy_path.with_extension("json.tmp").exists());

        drop(plane);
        fs::remove_dir_all(directory).expect("cleanup control plane");
    }
}

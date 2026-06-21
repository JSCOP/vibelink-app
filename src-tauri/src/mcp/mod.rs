use crate::app::board::{board_read_native, board_write_native};
use crate::app::daemon_client::{parse_uuid, DaemonClient};
use crate::cli::{strip_ansi, write_payload};
use crate::protocol::{ClientToDaemon, ReplyResult, TaskSignal};
use anyhow::{anyhow, bail, Context, Result};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use uuid::Uuid;

pub fn run(args: impl IntoIterator<Item = String>) -> Result<()> {
    let mut args = args.into_iter();
    if args.next().as_deref() == Some("mcp") {
        // app.exe mcp serve
    }
    match args.next().as_deref() {
        Some("serve") => serve(),
        _ => bail!("usage: app.exe mcp serve"),
    }
}

fn serve() -> Result<()> {
    let session_id = std::env::var("AWT_SESSION_ID").context("AWT_SESSION_ID is required")?;
    let session_id = parse_uuid(&session_id)?;
    let stream = crate::app::spawn_daemon::ensure_daemon().context("connect to daemon")?;
    let client = DaemonClient::new(stream);
    let stdin = io::stdin();
    let mut stdout = io::stdout();
    for line in stdin.lock().lines() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        let request: Value = serde_json::from_str(&line)?;
        if is_notification(&request) {
            // JSON-RPC notifications (e.g. notifications/initialized) never get a reply.
            let _ = handle_notification(&client, session_id, &request);
            continue;
        }
        let response = handle_message(&client, session_id, &request)
            .unwrap_or_else(|err| error_response(request.get("id").cloned().unwrap_or(Value::Null), -32000, err.to_string()));
        serde_json::to_writer(&mut stdout, &response)?;
        stdout.write_all(b"\n")?;
        stdout.flush()?;
    }
    Ok(())
}

fn handle_message(client: &DaemonClient, session_id: Uuid, request: &Value) -> Result<Value> {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    match request.get("method").and_then(Value::as_str) {
        Some("initialize") => Ok(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2025-06-18",
                "serverInfo": { "name": "awt", "version": env!("CARGO_PKG_VERSION") },
                "capabilities": { "tools": {} }
            }
        })),
        Some("tools/list") => Ok(json!({ "jsonrpc": "2.0", "id": id, "result": { "tools": tool_schemas() } })),
        Some("tools/call") => {
            let params = request.get("params").ok_or_else(|| anyhow!("tools/call missing params"))?;
            let name = params.get("name").and_then(Value::as_str).ok_or_else(|| anyhow!("tools/call missing name"))?;
            let args = params.get("arguments").cloned().unwrap_or_else(|| json!({}));
            let text = call_tool(client, session_id, name, &args)?;
            Ok(json!({ "jsonrpc": "2.0", "id": id, "result": { "content": [{ "type": "text", "text": text }] } }))
        }
        Some("ping") => Ok(json!({ "jsonrpc": "2.0", "id": id, "result": {} })),
        Some(other) => Ok(error_response(id, -32601, format!("method not found: {other}"))),
        None => Ok(error_response(id, -32600, "missing method")),
    }
}

fn call_tool(client: &DaemonClient, session_id: Uuid, name: &str, args: &Value) -> Result<String> {
    match name {
        "awt_pane_list" => match client.request_reply(|req| ClientToDaemon::AttachSession { req, session_id })? {
            ReplyResult::Attached { panes, .. } => Ok(serde_json::to_string(&panes)?),
            other => bail!("unexpected daemon response: {other:?}"),
        },
        "awt_pane_read" => {
            let pane_id = required_uuid(args, "paneId")?;
            match client.request_reply(|req| ClientToDaemon::GetScrollback { req, session_id, pane_id })? {
                ReplyResult::ScrollbackData(data) => Ok(strip_ansi(&String::from_utf8_lossy(&data)).into_owned()),
                other => bail!("unexpected daemon response: {other:?}"),
            }
        }
        "awt_pane_write" => {
            let pane_id = required_uuid(args, "paneId")?;
            let text = required_str(args, "text")?.to_string();
            let enter = args.get("enter").and_then(Value::as_bool).unwrap_or(false);
            client.send(ClientToDaemon::WritePane { session_id, pane_id, data: write_payload(text, enter) })?;
            Ok(json!({ "ok": true }).to_string())
        }
        "awt_task_list" => board_read_native(&session_id.to_string()),
        "awt_task_create" => {
            let title = required_str(args, "title")?;
            let description = args.get("description").and_then(Value::as_str).unwrap_or_default();
            let mut board = read_board_value(session_id)?;
            let task_id = Uuid::new_v4().to_string();
            let now = current_millis();
            board_create_task(&mut board, &task_id, session_id, title, description, now);
            write_board_value(session_id, &board)?;
            emit_board_changed(client, session_id)?;
            Ok(json!({ "taskId": task_id }).to_string())
        }
        "awt_task_assign" => {
            let task_id = required_str(args, "taskId")?;
            let pane_id = required_uuid(args, "paneId")?;
            let role = args
                .get("role")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);
            let now = current_millis();
            let mut board = read_board_value(session_id)?;
            let (title, description) = {
                let task = board.pointer_mut(&format!("/tasks/{task_id}")).ok_or_else(|| anyhow!("task not found: {task_id}"))?;
                let title = task.get("title").and_then(Value::as_str).unwrap_or("Task").to_string();
                let description = task.get("description").and_then(Value::as_str).unwrap_or_default().to_string();
                task["assignedPaneId"] = json!(pane_id.to_string());
                if let Some(role) = &role {
                    task["assignedRole"] = json!(role);
                } else if let Some(object) = task.as_object_mut() {
                    object.remove("assignedRole");
                }
                task["status"] = json!("assigned");
                task["updatedAt"] = json!(now);
                if !task.get("statusTimestamps").is_some_and(Value::is_object) {
                    task["statusTimestamps"] = json!({});
                }
                task["statusTimestamps"]["assigned"] = json!(now);
                (title, description)
            };
            let prompt = compose_task_prompt(task_id, &title, &description, role.as_deref());
            write_board_value(session_id, &board)?;
            emit_board_changed(client, session_id)?;
            client.send(ClientToDaemon::WritePane { session_id, pane_id, data: write_payload(prompt, true) })?;
            Ok(json!({ "ok": true }).to_string())
        }
        "awt_task_done" => {
            let task_id = required_str(args, "taskId")?.to_string();
            let commit_msg = args.get("commitMsg").and_then(Value::as_str).map(str::to_string);
            relay_task_event(client, session_id, TaskSignal::Done { task_id, commit_msg, pane_id: None })
        }
        "awt_task_note" => {
            let task_id = required_str(args, "taskId")?.to_string();
            let message = required_str(args, "message")?.to_string();
            relay_task_event(client, session_id, TaskSignal::Note { task_id, message, pane_id: None })
        }
        other => bail!("unknown tool: {other}"),
    }
}

fn tool_schemas() -> Vec<Value> {
    vec![
        tool_schema("awt_pane_list", "List panes in this AWT workspace", json!({ "type": "object", "properties": {} })),
        tool_schema("awt_pane_read", "Read a pane scrollback", json!({ "type": "object", "properties": { "paneId": { "type": "string" } }, "required": ["paneId"] })),
        tool_schema("awt_pane_write", "Write text to a pane", json!({ "type": "object", "properties": { "paneId": { "type": "string" }, "text": { "type": "string" }, "enter": { "type": "boolean" } }, "required": ["paneId", "text"] })),
        tool_schema("awt_task_list", "List Kanban tasks in this workspace", json!({ "type": "object", "properties": {} })),
        tool_schema("awt_task_create", "Create a Kanban task", json!({ "type": "object", "properties": { "title": { "type": "string" }, "description": { "type": "string" } }, "required": ["title"] })),
        tool_schema("awt_task_assign", "Assign a task to a pane", json!({ "type": "object", "properties": { "taskId": { "type": "string" }, "paneId": { "type": "string" }, "role": { "type": "string" } }, "required": ["taskId", "paneId"] })),
        tool_schema("awt_task_done", "Mark a task done", json!({ "type": "object", "properties": { "taskId": { "type": "string" }, "commitMsg": { "type": "string" } }, "required": ["taskId"] })),
        tool_schema("awt_task_note", "Append a note to a task", json!({ "type": "object", "properties": { "taskId": { "type": "string" }, "message": { "type": "string" } }, "required": ["taskId", "message"] })),
    ]
}

fn tool_schema(name: &str, description: &str, input_schema: Value) -> Value {
    json!({ "name": name, "description": description, "inputSchema": input_schema })
}

fn read_board_value(session_id: Uuid) -> Result<Value> {
    let mut value: Value = serde_json::from_str(&board_read_native(&session_id.to_string())?)?;
    if !value.is_object() {
        value = json!({});
    }
    if !value.get("tasks").is_some_and(Value::is_object) {
        value["tasks"] = json!({});
    }
    if !value.get("taskOrder").is_some_and(Value::is_array) {
        value["taskOrder"] = json!([]);
    }
    Ok(value)
}

fn write_board_value(session_id: Uuid, value: &Value) -> Result<()> {
    board_write_native(&session_id.to_string(), &serde_json::to_string(value)?)
}

fn board_create_task(board: &mut Value, task_id: &str, session_id: Uuid, title: &str, description: &str, now: u64) {
    board["tasks"][task_id] = json!({
        "id": task_id,
        "sessionId": session_id.to_string(),
        "title": title,
        "description": description,
        "status": "pending",
        "createdAt": now,
        "updatedAt": now,
    });
    board["taskOrder"].as_array_mut().expect("taskOrder array").push(json!(task_id));
}

fn compose_task_prompt(task_id: &str, title: &str, description: &str, role: Option<&str>) -> String {
    let short = task_id.get(..8).unwrap_or(task_id);
    let mut lines = vec![format!("[Task #{short}] {title}")];
    if let Some(role) = role {
        lines.push(format!("Role: {role}"));
    }
    let description = description.trim();
    if !description.is_empty() {
        lines.push(format!("\n{description}"));
    }
    lines.extend([
        "".to_string(),
        "When you make progress, report a note from this AWT pane with:".to_string(),
        format!("& $env:AWT_APP_EXE cli task note --task {task_id} --message \"<short progress note>\""),
        "".to_string(),
        "When finished, report completion from this AWT pane with:".to_string(),
        format!("& $env:AWT_APP_EXE cli task done --task {task_id}"),
    ]);
    lines.join("\n")
}

fn emit_board_changed(client: &DaemonClient, session_id: Uuid) -> Result<()> {
    relay_task_event(client, session_id, TaskSignal::BoardChanged {}).map(|_| ())
}

fn relay_task_event(client: &DaemonClient, session_id: Uuid, event: TaskSignal) -> Result<String> {
    match client.request_reply(|req| ClientToDaemon::TaskEvent { req, session_id, event })? {
        ReplyResult::Ok => Ok(json!({ "ok": true }).to_string()),
        other => bail!("unexpected daemon response: {other:?}"),
    }
}

fn required_str<'a>(args: &'a Value, key: &str) -> Result<&'a str> {
    args.get(key).and_then(Value::as_str).ok_or_else(|| anyhow!("missing string argument {key}"))
}

fn required_uuid(args: &Value, key: &str) -> Result<Uuid> {
    parse_uuid(required_str(args, key)?)
}

fn current_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn is_notification(request: &Value) -> bool {
    request.get("id").is_none()
}

fn handle_notification(_client: &DaemonClient, _session_id: Uuid, _request: &Value) -> Result<()> {
    Ok(())
}

fn error_response(id: Value, code: i64, message: impl Into<String>) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message.into() } })
}

#[cfg(test)]
mod tests {
    use super::*;
    use interprocess::local_socket::{prelude::*, GenericNamespaced, ListenerOptions};

    #[test]
    fn tools_list_contains_pane_and_task_tools() {
        let tools = tool_schemas();
        let names: Vec<&str> = tools.iter().filter_map(|tool| tool.get("name").and_then(Value::as_str)).collect();
        assert!(names.contains(&"awt_pane_list"));
        assert!(names.contains(&"awt_task_create"));
    }

    #[test]
    fn is_notification_tracks_absent_id_only() {
        assert!(is_notification(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })));
        assert!(!is_notification(&json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })));
    }

    #[test]
    fn handle_message_ping_returns_empty_result() {
        let request = json!({ "jsonrpc": "2.0", "id": "ping-1", "method": "ping" });
        let response = handle_message(&placeholder_client(), Uuid::nil(), &request).expect("ping response");

        assert_eq!(response["id"], "ping-1");
        assert_eq!(response["result"], json!({}));
    }

    #[test]
    fn handle_message_unknown_method_returns_method_not_found() {
        let request = json!({ "jsonrpc": "2.0", "id": 7, "method": "unknown" });
        let response = handle_message(&placeholder_client(), Uuid::nil(), &request).expect("error response");

        assert_eq!(response["id"], 7);
        assert_eq!(response["error"]["code"], -32601);
    }

    fn placeholder_client() -> DaemonClient {
        let socket_name = format!("awt-mcp-test-{}", Uuid::new_v4());
        let listener_name = socket_name.as_str().to_ns_name::<GenericNamespaced>().expect("listener name");
        let connect_name = socket_name.as_str().to_ns_name::<GenericNamespaced>().expect("connect name");
        let listener = ListenerOptions::new().name(listener_name).create_sync().expect("test listener");
        let stream = interprocess::local_socket::ConnectOptions::new().name(connect_name).connect_sync().expect("test connect");
        let _peer = listener.accept().expect("test accept");
        DaemonClient::new(stream)
    }

    #[test]
    fn board_create_task_updates_snapshot_shape() {
        let session_id = Uuid::new_v4();
        let mut board = json!({ "tasks": {}, "taskOrder": [] });
        board_create_task(&mut board, "task-1", session_id, "SMOKE", "desc", 42);
        assert_eq!(board["tasks"]["task-1"]["title"], "SMOKE");
        assert_eq!(board["tasks"]["task-1"]["sessionId"], session_id.to_string());
        assert_eq!(board["taskOrder"][0], "task-1");
    }

    #[test]
    fn compose_task_prompt_includes_role_and_callbacks() {
        let prompt = compose_task_prompt("12345678-aaaa", "Fix bug", "Do the thing", Some("Reviewer"));

        assert!(prompt.contains("[Task #12345678] Fix bug"));
        assert!(prompt.contains("Role: Reviewer"));
        assert!(prompt.contains("Do the thing"));
        assert!(prompt.contains("& $env:AWT_APP_EXE cli task note --task 12345678-aaaa"));
        assert!(prompt.contains("& $env:AWT_APP_EXE cli task done --task 12345678-aaaa"));
    }
}

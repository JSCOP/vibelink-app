// MCP (Model Context Protocol) server for AgenticWorkspaceTerminal
// Implements JSON-RPC 2.0 over stdin/stdout

use crate::app::daemon_client::{parse_uuid, DaemonClient};
use crate::protocol::{ClientToDaemon, ReplyResult};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};

pub fn run() -> Result<()> {
    let stream = crate::app::spawn_daemon::ensure_daemon().context("connect to daemon")?;
    let client = DaemonClient::new(stream);

    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut stdout = stdout.lock();

    for line in stdin.lock().lines() {
        let line = line.context("read stdin")?;
        if line.trim().is_empty() {
            continue;
        }

        let response = match serde_json::from_str::<JsonRpcRequest>(&line) {
            Ok(request) => handle_request(&client, request),
            Err(err) => json_rpc_error(None, -32700, &format!("Parse error: {}", err)),
        };

        writeln!(stdout, "{}", serde_json::to_string(&response)?)?;
        stdout.flush()?;
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
struct JsonRpcRequest {
    jsonrpc: String,
    id: Option<Value>,
    method: String,
    params: Option<Value>,
}

#[derive(Debug, Serialize)]
struct JsonRpcResponse {
    jsonrpc: String,
    id: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<JsonRpcError>,
}

#[derive(Debug, Serialize)]
struct JsonRpcError {
    code: i32,
    message: String,
}

fn json_rpc_error(id: Option<Value>, code: i32, message: &str) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: None,
        error: Some(JsonRpcError {
            code,
            message: message.to_string(),
        }),
    }
}

fn json_rpc_result(id: Option<Value>, result: Value) -> JsonRpcResponse {
    JsonRpcResponse {
        jsonrpc: "2.0".to_string(),
        id,
        result: Some(result),
        error: None,
    }
}

fn handle_request(client: &DaemonClient, request: JsonRpcRequest) -> JsonRpcResponse {
    match request.method.as_str() {
        "initialize" => handle_initialize(request.id),
        "tools/list" => handle_tools_list(request.id),
        "tools/call" => match request.params {
            Some(params) => handle_tools_call(client, request.id, params),
            None => json_rpc_error(request.id, -32602, "Invalid params"),
        },
        _ => json_rpc_error(request.id, -32601, "Method not found"),
    }
}

fn handle_initialize(id: Option<Value>) -> JsonRpcResponse {
    json_rpc_result(
        id,
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {
                "tools": {}
            },
            "serverInfo": {
                "name": "awt-mcp-server",
                "version": "0.1.0"
            }
        }),
    )
}

fn handle_tools_list(id: Option<Value>) -> JsonRpcResponse {
    json_rpc_result(
        id,
        json!({
            "tools": [
                {
                    "name": "list_sessions",
                    "description": "List all terminal sessions",
                    "inputSchema": {
                        "type": "object",
                        "properties": {},
                        "required": []
                    }
                },
                {
                    "name": "list_panes",
                    "description": "List all panes in a session",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "session_id": {
                                "type": "string",
                                "description": "Session UUID"
                            }
                        },
                        "required": ["session_id"]
                    }
                },
                {
                    "name": "read_pane_output",
                    "description": "Read recent output from a pane",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "pane_id": {
                                "type": "string",
                                "description": "Pane UUID"
                            }
                        },
                        "required": ["pane_id"]
                    }
                },
                {
                    "name": "write_to_pane",
                    "description": "Write input to a pane (execute command)",
                    "inputSchema": {
                        "type": "object",
                        "properties": {
                            "pane_id": {
                                "type": "string",
                                "description": "Pane UUID"
                            },
                            "input": {
                                "type": "string",
                                "description": "Input text to write (include newline for command execution)"
                            }
                        },
                        "required": ["pane_id", "input"]
                    }
                }
            ]
        }),
    )
}

fn handle_tools_call(client: &DaemonClient, id: Option<Value>, params: Value) -> JsonRpcResponse {
    let name = match params.get("name").and_then(|v| v.as_str()) {
        Some(n) => n,
        None => return json_rpc_error(id, -32602, "Missing tool name"),
    };

    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));

    match name {
        "list_sessions" => tool_list_sessions(client, id),
        "list_panes" => tool_list_panes(client, id, arguments),
        "read_pane_output" => tool_read_pane_output(client, id, arguments),
        "write_to_pane" => tool_write_to_pane(client, id, arguments),
        _ => json_rpc_error(id, -32602, &format!("Unknown tool: {}", name)),
    }
}

fn tool_list_sessions(client: &DaemonClient, id: Option<Value>) -> JsonRpcResponse {
    let result = match client.request_reply(|req| ClientToDaemon::ListSessions { req }) {
        Ok(ReplyResult::Sessions(sessions)) => {
            let content = sessions
                .iter()
                .map(|s| {
                    format!(
                        "- {} (id: {}, panes: {})",
                        s.name, s.id, s.pane_count
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");

            if content.is_empty() {
                "No sessions found".to_string()
            } else {
                format!("Sessions:\n{}", content)
            }
        }
        Ok(other) => return json_rpc_error(id, -32000, &format!("Unexpected response: {:?}", other)),
        Err(err) => return json_rpc_error(id, -32000, &format!("Failed to list sessions: {}", err)),
    };

    json_rpc_result(
        id,
        json!({
            "content": [
                {
                    "type": "text",
                    "text": result
                }
            ]
        }),
    )
}

fn tool_list_panes(client: &DaemonClient, id: Option<Value>, args: Value) -> JsonRpcResponse {
    let session_id = match args.get("session_id").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return json_rpc_error(id, -32602, "Missing session_id"),
    };

    let session_uuid = match parse_uuid(session_id) {
        Ok(u) => u,
        Err(err) => return json_rpc_error(id, -32602, &format!("Invalid session_id: {}", err)),
    };

    let result = match client.request_reply(|req| ClientToDaemon::AttachSession {
        req,
        session_id: session_uuid,
    }) {
        Ok(ReplyResult::Attached { panes, .. }) => {
            let content = panes
                .iter()
                .map(|p| {
                    format!(
                        "- {} (id: {}, alive: {})",
                        p.config.shell.as_deref().unwrap_or("default"),
                        p.id,
                        p.alive
                    )
                })
                .collect::<Vec<_>>()
                .join("\n");

            if content.is_empty() {
                "No panes found in session".to_string()
            } else {
                format!("Panes:\n{}", content)
            }
        }
        Ok(other) => return json_rpc_error(id, -32000, &format!("Unexpected response: {:?}", other)),
        Err(err) => return json_rpc_error(id, -32000, &format!("Failed to list panes: {}", err)),
    };

    json_rpc_result(
        id,
        json!({
            "content": [
                {
                    "type": "text",
                    "text": result
                }
            ]
        }),
    )
}

fn tool_read_pane_output(client: &DaemonClient, id: Option<Value>, args: Value) -> JsonRpcResponse {
    let pane_id = match args.get("pane_id").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return json_rpc_error(id, -32602, "Missing pane_id"),
    };

    let pane_uuid = match parse_uuid(pane_id) {
        Ok(u) => u,
        Err(err) => return json_rpc_error(id, -32602, &format!("Invalid pane_id: {}", err)),
    };

    let result = match client.request_reply(|req| ClientToDaemon::GetScrollback {
        req,
        pane_id: pane_uuid,
    }) {
        Ok(ReplyResult::ScrollbackData(data)) => {
            String::from_utf8_lossy(&data).to_string()
        }
        Ok(other) => return json_rpc_error(id, -32000, &format!("Unexpected response: {:?}", other)),
        Err(err) => return json_rpc_error(id, -32000, &format!("Failed to read pane output: {}", err)),
    };

    json_rpc_result(
        id,
        json!({
            "content": [
                {
                    "type": "text",
                    "text": result
                }
            ]
        }),
    )
}

fn tool_write_to_pane(client: &DaemonClient, id: Option<Value>, args: Value) -> JsonRpcResponse {
    let pane_id = match args.get("pane_id").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return json_rpc_error(id, -32602, "Missing pane_id"),
    };

    let pane_uuid = match parse_uuid(pane_id) {
        Ok(u) => u,
        Err(err) => return json_rpc_error(id, -32602, &format!("Invalid pane_id: {}", err)),
    };

    let input = match args.get("input").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => return json_rpc_error(id, -32602, "Missing input"),
    };

    if let Err(err) = client.send(ClientToDaemon::WritePane {
        pane_id: pane_uuid,
        data: input.as_bytes().to_vec(),
    }) {
        return json_rpc_error(id, -32000, &format!("Failed to write to pane: {}", err));
    }

    json_rpc_result(
        id,
        json!({
            "content": [
                {
                    "type": "text",
                    "text": "Input written successfully"
                }
            ]
        }),
    )
}

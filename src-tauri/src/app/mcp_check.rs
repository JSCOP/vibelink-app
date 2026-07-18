use super::{authorization::Capability, entitlement::EntitlementSupervisor};
use anyhow::{Context, Result};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    process::{Command, Stdio},
    sync::{mpsc, Arc},
    time::{Duration, Instant},
};
use tauri::State;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpCheckReport {
    pub spawn_ok: bool,
    pub initialize_ok: bool,
    pub tool_count: u32,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn mcp_self_check(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    session_id: String,
) -> Result<McpCheckReport, String> {
    supervisor
        .authorize(Capability::McpCall)
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let executable = std::env::current_exe().context("resolve current executable")?;
        Ok::<_, anyhow::Error>(mcp_self_check_native(
            &executable,
            &session_id,
            crate::daemon::paths::app_flavor(),
            CHECK_TIMEOUT,
        ))
    })
    .await
    .map_err(|error| error.to_string())?
    .map_err(|error| error.to_string())
}

fn mcp_self_check_native(
    executable: &Path,
    session_id: &str,
    app_flavor: &str,
    timeout: Duration,
) -> McpCheckReport {
    match run_mcp_self_check(executable, session_id, app_flavor, timeout) {
        Ok(report) => report,
        Err(error) => McpCheckReport {
            error: Some(error.to_string()),
            ..McpCheckReport::default()
        },
    }
}

fn run_mcp_self_check(
    executable: &Path,
    session_id: &str,
    app_flavor: &str,
    timeout: Duration,
) -> Result<McpCheckReport> {
    let mut command = Command::new(executable);
    command
        .args(["mcp", "serve"])
        .env("VIBELINK_SESSION_ID", session_id)
        .env("VIBELINK_APP_FLAVOR", app_flavor)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);

    let mut child = command
        .spawn()
        .with_context(|| format!("spawn {} mcp serve", executable.display()))?;
    let mut report = McpCheckReport {
        spawn_ok: true,
        ..McpCheckReport::default()
    };
    let mut stdin = child.stdin.take().context("capture MCP stdin")?;
    let stdout = child.stdout.take().context("capture MCP stdout")?;
    let stderr = child.stderr.take().context("capture MCP stderr")?;
    let (line_tx, line_rx) = mpsc::channel::<Result<String, String>>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            if line_tx
                .send(line.map_err(|error| error.to_string()))
                .is_err()
            {
                return;
            }
        }
    });
    let (stderr_tx, stderr_rx) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut text = String::new();
        let _ = reader.read_to_string(&mut text);
        let _ = stderr_tx.send(text);
    });

    let deadline = Instant::now() + timeout;
    let result = (|| -> Result<()> {
        send_request(
            &mut stdin,
            &json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-06-18",
                    "capabilities": {},
                    "clientInfo": { "name": "vibelink-self-check", "version": env!("CARGO_PKG_VERSION") }
                }
            }),
        )?;
        let initialized = receive_response(&line_rx, deadline)?;
        report.initialize_ok =
            initialized.get("result").is_some() && initialized.get("error").is_none();
        if !report.initialize_ok {
            anyhow::bail!("MCP initialize returned {}", initialized);
        }

        send_request(
            &mut stdin,
            &json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {} }),
        )?;
        let tools = receive_response(&line_rx, deadline)?;
        report.tool_count = tools
            .pointer("/result/tools")
            .and_then(Value::as_array)
            .map(|tools| tools.len() as u32)
            .unwrap_or_default();
        if tools.get("error").is_some() {
            anyhow::bail!("MCP tools/list returned {}", tools);
        }
        Ok(())
    })();

    drop(stdin);
    if child.try_wait()?.is_none() {
        child.kill().context("stop owned MCP self-check child")?;
    }
    let _ = child.wait();
    let stderr = stderr_rx
        .recv_timeout(Duration::from_millis(250))
        .unwrap_or_default();
    if let Err(error) = result {
        let excerpt = stderr_excerpt(&stderr);
        report.error = Some(if excerpt.is_empty() {
            error.to_string()
        } else {
            format!("{error}\n{excerpt}")
        });
    }
    Ok(report)
}

fn send_request(stdin: &mut impl Write, request: &Value) -> Result<()> {
    serde_json::to_writer(&mut *stdin, request)?;
    stdin.write_all(b"\n")?;
    stdin.flush()?;
    Ok(())
}

fn receive_response(
    receiver: &mpsc::Receiver<Result<String, String>>,
    deadline: Instant,
) -> Result<Value> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        anyhow::bail!("MCP self-check timed out");
    }
    let line = receiver
        .recv_timeout(remaining)
        .map_err(|_| anyhow::anyhow!("MCP self-check timed out waiting for response"))?
        .map_err(anyhow::Error::msg)?;
    serde_json::from_str(&line).context("parse MCP self-check response")
}

fn stderr_excerpt(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .take(8)
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spawn_failure_returns_report_shape() {
        let report = mcp_self_check_native(
            Path::new("Z:/missing/vibelink-self-check.exe"),
            "session-1",
            "dev",
            Duration::from_millis(20),
        );
        assert!(!report.spawn_ok);
        assert!(!report.initialize_ok);
        assert_eq!(report.tool_count, 0);
        assert!(report.error.is_some());
    }

    #[test]
    fn stderr_excerpt_is_bounded() {
        let text = (0..20)
            .map(|index| format!("line-{index}"))
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(stderr_excerpt(&text).lines().count(), 8);
    }
}

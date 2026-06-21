use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::{bounded, Sender};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{ipc::Channel, AppHandle, Manager, State};
use tracing::{debug, warn};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const HERMES_ACP_BIN: &str = if cfg!(windows) { "hermes-acp.exe" } else { "hermes-acp" };
#[allow(dead_code)]
const HERMES_BIN: &str = if cfg!(windows) { "hermes.exe" } else { "hermes" };
const HERMES_VERSION: &str = "0.17.0";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);


#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesRuntimeStatus {
    pub installed: bool,
    pub command: String,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesConfiguredModel {
    pub provider: String,
    pub model: String,
    pub base_url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesWorkspaceState {
    pub home: String,
    pub workspace_folder: String,
    pub model: Option<HermesConfiguredModel>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesModelInfo {
    pub id: String,
    pub name: String,
}


#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesPermissionOption {
    pub option_id: String,
    pub name: String,
    pub kind: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesPlanEntry {
    pub content: String,
    pub status: String,
    pub priority: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase", tag = "kind")]
pub enum HermesEvent {
    Started { session_id: String, acp_session_id: String },
    Message { session_id: String, text: String },
    Thought { session_id: String, text: String },
    ToolCall {
        session_id: String,
        tool_call_id: String,
        title: String,
        tool_kind: String,
        status: String,
    },
    ToolUpdate {
        session_id: String,
        tool_call_id: String,
        status: String,
        content: String,
    },
    Plan { session_id: String, entries: Vec<HermesPlanEntry> },
    Usage { session_id: String, size: u64, used: u64 },
    Permission {
        session_id: String,
        request_id: u64,
        title: String,
        tool_kind: String,
        options: Vec<HermesPermissionOption>,
        diff_path: Option<String>,
        old_text: Option<String>,
        new_text: Option<String>,
    },
    Models { session_id: String, available: Vec<HermesModelInfo>, current: String },
    TurnEnded { session_id: String, stop_reason: String },
    Error { session_id: String, message: String },
    Exited { session_id: String },
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesGatewayConfig {
    pub platform: HermesGatewayPlatform,
    pub token_env: String,
    pub token_set: bool,
    pub allowed_users: String,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum HermesGatewayPlatform {
    Telegram,
    Discord,
    Slack,
}

#[allow(dead_code)]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesGatewayStatus {
    pub running: bool,
    pub pid: Option<u32>,
}


#[derive(Serialize)]
struct McpServerConfig {
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
    enabled: bool,
}


pub struct HermesManager {
    instances: Mutex<HashMap<String, Arc<HermesInstance>>>,
    output_channel: Mutex<Option<Channel<HermesEvent>>>,
    gateway_children: Mutex<HashMap<String, Child>>,
    active_prompts: Mutex<HashSet<String>>,
}

struct HermesInstance {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    acp_session_id: Mutex<Option<String>>,
}

impl HermesManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            output_channel: Mutex::new(None),
            gateway_children: Mutex::new(HashMap::new()),
            active_prompts: Mutex::new(HashSet::new()),
        }
    }

    pub fn set_output_channel(&self, channel: Channel<HermesEvent>) {
        *self.output_channel.lock().expect("hermes output channel poisoned") = Some(channel);
    }

    pub fn start(
        self: &Arc<Self>,
        session_id: String,
        command_override: Option<String>,
        workspace_folder: Option<String>,
    ) -> Result<()> {
        if self
            .instances
            .lock()
            .expect("hermes instances poisoned")
            .contains_key(&session_id)
        {
            return Ok(());
        }

        let command_path = resolve_command(command_override)?;
        let home = hermes_home(&session_id)?;
        std::fs::create_dir_all(&home)?;
        let cwd = resolve_workspace_cwd(workspace_folder.as_deref(), &home)?;
        let acp_cwd = cwd.to_string_lossy().to_string();
        let configured_model = read_workspace_state_native(&session_id)
            .ok()
            .and_then(|state| state.model);
        let mut command = Command::new(&command_path);
        command
            .env("HERMES_HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        command.current_dir(&cwd);
        apply_no_window(&mut command);

        let mut child = command
            .spawn()
            .with_context(|| format!("spawn Hermes ACP command {command_path} in {}", cwd.display()))?;
        let stdin = child.stdin.take().ok_or_else(|| anyhow!("Hermes stdin unavailable"))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("Hermes stdout unavailable"))?;
        let stderr = child.stderr.take();
        let instance = Arc::new(HermesInstance {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            acp_session_id: Mutex::new(None),
        });

        self.instances
            .lock()
            .expect("hermes instances poisoned")
            .insert(session_id.clone(), Arc::clone(&instance));

        spawn_stdout_reader(session_id.clone(), stdout, Arc::clone(&instance), Arc::clone(self));
        if let Some(stderr) = stderr {
            spawn_stderr_drain(session_id.clone(), stderr);
        }

        let manager = Arc::clone(self);
        thread::Builder::new()
            .name(format!("awt-hermes-handshake-{session_id}"))
            .spawn(move || {
                if let Err(err) = handshake(&session_id, &acp_cwd, &home, configured_model.as_ref(), &instance, &manager) {
                    let _ = manager.send_event(HermesEvent::Error {
                        session_id: session_id.clone(),
                        message: err.to_string(),
                    });
                }
            })
            .map_err(|err| anyhow!(err))?;
        Ok(())
    }

    pub fn send_message(self: &Arc<Self>, session_id: String, text: String) -> Result<()> {
        let instance = self.instance(&session_id)?;
        let acp_session_id = instance.acp_session_id()?;
        let manager = Arc::clone(self);
        manager.set_prompt_active(&session_id, true);
        thread::Builder::new()
            .name(format!("awt-hermes-prompt-{session_id}"))
            .spawn(move || {
                let result = instance.request(
                    "session/prompt",
                    json!({
                        "sessionId": acp_session_id,
                        "prompt": [{ "type": "text", "text": text }],
                    }),
                    None,
                );
                manager.set_prompt_active(&session_id, false);
                match result {
                    Ok(value) => {
                        let stop_reason = value
                            .get("stopReason")
                            .and_then(Value::as_str)
                            .unwrap_or("end_turn")
                            .to_string();
                        let _ = manager.send_event(HermesEvent::TurnEnded { session_id, stop_reason });
                    }
                    Err(err) => {
                        let _ = manager.send_event(HermesEvent::Error {
                            session_id,
                            message: err.to_string(),
                        });
                    }
                }
            })
            .map_err(|err| anyhow!(err))?;
        Ok(())
    }

    pub fn cancel(&self, session_id: &str) -> Result<()> {
        if !self.is_prompt_active(session_id) {
            debug!(session_id, "ignoring Hermes cancel without active prompt");
            return Ok(());
        }
        let instance = self.instance(session_id)?;
        let acp_session_id = instance.acp_session_id()?;
        instance.notification("session/cancel", json!({ "sessionId": acp_session_id }))
    }

    pub fn respond_permission(&self, session_id: &str, request_id: u64, option_id: String) -> Result<()> {
        let instance = self.instance(session_id)?;
        instance.write_line(&json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "optionId": option_id },
        }))
    }

    pub fn set_model(&self, session_id: &str, model_id: String) -> Result<()> {
        let instance = self.instance(session_id)?;
        let acp_session_id = instance.acp_session_id()?;
        instance.request(
            "session/set_model",
            json!({ "sessionId": acp_session_id, "modelId": model_id }),
            Some(REQUEST_TIMEOUT),
        )?;
        Ok(())
    }

    pub fn set_mode(&self, session_id: &str, mode_id: String) -> Result<()> {
        let instance = self.instance(session_id)?;
        let acp_session_id = instance.acp_session_id()?;
        instance.request(
            "session/set_mode",
            json!({ "sessionId": acp_session_id, "modeId": mode_id }),
            Some(REQUEST_TIMEOUT),
        )?;
        Ok(())
    }

    pub fn stop(&self, session_id: &str) -> Result<()> {
        let instance = self
            .instances
            .lock()
            .expect("hermes instances poisoned")
            .remove(session_id);
        if let Some(instance) = instance {
            let mut child = instance.child.lock().expect("hermes child poisoned");
            let _ = child.kill();
            let _ = child.wait();
            self.send_event(HermesEvent::Exited { session_id: session_id.to_string() })?;
        }
        Ok(())
    }

    pub fn gateway_start(&self, session_id: String) -> Result<u32> {
        if let Some(child) = self.gateway_children.lock().expect("gateway children poisoned").get_mut(&session_id) {
            if child.try_wait()?.is_none() {
                return Ok(child.id());
            }
        }
        let home = hermes_home(&session_id)?;
        let command_path = resolve_hermes_command(None)?;
        let mut command = Command::new(&command_path);
        command
            .arg("gateway")
            .arg("run")
            .env("HERMES_HOME", &home)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        apply_no_window(&mut command);
        let child = command.spawn().with_context(|| format!("spawn Hermes gateway command {command_path}"))?;
        let pid = child.id();
        std::fs::write(home.join("gateway.pid"), pid.to_string())?;
        self.gateway_children
            .lock()
            .expect("gateway children poisoned")
            .insert(session_id, child);
        Ok(pid)
    }

    pub fn gateway_stop(&self, session_id: &str) -> Result<()> {
        if let Some(mut child) = self.gateway_children.lock().expect("gateway children poisoned").remove(session_id) {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    pub fn gateway_status(&self, session_id: &str) -> Result<HermesGatewayStatus> {
        if let Some(child) = self.gateway_children.lock().expect("gateway children poisoned").get_mut(session_id) {
            if child.try_wait()?.is_none() {
                return Ok(HermesGatewayStatus { running: true, pid: Some(child.id()) });
            }
        }
        let pid = std::fs::read_to_string(hermes_home(session_id)?.join("gateway.pid"))
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok());
        Ok(HermesGatewayStatus { running: false, pid })
    }

    pub fn shutdown_all(&self) {
        let session_ids: Vec<String> = self
            .instances
            .lock()
            .expect("hermes instances poisoned")
            .keys()
            .cloned()
            .collect();
        for session_id in session_ids {
            let _ = self.stop(&session_id);
        }
        let gateway_ids: Vec<String> = self
            .gateway_children
            .lock()
            .expect("gateway children poisoned")
            .keys()
            .cloned()
            .collect();
        for session_id in gateway_ids {
            let _ = self.gateway_stop(&session_id);
        }
    }

    fn set_prompt_active(&self, session_id: &str, active: bool) {
        let mut active_prompts = self.active_prompts.lock().expect("hermes active prompts poisoned");
        if active {
            active_prompts.insert(session_id.to_string());
        } else {
            active_prompts.remove(session_id);
        }
    }

    fn is_prompt_active(&self, session_id: &str) -> bool {
        self.active_prompts
            .lock()
            .expect("hermes active prompts poisoned")
            .contains(session_id)
    }

    fn instance(&self, session_id: &str) -> Result<Arc<HermesInstance>> {
        self.instances
            .lock()
            .expect("hermes instances poisoned")
            .get(session_id)
            .cloned()
            .ok_or_else(|| anyhow!("Hermes is not running for session {session_id}"))
    }

    fn send_event(&self, event: HermesEvent) -> Result<()> {
        if let Some(channel) = self
            .output_channel
            .lock()
            .expect("hermes output channel poisoned")
            .as_ref()
            .cloned()
        {
            channel.send(event)?;
        }
        Ok(())
    }
}

impl HermesInstance {
    fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = bounded(1);
        self.pending
            .lock()
            .expect("hermes pending poisoned")
            .insert(id, tx);
        let write = self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }));
        if let Err(err) = write {
            self.pending.lock().expect("hermes pending poisoned").remove(&id);
            return Err(err);
        }

        let response = match timeout {
            Some(timeout) => rx
                .recv_timeout(timeout)
                .map_err(|err| anyhow!("Hermes request {method} timed out or failed: {err}"))?,
            None => rx.recv().map_err(|err| anyhow!("Hermes request {method} failed: {err}"))?,
        };
        if let Some(error) = response.get("error") {
            bail!("Hermes request {method} failed: {error}");
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    fn notification(&self, method: &str, params: Value) -> Result<()> {
        self.write_line(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
    }

    fn write_line(&self, value: &Value) -> Result<()> {
        let mut stdin = self.stdin.lock().expect("hermes stdin poisoned");
        serde_json::to_writer(&mut *stdin, value)?;
        stdin.write_all(b"\n")?;
        stdin.flush()?;
        Ok(())
    }

    fn acp_session_id(&self) -> Result<String> {
        self.acp_session_id
            .lock()
            .expect("hermes acp session poisoned")
            .clone()
            .ok_or_else(|| anyhow!("Hermes ACP session is not ready"))
    }
}

#[tauri::command]
pub async fn init_hermes_output(
    manager: State<'_, Arc<HermesManager>>,
    channel: Channel<HermesEvent>,
) -> Result<(), String> {
    manager.set_output_channel(channel);
    Ok(())
}

#[tauri::command]
pub async fn hermes_start(
    app: AppHandle,
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    command_override: Option<String>,
    workspace_folder: Option<String>,
) -> Result<(), String> {
    let override_for_check = command_override.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_runtime_ready(&app, override_for_check))
        .await
        .map_err(to_string)?
        .map_err(to_string)?;
    let sid = session_id.clone();
    let wf = workspace_folder.clone();
    tauri::async_runtime::spawn_blocking(move || ensure_workspace_native(&sid, wf.as_deref()))
        .await
        .map_err(to_string)?
        .map_err(to_string)?;
    manager
        .start(session_id, command_override, workspace_folder)
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_send(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    manager.send_message(session_id, text).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_cancel(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.cancel(&session_id).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_respond_permission(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    request_id: u64,
    option_id: String,
) -> Result<(), String> {
    manager
        .respond_permission(&session_id, request_id, option_id)
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_set_model(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    model_id: String,
) -> Result<(), String> {
    manager.set_model(&session_id, model_id).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_set_mode(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    mode_id: String,
) -> Result<(), String> {
    manager.set_mode(&session_id, mode_id).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_stop(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.stop(&session_id).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_gateway_provision(
    session_id: String,
    gateway: HermesGatewayConfig,
    token: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || hermes_gateway_provision_native(&session_id, &gateway, token.as_deref()))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_gateway_start(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
) -> Result<u32, String> {
    manager.gateway_start(session_id).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_gateway_stop(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.gateway_stop(&session_id).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_gateway_status(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
) -> Result<HermesGatewayStatus, String> {
    manager.gateway_status(&session_id).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_cli_command(command_override: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_hermes_command(command_override))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_auth_list(session_id: String, command_override: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || hermes_auth_list_native(&session_id, command_override))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_workspace_home(session_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || hermes_home(&session_id).map(|path| path.to_string_lossy().to_string()))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_runtime_status(command_override: Option<String>) -> Result<HermesRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || hermes_runtime_status_native(command_override))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_install_runtime(app: AppHandle) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || hermes_install_runtime_native(&app))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_ensure_workspace(
    session_id: String,
    workspace_folder: Option<String>,
) -> Result<HermesWorkspaceState, String> {
    tauri::async_runtime::spawn_blocking(move || ensure_workspace_native(&session_id, workspace_folder.as_deref()))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_workspace_state(session_id: String) -> Result<HermesWorkspaceState, String> {
    tauri::async_runtime::spawn_blocking(move || read_workspace_state_native(&session_id))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

fn spawn_stdout_reader(
    session_id: String,
    stdout: impl std::io::Read + Send + 'static,
    instance: Arc<HermesInstance>,
    manager: Arc<HermesManager>,
) {
    thread::Builder::new()
        .name(format!("awt-hermes-stdout-{session_id}"))
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if line.trim().is_empty() => continue,
                    Ok(line) => match serde_json::from_str::<Value>(&line) {
                        Ok(value) => route_acp_message(&session_id, &value, &instance, &manager),
                        Err(err) => warn!(?err, line, "invalid Hermes ACP JSON"),
                    },
                    Err(err) => {
                        let _ = manager.send_event(HermesEvent::Error {
                            session_id: session_id.clone(),
                            message: format!("Hermes stdout stopped: {err}"),
                        });
                        break;
                    }
                }
            }
            let _ = manager.send_event(HermesEvent::Exited { session_id });
        })
        .expect("spawn hermes stdout reader");
}

fn spawn_stderr_drain(session_id: String, stderr: impl std::io::Read + Send + 'static) {
    thread::Builder::new()
        .name(format!("awt-hermes-stderr-{session_id}"))
        .spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                debug!(session_id, line, "Hermes stderr");
            }
        })
        .expect("spawn hermes stderr drain");
}

fn handshake(
    awt_session_id: &str,
    cwd: &str,
    home: &Path,
    configured_model: Option<&HermesConfiguredModel>,
    instance: &HermesInstance,
    manager: &HermesManager,
) -> Result<()> {
    instance.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": { "name": "AgenticWorkspaceTerminal", "version": env!("CARGO_PKG_VERSION") },
        }),
        Some(REQUEST_TIMEOUT),
    )?;

    let session_file = home.join("awt-acp-session");
    let saved_session = std::fs::read_to_string(&session_file)
        .ok()
        .and_then(non_empty)
        .map(|value| value.trim().to_string());

    let (response, resumed_session) = if let Some(session_id) = saved_session.as_deref() {
        match instance.request(
            "session/resume",
            json!({ "cwd": cwd, "sessionId": session_id }),
            Some(REQUEST_TIMEOUT),
        ) {
            Ok(value) => (value, Some(session_id.to_string())),
            Err(err) => {
                warn!(?err, "Hermes session resume failed; creating new session");
                (new_acp_session(instance, cwd)?, None)
            }
        }
    } else {
        (new_acp_session(instance, cwd)?, None)
    };

    let acp_session_id = acp_session_id_from_response(&response, resumed_session.as_deref())?;
    std::fs::write(&session_file, &acp_session_id)?;
    *instance
        .acp_session_id
        .lock()
        .expect("hermes acp session poisoned") = Some(acp_session_id.clone());

    if let Some(model) = configured_model {
        let model_id = acp_model_id_from_configured_model(model);
        if !model_id.is_empty() {
            instance.request(
                "session/set_model",
                json!({ "sessionId": acp_session_id, "modelId": model_id }),
                Some(REQUEST_TIMEOUT),
            )?;
        }
    }

    manager.send_event(HermesEvent::Started {
        session_id: awt_session_id.to_string(),
        acp_session_id,
    })?;
    let models = models_from_response(&response);
    if !models.0.is_empty() || !models.1.is_empty() {
        manager.send_event(HermesEvent::Models {
            session_id: awt_session_id.to_string(),
            available: models.0,
            current: models.1,
        })?;
    }
    Ok(())
}

fn new_acp_session(instance: &HermesInstance, cwd: &str) -> Result<Value> {
    instance.request(
        "session/new",
        json!({ "cwd": cwd, "mcpServers": [] }),
        Some(REQUEST_TIMEOUT),
    )
}

fn acp_session_id_from_response(response: &Value, resumed_session: Option<&str>) -> Result<String> {
    response
        .get("sessionId")
        .and_then(Value::as_str)
        .or(resumed_session)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("Hermes session response missing sessionId"))
}

fn acp_model_id_from_configured_model(model: &HermesConfiguredModel) -> String {
    let provider = model.provider.trim();
    let raw = model.model.trim();
    if raw.is_empty() {
        return String::new();
    }
    // Reduce to the bare model id, dropping a leading "<provider>/" or
    // "<provider>:" that only repeats the configured provider.
    let bare = raw
        .split_once(|c| c == '/' || c == ':')
        .filter(|(prefix, rest)| {
            prefix.trim().eq_ignore_ascii_case(provider) && !rest.trim().is_empty()
        })
        .map(|(_, rest)| rest.trim())
        .unwrap_or(raw);
    if provider.is_empty() {
        return bare.to_string();
    }
    // Qualify with the provider so Hermes pins it instead of re-detecting a
    // bare id to a different provider (e.g. gpt-5.5 -> openai-api).
    format!("{}:{}", provider.to_ascii_lowercase(), bare)
}

fn route_acp_message(
    awt_session_id: &str,
    value: &Value,
    instance: &HermesInstance,
    manager: &HermesManager,
) {
    if value.get("id").is_some() && (value.get("result").is_some() || value.get("error").is_some()) {
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            if let Some(sender) = instance.pending.lock().expect("hermes pending poisoned").remove(&id) {
                let _ = sender.try_send(value.clone());
            }
        }
        return;
    }

    if value.get("method").and_then(Value::as_str) == Some("session/update") {
        if let Some(event) = translate_update(awt_session_id, value) {
            let _ = manager.send_event(event);
        }
        return;
    }

    if value.get("method").and_then(Value::as_str) == Some("session/request_permission") {
        if let Some(event) = translate_permission(awt_session_id, value) {
            let _ = manager.send_event(event);
        }
        return;
    }

    if value.get("id").is_some() && value.get("method").is_some() {
        let _ = instance.write_line(&json!({
            "jsonrpc": "2.0",
            "id": value.get("id").cloned().unwrap_or(Value::Null),
            "error": { "code": -32601, "message": "method not found" },
        }));
    }
}

pub fn translate_update(awt_session_id: &str, value: &Value) -> Option<HermesEvent> {
    let update = value.get("params")?.get("update")?;
    let kind = update.get("sessionUpdate")?.as_str()?;
    match kind {
        "agent_message_chunk" => Some(HermesEvent::Message {
            session_id: awt_session_id.to_string(),
            text: update_text(update),
        }),
        "agent_thought_chunk" => Some(HermesEvent::Thought {
            session_id: awt_session_id.to_string(),
            text: update_text(update),
        }),
        "tool_call" => Some(HermesEvent::ToolCall {
            session_id: awt_session_id.to_string(),
            tool_call_id: read_string(update, &["toolCallId", "id"]),
            title: read_string(update, &["title", "name"]),
            tool_kind: read_string(update, &["kind", "toolKind"]),
            status: read_string(update, &["status"]),
        }),
        "tool_call_update" => Some(HermesEvent::ToolUpdate {
            session_id: awt_session_id.to_string(),
            tool_call_id: read_string(update, &["toolCallId", "id"]),
            status: read_string(update, &["status"]),
            content: update_text(update),
        }),
        "plan" => Some(HermesEvent::Plan {
            session_id: awt_session_id.to_string(),
            entries: plan_entries(update),
        }),
        "usage_update" => Some(HermesEvent::Usage {
            session_id: awt_session_id.to_string(),
            size: read_u64(update, &["size", "contextWindow"]),
            used: read_u64(update, &["used", "tokens"]),
        }),
        _ => None,
    }
}

fn translate_permission(awt_session_id: &str, value: &Value) -> Option<HermesEvent> {
    let params = value.get("params")?;
    let tool_call = params.get("toolCall")?;
    Some(HermesEvent::Permission {
        session_id: awt_session_id.to_string(),
        request_id: value.get("id")?.as_u64()?,
        title: read_string(tool_call, &["title", "name"]),
        tool_kind: read_string(tool_call, &["kind", "toolKind"]),
        options: params
            .get("options")
            .and_then(Value::as_array)
            .map(|options| {
                options
                    .iter()
                    .map(|option| HermesPermissionOption {
                        option_id: read_string(option, &["optionId", "id"]),
                        name: read_string(option, &["name"]),
                        kind: read_string(option, &["kind"]),
                    })
                    .collect()
            })
            .unwrap_or_default(),
        diff_path: tool_call.pointer("/content/path").and_then(Value::as_str).map(str::to_string),
        old_text: tool_call.pointer("/content/oldText").and_then(Value::as_str).map(str::to_string),
        new_text: tool_call.pointer("/content/newText").and_then(Value::as_str).map(str::to_string),
    })
}

fn update_text(update: &Value) -> String {
    for key in ["text", "content", "delta"] {
        if let Some(text) = update.get(key).and_then(Value::as_str) {
            return text.to_string();
        }
    }
    update
        .get("content")
        .and_then(|content| content.get("text"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn plan_entries(update: &Value) -> Vec<HermesPlanEntry> {
    let entries = update
        .get("entries")
        .or_else(|| update.get("plan").and_then(|plan| plan.get("entries")))
        .and_then(Value::as_array);
    entries
        .map(|entries| {
            entries
                .iter()
                .map(|entry| HermesPlanEntry {
                    content: read_string(entry, &["content", "title"]),
                    status: read_string(entry, &["status"]),
                    priority: read_string(entry, &["priority"]),
                })
                .collect()
        })
        .unwrap_or_default()
}

fn models_from_response(value: &Value) -> (Vec<HermesModelInfo>, String) {
    let current = read_string(value, &["model", "currentModel", "currentModelId", "current_model_id"]);
    let models = value
        .get("models")
        .or_else(|| value.get("availableModels"))
        .or_else(|| value.get("available_models"))
        .and_then(Value::as_array)
        .map(|models| {
            models
                .iter()
                .filter_map(|model| {
                    if let Some(id) = model.as_str() {
                        return Some(HermesModelInfo { id: id.to_string(), name: id.to_string() });
                    }
                    let id = read_string(model, &["id", "modelId", "model_id"]);
                    if id.is_empty() {
                        return None;
                    }
                    Some(HermesModelInfo {
                        name: read_string(model, &["name", "displayName", "display_name"]).if_empty_then(id.clone()),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    (models, current)
}

trait EmptyStringExt {
    fn if_empty_then(self, fallback: String) -> String;
}

impl EmptyStringExt for String {
    fn if_empty_then(self, fallback: String) -> String {
        if self.is_empty() { fallback } else { self }
    }
}

fn read_string(value: &Value, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .unwrap_or_default()
        .to_string()
}

fn read_u64(value: &Value, keys: &[&str]) -> u64 {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_u64))
        .unwrap_or_default()
}

pub fn hermes_home(session_id: &str) -> Result<PathBuf> {
    let safe_session_id = sanitize_session_id(session_id);
    if safe_session_id.is_empty() {
        bail!("Hermes session id contains no filesystem-safe characters");
    }
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join("hermes")
        .join(safe_session_id))
}

fn resolve_workspace_cwd(workspace_folder: Option<&str>, home: &Path) -> Result<PathBuf> {
    let Some(raw_cwd) = workspace_folder.and_then(non_empty_str) else {
        return Ok(home.to_path_buf());
    };
    let raw_path = PathBuf::from(raw_cwd);
    let cwd = if raw_path.is_absolute() {
        raw_path
    } else {
        std::env::current_dir()
            .context("resolve relative Hermes workspace folder")?
            .join(raw_path)
    };
    let metadata = std::fs::metadata(&cwd).with_context(|| {
        format!(
            "Hermes workspace folder is not accessible: {}. Open/create a workspace with an existing folder, or use a workspace without a folder to run from HERMES_HOME ({})",
            cwd.display(),
            home.display()
        )
    })?;
    if !metadata.is_dir() {
        bail!(
            "Hermes workspace folder is not a directory: {}. Open/create a workspace with an existing folder, or use a workspace without a folder to run from HERMES_HOME ({})",
            cwd.display(),
            home.display()
        );
    }
    Ok(cwd)
}

fn read_workspace_model(doc: &serde_yaml::Mapping) -> Option<HermesConfiguredModel> {
    match doc.get(&serde_yaml::Value::from("model"))? {
        serde_yaml::Value::Mapping(model) => {
            let provider = model
                .get(&serde_yaml::Value::from("provider"))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let id = model
                .get(&serde_yaml::Value::from("default"))
                .or_else(|| model.get(&serde_yaml::Value::from("model")))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let base_url = model
                .get(&serde_yaml::Value::from("base_url"))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string);

            Some(HermesConfiguredModel {
                provider: provider.to_string(),
                model: id.to_string(),
                base_url,
            })
        }
        _ => None,
    }
}

fn ensure_workspace_native(session_id: &str, workspace_folder: Option<&str>) -> Result<HermesWorkspaceState> {
    let home = hermes_home(session_id)?;
    std::fs::create_dir_all(&home)?;
    let cwd = resolve_workspace_cwd(workspace_folder, &home)?;
    let config_path = home.join("config.yaml");
    let mut doc = read_workspace_config_doc(&config_path)?;
    let command = std::env::current_exe()?.to_string_lossy().to_string();
    let cwd_text = cwd.to_string_lossy().to_string();

    merge_awt_into_doc(
        &mut doc,
        &command,
        session_id,
        crate::daemon::paths::app_flavor(),
        &cwd_text,
    )?;
    std::fs::write(&config_path, serde_yaml::to_string(&serde_yaml::Value::Mapping(doc.clone()))?)?;

    Ok(HermesWorkspaceState {
        home: home.to_string_lossy().to_string(),
        workspace_folder: cwd_text,
        model: read_workspace_model(&doc),
    })
}

fn read_workspace_state_native(session_id: &str) -> Result<HermesWorkspaceState> {
    let home = hermes_home(session_id)?;
    let config_path = home.join("config.yaml");
    let doc = read_workspace_config_doc(&config_path)?;
    let workspace_folder = doc
        .get(&serde_yaml::Value::from("terminal"))
        .and_then(serde_yaml::Value::as_mapping)
        .and_then(|terminal| terminal.get(&serde_yaml::Value::from("cwd")))
        .and_then(serde_yaml::Value::as_str)
        .unwrap_or_default()
        .to_string();

    Ok(HermesWorkspaceState {
        home: home.to_string_lossy().to_string(),
        workspace_folder,
        model: read_workspace_model(&doc),
    })
}

fn read_workspace_config_doc(config_path: &Path) -> Result<serde_yaml::Mapping> {
    if !config_path.exists() {
        return Ok(serde_yaml::Mapping::new());
    }
    Ok(serde_yaml::from_str::<serde_yaml::Value>(&std::fs::read_to_string(config_path)?)
        .ok()
        .and_then(|value| value.as_mapping().cloned())
        .unwrap_or_default())
}

fn merge_awt_into_doc(
    doc: &mut serde_yaml::Mapping,
    command: &str,
    session_id: &str,
    flavor: &str,
    cwd: &str,
) -> Result<()> {
    let mut env = BTreeMap::new();
    env.insert("AWT_SESSION_ID".to_string(), session_id.to_string());
    env.insert("AWT_APP_FLAVOR".to_string(), flavor.to_string());
    let awt = serde_yaml::to_value(McpServerConfig {
        command: command.to_string(),
        args: vec!["mcp".to_string(), "serve".to_string()],
        env,
        enabled: true,
    })?;
    upsert_mapping(doc, "mcp_servers", "awt", awt);

    let terminal = doc
        .entry(serde_yaml::Value::from("terminal"))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if !matches!(terminal, serde_yaml::Value::Mapping(_)) {
        *terminal = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    if let serde_yaml::Value::Mapping(terminal) = terminal {
        terminal.insert(serde_yaml::Value::from("cwd"), serde_yaml::Value::from(cwd));
        terminal
            .entry(serde_yaml::Value::from("backend"))
            .or_insert_with(|| serde_yaml::Value::from("local"));
    }
    Ok(())
}

fn upsert_mapping(doc: &mut serde_yaml::Mapping, outer: &str, key: &str, value: serde_yaml::Value) {
    let outer_value = doc
        .entry(serde_yaml::Value::from(outer))
        .or_insert_with(|| serde_yaml::Value::Mapping(serde_yaml::Mapping::new()));
    if !matches!(outer_value, serde_yaml::Value::Mapping(_)) {
        *outer_value = serde_yaml::Value::Mapping(serde_yaml::Mapping::new());
    }
    if let serde_yaml::Value::Mapping(outer_map) = outer_value {
        outer_map.insert(serde_yaml::Value::from(key), value);
    }
}

pub fn resolve_command(command_override: Option<String>) -> Result<String> {
    if let Some(command) = command_override.and_then(non_empty) {
        return Ok(command);
    }
    let managed = managed_bin_path(HERMES_ACP_BIN)?;
    if managed.exists() {
        return Ok(managed.to_string_lossy().to_string());
    }
    Ok("hermes-acp".to_string())
}

#[allow(dead_code)]
fn resolve_hermes_command(command_override: Option<String>) -> Result<String> {
    if let Some(command) = command_override.and_then(non_empty) {
        if command.ends_with("hermes-acp") || command.ends_with("hermes-acp.exe") {
            let path = PathBuf::from(command);
            let sibling = path.with_file_name(HERMES_BIN);
            if sibling.exists() {
                return Ok(sibling.to_string_lossy().to_string());
            }
        } else {
            return Ok(command);
        }
    }
    let managed = managed_bin_path(HERMES_BIN)?;
    if managed.exists() {
        return Ok(managed.to_string_lossy().to_string());
    }
    Ok("hermes".to_string())
}

fn hermes_auth_list_native(session_id: &str, command_override: Option<String>) -> Result<String> {
    let home = hermes_home(session_id)?;
    std::fs::create_dir_all(&home)?;
    let command_path = resolve_hermes_command(command_override)?;
    let mut command = Command::new(command_path);
    command
        .arg("auth")
        .arg("list")
        .env("HERMES_HOME", &home);
    apply_no_window(&mut command);
    let output = command.output().context("run hermes auth list")?;
    if !output.status.success() {
        return Err(anyhow!(stderr_or_status(&output, "hermes auth list")));
    }
    Ok(stdout_or_stderr(&output))
}

fn hermes_runtime_status_native(command_override: Option<String>) -> Result<HermesRuntimeStatus> {
    let command = resolve_command(command_override)?;
    let mut probe = Command::new(&command);
    probe.arg("--version");
    apply_no_window(&mut probe);
    match probe.output() {
        Ok(output) if output.status.success() => {
            let version = stdout_or_stderr(&output);
            Ok(HermesRuntimeStatus {
                installed: true,
                command,
                version: non_empty(version),
            })
        }
        _ => Ok(HermesRuntimeStatus {
            installed: false,
            command,
            version: None,
        }),
    }
}

fn ensure_runtime_ready(app: &AppHandle, command_override: Option<String>) -> Result<()> {
    if command_override.and_then(non_empty).is_some() {
        return Ok(());
    }
    if !hermes_runtime_status_native(None)?.installed {
        hermes_install_runtime_native(app)?;
    }
    Ok(())
}

fn hermes_install_runtime_native(app: &AppHandle) -> Result<String> {
    let uv = bundled_uv(app).unwrap_or_else(|_| PathBuf::from("uv"));
    let runtime_dir = crate::daemon::paths::daemon_paths()?.data_dir.join("hermes").join("runtime");
    let tools_dir = runtime_dir.join("tools");
    let bin_dir = runtime_dir.join("bin");
    std::fs::create_dir_all(&tools_dir)?;
    std::fs::create_dir_all(&bin_dir)?;

    let mut command = Command::new(uv);
    command
        .arg("tool")
        .arg("install")
        .arg("--force")
        .arg(format!("hermes-agent[acp,mcp]=={HERMES_VERSION}"))
        .env("UV_TOOL_DIR", &tools_dir)
        .env("UV_TOOL_BIN_DIR", &bin_dir);
    apply_no_window(&mut command);
    let output = command.output().context("run uv tool install")?;
    if !output.status.success() {
        return Err(anyhow!(stderr_or_status(&output, "uv")));
    }
    let acp = bin_dir.join(HERMES_ACP_BIN);
    if !acp.exists() {
        return Err(anyhow!("uv completed but {} was not created", acp.display()));
    }
    Ok(acp.to_string_lossy().to_string())
}


fn hermes_gateway_provision_native(
    session_id: &str,
    gateway: &HermesGatewayConfig,
    token: Option<&str>,
) -> Result<()> {
    let home = hermes_home(session_id)?;
    std::fs::create_dir_all(&home)?;
    if let Some(value) = token.and_then(non_empty_str) {
        upsert_dotenv(&home.join(".env"), &gateway.token_env, value)?;
    }
    let allowed_key = format!("{}_ALLOWED_USERS", gateway_platform_env_prefix(&gateway.platform));
    upsert_dotenv(&home.join(".env"), &allowed_key, &gateway.allowed_users)?;
    Ok(())
}

fn gateway_platform_env_prefix(platform: &HermesGatewayPlatform) -> &'static str {
    match platform {
        HermesGatewayPlatform::Telegram => "TELEGRAM",
        HermesGatewayPlatform::Discord => "DISCORD",
        HermesGatewayPlatform::Slack => "SLACK",
    }
}

fn bundled_uv(app: &AppHandle) -> Result<PathBuf> {
    Ok(app
        .path()
        .resolve("resources/uv/uv.exe", tauri::path::BaseDirectory::Resource)?)
}

fn managed_bin_path(bin: &str) -> Result<PathBuf> {
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join("hermes")
        .join("runtime")
        .join("bin")
        .join(bin))
}


fn upsert_dotenv(path: &Path, key: &str, value: &str) -> Result<()> {
    validate_env_key(key)?;
    if value.contains('\n') || value.contains('\r') {
        return Err(anyhow!("environment value for {key} must be a single line"));
    }
    let line = format!("{key}={value}");
    let existing = std::fs::read_to_string(path).unwrap_or_default();
    let mut replaced = false;
    let mut lines = Vec::new();
    for existing_line in existing.lines() {
        if existing_line.trim_start().starts_with(&format!("{key}=")) {
            lines.push(line.clone());
            replaced = true;
        } else {
            lines.push(existing_line.to_string());
        }
    }
    if !replaced {
        lines.push(line);
    }
    std::fs::write(path, format!("{}\n", lines.join("\n")))?;
    Ok(())
}


fn validate_env_key(key: &str) -> Result<()> {
    let valid = !key.is_empty()
        && key
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
        && key
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_uppercase() || ch == '_');
    if valid {
        Ok(())
    } else {
        Err(anyhow!("invalid environment variable name: {key}"))
    }
}


fn sanitize_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>()
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

fn non_empty_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() { None } else { Some(trimmed) }
}

fn stdout_or_stderr(output: &std::process::Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        String::from_utf8_lossy(&output.stderr).trim().to_string()
    } else {
        stdout
    }
}

fn stderr_or_status(output: &std::process::Output, command: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("{command} exited with status {}", output.status)
    } else {
        stderr
    }
}

fn apply_no_window(command: &mut Command) {
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
}

fn to_string(err: impl std::fmt::Display) -> String {
    format!("{err:#}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn translate_update_maps_message_chunk() {
        let value = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-session",
                "update": { "sessionUpdate": "agent_message_chunk", "content": "hello" }
            }
        });

        let event = translate_update("awt-session", &value).expect("event");
        match event {
            HermesEvent::Message { session_id, text } => {
                assert_eq!(session_id, "awt-session");
                assert_eq!(text, "hello");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn translate_update_maps_tool_call() {
        let value = json!({
            "jsonrpc": "2.0",
            "method": "session/update",
            "params": {
                "sessionId": "acp-session",
                "update": {
                    "sessionUpdate": "tool_call",
                    "toolCallId": "tool-1",
                    "title": "List panes",
                    "kind": "mcp",
                    "status": "pending"
                }
            }
        });

        let event = translate_update("awt-session", &value).expect("event");
        match event {
            HermesEvent::ToolCall { session_id, tool_call_id, title, tool_kind, status } => {
                assert_eq!(session_id, "awt-session");
                assert_eq!(tool_call_id, "tool-1");
                assert_eq!(title, "List panes");
                assert_eq!(tool_kind, "mcp");
                assert_eq!(status, "pending");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn hermes_manager_tracks_active_prompts_for_cancel_guard() {
        let manager = HermesManager::new();

        assert!(!manager.is_prompt_active("session-1"));
        manager.set_prompt_active("session-1", true);
        assert!(manager.is_prompt_active("session-1"));
        manager.set_prompt_active("session-1", false);
        assert!(!manager.is_prompt_active("session-1"));
    }

    #[test]
    fn acp_session_id_uses_saved_id_for_resume_ack() {
        let session_id = acp_session_id_from_response(&json!({}), Some("saved-session")).expect("resume id");

        assert_eq!(session_id, "saved-session");
    }

    #[test]
    fn acp_session_id_prefers_response_id() {
        let session_id = acp_session_id_from_response(
            &json!({ "sessionId": "new-session" }),
            Some("saved-session"),
        )
        .expect("response id");

        assert_eq!(session_id, "new-session");
    }

    #[test]
    fn acp_model_id_qualifies_with_provider() {
        let anthropic = HermesConfiguredModel {
            provider: "anthropic".to_string(),
            model: "anthropic/claude-sonnet-4-6".to_string(),
            base_url: None,
        };
        let openrouter = HermesConfiguredModel {
            provider: "openrouter".to_string(),
            model: "anthropic/claude-sonnet-4.6".to_string(),
            base_url: None,
        };
        let codex = HermesConfiguredModel {
            provider: "openai-codex".to_string(),
            model: "gpt-5.5".to_string(),
            base_url: None,
        };
        let no_provider = HermesConfiguredModel {
            provider: String::new(),
            model: "gpt-5.5".to_string(),
            base_url: None,
        };

        assert_eq!(acp_model_id_from_configured_model(&anthropic), "anthropic:claude-sonnet-4-6");
        assert_eq!(acp_model_id_from_configured_model(&openrouter), "openrouter:anthropic/claude-sonnet-4.6");
        assert_eq!(acp_model_id_from_configured_model(&codex), "openai-codex:gpt-5.5");
        assert_eq!(acp_model_id_from_configured_model(&no_provider), "gpt-5.5");
    }

    #[test]
    fn models_from_response_reads_hermes_available_models_shape() {
        let (models, current) = models_from_response(&json!({
            "current_model_id": "openai-codex:gpt-5.5",
            "available_models": [
                { "model_id": "openai-codex:gpt-5.5", "display_name": "GPT 5.5 Codex" },
                "anthropic:claude-sonnet-4-6"
            ]
        }));

        assert_eq!(current, "openai-codex:gpt-5.5");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].id, "openai-codex:gpt-5.5");
        assert_eq!(models[0].name, "GPT 5.5 Codex");
        assert_eq!(models[1].id, "anthropic:claude-sonnet-4-6");
        assert_eq!(models[1].name, "anthropic:claude-sonnet-4-6");
    }

    #[test]
    fn read_workspace_model_interprets_mapping_and_sentinel() {
        let doc = yaml_mapping(
            r#"
model:
  provider: anthropic
  default: claude-sonnet-4-6
  base_url: https://api.anthropic.com
"#,
        );

        let model = read_workspace_model(&doc).expect("configured model");

        assert_eq!(model.provider, "anthropic");
        assert_eq!(model.model, "claude-sonnet-4-6");
        assert_eq!(model.base_url.as_deref(), Some("https://api.anthropic.com"));
        assert!(read_workspace_model(&yaml_mapping("model: ''\n")).is_none());
    }

    #[test]
    fn merge_awt_into_doc_preserves_model_and_wires_workspace() {
        let mut doc = yaml_mapping(
            r#"
model:
  provider: anthropic
  default: claude-sonnet-4-6
stray: kept
terminal:
  backend: remote
"#,
        );
        let model_before = doc.get(&serde_yaml::Value::from("model")).cloned().expect("model block");

        merge_awt_into_doc(
            &mut doc,
            r"E:\AgenticWorkspaceTerminal\app.exe",
            "session-1",
            "dev",
            r"E:\CityAI\IncheonProject\t2in-dev",
        )
        .expect("merge");

        assert_eq!(doc.get(&serde_yaml::Value::from("model")), Some(&model_before));
        let yaml = serde_yaml::Value::Mapping(doc);
        assert_eq!(yaml["stray"].as_str(), Some("kept"));
        assert_eq!(yaml["terminal"]["cwd"].as_str(), Some(r"E:\CityAI\IncheonProject\t2in-dev"));
        assert_eq!(yaml["terminal"]["backend"].as_str(), Some("remote"));
        assert_eq!(yaml["mcp_servers"]["awt"]["command"].as_str(), Some(r"E:\AgenticWorkspaceTerminal\app.exe"));
        assert_eq!(yaml["mcp_servers"]["awt"]["args"][0].as_str(), Some("mcp"));
        assert_eq!(yaml["mcp_servers"]["awt"]["args"][1].as_str(), Some("serve"));
        assert_eq!(yaml["mcp_servers"]["awt"]["env"]["AWT_SESSION_ID"].as_str(), Some("session-1"));
        assert_eq!(yaml["mcp_servers"]["awt"]["env"]["AWT_APP_FLAVOR"].as_str(), Some("dev"));
        assert_eq!(yaml["mcp_servers"]["awt"]["enabled"].as_bool(), Some(true));
    }

    fn yaml_mapping(input: &str) -> serde_yaml::Mapping {
        serde_yaml::from_str::<serde_yaml::Value>(input)
            .expect("parse yaml")
            .as_mapping()
            .cloned()
            .expect("yaml mapping")
    }

    #[test]
    fn resolve_workspace_cwd_rejects_missing_workspace() {
        let home = std::env::temp_dir().join(format!("hermes-home-test-{}", uuid::Uuid::new_v4()));
        let missing = std::env::temp_dir().join(format!("hermes-missing-workspace-{}", uuid::Uuid::new_v4()));

        let error = resolve_workspace_cwd(Some(missing.to_string_lossy().as_ref()), &home)
            .expect_err("missing workspace should be rejected")
            .to_string();

        assert!(error.contains("Hermes workspace folder is not accessible"));
        assert!(error.contains(&home.to_string_lossy().to_string()));
    }
}

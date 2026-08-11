use crate::storage::{
    load_with_recovery, parse_json, require_supported_schema, write_json, DocumentError,
};
use anyhow::{anyhow, bail, Context, Result};
use crossbeam_channel::{bounded, Receiver, RecvTimeoutError, Sender};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{ipc::Channel, State};
use tracing::{debug, warn};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const HERMES_ACP_BIN: &str = if cfg!(windows) {
    "hermes-acp.exe"
} else {
    "hermes-acp"
};
const HERMES_BIN: &str = if cfg!(windows) {
    "hermes.exe"
} else {
    "hermes"
};
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a cooperative `session/cancel` gets to land before the prompt wait is
/// resolved locally. A wedged agent must never leave the chat stuck in `busy`.
const PROMPT_CANCEL_GRACE: Duration = Duration::from_secs(5);
const PROMPT_POLL_INTERVAL: Duration = Duration::from_millis(250);
const LAST_ACP_SESSION_SCHEMA_VERSION: u64 = 1;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LastAcpSessionDocument {
    schema_version: u64,
    acp_session_id: String,
}

struct LoadedLastAcpSession {
    acp_session_id: Option<String>,
    legacy: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesRuntimeStatus {
    pub detected: bool,
    pub command: Option<String>,
    pub cli_command: Option<String>,
    pub version: Option<String>,
    pub home: Option<String>,
    pub source: Option<String>,
    pub configured_model: Option<HermesConfiguredModel>,
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
pub struct HermesSessionInfo {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub cwd: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct HermesEvent {
    generation: u64,
    #[serde(flatten)]
    payload: HermesEventPayload,
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "kind"
)]
pub enum HermesEventPayload {
    Started {
        session_id: String,
        acp_session_id: String,
    },
    SessionReplay {
        session_id: String,
        acp_session_id: String,
    },
    UserMessage {
        session_id: String,
        text: String,
    },
    Message {
        session_id: String,
        text: String,
    },
    Thought {
        session_id: String,
        text: String,
    },
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
    Plan {
        session_id: String,
        entries: Vec<HermesPlanEntry>,
    },
    Usage {
        session_id: String,
        size: u64,
        used: u64,
    },
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
    Models {
        session_id: String,
        available: Vec<HermesModelInfo>,
        current: String,
    },
    TurnEnded {
        session_id: String,
        stop_reason: String,
    },
    Error {
        session_id: String,
        message: String,
    },
    Exited {
        session_id: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HermesStartResult {
    generation: u64,
}

struct HermesInstanceEntry {
    generation: u64,
    instance: Arc<HermesInstance>,
}

pub struct HermesManager {
    instances: Mutex<HashMap<String, HermesInstanceEntry>>,
    starting: Mutex<HashMap<String, u64>>,
    next_generation: AtomicU64,
    output_channel: Mutex<Option<Channel<HermesEvent>>>,
    active_prompts: Mutex<HashMap<String, u64>>,
}

struct HermesInstance {
    child: Mutex<Child>,
    stdin: Mutex<ChildStdin>,
    next_id: AtomicU64,
    pending: Mutex<HashMap<u64, Sender<Value>>>,
    acp_session_id: Mutex<Option<String>>,
    sessions_list_supported: AtomicBool,
    prompt_cancel_requested: AtomicBool,
    cwd: String,
}

impl Default for HermesManager {
    fn default() -> Self {
        Self::new()
    }
}

impl HermesManager {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(1),
            output_channel: Mutex::new(None),
            active_prompts: Mutex::new(HashMap::new()),
        }
    }

    pub fn set_output_channel(&self, channel: Channel<HermesEvent>) {
        *self
            .output_channel
            .lock()
            .expect("hermes output channel poisoned") = Some(channel);
    }

    pub fn start(
        self: &Arc<Self>,
        session_id: String,
        command_override: Option<String>,
        workspace_folder: Option<String>,
    ) -> Result<u64> {
        let existing = self
            .instances
            .lock()
            .expect("hermes instances poisoned")
            .get(&session_id)
            .map(|entry| (entry.generation, Arc::clone(&entry.instance)));
        if let Some((generation, instance)) = &existing {
            if let Some(acp_session_id) = instance
                .acp_session_id
                .lock()
                .expect("hermes acp session poisoned")
                .clone()
            {
                self.send_current_event(
                    &session_id,
                    *generation,
                    HermesEventPayload::Started {
                        session_id: session_id.clone(),
                        acp_session_id,
                    },
                )?;
                return Ok(*generation);
            }
        }

        let generation = {
            let mut starting = self.starting.lock().expect("hermes starting poisoned");
            if let Some(generation) = starting.get(&session_id) {
                return Ok(*generation);
            }
            let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
            starting.insert(session_id.clone(), generation);
            generation
        };

        if let Some((existing_generation, _)) = existing {
            if let Err(error) = self.stop_generation(&session_id, existing_generation, false) {
                if self.current_generation(&session_id) == Some(existing_generation) {
                    self.clear_starting(&session_id, generation);
                    return Err(error);
                }
            }
        }

        let result = (|| -> Result<()> {
            let command_path = resolve_command(command_override)?;
            let agent_dir = agent_workspace_dir(&session_id)?;
            std::fs::create_dir_all(&agent_dir)?;
            let cwd = resolve_workspace_cwd(workspace_folder.as_deref(), &agent_dir)?;
            let acp_cwd = cwd.to_string_lossy().to_string();
            let configured_model = read_global_configured_model().ok().flatten();
            let mut command = Command::new(&command_path);
            command
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            command.current_dir(&cwd);
            apply_no_window(&mut command);

            let mut child = command.spawn().with_context(|| {
                format!(
                    "spawn Hermes ACP command {command_path} in {}",
                    cwd.display()
                )
            })?;
            let stdin = child
                .stdin
                .take()
                .ok_or_else(|| anyhow!("Hermes stdin unavailable"))?;
            let stdout = child
                .stdout
                .take()
                .ok_or_else(|| anyhow!("Hermes stdout unavailable"))?;
            let stderr = child.stderr.take();
            let instance = Arc::new(HermesInstance {
                child: Mutex::new(child),
                stdin: Mutex::new(stdin),
                next_id: AtomicU64::new(1),
                pending: Mutex::new(HashMap::new()),
                acp_session_id: Mutex::new(None),
                sessions_list_supported: AtomicBool::new(false),
                prompt_cancel_requested: AtomicBool::new(false),
                cwd: acp_cwd.clone(),
            });

            self.instances
                .lock()
                .expect("hermes instances poisoned")
                .insert(
                    session_id.clone(),
                    HermesInstanceEntry {
                        generation,
                        instance: Arc::clone(&instance),
                    },
                );

            spawn_stdout_reader(
                session_id.clone(),
                generation,
                stdout,
                Arc::clone(&instance),
                Arc::clone(self),
            );
            if let Some(stderr) = stderr {
                spawn_stderr_drain(session_id.clone(), generation, stderr, Arc::clone(self));
            }

            let handshake_session_id = session_id.clone();
            let handshake_cwd = acp_cwd.clone();
            let handshake_home = agent_dir.clone();
            let handshake_instance = Arc::clone(&instance);
            let handshake_manager = Arc::clone(self);
            thread::Builder::new()
                .name(format!("vibelink-hermes-handshake-{session_id}"))
                .spawn(move || {
                    let result = handshake(
                        &handshake_session_id,
                        generation,
                        &handshake_cwd,
                        &handshake_home,
                        configured_model.as_ref(),
                        &handshake_instance,
                        &handshake_manager,
                    );
                    handshake_manager.clear_starting(&handshake_session_id, generation);
                    if let Err(err) = result {
                        let _ = handshake_manager.send_current_event(
                            &handshake_session_id,
                            generation,
                            HermesEventPayload::Error {
                                session_id: handshake_session_id.clone(),
                                message: err.to_string(),
                            },
                        );
                        let _ = handshake_manager.stop_generation(
                            &handshake_session_id,
                            generation,
                            true,
                        );
                    }
                })
                .map_err(|err| anyhow!(err))?;
            Ok(())
        })();

        if result.is_err() {
            self.clear_starting(&session_id, generation);
            let _ = self.stop_generation(&session_id, generation, false);
        }
        result.map(|()| generation)
    }

    pub fn new_session(self: &Arc<Self>, session_id: &str, generation: u64) -> Result<String> {
        let instance = self.instance(session_id, generation)?;
        let home = agent_workspace_dir(session_id)?;
        let configured_model = read_global_configured_model().ok().flatten();
        let response = new_acp_session(session_id, &instance, &instance.cwd)?;
        let acp_id = acp_session_id_from_response(&response, None)?;
        finalize_acp_session(
            session_id,
            generation,
            &home,
            configured_model.as_ref(),
            &instance,
            self,
            &response,
            Some(&acp_id),
        )?;
        Ok(acp_id)
    }

    pub fn resume_session(
        self: &Arc<Self>,
        session_id: &str,
        generation: u64,
        acp_session_id: String,
    ) -> Result<()> {
        let instance = self.instance(session_id, generation)?;
        let home = agent_workspace_dir(session_id)?;
        let configured_model = read_global_configured_model().ok().flatten();
        self.send_current_event(
            session_id,
            generation,
            HermesEventPayload::SessionReplay {
                session_id: session_id.to_string(),
                acp_session_id: acp_session_id.clone(),
            },
        )?;
        let response = instance.request(
            "session/resume",
            json!({
                "cwd": &instance.cwd,
                "sessionId": acp_session_id,
                "mcpServers": vibelink_mcp_servers(session_id, crate::daemon::paths::app_flavor()),
            }),
            Some(REQUEST_TIMEOUT),
        )?;
        finalize_acp_session(
            session_id,
            generation,
            &home,
            configured_model.as_ref(),
            &instance,
            self,
            &response,
            Some(&acp_session_id),
        )
    }

    pub fn list_sessions(
        &self,
        session_id: &str,
        generation: u64,
    ) -> Result<Vec<HermesSessionInfo>> {
        let instance = self.instance(session_id, generation)?;
        if !instance.sessions_list_supported.load(Ordering::Relaxed) {
            bail!("session list requires a newer Hermes — run `hermes update`");
        }
        let mut sessions = Vec::new();
        let mut cursor: Option<String> = None;
        while sessions.len() < 200 {
            let response = instance.request(
                "session/list",
                json!({ "cwd": &instance.cwd, "cursor": cursor }),
                Some(REQUEST_TIMEOUT),
            )?;
            let page = response
                .get("sessions")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            for session in page {
                if sessions.len() == 200 {
                    break;
                }
                let Some(id) = session.get("sessionId").and_then(Value::as_str) else {
                    continue;
                };
                sessions.push(HermesSessionInfo {
                    id: id.to_string(),
                    title: session
                        .get("title")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    updated_at: session
                        .get("updatedAt")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    cwd: session
                        .get("cwd")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
            }
            cursor = response
                .get("nextCursor")
                .and_then(Value::as_str)
                .and_then(non_empty_str)
                .map(str::to_string);
            if cursor.is_none() {
                break;
            }
        }
        if !self.is_current(session_id, generation) {
            bail!("HERMES_SESSION_REPLACED");
        }
        Ok(sessions)
    }

    pub fn send_message(
        self: &Arc<Self>,
        session_id: String,
        generation: u64,
        text: String,
    ) -> Result<()> {
        let instance = self.instance(&session_id, generation)?;
        let acp_session_id = instance.acp_session_id()?;
        let skill_prompt =
            crate::app::skills::augment_prompt_with_enabled_skills(&session_id, &text)?;
        let prompt_text = Self::augment_prompt_with_workspace_brief(&session_id, skill_prompt)?;
        instance
            .prompt_cancel_requested
            .store(false, Ordering::SeqCst);
        let pending = instance.begin_request(
            "session/prompt",
            json!({
                "sessionId": acp_session_id,
                "prompt": [{ "type": "text", "text": prompt_text }],
            }),
        )?;
        let pending_id = pending.id;
        self.set_prompt_active(&session_id, generation, true);
        let manager = Arc::clone(self);
        let response_instance = Arc::clone(&instance);
        let response_session_id = session_id.clone();
        let spawn = thread::Builder::new()
            .name(format!("vibelink-hermes-prompt-{session_id}"))
            .spawn(move || {
                let result = response_instance.finish_prompt_request(pending);
                manager.set_prompt_active(&response_session_id, generation, false);
                match result {
                    Ok(value) => {
                        let stop_reason = value
                            .get("stopReason")
                            .and_then(Value::as_str)
                            .unwrap_or("end_turn")
                            .to_string();
                        let _ = manager.send_current_event(
                            &response_session_id,
                            generation,
                            HermesEventPayload::TurnEnded {
                                session_id: response_session_id.clone(),
                                stop_reason,
                            },
                        );
                    }
                    Err(err) => {
                        let _ = manager.send_current_event(
                            &response_session_id,
                            generation,
                            HermesEventPayload::Error {
                                session_id: response_session_id.clone(),
                                message: err.to_string(),
                            },
                        );
                    }
                }
            });
        if let Err(error) = spawn {
            instance.cancel_pending(pending_id);
            self.set_prompt_active(&session_id, generation, false);
            return Err(anyhow!(error));
        }
        Ok(())
    }
    fn augment_prompt_with_workspace_brief(session_id: &str, prompt: String) -> Result<String> {
        let brief = crate::app::board::board_brief_get_native(session_id)?;
        Ok(Self::augment_prompt_with_brief(prompt, brief.as_ref()))
    }

    fn augment_prompt_with_brief(
        mut prompt: String,
        brief: Option<&crate::app::board::Brief>,
    ) -> String {
        let Some(brief) = brief else {
            return prompt;
        };
        if brief.purpose.is_empty() && brief.notes.is_empty() {
            return prompt;
        }
        prompt.push_str("\n\n## Workspace brief\n");
        if !brief.purpose.is_empty() {
            prompt.push_str("Purpose: ");
            prompt.push_str(&brief.purpose);
            prompt.push('\n');
        }
        if !brief.notes.is_empty() {
            prompt.push_str("Notes: ");
            prompt.push_str(&brief.notes);
        }
        prompt
    }

    pub fn cancel(&self, session_id: &str, generation: u64) -> Result<()> {
        if !self.is_prompt_active(session_id, generation) {
            debug!(
                session_id,
                generation, "ignoring Hermes cancel without active prompt"
            );
            return Ok(());
        }
        let instance = self.instance(session_id, generation)?;
        // Arm the local fallback before asking Hermes to stop. A hung agent never
        // answers `session/cancel`, and without this the prompt thread waits forever
        // and the chat stays `busy` with no way out from the UI.
        instance
            .prompt_cancel_requested
            .store(true, Ordering::SeqCst);
        let acp_session_id = instance.acp_session_id()?;
        instance.notification("session/cancel", json!({ "sessionId": acp_session_id }))
    }

    pub fn respond_permission(
        &self,
        session_id: &str,
        generation: u64,
        request_id: u64,
        option_id: String,
    ) -> Result<()> {
        let instance = self.instance(session_id, generation)?;
        instance.write_line(&json!({
            "jsonrpc": "2.0",
            "id": request_id,
            "result": { "optionId": option_id },
        }))
    }

    pub fn set_model(&self, session_id: &str, generation: u64, model_id: String) -> Result<()> {
        require_qualified_model(&model_id)?;
        let instance = self.instance(session_id, generation)?;
        let acp_session_id = instance.acp_session_id()?;
        instance.request(
            "session/set_model",
            json!({ "sessionId": acp_session_id, "modelId": model_id }),
            Some(REQUEST_TIMEOUT),
        )?;
        self.instance(session_id, generation)?;
        Ok(())
    }

    pub fn set_mode(&self, session_id: &str, generation: u64, mode_id: String) -> Result<()> {
        let instance = self.instance(session_id, generation)?;
        let acp_session_id = instance.acp_session_id()?;
        instance.request(
            "session/set_mode",
            json!({ "sessionId": acp_session_id, "modeId": mode_id }),
            Some(REQUEST_TIMEOUT),
        )?;
        self.instance(session_id, generation)?;
        Ok(())
    }
    pub fn stop(&self, session_id: &str) -> Result<()> {
        let Some(generation) = self.current_generation(session_id) else {
            return Ok(());
        };
        self.stop_generation(session_id, generation, true)
    }

    fn stop_generation(&self, session_id: &str, generation: u64, emit_exit: bool) -> Result<()> {
        let instance = self.instance(session_id, generation)?;
        instance.fail_pending("HERMES_SESSION_REPLACED");
        self.set_prompt_active(session_id, generation, false);
        {
            let mut child = instance.child.lock().expect("hermes child poisoned");
            if child.try_wait()?.is_none() {
                if let Err(error) = child.kill() {
                    if child.try_wait()?.is_none() {
                        return Err(error).context("kill Hermes process");
                    }
                } else {
                    child.wait().context("wait for Hermes process")?;
                }
            }
        }
        if emit_exit {
            self.retire_instance_if_current(session_id, generation, true)?;
        } else {
            self.remove_instance_if_current(session_id, generation);
        }
        Ok(())
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
    }

    fn clear_starting(&self, session_id: &str, generation: u64) {
        let mut starting = self.starting.lock().expect("hermes starting poisoned");
        if starting.get(session_id) == Some(&generation) {
            starting.remove(session_id);
        }
    }

    fn set_prompt_active(&self, session_id: &str, generation: u64, active: bool) {
        let mut active_prompts = self
            .active_prompts
            .lock()
            .expect("hermes active prompts poisoned");
        if active {
            active_prompts.insert(session_id.to_string(), generation);
        } else if active_prompts.get(session_id) == Some(&generation) {
            active_prompts.remove(session_id);
        }
    }

    fn is_prompt_active(&self, session_id: &str, generation: u64) -> bool {
        self.active_prompts
            .lock()
            .expect("hermes active prompts poisoned")
            .get(session_id)
            == Some(&generation)
    }

    fn current_generation(&self, session_id: &str) -> Option<u64> {
        self.instances
            .lock()
            .expect("hermes instances poisoned")
            .get(session_id)
            .map(|entry| entry.generation)
    }

    fn is_current(&self, session_id: &str, generation: u64) -> bool {
        self.current_generation(session_id) == Some(generation)
    }

    fn instance(&self, session_id: &str, generation: u64) -> Result<Arc<HermesInstance>> {
        self.instances
            .lock()
            .expect("hermes instances poisoned")
            .get(session_id)
            .filter(|entry| entry.generation == generation)
            .map(|entry| Arc::clone(&entry.instance))
            .ok_or_else(|| anyhow!("HERMES_SESSION_REPLACED"))
    }

    fn remove_instance_if_current(&self, session_id: &str, generation: u64) -> bool {
        let mut instances = self.instances.lock().expect("hermes instances poisoned");
        if instances.get(session_id).map(|entry| entry.generation) != Some(generation) {
            return false;
        }
        instances.remove(session_id);
        true
    }

    fn retire_instance_if_current(
        &self,
        session_id: &str,
        generation: u64,
        emit_exit: bool,
    ) -> Result<bool> {
        let mut instances = self.instances.lock().expect("hermes instances poisoned");
        if instances.get(session_id).map(|entry| entry.generation) != Some(generation) {
            return Ok(false);
        }
        let send_result = if emit_exit {
            self.output_channel
                .lock()
                .expect("hermes output channel poisoned")
                .as_ref()
                .cloned()
                .map(|channel| {
                    channel.send(HermesEvent {
                        generation,
                        payload: HermesEventPayload::Exited {
                            session_id: session_id.to_string(),
                        },
                    })
                })
                .transpose()
        } else {
            Ok(None)
        };
        instances.remove(session_id);
        send_result?;
        Ok(true)
    }

    fn send_current_event(
        &self,
        session_id: &str,
        generation: u64,
        payload: HermesEventPayload,
    ) -> Result<()> {
        let instances = self.instances.lock().expect("hermes instances poisoned");
        if instances.get(session_id).map(|entry| entry.generation) != Some(generation) {
            return Ok(());
        }
        if let Some(channel) = self
            .output_channel
            .lock()
            .expect("hermes output channel poisoned")
            .as_ref()
            .cloned()
        {
            channel.send(HermesEvent {
                generation,
                payload,
            })?;
        }
        Ok(())
    }
}

struct PendingHermesRequest {
    id: u64,
    method: String,
    receiver: Receiver<Value>,
}

impl HermesInstance {
    fn request(&self, method: &str, params: Value, timeout: Option<Duration>) -> Result<Value> {
        let pending = self.begin_request(method, params)?;
        self.finish_request(pending, timeout)
    }

    fn begin_request(&self, method: &str, params: Value) -> Result<PendingHermesRequest> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, receiver) = bounded(1);
        self.pending
            .lock()
            .expect("hermes pending poisoned")
            .insert(id, tx);
        if let Err(error) = self.write_line(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        })) {
            self.pending
                .lock()
                .expect("hermes pending poisoned")
                .remove(&id);
            return Err(error);
        }
        Ok(PendingHermesRequest {
            id,
            method: method.to_string(),
            receiver,
        })
    }

    fn finish_request(
        &self,
        pending: PendingHermesRequest,
        timeout: Option<Duration>,
    ) -> Result<Value> {
        let response = match timeout {
            Some(timeout) => pending.receiver.recv_timeout(timeout).map_err(|error| {
                anyhow!(
                    "Hermes request {} timed out or failed: {error}",
                    pending.method
                )
            }),
            None => pending
                .receiver
                .recv()
                .map_err(|error| anyhow!("Hermes request {} failed: {error}", pending.method)),
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.pending
                    .lock()
                    .expect("hermes pending poisoned")
                    .remove(&pending.id);
                return Err(error);
            }
        };
        if let Some(error) = response.get("error") {
            bail!("Hermes request {} failed: {error}", pending.method);
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Waits for a `session/prompt` reply without a turn deadline — a coding turn may
    /// legitimately run for a long time — but resolves locally when the user asked to
    /// cancel and Hermes did not answer within [`PROMPT_CANCEL_GRACE`].
    fn finish_prompt_request(&self, pending: PendingHermesRequest) -> Result<Value> {
        self.finish_prompt_request_with(pending, PROMPT_CANCEL_GRACE, PROMPT_POLL_INTERVAL)
    }

    fn finish_prompt_request_with(
        &self,
        pending: PendingHermesRequest,
        cancel_grace: Duration,
        poll_interval: Duration,
    ) -> Result<Value> {
        let mut cancel_deadline: Option<Instant> = None;
        let response = loop {
            match pending.receiver.recv_timeout(poll_interval) {
                Ok(response) => break Ok(response),
                Err(RecvTimeoutError::Disconnected) => {
                    break Err(anyhow!("Hermes request {} failed", pending.method))
                }
                Err(RecvTimeoutError::Timeout) => {}
            }
            if !self.prompt_cancel_requested.load(Ordering::SeqCst) {
                cancel_deadline = None;
                continue;
            }
            let deadline = *cancel_deadline.get_or_insert_with(|| Instant::now() + cancel_grace);
            if Instant::now() >= deadline {
                break Err(anyhow!("HERMES_PROMPT_CANCELLED"));
            }
        };
        let response = match response {
            Ok(response) => response,
            Err(error) => {
                self.cancel_pending(pending.id);
                return Err(error);
            }
        };
        if let Some(error) = response.get("error") {
            bail!("Hermes request {} failed: {error}", pending.method);
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    fn cancel_pending(&self, id: u64) {
        self.pending
            .lock()
            .expect("hermes pending poisoned")
            .remove(&id);
    }

    fn fail_pending(&self, message: &str) {
        let drained: Vec<_> = self
            .pending
            .lock()
            .expect("hermes pending poisoned")
            .drain()
            .collect();
        for (_, tx) in drained {
            let _ = tx.send(json!({ "error": { "code": -32000, "message": message } }));
        }
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
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    command_override: Option<String>,
    workspace_folder: Option<String>,
) -> Result<HermesStartResult, String> {
    manager
        .start(session_id, command_override, workspace_folder)
        .map(|generation| HermesStartResult { generation })
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_new_session(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    generation: u64,
) -> Result<String, String> {
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || manager.new_session(&session_id, generation))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_resume_session(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    generation: u64,
    acp_session_id: String,
) -> Result<(), String> {
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || {
        manager.resume_session(&session_id, generation, acp_session_id)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_list_sessions(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    generation: u64,
) -> Result<Vec<HermesSessionInfo>, String> {
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || manager.list_sessions(&session_id, generation))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_send(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    generation: u64,
    text: String,
) -> Result<(), String> {
    manager
        .send_message(session_id, generation, text)
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_cancel(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    generation: u64,
) -> Result<(), String> {
    manager.cancel(&session_id, generation).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_respond_permission(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    generation: u64,
    request_id: u64,
    option_id: String,
) -> Result<(), String> {
    manager
        .respond_permission(&session_id, generation, request_id, option_id)
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_set_model(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    generation: u64,
    model_id: String,
) -> Result<(), String> {
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || {
        manager.set_model(&session_id, generation, model_id)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_set_mode(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
    generation: u64,
    mode_id: String,
) -> Result<(), String> {
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || manager.set_mode(&session_id, generation, mode_id))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_stop(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
) -> Result<(), String> {
    manager.stop(&session_id).map_err(to_string)
}

#[tauri::command]
pub async fn hermes_cli_command(command_override: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_hermes_command(command_override))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_auth_list(
    session_id: String,
    command_override: Option<String>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        hermes_auth_list_native(&session_id, command_override)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_runtime_status(
    command_override: Option<String>,
) -> Result<HermesRuntimeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || hermes_runtime_status_native(command_override))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hermes_workspace_state(
    session_id: String,
    workspace_folder: Option<String>,
) -> Result<HermesWorkspaceState, String> {
    tauri::async_runtime::spawn_blocking(move || {
        read_workspace_state_native(&session_id, workspace_folder.as_deref())
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

fn cleanup_agent_workspace_at(
    manager: &HermesManager,
    session_id: &str,
    path: &Path,
) -> Result<()> {
    manager.stop(session_id)?;
    if path.exists() {
        std::fs::remove_dir_all(path)
            .with_context(|| format!("delete VibeLink agent workspace {}", path.display()))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_workspace_cleanup(
    manager: State<'_, Arc<HermesManager>>,
    session_id: String,
) -> Result<(), String> {
    let manager = Arc::clone(&manager);
    tauri::async_runtime::spawn_blocking(move || -> Result<()> {
        let path = agent_workspace_dir(&session_id)?;
        cleanup_agent_workspace_at(&manager, &session_id, &path)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

fn spawn_stdout_reader(
    session_id: String,
    generation: u64,
    stdout: impl std::io::Read + Send + 'static,
    instance: Arc<HermesInstance>,
    manager: Arc<HermesManager>,
) {
    thread::Builder::new()
        .name(format!("vibelink-hermes-stdout-{session_id}"))
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) if line.trim().is_empty() => continue,
                    Ok(line) => match serde_json::from_str::<Value>(&line) {
                        Ok(value) => {
                            route_acp_message(&session_id, generation, &value, &instance, &manager)
                        }
                        Err(err) => warn!(?err, line, "invalid Hermes ACP JSON"),
                    },
                    Err(err) => {
                        let _ = manager.send_current_event(
                            &session_id,
                            generation,
                            HermesEventPayload::Error {
                                session_id: session_id.clone(),
                                message: format!("Hermes stdout stopped: {err}"),
                            },
                        );
                        break;
                    }
                }
            }
            instance.fail_pending("Hermes process exited");
            if manager
                .retire_instance_if_current(&session_id, generation, true)
                .unwrap_or(false)
            {
                manager.set_prompt_active(&session_id, generation, false);
            }
        })
        .expect("spawn hermes stdout reader");
}

fn spawn_stderr_drain(
    session_id: String,
    generation: u64,
    stderr: impl std::io::Read + Send + 'static,
    manager: Arc<HermesManager>,
) {
    thread::Builder::new()
        .name(format!("vibelink-hermes-stderr-{session_id}"))
        .spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if manager.is_current(&session_id, generation) {
                    debug!(session_id, generation, line, "Hermes stderr");
                }
            }
        })
        .expect("spawn hermes stderr drain");
}

fn vibelink_mcp_servers(session_id: &str, flavor: &str) -> Value {
    json!([{
        "name": "vibelink",
        "command": super::cli_path::dedicated_cli_path()
            .map(|path| path.to_string_lossy().to_string())
            .unwrap_or_else(|_| "vibelink.exe".to_string()),
        "args": ["mcp", "serve"],
        "env": [
            { "name": "VIBELINK_SESSION_ID", "value": session_id },
            { "name": "VIBELINK_APP_FLAVOR", "value": flavor },
        ],
    }])
}

fn load_last_acp_session(path: &Path) -> Result<Option<String>> {
    let report = load_with_recovery(
        path,
        LoadedLastAcpSession {
            acp_session_id: None,
            legacy: false,
        },
        parse_last_acp_session,
    )?;
    let loaded = report.value;
    if loaded.legacy {
        save_last_acp_session(
            path,
            loaded
                .acp_session_id
                .as_deref()
                .expect("legacy Hermes metadata always has a session id"),
        )?;
    }
    Ok(loaded.acp_session_id)
}

fn parse_last_acp_session(
    bytes: &[u8],
) -> std::result::Result<LoadedLastAcpSession, DocumentError> {
    let text =
        std::str::from_utf8(bytes).map_err(|error| DocumentError::Invalid(anyhow!(error)))?;
    let trimmed = text.trim();
    if trimmed.starts_with('{') || trimmed.starts_with('[') || trimmed.starts_with('"') {
        let document: LastAcpSessionDocument = parse_json(bytes)?;
        require_supported_schema(document.schema_version, LAST_ACP_SESSION_SCHEMA_VERSION)?;
        return Ok(LoadedLastAcpSession {
            acp_session_id: Some(require_acp_session_id(document.acp_session_id)?),
            legacy: false,
        });
    }
    Ok(LoadedLastAcpSession {
        acp_session_id: Some(require_acp_session_id(trimmed.to_string())?),
        legacy: true,
    })
}

fn require_acp_session_id(value: String) -> std::result::Result<String, DocumentError> {
    let value = value.trim().to_string();
    if value.is_empty() {
        return Err(DocumentError::Invalid(anyhow!(
            "Hermes session metadata contains an empty session id"
        )));
    }
    Ok(value)
}

fn save_last_acp_session(path: &Path, acp_session_id: &str) -> Result<()> {
    let acp_session_id = require_acp_session_id(acp_session_id.to_string())
        .map_err(|_| anyhow!("Hermes session id is empty"))?;
    write_json(
        path,
        &LastAcpSessionDocument {
            schema_version: LAST_ACP_SESSION_SCHEMA_VERSION,
            acp_session_id,
        },
    )
}

fn handshake(
    vibelink_session_id: &str,
    generation: u64,
    cwd: &str,
    home: &Path,
    configured_model: Option<&HermesConfiguredModel>,
    instance: &HermesInstance,
    manager: &HermesManager,
) -> Result<()> {
    let initialize = instance.request(
        "initialize",
        json!({
            "protocolVersion": 1,
            "clientCapabilities": {},
            "clientInfo": { "name": "VibeLink", "version": env!("CARGO_PKG_VERSION") },
        }),
        Some(REQUEST_TIMEOUT),
    )?;
    manager.instance(vibelink_session_id, generation)?;
    instance.sessions_list_supported.store(
        initialize
            .pointer("/agentCapabilities/sessionCapabilities/list")
            .is_some(),
        Ordering::Relaxed,
    );

    let session_file = home.join("last-acp-session");
    let saved_session = load_last_acp_session(&session_file)?;

    let (response, resumed_session) = if let Some(session_id) = saved_session.as_deref() {
        let _ = manager.send_current_event(
            vibelink_session_id,
            generation,
            HermesEventPayload::SessionReplay {
                session_id: vibelink_session_id.to_string(),
                acp_session_id: session_id.to_string(),
            },
        );
        let resume_result = instance.request(
            "session/resume",
            json!({
                "cwd": cwd,
                "sessionId": session_id,
                "mcpServers": vibelink_mcp_servers(vibelink_session_id, crate::daemon::paths::app_flavor()),
            }),
            Some(REQUEST_TIMEOUT),
        );
        match resume_result {
            Ok(value) => (value, Some(session_id.to_string())),
            Err(err) => {
                warn!(?err, "Hermes session resume failed; creating new session");
                (new_acp_session(vibelink_session_id, instance, cwd)?, None)
            }
        }
    } else {
        (new_acp_session(vibelink_session_id, instance, cwd)?, None)
    };

    finalize_acp_session(
        vibelink_session_id,
        generation,
        home,
        configured_model,
        instance,
        manager,
        &response,
        resumed_session.as_deref(),
    )
}

fn finalize_acp_session(
    vibelink_session_id: &str,
    generation: u64,
    home: &Path,
    configured_model: Option<&HermesConfiguredModel>,
    instance: &HermesInstance,
    manager: &HermesManager,
    response: &Value,
    resumed_session: Option<&str>,
) -> Result<()> {
    let acp_session_id = acp_session_id_from_response(response, resumed_session)?;
    {
        let instances = manager.instances.lock().expect("hermes instances poisoned");
        if instances
            .get(vibelink_session_id)
            .map(|entry| entry.generation)
            != Some(generation)
        {
            bail!("HERMES_SESSION_REPLACED");
        }
        save_last_acp_session(&home.join("last-acp-session"), &acp_session_id)?;
        *instance
            .acp_session_id
            .lock()
            .expect("hermes acp session poisoned") = Some(acp_session_id.clone());
    }

    if let Some(model) = configured_model.filter(|model| !model.provider.trim().is_empty()) {
        let model_id = acp_model_id_from_configured_model(model);
        if !model_id.is_empty() {
            instance.request(
                "session/set_model",
                json!({ "sessionId": acp_session_id, "modelId": model_id }),
                Some(REQUEST_TIMEOUT),
            )?;
        }
    }

    manager.instance(vibelink_session_id, generation)?;

    manager.send_current_event(
        vibelink_session_id,
        generation,
        HermesEventPayload::Started {
            session_id: vibelink_session_id.to_string(),
            acp_session_id: acp_session_id.clone(),
        },
    )?;
    let models = models_from_response(response);
    if !models.0.is_empty() || !models.1.is_empty() {
        manager.send_current_event(
            vibelink_session_id,
            generation,
            HermesEventPayload::Models {
                session_id: vibelink_session_id.to_string(),
                available: models.0,
                current: models.1,
            },
        )?;
    }
    Ok(())
}

fn new_acp_session(
    vibelink_session_id: &str,
    instance: &HermesInstance,
    cwd: &str,
) -> Result<Value> {
    instance.request(
        "session/new",
        json!({
            "cwd": cwd,
            "mcpServers": vibelink_mcp_servers(vibelink_session_id, crate::daemon::paths::app_flavor()),
        }),
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
        .split_once(['/', ':'])
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

fn require_qualified_model(model_id: &str) -> Result<()> {
    if !model_id.contains(':') && !model_id.contains('/') {
        bail!("model id must be provider-qualified (provider:model), got bare {model_id}");
    }
    Ok(())
}

fn route_acp_message(
    vibelink_session_id: &str,
    generation: u64,
    value: &Value,
    instance: &HermesInstance,
    manager: &HermesManager,
) {
    if !manager.is_current(vibelink_session_id, generation) {
        return;
    }
    if value.get("id").is_some() && (value.get("result").is_some() || value.get("error").is_some())
    {
        if let Some(id) = value.get("id").and_then(Value::as_u64) {
            if let Some(sender) = instance
                .pending
                .lock()
                .expect("hermes pending poisoned")
                .remove(&id)
            {
                let _ = sender.try_send(value.clone());
            }
        }
        return;
    }

    if value.get("method").and_then(Value::as_str) == Some("session/update") {
        if let Some(event) = translate_update(vibelink_session_id, value) {
            let _ = manager.send_current_event(vibelink_session_id, generation, event);
        }
        return;
    }

    if value.get("method").and_then(Value::as_str) == Some("session/request_permission") {
        if let Some(event) = translate_permission(vibelink_session_id, value) {
            let _ = manager.send_current_event(vibelink_session_id, generation, event);
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

pub fn translate_update(vibelink_session_id: &str, value: &Value) -> Option<HermesEventPayload> {
    let update = value.get("params")?.get("update")?;
    let kind = update.get("sessionUpdate")?.as_str()?;
    match kind {
        "user_message_chunk" => Some(HermesEventPayload::UserMessage {
            session_id: vibelink_session_id.to_string(),
            text: update_text(update),
        }),
        "agent_message_chunk" => Some(HermesEventPayload::Message {
            session_id: vibelink_session_id.to_string(),
            text: update_text(update),
        }),
        "agent_thought_chunk" => Some(HermesEventPayload::Thought {
            session_id: vibelink_session_id.to_string(),
            text: update_text(update),
        }),
        "tool_call" => Some(HermesEventPayload::ToolCall {
            session_id: vibelink_session_id.to_string(),
            tool_call_id: read_string(update, &["toolCallId", "id"]),
            title: read_string(update, &["title", "name"]),
            tool_kind: read_string(update, &["kind", "toolKind"]),
            status: read_string(update, &["status"]),
        }),
        "tool_call_update" => Some(HermesEventPayload::ToolUpdate {
            session_id: vibelink_session_id.to_string(),
            tool_call_id: read_string(update, &["toolCallId", "id"]),
            status: read_string(update, &["status"]),
            content: update_text(update),
        }),
        "plan" => Some(HermesEventPayload::Plan {
            session_id: vibelink_session_id.to_string(),
            entries: plan_entries(update),
        }),
        "usage_update" => Some(HermesEventPayload::Usage {
            session_id: vibelink_session_id.to_string(),
            size: read_u64(update, &["size", "contextWindow"]),
            used: read_u64(update, &["used", "tokens"]),
        }),
        _ => None,
    }
}

fn translate_permission(vibelink_session_id: &str, value: &Value) -> Option<HermesEventPayload> {
    let params = value.get("params")?;
    let tool_call = params.get("toolCall")?;
    Some(HermesEventPayload::Permission {
        session_id: vibelink_session_id.to_string(),
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
        diff_path: tool_call
            .pointer("/content/path")
            .and_then(Value::as_str)
            .map(str::to_string),
        old_text: tool_call
            .pointer("/content/oldText")
            .and_then(Value::as_str)
            .map(str::to_string),
        new_text: tool_call
            .pointer("/content/newText")
            .and_then(Value::as_str)
            .map(str::to_string),
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
    let current = read_string(
        value,
        &[
            "model",
            "currentModel",
            "currentModelId",
            "current_model_id",
        ],
    );
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
                        return Some(HermesModelInfo {
                            id: id.to_string(),
                            name: id.to_string(),
                        });
                    }
                    let id = read_string(model, &["id", "modelId", "model_id"]);
                    if id.is_empty() {
                        return None;
                    }
                    Some(HermesModelInfo {
                        name: read_string(model, &["name", "displayName", "display_name"])
                            .if_empty_then(id.clone()),
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
        if self.is_empty() {
            fallback
        } else {
            self
        }
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

const HERMES_NOT_INSTALLED: &str = "Hermes Agent is not installed. Install it from https://hermes-agent.nousresearch.com/ and re-check.";

fn agent_workspace_dir(session_id: &str) -> Result<PathBuf> {
    let safe_session_id = sanitize_session_id(session_id);
    if safe_session_id.is_empty() {
        bail!("Hermes session id contains no filesystem-safe characters");
    }
    Ok(crate::daemon::paths::daemon_paths()?
        .data_dir
        .join("agent")
        .join(safe_session_id))
}

fn hermes_global_home() -> PathBuf {
    if let Some(home) = std::env::var("HERMES_HOME").ok().and_then(non_empty) {
        return PathBuf::from(home);
    }
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var("LOCALAPPDATA").ok().and_then(non_empty) {
            return PathBuf::from(local_app_data).join("hermes");
        }
        if let Some(user_profile) = std::env::var("USERPROFILE").ok().and_then(non_empty) {
            return PathBuf::from(user_profile)
                .join("AppData")
                .join("Local")
                .join("hermes");
        }
    }
    #[cfg(not(windows))]
    if let Some(home) = std::env::var("HOME").ok().and_then(non_empty) {
        return PathBuf::from(home).join(".hermes");
    }
    PathBuf::from(".hermes")
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
    match doc.get(serde_yaml::Value::from("model"))? {
        serde_yaml::Value::Mapping(model) => {
            let provider = model
                .get(serde_yaml::Value::from("provider"))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .unwrap_or_default();
            let id = model
                .get(serde_yaml::Value::from("default"))
                .or_else(|| model.get(serde_yaml::Value::from("model")))
                .and_then(serde_yaml::Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())?;
            let base_url = model
                .get(serde_yaml::Value::from("base_url"))
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
        serde_yaml::Value::String(model) => {
            non_empty(model.clone()).map(|model| HermesConfiguredModel {
                provider: String::new(),
                model,
                base_url: None,
            })
        }
        _ => None,
    }
}

fn read_global_configured_model() -> Result<Option<HermesConfiguredModel>> {
    let doc = read_workspace_config_doc(&hermes_global_home().join("config.yaml"))?;
    Ok(read_workspace_model(&doc))
}

fn read_workspace_state_native(
    session_id: &str,
    workspace_folder: Option<&str>,
) -> Result<HermesWorkspaceState> {
    let home = hermes_global_home();
    let anchor = agent_workspace_dir(session_id)?;
    let cwd = resolve_workspace_cwd(workspace_folder, &anchor)?;
    Ok(HermesWorkspaceState {
        home: home.to_string_lossy().to_string(),
        workspace_folder: cwd.to_string_lossy().to_string(),
        model: read_global_configured_model()?,
    })
}

fn read_workspace_config_doc(config_path: &Path) -> Result<serde_yaml::Mapping> {
    if !config_path.exists() {
        return Ok(serde_yaml::Mapping::new());
    }
    let text = std::fs::read_to_string(config_path).context("read config.yaml")?;
    let value: serde_yaml::Value =
        serde_yaml::from_str(&text).with_context(|| format!("parse {}", config_path.display()))?;
    value
        .as_mapping()
        .cloned()
        .ok_or_else(|| anyhow!("config.yaml top-level is not a mapping"))
}

fn installer_acp_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    #[cfg(windows)]
    {
        if let Some(local_app_data) = std::env::var("LOCALAPPDATA").ok().and_then(non_empty) {
            candidates.push(
                PathBuf::from(local_app_data)
                    .join("hermes/hermes-agent/venv/Scripts/hermes-acp.exe"),
            );
        }
        if let Some(user_profile) = std::env::var("USERPROFILE").ok().and_then(non_empty) {
            candidates.push(
                PathBuf::from(user_profile)
                    .join(".hermes/hermes-agent/venv/Scripts/hermes-acp.exe"),
            );
        }
    }
    candidates
}

fn resolve_command_with_source(command_override: Option<String>) -> Result<(String, &'static str)> {
    if let Some(command) = command_override.and_then(non_empty) {
        if let Some(resolved) = crate::daemon::pty::resolve_program(&command) {
            return Ok((resolved, "override"));
        }
        bail!(HERMES_NOT_INSTALLED);
    }
    if let Some(command) = crate::daemon::pty::resolve_program(HERMES_ACP_BIN) {
        return Ok((command, "path"));
    }
    if let Some(command) = installer_acp_candidates()
        .into_iter()
        .find(|path| path.is_file())
    {
        return Ok((command.to_string_lossy().to_string(), "installer"));
    }
    bail!(HERMES_NOT_INSTALLED)
}

pub fn resolve_command(command_override: Option<String>) -> Result<String> {
    resolve_command_with_source(command_override).map(|(command, _)| command)
}

fn resolve_hermes_command(command_override: Option<String>) -> Result<String> {
    if let Some(command) = command_override.clone().and_then(non_empty) {
        if !command.ends_with("hermes-acp") && !command.ends_with("hermes-acp.exe") {
            return crate::daemon::pty::resolve_program(&command)
                .ok_or_else(|| anyhow!(HERMES_NOT_INSTALLED));
        }
    }
    let acp = PathBuf::from(resolve_command(command_override)?);
    let sibling = acp.with_file_name(HERMES_BIN);
    if sibling.is_file() {
        return Ok(sibling.to_string_lossy().to_string());
    }
    crate::daemon::pty::resolve_program(HERMES_BIN).ok_or_else(|| anyhow!(HERMES_NOT_INSTALLED))
}

fn hermes_auth_list_native(_session_id: &str, command_override: Option<String>) -> Result<String> {
    let command_path = resolve_hermes_command(command_override)?;
    let mut command = Command::new(command_path);
    command.arg("auth").arg("list");
    apply_no_window(&mut command);
    let output = command.output().context("run hermes auth list")?;
    if !output.status.success() {
        return Err(anyhow!(stderr_or_status(&output, "hermes auth list")));
    }
    Ok(stdout_or_stderr(&output))
}

fn hermes_runtime_status_native(command_override: Option<String>) -> Result<HermesRuntimeStatus> {
    let home = hermes_global_home();
    let configured_model = read_global_configured_model().ok().flatten();
    let Ok((command, source)) = resolve_command_with_source(command_override) else {
        return Ok(HermesRuntimeStatus {
            detected: false,
            command: None,
            cli_command: None,
            version: None,
            home: Some(home.to_string_lossy().to_string()),
            source: None,
            configured_model,
        });
    };
    let cli_command = resolve_hermes_command(Some(command.clone())).ok();
    let mut probe = Command::new(&command);
    probe.arg("--version");
    apply_no_window(&mut probe);
    let version = probe
        .output()
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| non_empty(stdout_or_stderr(&output)));
    Ok(HermesRuntimeStatus {
        detected: version.is_some(),
        command: Some(command),
        cli_command,
        version,
        home: Some(home.to_string_lossy().to_string()),
        source: Some(source.to_string()),
        configured_model,
    })
}

fn sanitize_session_id(session_id: &str) -> String {
    session_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .collect::<String>()
}

fn non_empty(value: String) -> Option<String> {
    let trimmed = value.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn non_empty_str(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
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
    fn test_instance() -> HermesInstance {
        #[cfg(windows)]
        let mut child = Command::new("cmd")
            .args(["/D", "/Q", "/C", "more"])
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test child");
        #[cfg(not(windows))]
        let mut child = Command::new("cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn test child");
        let stdin = child.stdin.take().expect("test child stdin");
        HermesInstance {
            child: Mutex::new(child),
            stdin: Mutex::new(stdin),
            next_id: AtomicU64::new(1),
            pending: Mutex::new(HashMap::new()),
            acp_session_id: Mutex::new(None),
            sessions_list_supported: AtomicBool::new(false),
            prompt_cancel_requested: AtomicBool::new(false),
            cwd: String::new(),
        }
    }

    #[test]
    fn fail_pending_sends_error_to_waiters() {
        let instance = test_instance();
        let (tx, rx) = bounded(1);
        instance
            .pending
            .lock()
            .expect("pending mutex")
            .insert(7, tx);

        instance.fail_pending("Hermes stopped");

        let response = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("pending error");
        assert_eq!(response["error"]["code"], -32000);
        assert_eq!(response["error"]["message"], "Hermes stopped");
        assert!(instance.pending.lock().expect("pending mutex").is_empty());
        let mut child = instance.child.lock().expect("child mutex");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn prompt_wait_resolves_locally_when_cancel_is_not_answered() {
        let instance = test_instance();
        let (tx, receiver) = bounded(1);
        instance
            .pending
            .lock()
            .expect("pending mutex")
            .insert(9, tx);
        instance
            .prompt_cancel_requested
            .store(true, Ordering::SeqCst);

        let error = instance
            .finish_prompt_request_with(
                PendingHermesRequest {
                    id: 9,
                    method: "session/prompt".to_string(),
                    receiver,
                },
                Duration::from_millis(30),
                Duration::from_millis(5),
            )
            .expect_err("cancelled prompt resolves");

        assert!(error.to_string().contains("HERMES_PROMPT_CANCELLED"));
        assert!(instance.pending.lock().expect("pending mutex").is_empty());
        let mut child = instance.child.lock().expect("child mutex");
        let _ = child.kill();
        let _ = child.wait();
    }

    #[test]
    fn prompt_wait_has_no_turn_deadline_without_a_cancel() {
        let instance = test_instance();
        let (tx, receiver) = bounded(1);
        instance
            .pending
            .lock()
            .expect("pending mutex")
            .insert(11, tx.clone());
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(80));
            let _ = tx.send(json!({ "result": { "stopReason": "end_turn" } }));
        });

        let value = instance
            .finish_prompt_request_with(
                PendingHermesRequest {
                    id: 11,
                    method: "session/prompt".to_string(),
                    receiver,
                },
                Duration::from_millis(10),
                Duration::from_millis(5),
            )
            .expect("long turn still completes");

        assert_eq!(value["stopReason"], "end_turn");
        let mut child = instance.child.lock().expect("child mutex");
        let _ = child.kill();
        let _ = child.wait();
    }

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

        let event = translate_update("vibelink-session", &value).expect("event");
        match event {
            HermesEventPayload::Message { session_id, text } => {
                assert_eq!(session_id, "vibelink-session");
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

        let event = translate_update("vibelink-session", &value).expect("event");
        match event {
            HermesEventPayload::ToolCall {
                session_id,
                tool_call_id,
                title,
                tool_kind,
                status,
            } => {
                assert_eq!(session_id, "vibelink-session");
                assert_eq!(tool_call_id, "tool-1");
                assert_eq!(title, "List panes");
                assert_eq!(tool_kind, "mcp");
                assert_eq!(status, "pending");
            }
            other => panic!("unexpected event: {other:?}"),
        }
    }

    #[test]
    fn hermes_events_serialize_frontend_field_names() {
        let value = serde_json::to_value(HermesEvent {
            generation: 7,
            payload: HermesEventPayload::Started {
                session_id: "vibelink-session".to_string(),
                acp_session_id: "acp-session".to_string(),
            },
        })
        .expect("serialize event");

        assert_eq!(value["kind"], "started");
        assert_eq!(value["generation"], 7);
        assert_eq!(value["sessionId"], "vibelink-session");
        assert_eq!(value["acpSessionId"], "acp-session");
        assert!(value.get("session_id").is_none());
    }

    #[test]
    fn hermes_manager_tracks_active_prompts_for_cancel_guard() {
        let manager = HermesManager::new();

        assert!(!manager.is_prompt_active("session-1", 4));
        manager.set_prompt_active("session-1", 4, true);
        assert!(manager.is_prompt_active("session-1", 4));
        assert!(!manager.is_prompt_active("session-1", 5));
        manager.set_prompt_active("session-1", 5, false);
        assert!(manager.is_prompt_active("session-1", 4));
        manager.set_prompt_active("session-1", 4, false);
        assert!(!manager.is_prompt_active("session-1", 4));
    }

    #[test]
    fn stop_generation_waits_and_removes_exact_child() {
        let manager = HermesManager::new();
        let instance = Arc::new(test_instance());
        manager.instances.lock().expect("instances mutex").insert(
            "session-1".to_string(),
            HermesInstanceEntry {
                generation: 4,
                instance: Arc::clone(&instance),
            },
        );

        manager
            .stop_generation("session-1", 4, false)
            .expect("stop generation");

        assert_eq!(manager.current_generation("session-1"), None);
        assert!(instance
            .child
            .lock()
            .expect("child mutex")
            .try_wait()
            .expect("child status")
            .is_some());
    }

    #[test]
    fn workspace_cleanup_stops_child_before_removing_owned_files() {
        let manager = HermesManager::new();
        let instance = Arc::new(test_instance());
        manager.instances.lock().expect("instances mutex").insert(
            "session-cleanup".to_string(),
            HermesInstanceEntry {
                generation: 8,
                instance: Arc::clone(&instance),
            },
        );
        let path =
            std::env::temp_dir().join(format!("vibelink-hermes-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).expect("create Agent workspace");
        std::fs::write(path.join("metadata.json"), b"owned").expect("write Agent metadata");

        cleanup_agent_workspace_at(&manager, "session-cleanup", &path)
            .expect("cleanup Agent workspace");

        assert_eq!(manager.current_generation("session-cleanup"), None);
        assert!(!path.exists());
        assert!(instance
            .child
            .lock()
            .expect("child mutex")
            .try_wait()
            .expect("child status")
            .is_some());
    }

    #[test]
    fn stale_generation_cannot_remove_or_complete_current_instance() {
        let manager = HermesManager::new();
        let stale = Arc::new(test_instance());
        let current = Arc::new(test_instance());
        manager.instances.lock().expect("instances mutex").insert(
            "session-1".to_string(),
            HermesInstanceEntry {
                generation: 2,
                instance: Arc::clone(&current),
            },
        );
        let (sender, _receiver) = bounded(1);
        stale
            .pending
            .lock()
            .expect("pending mutex")
            .insert(9, sender);

        route_acp_message(
            "session-1",
            1,
            &json!({ "jsonrpc": "2.0", "id": 9, "result": {} }),
            &stale,
            &manager,
        );

        assert!(stale
            .pending
            .lock()
            .expect("pending mutex")
            .contains_key(&9));
        assert!(!manager.remove_instance_if_current("session-1", 1));
        assert_eq!(manager.current_generation("session-1"), Some(2));
        let error = manager
            .instance("session-1", 1)
            .err()
            .expect("stale generation error");
        assert_eq!(error.to_string(), "HERMES_SESSION_REPLACED");

        for instance in [stale, current] {
            let mut child = instance.child.lock().expect("child mutex");
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    #[test]
    fn acp_session_id_uses_saved_id_for_resume_ack() {
        let session_id =
            acp_session_id_from_response(&json!({}), Some("saved-session")).expect("resume id");

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

    fn hermes_metadata_path(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "vibelink-hermes-metadata-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create Hermes metadata test directory");
        root.join("last-acp-session")
    }

    fn hermes_metadata_backup_path(path: &Path) -> PathBuf {
        path.with_file_name(format!(
            "{}.bak",
            path.file_name().unwrap().to_string_lossy()
        ))
    }

    fn cleanup_hermes_metadata(path: &Path) {
        if let Some(root) = path.parent() {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn hermes_legacy_session_metadata_migrates_to_schema_v1() {
        let path = hermes_metadata_path("legacy");
        std::fs::write(&path, " legacy-session\n").unwrap();

        let loaded = load_last_acp_session(&path).expect("load legacy Hermes metadata");
        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();

        assert_eq!(loaded.as_deref(), Some("legacy-session"));
        assert_eq!(document["schemaVersion"], LAST_ACP_SESSION_SCHEMA_VERSION);
        assert_eq!(document["acpSessionId"], "legacy-session");
        cleanup_hermes_metadata(&path);
    }

    #[test]
    fn hermes_corrupt_primary_recovers_valid_backup() {
        let path = hermes_metadata_path("backup");
        save_last_acp_session(&path, "first-session").unwrap();
        save_last_acp_session(&path, "second-session").unwrap();
        std::fs::write(&path, b"{").unwrap();

        let loaded = load_last_acp_session(&path).expect("recover Hermes metadata backup");

        assert_eq!(loaded.as_deref(), Some("first-session"));
        assert_eq!(
            parse_last_acp_session(&std::fs::read(&path).unwrap())
                .unwrap()
                .acp_session_id
                .as_deref(),
            Some("first-session")
        );
        cleanup_hermes_metadata(&path);
    }

    #[test]
    fn hermes_corrupt_primary_and_backup_return_safe_default() {
        let path = hermes_metadata_path("default");
        std::fs::write(&path, b"{").unwrap();
        std::fs::write(hermes_metadata_backup_path(&path), b"[").unwrap();

        let loaded = load_last_acp_session(&path).expect("default corrupt Hermes metadata");

        assert!(loaded.is_none());
        assert!(!path.exists());
        assert!(!hermes_metadata_backup_path(&path).exists());
        assert_eq!(
            std::fs::read_dir(path.parent().unwrap())
                .unwrap()
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
                .count(),
            2
        );
        cleanup_hermes_metadata(&path);
    }

    #[test]
    fn hermes_newer_metadata_schema_errors_without_overwrite() {
        let path = hermes_metadata_path("newer");
        let future = br#"{"schemaVersion":2,"acpSessionId":"future-session"}"#;
        std::fs::write(&path, future).unwrap();

        let error = load_last_acp_session(&path).expect_err("future Hermes schema should fail");

        assert!(error.to_string().contains("unsupported storage schema 2"));
        assert!(!path.exists());
        let quarantined = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .expect("future Hermes metadata quarantine");
        assert_eq!(std::fs::read(quarantined.path()).unwrap(), future);
        cleanup_hermes_metadata(&path);
    }

    #[test]
    fn hermes_session_metadata_persists_normally() {
        let path = hermes_metadata_path("roundtrip");

        save_last_acp_session(&path, "current-session").expect("save Hermes metadata");
        let loaded = load_last_acp_session(&path).expect("load Hermes metadata");

        assert_eq!(loaded.as_deref(), Some("current-session"));
        let document: LastAcpSessionDocument =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(document.schema_version, LAST_ACP_SESSION_SCHEMA_VERSION);
        assert_eq!(document.acp_session_id, "current-session");
        cleanup_hermes_metadata(&path);
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

        assert_eq!(
            acp_model_id_from_configured_model(&anthropic),
            "anthropic:claude-sonnet-4-6"
        );
        assert_eq!(
            acp_model_id_from_configured_model(&openrouter),
            "openrouter:anthropic/claude-sonnet-4.6"
        );
        assert_eq!(
            acp_model_id_from_configured_model(&codex),
            "openai-codex:gpt-5.5"
        );
        assert_eq!(acp_model_id_from_configured_model(&no_provider), "gpt-5.5");
    }

    #[test]
    fn require_qualified_model_rejects_bare_id() {
        assert!(require_qualified_model("gpt-5.5").is_err());
        assert!(require_qualified_model("openai-codex:gpt-5.5").is_ok());
        assert!(require_qualified_model("openrouter:anthropic/claude-sonnet-4.6").is_ok());
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
    fn read_workspace_config_doc_rejects_corrupted_yaml() {
        let path = std::env::temp_dir().join(format!(
            "hermes-corrupt-config-{}.yaml",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, "model: [").expect("write corrupt config");

        let err = read_workspace_config_doc(&path).expect_err("corrupt yaml should fail");

        assert!(err.to_string().contains("parse"));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "model: [");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn read_workspace_config_doc_rejects_non_mapping() {
        let path =
            std::env::temp_dir().join(format!("hermes-list-config-{}.yaml", uuid::Uuid::new_v4()));
        std::fs::write(&path, "[]").expect("write list config");

        let err = read_workspace_config_doc(&path).expect_err("list yaml should fail");

        assert!(err.to_string().contains("top-level is not a mapping"));
        let _ = std::fs::remove_file(&path);
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
        let missing =
            std::env::temp_dir().join(format!("hermes-missing-workspace-{}", uuid::Uuid::new_v4()));

        let error = resolve_workspace_cwd(Some(missing.to_string_lossy().as_ref()), &home)
            .expect_err("missing workspace should be rejected")
            .to_string();

        assert!(error.contains("Hermes workspace folder is not accessible"));
        assert!(error.contains(&home.to_string_lossy().to_string()));
    }
    #[test]
    fn prompt_context_includes_workspace_brief() {
        let brief = crate::app::board::Brief {
            purpose: "Ship onboarding".to_string(),
            notes: "Keep the board native-owned".to_string(),
            updated_at: chrono::Utc::now().to_rfc3339(),
        };
        let prompt =
            HermesManager::augment_prompt_with_brief("User prompt".to_string(), Some(&brief));
        assert!(prompt.contains("## Workspace brief"));
        assert!(prompt.contains("Purpose: Ship onboarding"));
        assert!(prompt.contains("Notes: Keep the board native-owned"));
    }
}

use crate::orchestration::{
    adapters::{
        AdapterDetection, AdapterError, AdapterRuntime, AgentCollectedResult, AgentRuntimeHandle,
        AgentRuntimeStatus, AgentStartRequest, HermesAcpRuntime, PermissionResponse, PtyCliRuntime,
        ReconcileRequest,
    },
    AgentLifecycleStatus,
};
use serde_json::json;
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    thread,
};

const MAX_CAPTURE_BYTES: usize = 256 * 1024;

struct ProcessInstance {
    child: Child,
    stdin: ChildStdin,
    output: Arc<Mutex<Vec<u8>>>,
    runtime_identity: String,
    generation: u64,
    cancelled: bool,
}

pub struct PtyProcessRuntime {
    instances: Mutex<HashMap<String, ProcessInstance>>,
    next_generation: AtomicU64,
}

impl PtyProcessRuntime {
    pub fn new() -> Self {
        Self {
            instances: Mutex::new(HashMap::new()),
            next_generation: AtomicU64::new(1),
        }
    }

    fn with_instance<T>(
        &self,
        instance_id: &str,
        operation: impl FnOnce(&mut ProcessInstance) -> Result<T, AdapterError>,
    ) -> Result<T, AdapterError> {
        let mut instances = self
            .instances
            .lock()
            .map_err(|_| AdapterError::Runtime("PTY runtime mutex poisoned".to_string()))?;
        let instance = instances
            .get_mut(instance_id)
            .ok_or_else(|| AdapterError::NotFound(instance_id.to_string()))?;
        operation(instance)
    }
}

impl Default for PtyProcessRuntime {
    fn default() -> Self {
        Self::new()
    }
}

impl AdapterRuntime for PtyProcessRuntime {
    fn detect(&self) -> Result<AdapterDetection, AdapterError> {
        Ok(AdapterDetection {
            available: true,
            version: None,
            detail: Some("daemon subprocess runtime".to_string()),
        })
    }

    fn start(&self, request: &AgentStartRequest) -> Result<AgentRuntimeHandle, AdapterError> {
        let executable = request
            .profile
            .as_deref()
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                AdapterError::Runtime("PTY CLI profile must name an executable".to_string())
            })?;
        let mut command = Command::new(executable);
        command
            .current_dir(
                request
                    .worktree_path
                    .as_deref()
                    .unwrap_or(&request.workspace_path),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .envs(&request.environment);
        let mut child = command
            .spawn()
            .map_err(|error| AdapterError::Runtime(format!("start {executable}: {error}")))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AdapterError::Runtime("agent stdin unavailable".to_string()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AdapterError::Runtime("agent stdout unavailable".to_string()))?;
        let stderr = child.stderr.take();
        let output = Arc::new(Mutex::new(Vec::new()));
        capture_stream(stdout, Arc::clone(&output));
        if let Some(stderr) = stderr {
            capture_stream(stderr, Arc::clone(&output));
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed);
        let runtime_identity = format!("process:{}", child.id());
        let handle = AgentRuntimeHandle {
            runtime_identity: runtime_identity.clone(),
            generation,
            pane_id: None,
            resumable: false,
        };
        self.instances
            .lock()
            .map_err(|_| AdapterError::Runtime("PTY runtime mutex poisoned".to_string()))?
            .insert(
                request.instance_id.clone(),
                ProcessInstance {
                    child,
                    stdin,
                    output,
                    runtime_identity,
                    generation,
                    cancelled: false,
                },
            );
        Ok(handle)
    }

    fn send(&self, instance_id: &str, message: &str) -> Result<(), AdapterError> {
        self.with_instance(instance_id, |instance| {
            instance
                .stdin
                .write_all(message.as_bytes())
                .and_then(|_| instance.stdin.write_all(b"\n"))
                .and_then(|_| instance.stdin.flush())
                .map_err(|error| AdapterError::Runtime(format!("send agent input: {error}")))
        })
    }

    fn cancel(&self, instance_id: &str) -> Result<(), AdapterError> {
        self.with_instance(instance_id, |instance| {
            instance.cancelled = true;
            instance
                .child
                .kill()
                .map_err(|error| AdapterError::Runtime(format!("cancel agent: {error}")))
        })
    }

    fn status(&self, instance_id: &str) -> Result<AgentRuntimeStatus, AdapterError> {
        self.with_instance(instance_id, |instance| {
            let state = match instance
                .child
                .try_wait()
                .map_err(|error| AdapterError::Runtime(format!("inspect agent: {error}")))?
            {
                None => AgentLifecycleStatus::Running,
                Some(_) if instance.cancelled => AgentLifecycleStatus::Cancelled,
                Some(status) if status.success() => AgentLifecycleStatus::Completed,
                Some(_) => AgentLifecycleStatus::Failed,
            };
            Ok(AgentRuntimeStatus {
                state,
                runtime_identity: Some(instance.runtime_identity.clone()),
                generation: instance.generation,
                detail: None,
            })
        })
    }

    fn respond_permission(
        &self,
        instance_id: &str,
        response: &PermissionResponse,
    ) -> Result<(), AdapterError> {
        self.send(
            instance_id,
            &serde_json::to_string(response)
                .map_err(|error| AdapterError::Runtime(error.to_string()))?,
        )
    }

    fn collect_result(&self, instance_id: &str) -> Result<AgentCollectedResult, AdapterError> {
        self.with_instance(instance_id, |instance| {
            let bytes = instance
                .output
                .lock()
                .map_err(|_| AdapterError::Runtime("agent output mutex poisoned".to_string()))?
                .clone();
            let summary = String::from_utf8_lossy(&bytes).to_string();
            Ok(AgentCollectedResult {
                summary,
                files: Vec::new(),
                tests: Vec::new(),
                commit: None,
                checkpoint: None,
                metadata: json!({
                    "runtimeIdentity": instance.runtime_identity,
                    "generation": instance.generation,
                }),
            })
        })
    }

    fn stop(&self, instance_id: &str) -> Result<(), AdapterError> {
        self.with_instance(instance_id, |instance| {
            if instance
                .child
                .try_wait()
                .map_err(|error| AdapterError::Runtime(error.to_string()))?
                .is_none()
            {
                instance
                    .child
                    .kill()
                    .map_err(|error| AdapterError::Runtime(error.to_string()))?;
            }
            let _ = instance.child.wait();
            Ok(())
        })
    }

    fn reconcile(
        &self,
        instance_id: &str,
        request: &ReconcileRequest,
    ) -> Result<AgentRuntimeStatus, AdapterError> {
        let status = self.status(instance_id)?;
        if request.expected_generation != status.generation
            || request.expected_runtime_identity.as_deref() != status.runtime_identity.as_deref()
        {
            return Err(AdapterError::Runtime(
                "PTY process identity changed during reconciliation".to_string(),
            ));
        }
        Ok(status)
    }
}

impl PtyCliRuntime for PtyProcessRuntime {}

pub trait HermesAcpOwner: Send + Sync + 'static {
    fn detect(&self) -> Result<AdapterDetection, AdapterError>;
    fn start(&self, request: &AgentStartRequest) -> Result<AgentRuntimeHandle, AdapterError>;
    fn send(&self, instance_id: &str, message: &str) -> Result<(), AdapterError>;
    fn cancel(&self, instance_id: &str) -> Result<(), AdapterError>;
    fn status(&self, instance_id: &str) -> Result<AgentRuntimeStatus, AdapterError>;
    fn respond_permission(
        &self,
        instance_id: &str,
        response: &PermissionResponse,
    ) -> Result<(), AdapterError>;
    fn collect_result(&self, instance_id: &str) -> Result<AgentCollectedResult, AdapterError>;
    fn stop(&self, instance_id: &str) -> Result<(), AdapterError>;
    fn reconcile(
        &self,
        instance_id: &str,
        request: &ReconcileRequest,
    ) -> Result<AgentRuntimeStatus, AdapterError>;
}

pub struct HermesOwnedRuntime<O: HermesAcpOwner> {
    owner: Arc<O>,
}

impl<O: HermesAcpOwner> HermesOwnedRuntime<O> {
    pub fn new(owner: Arc<O>) -> Self {
        Self { owner }
    }
}

impl<O: HermesAcpOwner> AdapterRuntime for HermesOwnedRuntime<O> {
    fn detect(&self) -> Result<AdapterDetection, AdapterError> {
        self.owner.detect()
    }
    fn start(&self, request: &AgentStartRequest) -> Result<AgentRuntimeHandle, AdapterError> {
        self.owner.start(request)
    }
    fn send(&self, instance_id: &str, message: &str) -> Result<(), AdapterError> {
        self.owner.send(instance_id, message)
    }
    fn cancel(&self, instance_id: &str) -> Result<(), AdapterError> {
        self.owner.cancel(instance_id)
    }
    fn status(&self, instance_id: &str) -> Result<AgentRuntimeStatus, AdapterError> {
        self.owner.status(instance_id)
    }
    fn respond_permission(
        &self,
        instance_id: &str,
        response: &PermissionResponse,
    ) -> Result<(), AdapterError> {
        self.owner.respond_permission(instance_id, response)
    }
    fn collect_result(&self, instance_id: &str) -> Result<AgentCollectedResult, AdapterError> {
        self.owner.collect_result(instance_id)
    }
    fn stop(&self, instance_id: &str) -> Result<(), AdapterError> {
        self.owner.stop(instance_id)
    }
    fn reconcile(
        &self,
        instance_id: &str,
        request: &ReconcileRequest,
    ) -> Result<AgentRuntimeStatus, AdapterError> {
        self.owner.reconcile(instance_id, request)
    }
}

impl<O: HermesAcpOwner> HermesAcpRuntime for HermesOwnedRuntime<O> {}

fn capture_stream(stream: impl std::io::Read + Send + 'static, output: Arc<Mutex<Vec<u8>>>) {
    let _ = thread::Builder::new()
        .name("vibelink-agent-output".to_string())
        .spawn(move || {
            let mut reader = BufReader::new(stream);
            let mut line = Vec::new();
            loop {
                line.clear();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if let Ok(mut bytes) = output.lock() {
                            bytes.extend_from_slice(&line);
                            if bytes.len() > MAX_CAPTURE_BYTES {
                                let excess = bytes.len() - MAX_CAPTURE_BYTES;
                                bytes.drain(..excess);
                            }
                        }
                    }
                }
            }
        });
}

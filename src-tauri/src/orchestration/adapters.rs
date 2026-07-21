use super::AgentLifecycleStatus;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use thiserror::Error;
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentProvider {
    HermesAcp,
    PtyCli,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterDetection {
    pub available: bool,
    pub version: Option<String>,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStartRequest {
    pub instance_id: String,
    pub run_id: String,
    pub task_id: String,
    pub dispatch_id: String,
    pub session_id: String,
    pub workspace_path: String,
    pub worktree_path: Option<String>,
    pub profile: Option<String>,
    pub environment: HashMap<String, String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeHandle {
    pub runtime_identity: String,
    pub generation: u64,
    pub pane_id: Option<String>,
    pub resumable: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRuntimeStatus {
    pub state: AgentLifecycleStatus,
    pub runtime_identity: Option<String>,
    pub generation: u64,
    pub detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCollectedResult {
    pub summary: String,
    pub files_modified: Vec<String>,
    pub report_path: Option<String>,
    pub metadata: Value,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResponse {
    pub request_id: String,
    pub option_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconcileRequest {
    pub expected_runtime_identity: Option<String>,
    pub expected_generation: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentEvent {
    pub sequence: u64,
    pub instance_id: String,
    pub state: AgentLifecycleStatus,
    pub detail: Option<String>,
    pub payload: Value,
}

pub type AgentEventSink = Arc<dyn Fn(AgentEvent) + Send + Sync + 'static>;

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("agent instance not found: {0}")]
    NotFound(String),
    #[error("invalid agent lifecycle transition from {from:?} to {to:?}")]
    InvalidTransition {
        from: AgentLifecycleStatus,
        to: AgentLifecycleStatus,
    },
    #[error("agent instance is not active: {0}")]
    NotActive(String),
    #[error("adapter runtime error: {0}")]
    Runtime(String),
}

pub trait AdapterRuntime: Send + Sync + 'static {
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

/// Integration boundary for the existing Hermes manager. Implementations must delegate
/// detection, installation/config ownership, ACP session lifecycle, and credentials to Hermes.
pub trait HermesAcpRuntime: AdapterRuntime {}

/// Integration boundary for daemon-owned PTY panes. Implementations must use exact pane/process
/// generations and the existing PTY authority rather than focus-based terminal selection.
pub trait PtyCliRuntime: AdapterRuntime {}

pub trait AgentAdapter: Send + Sync {
    fn provider(&self) -> AgentProvider;
    fn detect(&self) -> Result<AdapterDetection, AdapterError>;
    fn start(&self, request: AgentStartRequest) -> Result<AgentRuntimeHandle, AdapterError>;
    fn send(&self, instance_id: &str, message: &str) -> Result<(), AdapterError>;
    fn cancel(&self, instance_id: &str) -> Result<(), AdapterError>;
    fn status(&self, instance_id: &str) -> Result<AgentRuntimeStatus, AdapterError>;
    fn subscribe_events(
        &self,
        instance_id: &str,
        sink: AgentEventSink,
    ) -> Result<Uuid, AdapterError>;
    fn unsubscribe_events(&self, instance_id: &str, subscription_id: Uuid);
    fn respond_permission(
        &self,
        instance_id: &str,
        response: PermissionResponse,
    ) -> Result<(), AdapterError>;
    fn collect_result(&self, instance_id: &str) -> Result<AgentCollectedResult, AdapterError>;
    fn stop(&self, instance_id: &str) -> Result<(), AdapterError>;
    fn reconcile(
        &self,
        instance_id: &str,
        request: ReconcileRequest,
    ) -> Result<AgentRuntimeStatus, AdapterError>;
}

#[derive(Clone)]
struct InstanceLifecycle {
    state: AgentLifecycleStatus,
    runtime_identity: Option<String>,
    generation: u64,
    next_sequence: u64,
    subscribers: HashMap<Uuid, AgentEventSink>,
}

struct StatefulAdapter<R> {
    provider: AgentProvider,
    runtime: Arc<R>,
    instances: Mutex<HashMap<String, InstanceLifecycle>>,
}

impl<R: AdapterRuntime> StatefulAdapter<R> {
    fn new(provider: AgentProvider, runtime: Arc<R>) -> Self {
        Self {
            provider,
            runtime,
            instances: Mutex::new(HashMap::new()),
        }
    }

    fn detect(&self) -> Result<AdapterDetection, AdapterError> {
        self.runtime.detect()
    }

    fn start(&self, request: AgentStartRequest) -> Result<AgentRuntimeHandle, AdapterError> {
        {
            let mut instances = self
                .instances
                .lock()
                .expect("adapter lifecycle mutex poisoned");
            if let Some(existing) = instances.get(&request.instance_id) {
                if !existing.state.is_terminal() {
                    return Err(AdapterError::InvalidTransition {
                        from: existing.state,
                        to: AgentLifecycleStatus::Starting,
                    });
                }
            }
            instances.insert(
                request.instance_id.clone(),
                InstanceLifecycle {
                    state: AgentLifecycleStatus::Starting,
                    runtime_identity: None,
                    generation: 0,
                    next_sequence: 1,
                    subscribers: HashMap::new(),
                },
            );
        }
        self.emit(
            &request.instance_id,
            AgentLifecycleStatus::Starting,
            None,
            Value::Null,
        )?;
        match self.runtime.start(&request) {
            Ok(handle) => {
                self.update_runtime(
                    &request.instance_id,
                    AgentLifecycleStatus::Running,
                    Some(handle.runtime_identity.clone()),
                    handle.generation,
                    None,
                )?;
                Ok(handle)
            }
            Err(error) => {
                let _ = self.transition(
                    &request.instance_id,
                    AgentLifecycleStatus::Failed,
                    Some(error.to_string()),
                );
                Err(error)
            }
        }
    }

    fn send(&self, instance_id: &str, message: &str) -> Result<(), AdapterError> {
        self.require_active(instance_id)?;
        self.runtime.send(instance_id, message)?;
        self.transition(instance_id, AgentLifecycleStatus::Running, None)
    }

    fn cancel(&self, instance_id: &str) -> Result<(), AdapterError> {
        self.require_active(instance_id)?;
        self.runtime.cancel(instance_id)?;
        self.transition(instance_id, AgentLifecycleStatus::Cancelled, None)
    }

    fn status(&self, instance_id: &str) -> Result<AgentRuntimeStatus, AdapterError> {
        self.require_known(instance_id)?;
        let status = self.runtime.status(instance_id)?;
        self.update_runtime(
            instance_id,
            status.state,
            status.runtime_identity.clone(),
            status.generation,
            status.detail.clone(),
        )?;
        Ok(status)
    }

    fn subscribe_events(
        &self,
        instance_id: &str,
        sink: AgentEventSink,
    ) -> Result<Uuid, AdapterError> {
        let mut instances = self
            .instances
            .lock()
            .expect("adapter lifecycle mutex poisoned");
        let lifecycle = instances
            .get_mut(instance_id)
            .ok_or_else(|| AdapterError::NotFound(instance_id.to_string()))?;
        let subscription_id = Uuid::new_v4();
        lifecycle.subscribers.insert(subscription_id, sink);
        Ok(subscription_id)
    }

    fn unsubscribe_events(&self, instance_id: &str, subscription_id: Uuid) {
        if let Some(lifecycle) = self
            .instances
            .lock()
            .expect("adapter lifecycle mutex poisoned")
            .get_mut(instance_id)
        {
            lifecycle.subscribers.remove(&subscription_id);
        }
    }

    fn respond_permission(
        &self,
        instance_id: &str,
        response: PermissionResponse,
    ) -> Result<(), AdapterError> {
        self.require_active(instance_id)?;
        self.runtime.respond_permission(instance_id, &response)
    }

    fn collect_result(&self, instance_id: &str) -> Result<AgentCollectedResult, AdapterError> {
        self.require_active(instance_id)?;
        let result = self.runtime.collect_result(instance_id)?;
        self.transition(instance_id, AgentLifecycleStatus::Completed, None)?;
        Ok(result)
    }

    fn stop(&self, instance_id: &str) -> Result<(), AdapterError> {
        self.require_known(instance_id)?;
        self.runtime.stop(instance_id)?;
        self.transition(instance_id, AgentLifecycleStatus::Stopped, None)
    }

    fn reconcile(
        &self,
        instance_id: &str,
        request: ReconcileRequest,
    ) -> Result<AgentRuntimeStatus, AdapterError> {
        self.require_known(instance_id)?;
        self.transition(instance_id, AgentLifecycleStatus::Reconciling, None)?;
        let status = self.runtime.reconcile(instance_id, &request)?;
        self.update_runtime(
            instance_id,
            status.state,
            status.runtime_identity.clone(),
            status.generation,
            status.detail.clone(),
        )?;
        Ok(status)
    }

    fn require_known(&self, instance_id: &str) -> Result<AgentLifecycleStatus, AdapterError> {
        self.instances
            .lock()
            .expect("adapter lifecycle mutex poisoned")
            .get(instance_id)
            .map(|lifecycle| lifecycle.state)
            .ok_or_else(|| AdapterError::NotFound(instance_id.to_string()))
    }

    fn require_active(&self, instance_id: &str) -> Result<AgentLifecycleStatus, AdapterError> {
        let state = self.require_known(instance_id)?;
        if state.is_active() {
            Ok(state)
        } else {
            Err(AdapterError::NotActive(instance_id.to_string()))
        }
    }

    fn update_runtime(
        &self,
        instance_id: &str,
        next: AgentLifecycleStatus,
        runtime_identity: Option<String>,
        generation: u64,
        detail: Option<String>,
    ) -> Result<(), AdapterError> {
        {
            let mut instances = self
                .instances
                .lock()
                .expect("adapter lifecycle mutex poisoned");
            let lifecycle = instances
                .get_mut(instance_id)
                .ok_or_else(|| AdapterError::NotFound(instance_id.to_string()))?;
            validate_lifecycle_transition(lifecycle.state, next)?;
            lifecycle.state = next;
            lifecycle.runtime_identity = runtime_identity;
            lifecycle.generation = generation;
        }
        self.emit(instance_id, next, detail, Value::Null)
    }

    fn transition(
        &self,
        instance_id: &str,
        next: AgentLifecycleStatus,
        detail: Option<String>,
    ) -> Result<(), AdapterError> {
        {
            let mut instances = self
                .instances
                .lock()
                .expect("adapter lifecycle mutex poisoned");
            let lifecycle = instances
                .get_mut(instance_id)
                .ok_or_else(|| AdapterError::NotFound(instance_id.to_string()))?;
            validate_lifecycle_transition(lifecycle.state, next)?;
            lifecycle.state = next;
        }
        self.emit(instance_id, next, detail, Value::Null)
    }

    fn emit(
        &self,
        instance_id: &str,
        state: AgentLifecycleStatus,
        detail: Option<String>,
        payload: Value,
    ) -> Result<(), AdapterError> {
        let (event, subscribers) = {
            let mut instances = self
                .instances
                .lock()
                .expect("adapter lifecycle mutex poisoned");
            let lifecycle = instances
                .get_mut(instance_id)
                .ok_or_else(|| AdapterError::NotFound(instance_id.to_string()))?;
            let event = AgentEvent {
                sequence: lifecycle.next_sequence,
                instance_id: instance_id.to_string(),
                state,
                detail,
                payload,
            };
            lifecycle.next_sequence = lifecycle.next_sequence.saturating_add(1);
            let subscribers = lifecycle.subscribers.values().cloned().collect::<Vec<_>>();
            (event, subscribers)
        };
        for subscriber in subscribers {
            subscriber(event.clone());
        }
        Ok(())
    }
}

fn validate_lifecycle_transition(
    from: AgentLifecycleStatus,
    to: AgentLifecycleStatus,
) -> Result<(), AdapterError> {
    if from == to {
        return Ok(());
    }
    let valid = match from {
        AgentLifecycleStatus::Registered => matches!(to, AgentLifecycleStatus::Starting),
        AgentLifecycleStatus::Starting => matches!(
            to,
            AgentLifecycleStatus::Running
                | AgentLifecycleStatus::Reconciling
                | AgentLifecycleStatus::Failed
                | AgentLifecycleStatus::Cancelled
                | AgentLifecycleStatus::Stopped
        ),
        AgentLifecycleStatus::Running => matches!(
            to,
            AgentLifecycleStatus::Waiting
                | AgentLifecycleStatus::Reconciling
                | AgentLifecycleStatus::Completed
                | AgentLifecycleStatus::Failed
                | AgentLifecycleStatus::Lost
                | AgentLifecycleStatus::Cancelled
                | AgentLifecycleStatus::Stopped
        ),
        AgentLifecycleStatus::Waiting | AgentLifecycleStatus::Reconciling => matches!(
            to,
            AgentLifecycleStatus::Running
                | AgentLifecycleStatus::Waiting
                | AgentLifecycleStatus::Reconciling
                | AgentLifecycleStatus::Completed
                | AgentLifecycleStatus::Failed
                | AgentLifecycleStatus::Lost
                | AgentLifecycleStatus::Cancelled
                | AgentLifecycleStatus::Stopped
        ),
        AgentLifecycleStatus::Completed
        | AgentLifecycleStatus::Failed
        | AgentLifecycleStatus::Lost
        | AgentLifecycleStatus::Cancelled
        | AgentLifecycleStatus::Stopped => false,
    };
    if valid {
        Ok(())
    } else {
        Err(AdapterError::InvalidTransition { from, to })
    }
}

macro_rules! define_adapter {
    ($name:ident, $runtime:ident, $provider:expr) => {
        pub struct $name<R: $runtime> {
            inner: StatefulAdapter<R>,
        }

        impl<R: $runtime> $name<R> {
            pub fn new(runtime: Arc<R>) -> Self {
                Self {
                    inner: StatefulAdapter::new($provider, runtime),
                }
            }
        }

        impl<R: $runtime> AgentAdapter for $name<R> {
            fn provider(&self) -> AgentProvider {
                self.inner.provider
            }

            fn detect(&self) -> Result<AdapterDetection, AdapterError> {
                self.inner.detect()
            }

            fn start(
                &self,
                request: AgentStartRequest,
            ) -> Result<AgentRuntimeHandle, AdapterError> {
                self.inner.start(request)
            }

            fn send(&self, instance_id: &str, message: &str) -> Result<(), AdapterError> {
                self.inner.send(instance_id, message)
            }

            fn cancel(&self, instance_id: &str) -> Result<(), AdapterError> {
                self.inner.cancel(instance_id)
            }

            fn status(&self, instance_id: &str) -> Result<AgentRuntimeStatus, AdapterError> {
                self.inner.status(instance_id)
            }

            fn subscribe_events(
                &self,
                instance_id: &str,
                sink: AgentEventSink,
            ) -> Result<Uuid, AdapterError> {
                self.inner.subscribe_events(instance_id, sink)
            }

            fn unsubscribe_events(&self, instance_id: &str, subscription_id: Uuid) {
                self.inner.unsubscribe_events(instance_id, subscription_id);
            }

            fn respond_permission(
                &self,
                instance_id: &str,
                response: PermissionResponse,
            ) -> Result<(), AdapterError> {
                self.inner.respond_permission(instance_id, response)
            }

            fn collect_result(
                &self,
                instance_id: &str,
            ) -> Result<AgentCollectedResult, AdapterError> {
                self.inner.collect_result(instance_id)
            }

            fn stop(&self, instance_id: &str) -> Result<(), AdapterError> {
                self.inner.stop(instance_id)
            }

            fn reconcile(
                &self,
                instance_id: &str,
                request: ReconcileRequest,
            ) -> Result<AgentRuntimeStatus, AdapterError> {
                self.inner.reconcile(instance_id, request)
            }
        }
    };
}

define_adapter!(HermesAcpAdapter, HermesAcpRuntime, AgentProvider::HermesAcp);
define_adapter!(PtyCliAdapter, PtyCliRuntime, AgentProvider::PtyCli);

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeRuntime {
        statuses: Mutex<HashMap<String, AgentRuntimeStatus>>,
    }

    impl FakeRuntime {
        fn set_status(&self, instance_id: &str, status: AgentLifecycleStatus) {
            self.statuses.lock().expect("fake runtime mutex").insert(
                instance_id.to_string(),
                AgentRuntimeStatus {
                    state: status,
                    runtime_identity: Some(format!("runtime-{instance_id}")),
                    generation: 4,
                    detail: None,
                },
            );
        }
    }

    impl AdapterRuntime for FakeRuntime {
        fn detect(&self) -> Result<AdapterDetection, AdapterError> {
            Ok(AdapterDetection {
                available: true,
                version: Some("test".to_string()),
                detail: None,
            })
        }

        fn start(&self, request: &AgentStartRequest) -> Result<AgentRuntimeHandle, AdapterError> {
            self.set_status(&request.instance_id, AgentLifecycleStatus::Running);
            Ok(AgentRuntimeHandle {
                runtime_identity: format!("runtime-{}", request.instance_id),
                generation: 4,
                pane_id: None,
                resumable: true,
            })
        }

        fn send(&self, instance_id: &str, _message: &str) -> Result<(), AdapterError> {
            self.status(instance_id).map(|_| ())
        }

        fn cancel(&self, instance_id: &str) -> Result<(), AdapterError> {
            self.set_status(instance_id, AgentLifecycleStatus::Cancelled);
            Ok(())
        }

        fn status(&self, instance_id: &str) -> Result<AgentRuntimeStatus, AdapterError> {
            self.statuses
                .lock()
                .expect("fake runtime mutex")
                .get(instance_id)
                .cloned()
                .ok_or_else(|| AdapterError::NotFound(instance_id.to_string()))
        }

        fn respond_permission(
            &self,
            instance_id: &str,
            _response: &PermissionResponse,
        ) -> Result<(), AdapterError> {
            self.status(instance_id).map(|_| ())
        }

        fn collect_result(&self, instance_id: &str) -> Result<AgentCollectedResult, AdapterError> {
            self.status(instance_id)?;
            self.set_status(instance_id, AgentLifecycleStatus::Completed);
            Ok(AgentCollectedResult {
                summary: "done".to_string(),
                files_modified: vec!["src/lib.rs".to_string()],
                report_path: None,
                metadata: Value::Null,
            })
        }

        fn stop(&self, instance_id: &str) -> Result<(), AdapterError> {
            self.set_status(instance_id, AgentLifecycleStatus::Stopped);
            Ok(())
        }

        fn reconcile(
            &self,
            instance_id: &str,
            _request: &ReconcileRequest,
        ) -> Result<AgentRuntimeStatus, AdapterError> {
            self.set_status(instance_id, AgentLifecycleStatus::Running);
            self.status(instance_id)
        }
    }

    impl HermesAcpRuntime for FakeRuntime {}
    impl PtyCliRuntime for FakeRuntime {}

    fn start_request(instance_id: &str) -> AgentStartRequest {
        AgentStartRequest {
            instance_id: instance_id.to_string(),
            run_id: Uuid::new_v4().to_string(),
            task_id: Uuid::new_v4().to_string(),
            dispatch_id: Uuid::new_v4().to_string(),
            session_id: Uuid::new_v4().to_string(),
            workspace_path: "C:/workspace".to_string(),
            worktree_path: None,
            profile: None,
            environment: HashMap::new(),
        }
    }

    #[test]
    fn hermes_and_pty_adapters_enforce_concrete_lifecycle_transitions() {
        let hermes = HermesAcpAdapter::new(Arc::new(FakeRuntime::default()));
        assert_eq!(hermes.provider(), AgentProvider::HermesAcp);
        assert!(hermes.detect().expect("detect Hermes").available);
        hermes
            .start(start_request("hermes"))
            .expect("start Hermes contract");
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = Arc::clone(&events);
        hermes
            .subscribe_events(
                "hermes",
                Arc::new(move |event| captured.lock().expect("events mutex").push(event)),
            )
            .expect("subscribe");
        hermes.send("hermes", "continue").expect("send");
        hermes
            .reconcile(
                "hermes",
                ReconcileRequest {
                    expected_runtime_identity: Some("runtime-hermes".to_string()),
                    expected_generation: 4,
                },
            )
            .expect("reconcile");
        hermes.collect_result("hermes").expect("collect result");
        assert_eq!(
            events
                .lock()
                .expect("events mutex")
                .last()
                .expect("completion event")
                .state,
            AgentLifecycleStatus::Completed
        );
        assert!(matches!(
            hermes.send("hermes", "late"),
            Err(AdapterError::NotActive(_))
        ));

        let pty = PtyCliAdapter::new(Arc::new(FakeRuntime::default()));
        assert_eq!(pty.provider(), AgentProvider::PtyCli);
        pty.start(start_request("pty")).expect("start PTY contract");
        pty.cancel("pty").expect("cancel PTY contract");
        assert!(matches!(
            pty.send("pty", "late"),
            Err(AdapterError::NotActive(_))
        ));
    }
}

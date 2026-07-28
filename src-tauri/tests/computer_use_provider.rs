use app_lib::computer_use;

use computer_use::{
    frame::{
        read_authenticated_request, write_frame_with_limit, BootToken, FrameError, RequestEnvelope,
        ResponseEnvelope,
    },
    host::{
        HostIoError, HostIoErrorKind, OwnedProviderProcess, ProviderHostSupervisor,
        ProviderProcessIdentity, ProviderProcessSpawner,
    },
    ActionMethod, ActionRequest, ActionTarget, AppIdentity, AppRecord, ApprovalRequest,
    ApprovalState, BackendError, BackendErrorKind, ComputerAction, ComputerBackend,
    ComputerSnapshot, ComputerUseProvider, ElementRecord, HostRequest, HostResponseBody,
    IntegrityLevel, Point, ProviderCapability, ProviderErrorCode, RawSnapshot, Rect,
    ScreenshotArtifact, SemanticAction, SensitiveAppPolicy, SnapshotLimits, SnapshotRequest,
    SnapshotTruncation, WindowIdentity, REDACTED_VALUE,
};
use std::{
    collections::VecDeque,
    io::Cursor,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use uuid::Uuid;

#[derive(Clone, Debug, Eq, PartialEq)]
enum BackendCall {
    Restore,
    Snapshot,
    Capture(Vec<Rect>),
    Semantic(SemanticAction),
    Coordinate(Point),
}

struct FakeBackend {
    provider_integrity: IntegrityLevel,
    raw_snapshot: RawSnapshot,
    calls: Vec<BackendCall>,
    semantic_result: Result<(), BackendError>,
}

impl FakeBackend {
    fn new(window: WindowIdentity, elements: Vec<ElementRecord>) -> Self {
        Self {
            provider_integrity: IntegrityLevel::Medium,
            raw_snapshot: RawSnapshot {
                window,
                tree_lines: vec!["window".to_string()],
                focused_summary: None,
                selected_text: None,
                elements,
                truncation: SnapshotTruncation::default(),
            },
            calls: Vec::new(),
            semantic_result: Ok(()),
        }
    }
}

impl ComputerBackend for FakeBackend {
    fn capabilities(&self) -> Vec<ProviderCapability> {
        vec![
            ProviderCapability::Observe,
            ProviderCapability::Control,
            ProviderCapability::SemanticActions,
            ProviderCapability::CoordinateFallback,
        ]
    }

    fn provider_integrity(&self) -> IntegrityLevel {
        self.provider_integrity
    }

    fn list_apps(&mut self) -> Result<Vec<AppRecord>, BackendError> {
        Ok(vec![AppRecord {
            identity: self.raw_snapshot.window.app_identity(),
            display_name: self.raw_snapshot.window.executable_name.clone(),
            window_count: 1,
            blocked: false,
        }])
    }

    fn list_windows(
        &mut self,
        _process_id: Option<u32>,
    ) -> Result<Vec<WindowIdentity>, BackendError> {
        Ok(vec![self.raw_snapshot.window.clone()])
    }

    fn restore_window(&mut self, _window: &WindowIdentity) -> Result<(), BackendError> {
        self.calls.push(BackendCall::Restore);
        self.raw_snapshot.window.visible = true;
        self.raw_snapshot.window.minimized = false;
        Ok(())
    }

    fn current_window(&mut self, _window: &WindowIdentity) -> Result<WindowIdentity, BackendError> {
        Ok(self.raw_snapshot.window.clone())
    }
    fn snapshot_window(
        &mut self,
        _window: &WindowIdentity,
        _limits: SnapshotLimits,
    ) -> Result<RawSnapshot, BackendError> {
        self.calls.push(BackendCall::Snapshot);
        Ok(self.raw_snapshot.clone())
    }

    fn capture_window(
        &mut self,
        _window: &WindowIdentity,
        _redactions: &[Rect],
    ) -> Result<ScreenshotArtifact, BackendError> {
        self.calls.push(BackendCall::Capture(_redactions.to_vec()));
        Ok(ScreenshotArtifact {
            path: "artifact.png".to_string(),
            width: 100,
            height: 80,
            format: "png".to_string(),
        })
    }

    fn semantic_action(
        &mut self,
        _window: &WindowIdentity,
        _runtime_id: &[i32],
        semantic: SemanticAction,
        _action: &ComputerAction,
    ) -> Result<(), BackendError> {
        self.calls.push(BackendCall::Semantic(semantic));
        self.semantic_result.clone()
    }

    fn coordinate_action(
        &mut self,
        _window: &WindowIdentity,
        point: Point,
        action: &ComputerAction,
    ) -> Result<ActionMethod, BackendError> {
        self.calls.push(BackendCall::Coordinate(point));
        Ok(
            if matches!(
                action,
                ComputerAction::TypeText { .. }
                    | ComputerAction::PressKey { .. }
                    | ComputerAction::Hotkey { .. }
                    | ComputerAction::PasteText { .. }
            ) {
                ActionMethod::Keyboard
            } else {
                ActionMethod::Coordinate
            },
        )
    }
}

fn window(executable: &str, generation: u64) -> WindowIdentity {
    WindowIdentity {
        handle: 0x1234,
        process_id: 42,
        generation,
        title: "Test Window".to_string(),
        executable_name: executable.to_string(),
        bounds: Rect {
            left: 0,
            top: 0,
            right: 800,
            bottom: 600,
        },
        visible: true,
        minimized: false,
        integrity: IntegrityLevel::Medium,
    }
}

fn element(index: u32, name: &str, value: Option<&str>) -> ElementRecord {
    ElementRecord {
        index,
        runtime_id: vec![42, index as i32],
        role: "edit".to_string(),
        name: name.to_string(),
        value: value.map(str::to_string),
        bounds: Some(Rect {
            left: 10,
            top: 20,
            right: 110,
            bottom: 60,
        }),
        enabled: true,
        offscreen: false,
        focused: false,
        password: false,
        redacted: false,
        supported_actions: vec![SemanticAction::Invoke, SemanticAction::Value],
    }
}

fn snapshot_request(window: WindowIdentity) -> SnapshotRequest {
    SnapshotRequest {
        operation_id: Uuid::new_v4(),
        window,
        no_screenshot: true,
        restore_window: false,
        limits: SnapshotLimits::default(),
    }
}

fn take_snapshot(provider: &mut ComputerUseProvider<FakeBackend>) -> ComputerSnapshot {
    let target = provider.backend().raw_snapshot.window.clone();
    provider
        .snapshot(snapshot_request(target))
        .expect("snapshot should succeed")
}

#[test]
fn frame_bounds_and_boot_token_are_enforced_before_dispatch() {
    let expected = BootToken::from_bytes([7; 32]);
    let wrong = BootToken::from_bytes([8; 32]);
    let request = RequestEnvelope::new(wrong, Uuid::new_v4(), HostRequest::Capabilities);
    let mut encoded = Vec::new();
    computer_use::frame::write_frame(&mut encoded, &request).expect("encode request");

    let error = read_authenticated_request(&mut Cursor::new(encoded), &expected)
        .expect_err("wrong boot token must be rejected");
    assert!(matches!(error, FrameError::Unauthorized));

    let oversized = RequestEnvelope::new(
        expected,
        Uuid::new_v4(),
        HostRequest::Action {
            request: ActionRequest {
                operation_id: Uuid::new_v4(),
                snapshot_id: Uuid::new_v4(),
                window_generation: 1,
                target: ActionTarget::Coordinate {
                    point: Point { x: 1, y: 1 },
                    window_generation: 1,
                },
                action: ComputerAction::TypeText {
                    text: "x".repeat(512),
                },
            },
        },
    );
    let error = write_frame_with_limit(&mut Vec::new(), &oversized, 64)
        .expect_err("encoded frame must respect the configured bound");
    assert!(matches!(error, FrameError::FrameTooLarge { .. }));

    let mut prefix_only = Cursor::new((65_u32).to_be_bytes().to_vec());
    let error =
        computer_use::frame::read_frame_with_limit::<_, RequestEnvelope>(&mut prefix_only, 64)
            .expect_err("oversized prefix must fail before payload allocation");
    assert!(matches!(
        error,
        FrameError::FrameTooLarge { len: 65, max: 64 }
    ));
}

#[test]
fn approved_action_json_contract_round_trips() {
    let approval_id = Uuid::new_v4();
    let request = HostRequest::Action {
        request: ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: Uuid::new_v4(),
            window_generation: 7,
            target: ActionTarget::Element { index: 4 },
            action: ComputerAction::Approved {
                approval_id,
                action: Box::new(ComputerAction::PasteText {
                    text: "approved".to_string(),
                }),
            },
        },
    };
    let value = serde_json::to_value(&request).expect("serialize approved action JSON");
    assert_eq!(value["method"], "action");
    assert_eq!(value["request"]["action"]["kind"], "approved");
    assert_eq!(
        value["request"]["action"]["approval_id"],
        approval_id.to_string()
    );
    assert_eq!(value["request"]["action"]["action"]["kind"], "paste_text");
    let decoded: HostRequest =
        serde_json::from_value(value).expect("deserialize approved action JSON");
    assert_eq!(decoded, request);
}

#[test]
fn element_indices_are_rejected_outside_their_snapshot() {
    let backend = FakeBackend::new(window("notepad.exe", 7), vec![element(1, "Save", None)]);
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());
    let first = take_snapshot(&mut provider);

    provider.backend_mut().raw_snapshot.elements = vec![element(2, "Cancel", None)];
    let second = take_snapshot(&mut provider);
    let error = provider
        .action(ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: second.snapshot_id,
            window_generation: second.window.generation,
            target: ActionTarget::Element { index: 1 },
            action: ComputerAction::Click,
        })
        .expect_err("an element index from another snapshot must be stale");

    assert_ne!(first.snapshot_id, second.snapshot_id);
    assert_eq!(error.code, ProviderErrorCode::StaleElement);
    assert_eq!(
        provider.action_history(1)[0].error,
        Some(ProviderErrorCode::StaleElement)
    );
}

#[test]
fn password_and_otp_values_are_redacted_from_every_snapshot_field() {
    let mut password = element(1, "Password", Some("hunter2"));
    password.password = true;
    password.focused = true;
    let otp = element(2, "One-time code", Some("123456"));
    let mut backend = FakeBackend::new(window("notepad.exe", 9), vec![password, otp]);
    backend.raw_snapshot.tree_lines = vec![
        "Password: hunter2".to_string(),
        "One-time code: 123456".to_string(),
    ];
    backend.raw_snapshot.focused_summary = Some("Password hunter2".to_string());
    backend.raw_snapshot.selected_text = Some("hunter2".to_string());
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());

    let mut request = snapshot_request(provider.backend().raw_snapshot.window.clone());
    request.no_screenshot = false;
    let snapshot = provider
        .snapshot(request)
        .expect("snapshot should redact secrets");
    assert!(snapshot
        .elements
        .iter()
        .all(|element| element.value.as_deref() == Some(REDACTED_VALUE)));
    assert!(snapshot.elements.iter().all(|element| element.redacted));
    assert!(snapshot.tree_lines.iter().all(|line| {
        !line.contains("hunter2") && !line.contains("123456") && line.contains(REDACTED_VALUE)
    }));
    assert_eq!(
        snapshot.focused_summary.as_deref(),
        Some("Password <redacted>")
    );
    assert_eq!(snapshot.selected_text.as_deref(), Some(REDACTED_VALUE));
    assert!(matches!(
        provider.backend().calls.last(),
        Some(BackendCall::Capture(redactions)) if redactions.len() == 2
    ));
}

#[test]
fn sensitive_apps_are_blocked_before_uia_or_capture() {
    let backend = FakeBackend::new(window("Bitwarden.exe", 3), vec![]);
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());
    let request = snapshot_request(provider.backend().raw_snapshot.window.clone());

    let error = provider
        .snapshot(request)
        .expect_err("password managers must be blocked by default");
    assert_eq!(error.code, ProviderErrorCode::AppBlocked);
    assert!(provider.backend().calls.is_empty());
}

#[test]
fn higher_integrity_targets_map_to_elevation_required_without_auto_elevation() {
    let mut target = window("regedit.exe", 11);
    target.integrity = IntegrityLevel::High;
    let mut backend = FakeBackend::new(target.clone(), vec![]);
    backend.provider_integrity = IntegrityLevel::Medium;
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());

    let error = provider
        .snapshot(snapshot_request(target))
        .expect_err("medium-integrity provider must not control a high-integrity target");
    assert_eq!(error.code, ProviderErrorCode::ElevationRequired);
    assert_eq!(
        error.details.get("providerIntegrity").map(String::as_str),
        Some("medium")
    );
    assert_eq!(
        error.details.get("targetIntegrity").map(String::as_str),
        Some("high")
    );
    assert!(provider.backend().calls.is_empty());
}

#[test]
fn semantic_action_is_attempted_before_coordinate_fallback() {
    let backend = FakeBackend::new(window("notepad.exe", 5), vec![element(1, "Save", None)]);
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());
    let snapshot = take_snapshot(&mut provider);
    provider.backend_mut().semantic_result = Err(BackendError::new(
        BackendErrorKind::Unsupported,
        "invoke unavailable",
    ));
    provider.backend_mut().calls.clear();

    let result = provider
        .action(ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: snapshot.snapshot_id,
            window_generation: snapshot.window.generation,
            target: ActionTarget::Element { index: 1 },
            action: ComputerAction::Click,
        })
        .expect("visible frame should permit coordinate fallback");

    assert_eq!(result.method, ActionMethod::Coordinate);
    assert_eq!(
        provider.backend().calls,
        vec![
            BackendCall::Semantic(SemanticAction::Invoke),
            BackendCall::Coordinate(Point { x: 60, y: 40 }),
        ]
    );
}

#[test]
fn screenshot_off_skips_capture_and_restore_is_one_explicit_attempt() {
    let mut target = window("notepad.exe", 13);
    target.visible = false;
    target.minimized = true;
    let backend = FakeBackend::new(target.clone(), vec![]);
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());

    let error = provider
        .snapshot(snapshot_request(target.clone()))
        .expect_err("minimized window without restoreWindow must fail");
    assert_eq!(error.code, ProviderErrorCode::InvalidArgument);
    assert!(provider.backend().calls.is_empty());

    let mut request = snapshot_request(target);
    request.restore_window = true;
    request.no_screenshot = true;
    let snapshot = provider
        .snapshot(request)
        .expect("explicit restore should retry once");
    assert!(snapshot.screenshot.is_none());
    assert_eq!(
        provider.backend().calls,
        vec![BackendCall::Restore, BackendCall::Snapshot]
    );
}
#[test]
fn superseded_snapshot_and_wrong_generation_are_rejected_before_actions() {
    let backend = FakeBackend::new(window("notepad.exe", 21), vec![element(1, "Save", None)]);
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());
    let first = take_snapshot(&mut provider);
    let second = take_snapshot(&mut provider);

    let stale = provider
        .action(ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: first.snapshot_id,
            window_generation: first.window.generation,
            target: ActionTarget::Element { index: 1 },
            action: ComputerAction::Click,
        })
        .expect_err("a newer observation must expire the old window snapshot");
    assert_eq!(stale.code, ProviderErrorCode::StaleSnapshot);

    let wrong_generation = provider
        .action(ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: second.snapshot_id,
            window_generation: second.window.generation + 1,
            target: ActionTarget::Element { index: 1 },
            action: ComputerAction::Click,
        })
        .expect_err("request generation must match its snapshot");
    assert_eq!(
        wrong_generation.code,
        ProviderErrorCode::StaleWindowGeneration
    );

    provider.backend_mut().raw_snapshot.window.generation += 1;
    let changed_live_window = provider
        .action(ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: second.snapshot_id,
            window_generation: second.window.generation,
            target: ActionTarget::Element { index: 1 },
            action: ComputerAction::Click,
        })
        .expect_err("live window generation must be revalidated before input");
    assert_eq!(
        changed_live_window.code,
        ProviderErrorCode::StaleWindowGeneration
    );
}

#[test]
fn risky_paste_requires_exact_one_time_approval() {
    let backend = FakeBackend::new(window("notepad.exe", 22), vec![element(1, "Editor", None)]);
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());
    let snapshot = take_snapshot(&mut provider);
    provider.backend_mut().calls.clear();
    let target = ActionTarget::Element { index: 1 };
    let action = ComputerAction::PasteText {
        text: "approved once".to_string(),
    };

    let denied = provider
        .action(ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: snapshot.snapshot_id,
            window_generation: snapshot.window.generation,
            target: target.clone(),
            action: action.clone(),
        })
        .expect_err("paste without approval must not reach the backend");
    assert_eq!(denied.code, ProviderErrorCode::ApprovalRequired);
    assert!(provider.backend().calls.is_empty());

    let approval = provider
        .create_approval(ApprovalRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: snapshot.snapshot_id,
            window_generation: snapshot.window.generation,
            target: target.clone(),
            action: action.clone(),
        })
        .expect("risky action should create a pending approval");
    assert_eq!(approval.state, ApprovalState::Pending);
    let approval = provider
        .resolve_approval(approval.approval_id, true)
        .expect("approval should resolve once");
    assert_eq!(approval.state, ApprovalState::Approved);

    let result = provider
        .action(ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: snapshot.snapshot_id,
            window_generation: snapshot.window.generation,
            target: target.clone(),
            action: ComputerAction::Approved {
                approval_id: approval.approval_id,
                action: Box::new(action.clone()),
            },
        })
        .expect("approved paste should execute exactly once");
    assert_eq!(result.method, ActionMethod::Keyboard);
    assert_eq!(provider.approvals(1)[0].state, ApprovalState::Consumed);

    let replay = provider
        .action(ActionRequest {
            operation_id: Uuid::new_v4(),
            snapshot_id: snapshot.snapshot_id,
            window_generation: snapshot.window.generation,
            target,
            action: ComputerAction::Approved {
                approval_id: approval.approval_id,
                action: Box::new(action),
            },
        })
        .expect_err("consumed approval must never authorize a replay");
    assert_eq!(replay.code, ProviderErrorCode::ApprovalDenied);
}

#[test]
fn all_planned_actions_map_to_semantic_and_fallback_policy() {
    let cases = [
        (ComputerAction::Click, Some(SemanticAction::Invoke), true),
        (ComputerAction::Invoke, Some(SemanticAction::Invoke), false),
        (
            ComputerAction::SecondaryAction,
            Some(SemanticAction::SecondaryAction),
            true,
        ),
        (
            ComputerAction::Scroll {
                delta_x: 0,
                delta_y: 1,
            },
            Some(SemanticAction::Scroll),
            true,
        ),
        (
            ComputerAction::Drag {
                to: Point { x: 1, y: 2 },
            },
            None,
            true,
        ),
        (ComputerAction::TypeText { text: "x".into() }, None, true),
        (
            ComputerAction::PressKey {
                key: "Enter".into(),
            },
            None,
            true,
        ),
        (
            ComputerAction::Hotkey {
                keys: vec!["Ctrl".into(), "A".into()],
            },
            None,
            true,
        ),
        (ComputerAction::PasteText { text: "x".into() }, None, true),
        (
            ComputerAction::SetValue { value: "x".into() },
            Some(SemanticAction::Value),
            false,
        ),
        (ComputerAction::Toggle, Some(SemanticAction::Toggle), true),
        (
            ComputerAction::Select,
            Some(SemanticAction::SelectionItem),
            true,
        ),
        (
            ComputerAction::Expand,
            Some(SemanticAction::ExpandCollapse),
            true,
        ),
        (
            ComputerAction::Collapse,
            Some(SemanticAction::ExpandCollapse),
            true,
        ),
        (
            ComputerAction::SetRangeValue { value: 5 },
            Some(SemanticAction::RangeValue),
            false,
        ),
    ];
    for (action, semantic, fallback) in cases {
        assert_eq!(
            action.preferred_semantic(),
            semantic,
            "semantic mapping for {action:?}"
        );
        assert_eq!(
            action.allows_coordinate_fallback(),
            fallback,
            "fallback mapping for {action:?}"
        );
    }
}

#[derive(Clone)]
struct HostTestState {
    transactions: Arc<Mutex<Vec<u64>>>,
    terminations: Arc<Mutex<Vec<u64>>>,
}

struct FakeProcess {
    identity: ProviderProcessIdentity,
    fail: bool,
    state: HostTestState,
}

impl OwnedProviderProcess for FakeProcess {
    fn identity(&self) -> &ProviderProcessIdentity {
        &self.identity
    }

    fn transact(&mut self, request: &RequestEnvelope) -> Result<ResponseEnvelope, HostIoError> {
        self.state
            .transactions
            .lock()
            .expect("transaction lock")
            .push(self.identity.generation);
        if self.fail {
            return Err(HostIoError::new(
                HostIoErrorKind::ProcessExited,
                "simulated sidecar crash",
            ));
        }
        Ok(ResponseEnvelope::success(
            request,
            if matches!(&request.request, HostRequest::EmergencyStop) {
                HostResponseBody::Stopped
            } else {
                HostResponseBody::Capabilities(vec![ProviderCapability::Observe])
            },
        ))
    }

    fn terminate_owned(self) -> Result<(), HostIoError> {
        self.state
            .terminations
            .lock()
            .expect("termination lock")
            .push(self.identity.generation);
        Ok(())
    }
}

struct FakeSpawner {
    outcomes: VecDeque<bool>,
    state: HostTestState,
}

impl ProviderProcessSpawner for FakeSpawner {
    type Process = FakeProcess;

    fn spawn(
        &mut self,
        executable_path: &Path,
        boot_token: BootToken,
        generation: u64,
    ) -> Result<Self::Process, HostIoError> {
        Ok(FakeProcess {
            identity: ProviderProcessIdentity {
                instance_id: Uuid::new_v4(),
                pid: 1_000 + generation as u32,
                generation,
                executable_path: executable_path.to_path_buf(),
                boot_token,
            },
            fail: self.outcomes.pop_front().unwrap_or(false),
            state: self.state.clone(),
        })
    }
}

#[test]
fn host_failure_restarts_exact_owned_provider_without_replaying_action() {
    let state = HostTestState {
        transactions: Arc::new(Mutex::new(Vec::new())),
        terminations: Arc::new(Mutex::new(Vec::new())),
    };
    let spawner = FakeSpawner {
        outcomes: VecDeque::from([true, false]),
        state: state.clone(),
    };
    let executable = PathBuf::from(r"C:\Program Files\VibeLink\vibelink-computer-host.exe");
    let mut supervisor = ProviderHostSupervisor::new(spawner, executable);
    let action_operation = Uuid::new_v4();

    let error = supervisor
        .request(
            action_operation,
            HostRequest::Action {
                request: ActionRequest {
                    operation_id: action_operation,
                    snapshot_id: Uuid::new_v4(),
                    window_generation: 1,
                    target: ActionTarget::Coordinate {
                        point: Point { x: 1, y: 1 },
                        window_generation: 1,
                    },
                    action: ComputerAction::Click,
                },
            },
        )
        .expect_err("failed action must be surfaced rather than replayed");

    assert_eq!(error.code, ProviderErrorCode::HostRestarted);
    assert_eq!(supervisor.generation(), 2);
    assert_eq!(
        *state.transactions.lock().expect("transaction lock"),
        vec![1]
    );
    assert_eq!(
        *state.terminations.lock().expect("termination lock"),
        vec![1]
    );

    let response = supervisor
        .request(Uuid::new_v4(), HostRequest::Capabilities)
        .expect("next explicit request should use replacement host");
    assert!(matches!(response, HostResponseBody::Capabilities(_)));
    assert_eq!(
        *state.transactions.lock().expect("transaction lock"),
        vec![1, 2]
    );
}

#[test]
fn emergency_stop_requires_explicit_safe_restart() {
    let state = HostTestState {
        transactions: Arc::new(Mutex::new(Vec::new())),
        terminations: Arc::new(Mutex::new(Vec::new())),
    };
    let spawner = FakeSpawner {
        outcomes: VecDeque::from([false, false]),
        state: state.clone(),
    };
    let executable = PathBuf::from(r"C:\Program Files\VibeLink\vibelink-computer-host.exe");
    let mut supervisor = ProviderHostSupervisor::new(spawner, executable);

    supervisor
        .request(Uuid::new_v4(), HostRequest::Capabilities)
        .expect("provider should start on first request");
    let stopped = supervisor
        .request(Uuid::new_v4(), HostRequest::EmergencyStop)
        .expect("emergency stop should be acknowledged");
    assert!(matches!(stopped, HostResponseBody::Stopped));
    assert!(supervisor.status().emergency_stopped);
    assert!(!supervisor.status().running);
    assert_eq!(
        supervisor
            .request(Uuid::new_v4(), HostRequest::Capabilities)
            .expect_err("ordinary requests must remain blocked after emergency stop")
            .code,
        ProviderErrorCode::EmergencyStopped
    );

    let restarted = supervisor
        .request(Uuid::new_v4(), HostRequest::RestartProvider)
        .expect("restart must be explicit");
    assert!(matches!(
        &restarted,
        HostResponseBody::ProviderStatus(status)
            if status.running && !status.emergency_stopped && status.host_generation == 2
    ));
    assert_eq!(
        *state.terminations.lock().expect("termination lock"),
        vec![1]
    );
}

#[test]
fn configured_sensitive_app_extension_is_normalized() {
    let policy = SensitiveAppPolicy::default().with_blocked_executables([r"C:\Tools\Vault.EXE"]);
    let app = AppIdentity {
        process_id: 77,
        executable_name: "vault.exe".to_string(),
        executable_path: None,
        integrity: IntegrityLevel::Medium,
    };
    assert!(policy.is_app_blocked(&app, None));
}

#[cfg(windows)]
#[test]
#[ignore = "interactive Windows UIA smoke"]
fn real_explorer_uia_smoke_observes_bounded_snapshot() {
    let artifact_root = std::env::temp_dir().join(format!(
        "vibelink-computer-explorer-smoke-{}",
        Uuid::new_v4()
    ));
    let backend = computer_use::WindowsComputerBackend::new(artifact_root.clone())
        .expect("initialize Windows UIA backend");
    let mut provider = ComputerUseProvider::new(backend, SensitiveAppPolicy::default());
    let target = provider
        .list_windows(None)
        .expect("list real desktop windows")
        .into_iter()
        .find(|window| {
            window.visible
                && !window.minimized
                && window.executable_name.eq_ignore_ascii_case("explorer.exe")
        })
        .expect("find a visible non-minimized Explorer window");
    let snapshot = provider
        .snapshot(SnapshotRequest {
            operation_id: Uuid::new_v4(),
            window: target.clone(),
            no_screenshot: true,
            restore_window: false,
            limits: SnapshotLimits {
                max_nodes: 512,
                max_depth: 32,
            },
        })
        .expect("observe real Explorer through Windows UI Automation");
    assert_eq!(snapshot.window.process_id, target.process_id);
    assert_eq!(snapshot.window.generation, target.generation);
    assert!(!snapshot.elements.is_empty());
    assert!(snapshot.elements.len() <= 512);
    assert!(snapshot.screenshot.is_none());
    eprintln!(
        "Explorer UIA smoke: pid={}, generation={}, elements={}, omitted={}",
        snapshot.window.process_id,
        snapshot.window.generation,
        snapshot.elements.len(),
        snapshot.truncation.omitted_nodes
    );
    let _ = std::fs::remove_dir_all(artifact_root);
}

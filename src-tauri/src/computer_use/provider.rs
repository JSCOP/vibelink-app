use super::{
    policy::{redact_element, redact_selected_text, SensitiveAppPolicy},
    types::*,
};
use std::{
    collections::{HashMap, VecDeque},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const MAX_LIVE_SNAPSHOTS: usize = 64;
const MAX_ACTION_HISTORY: usize = 256;
const MAX_APPROVAL_HISTORY: usize = 128;

pub trait ComputerBackend {
    fn capabilities(&self) -> Vec<ProviderCapability>;
    fn provider_integrity(&self) -> IntegrityLevel;
    fn list_apps(&mut self) -> Result<Vec<AppRecord>, BackendError>;
    fn list_windows(
        &mut self,
        process_id: Option<u32>,
    ) -> Result<Vec<WindowIdentity>, BackendError>;
    fn current_window(&mut self, window: &WindowIdentity) -> Result<WindowIdentity, BackendError>;
    fn restore_window(&mut self, window: &WindowIdentity) -> Result<(), BackendError>;
    fn snapshot_window(
        &mut self,
        window: &WindowIdentity,
        limits: SnapshotLimits,
    ) -> Result<RawSnapshot, BackendError>;
    fn capture_window(
        &mut self,
        window: &WindowIdentity,
        redactions: &[Rect],
    ) -> Result<ScreenshotArtifact, BackendError>;
    fn semantic_action(
        &mut self,
        window: &WindowIdentity,
        runtime_id: &[i32],
        semantic: SemanticAction,
        action: &ComputerAction,
    ) -> Result<(), BackendError>;
    fn coordinate_action(
        &mut self,
        window: &WindowIdentity,
        point: Point,
        action: &ComputerAction,
    ) -> Result<ActionMethod, BackendError>;
}

#[derive(Clone)]
struct SnapshotLease {
    snapshot: ComputerSnapshot,
}

#[derive(Clone)]
struct ApprovalLease {
    request: ApprovalRequest,
    record: ApprovalRecord,
}

pub struct ComputerUseProvider<B> {
    backend: B,
    policy: SensitiveAppPolicy,
    snapshots: HashMap<Uuid, SnapshotLease>,
    snapshot_order: VecDeque<Uuid>,
    approvals: HashMap<Uuid, ApprovalLease>,
    approval_order: VecDeque<Uuid>,
    action_history: VecDeque<ActionHistoryRecord>,
    stopped: bool,
}

impl<B> ComputerUseProvider<B>
where
    B: ComputerBackend,
{
    pub fn new(backend: B, policy: SensitiveAppPolicy) -> Self {
        Self {
            backend,
            policy,
            snapshots: HashMap::new(),
            snapshot_order: VecDeque::new(),
            approvals: HashMap::new(),
            approval_order: VecDeque::new(),
            action_history: VecDeque::new(),
            stopped: false,
        }
    }

    pub fn backend(&self) -> &B {
        &self.backend
    }

    pub fn backend_mut(&mut self) -> &mut B {
        &mut self.backend
    }
    pub fn capabilities(&self) -> Vec<ProviderCapability> {
        let mut capabilities = self.backend.capabilities();
        for capability in [
            ProviderCapability::ExplicitApprovals,
            ProviderCapability::EmergencyStop,
        ] {
            if !capabilities.contains(&capability) {
                capabilities.push(capability);
            }
        }
        capabilities
    }

    pub fn list_apps(&mut self) -> Result<Vec<AppRecord>, ProviderError> {
        self.require_running()?;
        let mut apps = self
            .backend
            .list_apps()
            .map_err(|error| self.map_backend_error(error, IntegrityLevel::Unknown))?;
        for app in &mut apps {
            app.blocked = self.policy.is_app_blocked(&app.identity, None);
        }
        Ok(apps)
    }

    pub fn list_windows(
        &mut self,
        process_id: Option<u32>,
    ) -> Result<Vec<WindowIdentity>, ProviderError> {
        self.require_running()?;
        self.backend
            .list_windows(process_id)
            .map_err(|error| self.map_backend_error(error, IntegrityLevel::Unknown))
    }

    pub fn snapshot(
        &mut self,
        request: SnapshotRequest,
    ) -> Result<ComputerSnapshot, ProviderError> {
        self.require_running()?;
        self.policy
            .require_allowed(&request.window.app_identity(), Some(&request.window.title))?;
        self.require_integrity(request.window.integrity)?;

        if request.window.minimized && !request.restore_window {
            return Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "window is minimized; set restoreWindow for one explicit restore attempt",
            ));
        }
        if request.restore_window && (!request.window.visible || request.window.minimized) {
            self.backend
                .restore_window(&request.window)
                .map_err(|error| self.map_backend_error(error, request.window.integrity))?;
        }

        let mut raw = self
            .backend
            .snapshot_window(&request.window, request.limits)
            .map_err(|error| self.map_backend_error(error, request.window.integrity))?;
        self.policy
            .require_allowed(&raw.window.app_identity(), Some(&raw.window.title))?;
        self.require_integrity(raw.window.integrity)?;
        if raw.window.handle != request.window.handle
            || raw.window.process_id != request.window.process_id
            || raw.window.generation != request.window.generation
        {
            return Err(stale_generation(
                request.window.generation,
                raw.window.generation,
            ));
        }

        let mut secret_values = Vec::new();
        for element in &raw.elements {
            if (element.password
                || super::policy::is_secret_label(&element.name)
                || super::policy::is_secret_label(&element.role))
                && element
                    .value
                    .as_ref()
                    .is_some_and(|value| !value.is_empty())
            {
                secret_values.push(element.value.clone().unwrap_or_default());
            }
        }
        for element in &mut raw.elements {
            redact_element(element);
        }
        redact_text_fields(
            &secret_values,
            &mut raw.tree_lines,
            &mut raw.focused_summary,
        );
        let focused = raw.elements.iter().find(|element| element.focused);
        redact_selected_text(&mut raw.selected_text, focused);

        let redactions = raw
            .elements
            .iter()
            .filter(|element| element.redacted || element.password)
            .filter_map(|element| element.bounds)
            .collect::<Vec<_>>();
        let screenshot = if request.no_screenshot {
            None
        } else {
            Some(
                self.backend
                    .capture_window(&raw.window, &redactions)
                    .map_err(|error| self.map_backend_error(error, raw.window.integrity))?,
            )
        };
        let snapshot = ComputerSnapshot {
            snapshot_id: Uuid::new_v4(),
            window: raw.window,
            tree_lines: raw.tree_lines,
            focused_summary: raw.focused_summary,
            selected_text: raw.selected_text,
            elements: raw.elements,
            screenshot,
            truncation: raw.truncation,
        };
        self.insert_snapshot(snapshot.clone());
        Ok(snapshot)
    }

    pub fn create_approval(
        &mut self,
        request: ApprovalRequest,
    ) -> Result<ApprovalRecord, ProviderError> {
        self.require_running()?;
        let (window, element) = self.action_context(
            request.snapshot_id,
            request.window_generation,
            &request.target,
        )?;
        if request.action.approval_id().is_some() {
            return Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "cannot request approval for an already approved action wrapper",
            ));
        }
        validate_action_request(
            &window,
            &request.target,
            request.action.unapproved(),
            element.as_ref(),
        )?;
        if !action_requires_approval(&request.target, &request.action, element.as_ref()) {
            return Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "this action does not require a separate approval",
            ));
        }
        while self.approval_order.len() >= MAX_APPROVAL_HISTORY {
            if let Some(expired) = self.approval_order.pop_front() {
                self.approvals.remove(&expired);
            }
        }
        let approval_id = Uuid::new_v4();
        let record = ApprovalRecord {
            approval_id,
            operation_id: request.operation_id,
            snapshot_id: request.snapshot_id,
            window_handle: window.handle,
            window_title: window.title,
            action: request.action.kind(),
            state: ApprovalState::Pending,
            reason: approval_reason(&request.target, &request.action, element.as_ref()).to_string(),
            created_at_ms: now_ms(),
            resolved_at_ms: None,
        };
        self.approval_order.push_back(approval_id);
        self.approvals.insert(
            approval_id,
            ApprovalLease {
                request,
                record: record.clone(),
            },
        );
        Ok(record)
    }

    pub fn resolve_approval(
        &mut self,
        approval_id: Uuid,
        approved: bool,
    ) -> Result<ApprovalRecord, ProviderError> {
        self.require_running()?;
        let approval = self.approvals.get_mut(&approval_id).ok_or_else(|| {
            ProviderError::new(
                ProviderErrorCode::NotFound,
                "approval request was not found",
            )
        })?;
        if approval.record.state != ApprovalState::Pending {
            return Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "approval request is already resolved",
            ));
        }
        approval.record.state = if approved {
            ApprovalState::Approved
        } else {
            ApprovalState::Denied
        };
        approval.record.resolved_at_ms = Some(now_ms());
        Ok(approval.record.clone())
    }

    pub fn approvals(&self, limit: u32) -> Vec<ApprovalRecord> {
        let limit = usize::try_from(limit)
            .unwrap_or(usize::MAX)
            .min(MAX_APPROVAL_HISTORY);
        self.approval_order
            .iter()
            .rev()
            .filter_map(|approval_id| self.approvals.get(approval_id))
            .take(limit)
            .map(|approval| approval.record.clone())
            .collect()
    }

    pub fn action(&mut self, request: ActionRequest) -> Result<ActionResult, ProviderError> {
        let started_at_ms = now_ms();
        let action_kind = request.action.kind();
        let snapshot_id = request.snapshot_id;
        let operation_id = request.operation_id;
        let window_handle = self
            .snapshots
            .get(&snapshot_id)
            .map_or(0, |lease| lease.snapshot.window.handle);

        let result = self.execute_action(&request);
        let method = result.as_ref().ok().map(|value| value.method);
        let error = result.as_ref().err().map(|value| value.code);
        self.push_history(ActionHistoryRecord {
            operation_id,
            snapshot_id,
            window_handle,
            action: action_kind,
            method,
            approval_id: request.action.approval_id(),
            started_at_ms,
            completed_at_ms: now_ms(),
            error,
        });
        result
    }

    pub fn action_history(&self, limit: u32) -> Vec<ActionHistoryRecord> {
        let limit = usize::try_from(limit)
            .unwrap_or(usize::MAX)
            .min(MAX_ACTION_HISTORY);
        self.action_history
            .iter()
            .rev()
            .take(limit)
            .cloned()
            .collect()
    }

    pub fn emergency_stop(&mut self) {
        self.stopped = true;
        self.snapshots.clear();
        self.snapshot_order.clear();
        self.approvals.clear();
        self.approval_order.clear();
    }

    fn execute_action(&mut self, request: &ActionRequest) -> Result<ActionResult, ProviderError> {
        self.require_running()?;
        let lease = self
            .snapshots
            .get(&request.snapshot_id)
            .cloned()
            .ok_or_else(|| {
                ProviderError::new(
                    ProviderErrorCode::StaleSnapshot,
                    "snapshot is no longer live; observe the window again",
                )
            })?;
        let window = lease.snapshot.window.clone();
        self.policy
            .require_allowed(&window.app_identity(), Some(&window.title))?;
        self.require_integrity(window.integrity)?;
        if request.window_generation != window.generation {
            return Err(stale_generation(
                window.generation,
                request.window_generation,
            ));
        }
        let live_window = self
            .backend
            .current_window(&window)
            .map_err(|error| self.map_backend_error(error, window.integrity))?;
        if live_window.handle != window.handle
            || live_window.process_id != window.process_id
            || live_window.generation != window.generation
        {
            return Err(stale_generation(window.generation, live_window.generation));
        }
        self.policy
            .require_allowed(&live_window.app_identity(), Some(&live_window.title))?;
        self.require_integrity(live_window.integrity)?;

        let element = match request.target {
            ActionTarget::Element { index } => Some(
                lease
                    .snapshot
                    .elements
                    .iter()
                    .find(|element| element.index == index)
                    .cloned()
                    .ok_or_else(|| {
                        ProviderError::new(
                            ProviderErrorCode::StaleElement,
                            "element index does not belong to this snapshot",
                        )
                        .with_detail("snapshotId", request.snapshot_id.to_string())
                        .with_detail("elementIndex", index.to_string())
                    })?,
            ),
            ActionTarget::Coordinate { .. } => None,
        };
        validate_action_request(
            &live_window,
            &request.target,
            request.action.unapproved(),
            element.as_ref(),
        )?;
        self.consume_approval_if_required(request, element.as_ref())?;
        let action = request.action.unapproved().clone();

        let method = match request.target {
            ActionTarget::Element { .. } => self.execute_element_action(
                &live_window,
                element.as_ref().expect("element target was resolved"),
                &action,
            )?,
            ActionTarget::Coordinate {
                point,
                window_generation,
            } => {
                if window_generation != live_window.generation {
                    return Err(stale_generation(live_window.generation, window_generation));
                }
                let local_bounds = Rect {
                    left: 0,
                    top: 0,
                    right: live_window.bounds.width(),
                    bottom: live_window.bounds.height(),
                };
                if !local_bounds.contains(point) {
                    return Err(ProviderError::new(
                        ProviderErrorCode::InvalidArgument,
                        "coordinate is outside the observed window bounds",
                    ));
                }
                self.backend
                    .coordinate_action(&live_window, point, &action)
                    .map_err(|error| self.map_backend_error(error, live_window.integrity))?
            }
        };

        Ok(ActionResult {
            operation_id: request.operation_id,
            method,
            window_generation: live_window.generation,
        })
    }

    fn action_context(
        &mut self,
        snapshot_id: Uuid,
        window_generation: u64,
        target: &ActionTarget,
    ) -> Result<(WindowIdentity, Option<ElementRecord>), ProviderError> {
        let lease = self.snapshots.get(&snapshot_id).cloned().ok_or_else(|| {
            ProviderError::new(
                ProviderErrorCode::StaleSnapshot,
                "snapshot is no longer live; observe the window again",
            )
        })?;
        if lease.snapshot.window.generation != window_generation {
            return Err(stale_generation(
                lease.snapshot.window.generation,
                window_generation,
            ));
        }
        let live_window = self
            .backend
            .current_window(&lease.snapshot.window)
            .map_err(|error| self.map_backend_error(error, lease.snapshot.window.integrity))?;
        if live_window.handle != lease.snapshot.window.handle
            || live_window.process_id != lease.snapshot.window.process_id
            || live_window.generation != lease.snapshot.window.generation
        {
            return Err(stale_generation(
                lease.snapshot.window.generation,
                live_window.generation,
            ));
        }
        self.policy
            .require_allowed(&live_window.app_identity(), Some(&live_window.title))?;
        self.require_integrity(live_window.integrity)?;
        let element = match target {
            ActionTarget::Element { index } => Some(
                lease
                    .snapshot
                    .elements
                    .iter()
                    .find(|element| element.index == *index)
                    .cloned()
                    .ok_or_else(|| {
                        ProviderError::new(
                            ProviderErrorCode::StaleElement,
                            "element index does not belong to this snapshot",
                        )
                    })?,
            ),
            ActionTarget::Coordinate {
                point,
                window_generation,
            } => {
                if *window_generation != live_window.generation {
                    return Err(stale_generation(live_window.generation, *window_generation));
                }
                let local_bounds = Rect {
                    left: 0,
                    top: 0,
                    right: live_window.bounds.width(),
                    bottom: live_window.bounds.height(),
                };
                if !local_bounds.contains(*point) {
                    return Err(ProviderError::new(
                        ProviderErrorCode::InvalidArgument,
                        "coordinate is outside the observed window bounds",
                    ));
                }
                None
            }
        };
        Ok((live_window, element))
    }

    fn consume_approval_if_required(
        &mut self,
        request: &ActionRequest,
        element: Option<&ElementRecord>,
    ) -> Result<(), ProviderError> {
        if !action_requires_approval(&request.target, request.action.unapproved(), element) {
            return Ok(());
        }
        let approval_id = request.action.approval_id().ok_or_else(|| {
            ProviderError::new(
                ProviderErrorCode::ApprovalRequired,
                approval_reason(&request.target, request.action.unapproved(), element),
            )
        })?;
        let approval = self.approvals.get_mut(&approval_id).ok_or_else(|| {
            ProviderError::new(
                ProviderErrorCode::ApprovalRequired,
                "approval is missing or expired",
            )
        })?;
        if approval.request.snapshot_id != request.snapshot_id
            || approval.request.window_generation != request.window_generation
            || approval.request.target != request.target
            || approval.request.action != *request.action.unapproved()
        {
            return Err(ProviderError::new(
                ProviderErrorCode::ApprovalDenied,
                "approval does not match this exact snapshot, target, and action",
            ));
        }
        match approval.record.state {
            ApprovalState::Approved => {
                approval.record.state = ApprovalState::Consumed;
                approval.record.resolved_at_ms = Some(now_ms());
                Ok(())
            }
            ApprovalState::Pending => Err(ProviderError::new(
                ProviderErrorCode::ApprovalRequired,
                "approval is still pending",
            )),
            ApprovalState::Denied | ApprovalState::Consumed => Err(ProviderError::new(
                ProviderErrorCode::ApprovalDenied,
                "approval was denied or already consumed",
            )),
        }
    }

    fn execute_element_action(
        &mut self,
        window: &WindowIdentity,
        element: &ElementRecord,
        action: &ComputerAction,
    ) -> Result<ActionMethod, ProviderError> {
        if element.password && matches!(action, ComputerAction::SetValue { .. }) {
            return Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "set-value is not permitted for secret fields; use explicit paste-text or type-text",
            ));
        }

        if let Some(semantic) = action.preferred_semantic() {
            if element.supported_actions.contains(&semantic) {
                match self
                    .backend
                    .semantic_action(window, &element.runtime_id, semantic, action)
                {
                    Ok(()) => return Ok(ActionMethod::Semantic),
                    Err(error) if error.kind == BackendErrorKind::Unsupported => {}
                    Err(error) => {
                        return Err(self.map_backend_error(error, window.integrity));
                    }
                }
            }
        }

        if !action.allows_coordinate_fallback() {
            return Err(ProviderError::new(
                ProviderErrorCode::ActionUnsupported,
                "the requested semantic pattern is unavailable and coordinate fallback is unsafe",
            ));
        }
        let bounds = element
            .bounds
            .filter(|bounds| bounds.is_visible())
            .ok_or_else(|| {
                ProviderError::new(
                    ProviderErrorCode::ActionUnsupported,
                    "semantic action unavailable and the element has no current visible frame",
                )
            })?;
        if element.offscreen || !element.enabled {
            return Err(ProviderError::new(
                ProviderErrorCode::ActionUnsupported,
                "coordinate fallback requires a visible enabled element",
            ));
        }
        self.backend
            .coordinate_action(window, bounds.center(), action)
            .map_err(|error| self.map_backend_error(error, window.integrity))
    }

    fn require_integrity(&self, target: IntegrityLevel) -> Result<(), ProviderError> {
        let provider = self.backend.provider_integrity();
        if target.rank() > provider.rank() && provider != IntegrityLevel::Unknown {
            return Err(elevation_error(provider, target));
        }
        Ok(())
    }

    fn require_running(&self) -> Result<(), ProviderError> {
        if self.stopped {
            return Err(ProviderError::new(
                ProviderErrorCode::EmergencyStopped,
                "computer-use emergency stop is active",
            ));
        }
        Ok(())
    }

    fn map_backend_error(&self, error: BackendError, target: IntegrityLevel) -> ProviderError {
        let provider = self.backend.provider_integrity();
        if error.kind == BackendErrorKind::AccessDenied
            && target.rank() > provider.rank()
            && provider != IntegrityLevel::Unknown
        {
            return elevation_error(provider, target);
        }
        let code = match error.kind {
            BackendErrorKind::AccessDenied => ProviderErrorCode::AppBlocked,
            BackendErrorKind::StaleElement => ProviderErrorCode::StaleElement,
            BackendErrorKind::ProtectedContent => ProviderErrorCode::ProtectedContent,
            BackendErrorKind::Unsupported => ProviderErrorCode::ActionUnsupported,
            BackendErrorKind::InvalidArgument => ProviderErrorCode::InvalidArgument,
            BackendErrorKind::Timeout => ProviderErrorCode::Timeout,
            BackendErrorKind::HostFailure => ProviderErrorCode::HostFailed,
            BackendErrorKind::Internal => ProviderErrorCode::Internal,
        };
        let retryable = matches!(
            error.kind,
            BackendErrorKind::StaleElement
                | BackendErrorKind::Timeout
                | BackendErrorKind::HostFailure
        );
        let mut mapped = ProviderError::new(code, error.message);
        mapped.retryable = retryable;
        if let Some(os_code) = error.os_code {
            mapped = mapped.with_detail("osCode", os_code.to_string());
        }
        mapped
    }

    fn insert_snapshot(&mut self, snapshot: ComputerSnapshot) {
        let stale_for_window = self
            .snapshots
            .iter()
            .filter_map(|(snapshot_id, lease)| {
                (lease.snapshot.window.handle == snapshot.window.handle).then_some(*snapshot_id)
            })
            .collect::<Vec<_>>();
        for snapshot_id in stale_for_window {
            self.snapshots.remove(&snapshot_id);
            self.snapshot_order
                .retain(|candidate| *candidate != snapshot_id);
        }
        while self.snapshot_order.len() >= MAX_LIVE_SNAPSHOTS {
            if let Some(expired) = self.snapshot_order.pop_front() {
                self.snapshots.remove(&expired);
            }
        }
        self.snapshot_order.push_back(snapshot.snapshot_id);
        self.snapshots
            .insert(snapshot.snapshot_id, SnapshotLease { snapshot });
    }

    fn push_history(&mut self, record: ActionHistoryRecord) {
        while self.action_history.len() >= MAX_ACTION_HISTORY {
            self.action_history.pop_front();
        }
        self.action_history.push_back(record);
    }
}

fn validate_action_request(
    window: &WindowIdentity,
    target: &ActionTarget,
    action: &ComputerAction,
    element: Option<&ElementRecord>,
) -> Result<(), ProviderError> {
    if !window.visible || window.minimized {
        return Err(ProviderError::new(
            ProviderErrorCode::InvalidArgument,
            "window is not currently visible; observe it again with restoreWindow",
        ));
    }
    if element.is_some_and(|element| !element.enabled) {
        return Err(ProviderError::new(
            ProviderErrorCode::ActionUnsupported,
            "the selected element is disabled",
        ));
    }
    if matches!(target, ActionTarget::Coordinate { .. }) && !action.allows_coordinate_fallback() {
        return Err(ProviderError::new(
            ProviderErrorCode::ActionUnsupported,
            "this action requires a semantic element target",
        ));
    }
    let local_bounds = Rect {
        left: 0,
        top: 0,
        right: window.bounds.width(),
        bottom: window.bounds.height(),
    };
    if let ComputerAction::Drag { to } = action {
        if !local_bounds.contains(*to) {
            return Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "drag destination is outside the observed window bounds",
            ));
        }
    }
    match action {
        ComputerAction::TypeText { text }
        | ComputerAction::PasteText { text }
        | ComputerAction::SetValue { value: text }
            if text.len() > 65_536 =>
        {
            Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "computer-use text payload exceeds 65536 bytes",
            ))
        }
        ComputerAction::PressKey { key } if key.trim().is_empty() || key.len() > 64 => {
            Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "key name must contain 1 to 64 bytes",
            ))
        }
        ComputerAction::Hotkey { keys }
            if keys.len() < 2
                || keys.len() > 8
                || keys
                    .iter()
                    .any(|key| key.trim().is_empty() || key.len() > 64) =>
        {
            Err(ProviderError::new(
                ProviderErrorCode::InvalidArgument,
                "hotkey must contain 2 to 8 bounded key names",
            ))
        }
        ComputerAction::Approved { .. } => Err(ProviderError::new(
            ProviderErrorCode::Internal,
            "approved action wrapper was not removed before validation",
        )),
        _ => Ok(()),
    }
}

fn action_requires_approval(
    target: &ActionTarget,
    action: &ComputerAction,
    element: Option<&ElementRecord>,
) -> bool {
    matches!(
        action,
        ComputerAction::PasteText { .. }
            | ComputerAction::Hotkey { .. }
            | ComputerAction::SecondaryAction
            | ComputerAction::Drag { .. }
    ) || matches!(target, ActionTarget::Coordinate { .. })
        && !matches!(action, ComputerAction::Scroll { .. })
        || element.is_some_and(|element| {
            (element.password || element.redacted) && action.contains_sensitive_text()
        })
}

fn approval_reason(
    target: &ActionTarget,
    action: &ComputerAction,
    element: Option<&ElementRecord>,
) -> &'static str {
    if element.is_some_and(|element| element.password || element.redacted)
        && action.contains_sensitive_text()
    {
        "typing into a secret field requires explicit approval"
    } else if matches!(action, ComputerAction::PasteText { .. }) {
        "clipboard paste requires explicit approval"
    } else if matches!(action, ComputerAction::Hotkey { .. }) {
        "keyboard shortcuts can trigger destructive application commands"
    } else if matches!(
        action,
        ComputerAction::SecondaryAction | ComputerAction::Drag { .. }
    ) {
        "this action can open privileged menus or move application data"
    } else if matches!(target, ActionTarget::Coordinate { .. }) {
        "coordinate actions require explicit approval because they bypass semantic targeting"
    } else {
        "this computer action requires explicit approval"
    }
}

fn elevation_error(provider: IntegrityLevel, target: IntegrityLevel) -> ProviderError {
    ProviderError::new(
        ProviderErrorCode::ElevationRequired,
        "target process has a higher Windows integrity level; VibeLink will not auto-elevate",
    )
    .with_detail(
        "providerIntegrity",
        format!("{provider:?}").to_ascii_lowercase(),
    )
    .with_detail(
        "targetIntegrity",
        format!("{target:?}").to_ascii_lowercase(),
    )
}

fn stale_generation(expected: u64, actual: u64) -> ProviderError {
    ProviderError::new(
        ProviderErrorCode::StaleWindowGeneration,
        "window generation changed; observe the window again",
    )
    .with_detail("expectedGeneration", expected.to_string())
    .with_detail("actualGeneration", actual.to_string())
}

fn redact_text_fields(
    secret_values: &[String],
    tree_lines: &mut [String],
    focused_summary: &mut Option<String>,
) {
    for value in secret_values.iter().filter(|value| !value.is_empty()) {
        for line in tree_lines.iter_mut() {
            if line.contains(value) {
                *line = line.replace(value, REDACTED_VALUE);
            }
        }
        if let Some(summary) = focused_summary.as_mut() {
            if summary.contains(value) {
                *summary = summary.replace(value, REDACTED_VALUE);
            }
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

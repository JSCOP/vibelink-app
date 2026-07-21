use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fmt};
use uuid::Uuid;

pub const COMPUTER_USE_PROTOCOL_VERSION: u16 = 1;
pub const REDACTED_VALUE: &str = "<redacted>";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderCapability {
    Observe,
    Control,
    Screenshots,
    SemanticActions,
    CoordinateFallback,
    RestoreWindow,
    ClipboardPaste,
    ExplicitApprovals,
    EmergencyStop,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IntegrityLevel {
    Unknown,
    Low,
    Medium,
    High,
    System,
}

impl IntegrityLevel {
    pub fn rank(self) -> u8 {
        match self {
            Self::Unknown => 0,
            Self::Low => 1,
            Self::Medium => 2,
            Self::High => 3,
            Self::System => 4,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

impl Rect {
    pub fn width(self) -> i32 {
        self.right.saturating_sub(self.left)
    }

    pub fn height(self) -> i32 {
        self.bottom.saturating_sub(self.top)
    }

    pub fn is_visible(self) -> bool {
        self.width() > 0 && self.height() > 0
    }

    pub fn center(self) -> Point {
        Point {
            x: self.left.saturating_add(self.width() / 2),
            y: self.top.saturating_add(self.height() / 2),
        }
    }

    pub fn contains(self, point: Point) -> bool {
        point.x >= self.left && point.x < self.right && point.y >= self.top && point.y < self.bottom
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppIdentity {
    pub process_id: u32,
    pub executable_name: String,
    pub executable_path: Option<String>,
    pub integrity: IntegrityLevel,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRecord {
    pub identity: AppIdentity,
    pub display_name: String,
    pub window_count: u32,
    pub blocked: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowIdentity {
    pub handle: u64,
    pub process_id: u32,
    pub generation: u64,
    pub title: String,
    pub executable_name: String,
    pub bounds: Rect,
    pub visible: bool,
    pub minimized: bool,
    pub integrity: IntegrityLevel,
}

impl WindowIdentity {
    pub fn app_identity(&self) -> AppIdentity {
        AppIdentity {
            process_id: self.process_id,
            executable_name: self.executable_name.clone(),
            executable_path: None,
            integrity: self.integrity,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticAction {
    Invoke,
    SecondaryAction,
    Value,
    Toggle,
    SelectionItem,
    ExpandCollapse,
    Scroll,
    RangeValue,
    LegacyDefaultAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ElementRecord {
    pub index: u32,
    pub runtime_id: Vec<i32>,
    pub role: String,
    pub name: String,
    pub value: Option<String>,
    pub bounds: Option<Rect>,
    pub enabled: bool,
    pub offscreen: bool,
    pub focused: bool,
    pub password: bool,
    pub redacted: bool,
    pub supported_actions: Vec<SemanticAction>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotTruncation {
    pub node_limit_reached: bool,
    pub depth_limit_reached: bool,
    pub omitted_nodes: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScreenshotArtifact {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub format: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSnapshot {
    pub snapshot_id: Uuid,
    pub window: WindowIdentity,
    pub tree_lines: Vec<String>,
    pub focused_summary: Option<String>,
    pub selected_text: Option<String>,
    pub elements: Vec<ElementRecord>,
    pub screenshot: Option<ScreenshotArtifact>,
    pub truncation: SnapshotTruncation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotLimits {
    pub max_nodes: u32,
    pub max_depth: u16,
}

impl Default for SnapshotLimits {
    fn default() -> Self {
        Self {
            max_nodes: 5_000,
            max_depth: 64,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotRequest {
    pub operation_id: Uuid,
    pub window: WindowIdentity,
    #[serde(default)]
    pub no_screenshot: bool,
    #[serde(default)]
    pub restore_window: bool,
    #[serde(default)]
    pub limits: SnapshotLimits,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ActionTarget {
    Element {
        index: u32,
    },
    Coordinate {
        point: Point,
        window_generation: u64,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerActionKind {
    Click,
    Invoke,
    SecondaryAction,
    Scroll,
    Drag,
    TypeText,
    PressKey,
    Hotkey,
    PasteText,
    SetValue,
    Toggle,
    Select,
    Expand,
    Collapse,
    SetRangeValue,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum ComputerAction {
    Click,
    Invoke,
    SecondaryAction,
    Scroll {
        delta_x: i32,
        delta_y: i32,
    },
    Drag {
        to: Point,
    },
    TypeText {
        text: String,
    },
    PressKey {
        key: String,
    },
    Hotkey {
        keys: Vec<String>,
    },
    PasteText {
        text: String,
    },
    SetValue {
        value: String,
    },
    Toggle,
    Select,
    Expand,
    Collapse,
    SetRangeValue {
        value: i64,
    },
    Approved {
        approval_id: Uuid,
        action: Box<ComputerAction>,
    },
}

impl ComputerAction {
    pub fn kind(&self) -> ComputerActionKind {
        match self.unapproved() {
            Self::Click => ComputerActionKind::Click,
            Self::Invoke => ComputerActionKind::Invoke,
            Self::SecondaryAction => ComputerActionKind::SecondaryAction,
            Self::Scroll { .. } => ComputerActionKind::Scroll,
            Self::Drag { .. } => ComputerActionKind::Drag,
            Self::TypeText { .. } => ComputerActionKind::TypeText,
            Self::PressKey { .. } => ComputerActionKind::PressKey,
            Self::Hotkey { .. } => ComputerActionKind::Hotkey,
            Self::PasteText { .. } => ComputerActionKind::PasteText,
            Self::SetValue { .. } => ComputerActionKind::SetValue,
            Self::Toggle => ComputerActionKind::Toggle,
            Self::Select => ComputerActionKind::Select,
            Self::Expand => ComputerActionKind::Expand,
            Self::Collapse => ComputerActionKind::Collapse,
            Self::SetRangeValue { .. } => ComputerActionKind::SetRangeValue,
            Self::Approved { .. } => unreachable!("unapproved removes approval wrappers"),
        }
    }

    pub fn preferred_semantic(&self) -> Option<SemanticAction> {
        match self.unapproved() {
            Self::Click | Self::Invoke => Some(SemanticAction::Invoke),
            Self::SecondaryAction => Some(SemanticAction::SecondaryAction),
            Self::SetValue { .. } => Some(SemanticAction::Value),
            Self::Toggle => Some(SemanticAction::Toggle),
            Self::Select => Some(SemanticAction::SelectionItem),
            Self::Expand | Self::Collapse => Some(SemanticAction::ExpandCollapse),
            Self::Scroll { .. } => Some(SemanticAction::Scroll),
            Self::SetRangeValue { .. } => Some(SemanticAction::RangeValue),
            Self::Drag { .. }
            | Self::TypeText { .. }
            | Self::PressKey { .. }
            | Self::Hotkey { .. }
            | Self::PasteText { .. } => None,
            Self::Approved { .. } => unreachable!("unapproved removes approval wrappers"),
        }
    }

    pub fn allows_coordinate_fallback(&self) -> bool {
        !matches!(
            self.unapproved(),
            Self::Invoke | Self::SetValue { .. } | Self::SetRangeValue { .. }
        )
    }

    pub fn contains_sensitive_text(&self) -> bool {
        matches!(
            self.unapproved(),
            Self::TypeText { .. } | Self::PasteText { .. } | Self::SetValue { .. }
        )
    }

    pub fn approval_id(&self) -> Option<Uuid> {
        match self {
            Self::Approved { approval_id, .. } => Some(*approval_id),
            _ => None,
        }
    }

    pub fn unapproved(&self) -> &ComputerAction {
        match self {
            Self::Approved { action, .. } => action.unapproved(),
            action => action,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionRequest {
    pub operation_id: Uuid,
    pub snapshot_id: Uuid,
    pub window_generation: u64,
    pub target: ActionTarget,
    pub action: ComputerAction,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ActionMethod {
    Semantic,
    Coordinate,
    Keyboard,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub operation_id: Uuid,
    pub method: ActionMethod,
    pub window_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionHistoryRecord {
    pub operation_id: Uuid,
    pub snapshot_id: Uuid,
    pub window_handle: u64,
    pub action: ComputerActionKind,
    pub method: Option<ActionMethod>,
    pub approval_id: Option<Uuid>,
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub error: Option<ProviderErrorCode>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalState {
    Pending,
    Approved,
    Denied,
    Consumed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRequest {
    pub operation_id: Uuid,
    pub snapshot_id: Uuid,
    pub window_generation: u64,
    pub target: ActionTarget,
    pub action: ComputerAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    pub approval_id: Uuid,
    pub operation_id: Uuid,
    pub snapshot_id: Uuid,
    pub window_handle: u64,
    pub window_title: String,
    pub action: ComputerActionKind,
    pub state: ApprovalState,
    pub reason: String,
    pub created_at_ms: u64,
    pub resolved_at_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub running: bool,
    pub emergency_stopped: bool,
    pub host_generation: u64,
    pub host_process_id: Option<u32>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorCode {
    Unauthorized,
    FrameTooLarge,
    InvalidFrame,
    InvalidArgument,
    NotFound,
    StaleSnapshot,
    StaleElement,
    StaleWindowGeneration,
    AppBlocked,
    ElevationRequired,
    ProtectedContent,
    ApprovalRequired,
    ApprovalDenied,
    EmergencyStopped,
    ActionUnsupported,
    ProviderUnavailable,
    HostFailed,
    HostRestarted,
    OwnershipMismatch,
    Timeout,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub code: ProviderErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub details: BTreeMap<String, String>,
}
impl ProviderError {
    pub fn new(code: ProviderErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: BTreeMap::new(),
        }
    }

    pub fn retryable(mut self) -> Self {
        self.retryable = true;
        self
    }

    pub fn with_detail(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.details.insert(key.into(), value.into());
        self
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for ProviderError {}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendErrorKind {
    AccessDenied,
    StaleElement,
    ProtectedContent,
    Unsupported,
    InvalidArgument,
    Timeout,
    HostFailure,
    Internal,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackendError {
    pub kind: BackendErrorKind,
    pub message: String,
    pub os_code: Option<i32>,
}

impl BackendError {
    pub fn new(kind: BackendErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            os_code: None,
        }
    }

    pub fn with_os_code(mut self, os_code: i32) -> Self {
        self.os_code = Some(os_code);
        self
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RawSnapshot {
    pub window: WindowIdentity,
    pub tree_lines: Vec<String>,
    pub focused_summary: Option<String>,
    pub selected_text: Option<String>,
    pub elements: Vec<ElementRecord>,
    pub truncation: SnapshotTruncation,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "method")]
pub enum HostRequest {
    Capabilities,
    ProviderStatus,
    RestartProvider,
    ListApps,
    ListWindows { process_id: Option<u32> },
    Snapshot { request: SnapshotRequest },
    ApprovalCreate { request: ApprovalRequest },
    ApprovalResolve { approval_id: Uuid, approved: bool },
    ApprovalList { limit: u32 },
    Action { request: ActionRequest },
    ActionHistory { limit: u32 },
    EmergencyStop,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case", tag = "kind", content = "data")]
pub enum HostResponseBody {
    Capabilities(Vec<ProviderCapability>),
    ProviderStatus(ProviderStatus),
    Apps(Vec<AppRecord>),
    Windows(Vec<WindowIdentity>),
    Snapshot(ComputerSnapshot),
    Approval(ApprovalRecord),
    Approvals(Vec<ApprovalRecord>),
    Action(ActionResult),
    ActionHistory(Vec<ActionHistoryRecord>),
    Stopped,
}

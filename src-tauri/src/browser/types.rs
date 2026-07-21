use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub type PageId = String;
pub type ProfileId = String;
pub type SnapshotId = String;
pub type BrowserRef = String;
pub type VisibilityLeaseToken = String;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserLoadState {
    Idle,
    Loading,
    Loaded,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum BrowserRiskCapability {
    Cookies,
    Storage,
    Upload,
    Download,
    Evaluate,
    LocalFiles,
}

impl BrowserRiskCapability {
    pub fn grant_name(self) -> &'static str {
        match self {
            Self::Cookies => "browser.cookies",
            Self::Storage => "browser.storage",
            Self::Upload => "browser.upload",
            Self::Download => "browser.download",
            Self::Evaluate => "browser.evaluate",
            Self::LocalFiles => "browser.file",
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDeviceMetrics {
    pub width: u32,
    pub height: u32,
    pub device_scale_factor: f64,
    pub mobile: bool,
}

impl BrowserDeviceMetrics {
    pub fn validate(self) -> bool {
        (1..=10_000).contains(&self.width)
            && (1..=10_000).contains(&self.height)
            && self.device_scale_factor.is_finite()
            && (0.1..=8.0).contains(&self.device_scale_factor)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PhysicalBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale_factor_milli: u32,
}

impl PhysicalBounds {
    pub fn validate(self) -> bool {
        self.width > 0 && self.height > 0 && self.scale_factor_milli > 0
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProfileKind {
    Persistent,
    Workspace,
    Incognito,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProfile {
    pub id: ProfileId,
    pub kind: ProfileKind,
    pub workspace_id: Option<String>,
    pub user_data_dir: Option<PathBuf>,
    pub page_ids: Vec<PageId>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChildWebViewCreate {
    pub page_id: PageId,
    pub label: String,
    pub profile_id: ProfileId,
    pub workspace_id: String,
    pub user_data_dir: Option<PathBuf>,
    pub initial_url: String,
    pub bounds: PhysicalBounds,
    pub external_guest: bool,
    pub tauri_ipc_allowed: bool,
    pub app_initialization_allowed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ChildWebViewState {
    pub page_id: PageId,
    pub bounds: PhysicalBounds,
    pub visible: bool,
    pub focused: bool,
    pub realized: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserPage {
    pub id: PageId,
    pub workspace_id: String,
    pub profile_id: ProfileId,
    pub url: String,
    pub title: String,
    pub navigation_generation: u64,
    pub current_snapshot_id: Option<SnapshotId>,
    pub bounds: PhysicalBounds,
    pub requested_visible: bool,
    pub effective_visible: bool,
    pub focused: bool,
    pub visibility_lease_count: usize,
    pub load_state: BrowserLoadState,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub last_error: Option<String>,
    pub device_metrics: Option<BrowserDeviceMetrics>,
    pub dropped_frame_count: u64,
    pub latest_frame_sequence: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotSource {
    Accessibility,
    DomFallback,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotNodeInput {
    pub role: String,
    pub name: String,
    pub backend_dom_id: u64,
    pub frame_id: String,
    pub session_id: String,
    pub bounds: Option<PhysicalBounds>,
    pub supported_actions: Vec<String>,
    pub source: SnapshotSource,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotNodeRecord {
    pub browser_ref: BrowserRef,
    pub role: String,
    pub name: String,
    pub duplicate_ordinal: u32,
    pub backend_dom_id: u64,
    pub frame_id: String,
    pub session_id: String,
    pub bounds: Option<PhysicalBounds>,
    pub supported_actions: Vec<String>,
    pub source: SnapshotSource,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSnapshot {
    pub page_id: PageId,
    pub navigation_generation: u64,
    pub snapshot_id: SnapshotId,
    pub nodes: Vec<SnapshotNodeRecord>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryCandidate {
    pub role: String,
    pub name: String,
    pub duplicate_ordinal: u32,
    pub backend_dom_id: u64,
    pub frame_id: String,
    pub session_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedBrowserRef {
    pub page_id: PageId,
    pub browser_ref: BrowserRef,
    pub backend_dom_id: u64,
    pub frame_id: String,
    pub session_id: String,
    pub recovered: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactDescriptor {
    pub path: PathBuf,
    pub content_type: String,
    pub bytes: u64,
    pub expires_at_ms: u64,
    pub truncated: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReservedDownload {
    pub path: PathBuf,
    pub file_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFrame {
    pub page_id: PageId,
    pub sequence: u64,
    pub navigation_generation: u64,
    pub width: u32,
    pub height: u32,
    pub format: String,
    pub bytes: Vec<u8>,
    pub captured_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCaptureState {
    pub page_id: PageId,
    pub pending_frames: usize,
    pub dropped_frames: u64,
    pub latest_sequence: Option<u64>,
    pub latest_bytes: Option<u64>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserLifecycleEventKind {
    PageCreated,
    PageClosed,
    PopupRequested,
    NavigationStarted,
    NavigationCommitted,
    NavigationFinished,
    NavigationFailed,
    TitleChanged,
    DownloadRequested,
    DownloadFinished,
    DialogRequested,
    PermissionRequested,
    CertificateError,
    CaptureUpdated,
    DeviceMetricsChanged,
    Restored,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserLifecycleEvent {
    pub sequence: u64,
    pub page_id: PageId,
    pub navigation_generation: u64,
    pub kind: BrowserLifecycleEventKind,
    pub url: Option<String>,
    pub detail: Option<String>,
    pub timestamp_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum BrowserDialogKind {
    Alert,
    Confirm,
    Prompt,
    BeforeUnload,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDialogRequest {
    pub id: String,
    pub page_id: PageId,
    pub origin: String,
    pub kind: BrowserDialogKind,
    pub message: String,
    pub default_text: Option<String>,
    pub requested_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserDownloadRecord {
    pub id: String,
    pub page_id: PageId,
    pub url: String,
    pub path: Option<PathBuf>,
    pub success: Option<bool>,
    pub error: Option<String>,
    pub updated_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    AllowForOrigin,
    Deny,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub id: String,
    pub page_id: PageId,
    pub origin: String,
    pub permission: String,
    pub requested_at_ms: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CertificateDecision {
    AllowForOrigin,
    Deny,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CertificateRequest {
    pub id: String,
    pub page_id: PageId,
    pub origin: String,
    pub error_code: String,
    pub requested_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesignGrabSelection {
    pub page_id: PageId,
    pub navigation_generation: u64,
    pub snapshot_id: SnapshotId,
    pub browser_ref: BrowserRef,
    pub screenshot_crop: Option<ArtifactDescriptor>,
    pub dom_ancestry: Vec<String>,
    pub accessible_name: String,
    pub bounds: PhysicalBounds,
    pub computed_styles: Vec<(String, String)>,
    pub attributes: Vec<(String, String)>,
    pub text: String,
    pub source_hints: Vec<String>,
}

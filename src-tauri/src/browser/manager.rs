use super::{
    error::{BrowserError, BrowserErrorCode, BrowserResult},
    policy::BrowserPolicy,
    provider::BrowserProvider,
    types::{
        ArtifactDescriptor, BrowserAnnotation, BrowserAnnotationInput, BrowserCaptureState,
        BrowserCookieImportInput, BrowserCookieImportResult, BrowserCookieImportSource,
        BrowserDeviceMetrics, BrowserDialogKind, BrowserDialogRequest, BrowserDownloadRecord,
        BrowserFrame, BrowserLifecycleEvent, BrowserLifecycleEventKind, BrowserLoadState,
        BrowserPage, BrowserProfile, BrowserRef, BrowserSnapshot, CertificateDecision,
        CertificateRequest, ChildWebViewCreate, PermissionDecision, PermissionRequest,
        PhysicalBounds, ProfileKind, RecoveryCandidate, ResolvedBrowserRef, SnapshotNodeInput,
        SnapshotNodeRecord, VisibilityLeaseToken,
    },
};
use crate::dedicated_cli::browser_page::{
    BrowserInspectSnapshot, BrowserJpegCaptureOptions, BrowserJpegFrame, BrowserKeyInput,
    BrowserPageScale, BrowserPointerInput,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const DEFAULT_URL: &str = "about:blank";
const DEFAULT_FRAME_QUEUE_CAPACITY: usize = 2;
const MAX_BROWSER_FRAME_BYTES: usize = 16 * 1024 * 1024;
const MAX_SNAPSHOT_NODES: usize = 5_000;
// Conservative initial caps, not measured limits; tune only with production evidence.
const MAX_LIFECYCLE_EVENTS: usize = 4_096;
const MAX_DOWNLOAD_RECORDS: usize = 1_024;
const BROWSER_RESTORE_VERSION: u8 = 1;
const MAX_BROWSER_RESTORE_BYTES: u64 = 4 * 1024 * 1024;
const TRANSIENT_CAPTURE_TTL_MS: u64 = 10 * 60 * 1_000;
const PROMOTED_ANNOTATION_TTL_MS: u64 = 24 * 60 * 60 * 1_000;
const ARTIFACT_SWEEP_INTERVAL_MS: u64 = 60 * 1_000;
const ARTIFACT_DESCRIPTOR_VERSION: u8 = 1;
const MAX_ARTIFACT_DESCRIPTOR_BYTES: u64 = 64 * 1024;
#[cfg(windows)]
const WINDOWS_RESTORE_RETRY_ATTEMPTS: usize = 8;
#[cfg(windows)]
const WINDOWS_RESTORE_RETRY_DELAY_MS: u64 = 20;

#[derive(Clone, Debug)]
struct StoredSnapshot {
    public: BrowserSnapshot,
    recovery_attempted: HashSet<BrowserRef>,
}

#[derive(Clone, Debug)]
struct PageState {
    public: BrowserPage,
    surface_owner_generation: u64,
    visibility_leases: HashMap<VisibilityLeaseToken, String>,
    snapshot_sequence: u64,
    snapshot: Option<StoredSnapshot>,
    frames: LatestFrameQueue,
}

#[derive(Clone, Debug)]
struct ProfileState {
    public: BrowserProfile,
}

#[derive(Clone, Copy, Debug)]
enum HistoryMutationKind {
    Back,
    Forward,
    Reload,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserRestoreDocument {
    version: u8,
    profiles: Vec<RestoreProfile>,
    pages: Vec<RestorePage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestoreProfile {
    id: String,
    kind: ProfileKind,
    workspace_id: Option<String>,
    #[serde(default)]
    cookie_import_quarantined: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RestorePage {
    id: String,
    workspace_id: String,
    profile_id: String,
    url: String,
    title: String,
    bounds: PhysicalBounds,
    device_metrics: Option<BrowserDeviceMetrics>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactCleanupRecord {
    version: u8,
    descriptor: ArtifactDescriptor,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativePermissionDetail {
    request_id: String,
    permission: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeCertificateDetail {
    request_id: String,
    error_code: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeDialogDetail {
    request_id: String,
    kind: BrowserDialogKind,
    message: String,
    default_text: Option<String>,
}

#[derive(Clone, Debug)]
pub struct LatestFrameQueue {
    page_id: String,
    capacity: usize,
    max_frame_bytes: usize,
    frames: VecDeque<BrowserFrame>,
    dropped_frames: u64,
}

impl LatestFrameQueue {
    pub fn new(
        page_id: impl Into<String>,
        capacity: usize,
        max_frame_bytes: usize,
    ) -> BrowserResult<Self> {
        if capacity == 0 || capacity > 8 {
            return Err(BrowserError::invalid(
                "browser frame capacity must be between 1 and 8",
            ));
        }
        if max_frame_bytes == 0 {
            return Err(BrowserError::invalid(
                "browser frame byte limit must be greater than zero",
            ));
        }
        Ok(Self {
            page_id: page_id.into(),
            capacity,
            max_frame_bytes,
            frames: VecDeque::with_capacity(capacity),
            dropped_frames: 0,
        })
    }

    pub fn push(&mut self, frame: BrowserFrame) -> BrowserResult<BrowserCaptureState> {
        if frame.page_id != self.page_id {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser frame page identity does not match its queue",
            ));
        }
        if frame.width == 0 || frame.height == 0 || frame.bytes.is_empty() {
            return Err(BrowserError::invalid("browser frame is empty"));
        }
        if frame.bytes.len() > self.max_frame_bytes {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser frame exceeds the bounded capture size",
            ));
        }
        if self
            .frames
            .back()
            .is_some_and(|current| frame.sequence <= current.sequence)
        {
            return Err(BrowserError::new(
                BrowserErrorCode::Conflict,
                "browser frame sequence must increase monotonically",
            ));
        }
        while self.frames.len() >= self.capacity {
            self.frames.pop_front();
            self.dropped_frames = self.dropped_frames.saturating_add(1);
        }
        self.frames.push_back(frame);
        Ok(self.status())
    }

    pub fn take_latest(&mut self) -> Option<BrowserFrame> {
        let latest = self.frames.pop_back();
        self.dropped_frames = self.dropped_frames.saturating_add(self.frames.len() as u64);
        self.frames.clear();
        latest
    }

    pub fn status(&self) -> BrowserCaptureState {
        BrowserCaptureState {
            page_id: self.page_id.clone(),
            pending_frames: self.frames.len(),
            dropped_frames: self.dropped_frames,
            latest_sequence: self.frames.back().map(|frame| frame.sequence),
            latest_bytes: self.frames.back().map(|frame| frame.bytes.len() as u64),
        }
    }
}

#[derive(Default)]
struct ManagerState {
    profiles: HashMap<String, ProfileState>,
    pages: HashMap<String, PageState>,
    permissions: VecDeque<PermissionRequest>,
    certificates: VecDeque<CertificateRequest>,
    dialogs: VecDeque<BrowserDialogRequest>,
    downloads: VecDeque<BrowserDownloadRecord>,
    events: VecDeque<BrowserLifecycleEvent>,
    event_sequence: u64,
}

pub struct BrowserManager<P: BrowserProvider> {
    provider: Arc<P>,
    policy: BrowserPolicy,
    profile_root: PathBuf,
    restore_path: PathBuf,
    restored_workspaces: Mutex<HashSet<String>>,
    tombstoned_pages: Mutex<HashSet<String>>,
    persistence: Mutex<()>,
    workspace_mutations: Mutex<()>,
    event_pump: Mutex<()>,
    provider_persistence_dirty: Mutex<bool>,
    state: Mutex<ManagerState>,
    page_mutations: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    last_artifact_sweep_ms: Mutex<u64>,
}

impl<P: BrowserProvider> BrowserManager<P> {
    pub fn new(provider: Arc<P>, policy: BrowserPolicy, profile_root: PathBuf) -> Self {
        let restore_path = profile_root
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("state.json");
        let manager = Self {
            provider,
            policy,
            profile_root,
            restore_path,
            restored_workspaces: Mutex::new(HashSet::new()),
            tombstoned_pages: Mutex::new(HashSet::new()),
            persistence: Mutex::new(()),
            workspace_mutations: Mutex::new(()),
            event_pump: Mutex::new(()),
            provider_persistence_dirty: Mutex::new(false),
            state: Mutex::new(ManagerState::default()),
            page_mutations: Mutex::new(HashMap::new()),
            last_artifact_sweep_ms: Mutex::new(0),
        };
        let _ = manager.restore_profile_metadata();
        let _ = manager.sweep_expired_artifacts(true);
        manager
    }

    pub fn create_profile(
        &self,
        id: impl Into<String>,
        kind: ProfileKind,
        workspace_id: Option<String>,
    ) -> BrowserResult<BrowserProfile> {
        let _workspace_mutation = lock(&self.workspace_mutations)?;
        self.create_profile_locked(id, kind, workspace_id)
    }

    fn create_profile_locked(
        &self,
        id: impl Into<String>,
        kind: ProfileKind,
        workspace_id: Option<String>,
    ) -> BrowserResult<BrowserProfile> {
        let id = id.into();
        validate_identifier("profile", &id)?;
        if matches!(kind, ProfileKind::Workspace | ProfileKind::Imported)
            && workspace_id.as_deref().unwrap_or_default().is_empty()
        {
            return Err(BrowserError::invalid(
                "workspace and imported profiles require a workspace id",
            ));
        }
        if let Some(workspace_id) = workspace_id.as_deref() {
            validate_identifier("workspace", workspace_id)?;
        }
        let user_data_dir = match kind {
            ProfileKind::Incognito => None,
            ProfileKind::Persistent | ProfileKind::Workspace | ProfileKind::Imported => {
                Some(vibelink_owned_profile_path(&self.profile_root, &id)?)
            }
        };
        let profile = BrowserProfile {
            id: id.clone(),
            kind,
            workspace_id,
            user_data_dir,
            page_ids: Vec::new(),
            cookie_import_quarantined: false,
        };
        let mut state = lock(&self.state)?;
        if state.profiles.contains_key(&id) {
            return Err(BrowserError::new(
                BrowserErrorCode::Conflict,
                format!("profile already exists: {id}"),
            ));
        }
        state.profiles.insert(
            id,
            ProfileState {
                public: profile.clone(),
            },
        );
        Ok(profile)
    }

    pub fn profiles(&self) -> BrowserResult<Vec<BrowserProfile>> {
        let state = lock(&self.state)?;
        let mut profiles = state
            .profiles
            .values()
            .map(|profile| profile.public.clone())
            .collect::<Vec<_>>();
        profiles.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(profiles)
    }

    pub fn create_page(
        &self,
        page_id: impl Into<String>,
        workspace_id: impl Into<String>,
        profile_id: &str,
        bounds: PhysicalBounds,
    ) -> BrowserResult<BrowserPage> {
        let _workspace_mutation = lock(&self.workspace_mutations)?;
        self.create_page_locked_with_url(
            page_id,
            workspace_id,
            profile_id,
            bounds,
            DEFAULT_URL,
            "New Tab",
        )
    }

    fn create_page_locked_with_url(
        &self,
        page_id: impl Into<String>,
        workspace_id: impl Into<String>,
        profile_id: &str,
        bounds: PhysicalBounds,
        initial_url: &str,
        title: &str,
    ) -> BrowserResult<BrowserPage> {
        let page_id = page_id.into();
        let workspace_id = workspace_id.into();
        validate_identifier("page", &page_id)?;
        validate_identifier("workspace", &workspace_id)?;
        if !bounds.validate() {
            return Err(BrowserError::invalid(
                "child WebView bounds must be non-zero physical pixels",
            ));
        }

        let mut state = lock(&self.state)?;
        if state.pages.contains_key(&page_id) {
            return Err(BrowserError::new(
                BrowserErrorCode::Conflict,
                format!("page already exists: {page_id}"),
            ));
        }
        let profile = state
            .profiles
            .get(profile_id)
            .ok_or_else(|| BrowserError::not_found(profile_id))?;
        if let Some(profile_workspace) = profile.public.workspace_id.as_deref() {
            if profile_workspace != workspace_id {
                return Err(BrowserError::new(
                    BrowserErrorCode::DeniedCapability,
                    "workspace profile cannot be shared across workspaces",
                ));
            }
        }
        let create = ChildWebViewCreate {
            page_id: page_id.clone(),
            label: format!("browser-guest-{page_id}"),
            profile_id: profile_id.to_string(),
            workspace_id: workspace_id.clone(),
            user_data_dir: profile.public.user_data_dir.clone(),
            initial_url: initial_url.to_string(),
            bounds,
            external_guest: true,
            tauri_ipc_allowed: false,
            app_initialization_allowed: false,
        };
        self.provider.create_child_webview(&create)?;
        if let Err(error) = self.provider.set_visible(&page_id, false) {
            let _ = self.provider.close(&page_id);
            return Err(error);
        }

        let page = BrowserPage {
            id: page_id.clone(),
            workspace_id,
            profile_id: profile_id.to_string(),
            url: initial_url.to_string(),
            title: title.to_string(),
            navigation_generation: 0,
            current_snapshot_id: None,
            bounds,
            requested_visible: false,
            effective_visible: false,
            focused: false,
            visibility_lease_count: 0,
            load_state: if initial_url == DEFAULT_URL {
                BrowserLoadState::Idle
            } else {
                BrowserLoadState::Loading
            },
            can_go_back: false,
            can_go_forward: false,
            last_error: None,
            device_metrics: None,
            dropped_frame_count: 0,
            latest_frame_sequence: None,
        };
        state.pages.insert(
            page_id.clone(),
            PageState {
                public: page.clone(),
                surface_owner_generation: 0,
                visibility_leases: HashMap::new(),
                snapshot_sequence: 0,
                snapshot: None,
                frames: LatestFrameQueue::new(
                    page_id.clone(),
                    DEFAULT_FRAME_QUEUE_CAPACITY,
                    MAX_BROWSER_FRAME_BYTES,
                )?,
            },
        );
        state
            .profiles
            .get_mut(profile_id)
            .expect("profile checked before provider creation")
            .public
            .page_ids
            .push(page_id.clone());
        push_event_locked(
            &mut state,
            &page_id,
            0,
            BrowserLifecycleEventKind::PageCreated,
            Some(initial_url.to_string()),
            Some(profile_id.to_string()),
        );
        lock(&self.page_mutations)?.insert(page_id, Arc::new(Mutex::new(())));
        Ok(page)
    }

    pub fn page(&self, page_id: &str) -> BrowserResult<BrowserPage> {
        let state = lock(&self.state)?;
        state
            .pages
            .get(page_id)
            .map(|page| page.public.clone())
            .ok_or_else(|| BrowserError::not_found(page_id))
    }

    pub fn mark_page_persistence_error(
        &self,
        page_id: &str,
        message: impl Into<String>,
    ) -> BrowserResult<BrowserPage> {
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.public.last_error = Some(message.into());
        Ok(page.public.clone())
    }

    pub fn rollback_empty_profile(&self, profile_id: &str) -> BrowserResult<()> {
        let user_data_dir = {
            let state = lock(&self.state)?;
            let profile = state
                .profiles
                .get(profile_id)
                .ok_or_else(|| BrowserError::not_found(profile_id))?;
            if !profile.public.page_ids.is_empty() {
                return Err(BrowserError::new(
                    BrowserErrorCode::Conflict,
                    "browser profile rollback requires an empty profile",
                ));
            }
            profile.public.user_data_dir.clone()
        };
        self.provider.release_profile(profile_id)?;
        lock(&self.state)?.profiles.remove(profile_id);
        if let Some(directory) = user_data_dir {
            self.remove_owned_profile_directory(&directory)?;
        }
        Ok(())
    }

    pub fn pages(&self) -> BrowserResult<Vec<BrowserPage>> {
        let state = lock(&self.state)?;
        let mut pages = state
            .pages
            .values()
            .map(|page| page.public.clone())
            .collect::<Vec<_>>();
        pages.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(pages)
    }

    pub fn select_page(
        &self,
        workspace_id: &str,
        page_id: &str,
    ) -> BrowserResult<Vec<BrowserPage>> {
        let page_ids = {
            let state = lock(&self.state)?;
            let selected = state
                .pages
                .get(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            if selected.public.workspace_id != workspace_id {
                return Err(BrowserError::new(
                    BrowserErrorCode::DeniedCapability,
                    "selected browser page belongs to another workspace",
                ));
            }
            state
                .pages
                .values()
                .filter(|page| page.public.workspace_id == workspace_id)
                .map(|page| page.public.id.clone())
                .collect::<Vec<_>>()
        };
        for candidate in &page_ids {
            let selected = candidate == page_id;
            self.set_visible(candidate, selected)?;
            self.set_focus(candidate, selected)?;
        }
        let state = lock(&self.state)?;
        Ok(page_ids
            .iter()
            .filter_map(|candidate| state.pages.get(candidate).map(|page| page.public.clone()))
            .collect())
    }

    pub fn navigate(&self, page_id: &str, input: &str) -> BrowserResult<BrowserPage> {
        self.sync_provider_events()?;
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let url = self.policy.normalize_navigation(input)?;
        let next_generation = {
            let state = lock(&self.state)?;
            let page = state
                .pages
                .get(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            if page.public.load_state == BrowserLoadState::Loading {
                return Err(BrowserError::new(
                    BrowserErrorCode::Conflict,
                    "browser navigation is already in progress",
                ));
            }
            page.public
                .navigation_generation
                .checked_add(1)
                .ok_or_else(|| {
                    BrowserError::new(
                        BrowserErrorCode::Internal,
                        "navigation generation exhausted",
                    )
                })?
        };
        self.provider.navigate(page_id, &url, next_generation)?;
        let mut state = lock(&self.state)?;
        let result = {
            let page = state
                .pages
                .get_mut(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            if page.public.url != url && page.public.url != DEFAULT_URL {
                page.public.can_go_back = true;
            }
            page.public.can_go_forward = false;
            page.public.url = url.clone();
            page.public.navigation_generation = next_generation;
            page.public.current_snapshot_id = None;
            page.public.load_state = BrowserLoadState::Loading;
            page.public.last_error = None;
            page.snapshot = None;
            page.public.clone()
        };
        push_event_locked(
            &mut state,
            page_id,
            next_generation,
            BrowserLifecycleEventKind::NavigationStarted,
            Some(url),
            None,
        );
        Ok(result)
    }

    pub fn go_back(&self, page_id: &str) -> BrowserResult<BrowserPage> {
        self.history_mutation(page_id, HistoryMutationKind::Back, |provider| {
            provider.go_back(page_id)
        })
    }

    pub fn go_forward(&self, page_id: &str) -> BrowserResult<BrowserPage> {
        self.history_mutation(page_id, HistoryMutationKind::Forward, |provider| {
            provider.go_forward(page_id)
        })
    }

    pub fn reload(&self, page_id: &str) -> BrowserResult<BrowserPage> {
        self.history_mutation(page_id, HistoryMutationKind::Reload, |provider| {
            provider.reload(page_id)
        })
    }

    pub fn set_design_mode(&self, page_id: &str, enabled: bool) -> BrowserResult<()> {
        self.provider.set_design_mode(page_id, enabled)
    }

    pub fn set_device_metrics(
        &self,
        page_id: &str,
        metrics: BrowserDeviceMetrics,
    ) -> BrowserResult<BrowserPage> {
        if !metrics.validate() {
            return Err(BrowserError::invalid("invalid browser device metrics"));
        }
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let current_generation = self.page(page_id)?.navigation_generation;
        let next_generation = current_generation.checked_add(1).ok_or_else(|| {
            BrowserError::new(
                BrowserErrorCode::Internal,
                "browser view generation exhausted",
            )
        })?;
        self.provider
            .set_navigation_generation(page_id, next_generation)?;
        if let Err(error) = self.provider.set_device_metrics(page_id, metrics) {
            let _ = self
                .provider
                .set_navigation_generation(page_id, current_generation);
            return Err(error);
        }
        let mut state = lock(&self.state)?;
        let result = {
            let page = state
                .pages
                .get_mut(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            page.public.device_metrics = Some(metrics);
            page.public.navigation_generation = next_generation;
            page.public.current_snapshot_id = None;
            page.snapshot = None;
            page.public.clone()
        };
        push_event_locked(
            &mut state,
            page_id,
            next_generation,
            BrowserLifecycleEventKind::DeviceMetricsChanged,
            None,
            Some(format!(
                "{}x{}@{} mobile={}",
                metrics.width, metrics.height, metrics.device_scale_factor, metrics.mobile
            )),
        );
        Ok(result)
    }
    pub fn clear_device_metrics(&self, page_id: &str) -> BrowserResult<BrowserPage> {
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let current_generation = self.page(page_id)?.navigation_generation;
        let next_generation = current_generation.checked_add(1).ok_or_else(|| {
            BrowserError::new(
                BrowserErrorCode::Internal,
                "browser view generation exhausted",
            )
        })?;
        self.provider
            .set_navigation_generation(page_id, next_generation)?;
        if let Err(error) = self.provider.clear_device_metrics(page_id) {
            let _ = self
                .provider
                .set_navigation_generation(page_id, current_generation);
            return Err(error);
        }
        let mut state = lock(&self.state)?;
        let result = {
            let page = state
                .pages
                .get_mut(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            page.public.device_metrics = None;
            page.public.navigation_generation = next_generation;
            page.public.current_snapshot_id = None;
            page.snapshot = None;
            page.public.clone()
        };
        push_event_locked(
            &mut state,
            page_id,
            next_generation,
            BrowserLifecycleEventKind::DeviceMetricsChanged,
            None,
            Some("restored desktop viewport".to_string()),
        );
        Ok(result)
    }

    pub fn set_page_scale(
        &self,
        page_id: &str,
        scale: BrowserPageScale,
    ) -> BrowserResult<BrowserPage> {
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let current_generation = self.page(page_id)?.navigation_generation;
        let next_generation = current_generation.checked_add(1).ok_or_else(|| {
            BrowserError::new(
                BrowserErrorCode::Internal,
                "browser view generation exhausted",
            )
        })?;
        self.provider
            .set_navigation_generation(page_id, next_generation)?;
        if let Err(error) = self.provider.set_page_scale(page_id, scale) {
            let _ = self
                .provider
                .set_navigation_generation(page_id, current_generation);
            return Err(error);
        }
        let mut state = lock(&self.state)?;
        let result = {
            let page = state
                .pages
                .get_mut(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            page.public.navigation_generation = next_generation;
            page.public.current_snapshot_id = None;
            page.snapshot = None;
            page.public.clone()
        };
        push_event_locked(
            &mut state,
            page_id,
            next_generation,
            BrowserLifecycleEventKind::DeviceMetricsChanged,
            None,
            Some(format!("page scale {}", scale.scale)),
        );
        Ok(result)
    }

    pub fn inspect_page(
        &self,
        page_id: &str,
        x: Option<f64>,
        y: Option<f64>,
    ) -> BrowserResult<BrowserInspectSnapshot> {
        self.sync_provider_events()?;
        let generation = self.page(page_id)?.navigation_generation;
        let snapshot = self.provider.inspect_page(page_id, x, y)?;
        self.sync_provider_events()?;
        if self.page(page_id)?.navigation_generation != generation {
            return Err(BrowserError::stale_ref(
                "browser inspection became stale while the view changed",
            ));
        }
        Ok(snapshot)
    }

    pub fn dispatch_pointer(&self, page_id: &str, input: BrowserPointerInput) -> BrowserResult<()> {
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        self.page(page_id)?;
        self.provider.dispatch_pointer(page_id, input)
    }

    pub fn dispatch_key(&self, page_id: &str, input: BrowserKeyInput) -> BrowserResult<()> {
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        self.page(page_id)?;
        self.provider.dispatch_key(page_id, input)
    }

    pub fn capture_jpeg(
        &self,
        page_id: &str,
        options: BrowserJpegCaptureOptions,
    ) -> BrowserResult<(BrowserJpegFrame, u64)> {
        self.sync_provider_events()?;
        let generation = self.page(page_id)?.navigation_generation;
        let frame = self.provider.capture_jpeg(page_id, options)?;
        self.sync_provider_events()?;
        if self.page(page_id)?.navigation_generation != generation {
            return Err(BrowserError::stale_ref(
                "browser screenshot became stale while the view changed",
            ));
        }
        Ok((frame, generation))
    }

    fn history_mutation(
        &self,
        page_id: &str,
        kind: HistoryMutationKind,
        action: impl FnOnce(&P) -> BrowserResult<()>,
    ) -> BrowserResult<BrowserPage> {
        self.sync_provider_events()?;
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let (current_generation, next_generation) = {
            let state = lock(&self.state)?;
            let page = state
                .pages
                .get(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            if page.public.load_state == BrowserLoadState::Loading {
                return Err(BrowserError::new(
                    BrowserErrorCode::Conflict,
                    "browser navigation is already in progress",
                ));
            }
            let current = page.public.navigation_generation;
            let next = current.checked_add(1).ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorCode::Internal,
                    "navigation generation exhausted",
                )
            })?;
            (current, next)
        };
        self.provider
            .set_navigation_generation(page_id, next_generation)?;
        if let Err(error) = action(&self.provider) {
            let _ = self
                .provider
                .set_navigation_generation(page_id, current_generation);
            return Err(error);
        }
        let mut state = lock(&self.state)?;
        let (generation, url, result) = {
            let page = state
                .pages
                .get_mut(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            match kind {
                HistoryMutationKind::Back => page.public.can_go_forward = true,
                HistoryMutationKind::Forward => page.public.can_go_back = true,
                HistoryMutationKind::Reload => {}
            }
            page.public.navigation_generation = next_generation;
            page.public.current_snapshot_id = None;
            page.public.load_state = BrowserLoadState::Loading;
            page.public.last_error = None;
            page.snapshot = None;
            (
                page.public.navigation_generation,
                page.public.url.clone(),
                page.public.clone(),
            )
        };
        push_event_locked(
            &mut state,
            page_id,
            generation,
            BrowserLifecycleEventKind::NavigationStarted,
            Some(url),
            None,
        );
        Ok(result)
    }

    pub fn set_bounds(&self, page_id: &str, bounds: PhysicalBounds) -> BrowserResult<BrowserPage> {
        if !bounds.validate() {
            return Err(BrowserError::invalid(
                "child WebView bounds must be non-zero physical pixels",
            ));
        }
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        self.provider.set_bounds(page_id, bounds)?;
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.public.bounds = bounds;
        Ok(page.public.clone())
    }

    pub fn set_visible(&self, page_id: &str, visible: bool) -> BrowserResult<BrowserPage> {
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let (current, next) = {
            let state = lock(&self.state)?;
            let page = state
                .pages
                .get(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            (
                page.public.effective_visible,
                visible || !page.visibility_leases.is_empty(),
            )
        };
        if current != next {
            self.provider.set_visible(page_id, next)?;
        }
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.public.requested_visible = visible;
        page.public.effective_visible = next;
        Ok(page.public.clone())
    }

    pub fn set_focus(&self, page_id: &str, focused: bool) -> BrowserResult<BrowserPage> {
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        self.provider.set_focus(page_id, focused)?;
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.public.focused = focused;
        Ok(page.public.clone())
    }

    pub fn set_surface(
        &self,
        page_id: &str,
        owner_generation: u64,
        bounds: Option<PhysicalBounds>,
        visible: bool,
        focused: bool,
    ) -> BrowserResult<BrowserPage> {
        if owner_generation == 0 {
            return Err(BrowserError::invalid(
                "browser surface owner generation must be greater than zero",
            ));
        }
        if bounds.is_some_and(|value| !value.validate()) {
            return Err(BrowserError::invalid(
                "child WebView bounds must be non-zero physical pixels",
            ));
        }
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let (effective_visible, effective_focused) = {
            let mut state = lock(&self.state)?;
            let page = state
                .pages
                .get_mut(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            if owner_generation < page.surface_owner_generation {
                return Err(BrowserError::new(
                    BrowserErrorCode::Conflict,
                    "stale browser surface owner generation",
                ));
            }
            // Claim the newer owner before touching the provider. Even if the first
            // application fails, an older unmount may not regain control and hide it.
            page.surface_owner_generation = owner_generation;
            let effective_visible = visible || !page.visibility_leases.is_empty();
            (effective_visible, visible && effective_visible && focused)
        };
        self.provider
            .set_surface(page_id, bounds, effective_visible, effective_focused)?;
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        if let Some(bounds) = bounds {
            page.public.bounds = bounds;
        }
        page.public.requested_visible = visible;
        page.public.effective_visible = effective_visible;
        page.public.focused = effective_focused;
        Ok(page.public.clone())
    }

    pub fn acquire_visibility_lease(
        &self,
        page_id: &str,
        reason: impl Into<String>,
    ) -> BrowserResult<VisibilityLeaseToken> {
        let reason = reason.into();
        if reason.trim().is_empty() {
            return Err(BrowserError::invalid("visibility lease reason is empty"));
        }
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let token = Uuid::new_v4().to_string();
        let should_show = {
            let state = lock(&self.state)?;
            let page = state
                .pages
                .get(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            !page.public.effective_visible
        };
        if should_show {
            self.provider.set_visible(page_id, true)?;
        }
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.visibility_leases.insert(token.clone(), reason);
        page.public.visibility_lease_count = page.visibility_leases.len();
        page.public.effective_visible = true;
        Ok(token)
    }

    pub fn release_visibility_lease(
        &self,
        page_id: &str,
        token: &str,
    ) -> BrowserResult<BrowserPage> {
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let should_hide = {
            let state = lock(&self.state)?;
            let page = state
                .pages
                .get(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            if !page.visibility_leases.contains_key(token) {
                return Err(BrowserError::not_found(token));
            }
            !page.public.requested_visible && page.visibility_leases.len() == 1
        };
        if should_hide {
            self.provider.set_visible(page_id, false)?;
        }
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.visibility_leases.remove(token);
        page.public.visibility_lease_count = page.visibility_leases.len();
        page.public.effective_visible =
            page.public.requested_visible || !page.visibility_leases.is_empty();
        Ok(page.public.clone())
    }

    pub fn record_snapshot(
        &self,
        page_id: &str,
        navigation_generation: u64,
        nodes: Vec<SnapshotNodeInput>,
    ) -> BrowserResult<BrowserSnapshot> {
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        if page.public.navigation_generation != navigation_generation {
            return Err(BrowserError::stale_ref(
                "snapshot belongs to an obsolete navigation generation",
            ));
        }
        page.snapshot_sequence += 1;
        let snapshot_id = format!(
            "{}:{}:{}",
            page_id, navigation_generation, page.snapshot_sequence
        );
        let truncated = nodes.len() > MAX_SNAPSHOT_NODES;
        let mut duplicates: HashMap<(String, String), u32> = HashMap::new();
        let records = nodes
            .into_iter()
            .take(MAX_SNAPSHOT_NODES)
            .enumerate()
            .map(|(index, node)| {
                let ordinal = duplicates
                    .entry((node.role.clone(), node.name.clone()))
                    .or_insert(0);
                let duplicate_ordinal = *ordinal;
                *ordinal += 1;
                SnapshotNodeRecord {
                    browser_ref: format!("ref:{}:{}", snapshot_id, index),
                    role: node.role,
                    name: node.name,
                    duplicate_ordinal,
                    backend_dom_id: node.backend_dom_id,
                    frame_id: node.frame_id,
                    session_id: node.session_id,
                    bounds: node.bounds,
                    supported_actions: node.supported_actions,
                    source: node.source,
                }
            })
            .collect::<Vec<_>>();
        let snapshot = BrowserSnapshot {
            page_id: page_id.to_string(),
            navigation_generation,
            snapshot_id: snapshot_id.clone(),
            nodes: records,
            truncated,
        };
        page.public.current_snapshot_id = Some(snapshot_id);
        page.snapshot = Some(StoredSnapshot {
            public: snapshot.clone(),
            recovery_attempted: HashSet::new(),
        });
        Ok(snapshot)
    }

    pub fn resolve_ref(
        &self,
        page_id: &str,
        navigation_generation: u64,
        snapshot_id: &str,
        browser_ref: &str,
        live_nodes: &[RecoveryCandidate],
    ) -> BrowserResult<ResolvedBrowserRef> {
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        if page.public.navigation_generation != navigation_generation {
            return Err(BrowserError::stale_ref(
                "ref navigation generation is stale; take a new snapshot",
            ));
        }
        let stored = page
            .snapshot
            .as_mut()
            .ok_or_else(|| BrowserError::stale_ref("page has no current snapshot"))?;
        if stored.public.snapshot_id != snapshot_id
            || page.public.current_snapshot_id.as_deref() != Some(snapshot_id)
        {
            return Err(BrowserError::stale_ref(
                "ref snapshot is stale; take a new snapshot",
            ));
        }
        let record_index = stored
            .public
            .nodes
            .iter()
            .position(|node| node.browser_ref == browser_ref)
            .ok_or_else(|| BrowserError::stale_ref("ref does not exist in the current snapshot"))?;
        let original = stored.public.nodes[record_index].clone();

        if let Some(live) = live_nodes
            .iter()
            .find(|node| node.backend_dom_id == original.backend_dom_id)
        {
            return Ok(ResolvedBrowserRef {
                page_id: page_id.to_string(),
                browser_ref: browser_ref.to_string(),
                backend_dom_id: live.backend_dom_id,
                frame_id: live.frame_id.clone(),
                session_id: live.session_id.clone(),
                recovered: false,
            });
        }
        if !stored.recovery_attempted.insert(browser_ref.to_string()) {
            return Err(BrowserError::stale_ref(
                "backend node stayed stale after the single recovery attempt",
            ));
        }
        let matches = live_nodes
            .iter()
            .filter(|candidate| {
                candidate.role == original.role
                    && candidate.name == original.name
                    && candidate.duplicate_ordinal == original.duplicate_ordinal
            })
            .collect::<Vec<_>>();
        if matches.len() != 1 {
            return Err(BrowserError::stale_ref(
                "backend node recovery was not unique; take a new snapshot",
            ));
        }
        let recovered = matches[0];
        let record = &mut stored.public.nodes[record_index];
        record.backend_dom_id = recovered.backend_dom_id;
        record.frame_id = recovered.frame_id.clone();
        record.session_id = recovered.session_id.clone();
        Ok(ResolvedBrowserRef {
            page_id: page_id.to_string(),
            browser_ref: browser_ref.to_string(),
            backend_dom_id: recovered.backend_dom_id,
            frame_id: recovered.frame_id.clone(),
            session_id: recovered.session_id.clone(),
            recovered: true,
        })
    }

    pub fn queue_permission(
        &self,
        page_id: &str,
        origin: impl Into<String>,
        permission: impl Into<String>,
    ) -> BrowserResult<PermissionRequest> {
        let request = PermissionRequest {
            id: Uuid::new_v4().to_string(),
            page_id: page_id.to_string(),
            origin: origin.into(),
            permission: permission.into(),
            requested_at_ms: now_ms(),
        };
        let mut state = lock(&self.state)?;
        let generation = state
            .pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?
            .public
            .navigation_generation;
        state.permissions.push_back(request.clone());
        push_event_locked(
            &mut state,
            page_id,
            generation,
            BrowserLifecycleEventKind::PermissionRequested,
            Some(request.origin.clone()),
            Some(request.permission.clone()),
        );
        Ok(request)
    }

    pub fn pending_permissions(&self) -> BrowserResult<Vec<PermissionRequest>> {
        Ok(lock(&self.state)?.permissions.iter().cloned().collect())
    }

    pub fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> BrowserResult<(PermissionRequest, PermissionDecision)> {
        let request = {
            let state = lock(&self.state)?;
            state
                .permissions
                .iter()
                .find(|request| request.id == request_id)
                .cloned()
                .ok_or_else(|| {
                    BrowserError::new(
                        BrowserErrorCode::PermissionNotFound,
                        format!("permission request not found: {request_id}"),
                    )
                })?
        };
        self.provider.resolve_permission(request_id, decision)?;
        let mut state = lock(&self.state)?;
        state
            .permissions
            .retain(|candidate| candidate.id != request_id);
        Ok((request, decision))
    }

    pub fn queue_certificate(
        &self,
        page_id: &str,
        origin: impl Into<String>,
        error_code: impl Into<String>,
    ) -> BrowserResult<CertificateRequest> {
        let request = CertificateRequest {
            id: Uuid::new_v4().to_string(),
            page_id: page_id.to_string(),
            origin: origin.into(),
            error_code: error_code.into(),
            requested_at_ms: now_ms(),
        };
        let mut state = lock(&self.state)?;
        let generation = state
            .pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?
            .public
            .navigation_generation;
        state.certificates.push_back(request.clone());
        push_event_locked(
            &mut state,
            page_id,
            generation,
            BrowserLifecycleEventKind::CertificateError,
            Some(request.origin.clone()),
            Some(request.error_code.clone()),
        );
        Ok(request)
    }

    pub fn pending_certificates(&self) -> BrowserResult<Vec<CertificateRequest>> {
        Ok(lock(&self.state)?.certificates.iter().cloned().collect())
    }

    pub fn resolve_certificate(
        &self,
        request_id: &str,
        decision: CertificateDecision,
    ) -> BrowserResult<(CertificateRequest, CertificateDecision)> {
        let request = {
            let state = lock(&self.state)?;
            state
                .certificates
                .iter()
                .find(|request| request.id == request_id)
                .cloned()
                .ok_or_else(|| {
                    BrowserError::new(
                        BrowserErrorCode::CertificateNotFound,
                        format!("certificate request not found: {request_id}"),
                    )
                })?
        };
        self.provider.resolve_certificate(request_id, decision)?;
        let mut state = lock(&self.state)?;
        state
            .certificates
            .retain(|candidate| candidate.id != request_id);
        Ok((request, decision))
    }

    pub fn queue_dialog(
        &self,
        page_id: &str,
        origin: impl Into<String>,
        kind: BrowserDialogKind,
        message: impl Into<String>,
        default_text: Option<String>,
    ) -> BrowserResult<BrowserDialogRequest> {
        let request = BrowserDialogRequest {
            id: Uuid::new_v4().to_string(),
            page_id: page_id.to_string(),
            origin: origin.into(),
            kind,
            message: message.into(),
            default_text,
            requested_at_ms: now_ms(),
        };
        let mut state = lock(&self.state)?;
        let generation = state
            .pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?
            .public
            .navigation_generation;
        state.dialogs.push_back(request.clone());
        push_event_locked(
            &mut state,
            page_id,
            generation,
            BrowserLifecycleEventKind::DialogRequested,
            Some(request.origin.clone()),
            Some(request.message.clone()),
        );
        Ok(request)
    }

    pub fn pending_dialogs(&self) -> BrowserResult<Vec<BrowserDialogRequest>> {
        Ok(lock(&self.state)?.dialogs.iter().cloned().collect())
    }

    pub fn resolve_dialog(
        &self,
        request_id: &str,
        accept: bool,
    ) -> BrowserResult<BrowserDialogRequest> {
        let request = {
            let state = lock(&self.state)?;
            state
                .dialogs
                .iter()
                .find(|request| request.id == request_id)
                .cloned()
                .ok_or_else(|| BrowserError::not_found(request_id))?
        };
        self.provider.resolve_dialog(request_id, accept)?;
        let mut state = lock(&self.state)?;
        state.dialogs.retain(|candidate| candidate.id != request_id);
        Ok(request)
    }

    pub fn push_frame(&self, frame: BrowserFrame) -> BrowserResult<BrowserCaptureState> {
        let page_id = frame.page_id.clone();
        let mut state = lock(&self.state)?;
        let (generation, status) = {
            let page = state
                .pages
                .get_mut(&page_id)
                .ok_or_else(|| BrowserError::not_found(&page_id))?;
            if frame.navigation_generation != page.public.navigation_generation {
                return Err(BrowserError::stale_ref(
                    "browser frame belongs to an obsolete navigation generation",
                ));
            }
            let status = page.frames.push(frame)?;
            page.public.dropped_frame_count = status.dropped_frames;
            page.public.latest_frame_sequence = status.latest_sequence;
            (page.public.navigation_generation, status)
        };
        push_event_locked(
            &mut state,
            &page_id,
            generation,
            BrowserLifecycleEventKind::CaptureUpdated,
            None,
            Some(format!(
                "pending={} dropped={}",
                status.pending_frames, status.dropped_frames
            )),
        );
        Ok(status)
    }

    pub fn capture_page(&self, page_id: &str) -> BrowserResult<BrowserCaptureState> {
        let (sequence, generation) = {
            let state = lock(&self.state)?;
            let page = state
                .pages
                .get(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            (
                page.public
                    .latest_frame_sequence
                    .unwrap_or_default()
                    .saturating_add(1),
                page.public.navigation_generation,
            )
        };
        let frame = self.provider.capture_frame(page_id, sequence, generation)?;
        self.push_frame(frame)
    }

    /// Full-viewport PNG bytes for the page, with no managed artifact written.
    /// The caller decides where the image lands; the browser markup flow stores
    /// it in the user's capture folder so the existing annotator can read it.
    pub fn capture_page_png(&self, page_id: &str) -> BrowserResult<Vec<u8>> {
        let generation = self.page(page_id)?.navigation_generation;
        Ok(self.provider.capture_frame(page_id, 0, generation)?.bytes)
    }

    pub fn open_dev_tools(&self, page_id: &str) -> BrowserResult<()> {
        self.page(page_id)?;
        self.provider.open_dev_tools(page_id)
    }

    pub fn capture_crop(
        &self,
        page_id: &str,
        bounds: PhysicalBounds,
    ) -> BrowserResult<ArtifactDescriptor> {
        self.sync_provider_events()?;
        let generation = self.page(page_id)?.navigation_generation;
        self.capture_crop_for_generation(page_id, generation, bounds, false)
    }

    pub fn create_annotation(
        &self,
        input: BrowserAnnotationInput,
    ) -> BrowserResult<BrowserAnnotation> {
        self.sync_provider_events()?;
        validate_annotation_input(&input)?;
        let page = self.page(&input.page_id)?;
        if page.workspace_id != input.workspace_id {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser annotation belongs to another workspace",
            ));
        }
        if page.navigation_generation != input.navigation_generation {
            return Err(BrowserError::stale_ref(
                "browser annotation is stale after navigation; pick the element again",
            ));
        }
        // The element context IS the deliverable; the crop is a bonus. A cold
        // or unreachable CDP target must not swallow the grab the user asked
        // for, so capture failures degrade to `screenshot: None`.
        let screenshot = self
            .capture_crop_for_generation(
                &input.page_id,
                input.navigation_generation,
                input.bounds,
                true,
            )
            .ok();
        let current = self.page(&input.page_id)?;
        if current.navigation_generation != input.navigation_generation || current.url != page.url {
            if let Some(stale) = &screenshot {
                let _ = self.remove_managed_artifact(&stale.path);
            }
            return Err(BrowserError::stale_ref(
                "browser annotation became stale while capturing; pick the element again",
            ));
        }
        Ok(BrowserAnnotation {
            id: format!("browser-annotation-{}", Uuid::new_v4()),
            workspace_id: input.workspace_id,
            page_id: input.page_id,
            navigation_generation: input.navigation_generation,
            url: current.url,
            browser_ref: input.browser_ref,
            tag_name: input.tag_name,
            selector: input.selector,
            full_path: input.full_path,
            role: input.role,
            react_components: input.react_components,
            html_snippet: input.html_snippet,
            accessible_name: input.accessible_name,
            nearby_text: input.nearby_text,
            ancestor_path: input.ancestor_path,
            bounds: input.bounds,
            text: input.text,
            attributes: input.attributes,
            computed_styles: input.computed_styles,
            source_hints: input.source_hints,
            comment: input.comment,
            screenshot,
        })
    }

    fn capture_crop_for_generation(
        &self,
        page_id: &str,
        navigation_generation: u64,
        bounds: PhysicalBounds,
        persisted: bool,
    ) -> BrowserResult<ArtifactDescriptor> {
        self.sweep_expired_artifacts(false)?;
        if !bounds.validate() || bounds.width > 10_000 || bounds.height > 10_000 {
            return Err(BrowserError::invalid("invalid browser capture clip"));
        }
        {
            let state = lock(&self.state)?;
            let page = state
                .pages
                .get(page_id)
                .ok_or_else(|| BrowserError::not_found(page_id))?;
            if page.public.navigation_generation != navigation_generation {
                return Err(BrowserError::stale_ref(
                    "browser capture belongs to an obsolete navigation generation",
                ));
            }
        }
        let bytes = self.provider.capture_crop(page_id, bounds)?;
        if bytes.is_empty() || bytes.len() as u64 > self.policy.max_artifact_bytes() {
            return Err(BrowserError::new(
                BrowserErrorCode::InvalidArgument,
                "browser capture exceeds the bounded artifact size",
            ));
        }
        if self.page(page_id)?.navigation_generation != navigation_generation {
            return Err(BrowserError::stale_ref(
                "browser capture became stale during navigation",
            ));
        }
        self.ensure_artifact_root()?;
        let artifact_id = Uuid::new_v4();
        let path = self
            .policy
            .artifact_root()
            .join(format!("design-crop-{artifact_id}.png"));
        let ttl_ms = if persisted {
            PROMOTED_ANNOTATION_TTL_MS
        } else {
            TRANSIENT_CAPTURE_TTL_MS
        };
        let expires_at_ms = now_ms().saturating_add(ttl_ms);
        let descriptor_path = self
            .policy
            .artifact_root()
            .join(format!("design-crop-{artifact_id}.artifact.json"));
        let pending_descriptor = ArtifactDescriptor {
            path: path.clone(),
            content_type: "image/png".to_string(),
            bytes: bytes.len() as u64,
            expires_at_ms,
            truncated: false,
        };
        self.write_artifact_cleanup_record(&descriptor_path, &pending_descriptor)?;
        if let Err(error) = fs::write(&path, bytes) {
            return Err(BrowserError::new(
                BrowserErrorCode::Internal,
                format!("write browser design crop: {error}"),
            ));
        }
        let mut descriptor = match self
            .policy
            .describe_artifact(&path, "image/png", expires_at_ms)
        {
            Ok(descriptor) => descriptor,
            Err(error) => {
                let _ = fs::remove_file(&path);
                return Err(error);
            }
        };
        // Policy validation canonicalizes both sides before checking containment. Keep that
        // security boundary while exposing the readable policy-composed path instead of the
        // Windows verbatim path returned by `canonicalize`.
        descriptor.path = path;
        Ok(descriptor)
    }

    pub fn detect_cookie_import_source(
        &self,
        endpoint: &str,
    ) -> BrowserResult<BrowserCookieImportSource> {
        self.provider.detect_cookie_import_source(endpoint)
    }

    pub fn import_cookies(
        &self,
        input: BrowserCookieImportInput,
    ) -> BrowserResult<BrowserCookieImportResult> {
        if !input.consent {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "cookie import requires explicit consent",
            ));
        }
        if input.origins.is_empty() || input.origins.len() > 64 {
            return Err(BrowserError::invalid(
                "cookie import requires between one and 64 explicit origins",
            ));
        }
        let mutation = self.mutation_lock(&input.page_id)?;
        let _serial = lock(&mutation)?;
        let (profile_kind, quarantined) = {
            let state = lock(&self.state)?;
            let page = state
                .pages
                .get(&input.page_id)
                .ok_or_else(|| BrowserError::not_found(&input.page_id))?;
            if page.public.workspace_id != input.workspace_id
                || page.public.profile_id != input.profile_id
            {
                return Err(BrowserError::new(
                    BrowserErrorCode::DeniedCapability,
                    "cookie import page/profile identity does not match the workspace content",
                ));
            }
            let profile = state
                .profiles
                .get(&input.profile_id)
                .ok_or_else(|| BrowserError::not_found(&input.profile_id))?;
            (
                profile.public.kind,
                profile.public.cookie_import_quarantined,
            )
        };
        if profile_kind != ProfileKind::Imported {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "cookie import is allowed only into an isolated imported profile",
            ));
        }
        if quarantined {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "cookie import is disabled for this quarantined profile",
            ));
        }
        if let Some(profile) = lock(&self.state)?.profiles.get_mut(&input.profile_id) {
            // This flag doubles as the durable in-progress transaction marker. A crash
            // after this save therefore restores the profile quarantined by default.
            profile.public.cookie_import_quarantined = true;
        }
        if let Err(error) = self.save_state() {
            return Err(BrowserError::new(
                BrowserErrorCode::Internal,
                format!("persist cookie import quarantine marker: {error}"),
            ));
        }
        let result = self.provider.import_cookies(&input)?;
        let transaction_proven =
            (result.verified && !result.rolled_back) || (result.rolled_back && !result.verified);
        if !transaction_proven || result.quarantined {
            return Ok(BrowserCookieImportResult {
                quarantined: true,
                ..result
            });
        }
        if let Some(profile) = lock(&self.state)?.profiles.get_mut(&input.profile_id) {
            profile.public.cookie_import_quarantined = false;
        }
        if let Err(error) = self.save_state() {
            if let Some(profile) = lock(&self.state)?.profiles.get_mut(&input.profile_id) {
                profile.public.cookie_import_quarantined = true;
            }
            let _ = self.save_state();
            return Err(BrowserError::new(
                BrowserErrorCode::Internal,
                format!("clear cookie import quarantine marker: {error}"),
            ));
        }
        Ok(result)
    }

    pub fn take_latest_frame(&self, page_id: &str) -> BrowserResult<Option<BrowserFrame>> {
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        let frame = page.frames.take_latest();
        let status = page.frames.status();
        page.public.dropped_frame_count = status.dropped_frames;
        page.public.latest_frame_sequence = frame.as_ref().map(|value| value.sequence);
        Ok(frame)
    }

    pub fn capture_state(&self, page_id: &str) -> BrowserResult<BrowserCaptureState> {
        let state = lock(&self.state)?;
        state
            .pages
            .get(page_id)
            .map(|page| page.frames.status())
            .ok_or_else(|| BrowserError::not_found(page_id))
    }

    pub fn sync_provider_events(&self) -> BrowserResult<Vec<BrowserLifecycleEvent>> {
        let _pump = lock(&self.event_pump)?;
        let incoming = self.provider.drain_events()?;
        if incoming.is_empty() {
            self.flush_provider_persistence()?;
            return Ok(Vec::new());
        }
        let mut state = lock(&self.state)?;
        let mut accepted = Vec::with_capacity(incoming.len());
        let mut deferred = Vec::new();
        let mut persistence_dirty = false;
        for event in incoming {
            let Some(current_generation) = state
                .pages
                .get(&event.page_id)
                .map(|page| page.public.navigation_generation)
            else {
                if event.kind != BrowserLifecycleEventKind::PageClosed {
                    deferred.push(event);
                }
                continue;
            };
            if event.navigation_generation != current_generation {
                if matches!(
                    event.kind,
                    BrowserLifecycleEventKind::PageCreated | BrowserLifecycleEventKind::PageClosed
                ) {
                    // Page lifecycle boundaries are not navigation-generation updates.
                } else if event.navigation_generation > current_generation
                    && matches!(
                        event.kind,
                        BrowserLifecycleEventKind::NavigationStarted
                            | BrowserLifecycleEventKind::NavigationCommitted
                            | BrowserLifecycleEventKind::NavigationFinished
                            | BrowserLifecycleEventKind::NavigationFailed
                    )
                {
                    let page = state.pages.get_mut(&event.page_id).expect("page checked");
                    if page.public.url != DEFAULT_URL {
                        page.public.can_go_back = true;
                    }
                    page.public.can_go_forward = false;
                    page.public.navigation_generation = event.navigation_generation;
                    page.public.current_snapshot_id = None;
                    page.snapshot = None;
                } else {
                    continue;
                }
            }
            match event.kind {
                BrowserLifecycleEventKind::NavigationStarted => {
                    let page = state.pages.get_mut(&event.page_id).expect("page checked");
                    if let Some(url) = &event.url {
                        page.public.url = url.clone();
                    }
                    page.public.load_state = BrowserLoadState::Loading;
                    page.public.last_error = None;
                    persistence_dirty = true;
                }
                BrowserLifecycleEventKind::NavigationCommitted => {
                    let page = state.pages.get_mut(&event.page_id).expect("page checked");
                    if let Some(url) = &event.url {
                        page.public.url = url.clone();
                    }
                    page.public.load_state = BrowserLoadState::Loading;
                    page.public.last_error = None;
                    persistence_dirty = true;
                }
                BrowserLifecycleEventKind::NavigationFinished => {
                    let page = state.pages.get_mut(&event.page_id).expect("page checked");
                    if let Some(url) = &event.url {
                        page.public.url = url.clone();
                    }
                    page.public.load_state = BrowserLoadState::Loaded;
                    page.public.last_error = None;
                    persistence_dirty = true;
                }
                BrowserLifecycleEventKind::NavigationFailed => {
                    let page = state.pages.get_mut(&event.page_id).expect("page checked");
                    page.public.load_state = BrowserLoadState::Failed;
                    page.public.last_error = event.detail.clone();
                    persistence_dirty = true;
                }
                BrowserLifecycleEventKind::TitleChanged => {
                    if let (Some(page), Some(title)) =
                        (state.pages.get_mut(&event.page_id), &event.detail)
                    {
                        page.public.title = title.clone();
                        persistence_dirty = true;
                    }
                }
                BrowserLifecycleEventKind::DownloadRequested => {
                    state.downloads.push_back(BrowserDownloadRecord {
                        id: Uuid::new_v4().to_string(),
                        page_id: event.page_id.clone(),
                        url: event.url.clone().unwrap_or_default(),
                        path: event.detail.as_ref().map(PathBuf::from),
                        success: None,
                        error: None,
                        updated_at_ms: event.timestamp_ms,
                    });
                    while state.downloads.len() > MAX_DOWNLOAD_RECORDS {
                        state.downloads.pop_front();
                    }
                }
                BrowserLifecycleEventKind::DownloadFinished => {
                    let success = event
                        .detail
                        .as_deref()
                        .is_some_and(|detail| detail.starts_with("completed:"));
                    if let Some(download) = state.downloads.iter_mut().rev().find(|download| {
                        download.page_id == event.page_id
                            && download.url == event.url.clone().unwrap_or_default()
                            && download.success.is_none()
                    }) {
                        download.success = Some(success);
                        download.error = (!success).then(|| {
                            event
                                .detail
                                .clone()
                                .unwrap_or_else(|| "download failed".to_string())
                        });
                        download.updated_at_ms = event.timestamp_ms;
                    }
                }
                BrowserLifecycleEventKind::PermissionRequested => {
                    let detail = event.detail.as_deref().and_then(|value| {
                        serde_json::from_str::<NativePermissionDetail>(value).ok()
                    });
                    let request = PermissionRequest {
                        id: detail
                            .as_ref()
                            .map(|value| value.request_id.clone())
                            .unwrap_or_else(|| Uuid::new_v4().to_string()),
                        page_id: event.page_id.clone(),
                        origin: event.url.clone().unwrap_or_default(),
                        permission: detail
                            .map(|value| value.permission)
                            .or_else(|| event.detail.clone())
                            .unwrap_or_else(|| "unknown".to_string()),
                        requested_at_ms: event.timestamp_ms,
                    };
                    if !state
                        .permissions
                        .iter()
                        .any(|pending| pending.id == request.id)
                    {
                        state.permissions.push_back(request);
                    }
                }
                BrowserLifecycleEventKind::CertificateError => {
                    let detail = event.detail.as_deref().and_then(|value| {
                        serde_json::from_str::<NativeCertificateDetail>(value).ok()
                    });
                    let request = CertificateRequest {
                        id: detail
                            .as_ref()
                            .map(|value| value.request_id.clone())
                            .unwrap_or_else(|| Uuid::new_v4().to_string()),
                        page_id: event.page_id.clone(),
                        origin: event.url.clone().unwrap_or_default(),
                        error_code: detail
                            .map(|value| value.error_code)
                            .or_else(|| event.detail.clone())
                            .unwrap_or_else(|| "certificate_error".to_string()),
                        requested_at_ms: event.timestamp_ms,
                    };
                    if !state
                        .certificates
                        .iter()
                        .any(|pending| pending.id == request.id)
                    {
                        state.certificates.push_back(request);
                    }
                }
                BrowserLifecycleEventKind::DialogRequested => {
                    let detail = event
                        .detail
                        .as_deref()
                        .and_then(|value| serde_json::from_str::<NativeDialogDetail>(value).ok());
                    let request = BrowserDialogRequest {
                        id: detail
                            .as_ref()
                            .map(|value| value.request_id.clone())
                            .unwrap_or_else(|| Uuid::new_v4().to_string()),
                        page_id: event.page_id.clone(),
                        origin: event.url.clone().unwrap_or_default(),
                        kind: detail
                            .as_ref()
                            .map(|value| value.kind)
                            .unwrap_or(BrowserDialogKind::Alert),
                        message: detail
                            .as_ref()
                            .map(|value| value.message.clone())
                            .or_else(|| event.detail.clone())
                            .unwrap_or_default(),
                        default_text: detail.and_then(|value| value.default_text),
                        requested_at_ms: event.timestamp_ms,
                    };
                    if !state.dialogs.iter().any(|pending| pending.id == request.id) {
                        state.dialogs.push_back(request);
                    }
                }
                _ => {}
            }
            let normalized = push_event_locked(
                &mut state,
                &event.page_id,
                event.navigation_generation,
                event.kind,
                event.url,
                event.detail,
            );
            accepted.push(normalized);
        }
        drop(state);
        if !deferred.is_empty() {
            self.provider.requeue_events(deferred)?;
        }
        if persistence_dirty {
            *lock(&self.provider_persistence_dirty)? = true;
        }
        let persistence_result = self.flush_provider_persistence();
        for event in &accepted {
            self.provider.publish_lifecycle_event(event);
        }
        persistence_result?;
        Ok(accepted)
    }

    fn flush_provider_persistence(&self) -> BrowserResult<()> {
        if !*lock(&self.provider_persistence_dirty)? {
            return Ok(());
        }
        let _workspace_mutation = lock(&self.workspace_mutations)?;
        self.save_state()?;
        *lock(&self.provider_persistence_dirty)? = false;
        Ok(())
    }

    pub fn lifecycle_events_since(
        &self,
        after_sequence: u64,
    ) -> BrowserResult<Vec<BrowserLifecycleEvent>> {
        self.sync_provider_events()?;
        Ok(lock(&self.state)?
            .events
            .iter()
            .filter(|event| event.sequence > after_sequence)
            .cloned()
            .collect())
    }

    pub fn lifecycle_events_snapshot(
        &self,
        after_sequence: u64,
    ) -> BrowserResult<Vec<BrowserLifecycleEvent>> {
        Ok(lock(&self.state)?
            .events
            .iter()
            .filter(|event| event.sequence > after_sequence)
            .cloned()
            .collect())
    }

    pub fn downloads(&self) -> BrowserResult<Vec<BrowserDownloadRecord>> {
        Ok(lock(&self.state)?.downloads.iter().cloned().collect())
    }

    pub fn close_page(&self, page_id: &str) -> BrowserResult<()> {
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        self.provider.close(page_id)?;
        self.remove_closed_page_state(page_id, None)?;
        lock(&self.page_mutations)?.remove(page_id);
        Ok(())
    }

    pub fn close_page_durable(&self, workspace_id: &str, page_id: &str) -> BrowserResult<()> {
        validate_identifier("workspace", workspace_id)?;
        validate_identifier("page", page_id)?;
        let _workspace_mutation = lock(&self.workspace_mutations)?;
        let mutation = self.mutation_lock(page_id)?;
        let _serial = lock(&mutation)?;
        let page = self.page(page_id)?;
        if page.workspace_id != workspace_id {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser page belongs to another workspace",
            ));
        }
        lock(&self.tombstoned_pages)?.insert(page_id.to_string());
        let persistence_result = (|| {
            let _persistence = lock(&self.persistence)?;
            let document = self.restore_document_excluding(None)?;
            self.write_restore_document(&document)
        })();
        if let Err(error) = persistence_result {
            lock(&self.tombstoned_pages)?.remove(page_id);
            return Err(error);
        }
        // Keep the durable tombstone if native teardown fails. The panel remains
        // retryable, while every later state save continues to exclude this page.
        self.provider.close(page_id)?;
        self.remove_closed_page_state(page_id, Some("durable close".to_string()))?;
        lock(&self.page_mutations)?.remove(page_id);
        lock(&self.tombstoned_pages)?.remove(page_id);
        Ok(())
    }

    fn remove_closed_page_state(&self, page_id: &str, detail: Option<String>) -> BrowserResult<()> {
        let mut state = lock(&self.state)?;
        let page = state
            .pages
            .remove(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        if let Some(profile) = state.profiles.get_mut(&page.public.profile_id) {
            profile
                .public
                .page_ids
                .retain(|candidate| candidate != page_id);
        }
        state
            .permissions
            .retain(|request| request.page_id != page_id);
        state
            .certificates
            .retain(|request| request.page_id != page_id);
        state.dialogs.retain(|request| request.page_id != page_id);
        state
            .downloads
            .retain(|download| download.page_id != page_id);
        push_event_locked(
            &mut state,
            page_id,
            page.public.navigation_generation,
            BrowserLifecycleEventKind::PageClosed,
            Some(page.public.url),
            detail,
        );
        Ok(())
    }

    pub fn close_profile(&self, profile_id: &str) -> BrowserResult<()> {
        let pages = {
            let state = lock(&self.state)?;
            state
                .profiles
                .get(profile_id)
                .map(|profile| profile.public.page_ids.clone())
                .ok_or_else(|| BrowserError::not_found(profile_id))?
        };
        for page_id in pages {
            self.close_page(&page_id)?;
        }
        self.provider.release_profile(profile_id)?;
        lock(&self.state)?.profiles.remove(profile_id);
        Ok(())
    }

    pub fn cleanup_workspace(&self, workspace_id: &str) -> BrowserResult<()> {
        validate_identifier("workspace", workspace_id)?;
        let _workspace_mutation = lock(&self.workspace_mutations)?;
        let (mut page_ids, profile_ids, profile_directories) = {
            let state = lock(&self.state)?;
            let profile_ids = state
                .profiles
                .values()
                .filter(|profile| profile.public.workspace_id.as_deref() == Some(workspace_id))
                .map(|profile| profile.public.id.clone())
                .collect::<HashSet<_>>();
            let profile_directories = state
                .profiles
                .values()
                .filter(|profile| profile_ids.contains(&profile.public.id))
                .filter_map(|profile| profile.public.user_data_dir.clone())
                .collect::<Vec<_>>();
            let page_ids = state
                .pages
                .values()
                .filter(|page| {
                    page.public.workspace_id == workspace_id
                        || profile_ids.contains(&page.public.profile_id)
                })
                .map(|page| page.public.id.clone())
                .collect::<Vec<_>>();
            (page_ids, profile_ids, profile_directories)
        };
        page_ids.sort();

        let page_mutations = page_ids
            .iter()
            .filter_map(|page_id| self.mutation_lock(page_id).ok())
            .collect::<Vec<_>>();
        let mut page_serials = Vec::with_capacity(page_mutations.len());
        for mutation in &page_mutations {
            page_serials.push(lock(mutation)?);
        }

        {
            let mut tombstones = lock(&self.tombstoned_pages)?;
            tombstones.extend(page_ids.iter().cloned());
        }
        let persistence_guard = lock(&self.persistence)?;
        if let Err(error) = self
            .restore_document_excluding(Some(workspace_id))
            .and_then(|document| self.write_restore_document(&document))
        {
            let mut tombstones = lock(&self.tombstoned_pages)?;
            for page_id in &page_ids {
                tombstones.remove(page_id);
            }
            return Err(error);
        }

        let mut close_error = None;
        let mut closed_page_ids = Vec::new();
        for page_id in &page_ids {
            if !lock(&self.state)?.pages.contains_key(page_id) {
                continue;
            }
            match self.provider.close(page_id) {
                Ok(()) => closed_page_ids.push(page_id.clone()),
                Err(error) => {
                    close_error.get_or_insert(error);
                }
            }
        }
        if close_error.is_none() {
            for profile_id in &profile_ids {
                if let Err(error) = self.provider.release_profile(profile_id) {
                    close_error.get_or_insert(error);
                }
            }
        }

        {
            let mut state = lock(&self.state)?;
            for page_id in &closed_page_ids {
                let Some(page) = state.pages.remove(page_id) else {
                    continue;
                };
                state
                    .permissions
                    .retain(|request| request.page_id != page_id.as_str());
                state
                    .certificates
                    .retain(|request| request.page_id != page_id.as_str());
                state
                    .dialogs
                    .retain(|request| request.page_id != page_id.as_str());
                state
                    .downloads
                    .retain(|download| download.page_id != page_id.as_str());
                push_event_locked(
                    &mut state,
                    page_id,
                    page.public.navigation_generation,
                    BrowserLifecycleEventKind::PageClosed,
                    Some(page.public.url),
                    Some("workspace cleanup".to_string()),
                );
            }
            for profile in state.profiles.values_mut() {
                profile
                    .public
                    .page_ids
                    .retain(|page_id| !closed_page_ids.contains(page_id));
            }
            if close_error.is_none() {
                state
                    .profiles
                    .retain(|profile_id, _| !profile_ids.contains(profile_id));
            }
        }
        drop(persistence_guard);
        {
            let mut mutations = lock(&self.page_mutations)?;
            for page_id in &closed_page_ids {
                mutations.remove(page_id);
            }
        }
        {
            let mut tombstones = lock(&self.tombstoned_pages)?;
            for page_id in &closed_page_ids {
                tombstones.remove(page_id);
            }
        }
        if let Some(error) = close_error {
            return Err(error);
        }
        lock(&self.restored_workspaces)?.remove(workspace_id);
        for directory in profile_directories {
            self.remove_owned_profile_directory(&directory)?;
        }
        Ok(())
    }

    pub fn save_state(&self) -> BrowserResult<()> {
        let _persistence = lock(&self.persistence)?;
        let document = self.restore_document_excluding(None)?;
        self.write_restore_document(&document)
    }

    fn restore_document_excluding(
        &self,
        excluded_workspace_id: Option<&str>,
    ) -> BrowserResult<BrowserRestoreDocument> {
        let tombstoned_pages = lock(&self.tombstoned_pages)?.clone();
        let state = lock(&self.state)?;
        let persistent_profiles = state
            .profiles
            .values()
            .filter(|profile| {
                profile.public.kind != ProfileKind::Incognito
                    && excluded_workspace_id.is_none_or(|workspace_id| {
                        profile.public.workspace_id.as_deref() != Some(workspace_id)
                    })
            })
            .map(|profile| RestoreProfile {
                id: profile.public.id.clone(),
                kind: profile.public.kind,
                workspace_id: profile.public.workspace_id.clone(),
                cookie_import_quarantined: profile.public.cookie_import_quarantined,
            })
            .collect::<Vec<_>>();
        let persistent_ids = persistent_profiles
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<HashSet<_>>();
        let pages = state
            .pages
            .values()
            .filter(|page| {
                persistent_ids.contains(page.public.profile_id.as_str())
                    && excluded_workspace_id
                        .is_none_or(|workspace_id| page.public.workspace_id != workspace_id)
                    && !tombstoned_pages.contains(&page.public.id)
            })
            .map(|page| RestorePage {
                id: page.public.id.clone(),
                workspace_id: page.public.workspace_id.clone(),
                profile_id: page.public.profile_id.clone(),
                url: page.public.url.clone(),
                title: page.public.title.clone(),
                bounds: page.public.bounds,
                device_metrics: page.public.device_metrics,
            })
            .collect::<Vec<_>>();
        Ok(BrowserRestoreDocument {
            version: BROWSER_RESTORE_VERSION,
            profiles: persistent_profiles,
            pages,
        })
    }

    fn write_restore_document(&self, document: &BrowserRestoreDocument) -> BrowserResult<()> {
        let bytes = serde_json::to_vec(&document).map_err(internal_error)?;
        if bytes.len() as u64 > MAX_BROWSER_RESTORE_BYTES {
            return Err(BrowserError::new(
                BrowserErrorCode::Internal,
                "browser restore state exceeds the bounded size",
            ));
        }
        write_restore_bytes_atomically(&self.restore_path, &bytes)
    }

    pub fn restore_workspace(
        &self,
        workspace_id: &str,
        fallback_bounds: PhysicalBounds,
    ) -> BrowserResult<Vec<BrowserPage>> {
        validate_identifier("workspace", workspace_id)?;
        if !fallback_bounds.validate() {
            return Err(BrowserError::invalid("invalid browser restore bounds"));
        }
        let _workspace_mutation = lock(&self.workspace_mutations)?;
        if lock(&self.restored_workspaces)?.contains(workspace_id) {
            return Ok(self
                .pages()?
                .into_iter()
                .filter(|page| page.workspace_id == workspace_id)
                .collect());
        }
        let Some(document) = self.load_restore_document()? else {
            lock(&self.restored_workspaces)?.insert(workspace_id.to_string());
            return Ok(Vec::new());
        };
        let BrowserRestoreDocument {
            profiles, pages, ..
        } = document;
        let restored_pages = pages
            .into_iter()
            .filter(|page| page.workspace_id == workspace_id)
            .collect::<Vec<_>>();
        let needed_profiles = restored_pages
            .iter()
            .map(|page| page.profile_id.clone())
            .collect::<HashSet<_>>();
        let mut existing_profiles = self
            .profiles()?
            .into_iter()
            .map(|profile| profile.id)
            .collect::<HashSet<_>>();
        let mut created_profiles = Vec::new();
        let mut created_pages = Vec::new();
        let restore_result = (|| {
            for profile in profiles {
                if needed_profiles.contains(profile.id.as_str())
                    && !existing_profiles.contains(&profile.id)
                {
                    let restored =
                        self.create_profile_locked(profile.id, profile.kind, profile.workspace_id)?;
                    if profile.cookie_import_quarantined {
                        if let Some(state_profile) =
                            lock(&self.state)?.profiles.get_mut(&restored.id)
                        {
                            state_profile.public.cookie_import_quarantined = true;
                        }
                    }
                    existing_profiles.insert(restored.id.clone());
                    created_profiles.push(restored.id);
                }
            }
            for restored in restored_pages {
                let page = match self.page(&restored.id) {
                    Ok(page) => {
                        if page.workspace_id != restored.workspace_id
                            || page.profile_id != restored.profile_id
                        {
                            return Err(BrowserError::new(
                                BrowserErrorCode::Conflict,
                                "restored browser page identity conflicts with live state",
                            ));
                        }
                        page
                    }
                    Err(error) if error.code == BrowserErrorCode::NotFound => {
                        let bounds = if restored.bounds.validate() {
                            restored.bounds
                        } else {
                            fallback_bounds
                        };
                        let page = self.create_page_locked_with_url(
                            restored.id.clone(),
                            restored.workspace_id.clone(),
                            &restored.profile_id,
                            bounds,
                            &restored.url,
                            &restored.title,
                        )?;
                        created_pages.push(page.id.clone());
                        page
                    }
                    Err(error) => return Err(error),
                };
                if let Some(metrics) = restored.device_metrics {
                    self.set_device_metrics(&page.id, metrics)?;
                }
                self.set_visible(&page.id, false)?;
                let mut state = lock(&self.state)?;
                let generation = {
                    let stored = state
                        .pages
                        .get_mut(&page.id)
                        .ok_or_else(|| BrowserError::not_found(&page.id))?;
                    stored.public.title = restored.title;
                    stored.public.navigation_generation
                };
                push_event_locked(
                    &mut state,
                    &page.id,
                    generation,
                    BrowserLifecycleEventKind::Restored,
                    Some(restored.url),
                    None,
                );
            }
            Ok::<(), BrowserError>(())
        })();
        if let Err(error) = restore_result {
            let rollback_error = self.rollback_restore_attempt(&created_pages, &created_profiles);
            return match rollback_error {
                Ok(()) => Err(error),
                Err(rollback) => Err(BrowserError::new(
                    error.code,
                    format!(
                        "{}; browser restore rollback failed: {}",
                        error.message, rollback.message
                    ),
                )),
            };
        }
        lock(&self.restored_workspaces)?.insert(workspace_id.to_string());
        Ok(self
            .pages()?
            .into_iter()
            .filter(|page| page.workspace_id == workspace_id)
            .collect())
    }

    fn rollback_restore_attempt(
        &self,
        created_pages: &[String],
        created_profiles: &[String],
    ) -> BrowserResult<()> {
        let mut first_error = None;
        for page_id in created_pages.iter().rev() {
            if self.page(page_id).is_ok() {
                if let Err(error) = self.close_page(page_id) {
                    first_error.get_or_insert(error);
                }
            }
        }
        for profile_id in created_profiles.iter().rev() {
            if self
                .profiles()?
                .iter()
                .any(|profile| profile.id == *profile_id && profile.page_ids.is_empty())
            {
                if let Err(error) = self.rollback_empty_profile(profile_id) {
                    first_error.get_or_insert(error);
                }
            }
        }
        match first_error {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }

    fn load_restore_document(&self) -> BrowserResult<Option<BrowserRestoreDocument>> {
        let _persistence = lock(&self.persistence)?;
        let backup = self.restore_path.with_extension("json.bak");
        for (path, quarantine) in [(&self.restore_path, true), (&backup, false)] {
            if !restore_path_exists(path)? {
                continue;
            }
            let result = read_restore_document(path).and_then(|document| {
                validate_restore_document(&document)?;
                for page in &document.pages {
                    self.policy.normalize_navigation(&page.url)?;
                }
                Ok(document)
            });
            match result {
                Ok(document) => return Ok(Some(document)),
                Err(error) if error.code == BrowserErrorCode::Conflict => return Err(error),
                Err(_) if quarantine => {
                    let corrupt = self
                        .restore_path
                        .with_extension(format!("corrupt-{}", now_ms()));
                    let _ = fs::rename(path, corrupt);
                }
                Err(_) => continue,
            }
        }
        Ok(None)
    }

    fn restore_profile_metadata(&self) -> BrowserResult<()> {
        let Some(document) = self.load_restore_document()? else {
            return Ok(());
        };
        for profile in document.profiles {
            if self
                .profiles()?
                .iter()
                .any(|candidate| candidate.id == profile.id)
            {
                continue;
            }
            let restored = self.create_profile(profile.id, profile.kind, profile.workspace_id)?;
            if profile.cookie_import_quarantined {
                if let Some(state_profile) = lock(&self.state)?.profiles.get_mut(&restored.id) {
                    state_profile.public.cookie_import_quarantined = true;
                }
            }
        }
        Ok(())
    }

    pub fn cleanup_expired_artifacts(&self) -> BrowserResult<usize> {
        self.sweep_expired_artifacts(true)
    }

    fn sweep_expired_artifacts(&self, force: bool) -> BrowserResult<usize> {
        let now = now_ms();
        {
            let mut last = lock(&self.last_artifact_sweep_ms)?;
            if !force && now.saturating_sub(*last) < ARTIFACT_SWEEP_INTERVAL_MS {
                return Ok(0);
            }
            *last = now;
        }
        let root = self.policy.artifact_root();
        if !root.exists() {
            return Ok(0);
        }
        self.validate_artifact_root(false)?;
        let mut removed = 0usize;
        for entry in fs::read_dir(root).map_err(internal_error)? {
            let entry = entry.map_err(internal_error)?;
            let descriptor_path = entry.path();
            let Some(descriptor_name) = entry.file_name().to_str().map(str::to_string) else {
                continue;
            };
            let Some(artifact_name) = artifact_name_from_descriptor(&descriptor_name) else {
                continue;
            };
            let metadata = fs::symlink_metadata(&descriptor_path).map_err(internal_error)?;
            if !metadata.file_type().is_file()
                || metadata.file_type().is_symlink()
                || metadata.len() > MAX_ARTIFACT_DESCRIPTOR_BYTES
            {
                continue;
            }
            let Ok(record) = fs::read(&descriptor_path)
                .map_err(internal_error)
                .and_then(|bytes| {
                    serde_json::from_slice::<ArtifactCleanupRecord>(&bytes).map_err(internal_error)
                })
            else {
                continue;
            };
            let artifact_path = root.join(&artifact_name);
            if record.version != ARTIFACT_DESCRIPTOR_VERSION
                || record.descriptor.expires_at_ms > now
                || record.descriptor.path != artifact_path
                || record.descriptor.content_type != "image/png"
                || record.descriptor.bytes > self.policy.max_artifact_bytes()
            {
                continue;
            }
            match fs::symlink_metadata(&artifact_path) {
                Ok(metadata)
                    if metadata.file_type().is_file() && !metadata.file_type().is_symlink() =>
                {
                    fs::remove_file(&artifact_path).map_err(internal_error)?;
                }
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(internal_error(error)),
            }
            fs::remove_file(&descriptor_path).map_err(internal_error)?;
            removed = removed.saturating_add(1);
        }
        Ok(removed)
    }

    fn ensure_artifact_root(&self) -> BrowserResult<()> {
        self.validate_artifact_root(true)
    }

    fn validate_artifact_root(&self, create: bool) -> BrowserResult<()> {
        let root = self.policy.artifact_root();
        if root.parent() != self.profile_root.parent() {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser artifact root is outside the VibeLink browser data root",
            ));
        }
        if create && !root.exists() {
            fs::create_dir_all(root).map_err(internal_error)?;
        }
        let metadata = fs::symlink_metadata(root).map_err(internal_error)?;
        if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser artifact root must be a real directory",
            ));
        }
        Ok(())
    }

    fn write_artifact_cleanup_record(
        &self,
        path: &Path,
        descriptor: &ArtifactDescriptor,
    ) -> BrowserResult<()> {
        let record = ArtifactCleanupRecord {
            version: ARTIFACT_DESCRIPTOR_VERSION,
            descriptor: descriptor.clone(),
        };
        let bytes = serde_json::to_vec(&record).map_err(internal_error)?;
        if bytes.len() as u64 > MAX_ARTIFACT_DESCRIPTOR_BYTES {
            return Err(BrowserError::new(
                BrowserErrorCode::Internal,
                "browser artifact descriptor exceeds its bounded size",
            ));
        }
        let mut descriptor_file = fs::File::create(path).map_err(internal_error)?;
        descriptor_file.write_all(&bytes).map_err(internal_error)?;
        descriptor_file.sync_all().map_err(internal_error)
    }

    fn remove_managed_artifact(&self, path: &Path) -> BrowserResult<()> {
        let root = self.policy.artifact_root();
        if path.parent() != Some(root) {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser artifact removal escaped the artifact root",
            ));
        }
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            return Err(BrowserError::invalid("invalid browser artifact name"));
        };
        let Some(id) = file_name
            .strip_prefix("design-crop-")
            .and_then(|value| value.strip_suffix(".png"))
            .filter(|value| Uuid::parse_str(value).is_ok())
        else {
            return Err(BrowserError::invalid("invalid browser artifact name"));
        };
        if fs::symlink_metadata(path).is_ok_and(|metadata| {
            metadata.file_type().is_file() && !metadata.file_type().is_symlink()
        }) {
            fs::remove_file(path).map_err(internal_error)?;
        }
        let descriptor_path = root.join(format!("design-crop-{id}.artifact.json"));
        if fs::symlink_metadata(&descriptor_path).is_ok_and(|metadata| {
            metadata.file_type().is_file() && !metadata.file_type().is_symlink()
        }) {
            fs::remove_file(descriptor_path).map_err(internal_error)?;
        }
        Ok(())
    }

    fn remove_owned_profile_directory(&self, path: &Path) -> BrowserResult<()> {
        if path.parent() != Some(self.profile_root.as_path())
            || !path.starts_with(&self.profile_root)
        {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser profile cleanup escaped the VibeLink profile root",
            ));
        }
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                fs::remove_file(path).map_err(internal_error)
            }
            Ok(metadata) if metadata.file_type().is_dir() => {
                fs::remove_dir_all(path).map_err(internal_error)
            }
            Ok(_) => Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser profile cleanup target is not a directory",
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(internal_error(error)),
        }
    }

    pub fn policy(&self) -> &BrowserPolicy {
        &self.policy
    }

    fn mutation_lock(&self, page_id: &str) -> BrowserResult<Arc<Mutex<()>>> {
        lock(&self.page_mutations)?
            .get(page_id)
            .cloned()
            .ok_or_else(|| BrowserError::not_found(page_id))
    }
}

fn artifact_name_from_descriptor(descriptor_name: &str) -> Option<String> {
    let id = descriptor_name
        .strip_prefix("design-crop-")?
        .strip_suffix(".artifact.json")?;
    Uuid::parse_str(id).ok()?;
    Some(format!("design-crop-{id}.png"))
}

fn read_restore_document(path: &Path) -> BrowserResult<BrowserRestoreDocument> {
    #[cfg(windows)]
    let bytes = read_restore_bytes_windows(path)?;
    #[cfg(not(windows))]
    let bytes = {
        let metadata = fs::metadata(path).map_err(internal_error)?;
        if metadata.len() > MAX_BROWSER_RESTORE_BYTES {
            return Err(BrowserError::new(
                BrowserErrorCode::Internal,
                "browser restore file exceeds the bounded size",
            ));
        }
        fs::read(path).map_err(internal_error)?
    };
    if bytes.len() as u64 > MAX_BROWSER_RESTORE_BYTES {
        return Err(BrowserError::new(
            BrowserErrorCode::Internal,
            "browser restore file exceeds the bounded size",
        ));
    }
    serde_json::from_slice(&bytes).map_err(internal_error)
}
fn restore_path_exists(path: &Path) -> BrowserResult<bool> {
    #[cfg(windows)]
    {
        match retry_windows_restore_io(|| fs::metadata(path)) {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(map_windows_restore_error(error)),
        }
    }
    #[cfg(not(windows))]
    {
        path.try_exists().map_err(internal_error)
    }
}

#[cfg(windows)]
fn read_restore_bytes_windows(path: &Path) -> BrowserResult<Vec<u8>> {
    let metadata =
        retry_windows_restore_io(|| fs::metadata(path)).map_err(map_windows_restore_error)?;
    if metadata.len() > MAX_BROWSER_RESTORE_BYTES {
        return Err(BrowserError::new(
            BrowserErrorCode::Internal,
            "browser restore file exceeds the bounded size",
        ));
    }
    retry_windows_restore_io(|| {
        let mut file = fs::File::open(path)?;
        let mut bytes = Vec::with_capacity(metadata.len() as usize);
        file.read_to_end(&mut bytes)?;
        Ok(bytes)
    })
    .map_err(map_windows_restore_error)
}

#[cfg(windows)]
fn write_restore_bytes_atomically(path: &Path, bytes: &[u8]) -> BrowserResult<()> {
    use std::os::windows::fs::OpenOptionsExt;

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    retry_windows_restore_io(|| fs::create_dir_all(parent)).map_err(map_windows_restore_error)?;
    let lock_path = path.with_extension("json.lock");
    let _cross_process_lock = retry_windows_restore_io(|| {
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0)
            .open(&lock_path)
    })
    .map_err(map_windows_restore_error)?;

    let transaction = format!("{}-{}", std::process::id(), Uuid::new_v4());
    let temporary = path.with_extension(format!("json.tmp-{transaction}"));
    let backup_staging = path.with_extension(format!("json.bak-{transaction}"));
    let backup = path.with_extension("json.bak");
    let result = (|| {
        let mut temporary_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(map_windows_restore_error)?;
        temporary_file
            .write_all(bytes)
            .map_err(map_windows_restore_error)?;
        temporary_file
            .sync_all()
            .map_err(map_windows_restore_error)?;
        drop(temporary_file);

        let target_exists = match retry_windows_restore_io(|| fs::metadata(path)) {
            Ok(_) => true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(map_windows_restore_error(error)),
        };
        if target_exists {
            match retry_windows_restore_io(|| fs::copy(path, &backup_staging)) {
                Ok(_) => {
                    retry_windows_restore_io(|| {
                        fs::OpenOptions::new()
                            .write(true)
                            .open(&backup_staging)?
                            .sync_all()
                    })
                    .map_err(map_windows_restore_error)?;
                    retry_windows_restore_io(|| {
                        move_file_replace_windows(&backup_staging, &backup)
                    })
                    .map_err(map_windows_restore_error)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(map_windows_restore_error(error)),
            }
        }

        retry_windows_restore_io(|| replace_restore_file_windows(path, &temporary))
            .map_err(map_windows_restore_error)
    })();
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_file(&backup_staging);
    result
}

#[cfg(not(windows))]
fn write_restore_bytes_atomically(path: &Path, bytes: &[u8]) -> BrowserResult<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(internal_error)?;
    let transaction = format!("{}-{}", std::process::id(), Uuid::new_v4());
    let temporary = path.with_extension(format!("json.tmp-{transaction}"));
    let backup_staging = path.with_extension(format!("json.bak-{transaction}"));
    let backup = path.with_extension("json.bak");
    let result = (|| {
        let mut temporary_file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(internal_error)?;
        temporary_file.write_all(bytes).map_err(internal_error)?;
        temporary_file.sync_all().map_err(internal_error)?;
        drop(temporary_file);
        if path.exists() {
            fs::copy(path, &backup_staging).map_err(internal_error)?;
            fs::File::open(&backup_staging)
                .and_then(|file| file.sync_all())
                .map_err(internal_error)?;
            fs::rename(&backup_staging, &backup).map_err(internal_error)?;
        }
        fs::rename(&temporary, path).map_err(internal_error)?;
        fs::File::open(path)
            .and_then(|file| file.sync_all())
            .map_err(internal_error)
    })();
    let _ = fs::remove_file(&temporary);
    let _ = fs::remove_file(&backup_staging);
    result
}

#[cfg(windows)]
fn retry_windows_restore_io<T>(
    mut action: impl FnMut() -> std::io::Result<T>,
) -> std::io::Result<T> {
    for attempt in 0..WINDOWS_RESTORE_RETRY_ATTEMPTS {
        match action() {
            Err(error)
                if is_windows_restore_sharing_error(&error)
                    && attempt + 1 < WINDOWS_RESTORE_RETRY_ATTEMPTS =>
            {
                std::thread::sleep(std::time::Duration::from_millis(
                    WINDOWS_RESTORE_RETRY_DELAY_MS * (attempt as u64 + 1),
                ));
            }
            result => return result,
        }
    }
    unreachable!("bounded restore retry loop always returns")
}

#[cfg(windows)]
fn is_windows_restore_sharing_error(error: &std::io::Error) -> bool {
    matches!(error.raw_os_error(), Some(5 | 32 | 33))
}

#[cfg(windows)]
fn map_windows_restore_error(error: std::io::Error) -> BrowserError {
    if is_windows_restore_sharing_error(&error) {
        BrowserError::new(
            BrowserErrorCode::Conflict,
            "browser restore state is busy in another VibeLink instance after bounded retries",
        )
    } else {
        internal_error(error)
    }
}

#[cfg(windows)]
fn replace_restore_file_windows(target: &Path, replacement: &Path) -> std::io::Result<()> {
    move_file_replace_windows(replacement, target)
}

#[cfg(windows)]
fn move_file_replace_windows(source: &Path, destination: &Path) -> std::io::Result<()> {
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source_wide = windows_path(source);
    let destination_wide = windows_path(destination);
    unsafe {
        MoveFileExW(
            PCWSTR(source_wide.as_ptr()),
            PCWSTR(destination_wide.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    }
    .map_err(windows_error_to_io)
}

#[cfg(windows)]
fn windows_path(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

#[cfg(windows)]
fn windows_error_to_io(error: windows::core::Error) -> std::io::Error {
    std::io::Error::from_raw_os_error((error.code().0 as u32 & 0xffff) as i32)
}

fn validate_restore_document(document: &BrowserRestoreDocument) -> BrowserResult<()> {
    if document.version != BROWSER_RESTORE_VERSION
        || document.profiles.len() > 256
        || document.pages.len() > 4_096
    {
        return Err(BrowserError::new(
            BrowserErrorCode::Internal,
            "invalid browser restore document header",
        ));
    }
    let mut profiles = HashSet::new();
    for profile in &document.profiles {
        validate_identifier("profile", &profile.id)?;
        if profile.kind == ProfileKind::Incognito || !profiles.insert(profile.id.as_str()) {
            return Err(BrowserError::new(
                BrowserErrorCode::Internal,
                "invalid browser restore profile",
            ));
        }
        if let Some(workspace_id) = profile.workspace_id.as_deref() {
            validate_identifier("workspace", workspace_id)?;
        }
    }
    let mut pages = HashSet::new();
    for page in &document.pages {
        validate_identifier("page", &page.id)?;
        validate_identifier("workspace", &page.workspace_id)?;
        validate_identifier("profile", &page.profile_id)?;
        if !profiles.contains(page.profile_id.as_str())
            || !pages.insert(page.id.as_str())
            || !page.bounds.validate()
            || page
                .device_metrics
                .is_some_and(|metrics| !metrics.validate())
        {
            return Err(BrowserError::new(
                BrowserErrorCode::Internal,
                "invalid browser restore page",
            ));
        }
    }
    Ok(())
}

fn validate_annotation_input(input: &BrowserAnnotationInput) -> BrowserResult<()> {
    validate_identifier("workspace", &input.workspace_id)?;
    validate_identifier("page", &input.page_id)?;
    if !input.bounds.validate()
        || input.bounds.width > 10_000
        || input.bounds.height > 10_000
        || input.browser_ref.is_empty()
        || input.browser_ref.len() > 4_096
        || input.accessible_name.len() > 16_384
        || input.tag_name.len() > 128
        || input.selector.len() > 4_096
        || input.full_path.len() > 4_096
        || input.role.len() > 256
        || input.react_components.len() > 2_048
        // Orca clamps the HTML snippet to 4 KiB in the guest; allow headroom for
        // multi-byte markup without letting a hostile page stream unbounded DOM.
        || input.html_snippet.len() > 32 * 1024
        || input.text.len() > 64 * 1024
        || input.comment.len() > 16 * 1024
        || input.nearby_text.len() > 32
        || input.ancestor_path.len() > 128
        || input.attributes.len() > 256
        || input.computed_styles.len() > 256
        || input.source_hints.len() > 128
    {
        return Err(BrowserError::invalid(
            "browser annotation exceeds bounded input limits",
        ));
    }
    let strings = input
        .ancestor_path
        .iter()
        .chain(input.nearby_text.iter())
        .chain(input.source_hints.iter())
        .chain(
            input
                .attributes
                .iter()
                .flat_map(|(name, value)| [name, value]),
        )
        .chain(
            input
                .computed_styles
                .iter()
                .flat_map(|(name, value)| [name, value]),
        );
    if strings
        .into_iter()
        .any(|value| value.len() > 16 * 1024 || value.contains('\0'))
    {
        return Err(BrowserError::invalid(
            "browser annotation contains an invalid field",
        ));
    }
    Ok(())
}

fn vibelink_owned_profile_path(root: &Path, id: &str) -> BrowserResult<PathBuf> {
    let path = root.join(id);
    if !path.starts_with(root) {
        return Err(BrowserError::new(
            BrowserErrorCode::DeniedCapability,
            "browser profile path escaped the VibeLink profile root",
        ));
    }
    let normalized = path
        .to_string_lossy()
        .replace('\\', "/")
        .to_ascii_lowercase();
    if normalized.contains("/google/chrome/user data")
        || normalized.contains("/microsoft/edge/user data")
        || normalized.contains("/chromium/user data")
    {
        return Err(BrowserError::new(
            BrowserErrorCode::DeniedCapability,
            "browser profiles must not reuse Chrome, Edge, or Chromium user-data roots",
        ));
    }
    Ok(path)
}

fn internal_error(error: impl std::fmt::Display) -> BrowserError {
    BrowserError::new(BrowserErrorCode::Internal, error.to_string())
}

fn push_event_locked(
    state: &mut ManagerState,
    page_id: &str,
    navigation_generation: u64,
    kind: BrowserLifecycleEventKind,
    url: Option<String>,
    detail: Option<String>,
) -> BrowserLifecycleEvent {
    state.event_sequence = state.event_sequence.saturating_add(1);
    let event = BrowserLifecycleEvent {
        sequence: state.event_sequence,
        page_id: page_id.to_string(),
        navigation_generation,
        kind,
        url,
        detail,
        timestamp_ms: now_ms(),
    };
    state.events.push_back(event.clone());
    while state.events.len() > MAX_LIFECYCLE_EVENTS {
        state.events.pop_front();
    }
    event
}

fn validate_identifier(kind: &str, value: &str) -> BrowserResult<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(BrowserError::invalid(format!("invalid {kind} id")));
    }
    Ok(())
}

fn lock<T>(mutex: &Mutex<T>) -> BrowserResult<MutexGuard<'_, T>> {
    mutex.lock().map_err(|_| {
        BrowserError::new(BrowserErrorCode::Internal, "browser state lock is poisoned")
    })
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::browser::types::ChildWebViewState;

    #[derive(Default)]
    struct TestProvider {
        events: Mutex<VecDeque<BrowserLifecycleEvent>>,
    }

    impl BrowserProvider for TestProvider {
        fn create_child_webview(&self, _request: &ChildWebViewCreate) -> BrowserResult<()> {
            Ok(())
        }

        fn set_bounds(&self, _page_id: &str, _bounds: PhysicalBounds) -> BrowserResult<()> {
            Ok(())
        }

        fn set_visible(&self, _page_id: &str, _visible: bool) -> BrowserResult<()> {
            Ok(())
        }

        fn set_focus(&self, _page_id: &str, _focused: bool) -> BrowserResult<()> {
            Ok(())
        }

        fn navigate(
            &self,
            _page_id: &str,
            _url: &str,
            _navigation_generation: u64,
        ) -> BrowserResult<()> {
            Ok(())
        }

        fn drain_events(&self) -> BrowserResult<Vec<BrowserLifecycleEvent>> {
            Ok(lock(&self.events)?.drain(..).collect())
        }

        fn close(&self, _page_id: &str) -> BrowserResult<()> {
            Ok(())
        }

        fn state(&self, _page_id: &str) -> BrowserResult<ChildWebViewState> {
            Err(BrowserError::unsupported("surface_state"))
        }
    }

    #[test]
    fn lifecycle_events_keep_the_latest_bounded_sequence() {
        let mut state = ManagerState::default();

        for _ in 0..=MAX_LIFECYCLE_EVENTS {
            push_event_locked(
                &mut state,
                "page",
                0,
                BrowserLifecycleEventKind::CaptureUpdated,
                None,
                None,
            );
        }

        assert_eq!(state.events.len(), MAX_LIFECYCLE_EVENTS);
        assert_eq!(state.events.front().unwrap().sequence, 2);
        assert_eq!(
            state.events.back().unwrap().sequence,
            MAX_LIFECYCLE_EVENTS as u64 + 1
        );
        assert_eq!(state.event_sequence, MAX_LIFECYCLE_EVENTS as u64 + 1);
        assert!(
            state
                .events
                .iter()
                .zip(state.events.iter().skip(1))
                .all(|(left, right)| left.sequence < right.sequence)
        );
    }

    #[test]
    fn download_records_keep_only_the_latest_requests() {
        let root = std::env::temp_dir().join(format!(
            "vibelink-browser-manager-test-{}",
            Uuid::new_v4()
        ));
        let provider = Arc::new(TestProvider::default());
        let manager = BrowserManager::new(
            provider.clone(),
            BrowserPolicy::new(
                false,
                Vec::new(),
                root.join("downloads"),
                root.join("artifacts"),
                1,
            )
            .unwrap(),
            root.join("profiles"),
        );
        manager
            .create_profile(
                "profile",
                crate::browser::types::ProfileKind::Incognito,
                None,
            )
            .unwrap();
        manager
            .create_page(
                "page",
                "workspace",
                "profile",
                PhysicalBounds {
                    x: 0,
                    y: 0,
                    width: 1,
                    height: 1,
                    scale_factor_milli: 1_000,
                },
            )
            .unwrap();

        lock(&provider.events).unwrap().extend(
            (1..=MAX_DOWNLOAD_RECORDS as u64 + 1).map(|sequence| BrowserLifecycleEvent {
                sequence,
                page_id: "page".to_string(),
                navigation_generation: 0,
                kind: BrowserLifecycleEventKind::DownloadRequested,
                url: Some(format!("https://example.test/{sequence}")),
                detail: Some(format!("download-{sequence}.bin")),
                timestamp_ms: sequence,
            }),
        );

        manager.sync_provider_events().unwrap();
        let downloads = manager.downloads().unwrap();

        assert_eq!(downloads.len(), MAX_DOWNLOAD_RECORDS);
        assert_eq!(downloads.first().unwrap().url, "https://example.test/2");
        assert_eq!(
            downloads.last().unwrap().url,
            format!(
                "https://example.test/{}",
                MAX_DOWNLOAD_RECORDS as u64 + 1
            )
        );
    }
}

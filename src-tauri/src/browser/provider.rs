use super::{
    error::{BrowserError, BrowserErrorCode, BrowserResult},
    types::{
        BrowserCookieImportInput, BrowserCookieImportResult, BrowserCookieImportSource,
        BrowserDeviceMetrics, BrowserDialogKind, BrowserFrame, BrowserLifecycleEvent,
        BrowserLifecycleEventKind, CertificateDecision, ChildWebViewCreate, ChildWebViewState,
        PermissionDecision, PhysicalBounds,
    },
};

pub trait BrowserProvider: Send + Sync + 'static {
    fn create_child_webview(&self, request: &ChildWebViewCreate) -> BrowserResult<()>;
    fn set_bounds(&self, page_id: &str, bounds: PhysicalBounds) -> BrowserResult<()>;
    fn set_visible(&self, page_id: &str, visible: bool) -> BrowserResult<()>;
    fn set_focus(&self, page_id: &str, focused: bool) -> BrowserResult<()>;
    fn set_surface(
        &self,
        page_id: &str,
        bounds: Option<PhysicalBounds>,
        visible: bool,
        focused: bool,
    ) -> BrowserResult<()> {
        if let Some(bounds) = bounds {
            self.set_bounds(page_id, bounds)?;
        }
        self.set_visible(page_id, visible)?;
        self.set_focus(page_id, visible && focused)
    }
    fn navigate(&self, page_id: &str, url: &str, navigation_generation: u64) -> BrowserResult<()>;
    fn set_navigation_generation(&self, _page_id: &str, _generation: u64) -> BrowserResult<()> {
        Ok(())
    }
    fn publish_lifecycle_event(&self, _event: &BrowserLifecycleEvent) {}
    fn go_back(&self, _page_id: &str) -> BrowserResult<()> {
        Err(BrowserError::unsupported("go_back"))
    }
    fn go_forward(&self, _page_id: &str) -> BrowserResult<()> {
        Err(BrowserError::unsupported("go_forward"))
    }
    fn reload(&self, _page_id: &str) -> BrowserResult<()> {
        Err(BrowserError::unsupported("reload"))
    }
    fn set_design_mode(&self, _page_id: &str, _enabled: bool) -> BrowserResult<()> {
        Err(BrowserError::unsupported("design_mode"))
    }
    fn set_device_metrics(
        &self,
        _page_id: &str,
        _metrics: BrowserDeviceMetrics,
    ) -> BrowserResult<()> {
        Err(BrowserError::unsupported("device_metrics"))
    }
    fn clear_device_metrics(&self, _page_id: &str) -> BrowserResult<()> {
        Err(BrowserError::unsupported("clear_device_metrics"))
    }
    fn drain_events(&self) -> BrowserResult<Vec<BrowserLifecycleEvent>> {
        Ok(Vec::new())
    }
    fn requeue_events(&self, _events: Vec<BrowserLifecycleEvent>) -> BrowserResult<()> {
        Ok(())
    }
    fn capture_frame(
        &self,
        _page_id: &str,
        _sequence: u64,
        _navigation_generation: u64,
    ) -> BrowserResult<BrowserFrame> {
        Err(BrowserError::unsupported("capture_frame"))
    }
    fn capture_crop(&self, _page_id: &str, _bounds: PhysicalBounds) -> BrowserResult<Vec<u8>> {
        Err(BrowserError::unsupported("capture_crop"))
    }
    fn detect_cookie_import_source(
        &self,
        _endpoint: &str,
    ) -> BrowserResult<BrowserCookieImportSource> {
        Err(BrowserError::unsupported("detect_cookie_import_source"))
    }
    fn import_cookies(
        &self,
        _input: &BrowserCookieImportInput,
    ) -> BrowserResult<BrowserCookieImportResult> {
        Err(BrowserError::unsupported("import_cookies"))
    }
    fn resolve_permission(
        &self,
        _request_id: &str,
        _decision: PermissionDecision,
    ) -> BrowserResult<()> {
        Ok(())
    }
    fn resolve_certificate(
        &self,
        _request_id: &str,
        _decision: CertificateDecision,
    ) -> BrowserResult<()> {
        Ok(())
    }
    fn resolve_dialog(&self, _request_id: &str, _accept: bool) -> BrowserResult<()> {
        Ok(())
    }
    fn release_profile(&self, _profile_id: &str) -> BrowserResult<()> {
        Ok(())
    }
    fn close(&self, page_id: &str) -> BrowserResult<()>;
    fn state(&self, page_id: &str) -> BrowserResult<ChildWebViewState>;
}

#[derive(Clone, Copy, Debug, Default)]
pub struct UnsupportedBrowserProvider;

impl BrowserProvider for UnsupportedBrowserProvider {
    fn create_child_webview(&self, _request: &ChildWebViewCreate) -> BrowserResult<()> {
        Err(BrowserError::new(
            BrowserErrorCode::RuntimeUnavailable,
            "native child WebView2 runtime is not wired into the Tauri application",
        ))
    }

    fn set_bounds(&self, _page_id: &str, _bounds: PhysicalBounds) -> BrowserResult<()> {
        Err(BrowserError::unsupported("set_bounds"))
    }

    fn set_visible(&self, _page_id: &str, _visible: bool) -> BrowserResult<()> {
        Err(BrowserError::unsupported("show/hide"))
    }

    fn set_focus(&self, _page_id: &str, _focused: bool) -> BrowserResult<()> {
        Err(BrowserError::unsupported("set_focus"))
    }

    fn navigate(
        &self,
        _page_id: &str,
        _url: &str,
        _navigation_generation: u64,
    ) -> BrowserResult<()> {
        Err(BrowserError::unsupported("navigate"))
    }

    fn close(&self, _page_id: &str) -> BrowserResult<()> {
        Err(BrowserError::unsupported("close"))
    }

    fn state(&self, _page_id: &str) -> BrowserResult<ChildWebViewState> {
        Err(BrowserError::unsupported("surface_state"))
    }
}

#[cfg(windows)]
use serde::{Deserialize, Serialize};
#[cfg(windows)]
use serde_json::{json, Value};
#[cfg(windows)]
use sha2::{Digest, Sha256};
#[cfg(windows)]
use std::net::TcpStream;
#[cfg(windows)]
use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap, HashSet, VecDeque},
    fs,
    io::Read,
    net::TcpListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc, Arc, Mutex, MutexGuard,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
#[cfg(windows)]
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Rect, Webview, WebviewBuilder,
    WebviewUrl, Wry,
};
#[cfg(windows)]
use tungstenite::{connect, stream::MaybeTlsStream, Message, WebSocket};
#[cfg(windows)]
use webview2_com::{
    take_pwstr,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2PermissionRequestedEventArgs3, ICoreWebView2_14, COREWEBVIEW2_PERMISSION_KIND,
        COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
        COREWEBVIEW2_PERMISSION_STATE_DENY, COREWEBVIEW2_SCRIPT_DIALOG_KIND,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT, COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM, COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT,
        COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW,
        COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL,
    },
    PermissionRequestedEventHandler, ScriptDialogOpeningEventHandler,
    ServerCertificateErrorDetectedEventHandler,
};
#[cfg(windows)]
use windows::core::{Interface, PWSTR};

#[cfg(windows)]
struct NativePage {
    webview: Webview<Wry>,
    state: ChildWebViewState,
    profile_id: String,
    workspace_id: String,
}

#[cfg(windows)]
type PermissionResolver = Box<dyn Fn(PermissionDecision) -> BrowserResult<()> + 'static>;
#[cfg(windows)]
type CertificateResolver = Box<dyn Fn(CertificateDecision) -> BrowserResult<()> + 'static>;
#[cfg(windows)]
type DialogResolver = Box<dyn Fn(bool) -> BrowserResult<()> + 'static>;
#[cfg(windows)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PromptResolutionStatus {
    Queued,
    InFlight,
    Completed,
}
#[cfg(windows)]
#[derive(Clone, Debug)]
struct PendingPrompt {
    page_id: String,
    status: PromptResolutionStatus,
}

#[cfg(windows)]
thread_local! {
    static NATIVE_PERMISSION_RESOLVERS: RefCell<HashMap<String, PermissionResolver>> = RefCell::new(HashMap::new());
    static NATIVE_CERTIFICATE_RESOLVERS: RefCell<HashMap<String, CertificateResolver>> = RefCell::new(HashMap::new());
    static NATIVE_DIALOG_RESOLVERS: RefCell<HashMap<String, DialogResolver>> = RefCell::new(HashMap::new());
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CdpRegistry {
    version: u8,
    main_port: u16,
    profiles: Vec<CdpRegistryProfile>,
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CdpRegistryProfile {
    profile_id: String,
    port: u16,
    pages: Vec<CdpRegistryPage>,
}

#[cfg(windows)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CdpRegistryPage {
    page_id: String,
    workspace_id: String,
}

#[cfg(windows)]
type EventPumpScheduler = Arc<dyn Fn() + Send + Sync + 'static>;

#[cfg(windows)]
pub struct NativeBrowserProvider {
    app: AppHandle<Wry>,
    parent_window_label: String,
    pages: Mutex<HashMap<String, NativePage>>,
    profile_ports: Mutex<HashMap<String, u16>>,
    navigation_generations: Arc<Mutex<HashMap<String, u64>>>,
    managed_navigation_starts: Arc<Mutex<HashMap<String, u64>>>,
    events: Arc<Mutex<VecDeque<BrowserLifecycleEvent>>>,
    event_sequence: Arc<AtomicU64>,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPrompt>>>,
    pending_certificates: Arc<Mutex<HashMap<String, PendingPrompt>>>,
    pending_dialogs: Arc<Mutex<HashMap<String, PendingPrompt>>>,
    registry_path: PathBuf,
    event_pump_scheduler: EventPumpScheduler,
    download_root: PathBuf,
    main_cdp_port: u16,
}

#[cfg(windows)]
impl NativeBrowserProvider {
    pub fn new(
        app: AppHandle<Wry>,
        parent_window_label: impl Into<String>,
        registry_path: PathBuf,
        main_cdp_port: u16,
        schedule_event_pump: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        let download_root = registry_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("downloads");
        let provider = Self {
            app,
            parent_window_label: parent_window_label.into(),
            pages: Mutex::new(HashMap::new()),
            profile_ports: Mutex::new(HashMap::new()),
            navigation_generations: Arc::new(Mutex::new(HashMap::new())),
            managed_navigation_starts: Arc::new(Mutex::new(HashMap::new())),
            events: Arc::new(Mutex::new(VecDeque::new())),
            event_sequence: Arc::new(AtomicU64::new(0)),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            pending_certificates: Arc::new(Mutex::new(HashMap::new())),
            pending_dialogs: Arc::new(Mutex::new(HashMap::new())),
            registry_path,
            download_root,
            main_cdp_port,
            event_pump_scheduler: Arc::new(schedule_event_pump),
        };
        let _ = provider.write_registry();
        provider
    }

    fn pages(&self) -> BrowserResult<MutexGuard<'_, HashMap<String, NativePage>>> {
        self.pages.lock().map_err(|_| {
            BrowserError::new(
                BrowserErrorCode::Internal,
                "native browser state lock is poisoned",
            )
        })
    }

    fn validate_user_data_dir(&self, user_data_dir: &std::path::Path) -> BrowserResult<()> {
        let owned_root = self
            .registry_path
            .parent()
            .unwrap_or_else(|| std::path::Path::new("."))
            .join("profiles");
        let contains_parent = user_data_dir
            .components()
            .any(|component| component == std::path::Component::ParentDir);
        let normalized = user_data_dir
            .to_string_lossy()
            .replace('\\', "/")
            .to_ascii_lowercase();
        if contains_parent
            || user_data_dir == owned_root
            || !user_data_dir.starts_with(&owned_root)
            || normalized.contains("/google/chrome/user data")
            || normalized.contains("/microsoft/edge/user data")
            || normalized.contains("/chromium/user data")
        {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "browser user-data directories must be isolated under the VibeLink profile root",
            ));
        }
        Ok(())
    }

    fn complete_on_page<F>(&self, page_id: &str, operation: F) -> BrowserResult<()>
    where
        F: FnOnce() -> BrowserResult<()> + Send + 'static,
    {
        let webview = self
            .pages()?
            .get(page_id)
            .map(|page| page.webview.clone())
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        let (sender, receiver) = mpsc::sync_channel(1);
        webview
            .with_webview(move |_| {
                let _ = sender.send(operation());
            })
            .map_err(native_error)?;
        receiver
            .recv_timeout(Duration::from_secs(5))
            .map_err(|error| {
                BrowserError::new(
                    BrowserErrorCode::Timeout,
                    format!("native browser prompt resolution timed out: {error}"),
                )
            })?
    }

    fn profile_port(&self, profile_id: &str) -> BrowserResult<u16> {
        let mut ports = self.profile_ports.lock().map_err(|_| {
            BrowserError::new(
                BrowserErrorCode::Internal,
                "native browser profile lock is poisoned",
            )
        })?;
        if let Some(port) = ports.get(profile_id) {
            return Ok(*port);
        }
        let start = self.main_cdp_port.saturating_add(1);
        let port = (start..start.saturating_add(256))
            .find(|candidate| {
                !ports.values().any(|port| port == candidate)
                    && TcpListener::bind(("127.0.0.1", *candidate)).is_ok()
            })
            .ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorCode::RuntimeUnavailable,
                    "no local CDP port is available for the browser profile",
                )
            })?;
        ports.insert(profile_id.to_string(), port);
        Ok(port)
    }

    fn emit_event(
        &self,
        page_id: &str,
        navigation_generation: u64,
        kind: BrowserLifecycleEventKind,
        url: Option<String>,
        detail: Option<String>,
    ) {
        emit_native_event(
            &self.event_pump_scheduler,
            &self.events,
            &self.event_sequence,
            page_id,
            navigation_generation,
            kind,
            url,
            detail,
        );
    }

    fn release_profile_port(&self, profile_id: &str) -> BrowserResult<()> {
        if self
            .pages()?
            .values()
            .any(|page| page.profile_id == profile_id)
        {
            return Err(BrowserError::new(
                BrowserErrorCode::Conflict,
                "browser profile still owns native pages",
            ));
        }
        self.profile_ports
            .lock()
            .map_err(|_| {
                BrowserError::new(
                    BrowserErrorCode::Internal,
                    "native browser profile lock is poisoned",
                )
            })?
            .remove(profile_id);
        self.write_registry()
    }

    fn write_registry(&self) -> BrowserResult<()> {
        let ports = self.profile_ports.lock().map_err(|_| {
            BrowserError::new(
                BrowserErrorCode::Internal,
                "native browser profile lock is poisoned",
            )
        })?;
        let pages = self.pages()?;
        let mut profiles = ports
            .iter()
            .map(|(profile_id, port)| {
                let mut profile_pages = pages
                    .iter()
                    .filter(|(_, page)| page.profile_id == *profile_id)
                    .map(|(page_id, page)| CdpRegistryPage {
                        page_id: page_id.clone(),
                        workspace_id: page.workspace_id.clone(),
                    })
                    .collect::<Vec<_>>();
                profile_pages.sort_by(|left, right| left.page_id.cmp(&right.page_id));
                CdpRegistryProfile {
                    profile_id: profile_id.clone(),
                    port: *port,
                    pages: profile_pages,
                }
            })
            .collect::<Vec<_>>();
        profiles.sort_by(|left, right| left.profile_id.cmp(&right.profile_id));
        if let Some(parent) = self.registry_path.parent() {
            fs::create_dir_all(parent).map_err(registry_error)?;
        }
        let bytes = serde_json::to_vec(&CdpRegistry {
            version: 2,
            main_port: self.main_cdp_port,
            profiles,
        })
        .map_err(registry_error)?;
        fs::write(&self.registry_path, bytes).map_err(registry_error)
    }
}

#[cfg(windows)]
impl BrowserProvider for NativeBrowserProvider {
    fn create_child_webview(&self, request: &ChildWebViewCreate) -> BrowserResult<()> {
        if !request.external_guest
            || request.tauri_ipc_allowed
            || request.app_initialization_allowed
        {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "external browser pages must not receive app IPC or initialization",
            ));
        }
        if let Some(user_data_dir) = request.user_data_dir.as_deref() {
            self.validate_user_data_dir(user_data_dir)?;
        }
        let url = url::Url::parse(&request.initial_url)
            .map_err(|error| BrowserError::invalid(format!("invalid browser URL: {error}")))?;
        if !matches!(url.scheme(), "http" | "https" | "about") {
            return Err(BrowserError::new(
                BrowserErrorCode::UnsafeUrl,
                "unsafe browser URL scheme",
            ));
        }
        let window = self
            .app
            .get_window(&self.parent_window_label)
            .ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorCode::RuntimeUnavailable,
                    "browser parent window is unavailable",
                )
            })?;
        let cdp_port = self.profile_port(&request.profile_id)?;
        let browser_arguments = format!(
            "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required --remote-debugging-port={cdp_port}"
        );
        let page_name = serde_json::to_string(&format!("vibelink-page:{}", request.page_id))
            .map_err(registry_error)?;
        let design_app = self.app.clone();
        let design_page_id = request.page_id.clone();
        let design_generations = self.navigation_generations.clone();
        let navigation_event_pump = self.event_pump_scheduler.clone();
        let navigation_events = self.events.clone();
        let navigation_sequence = self.event_sequence.clone();
        let navigation_page_id = request.page_id.clone();
        let navigation_generations = self.navigation_generations.clone();
        let managed_navigation_starts = self.managed_navigation_starts.clone();
        let popup_event_pump = self.event_pump_scheduler.clone();
        let popup_events = self.events.clone();
        let popup_sequence = self.event_sequence.clone();
        let popup_page_id = request.page_id.clone();
        let popup_generations = self.navigation_generations.clone();
        let load_event_pump = self.event_pump_scheduler.clone();
        let load_events = self.events.clone();
        let load_sequence = self.event_sequence.clone();
        let load_page_id = request.page_id.clone();
        let load_generations = self.navigation_generations.clone();
        let load_managed_navigation_starts = self.managed_navigation_starts.clone();
        let title_event_pump = self.event_pump_scheduler.clone();
        let title_events = self.events.clone();
        let title_sequence = self.event_sequence.clone();
        let title_page_id = request.page_id.clone();
        let title_generations = self.navigation_generations.clone();
        let download_event_pump = self.event_pump_scheduler.clone();
        let download_events = self.events.clone();
        let download_sequence = self.event_sequence.clone();
        let download_page_id = request.page_id.clone();
        let download_generations = self.navigation_generations.clone();
        let download_root = self.download_root.clone();
        let mut builder = WebviewBuilder::new(&request.label, WebviewUrl::External(url))
            .initialization_script(format!("window.name={page_name};"))
            .on_navigation(move |url| {
                if url.scheme() == "vibelink-design" {
                    if let Some((_, payload)) = url.query_pairs().find(|(name, _)| name == "payload") {
                        if let Ok(selection) = serde_json::from_str::<serde_json::Value>(&payload) {
                            let _ = design_app.emit(
                                "browser-design-grab",
                                serde_json::json!({
                                    "pageId": design_page_id,
                                    "navigationGeneration": generation_for(&design_generations, &design_page_id),
                                    "selection": selection,
                                }),
                            );
                        }
                    }
                    return false;
                }
                let allowed = matches!(url.scheme(), "http" | "https" | "about");
                if allowed {
                    let (generation, native_start) = begin_native_navigation(
                        &navigation_generations,
                        &managed_navigation_starts,
                        &navigation_page_id,
                    );
                    if native_start {
                        emit_native_event(
                            &navigation_event_pump,
                            &navigation_events,
                            &navigation_sequence,
                            &navigation_page_id,
                            generation,
                            BrowserLifecycleEventKind::NavigationStarted,
                            Some(url.to_string()),
                            None,
                        );
                    }
                }
                allowed
            })
            .on_new_window(move |url, _features| {
                let generation = generation_for(&popup_generations, &popup_page_id);
                emit_native_event(
                    &popup_event_pump,
                    &popup_events,
                    &popup_sequence,
                    &popup_page_id,
                    generation,
                    BrowserLifecycleEventKind::PopupRequested,
                    Some(url.to_string()),
                    Some("popup blocked pending explicit tab creation".to_string()),
                );
                NewWindowResponse::Deny
            })
            .on_page_load(move |_webview, payload| {
                let generation = generation_for(&load_generations, &load_page_id);
                let url = payload.url().to_string();
                let (kind, detail, terminal) = if url.starts_with("edge-error://") {
                    (
                        BrowserLifecycleEventKind::NavigationFailed,
                        Some("WebView2 loaded an error document".to_string()),
                        true,
                    )
                } else {
                    match payload.event() {
                        PageLoadEvent::Started => (
                            BrowserLifecycleEventKind::NavigationCommitted,
                            None,
                            false,
                        ),
                        PageLoadEvent::Finished => (
                            BrowserLifecycleEventKind::NavigationFinished,
                            None,
                            true,
                        ),
                    }
                };
                emit_native_event(
                    &load_event_pump,
                    &load_events,
                    &load_sequence,
                    &load_page_id,
                    generation,
                    kind,
                    Some(url),
                    detail,
                );
                if terminal {
                    if let Ok(mut starts) = load_managed_navigation_starts.lock() {
                        starts.remove(&load_page_id);
                    }
                }
            })
            .on_document_title_changed(move |_webview, title| {
                emit_native_event(
                    &title_event_pump,
                    &title_events,
                    &title_sequence,
                    &title_page_id,
                    generation_for(&title_generations, &title_page_id),
                    BrowserLifecycleEventKind::TitleChanged,
                    None,
                    Some(title),
                );
            })
            .on_download(move |_webview, event| {
                let generation = generation_for(&download_generations, &download_page_id);
                match event {
                    DownloadEvent::Requested { url, destination } => {
                        let suggested = destination
                            .file_name()
                            .and_then(|value| value.to_str())
                            .filter(|value| !value.is_empty())
                            .unwrap_or("download.bin");
                        match reserve_native_download(&download_root, suggested) {
                            Ok(path) => {
                                *destination = path.clone();
                                emit_native_event(
                                    &download_event_pump,
                                    &download_events,
                                    &download_sequence,
                                    &download_page_id,
                                    generation,
                                    BrowserLifecycleEventKind::DownloadRequested,
                                    Some(url.to_string()),
                                    Some(path.to_string_lossy().into_owned()),
                                );
                                true
                            }
                            Err(error) => {
                                emit_native_event(
                                    &download_event_pump,
                                    &download_events,
                                    &download_sequence,
                                    &download_page_id,
                                    generation,
                                    BrowserLifecycleEventKind::DownloadFinished,
                                    Some(url.to_string()),
                                    Some(format!("denied: {}", error.message)),
                                );
                                false
                            }
                        }
                    }
                    DownloadEvent::Finished { url, path, success } => {
                        emit_native_event(
                            &download_event_pump,
                            &download_events,
                            &download_sequence,
                            &download_page_id,
                            generation,
                            BrowserLifecycleEventKind::DownloadFinished,
                            Some(url.to_string()),
                            Some(format!(
                                "{}: {}",
                                if success { "completed" } else { "failed" },
                                path.as_ref()
                                    .map(|value| value.to_string_lossy().into_owned())
                                    .unwrap_or_else(|| "no destination".to_string())
                            )),
                        );
                        true
                    }
                    _ => true,
                }
            })
            .additional_browser_args(&browser_arguments);
        if let Some(user_data_dir) = &request.user_data_dir {
            builder = builder.data_directory(user_data_dir.clone());
        } else {
            builder = builder.incognito(true);
        }
        let bounds = request.bounds;
        let webview = window
            .add_child(
                builder,
                PhysicalPosition::new(bounds.x, bounds.y),
                PhysicalSize::new(bounds.width, bounds.height),
            )
            .map_err(|error| {
                BrowserError::new(BrowserErrorCode::RuntimeUnavailable, error.to_string())
            })?;
        let attach_event_pump = self.event_pump_scheduler.clone();
        let attach_events = self.events.clone();
        let attach_sequence = self.event_sequence.clone();
        let attach_generations = self.navigation_generations.clone();
        let attach_page_id = request.page_id.clone();
        let attach_permissions = self.pending_permissions.clone();
        let attach_certificates = self.pending_certificates.clone();
        let attach_dialogs = self.pending_dialogs.clone();
        webview
            .with_webview(move |platform| {
                if let Err(error) = attach_native_prompt_handlers(
                    platform,
                    attach_event_pump.clone(),
                    attach_events.clone(),
                    attach_sequence.clone(),
                    attach_generations.clone(),
                    attach_page_id.clone(),
                    attach_permissions,
                    attach_certificates,
                    attach_dialogs,
                ) {
                    emit_native_event(
                        &attach_event_pump,
                        &attach_events,
                        &attach_sequence,
                        &attach_page_id,
                        generation_for(&attach_generations, &attach_page_id),
                        BrowserLifecycleEventKind::NavigationFailed,
                        None,
                        Some(format!(
                            "WebView2 security handler registration failed: {error}"
                        )),
                    );
                }
            })
            .map_err(native_error)?;
        webview.hide().map_err(native_error)?;
        let mut pages = self.pages()?;
        if pages.contains_key(&request.page_id) {
            let _ = webview.close();
            return Err(BrowserError::new(
                BrowserErrorCode::Conflict,
                "browser page already exists",
            ));
        }
        pages.insert(
            request.page_id.clone(),
            NativePage {
                webview,
                state: ChildWebViewState {
                    page_id: request.page_id.clone(),
                    bounds,
                    visible: false,
                    focused: false,
                    realized: true,
                },
                profile_id: request.profile_id.clone(),
                workspace_id: request.workspace_id.clone(),
            },
        );
        if let Ok(mut generations) = self.navigation_generations.lock() {
            generations.insert(request.page_id.clone(), 0);
        }
        self.emit_event(
            &request.page_id,
            0,
            BrowserLifecycleEventKind::PageCreated,
            Some(request.initial_url.clone()),
            Some(request.profile_id.clone()),
        );
        drop(pages);
        // The registry is diagnostic/recovery metadata. The native page is already
        // realized and owned here, so a registry write failure must not orphan it.
        let _ = self.write_registry();
        Ok(())
    }

    fn set_bounds(&self, page_id: &str, bounds: PhysicalBounds) -> BrowserResult<()> {
        if !bounds.validate() {
            return Err(BrowserError::invalid(
                "browser bounds must be positive physical pixels",
            ));
        }
        let mut pages = self.pages()?;
        let page = pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.webview
            .set_bounds(Rect {
                position: PhysicalPosition::new(bounds.x, bounds.y).into(),
                size: PhysicalSize::new(bounds.width, bounds.height).into(),
            })
            .map_err(native_error)?;
        page.state.bounds = bounds;
        Ok(())
    }

    fn set_visible(&self, page_id: &str, visible: bool) -> BrowserResult<()> {
        let mut pages = self.pages()?;
        let page = pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        if visible {
            page.webview.show().map_err(native_error)?;
        } else {
            page.webview.hide().map_err(native_error)?;
            page.state.focused = false;
        }
        page.state.visible = visible;
        Ok(())
    }

    fn set_focus(&self, page_id: &str, focused: bool) -> BrowserResult<()> {
        let mut pages = self.pages()?;
        let page = pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        if focused {
            if !page.state.visible {
                return Err(BrowserError::new(
                    BrowserErrorCode::Conflict,
                    "hidden browser page cannot receive focus",
                ));
            }
            page.webview.set_focus().map_err(native_error)?;
        }
        page.state.focused = focused;
        Ok(())
    }

    fn set_surface(
        &self,
        page_id: &str,
        bounds: Option<PhysicalBounds>,
        visible: bool,
        focused: bool,
    ) -> BrowserResult<()> {
        if bounds.is_some_and(|value| !value.validate()) {
            return Err(BrowserError::invalid(
                "browser bounds must be positive physical pixels",
            ));
        }
        let mut pages = self.pages()?;
        let page = pages
            .get_mut(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        let previous = page.state.clone();
        let apply = (|| {
            let repositioning_visible_page =
                previous.visible && bounds.is_some_and(|next| next != previous.bounds);
            if !visible || repositioning_visible_page {
                page.webview.hide().map_err(native_error)?;
            }
            if let Some(bounds) = bounds {
                page.webview
                    .set_bounds(Rect {
                        position: PhysicalPosition::new(bounds.x, bounds.y).into(),
                        size: PhysicalSize::new(bounds.width, bounds.height).into(),
                    })
                    .map_err(native_error)?;
            }
            if visible {
                page.webview.show().map_err(native_error)?;
            }
            if visible && focused {
                page.webview.set_focus().map_err(native_error)?;
            }
            Ok::<(), BrowserError>(())
        })();
        if let Err(error) = apply {
            let _ = page.webview.set_bounds(Rect {
                position: PhysicalPosition::new(previous.bounds.x, previous.bounds.y).into(),
                size: PhysicalSize::new(previous.bounds.width, previous.bounds.height).into(),
            });
            let _ = if previous.visible {
                page.webview.show()
            } else {
                page.webview.hide()
            };
            if previous.visible && previous.focused {
                let _ = page.webview.set_focus();
            }
            return Err(error);
        }
        if let Some(bounds) = bounds {
            page.state.bounds = bounds;
        }
        page.state.visible = visible;
        page.state.focused = visible && focused;
        Ok(())
    }

    fn navigate(&self, page_id: &str, url: &str, navigation_generation: u64) -> BrowserResult<()> {
        let parsed = url::Url::parse(url)
            .map_err(|error| BrowserError::invalid(format!("invalid browser URL: {error}")))?;
        if !matches!(parsed.scheme(), "http" | "https" | "about") {
            return Err(BrowserError::new(
                BrowserErrorCode::UnsafeUrl,
                "unsafe browser URL scheme",
            ));
        }
        let pages = self.pages()?;
        let page = pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        let previous_generation = generation_for(&self.navigation_generations, page_id);
        prepare_managed_navigation(
            &self.navigation_generations,
            &self.managed_navigation_starts,
            page_id,
            navigation_generation,
        )?;
        if let Err(error) = page.webview.navigate(parsed) {
            let _ = restore_navigation_generation(
                &self.navigation_generations,
                &self.managed_navigation_starts,
                page_id,
                previous_generation,
            );
            self.emit_event(
                page_id,
                navigation_generation,
                BrowserLifecycleEventKind::NavigationFailed,
                Some(url.to_string()),
                Some(error.to_string()),
            );
            return Err(native_error(error));
        }
        Ok(())
    }

    fn set_navigation_generation(&self, page_id: &str, generation: u64) -> BrowserResult<()> {
        let current = generation_for(&self.navigation_generations, page_id);
        if generation > current {
            prepare_managed_navigation(
                &self.navigation_generations,
                &self.managed_navigation_starts,
                page_id,
                generation,
            )
        } else {
            restore_navigation_generation(
                &self.navigation_generations,
                &self.managed_navigation_starts,
                page_id,
                generation,
            )
        }
    }

    fn go_back(&self, page_id: &str) -> BrowserResult<()> {
        let pages = self.pages()?;
        let page = pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.webview.eval("history.back()").map_err(native_error)
    }

    fn go_forward(&self, page_id: &str) -> BrowserResult<()> {
        let pages = self.pages()?;
        let page = pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.webview.eval("history.forward()").map_err(native_error)
    }

    fn reload(&self, page_id: &str) -> BrowserResult<()> {
        let pages = self.pages()?;
        let page = pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.webview.reload().map_err(native_error)
    }

    fn close(&self, page_id: &str) -> BrowserResult<()> {
        let permission_ids = self
            .pending_permissions
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .filter(|(_, value)| value.page_id == page_id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for request_id in permission_ids {
            self.resolve_permission(&request_id, PermissionDecision::Deny)?;
        }
        let certificate_ids = self
            .pending_certificates
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .filter(|(_, value)| value.page_id == page_id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for request_id in certificate_ids {
            self.resolve_certificate(&request_id, CertificateDecision::Deny)?;
        }
        let dialog_ids = self
            .pending_dialogs
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .filter(|(_, value)| value.page_id == page_id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for request_id in dialog_ids {
            self.resolve_dialog(&request_id, false)?;
        }
        let webview = self
            .pages()?
            .get(page_id)
            .map(|page| page.webview.clone())
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        webview.close().map_err(native_error)?;
        self.pages()?
            .remove(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        let generation = self
            .navigation_generations
            .lock()
            .ok()
            .and_then(|mut generations| generations.remove(page_id))
            .unwrap_or_default();
        if let Ok(mut starts) = self.managed_navigation_starts.lock() {
            starts.remove(page_id);
        }
        if let Ok(mut pending) = self.pending_permissions.lock() {
            pending.retain(|_, request| request.page_id != page_id);
        }
        if let Ok(mut pending) = self.pending_certificates.lock() {
            pending.retain(|_, request| request.page_id != page_id);
        }
        if let Ok(mut pending) = self.pending_dialogs.lock() {
            pending.retain(|_, request| request.page_id != page_id);
        }
        self.emit_event(
            page_id,
            generation,
            BrowserLifecycleEventKind::PageClosed,
            None,
            None,
        );
        let _ = self.write_registry();
        Ok(())
    }
    fn set_design_mode(&self, page_id: &str, enabled: bool) -> BrowserResult<()> {
        let pages = self.pages()?;
        let page = pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        let script = if enabled {
            r#"(()=>{if(window.__vibelinkDesignGrab)return;let active=null;const clear=()=>{if(active)active.style.outline=active.dataset.vibelinkOutline||'';active=null};const hover=(event)=>{clear();active=event.target;active.dataset.vibelinkOutline=active.style.outline||'';active.style.outline='3px solid #ff2d55'};const click=(event)=>{event.preventDefault();event.stopImmediatePropagation();const e=event.target;const r=e.getBoundingClientRect();const ancestry=[];for(let n=e;n&&n.nodeType===1;n=n.parentElement)ancestry.unshift(n.tagName.toLowerCase()+(n.id?'#'+n.id:''));const styles=getComputedStyle(e);const selection={browserRef:e.tagName.toLowerCase()+(e.id?'#'+e.id:''),domAncestry:ancestry,accessibleName:e.getAttribute('aria-label')||e.innerText||e.value||'',bounds:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height),scaleFactorMilli:Math.round(devicePixelRatio*1000)},computedStyles:['display','position','color','background-color','font-family','font-size'].map(k=>[k,styles.getPropertyValue(k)]),attributes:Array.from(e.attributes).map(a=>[a.name,a.value]),text:e.innerText||e.value||'',sourceHints:[]};location.href='vibelink-design://grab?payload='+encodeURIComponent(JSON.stringify(selection))};document.addEventListener('mouseover',hover,true);document.addEventListener('click',click,true);window.__vibelinkDesignGrab={hover,click,clear}})()"#
        } else {
            r#"(()=>{const d=window.__vibelinkDesignGrab;if(!d)return;document.removeEventListener('mouseover',d.hover,true);document.removeEventListener('click',d.click,true);d.clear();delete window.__vibelinkDesignGrab})()"#
        };
        page.webview.eval(script).map_err(native_error)
    }

    #[cfg(not(test))]
    fn set_device_metrics(
        &self,
        page_id: &str,
        metrics: BrowserDeviceMetrics,
    ) -> BrowserResult<()> {
        if !metrics.validate() {
            return Err(BrowserError::invalid("invalid browser device metrics"));
        }
        crate::dedicated_cli::browser_cdp::set_device_metrics_for_page(
            &self.registry_path,
            page_id,
            Some(metrics),
        )
        .map_err(|error| BrowserError::new(BrowserErrorCode::RuntimeUnavailable, error.to_string()))
    }

    #[cfg(not(test))]
    fn clear_device_metrics(&self, page_id: &str) -> BrowserResult<()> {
        crate::dedicated_cli::browser_cdp::set_device_metrics_for_page(
            &self.registry_path,
            page_id,
            None,
        )
        .map_err(|error| BrowserError::new(BrowserErrorCode::RuntimeUnavailable, error.to_string()))
    }

    #[cfg(not(test))]
    fn capture_frame(
        &self,
        page_id: &str,
        sequence: u64,
        navigation_generation: u64,
    ) -> BrowserResult<BrowserFrame> {
        let (bytes, width, height) =
            crate::dedicated_cli::browser_cdp::capture_png_for_page(&self.registry_path, page_id)
                .map_err(|error| {
                BrowserError::new(BrowserErrorCode::RuntimeUnavailable, error.to_string())
            })?;
        Ok(BrowserFrame {
            page_id: page_id.to_string(),
            sequence,
            navigation_generation,
            width,
            height,
            format: "png".to_string(),
            bytes,
            captured_at_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or_default(),
        })
    }

    #[cfg(not(test))]
    fn capture_crop(&self, page_id: &str, bounds: PhysicalBounds) -> BrowserResult<Vec<u8>> {
        crate::dedicated_cli::browser_cdp::capture_png_clip_for_page(
            &self.registry_path,
            page_id,
            bounds,
        )
        .map_err(|error| BrowserError::new(BrowserErrorCode::RuntimeUnavailable, error.to_string()))
    }

    fn detect_cookie_import_source(
        &self,
        endpoint: &str,
    ) -> BrowserResult<BrowserCookieImportSource> {
        let detected = detect_loopback_cookie_source(endpoint)?;
        reject_owned_cookie_source_port(self, &detected.endpoint)?;
        Ok(detected)
    }

    fn import_cookies(
        &self,
        input: &BrowserCookieImportInput,
    ) -> BrowserResult<BrowserCookieImportResult> {
        if !input.consent {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "cookie import requires explicit consent",
            ));
        }
        let detected = detect_loopback_cookie_source(&input.endpoint)?;
        let requested = normalize_cookie_origins(&input.origins)?;
        let detected_origins = detected.origins.into_iter().collect::<HashSet<_>>();
        if requested
            .iter()
            .any(|origin| !detected_origins.contains(origin))
        {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "cookie import origin was not present in the explicit source detection result",
            ));
        }
        let destination_port = self.profile_port(&input.profile_id)?;
        reject_owned_cookie_source_port(self, &detected.endpoint)?;
        let mut source = connect_browser_cdp(&input.endpoint)?;
        let source_payload = get_all_cookie_payload(&mut source)?;
        let source_cookies = filter_cookie_payload(&source_payload, &requested)?;
        if source_cookies.len() > 4_096 {
            return Err(BrowserError::invalid(
                "cookie import exceeds the bounded cookie count",
            ));
        }
        let mut destination = connect_page_cdp(destination_port, &input.page_id)?;
        destination
            .command("Network.enable", json!({}))
            .map_err(safe_cdp_error)?;
        let before_payload = get_all_cookie_payload(&mut destination)?;
        let before = filter_cookie_payload(&before_payload, &requested)?;
        let transaction_identities = source_cookies
            .iter()
            .map(CookieMaterial::identity)
            .collect::<HashSet<_>>();
        let before_transaction = before
            .iter()
            .filter(|cookie| transaction_identities.contains(&cookie.identity()))
            .cloned()
            .collect::<Vec<_>>();
        let before_hash = cookie_hash(&before_transaction)?;
        let expected_hash = cookie_hash(&source_cookies)?;
        let set_result = destination.command(
            "Network.setCookies",
            json!({ "cookies": source_cookies.iter().map(CookieMaterial::set_value).collect::<Vec<_>>() }),
        );
        let set_succeeded = matches!(&set_result, Ok(value) if value.get("success").and_then(Value::as_bool).unwrap_or(true));
        if set_succeeded {
            let verified = get_all_cookie_payload(&mut destination)
                .ok()
                .and_then(|payload| filter_cookie_payload(&payload, &requested).ok())
                .map(|cookies| {
                    cookies
                        .into_iter()
                        .filter(|cookie| transaction_identities.contains(&cookie.identity()))
                        .collect::<Vec<_>>()
                })
                .and_then(|cookies| cookie_hash(&cookies).ok())
                .is_some_and(|hash| hash == expected_hash);
            if verified {
                return Ok(BrowserCookieImportResult {
                    imported_count: source_cookies.len(),
                    origin_count: requested.len(),
                    verified: true,
                    rolled_back: false,
                    quarantined: false,
                });
            }
        }
        let rollback_proven = rollback_cookie_transaction(
            &mut destination,
            &transaction_identities,
            &before_transaction,
            &requested,
            before_hash,
        );
        Ok(BrowserCookieImportResult {
            imported_count: 0,
            origin_count: requested.len(),
            verified: false,
            rolled_back: rollback_proven,
            quarantined: !rollback_proven,
        })
    }

    fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> BrowserResult<()> {
        let page_id = {
            let mut pending = self.pending_permissions.lock().map_err(|_| {
                BrowserError::new(BrowserErrorCode::Internal, "permission lock poisoned")
            })?;
            let request = pending.get_mut(request_id).ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorCode::PermissionNotFound,
                    format!("permission request not found: {request_id}"),
                )
            })?;
            match request.status {
                PromptResolutionStatus::Completed => return Ok(()),
                PromptResolutionStatus::InFlight => {
                    return Err(BrowserError::new(
                        BrowserErrorCode::Timeout,
                        "permission resolution is still completing on the browser thread",
                    ));
                }
                PromptResolutionStatus::Queued => request.status = PromptResolutionStatus::InFlight,
            }
            request.page_id.clone()
        };
        let request_key = request_id.to_string();
        let pending_requests = self.pending_permissions.clone();
        let operation_key = request_key.clone();
        let result = self.complete_on_page(&page_id, move || {
            let result = NATIVE_PERMISSION_RESOLVERS.with(|resolutions| {
                let mut resolutions = resolutions.borrow_mut();
                let result = resolutions
                    .get(&operation_key)
                    .ok_or_else(|| BrowserError::not_found(&operation_key))?(
                    decision
                );
                if result.is_ok() {
                    resolutions.remove(&operation_key);
                }
                result
            });
            if let Ok(mut pending) = pending_requests.lock() {
                if let Some(request) = pending.get_mut(&operation_key) {
                    request.status = if result.is_ok() {
                        PromptResolutionStatus::Completed
                    } else {
                        PromptResolutionStatus::Queued
                    };
                }
            }
            result
        });
        if result
            .as_ref()
            .is_err_and(|error| error.code != BrowserErrorCode::Timeout)
        {
            if let Ok(mut pending) = self.pending_permissions.lock() {
                if let Some(request) = pending.get_mut(&request_key) {
                    if request.status == PromptResolutionStatus::InFlight {
                        request.status = PromptResolutionStatus::Queued;
                    }
                }
            }
        }
        result
    }

    fn resolve_certificate(
        &self,
        request_id: &str,
        decision: CertificateDecision,
    ) -> BrowserResult<()> {
        let page_id = {
            let mut pending = self.pending_certificates.lock().map_err(|_| {
                BrowserError::new(BrowserErrorCode::Internal, "certificate lock poisoned")
            })?;
            let request = pending.get_mut(request_id).ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorCode::CertificateNotFound,
                    format!("certificate request not found: {request_id}"),
                )
            })?;
            match request.status {
                PromptResolutionStatus::Completed => return Ok(()),
                PromptResolutionStatus::InFlight => {
                    return Err(BrowserError::new(
                        BrowserErrorCode::Timeout,
                        "certificate resolution is still completing on the browser thread",
                    ));
                }
                PromptResolutionStatus::Queued => request.status = PromptResolutionStatus::InFlight,
            }
            request.page_id.clone()
        };
        let request_key = request_id.to_string();
        let pending_requests = self.pending_certificates.clone();
        let operation_key = request_key.clone();
        let result = self.complete_on_page(&page_id, move || {
            let result = NATIVE_CERTIFICATE_RESOLVERS.with(|resolutions| {
                let mut resolutions = resolutions.borrow_mut();
                let result = resolutions
                    .get(&operation_key)
                    .ok_or_else(|| BrowserError::not_found(&operation_key))?(
                    decision
                );
                if result.is_ok() {
                    resolutions.remove(&operation_key);
                }
                result
            });
            if let Ok(mut pending) = pending_requests.lock() {
                if let Some(request) = pending.get_mut(&operation_key) {
                    request.status = if result.is_ok() {
                        PromptResolutionStatus::Completed
                    } else {
                        PromptResolutionStatus::Queued
                    };
                }
            }
            result
        });
        if result
            .as_ref()
            .is_err_and(|error| error.code != BrowserErrorCode::Timeout)
        {
            if let Ok(mut pending) = self.pending_certificates.lock() {
                if let Some(request) = pending.get_mut(&request_key) {
                    if request.status == PromptResolutionStatus::InFlight {
                        request.status = PromptResolutionStatus::Queued;
                    }
                }
            }
        }
        result
    }

    fn resolve_dialog(&self, request_id: &str, accept: bool) -> BrowserResult<()> {
        let page_id = {
            let mut pending = self.pending_dialogs.lock().map_err(|_| {
                BrowserError::new(BrowserErrorCode::Internal, "dialog lock poisoned")
            })?;
            let request = pending
                .get_mut(request_id)
                .ok_or_else(|| BrowserError::not_found(request_id))?;
            match request.status {
                PromptResolutionStatus::Completed => return Ok(()),
                PromptResolutionStatus::InFlight => {
                    return Err(BrowserError::new(
                        BrowserErrorCode::Timeout,
                        "dialog resolution is still completing on the browser thread",
                    ));
                }
                PromptResolutionStatus::Queued => request.status = PromptResolutionStatus::InFlight,
            }
            request.page_id.clone()
        };
        let request_key = request_id.to_string();
        let pending_requests = self.pending_dialogs.clone();
        let operation_key = request_key.clone();
        let result = self.complete_on_page(&page_id, move || {
            let result = NATIVE_DIALOG_RESOLVERS.with(|resolutions| {
                let mut resolutions = resolutions.borrow_mut();
                let result = resolutions
                    .get(&operation_key)
                    .ok_or_else(|| BrowserError::not_found(&operation_key))?(
                    accept
                );
                if result.is_ok() {
                    resolutions.remove(&operation_key);
                }
                result
            });
            if let Ok(mut pending) = pending_requests.lock() {
                if let Some(request) = pending.get_mut(&operation_key) {
                    request.status = if result.is_ok() {
                        PromptResolutionStatus::Completed
                    } else {
                        PromptResolutionStatus::Queued
                    };
                }
            }
            result
        });
        if result
            .as_ref()
            .is_err_and(|error| error.code != BrowserErrorCode::Timeout)
        {
            if let Ok(mut pending) = self.pending_dialogs.lock() {
                if let Some(request) = pending.get_mut(&request_key) {
                    if request.status == PromptResolutionStatus::InFlight {
                        request.status = PromptResolutionStatus::Queued;
                    }
                }
            }
        }
        result
    }

    fn publish_lifecycle_event(&self, event: &BrowserLifecycleEvent) {
        let _ = self.app.emit("browser-lifecycle", event.clone());
    }

    fn release_profile(&self, profile_id: &str) -> BrowserResult<()> {
        self.release_profile_port(profile_id)
    }

    fn drain_events(&self) -> BrowserResult<Vec<BrowserLifecycleEvent>> {
        let mut events = self.events.lock().map_err(|_| {
            BrowserError::new(BrowserErrorCode::Internal, "browser event lock is poisoned")
        })?;
        Ok(events.drain(..).collect())
    }

    fn requeue_events(&self, events: Vec<BrowserLifecycleEvent>) -> BrowserResult<()> {
        let mut queue = self.events.lock().map_err(|_| {
            BrowserError::new(BrowserErrorCode::Internal, "browser event lock is poisoned")
        })?;
        for event in events.into_iter().rev() {
            queue.push_front(event);
        }
        Ok(())
    }

    fn state(&self, page_id: &str) -> BrowserResult<ChildWebViewState> {
        self.pages()?
            .get(page_id)
            .map(|page| page.state.clone())
            .ok_or_else(|| BrowserError::not_found(page_id))
    }
}

#[cfg(windows)]
fn generation_for(generations: &Mutex<HashMap<String, u64>>, page_id: &str) -> u64 {
    generations
        .lock()
        .ok()
        .and_then(|values| values.get(page_id).copied())
        .unwrap_or_default()
}

#[cfg(windows)]
fn begin_native_navigation(
    generations: &Mutex<HashMap<String, u64>>,
    managed_starts: &Mutex<HashMap<String, u64>>,
    page_id: &str,
) -> (u64, bool) {
    let Ok(mut starts) = managed_starts.lock() else {
        return (0, false);
    };
    let Ok(mut values) = generations.lock() else {
        return (0, false);
    };
    if let Some(target_generation) = starts.get(page_id).copied() {
        let current = values.entry(page_id.to_string()).or_default();
        if *current < target_generation {
            *current = target_generation;
        }
        return (*current, false);
    }
    let generation = match values.get_mut(page_id) {
        Some(generation) => {
            *generation = generation.saturating_add(1);
            *generation
        }
        None => {
            values.insert(page_id.to_string(), 0);
            0
        }
    };
    starts.insert(page_id.to_string(), generation);
    (generation, true)
}

#[cfg(windows)]
fn prepare_managed_navigation(
    _generations: &Mutex<HashMap<String, u64>>,
    managed_starts: &Mutex<HashMap<String, u64>>,
    page_id: &str,
    generation: u64,
) -> BrowserResult<()> {
    let mut starts = managed_starts.lock().map_err(|_| {
        BrowserError::new(
            BrowserErrorCode::Internal,
            "browser navigation start lock is poisoned",
        )
    })?;
    if starts.contains_key(page_id) {
        return Err(BrowserError::new(
            BrowserErrorCode::Conflict,
            "browser navigation is already in progress",
        ));
    }
    starts.insert(page_id.to_string(), generation);
    Ok(())
}

#[cfg(windows)]
fn restore_navigation_generation(
    generations: &Mutex<HashMap<String, u64>>,
    managed_starts: &Mutex<HashMap<String, u64>>,
    page_id: &str,
    generation: u64,
) -> BrowserResult<()> {
    let mut starts = managed_starts.lock().map_err(|_| {
        BrowserError::new(
            BrowserErrorCode::Internal,
            "browser navigation start lock is poisoned",
        )
    })?;
    let mut values = generations.lock().map_err(|_| {
        BrowserError::new(
            BrowserErrorCode::Internal,
            "browser generation lock is poisoned",
        )
    })?;
    values.insert(page_id.to_string(), generation);
    starts.remove(page_id);
    Ok(())
}

#[cfg(windows)]
fn emit_native_event(
    schedule_event_pump: &EventPumpScheduler,
    events: &Mutex<VecDeque<BrowserLifecycleEvent>>,
    sequence: &AtomicU64,
    page_id: &str,
    navigation_generation: u64,
    kind: BrowserLifecycleEventKind,
    url: Option<String>,
    detail: Option<String>,
) {
    let event = BrowserLifecycleEvent {
        sequence: sequence.fetch_add(1, Ordering::SeqCst).saturating_add(1),
        page_id: page_id.to_string(),
        navigation_generation,
        kind,
        url,
        detail,
        timestamp_ms: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as u64)
            .unwrap_or_default(),
    };
    if let Ok(mut queue) = events.lock() {
        queue.push_back(event);
    }
    schedule_event_pump();
}
#[cfg(windows)]
fn attach_native_prompt_handlers(
    platform: tauri::webview::PlatformWebview,
    event_pump_scheduler: EventPumpScheduler,
    events: Arc<Mutex<VecDeque<BrowserLifecycleEvent>>>,
    sequence: Arc<AtomicU64>,
    generations: Arc<Mutex<HashMap<String, u64>>>,
    page_id: String,
    pending_permissions: Arc<Mutex<HashMap<String, PendingPrompt>>>,
    pending_certificates: Arc<Mutex<HashMap<String, PendingPrompt>>>,
    pending_dialogs: Arc<Mutex<HashMap<String, PendingPrompt>>>,
) -> windows::core::Result<()> {
    let core = unsafe { platform.controller().CoreWebView2()? };

    let permission_event_pump = event_pump_scheduler.clone();
    let permission_events = events.clone();
    let permission_sequence = sequence.clone();
    let permission_generations = generations.clone();
    let permission_page_id = page_id.clone();
    let permission_pending = pending_permissions.clone();
    let mut permission_token = 0;
    unsafe {
        core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let deferral = args.GetDeferral()?;
                let mut raw_uri = PWSTR::null();
                args.Uri(&mut raw_uri)?;
                let origin = security_origin(&take_pwstr(raw_uri));
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_FILE_READ_WRITE {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    deferral.Complete()?;
                    return Ok(());
                }

                let request_id = uuid::Uuid::new_v4().to_string();
                let permission = permission_kind_name(kind).to_string();
                if let Ok(mut resolutions) = permission_pending.lock() {
                    resolutions.insert(
                        request_id.clone(),
                        PendingPrompt {
                            page_id: permission_page_id.clone(),
                            status: PromptResolutionStatus::Queued,
                        },
                    );
                } else {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_DENY)?;
                    deferral.Complete()?;
                    return Ok(());
                }
                let resolution_args = args.clone();
                let resolver: PermissionResolver = Box::new(move |decision| {
                    if let Ok(args3) =
                        resolution_args.cast::<ICoreWebView2PermissionRequestedEventArgs3>()
                    {
                        args3
                            .SetSavesInProfile(matches!(
                                decision,
                                PermissionDecision::AllowForOrigin
                            ))
                            .map_err(com_error)?;
                    }
                    resolution_args
                        .SetState(if matches!(decision, PermissionDecision::Deny) {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        })
                        .map_err(com_error)?;
                    deferral.Complete().map_err(com_error)?;
                    Ok(())
                });
                NATIVE_PERMISSION_RESOLVERS.with(|resolutions| {
                    resolutions
                        .borrow_mut()
                        .insert(request_id.clone(), resolver);
                });
                emit_native_event(
                    &permission_event_pump,
                    &permission_events,
                    &permission_sequence,
                    &permission_page_id,
                    generation_for(&permission_generations, &permission_page_id),
                    BrowserLifecycleEventKind::PermissionRequested,
                    Some(origin),
                    Some(
                        serde_json::json!({
                            "requestId": request_id,
                            "permission": permission,
                        })
                        .to_string(),
                    ),
                );
                Ok(())
            })),
            &mut permission_token,
        )?;
    }

    let dialog_event_pump = event_pump_scheduler.clone();
    let dialog_events = events.clone();
    let dialog_sequence = sequence.clone();
    let dialog_generations = generations.clone();
    let dialog_page_id = page_id.clone();
    let dialog_pending = pending_dialogs.clone();
    let mut dialog_token = 0;
    unsafe {
        core.add_ScriptDialogOpening(
            &ScriptDialogOpeningEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let deferral = args.GetDeferral()?;
                let mut raw_uri = PWSTR::null();
                args.Uri(&mut raw_uri)?;
                let origin = security_origin(&take_pwstr(raw_uri));
                let mut raw_message = PWSTR::null();
                args.Message(&mut raw_message)?;
                let message = take_pwstr(raw_message);
                let mut raw_default = PWSTR::null();
                args.DefaultText(&mut raw_default)?;
                let default_text = take_pwstr(raw_default);
                let mut raw_kind = COREWEBVIEW2_SCRIPT_DIALOG_KIND::default();
                args.Kind(&mut raw_kind)?;
                let kind = browser_dialog_kind(raw_kind);
                let request_id = uuid::Uuid::new_v4().to_string();
                if let Ok(mut resolutions) = dialog_pending.lock() {
                    resolutions.insert(
                        request_id.clone(),
                        PendingPrompt {
                            page_id: dialog_page_id.clone(),
                            status: PromptResolutionStatus::Queued,
                        },
                    );
                } else {
                    deferral.Complete()?;
                    return Ok(());
                }
                let resolution_args = args.clone();
                let resolver: DialogResolver = Box::new(move |accept| {
                    if accept {
                        resolution_args.Accept().map_err(com_error)?;
                    }
                    deferral.Complete().map_err(com_error)?;
                    Ok(())
                });
                NATIVE_DIALOG_RESOLVERS.with(|resolutions| {
                    resolutions
                        .borrow_mut()
                        .insert(request_id.clone(), resolver);
                });
                emit_native_event(
                    &dialog_event_pump,
                    &dialog_events,
                    &dialog_sequence,
                    &dialog_page_id,
                    generation_for(&dialog_generations, &dialog_page_id),
                    BrowserLifecycleEventKind::DialogRequested,
                    Some(origin),
                    Some(
                        serde_json::json!({
                            "requestId": request_id,
                            "kind": kind,
                            "message": message,
                            "defaultText": (!default_text.is_empty()).then_some(default_text),
                        })
                        .to_string(),
                    ),
                );
                Ok(())
            })),
            &mut dialog_token,
        )?;
    }

    let certificate_event_pump = event_pump_scheduler;
    let certificate_events = events;
    let certificate_sequence = sequence;
    let certificate_generations = generations;
    let certificate_page_id = page_id;
    let certificate_pending = pending_certificates;
    let core14 = core.cast::<ICoreWebView2_14>()?;
    let mut certificate_token = 0;
    unsafe {
        core14.add_ServerCertificateErrorDetected(
            &ServerCertificateErrorDetectedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let deferral = args.GetDeferral()?;
                let mut raw_uri = PWSTR::null();
                args.RequestUri(&mut raw_uri)?;
                let origin = security_origin(&take_pwstr(raw_uri));
                let mut status = Default::default();
                args.ErrorStatus(&mut status)?;
                let error_code = format!("{status:?}");
                let request_id = uuid::Uuid::new_v4().to_string();
                if let Ok(mut resolutions) = certificate_pending.lock() {
                    resolutions.insert(
                        request_id.clone(),
                        PendingPrompt {
                            page_id: certificate_page_id.clone(),
                            status: PromptResolutionStatus::Queued,
                        },
                    );
                } else {
                    args.SetAction(COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL)?;
                    deferral.Complete()?;
                    return Ok(());
                }
                let resolution_args = args.clone();
                let resolver: CertificateResolver = Box::new(move |decision| {
                    resolution_args
                        .SetAction(if matches!(decision, CertificateDecision::AllowForOrigin) {
                            COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_ALWAYS_ALLOW
                        } else {
                            COREWEBVIEW2_SERVER_CERTIFICATE_ERROR_ACTION_CANCEL
                        })
                        .map_err(com_error)?;
                    deferral.Complete().map_err(com_error)?;
                    Ok(())
                });
                NATIVE_CERTIFICATE_RESOLVERS.with(|resolutions| {
                    resolutions
                        .borrow_mut()
                        .insert(request_id.clone(), resolver);
                });
                emit_native_event(
                    &certificate_event_pump,
                    &certificate_events,
                    &certificate_sequence,
                    &certificate_page_id,
                    generation_for(&certificate_generations, &certificate_page_id),
                    BrowserLifecycleEventKind::CertificateError,
                    Some(origin),
                    Some(
                        serde_json::json!({
                            "requestId": request_id,
                            "errorCode": error_code,
                        })
                        .to_string(),
                    ),
                );
                Ok(())
            })),
            &mut certificate_token,
        )?;
    }
    Ok(())
}

#[cfg(windows)]
fn permission_kind_name(kind: COREWEBVIEW2_PERMISSION_KIND) -> &'static str {
    match kind.0 {
        1 => "microphone",
        2 => "camera",
        3 => "geolocation",
        4 => "notifications",
        5 => "sensors",
        6 => "clipboard_read",
        7 => "multiple_downloads",
        8 => "file_read_write",
        9 => "autoplay",
        10 => "local_fonts",
        11 => "midi_system_exclusive",
        12 => "window_management",
        _ => "unknown",
    }
}

#[cfg(windows)]
fn browser_dialog_kind(kind: COREWEBVIEW2_SCRIPT_DIALOG_KIND) -> BrowserDialogKind {
    match kind {
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_CONFIRM => BrowserDialogKind::Confirm,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_PROMPT => BrowserDialogKind::Prompt,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_BEFOREUNLOAD => BrowserDialogKind::BeforeUnload,
        COREWEBVIEW2_SCRIPT_DIALOG_KIND_ALERT | _ => BrowserDialogKind::Alert,
    }
}

#[cfg(windows)]
fn security_origin(uri: &str) -> String {
    url::Url::parse(uri)
        .ok()
        .map(|value| value.origin().ascii_serialization())
        .filter(|value| value != "null")
        .unwrap_or_else(|| uri.to_string())
}

#[cfg(windows)]
fn reserve_native_download(root: &std::path::Path, suggested: &str) -> BrowserResult<PathBuf> {
    let name = suggested.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
        || name.chars().any(char::is_control)
    {
        return Err(BrowserError::new(
            BrowserErrorCode::DownloadDenied,
            "unsafe native download file name",
        ));
    }
    fs::create_dir_all(root).map_err(registry_error)?;
    let canonical_root = fs::canonicalize(root).map_err(registry_error)?;
    let (stem, extension) = match name.rsplit_once('.') {
        Some((stem, extension)) if !stem.is_empty() && !extension.is_empty() => {
            (stem.to_string(), Some(extension.to_string()))
        }
        _ => (name.to_string(), None),
    };
    for suffix in 0..10_000u32 {
        let candidate_name = match (&extension, suffix) {
            (_, 0) => name.to_string(),
            (Some(extension), value) => format!("{stem} ({value}).{extension}"),
            (None, value) => format!("{stem} ({value})"),
        };
        let candidate = canonical_root.join(candidate_name);
        if !candidate.starts_with(&canonical_root) {
            return Err(BrowserError::new(
                BrowserErrorCode::DownloadDenied,
                "native download escaped its canonical root",
            ));
        }
        match fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&candidate)
        {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => {
                return Err(BrowserError::new(
                    BrowserErrorCode::DownloadDenied,
                    format!("reserve native download: {error}"),
                ))
            }
        }
    }
    Err(BrowserError::new(
        BrowserErrorCode::Conflict,
        "could not reserve a unique native download path",
    ))
}

#[cfg(windows)]
const MAX_CDP_METADATA_BYTES: u64 = 4 * 1024 * 1024;

#[cfg(windows)]
struct LoopbackCdp {
    socket: WebSocket<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

#[cfg(windows)]
enum CdpCommandError {
    Protocol,
    Transport,
}

#[cfg(windows)]
impl LoopbackCdp {
    fn connect(websocket_url: &str, expected_port: u16) -> BrowserResult<Self> {
        let parsed = url::Url::parse(websocket_url).map_err(|_| {
            BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "invalid loopback CDP websocket",
            )
        })?;
        if parsed.scheme() != "ws"
            || !is_loopback_websocket_host(&parsed)
            || parsed.port_or_known_default() != Some(expected_port)
            || !parsed.username().is_empty()
            || parsed.password().is_some()
        {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "CDP websocket must remain on the detected loopback endpoint",
            ));
        }
        let (mut socket, _) = connect(parsed.as_str()).map_err(|_| {
            BrowserError::new(
                BrowserErrorCode::RuntimeUnavailable,
                "loopback CDP websocket is unavailable",
            )
        })?;
        let MaybeTlsStream::Plain(stream) = socket.get_mut() else {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "CDP websocket must use a plain local loopback transport",
            ));
        };
        if !stream
            .peer_addr()
            .map(|address| address.ip().is_loopback())
            .unwrap_or(false)
        {
            return Err(BrowserError::new(
                BrowserErrorCode::DeniedCapability,
                "CDP websocket resolved outside the local loopback interface",
            ));
        }
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .and_then(|_| stream.set_write_timeout(Some(Duration::from_secs(5))))
            .map_err(|_| {
                BrowserError::new(
                    BrowserErrorCode::RuntimeUnavailable,
                    "loopback CDP websocket timeout configuration failed",
                )
            })?;
        Ok(Self { socket, next_id: 0 })
    }

    fn command(&mut self, method: &str, params: Value) -> Result<Value, CdpCommandError> {
        self.next_id = self.next_id.saturating_add(1);
        let id = self.next_id;
        let message =
            serde_json::to_string(&json!({ "id": id, "method": method, "params": params }))
                .map_err(|_| CdpCommandError::Transport)?;
        self.socket
            .send(Message::Text(message.into()))
            .map_err(|_| CdpCommandError::Transport)?;
        loop {
            let message = self.socket.read().map_err(|_| CdpCommandError::Transport)?;
            let Message::Text(text) = message else {
                continue;
            };
            if text.len() as u64 > MAX_CDP_METADATA_BYTES {
                return Err(CdpCommandError::Transport);
            }
            let value: Value =
                serde_json::from_str(text.as_str()).map_err(|_| CdpCommandError::Transport)?;
            if value.get("id").and_then(Value::as_u64) != Some(id) {
                continue;
            }
            if value.get("error").is_some() {
                return Err(CdpCommandError::Protocol);
            }
            return value
                .get("result")
                .cloned()
                .ok_or(CdpCommandError::Protocol);
        }
    }
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpMetadata {
    #[serde(default, rename = "Browser")]
    browser: String,
    #[serde(default)]
    web_socket_debugger_url: String,
}

#[cfg(windows)]
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CdpTargetMetadata {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    url: String,
    #[serde(default)]
    web_socket_debugger_url: String,
}

#[cfg(windows)]
#[derive(Clone, PartialEq, Eq, Hash)]
struct CookieIdentity {
    name: String,
    domain: String,
    path: String,
}

#[cfg(windows)]
#[derive(Clone)]
struct CookieMaterial {
    name: String,
    value: String,
    domain: String,
    path: String,
    secure: bool,
    http_only: bool,
    same_site: Option<String>,
    expires: Option<f64>,
    priority: Option<String>,
    same_party: Option<bool>,
    source_scheme: Option<String>,
    source_port: Option<i64>,
}

#[cfg(windows)]
impl CookieMaterial {
    fn from_value(value: &Value) -> BrowserResult<Self> {
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(cookie_payload_error)?;
        let cookie_value = value
            .get("value")
            .and_then(Value::as_str)
            .ok_or_else(cookie_payload_error)?;
        let domain = value
            .get("domain")
            .and_then(Value::as_str)
            .ok_or_else(cookie_payload_error)?;
        let path = value.get("path").and_then(Value::as_str).unwrap_or("/");
        if name.len() > 4_096
            || cookie_value.len() > 64 * 1024
            || domain.len() > 4_096
            || path.len() > 16 * 1024
        {
            return Err(BrowserError::invalid(
                "cookie import contains an oversized field",
            ));
        }
        Ok(Self {
            name: name.to_string(),
            value: cookie_value.to_string(),
            domain: domain.to_ascii_lowercase(),
            path: path.to_string(),
            secure: value
                .get("secure")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            http_only: value
                .get("httpOnly")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            same_site: value
                .get("sameSite")
                .and_then(Value::as_str)
                .map(str::to_string),
            expires: value
                .get("expires")
                .and_then(Value::as_f64)
                .filter(|value| value.is_finite() && *value > 0.0),
            priority: value
                .get("priority")
                .and_then(Value::as_str)
                .map(str::to_string),
            same_party: value.get("sameParty").and_then(Value::as_bool),
            source_scheme: value
                .get("sourceScheme")
                .and_then(Value::as_str)
                .map(str::to_string),
            source_port: value.get("sourcePort").and_then(Value::as_i64),
        })
    }

    fn identity(&self) -> CookieIdentity {
        CookieIdentity {
            name: self.name.clone(),
            domain: self.domain.clone(),
            path: self.path.clone(),
        }
    }

    fn matches_origin(&self, origins: &[String]) -> bool {
        let domain = self.domain.trim_start_matches('.');
        origins.iter().any(|origin| {
            let Ok(url) = url::Url::parse(origin) else {
                return false;
            };
            if self.secure && url.scheme() != "https" {
                return false;
            }
            url.host_str()
                .map(str::to_ascii_lowercase)
                .is_some_and(|host| host == domain || host.ends_with(&format!(".{domain}")))
        })
    }

    fn set_value(&self) -> Value {
        let mut value = serde_json::Map::new();
        value.insert("name".to_string(), Value::String(self.name.clone()));
        value.insert("value".to_string(), Value::String(self.value.clone()));
        value.insert("domain".to_string(), Value::String(self.domain.clone()));
        value.insert("path".to_string(), Value::String(self.path.clone()));
        value.insert("secure".to_string(), Value::Bool(self.secure));
        value.insert("httpOnly".to_string(), Value::Bool(self.http_only));
        if let Some(same_site) = &self.same_site {
            value.insert("sameSite".to_string(), Value::String(same_site.clone()));
        }
        if let Some(expires) = self.expires {
            if let Some(number) = serde_json::Number::from_f64(expires) {
                value.insert("expires".to_string(), Value::Number(number));
            }
        }
        if let Some(priority) = &self.priority {
            value.insert("priority".to_string(), Value::String(priority.clone()));
        }
        if let Some(same_party) = self.same_party {
            value.insert("sameParty".to_string(), Value::Bool(same_party));
        }
        if let Some(source_scheme) = &self.source_scheme {
            value.insert(
                "sourceScheme".to_string(),
                Value::String(source_scheme.clone()),
            );
        }
        if let Some(source_port) = self.source_port {
            value.insert("sourcePort".to_string(), Value::Number(source_port.into()));
        }
        Value::Object(value)
    }

    fn hash_value(&self) -> Value {
        json!({
            "name": self.name.clone(),
            "value": self.value.clone(),
            "domain": self.domain.clone(),
            "path": self.path.clone(),
            "secure": self.secure,
            "httpOnly": self.http_only,
            "sameSite": self.same_site.clone(),
            "expires": self.expires,
            "priority": self.priority.clone(),
            "sameParty": self.same_party,
            "sourceScheme": self.source_scheme.clone(),
            "sourcePort": self.source_port,
        })
    }
}

#[cfg(windows)]
fn detect_loopback_cookie_source(endpoint: &str) -> BrowserResult<BrowserCookieImportSource> {
    let endpoint = normalize_loopback_endpoint(endpoint)?;
    let version: CdpMetadata = read_loopback_json(&format!("{endpoint}/json/version"))?;
    let targets: Vec<CdpTargetMetadata> = read_loopback_json(&format!("{endpoint}/json"))?;
    if targets.len() > 512 {
        return Err(BrowserError::invalid(
            "loopback CDP exposed too many targets",
        ));
    }
    let mut origins = BTreeSet::new();
    for target in targets {
        if let Ok(url) = url::Url::parse(&target.url) {
            if matches!(url.scheme(), "http" | "https") {
                origins.insert(url.origin().ascii_serialization());
            }
        }
    }
    let label = version.browser.to_ascii_lowercase();
    let browser = if label.contains("edge") {
        "edge"
    } else if label.contains("chrome") {
        "chrome"
    } else if label.contains("chromium") {
        "chromium"
    } else {
        "unknown"
    };
    if browser == "unknown" {
        return Err(BrowserError::new(
            BrowserErrorCode::DeniedCapability,
            "cookie import source is not a detected Chrome, Edge, or Chromium CDP browser",
        ));
    }
    if origins.len() > 256 {
        return Err(BrowserError::invalid(
            "loopback CDP exposed too many distinct origins",
        ));
    }
    Ok(BrowserCookieImportSource {
        endpoint,
        browser: browser.to_string(),
        origins: origins.into_iter().collect(),
    })
}

#[cfg(windows)]
fn reject_owned_cookie_source_port(
    provider: &NativeBrowserProvider,
    endpoint: &str,
) -> BrowserResult<()> {
    let source_port = url::Url::parse(endpoint)
        .ok()
        .and_then(|url| url.port())
        .ok_or_else(|| BrowserError::invalid("cookie import source requires an explicit port"))?;
    let owned_ports = provider.profile_ports.lock().map_err(|_| {
        BrowserError::new(
            BrowserErrorCode::Internal,
            "native browser profile lock is poisoned",
        )
    })?;
    if source_port == provider.main_cdp_port
        || owned_ports.values().any(|port| *port == source_port)
    {
        return Err(BrowserError::new(
            BrowserErrorCode::DeniedCapability,
            "cookie import source must be an external local Chrome CDP browser",
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn connect_browser_cdp(endpoint: &str) -> BrowserResult<LoopbackCdp> {
    let endpoint = normalize_loopback_endpoint(endpoint)?;
    let parsed = url::Url::parse(&endpoint)
        .map_err(|_| BrowserError::invalid("invalid loopback CDP endpoint"))?;
    let port = parsed
        .port_or_known_default()
        .ok_or_else(|| BrowserError::invalid("loopback CDP endpoint requires an explicit port"))?;
    let version: CdpMetadata = read_loopback_json(&format!("{endpoint}/json/version"))?;
    if version.web_socket_debugger_url.is_empty() {
        return Err(BrowserError::new(
            BrowserErrorCode::RuntimeUnavailable,
            "loopback CDP browser websocket is unavailable",
        ));
    }
    LoopbackCdp::connect(&version.web_socket_debugger_url, port)
}

#[cfg(windows)]
fn connect_page_cdp(port: u16, page_id: &str) -> BrowserResult<LoopbackCdp> {
    let targets: Vec<CdpTargetMetadata> =
        read_loopback_json(&format!("http://127.0.0.1:{port}/json"))?;
    if targets.len() > 512 {
        return Err(BrowserError::invalid(
            "destination CDP exposed too many targets",
        ));
    }
    let expected_name = format!("vibelink-page:{page_id}");
    for target in targets
        .into_iter()
        .filter(|target| target.kind.is_empty() || target.kind == "page")
    {
        if target.web_socket_debugger_url.is_empty() {
            continue;
        }
        let Ok(mut connection) = LoopbackCdp::connect(&target.web_socket_debugger_url, port) else {
            continue;
        };
        let Ok(result) = connection.command(
            "Runtime.evaluate",
            json!({ "expression": "window.name", "returnByValue": true }),
        ) else {
            continue;
        };
        let name = result
            .get("result")
            .and_then(|value| value.get("value"))
            .and_then(Value::as_str);
        if name == Some(expected_name.as_str()) {
            return Ok(connection);
        }
    }
    Err(BrowserError::new(
        BrowserErrorCode::RuntimeUnavailable,
        "destination browser page CDP target is unavailable",
    ))
}

#[cfg(windows)]
fn normalize_loopback_endpoint(endpoint: &str) -> BrowserResult<String> {
    let parsed = url::Url::parse(endpoint.trim())
        .map_err(|_| BrowserError::invalid("invalid loopback CDP endpoint"))?;
    if parsed.scheme() != "http"
        || !is_loopback_host(&parsed)
        || parsed.port().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || !matches!(parsed.path(), "" | "/")
    {
        return Err(BrowserError::new(
            BrowserErrorCode::DeniedCapability,
            "cookie import requires an explicit local loopback HTTP CDP endpoint",
        ));
    }
    Ok(parsed.origin().ascii_serialization())
}

#[cfg(windows)]
fn is_loopback_host(url: &url::Url) -> bool {
    match url.host() {
        Some(url::Host::Ipv4(address)) => address.is_loopback(),
        Some(url::Host::Ipv6(address)) => address.is_loopback(),
        _ => false,
    }
}

#[cfg(windows)]
fn is_loopback_websocket_host(url: &url::Url) -> bool {
    is_loopback_host(url)
        || matches!(url.host(), Some(url::Host::Domain(host)) if host.eq_ignore_ascii_case("localhost"))
}

#[cfg(windows)]
fn read_loopback_json<T: for<'de> Deserialize<'de>>(url: &str) -> BrowserResult<T> {
    let agent = ureq::AgentBuilder::new().redirects(0).build();
    let response = agent
        .get(url)
        .timeout(Duration::from_secs(3))
        .call()
        .map_err(|_| {
            BrowserError::new(
                BrowserErrorCode::RuntimeUnavailable,
                "loopback CDP metadata is unavailable",
            )
        })?;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(MAX_CDP_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| {
            BrowserError::new(
                BrowserErrorCode::RuntimeUnavailable,
                "loopback CDP metadata could not be read",
            )
        })?;
    if bytes.len() as u64 > MAX_CDP_METADATA_BYTES {
        return Err(BrowserError::invalid(
            "loopback CDP metadata exceeds the bounded size",
        ));
    }
    serde_json::from_slice(&bytes).map_err(|_| {
        BrowserError::new(
            BrowserErrorCode::RuntimeUnavailable,
            "loopback CDP metadata is invalid",
        )
    })
}

#[cfg(windows)]
fn normalize_cookie_origins(origins: &[String]) -> BrowserResult<Vec<String>> {
    if origins.is_empty() || origins.len() > 64 {
        return Err(BrowserError::invalid(
            "cookie import requires a bounded origin allowlist",
        ));
    }
    let mut normalized = BTreeSet::new();
    for origin in origins {
        let parsed = url::Url::parse(origin)
            .map_err(|_| BrowserError::invalid("invalid cookie import origin"))?;
        if !matches!(parsed.scheme(), "http" | "https")
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || !matches!(parsed.path(), "" | "/")
            || parsed.query().is_some()
            || parsed.fragment().is_some()
        {
            return Err(BrowserError::invalid(
                "cookie import entries must be exact HTTP(S) origins",
            ));
        }
        normalized.insert(parsed.origin().ascii_serialization());
    }
    Ok(normalized.into_iter().collect())
}

#[cfg(windows)]
fn filter_cookie_payload(
    payload: &Value,
    origins: &[String],
) -> BrowserResult<Vec<CookieMaterial>> {
    let values = payload
        .get("cookies")
        .and_then(Value::as_array)
        .ok_or_else(cookie_payload_error)?;
    let mut cookies = Vec::new();
    for value in values {
        let cookie = CookieMaterial::from_value(value)?;
        if !cookie.matches_origin(origins) {
            continue;
        }
        if value.get("partitionKey").is_some_and(|key| !key.is_null())
            || value
                .get("partitionKeyOpaque")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            || value
                .get("partitioned")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            return Err(BrowserError::new(
                BrowserErrorCode::Unsupported,
                "partitioned cookies cannot be imported without preserving partition identity",
            ));
        }
        cookies.push(cookie);
    }
    Ok(cookies)
}

#[cfg(windows)]
fn get_all_cookie_payload(connection: &mut LoopbackCdp) -> BrowserResult<Value> {
    match connection.command("Storage.getCookies", json!({})) {
        Ok(value) => Ok(value),
        Err(CdpCommandError::Protocol) => connection
            .command("Network.getAllCookies", json!({}))
            .map_err(safe_cdp_error),
        Err(error) => Err(safe_cdp_error(error)),
    }
}

#[cfg(windows)]
fn cookie_hash(cookies: &[CookieMaterial]) -> BrowserResult<[u8; 32]> {
    let mut entries = cookies
        .iter()
        .map(|cookie| serde_json::to_vec(&cookie.hash_value()).map_err(|_| cookie_payload_error()))
        .collect::<BrowserResult<Vec<_>>>()?;
    entries.sort();
    let mut hasher = Sha256::new();
    for entry in entries {
        hasher.update((entry.len() as u64).to_be_bytes());
        hasher.update(entry);
    }
    Ok(hasher.finalize().into())
}

#[cfg(windows)]
fn rollback_cookie_transaction(
    destination: &mut LoopbackCdp,
    identities: &HashSet<CookieIdentity>,
    before: &[CookieMaterial],
    origins: &[String],
    before_hash: [u8; 32],
) -> bool {
    for identity in identities {
        if destination
            .command(
                "Network.deleteCookies",
                json!({
                    "name": identity.name.clone(),
                    "domain": identity.domain.clone(),
                    "path": identity.path.clone(),
                }),
            )
            .is_err()
        {
            return false;
        }
    }
    if !before.is_empty() {
        let restored = destination.command(
            "Network.setCookies",
            json!({ "cookies": before.iter().map(CookieMaterial::set_value).collect::<Vec<_>>() }),
        );
        if !matches!(restored, Ok(value) if value.get("success").and_then(Value::as_bool).unwrap_or(true))
        {
            return false;
        }
    }
    let Ok(payload) = get_all_cookie_payload(destination) else {
        return false;
    };
    let Ok(cookies) = filter_cookie_payload(&payload, origins) else {
        return false;
    };
    let transaction = cookies
        .into_iter()
        .filter(|cookie| identities.contains(&cookie.identity()))
        .collect::<Vec<_>>();
    cookie_hash(&transaction).is_ok_and(|hash| hash == before_hash)
}

#[cfg(windows)]
fn safe_cdp_error(error: CdpCommandError) -> BrowserError {
    match error {
        CdpCommandError::Protocol => BrowserError::new(
            BrowserErrorCode::Unsupported,
            "required cookie-only CDP command is unavailable",
        ),
        CdpCommandError::Transport => BrowserError::new(
            BrowserErrorCode::RuntimeUnavailable,
            "loopback CDP command failed",
        ),
    }
}

#[cfg(windows)]
fn cookie_payload_error() -> BrowserError {
    BrowserError::new(
        BrowserErrorCode::RuntimeUnavailable,
        "CDP returned an invalid cookie payload",
    )
}

#[cfg(windows)]
fn registry_error(error: impl std::fmt::Display) -> BrowserError {
    BrowserError::new(
        BrowserErrorCode::Internal,
        format!("browser CDP registry: {error}"),
    )
}

#[cfg(windows)]
fn native_error(error: tauri::Error) -> BrowserError {
    BrowserError::new(BrowserErrorCode::Internal, error.to_string())
}

#[cfg(windows)]
fn com_error(error: windows::core::Error) -> BrowserError {
    BrowserError::new(BrowserErrorCode::Internal, error.to_string())
}

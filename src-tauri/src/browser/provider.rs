use super::{
    error::{BrowserError, BrowserErrorCode, BrowserResult},
    types::{
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
    fn navigate(&self, page_id: &str, url: &str, navigation_generation: u64) -> BrowserResult<()>;
    fn set_navigation_generation(&self, _page_id: &str, _generation: u64) -> BrowserResult<()> {
        Ok(())
    }
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
use serde::Serialize;
#[cfg(windows)]
use std::{
    cell::RefCell,
    collections::{HashMap, VecDeque},
    fs,
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
type PermissionResolver = Box<dyn FnOnce(PermissionDecision) -> BrowserResult<()> + 'static>;
#[cfg(windows)]
type CertificateResolver = Box<dyn FnOnce(CertificateDecision) -> BrowserResult<()> + 'static>;
#[cfg(windows)]
type DialogResolver = Box<dyn FnOnce(bool) -> BrowserResult<()> + 'static>;

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
pub struct NativeBrowserProvider {
    app: AppHandle<Wry>,
    parent_window_label: String,
    pages: Mutex<HashMap<String, NativePage>>,
    profile_ports: Mutex<HashMap<String, u16>>,
    navigation_generations: Arc<Mutex<HashMap<String, u64>>>,
    events: Arc<Mutex<VecDeque<BrowserLifecycleEvent>>>,
    event_sequence: Arc<AtomicU64>,
    pending_permissions: Arc<Mutex<HashMap<String, String>>>,
    pending_certificates: Arc<Mutex<HashMap<String, String>>>,
    pending_dialogs: Arc<Mutex<HashMap<String, String>>>,
    registry_path: PathBuf,
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
            events: Arc::new(Mutex::new(VecDeque::new())),
            event_sequence: Arc::new(AtomicU64::new(0)),
            pending_permissions: Arc::new(Mutex::new(HashMap::new())),
            pending_certificates: Arc::new(Mutex::new(HashMap::new())),
            pending_dialogs: Arc::new(Mutex::new(HashMap::new())),
            registry_path,
            download_root,
            main_cdp_port,
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
            &self.app,
            &self.events,
            &self.event_sequence,
            page_id,
            navigation_generation,
            kind,
            url,
            detail,
        );
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
        let popup_app = self.app.clone();
        let popup_events = self.events.clone();
        let popup_sequence = self.event_sequence.clone();
        let popup_page_id = request.page_id.clone();
        let popup_generations = self.navigation_generations.clone();
        let load_app = self.app.clone();
        let load_events = self.events.clone();
        let load_sequence = self.event_sequence.clone();
        let load_page_id = request.page_id.clone();
        let load_generations = self.navigation_generations.clone();
        let title_app = self.app.clone();
        let title_events = self.events.clone();
        let title_sequence = self.event_sequence.clone();
        let title_page_id = request.page_id.clone();
        let title_generations = self.navigation_generations.clone();
        let download_app = self.app.clone();
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
                                serde_json::json!({ "pageId": design_page_id, "selection": selection }),
                            );
                        }
                    }
                    return false;
                }
                matches!(url.scheme(), "http" | "https" | "about")
            })
            .on_new_window(move |url, _features| {
                let generation = generation_for(&popup_generations, &popup_page_id);
                emit_native_event(
                    &popup_app,
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
                let (kind, detail) = if url.starts_with("edge-error://") {
                    (
                        BrowserLifecycleEventKind::NavigationFailed,
                        Some("WebView2 loaded an error document".to_string()),
                    )
                } else {
                    match payload.event() {
                        PageLoadEvent::Started => {
                            (BrowserLifecycleEventKind::NavigationCommitted, None)
                        }
                        PageLoadEvent::Finished => {
                            (BrowserLifecycleEventKind::NavigationFinished, None)
                        }
                    }
                };
                emit_native_event(
                    &load_app,
                    &load_events,
                    &load_sequence,
                    &load_page_id,
                    generation,
                    kind,
                    Some(url),
                    detail,
                );
            })
            .on_document_title_changed(move |_webview, title| {
                emit_native_event(
                    &title_app,
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
                                    &download_app,
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
                                    &download_app,
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
                            &download_app,
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
        let attach_app = self.app.clone();
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
                    attach_app.clone(),
                    attach_events.clone(),
                    attach_sequence.clone(),
                    attach_generations.clone(),
                    attach_page_id.clone(),
                    attach_permissions,
                    attach_certificates,
                    attach_dialogs,
                ) {
                    emit_native_event(
                        &attach_app,
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
        self.write_registry()?;
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

    fn navigate(&self, page_id: &str, url: &str, navigation_generation: u64) -> BrowserResult<()> {
        let parsed = url::Url::parse(url)
            .map_err(|error| BrowserError::invalid(format!("invalid browser URL: {error}")))?;
        if !matches!(parsed.scheme(), "http" | "https" | "about") {
            return Err(BrowserError::new(
                BrowserErrorCode::UnsafeUrl,
                "unsafe browser URL scheme",
            ));
        }
        self.navigation_generations
            .lock()
            .map_err(|_| {
                BrowserError::new(
                    BrowserErrorCode::Internal,
                    "browser generation lock is poisoned",
                )
            })?
            .insert(page_id.to_string(), navigation_generation);
        let pages = self.pages()?;
        let page = pages
            .get(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        page.webview.navigate(parsed).map_err(|error| {
            self.emit_event(
                page_id,
                navigation_generation,
                BrowserLifecycleEventKind::NavigationFailed,
                Some(url.to_string()),
                Some(error.to_string()),
            );
            native_error(error)
        })
    }

    fn set_navigation_generation(&self, page_id: &str, generation: u64) -> BrowserResult<()> {
        self.navigation_generations
            .lock()
            .map_err(|_| {
                BrowserError::new(
                    BrowserErrorCode::Internal,
                    "browser generation lock is poisoned",
                )
            })?
            .insert(page_id.to_string(), generation);
        Ok(())
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
                    .filter(|(_, value)| value.as_str() == page_id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for request_id in permission_ids {
            let _ = self.resolve_permission(&request_id, PermissionDecision::Deny);
        }
        let certificate_ids = self
            .pending_certificates
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .filter(|(_, value)| value.as_str() == page_id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for request_id in certificate_ids {
            let _ = self.resolve_certificate(&request_id, CertificateDecision::Deny);
        }
        let dialog_ids = self
            .pending_dialogs
            .lock()
            .map(|pending| {
                pending
                    .iter()
                    .filter(|(_, value)| value.as_str() == page_id)
                    .map(|(id, _)| id.clone())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for request_id in dialog_ids {
            let _ = self.resolve_dialog(&request_id, false);
        }
        let page = self
            .pages()?
            .remove(page_id)
            .ok_or_else(|| BrowserError::not_found(page_id))?;
        let generation = self
            .navigation_generations
            .lock()
            .ok()
            .and_then(|mut generations| generations.remove(page_id))
            .unwrap_or_default();
        page.webview.close().map_err(native_error)?;
        self.emit_event(
            page_id,
            generation,
            BrowserLifecycleEventKind::PageClosed,
            None,
            None,
        );
        self.write_registry()
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

    fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> BrowserResult<()> {
        let page_id = self
            .pending_permissions
            .lock()
            .map_err(|_| BrowserError::new(BrowserErrorCode::Internal, "permission lock poisoned"))?
            .remove(request_id)
            .ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorCode::PermissionNotFound,
                    format!("permission request not found: {request_id}"),
                )
            })?;
        let request_id = request_id.to_string();
        self.complete_on_page(&page_id, move || {
            NATIVE_PERMISSION_RESOLVERS.with(|resolutions| {
                let resolver = resolutions
                    .borrow_mut()
                    .remove(&request_id)
                    .ok_or_else(|| BrowserError::not_found(&request_id))?;
                resolver(decision)
            })
        })
    }

    fn resolve_certificate(
        &self,
        request_id: &str,
        decision: CertificateDecision,
    ) -> BrowserResult<()> {
        let page_id = self
            .pending_certificates
            .lock()
            .map_err(|_| {
                BrowserError::new(BrowserErrorCode::Internal, "certificate lock poisoned")
            })?
            .remove(request_id)
            .ok_or_else(|| {
                BrowserError::new(
                    BrowserErrorCode::CertificateNotFound,
                    format!("certificate request not found: {request_id}"),
                )
            })?;
        let request_id = request_id.to_string();
        self.complete_on_page(&page_id, move || {
            NATIVE_CERTIFICATE_RESOLVERS.with(|resolutions| {
                let resolver = resolutions
                    .borrow_mut()
                    .remove(&request_id)
                    .ok_or_else(|| BrowserError::not_found(&request_id))?;
                resolver(decision)
            })
        })
    }

    fn resolve_dialog(&self, request_id: &str, accept: bool) -> BrowserResult<()> {
        let page_id = self
            .pending_dialogs
            .lock()
            .map_err(|_| BrowserError::new(BrowserErrorCode::Internal, "dialog lock poisoned"))?
            .remove(request_id)
            .ok_or_else(|| BrowserError::not_found(request_id))?;
        let request_id = request_id.to_string();
        self.complete_on_page(&page_id, move || {
            NATIVE_DIALOG_RESOLVERS.with(|resolutions| {
                let resolver = resolutions
                    .borrow_mut()
                    .remove(&request_id)
                    .ok_or_else(|| BrowserError::not_found(&request_id))?;
                resolver(accept)
            })
        })
    }

    fn drain_events(&self) -> BrowserResult<Vec<BrowserLifecycleEvent>> {
        let mut events = self.events.lock().map_err(|_| {
            BrowserError::new(BrowserErrorCode::Internal, "browser event lock is poisoned")
        })?;
        Ok(events.drain(..).collect())
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
fn emit_native_event(
    app: &AppHandle<Wry>,
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
        queue.push_back(event.clone());
    }
    let _ = app.emit("browser-lifecycle", event);
}
#[cfg(windows)]
fn attach_native_prompt_handlers(
    platform: tauri::webview::PlatformWebview,
    app: AppHandle<Wry>,
    events: Arc<Mutex<VecDeque<BrowserLifecycleEvent>>>,
    sequence: Arc<AtomicU64>,
    generations: Arc<Mutex<HashMap<String, u64>>>,
    page_id: String,
    pending_permissions: Arc<Mutex<HashMap<String, String>>>,
    pending_certificates: Arc<Mutex<HashMap<String, String>>>,
    pending_dialogs: Arc<Mutex<HashMap<String, String>>>,
) -> windows::core::Result<()> {
    let core = unsafe { platform.controller().CoreWebView2()? };

    let permission_app = app.clone();
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
                    resolutions.insert(request_id.clone(), permission_page_id.clone());
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
                    &permission_app,
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

    let dialog_app = app.clone();
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
                    resolutions.insert(request_id.clone(), dialog_page_id.clone());
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
                    &dialog_app,
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

    let certificate_app = app;
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
                    resolutions.insert(request_id.clone(), certificate_page_id.clone());
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
                    &certificate_app,
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

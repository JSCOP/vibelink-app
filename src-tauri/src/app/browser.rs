use crate::browser::{
    ArtifactDescriptor, BrowserAnnotation, BrowserAnnotationInput, BrowserCaptureState,
    BrowserCookieImportInput, BrowserCookieImportResult, BrowserCookieImportSource,
    BrowserDeviceMetrics, BrowserDialogRequest, BrowserDownloadRecord, BrowserError,
    BrowserErrorCode, BrowserLifecycleEvent, BrowserManager, BrowserPage, BrowserProfile,
    CertificateDecision, CertificateRequest, PermissionDecision, PermissionRequest, PhysicalBounds,
    PlatformBrowserProvider, ProfileKind,
};
use crate::dedicated_cli::browser_page::{
    BrowserJpegCaptureOptions, BrowserKeyInput as CdpKeyInput, BrowserPageScale,
    BrowserPointerInput as CdpPointerInput, BrowserViewport,
};
use crate::remote::v2::generated::{
    BrowserInspectParams, BrowserInspectResult, BrowserKeyParams, BrowserKeyType,
    BrowserNavigateParams, BrowserPageParams, BrowserPointerParams, BrowserPointerType,
    BrowserScreenshotParams, BrowserScreenshotResult, BrowserTab, BrowserTabCloseParams,
    BrowserTabCloseResult, BrowserTabOpenParams, BrowserTabResult, BrowserTabsParams,
    BrowserTabsResult, BrowserViewportMode, BrowserViewportSetParams,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager as _, State, Wry};
use uuid::Uuid;

pub type ManagedBrowser = Arc<BrowserManager<PlatformBrowserProvider>>;

#[cfg(windows)]
static BROWSER_EVENT_PUMP_SCHEDULED: AtomicBool = AtomicBool::new(false);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProjection {
    profiles: Vec<BrowserProfile>,
    pages: Vec<BrowserPage>,
    permissions: Vec<PermissionRequest>,
    certificates: Vec<CertificateRequest>,
    dialogs: Vec<BrowserDialogRequest>,
    downloads: Vec<BrowserDownloadRecord>,
    events: Vec<BrowserLifecycleEvent>,
}

#[tauri::command]
pub async fn browser_initialize(
    manager: State<'_, ManagedBrowser>,
    workspace_id: String,
) -> Result<BrowserProjection, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        match manager.restore_workspace(&workspace_id, hidden_bounds()) {
            Ok(_) => {}
            Err(error) if error.code == BrowserErrorCode::Conflict => {
                std::thread::sleep(Duration::from_millis(40));
                manager
                    .restore_workspace(&workspace_id, hidden_bounds())
                    .map_err(to_string)?;
            }
            Err(error) => return Err(to_string(error)),
        }
        manager.sync_provider_events().map_err(to_string)?;
        browser_projection(&manager, &workspace_id)
    })
    .await
}

#[tauri::command]
pub async fn browser_create_profile(
    manager: State<'_, ManagedBrowser>,
    workspace_id: String,
    kind: ProfileKind,
) -> Result<BrowserProfile, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        let (id, owner) = match kind {
            ProfileKind::Persistent => (format!("profile-{}", Uuid::new_v4()), None),
            ProfileKind::Workspace => (
                format!("workspace-{workspace_id}"),
                Some(workspace_id.clone()),
            ),
            ProfileKind::Imported => (
                format!("imported-{}", Uuid::new_v4()),
                Some(workspace_id.clone()),
            ),
            ProfileKind::Incognito => (
                format!("incognito-{}", Uuid::new_v4()),
                Some(workspace_id.clone()),
            ),
        };
        if let Some(existing) = manager
            .profiles()
            .map_err(to_string)?
            .into_iter()
            .find(|profile| profile.id == id)
        {
            return Ok(existing);
        }
        let profile = manager.create_profile(id, kind, owner).map_err(to_string)?;
        if let Err(error) = manager.save_state() {
            if let Err(rollback_error) = manager.rollback_empty_profile(&profile.id) {
                return Err(format!(
                    "{error}; browser profile rollback also failed: {rollback_error}"
                ));
            }
            return Err(to_string(error));
        }
        Ok(profile)
    })
    .await
}

#[tauri::command]
pub async fn browser_create_tab(
    manager: State<'_, ManagedBrowser>,
    workspace_id: String,
    profile_id: String,
) -> Result<BrowserPage, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        let default_profile_id = format!("workspace-{workspace_id}");
        let mut created_profile = false;
        if !manager
            .profiles()
            .map_err(to_string)?
            .iter()
            .any(|profile| profile.id == profile_id)
        {
            if profile_id != default_profile_id {
                return Err(format!("browser profile not found: {profile_id}"));
            }
            match manager.create_profile(
                profile_id.clone(),
                ProfileKind::Workspace,
                Some(workspace_id.clone()),
            ) {
                Ok(_) => created_profile = true,
                Err(error) if error.code == BrowserErrorCode::Conflict => {}
                Err(error) => return Err(to_string(error)),
            }
        }
        let page = match manager.create_page(
            Uuid::new_v4().to_string(),
            workspace_id.clone(),
            &profile_id,
            hidden_bounds(),
        ) {
            Ok(page) => page,
            Err(error) => {
                if created_profile {
                    let _ = manager.rollback_empty_profile(&profile_id);
                }
                return Err(to_string(error));
            }
        };
        let page = manager.page(&page.id).map_err(to_string)?;
        if let Err(persistence_error) = manager.save_state() {
            match manager.close_page(&page.id) {
                Ok(()) => {
                    if created_profile {
                        manager
                            .rollback_empty_profile(&profile_id)
                            .map_err(to_string)?;
                    }
                    return Err(to_string(persistence_error));
                }
                Err(rollback_error) => {
                    return manager
                        .mark_page_persistence_error(
                            &page.id,
                            format!(
                                "Browser state could not be saved; this page remains open for recovery. Persistence: {persistence_error}. Rollback: {rollback_error}"
                            ),
                        )
                        .map_err(to_string);
                }
            }
        }
        Ok(page)
    })
    .await
}

#[tauri::command]
pub async fn browser_go_back(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
) -> Result<BrowserPage, String> {
    let manager = manager.inner().clone();
    off_main(move || manager.go_back(&page_id).map_err(to_string)).await
}

#[tauri::command]
pub async fn browser_go_forward(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
) -> Result<BrowserPage, String> {
    let manager = manager.inner().clone();
    off_main(move || manager.go_forward(&page_id).map_err(to_string)).await
}

#[tauri::command]
pub async fn browser_reload(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
) -> Result<BrowserPage, String> {
    let manager = manager.inner().clone();
    off_main(move || manager.reload(&page_id).map_err(to_string)).await
}

#[tauri::command]
pub async fn browser_navigate(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
    input: String,
) -> Result<BrowserPage, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        let page = manager.navigate(&page_id, &input).map_err(to_string)?;
        manager.save_state().map_err(to_string)?;
        Ok(page)
    })
    .await
}

#[tauri::command]
pub async fn browser_set_surface(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
    bounds: Option<PhysicalBounds>,
    visible: bool,
    focused: Option<bool>,
    owner_generation: u64,
) -> Result<BrowserPage, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager
            .set_surface(
                &page_id,
                owner_generation,
                bounds,
                visible,
                focused.unwrap_or(false),
            )
            .map_err(to_string)
    })
    .await
}

#[tauri::command]
pub async fn browser_set_design_mode(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
    enabled: bool,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager
            .set_design_mode(&page_id, enabled)
            .map_err(to_string)
    })
    .await
}

#[tauri::command]
pub async fn browser_set_device_metrics(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
    metrics: Option<BrowserDeviceMetrics>,
) -> Result<BrowserPage, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        let page = match metrics {
            Some(metrics) => manager
                .set_device_metrics(&page_id, metrics)
                .map_err(to_string)?,
            None => manager.clear_device_metrics(&page_id).map_err(to_string)?,
        };
        manager.save_state().map_err(to_string)?;
        Ok(page)
    })
    .await
}

#[tauri::command]
pub async fn browser_capture_state(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
    capture: Option<bool>,
) -> Result<BrowserCaptureState, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        if capture.unwrap_or(false) {
            manager.capture_page(&page_id).map_err(to_string)
        } else {
            manager.capture_state(&page_id).map_err(to_string)
        }
    })
    .await
}

#[tauri::command]
pub async fn browser_capture_crop(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
    bounds: PhysicalBounds,
) -> Result<ArtifactDescriptor, String> {
    let manager = manager.inner().clone();
    off_main(move || manager.capture_crop(&page_id, bounds).map_err(to_string)).await
}

#[tauri::command]
pub async fn browser_open_dev_tools(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    off_main(move || manager.open_dev_tools(&page_id).map_err(to_string)).await
}

/// Capture the page and store it as an ordinary screenshot so the existing
/// capture annotator can open it. Writing anywhere else would require widening
/// `read_capture_file`, which is deliberately locked to `<dir>/Images`.
#[tauri::command]
pub async fn browser_capture_page_image(
    manager: State<'_, ManagedBrowser>,
    page_id: String,
    dir: String,
) -> Result<String, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        let bytes = manager.capture_page_png(&page_id).map_err(to_string)?;
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        crate::app::capture::store_capture_image(&dir, &format!("vibelink-browser-{stamp}"), &bytes)
    })
    .await
}

#[tauri::command]
pub async fn browser_create_annotation(
    manager: State<'_, ManagedBrowser>,
    input: BrowserAnnotationInput,
) -> Result<BrowserAnnotation, String> {
    let manager = manager.inner().clone();
    off_main(move || manager.create_annotation(input).map_err(to_string)).await
}

#[tauri::command]
pub async fn browser_detect_cookie_import_source(
    manager: State<'_, ManagedBrowser>,
    endpoint: String,
) -> Result<BrowserCookieImportSource, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager
            .detect_cookie_import_source(&endpoint)
            .map_err(to_string)
    })
    .await
}

#[tauri::command]
pub async fn browser_import_cookies(
    manager: State<'_, ManagedBrowser>,
    input: BrowserCookieImportInput,
) -> Result<BrowserCookieImportResult, String> {
    let manager = manager.inner().clone();
    off_main(move || manager.import_cookies(input).map_err(to_string)).await
}

#[tauri::command]
pub async fn browser_resolve_permission(
    manager: State<'_, ManagedBrowser>,
    request_id: String,
    decision: PermissionDecision,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager
            .resolve_permission(&request_id, decision)
            .map(|_| ())
            .map_err(to_string)
    })
    .await
}

#[tauri::command]
pub async fn browser_resolve_certificate(
    manager: State<'_, ManagedBrowser>,
    request_id: String,
    decision: CertificateDecision,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager
            .resolve_certificate(&request_id, decision)
            .map(|_| ())
            .map_err(to_string)
    })
    .await
}

#[tauri::command]
pub async fn browser_resolve_dialog(
    manager: State<'_, ManagedBrowser>,
    request_id: String,
    accept: Option<bool>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager
            .resolve_dialog(&request_id, accept.unwrap_or(false))
            .map(|_| ())
            .map_err(to_string)
    })
    .await
}

#[tauri::command]
pub async fn browser_close_tab(
    manager: State<'_, ManagedBrowser>,
    workspace_id: String,
    page_id: String,
) -> Result<BrowserCloseResult, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager
            .close_page_durable(&workspace_id, &page_id)
            .map_err(to_string)?;
        Ok(BrowserCloseResult {
            closed: true,
            persistence_pending: false,
        })
    })
    .await
}

#[tauri::command]
pub async fn browser_cleanup_workspace(
    manager: State<'_, ManagedBrowser>,
    workspace_id: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    off_main(move || manager.cleanup_workspace(&workspace_id).map_err(to_string)).await
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserCloseResult {
    closed: bool,
    persistence_pending: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserProjectTarget {
    label: String,
    url: String,
    port: u16,
    running: bool,
    source: String,
    start_command: Option<String>,
}

#[tauri::command]
pub async fn browser_project_targets(
    workspace_folder: String,
) -> Result<Vec<BrowserProjectTarget>, String> {
    off_main(move || discover_project_targets(Path::new(&workspace_folder)).map_err(to_string))
        .await
}

fn discover_project_targets(root: &Path) -> Result<Vec<BrowserProjectTarget>, String> {
    let root = root
        .canonicalize()
        .map_err(|error| format!("resolve workspace folder: {error}"))?;
    if !root.is_dir() {
        return Err("workspace folder is not a directory".to_string());
    }

    let mut candidates = BTreeMap::<u16, (String, String)>::new();
    let start_command = project_start_command(&root);
    let package_path = root.join("package.json");
    if let Ok(metadata) = fs::metadata(&package_path) {
        if metadata.len() <= 1024 * 1024 {
            if let Ok(bytes) = fs::read(&package_path) {
                if let Ok(package) = serde_json::from_slice::<Value>(&bytes) {
                    if let Some(scripts) = package.get("scripts").and_then(Value::as_object) {
                        for (name, command) in scripts {
                            if matches!(name.as_str(), "dev" | "start" | "serve" | "preview") {
                                if let Some(command) = command.as_str() {
                                    collect_command_ports(command, name, &mut candidates);
                                }
                            }
                        }
                    }
                    let dependencies = package
                        .get("dependencies")
                        .and_then(Value::as_object)
                        .into_iter()
                        .flatten()
                        .chain(
                            package
                                .get("devDependencies")
                                .and_then(Value::as_object)
                                .into_iter()
                                .flatten(),
                        )
                        .map(|(name, _)| name.as_str())
                        .collect::<Vec<_>>();
                    if dependencies.contains(&"next") {
                        candidates
                            .entry(3000)
                            .or_insert_with(|| ("Next.js".into(), "package.json".into()));
                    }
                    if dependencies
                        .iter()
                        .any(|name| *name == "vite" || *name == "@vitejs/plugin-react")
                    {
                        candidates
                            .entry(5173)
                            .or_insert_with(|| ("Vite".into(), "package.json".into()));
                    }
                    if dependencies.contains(&"@angular/core") {
                        candidates
                            .entry(4200)
                            .or_insert_with(|| ("Angular".into(), "package.json".into()));
                    }
                    if dependencies.contains(&"astro") {
                        candidates
                            .entry(4321)
                            .or_insert_with(|| ("Astro".into(), "package.json".into()));
                    }
                }
            }
        }
    }
    collect_tauri_project_target(&root, &mut candidates);
    if [
        "vite.config.ts",
        "vite.config.js",
        "vite.config.mts",
        "vite.config.mjs",
    ]
    .iter()
    .any(|name| root.join(name).is_file())
    {
        candidates
            .entry(5173)
            .or_insert_with(|| ("Vite".into(), "vite.config".into()));
    }
    if candidates.is_empty() {
        for port in [3000, 5173, 8080] {
            candidates.insert(port, ("Project preview".into(), "common default".into()));
        }
    }

    let mut targets = candidates
        .into_iter()
        .map(|(port, (label, source))| BrowserProjectTarget {
            label,
            url: format!("http://localhost:{port}"),
            port,
            running: project_port_is_running(port),
            start_command: start_command.clone(),
            source,
        })
        .collect::<Vec<_>>();
    targets.sort_by_key(|target| (!target.running, target.port));
    targets.truncate(8);
    Ok(targets)
}

fn project_port_is_running(port: u16) -> bool {
    [
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port),
        SocketAddr::new(IpAddr::V6(Ipv6Addr::LOCALHOST), port),
    ]
    .into_iter()
    .any(|address| TcpStream::connect_timeout(&address, Duration::from_millis(75)).is_ok())
}

fn project_start_command(root: &Path) -> Option<String> {
    let package_path = root.join("package.json");
    let metadata = fs::metadata(&package_path).ok()?;
    if metadata.len() > 1024 * 1024 {
        return None;
    }
    let package = serde_json::from_slice::<Value>(&fs::read(package_path).ok()?).ok()?;
    let scripts = package.get("scripts")?.as_object()?;
    let script = ["dev", "start", "serve", "preview"]
        .into_iter()
        .find(|name| scripts.get(*name).and_then(Value::as_str).is_some())?;
    let runner = if root.join("pnpm-lock.yaml").is_file() {
        "pnpm"
    } else if root.join("bun.lock").is_file() || root.join("bun.lockb").is_file() {
        "bun"
    } else if root.join("yarn.lock").is_file() {
        "yarn"
    } else {
        "npm"
    };
    Some(if runner == "yarn" {
        format!("yarn {script}")
    } else {
        format!("{runner} run {script}")
    })
}

fn collect_tauri_project_target(root: &Path, candidates: &mut BTreeMap<u16, (String, String)>) {
    let path = root.join("src-tauri").join("tauri.conf.json");
    let Ok(metadata) = fs::metadata(&path) else {
        return;
    };
    if metadata.len() > 1024 * 1024 {
        return;
    }
    let Ok(bytes) = fs::read(path) else {
        return;
    };
    let Ok(config) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    let Some(dev_url) = config.pointer("/build/devUrl").and_then(Value::as_str) else {
        return;
    };
    let Ok(url) = url::Url::parse(dev_url) else {
        return;
    };
    if !url
        .host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "::1"))
    {
        return;
    }
    if let Some(port) = url.port_or_known_default().filter(|port| *port != 0) {
        candidates.insert(port, ("Tauri dev server".into(), "tauri.conf.json".into()));
    }
}

fn collect_command_ports(
    command: &str,
    script_name: &str,
    candidates: &mut BTreeMap<u16, (String, String)>,
) {
    let tokens = command.split_whitespace().collect::<Vec<_>>();
    for (index, token) in tokens.iter().enumerate() {
        let value = token
            .strip_prefix("--port=")
            .or_else(|| token.strip_prefix("-p="))
            .or_else(|| {
                matches!(*token, "--port" | "-p")
                    .then(|| tokens.get(index + 1).copied())
                    .flatten()
            });
        if let Some(port) =
            value.and_then(|value| value.trim_matches(['\'', '"']).parse::<u16>().ok())
        {
            if port != 0 {
                candidates.entry(port).or_insert_with(|| {
                    (
                        format!("{script_name} script"),
                        "package.json script".into(),
                    )
                });
            }
        }
    }
}

pub(crate) fn handle_remote_browser_request(
    manager: &ManagedBrowser,
    method: &str,
    payload_json: &str,
) -> Result<Value, String> {
    if payload_json.len() > 64 * 1024 {
        return Err("invalid_argument: browser request exceeds the bounded size".to_string());
    }
    match method {
        "tabs" => {
            let params: BrowserTabsParams = parse_remote_payload(payload_json)?;
            validate_remote_id("workspaceId", &params.workspace_id)?;
            manager
                .sync_provider_events()
                .map_err(remote_browser_error)?;
            let tabs = manager
                .pages()
                .map_err(remote_browser_error)?
                .into_iter()
                .filter(|page| page.workspace_id == params.workspace_id)
                .map(remote_browser_tab)
                .collect();
            serde_json::to_value(BrowserTabsResult { tabs }).map_err(|error| error.to_string())
        }
        "tab.open" => {
            let params: BrowserTabOpenParams = parse_remote_payload(payload_json)?;
            validate_remote_id("workspaceId", &params.workspace_id)?;
            let page =
                create_remote_browser_tab(manager, &params.workspace_id, params.url.as_deref())?;
            serde_json::to_value(BrowserTabResult {
                tab: remote_browser_tab(page),
            })
            .map_err(|error| error.to_string())
        }
        "tab.close" => {
            let params: BrowserTabCloseParams = parse_remote_payload(payload_json)?;
            owned_remote_page(manager, &params.workspace_id, &params.page_id)?;
            manager
                .close_page_durable(&params.workspace_id, &params.page_id)
                .map_err(remote_browser_error)?;
            serde_json::to_value(BrowserTabCloseResult { closed: true })
                .map_err(|error| error.to_string())
        }
        "navigate" => {
            let params: BrowserNavigateParams = parse_remote_payload(payload_json)?;
            owned_remote_page(manager, &params.workspace_id, &params.page_id)?;
            validate_remote_text("url", &params.url, 8 * 1024)?;
            let page = manager
                .navigate(&params.page_id, &params.url)
                .map_err(remote_browser_error)?;
            manager.save_state().map_err(remote_browser_error)?;
            browser_tab_result(page)
        }
        "reload" | "back" | "forward" => {
            let params: BrowserPageParams = parse_remote_payload(payload_json)?;
            owned_remote_page(manager, &params.workspace_id, &params.page_id)?;
            let page = match method {
                "reload" => manager.reload(&params.page_id),
                "back" => manager.go_back(&params.page_id),
                _ => manager.go_forward(&params.page_id),
            }
            .map_err(remote_browser_error)?;
            manager.save_state().map_err(remote_browser_error)?;
            browser_tab_result(page)
        }
        "inspect" => {
            let params: BrowserInspectParams = parse_remote_payload(payload_json)?;
            owned_remote_page(manager, &params.workspace_id, &params.page_id)?;
            let snapshot = manager
                .inspect_page(&params.page_id, params.x, params.y)
                .map_err(remote_browser_error)?;
            serde_json::to_value(BrowserInspectResult {
                snapshot_json: snapshot.snapshot_json,
                truncated: snapshot.truncated,
            })
            .map_err(|error| error.to_string())
        }
        "input.pointer" => {
            let params: BrowserPointerParams = parse_remote_payload(payload_json)?;
            owned_remote_page(manager, &params.workspace_id, &params.page_id)?;
            let input = remote_pointer_input(params.input)?;
            manager
                .dispatch_pointer(&params.page_id, input)
                .map_err(remote_browser_error)?;
            Ok(serde_json::json!({}))
        }
        "input.key" => {
            let params: BrowserKeyParams = parse_remote_payload(payload_json)?;
            owned_remote_page(manager, &params.workspace_id, &params.page_id)?;
            let input = remote_key_input(params.input)?;
            manager
                .dispatch_key(&params.page_id, input)
                .map_err(remote_browser_error)?;
            Ok(serde_json::json!({}))
        }
        "screenshot" => {
            let params: BrowserScreenshotParams = parse_remote_payload(payload_json)?;
            owned_remote_page(manager, &params.workspace_id, &params.page_id)?;
            let quality = remote_jpeg_quality(params.quality)?;
            let (frame, generation) = manager
                .capture_jpeg(&params.page_id, BrowserJpegCaptureOptions { quality })
                .map_err(remote_browser_error)?;
            serde_json::to_value(BrowserScreenshotResult {
                data_base64: BASE64_STANDARD.encode(frame.bytes),
                width: frame.viewport_width,
                height: frame.viewport_height,
                view_generation: generation.saturating_add(1),
            })
            .map_err(|error| error.to_string())
        }
        "viewport.set" => {
            let params: BrowserViewportSetParams = parse_remote_payload(payload_json)?;
            owned_remote_page(manager, &params.workspace_id, &params.page_id)?;
            let viewport = remote_viewport(&params)?;
            let page_scale = remote_page_scale(&params)?;
            match viewport {
                BrowserViewport::Web => {
                    manager
                        .clear_device_metrics(&params.page_id)
                        .map_err(remote_browser_error)?;
                }
                BrowserViewport::Mobile {
                    width,
                    height,
                    device_scale_factor,
                } => {
                    manager
                        .set_device_metrics(
                            &params.page_id,
                            BrowserDeviceMetrics {
                                width,
                                height,
                                device_scale_factor,
                                mobile: true,
                            },
                        )
                        .map_err(remote_browser_error)?;
                }
            }
            if let Some(scale) = page_scale {
                manager
                    .set_page_scale(&params.page_id, scale)
                    .map_err(remote_browser_error)?;
            }
            manager.save_state().map_err(remote_browser_error)?;
            Ok(serde_json::json!({}))
        }
        _ => Err(format!(
            "invalid_argument: unsupported browser method {method}"
        )),
    }
}

fn parse_remote_payload<T: serde::de::DeserializeOwned>(payload_json: &str) -> Result<T, String> {
    serde_json::from_str(payload_json).map_err(|error| format!("invalid_argument: {error}"))
}

fn validate_remote_id(name: &str, value: &str) -> Result<(), String> {
    if value.len() > 64 || Uuid::parse_str(value).is_err() {
        return Err(format!("invalid_argument: {name} must be a UUID"));
    }
    Ok(())
}

fn validate_remote_text(name: &str, value: &str, max_bytes: usize) -> Result<(), String> {
    if value.is_empty() || value.len() > max_bytes || value.contains('\0') {
        return Err(format!(
            "invalid_argument: {name} is empty or exceeds the bounded size"
        ));
    }
    Ok(())
}

fn owned_remote_page<P: crate::browser::BrowserProvider>(
    manager: &BrowserManager<P>,
    workspace_id: &str,
    page_id: &str,
) -> Result<BrowserPage, String> {
    validate_remote_id("workspaceId", workspace_id)?;
    validate_remote_id("pageId", page_id)?;
    let page = manager
        .page(page_id)
        .map_err(|_| "stale_target: browser page is not active".to_string())?;
    if page.workspace_id != workspace_id {
        return Err("stale_target: browser page belongs to a different workspace".to_string());
    }
    Ok(page)
}

fn create_remote_browser_tab<P: crate::browser::BrowserProvider>(
    manager: &BrowserManager<P>,
    workspace_id: &str,
    url: Option<&str>,
) -> Result<BrowserPage, String> {
    if let Some(url) = url {
        validate_remote_text("url", url, 8 * 1024)?;
    }
    let profile_id = format!("workspace-{workspace_id}");
    let mut created_profile = false;
    if !manager
        .profiles()
        .map_err(remote_browser_error)?
        .iter()
        .any(|profile| profile.id == profile_id)
    {
        match manager.create_profile(
            profile_id.clone(),
            ProfileKind::Workspace,
            Some(workspace_id.to_string()),
        ) {
            Ok(_) => created_profile = true,
            Err(error) if error.code == BrowserErrorCode::Conflict => {}
            Err(error) => return Err(remote_browser_error(error)),
        }
    }
    let page = match manager.create_page(
        Uuid::new_v4().to_string(),
        workspace_id.to_string(),
        &profile_id,
        hidden_bounds(),
    ) {
        Ok(page) => page,
        Err(error) => {
            if created_profile {
                let _ = manager.rollback_empty_profile(&profile_id);
            }
            return Err(remote_browser_error(error));
        }
    };
    let result = if let Some(url) = url {
        manager.navigate(&page.id, url)
    } else {
        manager.page(&page.id)
    };
    let page = match result {
        Ok(page) => page,
        Err(error) => {
            let _ = manager.close_page(&page.id);
            if created_profile {
                let _ = manager.rollback_empty_profile(&profile_id);
            }
            return Err(remote_browser_error(error));
        }
    };
    if let Err(error) = manager.save_state() {
        let _ = manager.close_page(&page.id);
        if created_profile {
            let _ = manager.rollback_empty_profile(&profile_id);
        }
        return Err(remote_browser_error(error));
    }
    Ok(page)
}

fn remote_browser_tab(page: BrowserPage) -> BrowserTab {
    BrowserTab {
        id: page.id,
        title: page.title,
        url: page.url,
        workspace_id: page.workspace_id,
    }
}

fn browser_tab_result(page: BrowserPage) -> Result<Value, String> {
    serde_json::to_value(BrowserTabResult {
        tab: remote_browser_tab(page),
    })
    .map_err(|error| error.to_string())
}

fn remote_pointer_input(
    input: crate::remote::v2::generated::BrowserPointerInput,
) -> Result<CdpPointerInput, String> {
    match input.r#type {
        BrowserPointerType::Tap => match (
            input.x,
            input.y,
            input.from_x,
            input.from_y,
            input.to_x,
            input.to_y,
            input.delta_x,
            input.delta_y,
        ) {
            (Some(x), Some(y), None, None, None, None, None, None) => {
                Ok(CdpPointerInput::Tap { x, y })
            }
            _ => Err("invalid_argument: tap requires only x and y".to_string()),
        },
        BrowserPointerType::Drag => match (
            input.x,
            input.y,
            input.from_x,
            input.from_y,
            input.to_x,
            input.to_y,
            input.delta_x,
            input.delta_y,
        ) {
            (None, None, Some(from_x), Some(from_y), Some(to_x), Some(to_y), None, None) => {
                Ok(CdpPointerInput::Drag {
                    from_x,
                    from_y,
                    to_x,
                    to_y,
                })
            }
            _ => Err("invalid_argument: drag requires only fromX, fromY, toX, and toY".to_string()),
        },
        BrowserPointerType::Scroll => match (
            input.x,
            input.y,
            input.from_x,
            input.from_y,
            input.to_x,
            input.to_y,
            input.delta_x,
            input.delta_y,
        ) {
            (Some(x), Some(y), None, None, None, None, Some(delta_x), Some(delta_y)) => {
                Ok(CdpPointerInput::Scroll {
                    x,
                    y,
                    delta_x,
                    delta_y,
                })
            }
            _ => Err("invalid_argument: scroll requires only x, y, deltaX, and deltaY".to_string()),
        },
    }
}

fn remote_key_input(
    input: crate::remote::v2::generated::BrowserKeyInput,
) -> Result<CdpKeyInput, String> {
    match input.r#type {
        BrowserKeyType::Text => match (input.text, input.key) {
            (Some(text), None) => {
                validate_remote_text("text", &text, 16 * 1024)?;
                Ok(CdpKeyInput::Text { text })
            }
            _ => Err("invalid_argument: text input requires only text".to_string()),
        },
        BrowserKeyType::Key => match (input.text, input.key) {
            (None, Some(key)) => {
                validate_remote_text("key", &key, 64)?;
                if key.chars().any(char::is_control) {
                    return Err("invalid_argument: key contains control characters".to_string());
                }
                Ok(CdpKeyInput::Key { key })
            }
            _ => Err("invalid_argument: key input requires only key".to_string()),
        },
    }
}

fn remote_jpeg_quality(quality: Option<u16>) -> Result<u8, String> {
    let quality = quality.unwrap_or(80);
    if !(1..=100).contains(&quality) {
        return Err("invalid_argument: JPEG quality must be between 1 and 100".to_string());
    }
    Ok(quality as u8)
}

fn remote_page_scale(
    params: &BrowserViewportSetParams,
) -> Result<Option<BrowserPageScale>, String> {
    let scale = match params.page_scale {
        Some(scale) => BrowserPageScale {
            scale,
            center_x: params.center_x,
            center_y: params.center_y,
        },
        None if params.center_x.is_none() && params.center_y.is_none() => return Ok(None),
        None => return Err("invalid_argument: viewport center requires pageScale".to_string()),
    };
    scale
        .validate()
        .map_err(|error| format!("invalid_argument: {error}"))?;
    Ok(Some(scale))
}

fn remote_viewport(params: &BrowserViewportSetParams) -> Result<BrowserViewport, String> {
    match params.mode {
        BrowserViewportMode::Web => {
            if params.width.is_some()
                || params.height.is_some()
                || params.device_scale_factor.is_some()
            {
                return Err(
                    "invalid_argument: web viewport does not accept mobile metrics".to_string(),
                );
            }
            Ok(BrowserViewport::Web)
        }
        BrowserViewportMode::Mobile => {
            match (params.width, params.height, params.device_scale_factor) {
                (None, None, None) => Ok(BrowserViewport::mobile_default()),
                (Some(width), Some(height), Some(device_scale_factor)) => {
                    let metrics = BrowserDeviceMetrics {
                        width,
                        height,
                        device_scale_factor,
                        mobile: true,
                    };
                    if !metrics.validate() {
                        return Err(
                            "invalid_argument: mobile viewport metrics are out of bounds"
                                .to_string(),
                        );
                    }
                    Ok(BrowserViewport::Mobile {
                        width,
                        height,
                        device_scale_factor,
                    })
                }
                _ => Err(
                    "invalid_argument: mobile viewport metrics must be supplied together"
                        .to_string(),
                ),
            }
        }
    }
}

fn remote_browser_error(error: BrowserError) -> String {
    let code = match error.code {
        BrowserErrorCode::InvalidArgument
        | BrowserErrorCode::UnsafeUrl
        | BrowserErrorCode::LocalFileDenied
        | BrowserErrorCode::DownloadDenied
        | BrowserErrorCode::Unsupported => "invalid_argument",
        BrowserErrorCode::NotFound => "stale_target",
        BrowserErrorCode::StaleRef => "stale_ref",
        BrowserErrorCode::DeniedCapability
        | BrowserErrorCode::PermissionNotFound
        | BrowserErrorCode::CertificateNotFound => "capability_denied",
        BrowserErrorCode::Conflict => "conflict",
        BrowserErrorCode::Timeout => "timeout",
        BrowserErrorCode::RuntimeUnavailable | BrowserErrorCode::Internal => "internal",
    };
    format!("{code}: {}", error.message)
}

async fn off_main<T, F>(action: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(action)
        .await
        .map_err(to_string)?
}

fn browser_projection(
    manager: &BrowserManager<PlatformBrowserProvider>,
    workspace_id: &str,
) -> Result<BrowserProjection, String> {
    let pages: Vec<BrowserPage> = manager
        .pages()
        .map_err(to_string)?
        .into_iter()
        .filter(|page| page.workspace_id == workspace_id)
        .collect();
    let page_ids = pages
        .iter()
        .map(|page: &BrowserPage| page.id.clone())
        .collect::<std::collections::HashSet<_>>();
    Ok(BrowserProjection {
        profiles: manager.profiles().map_err(to_string)?,
        pages,
        permissions: manager
            .pending_permissions()
            .map_err(to_string)?
            .into_iter()
            .filter(|request| page_ids.contains(request.page_id.as_str()))
            .collect(),
        certificates: manager
            .pending_certificates()
            .map_err(to_string)?
            .into_iter()
            .filter(|request| page_ids.contains(request.page_id.as_str()))
            .collect(),
        dialogs: manager
            .pending_dialogs()
            .map_err(to_string)?
            .into_iter()
            .filter(|request| page_ids.contains(request.page_id.as_str()))
            .collect(),
        downloads: manager
            .downloads()
            .map_err(to_string)?
            .into_iter()
            .filter(|download| page_ids.contains(download.page_id.as_str()))
            .collect(),
        events: manager
            .lifecycle_events_snapshot(0)
            .map_err(to_string)?
            .into_iter()
            .filter(|event| page_ids.contains(event.page_id.as_str()))
            .collect(),
    })
}

fn hidden_bounds() -> PhysicalBounds {
    PhysicalBounds {
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        scale_factor_milli: 1_000,
    }
}

fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(windows)]
pub(crate) fn schedule_browser_event_pump(app: AppHandle<Wry>) {
    if BROWSER_EVENT_PUMP_SCHEDULED
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        return;
    }
    drop(tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(Duration::from_millis(16));
        if let Some(manager) = app.try_state::<ManagedBrowser>() {
            loop {
                match manager.sync_provider_events() {
                    Ok(events) if !events.is_empty() => continue,
                    _ => break,
                }
            }
        }
        BROWSER_EVENT_PUMP_SCHEDULED.store(false, Ordering::Release);
        // Close the enqueue/store race: an event after the store schedules its own
        // pump, while an event just before the store is drained here.
        if let Some(manager) = app.try_state::<ManagedBrowser>() {
            let _ = manager.sync_provider_events();
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_targets_prefer_explicit_dev_script_ports() {
        let root =
            std::env::temp_dir().join(format!("vibelink-browser-project-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("package.json"),
            br#"{"scripts":{"dev":"vite --host 0.0.0.0 --port 43127"},"devDependencies":{"vite":"latest"}}"#,
        )
        .unwrap();
        let targets = discover_project_targets(&root).unwrap();
        let target = targets.iter().find(|target| target.port == 43127).unwrap();
        assert_eq!(target.url, "http://localhost:43127");
        assert_eq!(target.start_command.as_deref(), Some("npm run dev"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_targets_use_framework_defaults_without_explicit_ports() {
        let root =
            std::env::temp_dir().join(format!("vibelink-browser-project-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("package.json"),
            br#"{"scripts":{"dev":"next dev"},"dependencies":{"next":"latest"}}"#,
        )
        .unwrap();
        let targets = discover_project_targets(&root).unwrap();
        assert!(targets
            .iter()
            .any(|target| target.port == 3000 && target.label == "Next.js"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_targets_use_tauri_dev_url() {
        let root =
            std::env::temp_dir().join(format!("vibelink-browser-project-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("src-tauri")).unwrap();
        fs::write(
            root.join("src-tauri").join("tauri.conf.json"),
            br#"{"build":{"devUrl":"http://localhost:1420"}}"#,
        )
        .unwrap();
        let targets = discover_project_targets(&root).unwrap();
        assert!(targets
            .iter()
            .any(|target| { target.port == 1420 && target.label == "Tauri dev server" }));
        fs::remove_dir_all(root).unwrap();
    }

    #[derive(Clone, Copy)]
    struct RemoteTestProvider;

    impl crate::browser::BrowserProvider for RemoteTestProvider {
        fn create_child_webview(
            &self,
            _request: &crate::browser::ChildWebViewCreate,
        ) -> crate::browser::BrowserResult<()> {
            Ok(())
        }

        fn set_bounds(
            &self,
            _page_id: &str,
            _bounds: PhysicalBounds,
        ) -> crate::browser::BrowserResult<()> {
            Ok(())
        }

        fn set_visible(&self, _page_id: &str, _visible: bool) -> crate::browser::BrowserResult<()> {
            Ok(())
        }

        fn set_focus(&self, _page_id: &str, _focused: bool) -> crate::browser::BrowserResult<()> {
            Ok(())
        }

        fn navigate(
            &self,
            _page_id: &str,
            _url: &str,
            _navigation_generation: u64,
        ) -> crate::browser::BrowserResult<()> {
            Ok(())
        }

        fn close(&self, _page_id: &str) -> crate::browser::BrowserResult<()> {
            Ok(())
        }

        fn state(
            &self,
            _page_id: &str,
        ) -> crate::browser::BrowserResult<crate::browser::ChildWebViewState> {
            Err(BrowserError::unsupported("test state"))
        }
    }

    #[test]
    fn typed_browser_payloads_reject_legacy_args() {
        let workspace_id = Uuid::new_v4().to_string();
        let error = parse_remote_payload::<BrowserTabsParams>(
            &serde_json::json!({ "workspaceId": workspace_id, "args": [] }).to_string(),
        )
        .unwrap_err();
        assert!(error.contains("unknown field"));

        let error = remote_pointer_input(
            serde_json::from_value(serde_json::json!({
                "type": "tap",
                "x": 12.0,
                "y": 14.0,
                "deltaX": 1.0
            }))
            .unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("tap requires only x and y"));
    }

    #[test]
    fn remote_browser_page_ownership_rejects_cross_workspace_targets() {
        let root = std::env::temp_dir().join(format!("vibelink-remote-browser-{}", Uuid::new_v4()));
        let workspace_id = Uuid::new_v4().to_string();
        let other_workspace_id = Uuid::new_v4().to_string();
        let page_id = Uuid::new_v4().to_string();
        let profile_id = format!("workspace-{workspace_id}");
        let manager = BrowserManager::new(
            Arc::new(RemoteTestProvider),
            crate::browser::BrowserPolicy::new(
                false,
                Vec::new(),
                root.join("downloads"),
                root.join("artifacts"),
                64 * 1024 * 1024,
            )
            .unwrap(),
            root.join("profiles"),
        );
        manager
            .create_profile(
                profile_id.clone(),
                ProfileKind::Workspace,
                Some(workspace_id.clone()),
            )
            .unwrap();
        manager
            .create_page(
                page_id.clone(),
                workspace_id.clone(),
                &profile_id,
                hidden_bounds(),
            )
            .unwrap();

        assert!(owned_remote_page(&manager, &workspace_id, &page_id).is_ok());
        let error = owned_remote_page(&manager, &other_workspace_id, &page_id).unwrap_err();
        assert!(error.contains("different workspace"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn remote_tab_open_and_close_update_authoritative_persisted_state() {
        let root = std::env::temp_dir().join(format!("vibelink-remote-tab-{}", Uuid::new_v4()));
        let workspace_id = Uuid::new_v4().to_string();
        let manager = BrowserManager::new(
            Arc::new(RemoteTestProvider),
            crate::browser::BrowserPolicy::new(
                false,
                Vec::new(),
                root.join("downloads"),
                root.join("artifacts"),
                64 * 1024 * 1024,
            )
            .unwrap(),
            root.join("profiles"),
        );
        let page = create_remote_browser_tab(&manager, &workspace_id, None).unwrap();
        assert_eq!(manager.page(&page.id).unwrap().workspace_id, workspace_id);
        let persisted: Value =
            serde_json::from_slice(&fs::read(root.join("state.json")).unwrap()).unwrap();
        assert!(persisted["pages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|candidate| candidate["id"] == page.id));

        manager.close_page_durable(&workspace_id, &page.id).unwrap();
        assert!(manager.page(&page.id).is_err());
        let persisted: Value =
            serde_json::from_slice(&fs::read(root.join("state.json")).unwrap()).unwrap();
        assert!(!persisted["pages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|candidate| candidate["id"] == page.id));
        let _ = fs::remove_dir_all(root);
    }
}

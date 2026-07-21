use crate::browser::{
    ArtifactDescriptor, BrowserCaptureState, BrowserDeviceMetrics, BrowserDialogRequest,
    BrowserDownloadRecord, BrowserErrorCode, BrowserLifecycleEvent, BrowserManager, BrowserPage,
    BrowserProfile, CertificateDecision, CertificateRequest, NativeBrowserProvider,
    PermissionDecision, PermissionRequest, PhysicalBounds, ProfileKind,
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tauri::State;
use uuid::Uuid;

pub type ManagedBrowser = Arc<BrowserManager<NativeBrowserProvider>>;

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
        manager
            .restore_workspace(&workspace_id, hidden_bounds())
            .map_err(to_string)?;
        let profile_id = format!("workspace-{workspace_id}");
        if !manager
            .profiles()
            .map_err(to_string)?
            .iter()
            .any(|profile| profile.id == profile_id)
        {
            match manager.create_profile(
                profile_id.clone(),
                ProfileKind::Workspace,
                Some(workspace_id.clone()),
            ) {
                Ok(_) => {}
                Err(error) if error.code == BrowserErrorCode::Conflict => {}
                Err(error) => return Err(to_string(error)),
            }
        }
        let existing = manager
            .pages()
            .map_err(to_string)?
            .into_iter()
            .filter(|page| page.workspace_id == workspace_id)
            .collect::<Vec<_>>();
        if existing.is_empty() {
            let page = match manager.create_page(
                format!("workspace-home-{workspace_id}"),
                workspace_id.clone(),
                &profile_id,
                hidden_bounds(),
            ) {
                Ok(page) => page,
                Err(error) if error.code == BrowserErrorCode::Conflict => {
                    return browser_projection(&manager, &workspace_id)
                }
                Err(error) => return Err(to_string(error)),
            };
            manager.set_visible(&page.id, false).map_err(to_string)?;
        }
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
        manager.save_state().map_err(to_string)?;
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
        let page = manager
            .create_page(
                Uuid::new_v4().to_string(),
                workspace_id.clone(),
                &profile_id,
                hidden_bounds(),
            )
            .map_err(to_string)?;
        manager
            .select_page(&workspace_id, &page.id)
            .map_err(to_string)?;
        let page = manager.page(&page.id).map_err(to_string)?;
        manager.save_state().map_err(to_string)?;
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
pub async fn browser_select_tab(
    manager: State<'_, ManagedBrowser>,
    workspace_id: String,
    page_id: String,
) -> Result<Vec<BrowserPage>, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager
            .select_page(&workspace_id, &page_id)
            .map_err(to_string)
    })
    .await
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
) -> Result<BrowserPage, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        if let Some(bounds) = bounds {
            manager.set_bounds(&page_id, bounds).map_err(to_string)?;
        }
        let page = manager.set_visible(&page_id, visible).map_err(to_string)?;
        if visible {
            manager.set_focus(&page_id, true).map_err(to_string)
        } else {
            Ok(page)
        }
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
) -> Result<BrowserProjection, String> {
    let manager = manager.inner().clone();
    off_main(move || {
        manager.close_page(&page_id).map_err(to_string)?;
        browser_projection(&manager, &workspace_id)
    })
    .await
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
                    if dependencies.iter().any(|name| *name == "next") {
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
                    if dependencies.iter().any(|name| *name == "@angular/core") {
                        candidates
                            .entry(4200)
                            .or_insert_with(|| ("Angular".into(), "package.json".into()));
                    }
                    if dependencies.iter().any(|name| *name == "astro") {
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
    manager: &BrowserManager<NativeBrowserProvider>,
    workspace_id: &str,
) -> Result<BrowserProjection, String> {
    manager.sync_provider_events().map_err(to_string)?;
    manager.save_state().map_err(to_string)?;
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
            .lifecycle_events_since(0)
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
}

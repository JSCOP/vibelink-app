#[path = "../src/browser/mod.rs"]
mod browser;

use browser::{
    BrowserAnnotationInput, BrowserCookieImportInput, BrowserCookieImportResult,
    BrowserDeviceMetrics, BrowserDialogKind, BrowserErrorCode, BrowserFrame, BrowserLifecycleEvent,
    BrowserLifecycleEventKind, BrowserManager, BrowserPolicy, BrowserProvider, BrowserResult,
    CertificateDecision, ChildWebViewCreate, ChildWebViewState, PermissionDecision, PhysicalBounds,
    ProfileKind, RecoveryCandidate, SnapshotNodeInput, SnapshotSource,
};
use std::{
    collections::HashMap,
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Barrier, Mutex,
    },
    thread,
    time::Duration,
};
use uuid::Uuid;

#[derive(Default)]
struct ContractProvider {
    surfaces: Mutex<HashMap<String, ChildWebViewState>>,
    device_metrics: Mutex<HashMap<String, BrowserDeviceMetrics>>,
    events: Mutex<Vec<BrowserLifecycleEvent>>,
    navigation_count: AtomicUsize,
    capture_count: AtomicUsize,
    permission_resolutions: Mutex<Vec<(String, PermissionDecision)>>,
    certificate_resolutions: Mutex<Vec<(String, CertificateDecision)>>,
    dialog_resolutions: Mutex<Vec<(String, bool)>>,
    cookie_import_result: Mutex<Option<BrowserResult<BrowserCookieImportResult>>>,
    active_mutations: AtomicUsize,
    max_active_mutations: AtomicUsize,
}

impl ContractProvider {
    fn has_page(&self, page_id: &str) -> bool {
        self.surfaces.lock().unwrap().contains_key(page_id)
    }

    fn enter_mutation(&self) -> MutationGuard<'_> {
        let active = self.active_mutations.fetch_add(1, Ordering::SeqCst) + 1;
        self.max_active_mutations
            .fetch_max(active, Ordering::SeqCst);
        MutationGuard { provider: self }
    }
}

struct MutationGuard<'a> {
    provider: &'a ContractProvider,
}

impl Drop for MutationGuard<'_> {
    fn drop(&mut self) {
        self.provider
            .active_mutations
            .fetch_sub(1, Ordering::SeqCst);
    }
}

impl BrowserProvider for ContractProvider {
    fn create_child_webview(&self, request: &ChildWebViewCreate) -> BrowserResult<()> {
        assert!(request.external_guest);
        assert!(!request.workspace_id.is_empty());
        assert!(!request.tauri_ipc_allowed);
        assert!(!request.app_initialization_allowed);
        self.surfaces.lock().unwrap().insert(
            request.page_id.clone(),
            ChildWebViewState {
                page_id: request.page_id.clone(),
                bounds: request.bounds,
                visible: true,
                focused: false,
                realized: true,
            },
        );
        Ok(())
    }

    fn set_bounds(&self, page_id: &str, bounds: PhysicalBounds) -> BrowserResult<()> {
        let _guard = self.enter_mutation();
        thread::sleep(Duration::from_millis(10));
        self.surfaces
            .lock()
            .unwrap()
            .get_mut(page_id)
            .unwrap()
            .bounds = bounds;
        Ok(())
    }

    fn set_visible(&self, page_id: &str, visible: bool) -> BrowserResult<()> {
        self.surfaces
            .lock()
            .unwrap()
            .get_mut(page_id)
            .unwrap()
            .visible = visible;
        Ok(())
    }

    fn set_focus(&self, page_id: &str, focused: bool) -> BrowserResult<()> {
        self.surfaces
            .lock()
            .unwrap()
            .get_mut(page_id)
            .unwrap()
            .focused = focused;
        Ok(())
    }

    fn navigate(
        &self,
        _page_id: &str,
        _url: &str,
        _navigation_generation: u64,
    ) -> BrowserResult<()> {
        let _guard = self.enter_mutation();
        self.navigation_count.fetch_add(1, Ordering::SeqCst);
        thread::sleep(Duration::from_millis(10));
        Ok(())
    }

    fn set_device_metrics(
        &self,
        page_id: &str,
        metrics: BrowserDeviceMetrics,
    ) -> BrowserResult<()> {
        self.device_metrics
            .lock()
            .unwrap()
            .insert(page_id.to_string(), metrics);
        Ok(())
    }

    fn clear_device_metrics(&self, page_id: &str) -> BrowserResult<()> {
        self.device_metrics.lock().unwrap().remove(page_id);
        Ok(())
    }
    fn drain_events(&self) -> BrowserResult<Vec<BrowserLifecycleEvent>> {
        Ok(self.events.lock().unwrap().drain(..).collect())
    }
    fn capture_frame(
        &self,
        page_id: &str,
        sequence: u64,
        navigation_generation: u64,
    ) -> BrowserResult<BrowserFrame> {
        self.capture_count.fetch_add(1, Ordering::SeqCst);
        Ok(BrowserFrame {
            page_id: page_id.to_string(),
            sequence,
            navigation_generation,
            width: 1,
            height: 1,
            format: "png".to_string(),
            bytes: vec![137, 80, 78, 71],
            captured_at_ms: 1,
        })
    }
    fn capture_crop(&self, _page_id: &str, _bounds: PhysicalBounds) -> BrowserResult<Vec<u8>> {
        Ok(vec![137, 80, 78, 71])
    }
    fn import_cookies(
        &self,
        _input: &BrowserCookieImportInput,
    ) -> BrowserResult<BrowserCookieImportResult> {
        self.cookie_import_result
            .lock()
            .unwrap()
            .clone()
            .unwrap_or_else(|| Err(browser::BrowserError::unsupported("import_cookies")))
    }
    fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> BrowserResult<()> {
        self.permission_resolutions
            .lock()
            .unwrap()
            .push((request_id.to_string(), decision));
        Ok(())
    }

    fn resolve_certificate(
        &self,
        request_id: &str,
        decision: CertificateDecision,
    ) -> BrowserResult<()> {
        self.certificate_resolutions
            .lock()
            .unwrap()
            .push((request_id.to_string(), decision));
        Ok(())
    }

    fn resolve_dialog(&self, request_id: &str, accept: bool) -> BrowserResult<()> {
        self.dialog_resolutions
            .lock()
            .unwrap()
            .push((request_id.to_string(), accept));
        Ok(())
    }

    fn close(&self, page_id: &str) -> BrowserResult<()> {
        self.surfaces.lock().unwrap().remove(page_id);
        Ok(())
    }

    fn state(&self, page_id: &str) -> BrowserResult<ChildWebViewState> {
        self.surfaces
            .lock()
            .unwrap()
            .get(page_id)
            .cloned()
            .ok_or_else(|| browser::BrowserError::not_found(page_id))
    }
}

fn bounds() -> PhysicalBounds {
    PhysicalBounds {
        x: 10,
        y: 20,
        width: 1200,
        height: 800,
        scale_factor_milli: 1500,
    }
}

fn manager() -> (
    Arc<BrowserManager<ContractProvider>>,
    Arc<ContractProvider>,
    PathBuf,
) {
    let root = std::env::temp_dir().join(format!("vibelink-browser-test-{}", Uuid::new_v4()));
    let downloads = root.join("downloads");
    let artifacts = root.join("artifacts");
    fs::create_dir_all(&downloads).unwrap();
    fs::create_dir_all(&artifacts).unwrap();
    let policy = BrowserPolicy::new(false, vec![], downloads, artifacts, 1024).unwrap();
    let provider = Arc::new(ContractProvider::default());
    let manager = Arc::new(BrowserManager::new(
        provider.clone(),
        policy,
        root.join("profiles"),
    ));
    (manager, provider, root)
}

fn node(backend_dom_id: u64, role: &str, name: &str) -> SnapshotNodeInput {
    SnapshotNodeInput {
        role: role.to_string(),
        name: name.to_string(),
        backend_dom_id,
        frame_id: "frame-main".to_string(),
        session_id: "session-main".to_string(),
        bounds: Some(bounds()),
        supported_actions: vec!["click".to_string()],
        source: SnapshotSource::Accessibility,
    }
}

fn candidate(
    backend_dom_id: u64,
    role: &str,
    name: &str,
    duplicate_ordinal: u32,
) -> RecoveryCandidate {
    RecoveryCandidate {
        role: role.to_string(),
        name: name.to_string(),
        duplicate_ordinal,
        backend_dom_id,
        frame_id: "frame-main".to_string(),
        session_id: "session-main".to_string(),
    }
}

#[test]
fn profiles_are_isolated_and_workspace_cleanup_closes_owned_pages() {
    let (manager, provider, root) = manager();
    let default = manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    let workspace = manager
        .create_profile(
            "workspace-a",
            ProfileKind::Workspace,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    let incognito = manager
        .create_profile(
            "private-a",
            ProfileKind::Incognito,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    let imported = manager
        .create_profile(
            "imported-a",
            ProfileKind::Imported,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    assert_ne!(default.user_data_dir, workspace.user_data_dir);
    assert_ne!(workspace.user_data_dir, imported.user_data_dir);
    assert!(imported
        .user_data_dir
        .as_ref()
        .is_some_and(|path| path.starts_with(&root)));
    assert!(!imported.cookie_import_quarantined);
    assert!(incognito.user_data_dir.is_none());
    fs::create_dir_all(workspace.user_data_dir.as_ref().unwrap()).unwrap();
    fs::create_dir_all(imported.user_data_dir.as_ref().unwrap()).unwrap();

    manager
        .create_page("page-default", "workspace-a", "default", bounds())
        .unwrap();
    manager
        .create_page("page-workspace", "workspace-a", "workspace-a", bounds())
        .unwrap();
    manager
        .create_page("page-private", "workspace-a", "private-a", bounds())
        .unwrap();
    let denied = manager
        .create_page("wrong-workspace", "workspace-b", "workspace-a", bounds())
        .unwrap_err();
    assert_eq!(denied.code, BrowserErrorCode::DeniedCapability);

    manager.set_visible("page-default", true).unwrap();
    manager.set_visible("page-workspace", true).unwrap();
    assert!(provider.state("page-default").unwrap().visible);
    assert!(provider.state("page-workspace").unwrap().visible);

    manager.select_page("workspace-a", "page-private").unwrap();
    assert!(!provider.state("page-default").unwrap().visible);
    assert!(!provider.state("page-workspace").unwrap().visible);
    assert!(provider.state("page-private").unwrap().visible);
    assert!(provider.state("page-private").unwrap().focused);

    manager.save_state().unwrap();
    manager.cleanup_workspace("workspace-a").unwrap();
    assert!(manager.pages().unwrap().is_empty());
    assert!(!provider.has_page("page-default"));
    assert!(!provider.has_page("page-workspace"));
    assert!(!provider.has_page("page-private"));
    assert_eq!(
        manager
            .profiles()
            .unwrap()
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>(),
        vec!["default"]
    );
    assert!(!workspace.user_data_dir.as_ref().unwrap().exists());
    assert!(!imported.user_data_dir.as_ref().unwrap().exists());
    let restarted = BrowserManager::new(
        Arc::new(ContractProvider::default()),
        BrowserPolicy::new(
            false,
            vec![],
            root.join("downloads"),
            root.join("artifacts"),
            1024,
        )
        .unwrap(),
        root.join("profiles"),
    );
    assert_eq!(
        restarted
            .profiles()
            .unwrap()
            .iter()
            .map(|profile| profile.id.as_str())
            .collect::<Vec<_>>(),
        vec!["default"]
    );
    assert!(restarted
        .restore_workspace("workspace-a", bounds())
        .unwrap()
        .is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn profile_storage_rejects_chrome_and_edge_user_data_roots() {
    for browser_root in [
        PathBuf::from("C:/Users/test/AppData/Local/Google/Chrome/User Data/VibeLink"),
        PathBuf::from("C:/Users/test/AppData/Local/Microsoft/Edge/User Data/VibeLink"),
    ] {
        let root =
            std::env::temp_dir().join(format!("vibelink-browser-path-test-{}", Uuid::new_v4()));
        let downloads = root.join("downloads");
        let artifacts = root.join("artifacts");
        fs::create_dir_all(&downloads).unwrap();
        fs::create_dir_all(&artifacts).unwrap();
        let policy = BrowserPolicy::new(false, vec![], downloads, artifacts, 1024).unwrap();
        let manager =
            BrowserManager::new(Arc::new(ContractProvider::default()), policy, browser_root);
        let error = manager
            .create_profile("rejected", ProfileKind::Persistent, None)
            .unwrap_err();
        assert_eq!(error.code, BrowserErrorCode::DeniedCapability);
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn cookie_import_crash_marker_restores_the_profile_quarantined() {
    let (manager, provider, root) = manager();
    manager
        .create_profile(
            "imported-a",
            ProfileKind::Imported,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "imported-a", bounds())
        .unwrap();
    *provider.cookie_import_result.lock().unwrap() = Some(Err(browser::BrowserError::new(
        BrowserErrorCode::RuntimeUnavailable,
        "simulated crash after mutation began",
    )));
    let input = BrowserCookieImportInput {
        workspace_id: "workspace-a".to_string(),
        page_id: "page-a".to_string(),
        profile_id: "imported-a".to_string(),
        endpoint: "http://127.0.0.1:9222".to_string(),
        origins: vec!["https://example.test".to_string()],
        consent: true,
    };
    assert_eq!(
        manager.import_cookies(input).unwrap_err().code,
        BrowserErrorCode::RuntimeUnavailable
    );
    assert!(
        manager
            .profiles()
            .unwrap()
            .iter()
            .find(|profile| profile.id == "imported-a")
            .unwrap()
            .cookie_import_quarantined
    );

    let restarted = BrowserManager::new(
        Arc::new(ContractProvider::default()),
        BrowserPolicy::new(
            false,
            vec![],
            root.join("downloads"),
            root.join("artifacts"),
            1024,
        )
        .unwrap(),
        root.join("profiles"),
    );
    assert!(
        restarted
            .profiles()
            .unwrap()
            .iter()
            .find(|profile| profile.id == "imported-a")
            .unwrap()
            .cookie_import_quarantined
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn hash_proven_cookie_rollback_clears_the_durable_marker() {
    let (manager, provider, root) = manager();
    manager
        .create_profile(
            "imported-a",
            ProfileKind::Imported,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "imported-a", bounds())
        .unwrap();
    *provider.cookie_import_result.lock().unwrap() = Some(Ok(BrowserCookieImportResult {
        imported_count: 0,
        origin_count: 1,
        verified: false,
        rolled_back: true,
        quarantined: false,
    }));
    let result = manager
        .import_cookies(BrowserCookieImportInput {
            workspace_id: "workspace-a".to_string(),
            page_id: "page-a".to_string(),
            profile_id: "imported-a".to_string(),
            endpoint: "http://127.0.0.1:9222".to_string(),
            origins: vec!["https://example.test".to_string()],
            consent: true,
        })
        .unwrap();
    assert!(result.rolled_back);
    assert!(
        !manager
            .profiles()
            .unwrap()
            .iter()
            .find(|profile| profile.id == "imported-a")
            .unwrap()
            .cookie_import_quarantined
    );
    let restarted = BrowserManager::new(
        Arc::new(ContractProvider::default()),
        BrowserPolicy::new(
            false,
            vec![],
            root.join("downloads"),
            root.join("artifacts"),
            1024,
        )
        .unwrap(),
        root.join("profiles"),
    );
    assert!(
        !restarted
            .profiles()
            .unwrap()
            .iter()
            .find(|profile| profile.id == "imported-a")
            .unwrap()
            .cookie_import_quarantined
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn unsafe_schemes_are_denied_before_native_navigation() {
    let (manager, provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();
    let error = manager
        .navigate("page-a", "javascript:alert(document.cookie)")
        .unwrap_err();
    assert_eq!(error.code, BrowserErrorCode::UnsafeUrl);
    assert_eq!(provider.navigation_count.load(Ordering::SeqCst), 0);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn navigation_stale_refs_never_recover_and_backend_recovery_must_be_unique() {
    let (manager, provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();
    let page = manager.navigate("page-a", "https://example.test").unwrap();
    let snapshot = manager
        .record_snapshot(
            "page-a",
            page.navigation_generation,
            vec![node(10, "button", "Save")],
        )
        .unwrap();
    let browser_ref = snapshot.nodes[0].browser_ref.clone();

    let recovered = manager
        .resolve_ref(
            "page-a",
            page.navigation_generation,
            &snapshot.snapshot_id,
            &browser_ref,
            &[candidate(20, "button", "Save", 0)],
        )
        .unwrap();
    assert!(recovered.recovered);
    assert_eq!(recovered.backend_dom_id, 20);

    let next_snapshot = manager
        .record_snapshot(
            "page-a",
            page.navigation_generation,
            vec![node(30, "button", "Delete")],
        )
        .unwrap();
    let ambiguous = manager
        .resolve_ref(
            "page-a",
            page.navigation_generation,
            &next_snapshot.snapshot_id,
            &next_snapshot.nodes[0].browser_ref,
            &[
                candidate(31, "button", "Delete", 0),
                candidate(32, "button", "Delete", 0),
            ],
        )
        .unwrap_err();
    assert_eq!(ambiguous.code, BrowserErrorCode::StaleRef);

    let in_flight = manager
        .navigate("page-a", "https://example.test/next")
        .unwrap_err();
    assert_eq!(in_flight.code, BrowserErrorCode::Conflict);
    provider.events.lock().unwrap().push(BrowserLifecycleEvent {
        sequence: 1,
        page_id: "page-a".to_string(),
        navigation_generation: page.navigation_generation,
        kind: BrowserLifecycleEventKind::NavigationFinished,
        url: Some(page.url.clone()),
        detail: None,
        timestamp_ms: 1,
    });
    let completion = manager.sync_provider_events().unwrap();
    assert_eq!(completion.len(), 1);
    assert_eq!(
        completion[0].kind,
        BrowserLifecycleEventKind::NavigationFinished
    );

    let navigated = manager
        .navigate("page-a", "https://example.test/next")
        .unwrap();
    let stale = manager
        .resolve_ref(
            "page-a",
            page.navigation_generation,
            &snapshot.snapshot_id,
            &browser_ref,
            &[candidate(40, "button", "Save", 0)],
        )
        .unwrap_err();
    assert_eq!(
        navigated.navigation_generation,
        page.navigation_generation + 1
    );
    assert_eq!(stale.code, BrowserErrorCode::StaleRef);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn visibility_leases_reveal_hidden_pages_and_cleanup_without_stale_visibility() {
    let (manager, provider, root) = manager();
    manager
        .create_profile(
            "workspace-a",
            ProfileKind::Workspace,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "workspace-a", bounds())
        .unwrap();
    manager.set_visible("page-a", false).unwrap();
    assert!(!provider.state("page-a").unwrap().visible);

    let first = manager
        .acquire_visibility_lease("page-a", "screenshot")
        .unwrap();
    let second = manager
        .acquire_visibility_lease("page-a", "automation")
        .unwrap();
    assert!(provider.state("page-a").unwrap().visible);
    assert_eq!(manager.page("page-a").unwrap().visibility_lease_count, 2);
    manager.release_visibility_lease("page-a", &first).unwrap();
    assert!(provider.state("page-a").unwrap().visible);
    manager.release_visibility_lease("page-a", &second).unwrap();
    assert!(!provider.state("page-a").unwrap().visible);

    manager
        .acquire_visibility_lease("page-a", "capture")
        .unwrap();
    manager.cleanup_workspace("workspace-a").unwrap();
    assert!(!provider.has_page("page-a"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn surface_owner_generations_reject_stale_unmount_updates() {
    let (manager, provider, root) = manager();
    manager
        .create_profile(
            "workspace-a",
            ProfileKind::Workspace,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "workspace-a", bounds())
        .unwrap();

    manager
        .set_surface("page-a", 10, Some(bounds()), true, true)
        .unwrap();
    manager
        .set_surface(
            "page-a",
            11,
            Some(PhysicalBounds {
                width: 900,
                ..bounds()
            }),
            true,
            true,
        )
        .unwrap();
    assert_eq!(
        manager
            .set_surface("page-a", 10, None, false, false)
            .unwrap_err()
            .code,
        BrowserErrorCode::Conflict
    );
    let surface = provider.state("page-a").unwrap();
    assert!(surface.visible);
    assert!(surface.focused);
    assert_eq!(surface.bounds.width, 900);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn mutations_are_serialized_per_tab() {
    let (manager, provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();

    let first = {
        let manager = manager.clone();
        thread::spawn(move || manager.navigate("page-a", "https://one.test").unwrap())
    };
    let second = {
        let manager = manager.clone();
        thread::spawn(move || {
            manager
                .set_bounds(
                    "page-a",
                    PhysicalBounds {
                        width: 900,
                        ..bounds()
                    },
                )
                .unwrap()
        })
    };
    first.join().unwrap();
    second.join().unwrap();
    assert_eq!(provider.max_active_mutations.load(Ordering::SeqCst), 1);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_files_downloads_and_artifacts_stay_inside_bounded_policy_roots() {
    let root = std::env::temp_dir().join(format!("vibelink-browser-policy-{}", Uuid::new_v4()));
    let downloads = root.join("downloads");
    let artifacts = root.join("artifacts");
    fs::create_dir_all(&downloads).unwrap();
    fs::create_dir_all(&artifacts).unwrap();
    let artifact = artifacts.join("capture.png");
    fs::write(&artifact, vec![7u8; 2_048]).unwrap();
    let policy = BrowserPolicy::new(false, vec![], downloads.clone(), artifacts, 1_024).unwrap();

    let local_error = policy
        .normalize_navigation(root.to_string_lossy().as_ref())
        .unwrap_err();
    assert_eq!(local_error.code, BrowserErrorCode::LocalFileDenied);
    let first = policy.reserve_download("report.txt").unwrap();
    let second = policy.reserve_download("report.txt").unwrap();
    assert_eq!(first.file_name, "report.txt");
    assert_eq!(second.file_name, "report (1).txt");
    assert_eq!(
        policy.reserve_download("../escape.txt").unwrap_err().code,
        BrowserErrorCode::DownloadDenied
    );
    assert_eq!(
        policy.reserve_download("NUL.txt").unwrap_err().code,
        BrowserErrorCode::DownloadDenied
    );

    let descriptor = policy
        .describe_artifact(&artifact, "image/png", 99_999)
        .unwrap();
    assert_eq!(descriptor.bytes, 1_024);
    assert!(descriptor.truncated);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn permission_and_certificate_prompts_are_queued_resolved_and_cleaned_with_pages() {
    let (manager, provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();
    let permission = manager
        .queue_permission("page-a", "https://example.test", "geolocation")
        .unwrap();
    let certificate = manager
        .queue_certificate("page-a", "https://example.test", "CERT_DATE_INVALID")
        .unwrap();
    let dialog = manager
        .queue_dialog(
            "page-a",
            "https://example.test",
            BrowserDialogKind::Confirm,
            "Continue?",
            None,
        )
        .unwrap();
    assert_eq!(
        manager.pending_permissions().unwrap(),
        vec![permission.clone()]
    );
    assert_eq!(
        manager.pending_certificates().unwrap(),
        vec![certificate.clone()]
    );
    assert_eq!(
        manager
            .resolve_permission(&permission.id, PermissionDecision::Deny)
            .unwrap(),
        (permission.clone(), PermissionDecision::Deny),
    );
    assert_eq!(
        manager
            .resolve_certificate(&certificate.id, CertificateDecision::Deny)
            .unwrap(),
        (certificate.clone(), CertificateDecision::Deny),
    );
    assert_eq!(
        manager.resolve_dialog(&dialog.id, true).unwrap(),
        dialog.clone()
    );
    assert_eq!(
        *provider.permission_resolutions.lock().unwrap(),
        vec![(permission.id.clone(), PermissionDecision::Deny)],
    );
    assert_eq!(
        *provider.certificate_resolutions.lock().unwrap(),
        vec![(certificate.id.clone(), CertificateDecision::Deny)],
    );
    assert_eq!(
        *provider.dialog_resolutions.lock().unwrap(),
        vec![(dialog.id.clone(), true)],
    );

    manager
        .queue_permission("page-a", "https://example.test", "notifications")
        .unwrap();
    manager
        .queue_certificate("page-a", "https://example.test", "CERT_AUTHORITY_INVALID")
        .unwrap();
    manager.close_page("page-a").unwrap();
    assert!(manager.pending_permissions().unwrap().is_empty());
    assert!(manager.pending_certificates().unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn capture_page_requests_a_provider_frame_and_queues_it() {
    let (manager, provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    let page = manager
        .create_page("capture-native", "workspace-a", "default", bounds())
        .unwrap();

    let status = manager.capture_page(&page.id).unwrap();
    assert_eq!(provider.capture_count.load(Ordering::SeqCst), 1);
    assert_eq!(status.pending_frames, 1);
    assert_eq!(status.latest_sequence, Some(1));
    let frame = manager.take_latest_frame(&page.id).unwrap().unwrap();
    assert_eq!(frame.bytes, vec![137, 80, 78, 71]);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn expired_capture_artifacts_are_swept_only_from_the_managed_root() {
    let (manager, _provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();
    let descriptor = manager.capture_crop("page-a", bounds()).unwrap();
    let artifact_name = descriptor.path.file_name().unwrap().to_string_lossy();
    let descriptor_path = descriptor
        .path
        .with_file_name(artifact_name.replace(".png", ".artifact.json"));
    let mut record: serde_json::Value =
        serde_json::from_slice(&fs::read(&descriptor_path).unwrap()).unwrap();
    record["descriptor"]["expiresAtMs"] = serde_json::json!(0);
    fs::write(&descriptor_path, serde_json::to_vec(&record).unwrap()).unwrap();

    let repository = root.join("repository");
    fs::create_dir_all(&repository).unwrap();
    let repository_file = repository.join(artifact_name.as_ref());
    fs::write(&repository_file, b"repository-owned").unwrap();

    assert_eq!(manager.cleanup_expired_artifacts().unwrap(), 1);
    assert!(!descriptor.path.exists());
    assert!(!descriptor_path.exists());
    assert_eq!(fs::read(repository_file).unwrap(), b"repository-owned");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn capture_queue_is_latest_frame_wins_bounded_and_generation_fenced() {
    let (manager, _provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();
    let generation = manager
        .navigate("page-a", "https://example.test")
        .unwrap()
        .navigation_generation;
    for sequence in 1..=3 {
        manager
            .push_frame(BrowserFrame {
                page_id: "page-a".to_string(),
                sequence,
                navigation_generation: generation,
                width: 320,
                height: 180,
                format: "png".to_string(),
                bytes: vec![sequence as u8; 32],
                captured_at_ms: sequence,
            })
            .unwrap();
    }
    let status = manager.capture_state("page-a").unwrap();
    assert_eq!(status.pending_frames, 2);
    assert_eq!(status.dropped_frames, 1);
    assert_eq!(status.latest_sequence, Some(3));
    assert_eq!(
        manager
            .take_latest_frame("page-a")
            .unwrap()
            .unwrap()
            .sequence,
        3
    );
    assert_eq!(manager.capture_state("page-a").unwrap().dropped_frames, 2);

    let stale = manager
        .push_frame(BrowserFrame {
            page_id: "page-a".to_string(),
            sequence: 4,
            navigation_generation: generation.saturating_sub(1),
            width: 320,
            height: 180,
            format: "png".to_string(),
            bytes: vec![1],
            captured_at_ms: 4,
        })
        .unwrap_err();
    assert_eq!(stale.code, BrowserErrorCode::StaleRef);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn lifecycle_events_are_ordered_and_device_restore_is_explicit() {
    let (manager, provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();
    let page = manager.navigate("page-a", "https://example.test").unwrap();
    manager
        .queue_permission("page-a", "https://example.test", "geolocation")
        .unwrap();
    manager
        .queue_certificate("page-a", "https://example.test", "CERT_DATE_INVALID")
        .unwrap();
    manager
        .queue_dialog(
            "page-a",
            "https://example.test",
            BrowserDialogKind::Confirm,
            "Continue?",
            None,
        )
        .unwrap();
    let metrics = BrowserDeviceMetrics {
        width: 390,
        height: 844,
        device_scale_factor: 3.0,
        mobile: true,
    };
    assert_eq!(
        manager
            .set_device_metrics("page-a", metrics)
            .unwrap()
            .device_metrics,
        Some(metrics)
    );
    assert_eq!(
        provider.device_metrics.lock().unwrap().get("page-a"),
        Some(&metrics)
    );
    assert_eq!(
        manager
            .clear_device_metrics("page-a")
            .unwrap()
            .device_metrics,
        None
    );
    assert!(!provider
        .device_metrics
        .lock()
        .unwrap()
        .contains_key("page-a"));
    manager.close_page("page-a").unwrap();

    let events = manager.lifecycle_events_since(0).unwrap();
    assert!(events
        .windows(2)
        .all(|pair| pair[0].sequence < pair[1].sequence));
    assert!(events
        .iter()
        .any(|event| event.kind == BrowserLifecycleEventKind::PageCreated));
    assert!(events.iter().any(
        |event| event.kind == BrowserLifecycleEventKind::NavigationStarted
            && event.navigation_generation == page.navigation_generation
    ));
    assert!(events
        .iter()
        .any(|event| event.kind == BrowserLifecycleEventKind::PermissionRequested));
    assert!(events
        .iter()
        .any(|event| event.kind == BrowserLifecycleEventKind::CertificateError));
    assert!(events
        .iter()
        .any(|event| event.kind == BrowserLifecycleEventKind::DialogRequested));
    assert!(events
        .iter()
        .any(|event| event.kind == BrowserLifecycleEventKind::DeviceMetricsChanged));
    assert!(events
        .iter()
        .any(|event| event.kind == BrowserLifecycleEventKind::PageClosed));
    assert!(manager.pending_dialogs().unwrap().is_empty());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_prompt_events_preserve_request_identity_and_dialog_metadata() {
    let (manager, provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();
    let details = [
        (
            BrowserLifecycleEventKind::PermissionRequested,
            serde_json::json!({ "requestId": "native-permission", "permission": "camera" }),
        ),
        (
            BrowserLifecycleEventKind::CertificateError,
            serde_json::json!({ "requestId": "native-certificate", "errorCode": "CERT_DATE_INVALID" }),
        ),
        (
            BrowserLifecycleEventKind::DialogRequested,
            serde_json::json!({
                "requestId": "native-dialog",
                "kind": "prompt",
                "message": "Name?",
                "defaultText": "VibeLink",
            }),
        ),
    ];
    for (index, (kind, detail)) in details.into_iter().enumerate() {
        provider.events.lock().unwrap().push(BrowserLifecycleEvent {
            sequence: index as u64 + 1,
            page_id: "page-a".to_string(),
            navigation_generation: 0,
            kind,
            url: Some("https://example.test".to_string()),
            detail: Some(detail.to_string()),
            timestamp_ms: index as u64 + 1,
        });
    }

    manager.sync_provider_events().unwrap();
    let permission = manager.pending_permissions().unwrap().remove(0);
    assert_eq!(permission.id, "native-permission");
    assert_eq!(permission.permission, "camera");
    let certificate = manager.pending_certificates().unwrap().remove(0);
    assert_eq!(certificate.id, "native-certificate");
    assert_eq!(certificate.error_code, "CERT_DATE_INVALID");
    let dialog = manager.pending_dialogs().unwrap().remove(0);
    assert_eq!(dialog.id, "native-dialog");
    assert_eq!(dialog.kind, BrowserDialogKind::Prompt);
    assert_eq!(dialog.message, "Name?");
    assert_eq!(dialog.default_text.as_deref(), Some("VibeLink"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn persistent_pages_restore_once_while_incognito_pages_do_not() {
    let root = std::env::temp_dir().join(format!("vibelink-browser-restore-{}", Uuid::new_v4()));
    let downloads = root.join("downloads");
    let artifacts = root.join("artifacts");
    fs::create_dir_all(&downloads).unwrap();
    fs::create_dir_all(&artifacts).unwrap();
    let policy =
        BrowserPolicy::new(false, vec![], downloads.clone(), artifacts.clone(), 1_024).unwrap();
    let first = BrowserManager::new(
        Arc::new(ContractProvider::default()),
        policy,
        root.join("profiles"),
    );
    first
        .create_profile(
            "workspace-a",
            ProfileKind::Workspace,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    first
        .create_profile(
            "private-a",
            ProfileKind::Incognito,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    first
        .create_page("persistent-page", "workspace-a", "workspace-a", bounds())
        .unwrap();
    first
        .create_page("private-page", "workspace-a", "private-a", bounds())
        .unwrap();
    first
        .navigate("persistent-page", "https://restore.test/path")
        .unwrap();
    first.save_state().unwrap();

    let second_provider = Arc::new(ContractProvider::default());
    let second = BrowserManager::new(
        second_provider.clone(),
        BrowserPolicy::new(false, vec![], downloads, artifacts, 1_024).unwrap(),
        root.join("profiles"),
    );
    let restored = second.restore_workspace("workspace-a", bounds()).unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].id, "persistent-page");
    assert_eq!(restored[0].url, "https://restore.test/path");
    assert!(!restored[0].effective_visible);
    assert!(second_provider.has_page("persistent-page"));
    assert!(!second_provider.has_page("private-page"));
    assert_eq!(
        second
            .restore_workspace("workspace-a", bounds())
            .unwrap()
            .len(),
        1
    );
    assert!(second
        .lifecycle_events_since(0)
        .unwrap()
        .iter()
        .any(|event| event.kind == BrowserLifecycleEventKind::Restored));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn concurrent_state_saves_remain_atomic() {
    let root = std::env::temp_dir().join(format!("vibelink-browser-save-race-{}", Uuid::new_v4()));
    let downloads = root.join("downloads");
    let artifacts = root.join("artifacts");
    fs::create_dir_all(&downloads).unwrap();
    fs::create_dir_all(&artifacts).unwrap();
    let manager = Arc::new(BrowserManager::new(
        Arc::new(ContractProvider::default()),
        BrowserPolicy::new(false, vec![], downloads.clone(), artifacts.clone(), 1_024).unwrap(),
        root.join("profiles"),
    ));
    manager
        .create_profile(
            "workspace-a",
            ProfileKind::Workspace,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "workspace-a", bounds())
        .unwrap();

    let concurrency = 16;
    let barrier = Arc::new(Barrier::new(concurrency));
    let workers = (0..concurrency)
        .map(|_| {
            let manager = manager.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                manager.save_state()
            })
        })
        .collect::<Vec<_>>();
    for worker in workers {
        worker.join().unwrap().unwrap();
    }

    let restored = BrowserManager::new(
        Arc::new(ContractProvider::default()),
        BrowserPolicy::new(false, vec![], downloads, artifacts, 1_024).unwrap(),
        root.join("profiles"),
    )
    .restore_workspace("workspace-a", bounds())
    .unwrap();
    assert_eq!(restored.len(), 1);
    assert_eq!(restored[0].id, "page-a");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn provider_lifecycle_events_update_pages_and_ignore_stale_generations() {
    let (manager, provider, root) = manager();
    manager
        .create_profile("default", ProfileKind::Persistent, None)
        .unwrap();
    manager
        .create_page("page-a", "workspace-a", "default", bounds())
        .unwrap();
    let page = manager.navigate("page-a", "https://example.test").unwrap();
    provider.events.lock().unwrap().extend([
        BrowserLifecycleEvent {
            sequence: 1,
            page_id: "page-a".to_string(),
            navigation_generation: page.navigation_generation.saturating_sub(1),
            kind: BrowserLifecycleEventKind::TitleChanged,
            url: None,
            detail: Some("Stale title".to_string()),
            timestamp_ms: 1,
        },
        BrowserLifecycleEvent {
            sequence: 2,
            page_id: "page-a".to_string(),
            navigation_generation: page.navigation_generation,
            kind: BrowserLifecycleEventKind::NavigationFinished,
            url: Some("https://example.test/final".to_string()),
            detail: None,
            timestamp_ms: 2,
        },
        BrowserLifecycleEvent {
            sequence: 3,
            page_id: "page-a".to_string(),
            navigation_generation: page.navigation_generation,
            kind: BrowserLifecycleEventKind::TitleChanged,
            url: None,
            detail: Some("Current title".to_string()),
            timestamp_ms: 3,
        },
        BrowserLifecycleEvent {
            sequence: 4,
            page_id: "page-a".to_string(),
            navigation_generation: page.navigation_generation,
            kind: BrowserLifecycleEventKind::DownloadRequested,
            url: Some("https://example.test/file.zip".to_string()),
            detail: Some(
                root.join("downloads/file.zip")
                    .to_string_lossy()
                    .into_owned(),
            ),
            timestamp_ms: 4,
        },
        BrowserLifecycleEvent {
            sequence: 5,
            page_id: "page-a".to_string(),
            navigation_generation: page.navigation_generation,
            kind: BrowserLifecycleEventKind::DownloadFinished,
            url: Some("https://example.test/file.zip".to_string()),
            detail: Some("completed: file.zip".to_string()),
            timestamp_ms: 5,
        },
    ]);
    let accepted = manager.sync_provider_events().unwrap();
    assert_eq!(accepted.len(), 4);
    assert_eq!(manager.page("page-a").unwrap().title, "Current title");
    assert_eq!(
        manager.page("page-a").unwrap().url,
        "https://example.test/final"
    );
    let downloads = manager.downloads().unwrap();
    assert_eq!(downloads.len(), 1);
    assert_eq!(downloads[0].success, Some(true));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn page_originated_navigation_invalidates_exact_persisted_annotations() {
    let (manager, provider, root) = manager();
    manager
        .create_profile(
            "workspace-a",
            ProfileKind::Workspace,
            Some("workspace-a".to_string()),
        )
        .unwrap();
    let page = manager
        .create_page("page-a", "workspace-a", "workspace-a", bounds())
        .unwrap();
    let input = BrowserAnnotationInput {
        workspace_id: "workspace-a".to_string(),
        page_id: page.id.clone(),
        navigation_generation: page.navigation_generation,
        browser_ref: "button#submit".to_string(),
        accessible_name: "Submit".to_string(),
        dom_ancestry: vec![
            "html".to_string(),
            "body".to_string(),
            "button#submit".to_string(),
        ],
        bounds: bounds(),
        text: "Submit".to_string(),
        attributes: vec![("type".to_string(), "submit".to_string())],
        computed_styles: vec![("display".to_string(), "block".to_string())],
        source_hints: vec!["main form".to_string()],
        comment: "Use this action".to_string(),
    };
    let annotation = manager.create_annotation(input.clone()).unwrap();
    let screenshot = annotation.screenshot.expect("persisted crop");
    let artifact_root = root.join("artifacts");
    let repository_root = root.join("repository");
    assert!(screenshot.path.starts_with(&artifact_root));
    assert!(!screenshot.path.starts_with(&repository_root));
    assert_eq!(fs::read(&screenshot.path).unwrap(), vec![137, 80, 78, 71]);
    assert_eq!(screenshot.content_type, "image/png");
    assert_eq!(screenshot.bytes, 4);
    assert!(!screenshot.truncated);
    let checked_at_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64;
    assert!(screenshot.expires_at_ms > checked_at_ms);
    assert!(screenshot.expires_at_ms.saturating_sub(checked_at_ms) <= 24 * 60 * 60 * 1_000);
    assert!(screenshot.expires_at_ms <= (1_u64 << 53) - 1);

    provider.events.lock().unwrap().push(BrowserLifecycleEvent {
        sequence: 1,
        page_id: page.id.clone(),
        navigation_generation: page.navigation_generation + 1,
        kind: BrowserLifecycleEventKind::NavigationStarted,
        url: Some("https://next.example.test".to_string()),
        detail: None,
        timestamp_ms: 1,
    });
    let accepted = manager.sync_provider_events().unwrap();
    assert_eq!(accepted.len(), 1);
    assert_eq!(
        manager.page(&page.id).unwrap().navigation_generation,
        page.navigation_generation + 1
    );
    assert_eq!(
        manager.create_annotation(input).unwrap_err().code,
        BrowserErrorCode::StaleRef
    );
    fs::remove_dir_all(root).unwrap();
}

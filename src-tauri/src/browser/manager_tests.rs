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
    assert!(state
        .events
        .iter()
        .zip(state.events.iter().skip(1))
        .all(|(left, right)| left.sequence < right.sequence));
}

#[test]
fn download_record_cap_preserves_pending_records() {
    let root =
        std::env::temp_dir().join(format!("vibelink-browser-manager-test-{}", Uuid::new_v4()));
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

    {
        let mut events = lock(&provider.events).unwrap();
        events.extend(
            (1..=MAX_DOWNLOAD_RECORDS as u64).map(|sequence| BrowserLifecycleEvent {
                sequence,
                page_id: "page".to_string(),
                navigation_generation: 0,
                kind: BrowserLifecycleEventKind::DownloadRequested,
                url: Some(format!("https://example.test/{sequence}")),
                detail: Some(format!("download-{sequence}.bin")),
                timestamp_ms: sequence,
            }),
        );
        events.push_back(BrowserLifecycleEvent {
            sequence: MAX_DOWNLOAD_RECORDS as u64 + 1,
            page_id: "page".to_string(),
            navigation_generation: 0,
            kind: BrowserLifecycleEventKind::DownloadRequested,
            url: Some("https://example.test/overflow".to_string()),
            detail: Some("overflow.bin".to_string()),
            timestamp_ms: MAX_DOWNLOAD_RECORDS as u64 + 1,
        });
        events.push_back(BrowserLifecycleEvent {
            sequence: MAX_DOWNLOAD_RECORDS as u64 + 2,
            page_id: "page".to_string(),
            navigation_generation: 0,
            kind: BrowserLifecycleEventKind::DownloadFinished,
            url: Some("https://example.test/1".to_string()),
            detail: Some("completed: download-1.bin".to_string()),
            timestamp_ms: MAX_DOWNLOAD_RECORDS as u64 + 2,
        });
    }

    manager.sync_provider_events().unwrap();
    let downloads = manager.downloads().unwrap();

    assert_eq!(downloads.len(), MAX_DOWNLOAD_RECORDS);
    assert_eq!(downloads.first().unwrap().url, "https://example.test/1");
    assert_eq!(downloads.first().unwrap().success, Some(true));
    assert_eq!(
        downloads.last().unwrap().url,
        format!("https://example.test/{MAX_DOWNLOAD_RECORDS}")
    );
    assert!(downloads
        .iter()
        .all(|download| download.url != "https://example.test/overflow"));

    lock(&provider.events)
        .unwrap()
        .push_back(BrowserLifecycleEvent {
            sequence: MAX_DOWNLOAD_RECORDS as u64 + 3,
            page_id: "page".to_string(),
            navigation_generation: 0,
            kind: BrowserLifecycleEventKind::DownloadRequested,
            url: Some("https://example.test/replacement".to_string()),
            detail: Some("replacement.bin".to_string()),
            timestamp_ms: MAX_DOWNLOAD_RECORDS as u64 + 3,
        });

    manager.sync_provider_events().unwrap();
    let downloads = manager.downloads().unwrap();

    assert_eq!(downloads.len(), MAX_DOWNLOAD_RECORDS);
    assert_eq!(downloads.first().unwrap().url, "https://example.test/2");
    assert_eq!(
        downloads.last().unwrap().url,
        "https://example.test/replacement"
    );
}

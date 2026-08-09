use super::*;

const EXTENSION_ID: &str = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_EXTENSION_ID: &str = "ponmlkjihgfedcbaponmlkjihgfedcba";
/// Synthetic: never a real published id, so the HKCU round trip cannot
/// collide with an extension the user actually has.
const STORE_TEST_ID: &str = "ijklmnopijklmnopijklmnopijklmnop";

fn test_bridge() -> Arc<ExtensionBridge> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("bind ephemeral test port");
    let trust = std::env::temp_dir().join(format!(
        "vibelink-browser-extension-trust-{}.json",
        Uuid::new_v4()
    ));
    ExtensionBridge::start(listener, trust).expect("start test bridge")
}

fn open(
    bridge: &ExtensionBridge,
    origin: Option<&str>,
) -> WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>> {
    use tungstenite::client::IntoClientRequest;
    let mut request = format!("ws://127.0.0.1:{}", bridge.port)
        .into_client_request()
        .expect("build extension request");
    if let Some(origin) = origin {
        request
            .headers_mut()
            .insert("origin", origin.parse().expect("origin header value"));
    }
    let (socket, _) = tungstenite::connect(request).expect("connect test extension");
    socket
}

fn connect(
    bridge: &ExtensionBridge,
    extension_id: &str,
) -> WebSocket<tungstenite::stream::MaybeTlsStream<TcpStream>> {
    let mut socket = open(bridge, Some(&format!("chrome-extension://{extension_id}")));
    socket
        .send(Message::Text(
            json!({
                "v": 1,
                "type": "hello",
                "browser": "chrome",
                "extensionVersion": "1.0.0",
                "userAgent": "test",
            })
            .to_string()
            .into(),
        ))
        .expect("send hello");
    socket
}

fn wait_for_connected(bridge: &ExtensionBridge) {
    let deadline = Instant::now() + Duration::from_secs(1);
    while Instant::now() < deadline {
        if bridge.status().connected {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("extension did not connect");
}

fn wait_for_disconnected(bridge: &ExtensionBridge) {
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if !bridge.status().connected {
            return;
        }
        thread::sleep(Duration::from_millis(5));
    }
    panic!("extension did not disconnect");
}

#[test]
fn list_tabs_round_trip_uses_real_websocket() {
    let bridge = test_bridge();
    let mut socket = connect(&bridge, EXTENSION_ID);
    wait_for_connected(&bridge);

    let caller_bridge = Arc::clone(&bridge);
    let caller = thread::spawn(move || caller_bridge.list_tabs());
    let request = match socket.read().expect("read listTabs request") {
        Message::Text(text) => {
            serde_json::from_str::<Value>(text.as_ref()).expect("parse listTabs request")
        }
        other => panic!("expected text request, got {other:?}"),
    };
    assert_eq!(request["v"], 1);
    assert_eq!(request["op"], "listTabs");
    let id = request["id"].as_u64().expect("request id");

    socket
        .send(Message::Text(
            json!({
                "v": 1,
                "type": "result",
                "id": id,
                "ok": true,
                "result": {
                    "tabs": [{
                        "tabId": 7,
                        "windowId": 3,
                        "url": "https://example.com/",
                        "title": "Example",
                        "active": true,
                        "attached": false,
                    }]
                }
            })
            .to_string()
            .into(),
        ))
        .expect("answer listTabs");

    assert_eq!(
        caller
            .join()
            .expect("join listTabs caller")
            .expect("list tabs"),
        vec![ExtensionTab {
            tab_id: 7,
            window_id: 3,
            url: "https://example.com/".to_string(),
            title: "Example".to_string(),
            active: true,
            attached: false,
        }]
    );
}

#[test]
fn a_page_origin_is_refused_because_only_an_extension_may_drive_the_browser() {
    let bridge = test_bridge();
    for origin in [None, Some("https://evil.example"), Some("null")] {
        let mut socket = open(&bridge, origin);
        assert!(
            matches!(socket.read().expect("read close"), Message::Close(_)),
            "origin {origin:?} must be refused"
        );
    }
    assert!(!bridge.status().connected);
    assert!(bridge.status().trusted_extension_id.is_none());
}

#[test]
fn firefox_and_invalid_chrome_extension_origins_are_refused() {
    let bridge = test_bridge();
    let invalid_id = "abcdefghijklmnopabcdefghijklmnoq";
    for origin in [
        format!("moz-extension://{EXTENSION_ID}"),
        format!("chrome-extension://{invalid_id}"),
        format!("chrome-extension://{EXTENSION_ID}//"),
    ] {
        let mut socket = open(&bridge, Some(&origin));
        assert!(
            matches!(socket.read().expect("read close"), Message::Close(_)),
            "origin {origin} must be refused"
        );
    }
    assert_eq!(
        extension_id_from_origin(&format!("chrome-extension://{EXTENSION_ID}/")).as_deref(),
        Some(EXTENSION_ID)
    );
    assert!(bridge.status().trusted_extension_id.is_none());
}

#[test]
fn a_websocket_handshake_without_hello_does_not_claim_trust() {
    let bridge = test_bridge();
    let _handshake_only = open(
        &bridge,
        Some(&format!("chrome-extension://{EXTENSION_ID}")),
    );
    thread::sleep(Duration::from_millis(20));
    assert!(bridge.status().trusted_extension_id.is_none());

    let _real = connect(&bridge, OTHER_EXTENSION_ID);
    wait_for_connected(&bridge);
    assert_eq!(
        bridge.status().trusted_extension_id.as_deref(),
        Some(OTHER_EXTENSION_ID)
    );
}

#[test]
fn the_first_extension_is_trusted_and_a_second_one_is_refused_until_unpaired() {
    let bridge = test_bridge();
    let _first = connect(&bridge, EXTENSION_ID);
    wait_for_connected(&bridge);
    assert_eq!(
        bridge.status().trusted_extension_id.as_deref(),
        Some(EXTENSION_ID)
    );

    let mut intruder = connect(&bridge, OTHER_EXTENSION_ID);
    assert!(matches!(
        intruder.read().expect("read intruder close"),
        Message::Close(_)
    ));
    assert_eq!(
        bridge.status().rejected_extension_id.as_deref(),
        Some(OTHER_EXTENSION_ID)
    );

    bridge.unpair().expect("unpair");
    assert!(bridge.status().trusted_extension_id.is_none());
    let _second = connect(&bridge, OTHER_EXTENSION_ID);
    wait_for_connected(&bridge);
    assert_eq!(
        bridge.status().trusted_extension_id.as_deref(),
        Some(OTHER_EXTENSION_ID)
    );
}

#[test]
fn a_silent_extension_is_dropped_and_the_slot_can_be_reused() {
    let bridge = test_bridge();
    let _silent = connect(&bridge, EXTENSION_ID);
    wait_for_connected(&bridge);
    wait_for_disconnected(&bridge);

    let _replacement = connect(&bridge, EXTENSION_ID);
    wait_for_connected(&bridge);
}

#[test]
fn the_trusted_extension_survives_a_restart() {
    let path = std::env::temp_dir().join(format!(
        "vibelink-browser-extension-trust-{}.json",
        Uuid::new_v4()
    ));
    write_trust(&path, Some(EXTENSION_ID)).expect("write trust");
    assert_eq!(read_trust(&path).as_deref(), Some(EXTENSION_ID));

    write_trust(&path, None).expect("clear trust");
    assert!(read_trust(&path).is_none());
}

#[test]
fn send_without_extension_is_unavailable() {
    let bridge = test_bridge();
    let error = bridge
        .send(1, "Runtime.evaluate", json!({"expression": "1 + 1"}))
        .expect_err("disconnected send must fail");
    assert!(error.to_string().contains("unavailable"));
}

#[test]
fn event_ring_drops_oldest_and_drain_removes_returned_events() {
    let bridge = test_bridge();
    for sequence in 0..=MAX_EVENTS_PER_TAB {
        bridge.push_event(7, json!({"sequence": sequence}));
    }

    let events = bridge.drain_events(7, usize::MAX);
    assert_eq!(events.len(), MAX_EVENTS_PER_TAB);
    assert_eq!(events[0]["sequence"], 1);
    assert_eq!(
        events[MAX_EVENTS_PER_TAB - 1]["sequence"],
        MAX_EVENTS_PER_TAB
    );
    assert!(bridge.drain_events(7, usize::MAX).is_empty());
}

#[test]
fn event_buffer_preserves_per_tab_order_and_global_byte_eviction() {
    let mut state = BridgeState::default();
    state.push_event(7, MAX_EVENT_BUFFER_BYTES, json!({"sequence": 1}));
    state.push_event(8, 1, json!({"sequence": 2}));
    assert!(state.pop_event(7).is_none());
    assert_eq!(state.pop_event(8).expect("tab 8 event").value["sequence"], 2);

    state.push_event(7, 1, json!({"sequence": 3}));
    state.push_event(8, 1, json!({"sequence": 4}));
    state.push_event(7, 1, json!({"sequence": 5}));
    assert_eq!(state.pop_event(7).expect("first tab 7 event").value["sequence"], 3);
    assert_eq!(state.pop_event(7).expect("second tab 7 event").value["sequence"], 5);
    assert_eq!(state.pop_event(8).expect("tab 8 event").value["sequence"], 4);
}

#[test]
fn install_writes_the_selected_bridge_port() {
    let data_root = std::env::temp_dir().join(format!(
        "vibelink-browser-extension-install-{}",
        Uuid::new_v4()
    ));
    let directory = install_directory(&data_root);
    fs::create_dir_all(&directory).expect("create existing extension directory");
    fs::write(directory.join("bridge-port.json"), r#"{"port": 9332}"#)
        .expect("write release bridge port");
    let installed = install(&data_root, 19_399).expect("install extension");
    assert_eq!(installed.ports, vec![19_399]);
    assert_eq!(
        fs::read_to_string(installed.directory.join("bridge-port.json"))
            .expect("read bridge port"),
        r#"{"port": 19399}"#
    );
    fs::remove_dir_all(data_root).expect("remove installed extension");
}

#[test]
fn store_registration_targets_chrome_external_extension_key() {
    assert_eq!(
        store_registration(STORE_TEST_ID),
        (
            format!("Software\\Google\\Chrome\\Extensions\\{STORE_TEST_ID}"),
            "update_url",
            "https://clients2.google.com/service/update2/crx",
        )
    );
}

#[test]
fn store_extension_id_is_unset_or_a_valid_chrome_id() {
    let Some(id) = STORE_EXTENSION_ID else { return };
    assert_eq!(id.len(), 32, "a Chrome extension id is 32 characters: {id}");
    assert!(
        id.bytes().all(|byte| matches!(byte, b'a'..=b'p')),
        "a Chrome extension id uses only a-p: {id}"
    );
}

/// A per-run id keeps two concurrent `cargo test` processes from deleting
/// each other's key, and the guard removes it even when an assert panics —
/// this test writes to the user's live registry.
#[cfg(windows)]
#[test]
fn store_registration_round_trips_in_hkcu() {
    struct Cleanup(String);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = unregister_store_extension(&self.0);
        }
    }

    let id: String = Uuid::new_v4()
        .simple()
        .to_string()
        .bytes()
        .map(|byte| (b'a' + (byte % 16)) as char)
        .collect();
    let guard = Cleanup(id.clone());
    let (path, name, value) = store_registration(&id);

    assert_eq!(
        register_store_extension(&id).expect("register"),
        format!("HKCU\\{path}")
    );
    let hkcu = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
    let key = hkcu.open_subkey(&path).expect("open the registered key");
    assert_eq!(
        key.get_value::<String, _>(name).expect("read update_url"),
        value
    );
    drop(key);

    unregister_store_extension(&id).expect("unregister");
    assert!(hkcu.open_subkey(&path).is_err(), "the key must be gone");
    unregister_store_extension(&id).expect("unregistering twice is a no-op");
    drop(guard);
}

    use super::*;
    use crate::dedicated_cli::browser_page::inspect;
    use crate::dedicated_cli::browser_page::{
        DEFAULT_MOBILE_DEVICE_SCALE_FACTOR, DEFAULT_MOBILE_VIEWPORT_HEIGHT,
        DEFAULT_MOBILE_VIEWPORT_WIDTH, MAX_KEY_INPUT_BYTES, MAX_PAGE_SCALE, MAX_SCROLL_DELTA,
        MIN_PAGE_SCALE,
    };
    use crate::dedicated_cli::{OperationArguments, SelectorSet};
    use std::collections::BTreeMap;
    use uuid::Uuid;

    fn command(
        action: BrowserAction,
        options: impl IntoIterator<Item = (&'static str, Vec<String>)>,
    ) -> ActionCommand<BrowserAction> {
        ActionCommand {
            action,
            selectors: SelectorSet::default(),
            arguments: OperationArguments {
                options: options
                    .into_iter()
                    .map(|(name, values)| (name.to_string(), values))
                    .collect::<BTreeMap<_, _>>(),
                ..OperationArguments::default()
            },
        }
    }

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("vibelink-browser-cdp-{label}-{}", Uuid::new_v4()))
    }

    #[test]
    fn capture_viewport_metrics_are_bounded() {
        let metrics = json!({
            "cssVisualViewport": { "clientWidth": 390.25, "clientHeight": 844.1 }
        });
        assert_eq!(viewport_dimension(&metrics, "clientWidth").unwrap(), 391);
        assert_eq!(viewport_dimension(&metrics, "clientHeight").unwrap(), 845);
        assert!(viewport_dimension(
            &json!({ "cssVisualViewport": { "clientWidth": 10001.0 } }),
            "clientWidth"
        )
        .is_err());
    }

    #[test]
    fn typed_pointer_inputs_reject_hostile_values() {
        BrowserPointerInput::Tap { x: 12.0, y: 34.0 }
            .validate_for_viewport(390, 844)
            .unwrap();
        BrowserPointerInput::Drag {
            from_x: 1.0,
            from_y: 2.0,
            to_x: 389.0,
            to_y: 843.0,
        }
        .validate_for_viewport(390, 844)
        .unwrap();
        BrowserPointerInput::Scroll {
            x: 10.0,
            y: 20.0,
            delta_x: 0.0,
            delta_y: -120.0,
        }
        .validate_for_viewport(390, 844)
        .unwrap();

        for hostile in [
            BrowserPointerInput::Tap {
                x: f64::NAN,
                y: 0.0,
            },
            BrowserPointerInput::Tap { x: -1.0, y: 0.0 },
            BrowserPointerInput::Drag {
                from_x: 0.0,
                from_y: 0.0,
                to_x: f64::INFINITY,
                to_y: 1.0,
            },
            BrowserPointerInput::Scroll {
                x: 0.0,
                y: 0.0,
                delta_x: MAX_SCROLL_DELTA + 1.0,
                delta_y: 0.0,
            },
            BrowserPointerInput::Scroll {
                x: 0.0,
                y: 0.0,
                delta_x: 0.0,
                delta_y: 0.0,
            },
        ] {
            assert!(hostile.validate().is_err());
        }
        assert!(BrowserPointerInput::Tap { x: 390.0, y: 1.0 }
            .validate_for_viewport(390, 844)
            .is_err());
    }

    #[test]
    fn clicks_emit_matched_press_release_pairs() {
        let (mut cdp, calls) = CdpConnection::scripted(vec![Ok(Value::Null); 6]);

        dispatch_click(&mut cdp, 10.0, 20.0, 1).expect("single click");
        dispatch_click(&mut cdp, 30.0, 40.0, 2).expect("double click");

        let calls = calls.lock().expect("scripted CDP calls");
        let events = calls
            .iter()
            .map(|(_, params)| {
                (
                    params["type"].as_str().unwrap(),
                    params["buttons"].as_u64().unwrap(),
                    params["clickCount"].as_u64().unwrap(),
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            events,
            vec![
                ("mousePressed", 1, 1),
                ("mouseReleased", 0, 1),
                ("mousePressed", 1, 1),
                ("mouseReleased", 0, 1),
                ("mousePressed", 1, 2),
                ("mouseReleased", 0, 2),
            ]
        );
    }

    #[test]
    fn named_keys_include_codes_modifiers_and_literal_text_uses_insert_text() {
        let (mut cdp, calls) = CdpConnection::scripted(vec![Ok(Value::Null); 3]);

        dispatch_key(&mut cdp, "Ctrl+Shift+P").expect("dispatch named key");
        dispatch_key(&mut cdp, "한").expect("insert literal character");

        let calls = calls.lock().expect("scripted CDP calls");
        assert_eq!(calls[0].0, "Input.dispatchKeyEvent");
        assert_eq!(calls[0].1["type"], "rawKeyDown");
        assert_eq!(calls[0].1["key"], "P");
        assert_eq!(calls[0].1["code"], "KeyP");
        assert_eq!(calls[0].1["windowsVirtualKeyCode"], 80);
        assert_eq!(calls[0].1["modifiers"], 10);
        assert_eq!(calls[1].1["type"], "keyUp");
        assert_eq!(calls[2].0, "Input.insertText");
        assert_eq!(calls[2].1["text"], "한");
    }

    #[test]
    fn key_up_is_attempted_after_key_down_failure() {
        let (mut cdp, calls) = CdpConnection::scripted(vec![
            Err("key down failed".to_string()),
            Ok(Value::Null),
        ]);

        assert!(dispatch_key(&mut cdp, "Enter").is_err());
        let calls = calls.lock().expect("scripted CDP calls");
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[1].1["type"], "keyUp");
    }

    #[test]
    fn drag_attempts_release_after_move_failure() {
        let (mut cdp, calls) = CdpConnection::scripted(vec![
            Ok(Value::Null),
            Err("move failed".to_string()),
            Ok(Value::Null),
        ]);

        let error = dispatch_drag(&mut cdp, 1.0, 2.0, 30.0, 40.0).unwrap_err();
        assert!(error.to_string().contains("move failed"));
        let calls = calls.lock().expect("scripted CDP calls");
        assert_eq!(calls.len(), 3);
        assert_eq!(calls[2].1["type"], "mouseReleased");
        assert_eq!(calls[2].1["buttons"], 0);
    }

    #[test]
    fn viewport_and_page_scale_validation_is_bounded() {
        assert_eq!(
            BrowserViewport::mobile_default().device_metrics().unwrap(),
            Some(BrowserDeviceMetrics {
                width: DEFAULT_MOBILE_VIEWPORT_WIDTH,
                height: DEFAULT_MOBILE_VIEWPORT_HEIGHT,
                device_scale_factor: DEFAULT_MOBILE_DEVICE_SCALE_FACTOR,
                mobile: true,
            })
        );
        assert_eq!(BrowserViewport::Web.device_metrics().unwrap(), None);
        for hostile in [
            BrowserViewport::Mobile {
                width: 0,
                height: 844,
                device_scale_factor: 1.0,
            },
            BrowserViewport::Mobile {
                width: 390,
                height: 10_001,
                device_scale_factor: 1.0,
            },
            BrowserViewport::Mobile {
                width: 390,
                height: 844,
                device_scale_factor: f64::NAN,
            },
        ] {
            assert!(hostile.device_metrics().is_err());
        }

        for scale in [MIN_PAGE_SCALE, 1.0, MAX_PAGE_SCALE] {
            BrowserPageScale {
                scale,
                center_x: None,
                center_y: None,
            }
            .validate()
            .unwrap();
        }
        BrowserPageScale {
            scale: 2.0,
            center_x: Some(195.0),
            center_y: Some(422.0),
        }
        .validate()
        .unwrap();
        for scale in [f64::NAN, 0.0, MIN_PAGE_SCALE - 0.01, MAX_PAGE_SCALE + 0.01] {
            assert!(BrowserPageScale {
                scale,
                center_x: None,
                center_y: None,
            }
            .validate()
            .is_err());
        }
        assert!(BrowserPageScale {
            scale: 2.0,
            center_x: Some(f64::NAN),
            center_y: Some(1.0),
        }
        .validate()
        .is_err());
        assert!(BrowserPageScale {
            scale: 2.0,
            center_x: Some(1.0),
            center_y: None,
        }
        .validate()
        .is_err());
    }

    #[test]
    fn text_and_key_input_validation_is_bounded() {
        BrowserKeyInput::Text {
            text: "한글 text\n".to_string(),
        }
        .validate()
        .unwrap();
        BrowserKeyInput::Key {
            key: "Enter".to_string(),
        }
        .validate()
        .unwrap();

        for hostile in [
            BrowserKeyInput::Text {
                text: String::new(),
            },
            BrowserKeyInput::Text {
                text: "x".repeat(MAX_TEXT_INPUT_BYTES + 1),
            },
            BrowserKeyInput::Text {
                text: "bad\0text".to_string(),
            },
            BrowserKeyInput::Key {
                key: "\n".to_string(),
            },
            BrowserKeyInput::Key {
                key: "x".repeat(MAX_KEY_INPUT_BYTES + 1),
            },
        ] {
            assert!(hostile.validate().is_err());
        }
    }

    #[test]
    fn capture_options_reject_invalid_quality() {
        BrowserJpegCaptureOptions::default().validate().unwrap();
        BrowserJpegCaptureOptions { quality: 1 }.validate().unwrap();
        BrowserJpegCaptureOptions { quality: 100 }
            .validate()
            .unwrap();
        assert!(BrowserJpegCaptureOptions { quality: 0 }.validate().is_err());
        assert!(BrowserJpegCaptureOptions { quality: 101 }
            .validate()
            .is_err());
    }

    #[test]
    fn public_helpers_validate_before_browser_discovery() {
        let missing_registry = temp_root("typed-validation").join("cdp-registry.json");

        assert!(capture_jpeg_for_page(
            &missing_registry,
            "page-a",
            BrowserJpegCaptureOptions { quality: 0 },
        )
        .unwrap_err()
        .to_string()
        .contains("JPEG quality"));
        assert!(dispatch_pointer_for_page(
            &missing_registry,
            "page-a",
            BrowserPointerInput::Tap {
                x: f64::NAN,
                y: 0.0,
            },
        )
        .unwrap_err()
        .to_string()
        .contains("pointer coordinates"));
        assert!(dispatch_key_input_for_page(
            &missing_registry,
            "page-a",
            BrowserKeyInput::Text {
                text: String::new(),
            },
        )
        .unwrap_err()
        .to_string()
        .contains("text input"));
        assert!(inspect(&missing_registry, "page-a", Some(1.0), None)
            .unwrap_err()
            .to_string()
            .contains("requires both"));
        assert!(
            inspect(&missing_registry, "page-a", Some(10_001.0), Some(0.0))
                .unwrap_err()
                .to_string()
                .contains("out of bounds")
        );
        assert!(set_viewport_for_page(
            &missing_registry,
            "page-a",
            BrowserViewport::Mobile {
                width: 0,
                height: 844,
                device_scale_factor: 1.0,
            },
        )
        .unwrap_err()
        .to_string()
        .contains("mobile browser viewport"));
        assert!(set_page_scale_for_page(
            &missing_registry,
            "page-a",
            BrowserPageScale {
                scale: f64::NAN,
                center_x: None,
                center_y: None,
            },
        )
        .unwrap_err()
        .to_string()
        .contains("page scale"));
    }

    #[test]
    fn tab_projection_uses_only_authoritative_registry_annotations() {
        let targets = vec![
            DebugTarget {
                id: "cdp-a".to_string(),
                title: "First".to_string(),
                url: "https://example.test/first".to_string(),
                target_type: "page".to_string(),
                web_socket_debugger_url: None,
                cdp_port: 9334,
                page_id: Some("page-a".to_string()),
                profile_id: Some("profile-a".to_string()),
                workspace_id: Some("workspace-a".to_string()),
                external: false,
                extension_tab_id: None,
            },
            DebugTarget {
                id: "cdp-b".to_string(),
                title: "Second".to_string(),
                url: "https://example.test/second".to_string(),
                target_type: "page".to_string(),
                web_socket_debugger_url: None,
                cdp_port: 9335,
                page_id: Some("page-b".to_string()),
                profile_id: Some("profile-b".to_string()),
                workspace_id: Some("workspace-b".to_string()),
                external: false,
                extension_tab_id: None,
            },
            DebugTarget {
                id: "unregistered-cdp-target".to_string(),
                title: "Application shell".to_string(),
                url: "tauri://localhost".to_string(),
                target_type: "page".to_string(),
                web_socket_debugger_url: None,
                cdp_port: 9333,
                page_id: None,
                profile_id: None,
                workspace_id: None,
                external: false,
                extension_tab_id: None,
            },
        ];

        assert_eq!(
            project_embedded_tabs(&targets, Some("workspace-a")),
            vec![EmbeddedBrowserTab {
                id: "page-a".to_string(),
                title: "First".to_string(),
                url: "https://example.test/first".to_string(),
                workspace_id: "workspace-a".to_string(),
            }]
        );
        assert_eq!(project_embedded_tabs(&targets, None).len(), 2);
    }
    #[test]
    fn risky_actions_are_denied_before_any_cdp_connection() {
        let root = temp_root("risk");
        for action in [
            BrowserAction::Cookies,
            BrowserAction::Storage,
            BrowserAction::Upload,
            BrowserAction::Download,
        ] {
            let error = execute(command(action, []), &root).unwrap_err();
            assert!(error.to_string().contains("requires explicit browser."));
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn upload_paths_require_a_grant_and_canonical_workspace_containment() {
        let root = temp_root("upload");
        let workspace = root.join("workspace");
        let outside = root.join("outside.txt");
        fs::create_dir_all(&workspace).unwrap();
        let inside = workspace.join("inside.txt");
        fs::write(&inside, b"inside").unwrap();
        fs::write(&outside, b"outside").unwrap();
        let access = CdpAccessPolicy::from_command(
            &command(
                BrowserAction::Upload,
                [
                    ("grant", vec!["browser.upload".to_string()]),
                    (
                        "workspace-root",
                        vec![workspace.to_string_lossy().into_owned()],
                    ),
                ],
            ),
            &root.join("artifacts"),
        )
        .unwrap();
        assert_eq!(
            access
                .upload_files(&[inside.to_string_lossy().into_owned()])
                .unwrap(),
            vec![fs::canonicalize(&inside).unwrap()]
        );
        assert!(access
            .upload_files(&[outside.to_string_lossy().into_owned()])
            .unwrap_err()
            .to_string()
            .contains("outside the explicitly granted workspace roots"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn registry_routes_pages_only_to_their_declared_profile() {
        let first = BrowserCdpProfile {
            profile_id: "profile-a".to_string(),
            port: 9334,
            pages: vec![BrowserCdpPage {
                page_id: "page-a".to_string(),
                workspace_id: "workspace-a".to_string(),
            }],
        };
        let second = BrowserCdpProfile {
            profile_id: "profile-b".to_string(),
            port: 9335,
            pages: vec![BrowserCdpPage {
                page_id: "page-b".to_string(),
                workspace_id: "workspace-b".to_string(),
            }],
        };
        validate_registry(&BrowserCdpRegistry {
            version: 2,
            main_port: 9333,
            profiles: vec![first.clone(), second.clone()],
        })
        .unwrap();
        let mut claimed = HashSet::new();
        assert_eq!(
            registered_page_for_name(&first, "vibelink-page:page-a", &mut claimed)
                .map(|page| (page.page_id.as_str(), page.workspace_id.as_str())),
            Some(("page-a", "workspace-a"))
        );
        assert!(registered_page_for_name(&second, "vibelink-page:page-a", &mut claimed).is_none());
        assert_eq!(
            registered_page_for_name(&second, "vibelink-page:page-b", &mut claimed)
                .map(|page| (page.page_id.as_str(), page.workspace_id.as_str())),
            Some(("page-b", "workspace-b"))
        );
        assert_eq!(
            profiles_for_workspace(vec![first, second], Some("workspace-a"))
                .into_iter()
                .map(|profile| profile.profile_id)
                .collect::<Vec<_>>(),
            vec!["profile-a"]
        );
    }

    #[test]
    fn hostile_registry_and_websocket_inputs_fail_closed() {
        let duplicate = BrowserCdpRegistry {
            version: 2,
            main_port: 9333,
            profiles: vec![
                BrowserCdpProfile {
                    profile_id: "a".to_string(),
                    port: 9334,
                    pages: vec![BrowserCdpPage {
                        page_id: "same".to_string(),
                        workspace_id: "workspace-a".to_string(),
                    }],
                },
                BrowserCdpProfile {
                    profile_id: "b".to_string(),
                    port: 9335,
                    pages: vec![BrowserCdpPage {
                        page_id: "same".to_string(),
                        workspace_id: "workspace-b".to_string(),
                    }],
                },
            ],
        };
        assert!(validate_registry(&duplicate).is_err());
        let target = DebugTarget {
            id: "target".to_string(),
            title: "Hostile".to_string(),
            url: "https://example.test".to_string(),
            target_type: "page".to_string(),
            web_socket_debugger_url: Some("ws://example.test:9334/devtools/page/1".to_string()),
            cdp_port: 9334,
            page_id: None,
            profile_id: None,
            workspace_id: None,
            external: false,
            extension_tab_id: None,
        };
        let error = match CdpConnection::open(&target) {
            Ok(_) => panic!("hostile websocket URL was accepted"),
            Err(error) => error,
        };
        assert!(error.to_string().contains("unsafe CDP websocket URL"));
    }

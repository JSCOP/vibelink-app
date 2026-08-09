    use super::*;
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
        std::env::temp_dir().join(format!("vibelink-browser-page-{label}-{}", Uuid::new_v4()))
    }

    fn element_command(
        action: BrowserAction,
        options: &[(&'static str, &str)],
    ) -> ActionCommand<BrowserAction> {
        command(
            action,
            options
                .iter()
                .map(|(name, value)| (*name, vec![(*value).to_string()]))
                .collect::<Vec<_>>(),
        )
    }

    #[test]
    fn element_target_requires_exactly_one_targeting_mode() {
        assert!(
            element_target(&element_command(BrowserAction::Snapshot, &[]))
                .unwrap()
                .is_none()
        );
        assert!(matches!(
            element_target(&element_command(BrowserAction::Click, &[("ref", "e4")])).unwrap(),
            Some(ElementTarget::Ref(reference)) if reference == "e4"
        ));
        assert!(matches!(
            element_target(&element_command(BrowserAction::Click, &[("selector", "#save")]))
                .unwrap(),
            Some(ElementTarget::Selector(selector)) if selector == "#save"
        ));
        assert!(element_target(&element_command(
            BrowserAction::Click,
            &[("ref", "e4"), ("selector", "#save")]
        ))
        .is_err());
        assert!(element_target(&element_command(BrowserAction::Click, &[])).is_err());
    }

    #[test]
    fn snapshot_refs_survive_between_commands() {
        let root = temp_root("snapshot");
        let state = SnapshotState {
            version: 1,
            generation: "s1".to_string(),
            next_ref: 2,
            target_id: "TARGET/1".to_string(),
            url: "https://example.test/a".to_string(),
            captured_at_ms: 1,
            refs: vec![SnapshotRef {
                reference: "e1".to_string(),
                backend_node_id: 42,
                role: "button".to_string(),
                name: "Save".to_string(),
            }],
        };
        write_snapshot_state(&root, &state).expect("write snapshot state");
        let restored = read_snapshot_state(&root, "TARGET/1")
            .expect("read snapshot state")
            .expect("snapshot state present");
        assert_eq!(restored.url, state.url);
        assert_eq!(restored.refs[0].backend_node_id, 42);
        assert!(read_snapshot_state(&root, "OTHER").unwrap().is_none());
        assert_eq!(
            snapshot_state_path(&root, "TARGET/1").file_name().unwrap(),
            std::ffi::OsStr::new("TARGET_1.json")
        );
        assert_eq!(
            snapshot_state_path(&root, "../../evil")
                .file_name()
                .unwrap(),
            std::ffi::OsStr::new("______evil.json")
        );
        fs::write(
            snapshot_state_path(&root, "TARGET/1"),
            br#"{"version":9,"generation":"s1","targetId":"TARGET/1","url":"u","capturedAtMs":1,"refs":[]}"#,
        )
        .expect("overwrite snapshot state");
        assert!(read_snapshot_state(&root, "TARGET/1").unwrap().is_none());
        fs::write(snapshot_state_path(&root, "TARGET/1"), b"{")
            .expect("corrupt snapshot state");
        assert!(read_snapshot_state(&root, "TARGET/1").is_err());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn snapshot_state_writes_are_bounded_and_pruned() {
        let root = temp_root("snapshot-bounds");
        let mut state = SnapshotState {
            version: 1,
            generation: "s1".to_string(),
            next_ref: 2,
            target_id: "oversized".to_string(),
            url: "https://example.test/".to_string(),
            captured_at_ms: 1,
            refs: vec![SnapshotRef {
                reference: "e1".to_string(),
                backend_node_id: 1,
                role: "button".to_string(),
                name: "x".repeat(MAX_SNAPSHOT_STATE_BYTES as usize),
            }],
        };
        assert!(write_snapshot_state(&root, &state).is_err());
        assert!(!snapshot_state_path(&root, "oversized").exists());

        state.refs[0].name.clear();
        for index in 0..=MAX_SNAPSHOT_STATE_FILES {
            state.target_id = format!("target-{index}");
            write_snapshot_state(&root, &state).expect("write bounded snapshot state");
        }
        let snapshots = fs::read_dir(root.join("snapshots"))
            .expect("read snapshot directory")
            .count();
        assert_eq!(snapshots, MAX_SNAPSHOT_STATE_FILES);
        assert!(snapshot_state_path(
            &root,
            &format!("target-{MAX_SNAPSHOT_STATE_FILES}")
        )
        .exists());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn same_url_snapshot_rejects_previous_refs() {
        let root = temp_root("same-url-stale");
        let tree = json!({
            "nodes": [
                { "nodeId": "1", "role": {"value": "button"}, "name": {"value": "First"}, "backendDOMNodeId": 1 }
            ]
        });
        let first = compress_ax_tree(
            &tree,
            "target-1",
            "https://example.test/app".to_string(),
            1,
            false,
        )
        .expect("first snapshot");
        write_snapshot_state(&root, &first.state).expect("persist first snapshot");
        let previous = read_snapshot_state(&root, "target-1")
            .expect("read first snapshot")
            .expect("first snapshot present");
        let second = compress_ax_tree(
            &tree,
            "target-1",
            "https://example.test/app".to_string(),
            next_snapshot_ref(Some(&previous)),
            false,
        )
        .expect("second snapshot");
        assert_eq!(first.state.refs[0].reference, "e1");
        assert_eq!(second.state.refs[0].reference, "e2");
        write_snapshot_state(&root, &second.state).expect("persist second snapshot");
        let current = read_snapshot_state(&root, "target-1")
            .expect("read second snapshot")
            .expect("second snapshot present");
        let error = snapshot_ref(&current, "e1").unwrap_err();
        assert!(error
            .to_string()
            .contains("stale_ref: e1 does not belong to snapshot"));
        let _ = fs::remove_dir_all(root);
    }
    #[test]
    fn resolved_detached_node_is_rejected_as_a_stale_ref() {
        let root = temp_root("resolve-detached");
        let state = SnapshotState {
            version: 1,
            generation: "s1".to_string(),
            next_ref: 2,
            target_id: "target-1".to_string(),
            url: "https://example.test/app".to_string(),
            captured_at_ms: 1,
            refs: vec![SnapshotRef {
                reference: "e1".to_string(),
                backend_node_id: 1,
                role: "button".to_string(),
                name: "Save".to_string(),
            }],
        };
        write_snapshot_state(&root, &state).expect("persist snapshot state");
        let target = DebugTarget {
            id: "target-1".to_string(),
            title: "Page".to_string(),
            url: state.url.clone(),
            target_type: "page".to_string(),
            web_socket_debugger_url: None,
            cdp_port: 0,
            page_id: None,
            profile_id: None,
            workspace_id: None,
            external: false,
            extension_tab_id: None,
        };
        let (mut cdp, calls) = CdpConnection::scripted(vec![
            Ok(json!({ "result": { "value": state.url } })),
            Ok(json!({ "object": { "objectId": "object-1" } })),
            Ok(json!({ "result": { "value": false } })),
        ]);

        let error = resolve_element(
            &mut cdp,
            &root,
            &target,
            &ElementTarget::Ref("e1".to_string()),
        )
        .unwrap_err();
        assert!(error.to_string().starts_with("stale_ref:"));
        let calls = calls.lock().expect("scripted CDP calls");
        assert_eq!(calls[1].0, "DOM.resolveNode");
        assert_eq!(calls[2].0, "Runtime.callFunctionOn");
        assert!(calls.iter().all(|(method, _)| method != "Input.dispatchMouseEvent"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn detached_node_center_fails_before_pointer_dispatch() {
        let (mut cdp, calls) = CdpConnection::scripted(vec![Ok(json!({
            "result": { "value": { "live": false, "x": 0, "y": 0, "width": 0, "height": 0, "hit": false } }
        }))]);

        let error = element_center(&mut cdp, "object-1").unwrap_err();
        assert!(error.to_string().starts_with("stale_ref:"));
        let calls = calls.lock().expect("scripted CDP calls");
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].0, "Runtime.callFunctionOn");
    }

    #[test]
    fn only_missing_nodes_are_classified_as_stale_refs() {
        assert!(is_stale_node_error(&anyhow::anyhow!(
            "CDP DOM.resolveNode failed: No node with given id found"
        )));
        assert!(!is_stale_node_error(&anyhow::anyhow!(
            "browser extension request disconnected"
        )));
    }

    #[test]
    fn ax_tree_compression_emits_actionable_refs() {
        let tree = json!({
            "nodes": [
                { "nodeId": "1", "role": {"value": "RootWebArea"}, "name": {"value": "Doc"}, "backendDOMNodeId": 1 },
                { "nodeId": "2", "parentId": "1", "role": {"value": "generic"}, "backendDOMNodeId": 2 },
                { "nodeId": "3", "parentId": "2", "role": {"value": "button"}, "name": {"value": "  Save\n  now  "}, "backendDOMNodeId": 3 },
                { "nodeId": "4", "parentId": "3", "role": {"value": "textbox"}, "name": {"value": "Email"}, "backendDOMNodeId": 4 },
                { "nodeId": "5", "parentId": "1", "role": {"value": "button"}, "ignored": true, "backendDOMNodeId": 5 },
                { "nodeId": "6", "parentId": "1", "role": {"value": "button"}, "name": {"value": "No node"} },
                { "nodeId": "7", "parentId": "1", "role": {"value": "generic"}, "name": {"value": "Composer"}, "backendDOMNodeId": 7,
                  "properties": [{"name": "editable", "value": {"value": "richtext"}}] },
                { "nodeId": "8", "parentId": "1", "role": {"value": "generic"}, "backendDOMNodeId": 8,
                  "properties": [{"name": "focusable", "value": {"value": true}}] }
            ]
        });
        let snapshot = compress_ax_tree(&tree, "target-1", "https://example.test/".to_string(), 1, false)
            .expect("compress accessibility tree");
        assert_eq!(snapshot.state.refs.len(), 3);
        assert_eq!(snapshot.state.refs[0].reference, "e1");
        assert_eq!(snapshot.state.refs[0].backend_node_id, 3);
        assert_eq!(snapshot.state.refs[0].name, "Save now");
        assert_eq!(snapshot.state.refs[1].role, "textbox");
        assert_eq!(
            snapshot.tree,
            "    e1 button \"Save now\"\n      e2 textbox \"Email\"\n  e3 generic \"Composer\" [editable]"
        );
        assert!(!snapshot.truncated);
    }

    #[test]
    fn interactive_only_drops_text_but_keeps_editables() {
        let tree = json!({
            "nodes": [
                { "nodeId": "1", "role": {"value": "RootWebArea"}, "backendDOMNodeId": 1 },
                { "nodeId": "2", "parentId": "1", "role": {"value": "button"}, "name": {"value": "Save"}, "backendDOMNodeId": 2 },
                { "nodeId": "3", "parentId": "1", "role": {"value": "StaticText"}, "name": {"value": "some prose"}, "backendDOMNodeId": 3 },
                { "nodeId": "4", "parentId": "1", "role": {"value": "heading"}, "name": {"value": "Title"}, "backendDOMNodeId": 4 },
                { "nodeId": "5", "parentId": "1", "role": {"value": "generic"}, "name": {"value": "Composer"}, "backendDOMNodeId": 5,
                  "properties": [{"name": "editable", "value": {"value": "richtext"}}] }
            ]
        });
        let full = compress_ax_tree(&tree, "t", "https://example.test/".to_string(), 1, false)
            .expect("full snapshot");
        assert_eq!(full.state.refs.len(), 4);

        let lean = compress_ax_tree(&tree, "t", "https://example.test/".to_string(), 1, true)
            .expect("interactive snapshot");
        let roles: Vec<&str> = lean.state.refs.iter().map(|r| r.role.as_str()).collect();
        // The editable composer survives even though `generic` is not actionable.
        assert_eq!(roles, vec!["button", "generic"]);
        assert!(lean.tree.len() < full.tree.len());
    }

    #[test]
    fn wait_conditions_build_bounded_expressions() {
        assert_eq!(
            wait_expression("load", &element_command(BrowserAction::Wait, &[])).unwrap(),
            "document.readyState==='complete'"
        );
        let selector = wait_expression(
            "selector",
            &element_command(BrowserAction::Wait, &[("selector", "#ready")]),
        )
        .unwrap();
        assert!(selector.contains("\"#ready\"") && selector.contains("getBoundingClientRect"));
        assert_eq!(
            wait_expression(
                "url",
                &element_command(BrowserAction::Wait, &[("url", "/done")])
            )
            .unwrap(),
            "location.href.includes(\"/done\")"
        );
        let idle = wait_expression(
            "idle",
            &element_command(BrowserAction::Wait, &[("quiet-ms", "750")]),
        )
        .unwrap();
        assert!(idle.ends_with("(750)") && idle.contains("MutationObserver"));
        assert!(wait_expression("selector", &element_command(BrowserAction::Wait, &[])).is_err());
        assert!(wait_expression("teleport", &element_command(BrowserAction::Wait, &[])).is_err());
    }

    #[test]
    fn ax_names_are_collapsed_and_bounded() {
        assert_eq!(bounded_ax_name("  a \n b  "), "a b");
        assert_eq!(
            bounded_ax_name(&"x".repeat(500)).chars().count(),
            MAX_AX_NAME_CHARS
        );
    }

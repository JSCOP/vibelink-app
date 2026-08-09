use super::*;

#[test]
fn parses_every_stable_command_family() {
    let cases = [
        (vec!["status"], "status"),
        (vec!["workspace", "list"], "workspace"),
        (vec!["terminal", "read", "--pane", "p1"], "terminal"),
        (
            vec!["orchestration", "task-list", "--run-id", "run-1"],
            "orchestration",
        ),
        (vec!["automation", "list"], "automation"),
        (vec!["browser", "snapshot", "--page", "page-1"], "browser"),
        (
            vec!["computer", "get-app-state", "--app", "Notepad"],
            "computer",
        ),
        (vec!["skill", "doctor"], "skill"),
        (vec!["memory", "list"], "memory"),
        (vec!["remote", "devices"], "remote"),
        (vec!["mcp", "serve"], "mcp"),
        (vec!["worktree", "current"], "worktree"),
    ];
    for (args, expected_domain) in cases {
        let invocation = parse_args(args).expect("parse command family");
        let value = serde_json::to_value(invocation.command).expect("serialize command");
        assert_eq!(value["domain"], expected_domain);
    }
}

#[test]
fn parses_every_published_action() {
    let command_tree: &[(&str, &[&str])] = &[
        (
            "workspace",
            &["list", "create", "show", "open", "sleep", "wake", "delete"],
        ),
        (
            "worktree",
            &[
                "list",
                "show",
                "current",
                "create",
                "import",
                "move",
                "preflight-remove",
                "remove",
                "set",
                "checkpoint",
                "comment",
            ],
        ),
        (
            "terminal",
            &[
                "list", "show", "read", "send", "wait", "create", "split", "close",
            ],
        ),
        (
            "orchestration",
            &[
                "send",
                "check",
                "reply",
                "inbox",
                "task-create",
                "task-list",
                "task-update",
                "dispatch",
                "dispatch-show",
                "ask",
                "run",
                "run-stop",
                "gate-create",
                "gate-resolve",
                "gate-list",
                "reset",
            ],
        ),
        (
            "automation",
            &[
                "list",
                "create",
                "update",
                "delete",
                "run",
                "runs",
                "precheck",
                "schedule-preview",
                "cancel",
                "import-preview",
                "import",
                "draft-preview",
                "draft-cancel",
            ],
        ),
        (
            "browser",
            &[
                "navigate",
                "snapshot",
                "screenshot",
                "full-screenshot",
                "pdf",
                "back",
                "forward",
                "reload",
                "wait",
                "click",
                "double-click",
                "fill",
                "type",
                "select",
                "check",
                "focus",
                "clear",
                "select-all",
                "keypress",
                "hover",
                "drag",
                "upload",
                "scroll",
                "scroll-into-view",
                "find",
                "get",
                "is",
                "mouse",
                "highlight",
                "download",
                "tabs",
                "profiles",
                "chrome",
                "cookies",
                "storage",
                "viewport",
                "device-mode",
                "console",
                "network",
            ],
        ),
        (
            "computer",
            &[
                "capabilities",
                "list-apps",
                "list-windows",
                "get-app-state",
                "approval-create",
                "approval-resolve",
                "approval-list",
                "action-history",
                "click",
                "perform-secondary-action",
                "scroll",
                "drag",
                "type-text",
                "press-key",
                "hotkey",
                "paste-text",
                "set-value",
            ],
        ),
        ("skill", &["list", "show", "apply", "delete", "doctor"]),
        ("memory", &["list", "search", "add", "remove"]),
        ("remote", &["status", "pair", "devices", "revoke"]),
    ];
    for (domain, actions) in command_tree {
        for action in *actions {
            let mut args = vec![(*domain).to_string(), (*action).to_string()];
            if let Some(contract) = crate::dedicated_cli::find_contract(domain, action) {
                for option in contract.options.iter().filter(|option| option.required) {
                    args.push(format!("--{}", option.name));
                    args.push(
                        option
                            .enum_values
                            .first()
                            .copied()
                            .map(str::to_string)
                            .unwrap_or_else(|| match option.kind {
                                crate::dedicated_cli::ValueKind::Uuid => {
                                    Uuid::nil().to_string()
                                }
                                crate::dedicated_cli::ValueKind::Integer
                                | crate::dedicated_cli::ValueKind::UnsignedInteger => {
                                    "1".to_string()
                                }
                                crate::dedicated_cli::ValueKind::String => "value".to_string(),
                            }),
                    );
                }
                if let Some(id) = contract.positional_satisfies {
                    if !args.iter().any(|value| value == &format!("--{id}")) {
                        args.extend([format!("--{id}"), "value".to_string()]);
                    }
                }
                if contract.requires_expected_revision {
                    args.extend(["--expected-revision".to_string(), "1".to_string()]);
                }
                if contract.domain == "worktree" && contract.action == "remove" {
                    args.push("--confirm".to_string());
                }
            }
            parse_args(args)
                .unwrap_or_else(|error| panic!("{domain} {action} did not parse: {error}"));
        }
    }
}

#[test]
fn parses_memory_add_with_repeated_tags_and_pin() {
    let invocation = parse_args([
        "memory", "add", "--title", "T", "--body", "B", "--tag", "a", "--tag", "b", "--pin",
    ])
    .expect("parse memory add");
    let Command::Memory(command) = invocation.command else {
        panic!("expected memory command")
    };

    assert_eq!(command.action, MemoryAction::Add);
    assert_eq!(command.arguments.options["title"], ["T"]);
    assert_eq!(command.arguments.options["body"], ["B"]);
    assert_eq!(command.arguments.options["tag"], ["a", "b"]);
    assert!(command.arguments.switches.contains("pin"));
}

#[test]
fn rejects_unknown_memory_action() {
    assert!(parse_args(["memory", "guess"]).is_err());
    assert!(parse_args(["memory", "link"]).is_err());
}

#[test]
fn parses_memory_agent_as_origin_option() {
    let invocation = parse_args([
        "memory", "add", "--title", "T", "--body", "B", "--agent", "omp",
    ])
    .expect("parse memory agent");
    let Command::Memory(command) = invocation.command else {
        panic!("expected memory command")
    };

    assert_eq!(command.selectors.agent, None);
    assert_eq!(command.arguments.options["agent"], ["omp"]);
}

#[test]
fn parses_global_contract_and_typed_selectors() {
    let operation_id = Uuid::new_v4();
    let invocation = parse_args([
        "terminal",
        "send",
        "--workspace",
        "alpha",
        "--pane=pane-1",
        "--text",
        "hello",
        "--enter",
        "--json",
        "--operation-id",
        &operation_id.to_string(),
        "--expected-revision=7",
        "--request-timeout-seconds",
        "15",
        "--flavor",
        "prod",
    ])
    .expect("parse invocation");
    assert!(invocation.json);
    assert_eq!(invocation.flavor, Some(Flavor::Prod));
    assert_eq!(invocation.timeout_ms, 15_000);
    let Command::Terminal(command) = invocation.command else {
        panic!("expected terminal command")
    };
    assert_eq!(command.action, TerminalAction::Send);
    assert_eq!(command.selectors.workspace.as_deref(), Some("alpha"));
    assert_eq!(command.selectors.pane.as_deref(), Some("pane-1"));
    assert_eq!(command.arguments.options["text"], ["hello"]);
    assert!(command.arguments.switches.contains("enter"));
}
#[test]
fn automation_payload_json_does_not_consume_global_json_output() {
    let payload = r#"{"requestId":"33e7e588-9842-44c1-94e7-c77819718d11","request":"test"}"#;
    let invocation = parse_args([
        "--json",
        "automation",
        "draft-preview",
        "--workspace",
        "workspace-1",
        "--json",
        payload,
        "--request-timeout-seconds",
        "15",
    ])
    .expect("parse automation draft JSON payload");
    assert!(invocation.json);
    assert_eq!(invocation.timeout_ms, 15_000);
    let Command::Automation(command) = invocation.command else {
        panic!("expected automation command")
    };
    assert_eq!(command.action, AutomationAction::DraftPreview);
    assert_eq!(command.arguments.options["json"], [payload]);
}

#[test]
fn automation_schedule_preview_keeps_json_payload() {
    let payload = r#"{"scheduleKind":"daily","scheduleValue":"09:00","timezone":"UTC"}"#;
    let invocation = parse_args(["automation", "schedule-preview", "--json", payload])
        .expect("parse automation schedule preview JSON payload");
    let Command::Automation(command) = invocation.command else {
        panic!("expected automation command")
    };
    assert_eq!(command.action, AutomationAction::SchedulePreview);
    assert_eq!(command.arguments.options["json"], [payload]);
}
#[test]
fn automation_v4_actions_parse_and_require_json_or_id() {
    let run_id = Uuid::new_v4().to_string();
    let cancel_inv =
        parse_args(["automation", "cancel", &run_id]).expect("parse cancel positional");
    let Command::Automation(cancel_cmd) = cancel_inv.command else {
        panic!("expected automation")
    };
    assert_eq!(cancel_cmd.action, AutomationAction::Cancel);
    assert_eq!(
        cancel_cmd.arguments.positionals.as_slice(),
        std::slice::from_ref(&run_id)
    );

    let cancel_opt_inv =
        parse_args(["automation", "cancel", "--id", &run_id]).expect("parse cancel --id");
    let Command::Automation(cancel_opt_cmd) = cancel_opt_inv.command else {
        panic!("expected automation")
    };
    assert_eq!(cancel_opt_cmd.action, AutomationAction::Cancel);
    assert_eq!(cancel_opt_cmd.arguments.options["id"], [run_id]);

    let import_preview_inv =
        parse_args(["automation", "import-preview", "--workspace", "ws-1"])
            .expect("parse import-preview");
    let Command::Automation(import_preview_cmd) = import_preview_inv.command else {
        panic!("expected automation")
    };
    assert_eq!(import_preview_cmd.action, AutomationAction::ImportPreview);
    assert_eq!(
        import_preview_cmd.selectors.workspace.as_deref(),
        Some("ws-1")
    );

    let import_payload = r#"{"jobs":[]}"#;
    let import_inv = parse_args([
        "automation",
        "import",
        "--workspace",
        "ws-1",
        "--json",
        import_payload,
    ])
    .expect("parse import");
    let Command::Automation(import_cmd) = import_inv.command else {
        panic!("expected automation")
    };
    assert_eq!(import_cmd.action, AutomationAction::Import);
    assert_eq!(import_cmd.arguments.options["json"], [import_payload]);

    let draft_payload =
        r#"{"requestId":"33e7e588-9842-44c1-94e7-c77819718d11","request":"test"}"#;
    let draft_inv = parse_args([
        "automation",
        "draft-preview",
        "--workspace",
        "ws-1",
        "--json",
        draft_payload,
    ])
    .expect("parse draft-preview");
    let Command::Automation(draft_cmd) = draft_inv.command else {
        panic!("expected automation")
    };
    assert_eq!(draft_cmd.action, AutomationAction::DraftPreview);
    assert_eq!(draft_cmd.arguments.options["json"], [draft_payload]);

    let draft_request_id = Uuid::new_v4().to_string();
    let draft_cancel_inv =
        parse_args(["automation", "draft-cancel", "--id", &draft_request_id])
            .expect("parse draft-cancel");
    let Command::Automation(draft_cancel_cmd) = draft_cancel_inv.command else {
        panic!("expected automation")
    };
    assert_eq!(draft_cancel_cmd.action, AutomationAction::DraftCancel);
    assert_eq!(draft_cancel_cmd.arguments.options["id"], [draft_request_id]);

    assert!(parse_args(["automation", "create", "--workspace", "ws-1"]).is_err());
    assert!(parse_args(["automation", "update", "--id", &Uuid::new_v4().to_string()]).is_err());
    assert!(parse_args(["automation", "import", "--workspace", "ws-1"]).is_err());
    assert!(parse_args(["automation", "draft-preview", "--workspace", "ws-1"]).is_err());
    assert!(parse_args(["automation", "draft-cancel"]).is_err());
    assert!(parse_args(["automation", "draft-cancel", "--id", "not-a-uuid"]).is_err());
}

#[test]
fn automation_rejects_legacy_goal_and_command_flags() {
    assert!(parse_args([
        "automation",
        "create",
        "--workspace",
        "ws-1",
        "--goal",
        "do task"
    ])
    .is_err());
    assert!(parse_args([
        "automation",
        "create",
        "--workspace",
        "ws-1",
        "--command",
        "run"
    ])
    .is_err());
}

#[test]
fn rejects_unknown_actions_and_duplicate_selectors() {
    assert!(parse_args(["workspace", "guess"]).is_err());
    let error = parse_args(["terminal", "read", "--pane", "one", "--pane", "two"])
        .expect_err("duplicate selector");
    assert_eq!(
        error.code,
        crate::dedicated_cli::ErrorCode::InvalidArguments
    );
}

#[test]
fn worktree_grammar_uses_exact_instance_and_parent_flags() {
    let instance_id = Uuid::new_v4().to_string();
    let operation = parse_args([
        "worktree",
        "remove",
        "--worktree",
        "worktree-1",
        "--expected-instance-id",
        instance_id.as_str(),
        "--acknowledge-blocker",
        "dirty",
        "--confirm",
    ])
    .expect("parse exact removal grammar");
    let Command::Worktree(command) = operation.command else {
        panic!("expected worktree command")
    };
    assert_eq!(
        command.arguments.options["expected-instance-id"],
        [instance_id.as_str()]
    );
    assert!(parse_args([
        "worktree",
        "remove",
        "--worktree",
        "worktree-1",
        "--instance",
        instance_id.as_str(),
        "--confirm",
    ])
    .is_err());
    assert!(parse_args([
        "worktree",
        "create",
        "--repo",
        ".",
        "--name",
        "child",
        "--parent-worktree",
        "parent",
        "--no-parent",
    ])
    .is_err());
}

#[test]
fn action_serialization_is_stable_kebab_case() {
    let invocation = parse_args([
        "orchestration",
        "gate-resolve",
        "--gate-id",
        "gate-1",
        "--resolution",
        "approve",
        "--expected-revision",
        "1",
    ])
    .expect("parse gate resolve");
    let json = serde_json::to_value(invocation.command).expect("serialize command");
    assert_eq!(json["request"]["action"], "gate-resolve");
}

/// `COMMAND_DOMAINS` gates whether the GUI binary refuses an argv, so it
/// must stay in sync with what the parser actually accepts. A domain the
/// parser knows but this list omits would let a hook boot a second desktop
/// instance again; the extra instance then refits the shared panes to its
/// own window and the live terminal grid visibly shakes.
#[test]
fn command_domains_cover_every_domain_the_parser_accepts() {
    for domain in COMMAND_DOMAINS {
        assert!(is_command_domain(domain));
        let error = parse_args([*domain]).err();
        // Each domain must be RECOGNISED: it either parses or fails for a
        // reason other than "unknown command domain".
        if let Some(error) = error {
            assert!(
                !error.to_string().contains("unknown command domain"),
                "{domain} is listed but the parser does not know it"
            );
        }
    }

    assert!(parse_args(["definitely-not-a-domain"])
        .expect_err("unknown domain rejected")
        .to_string()
        .contains("unknown command domain"));
}

#[test]
fn ordinary_launch_arguments_are_not_command_domains() {
    for argument in ["", "--daemon", "vibelink://open", "C:/some/path", "--flag"] {
        assert!(!is_command_domain(argument));
    }
}

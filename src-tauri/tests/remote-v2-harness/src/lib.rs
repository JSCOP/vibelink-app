mod persistence {
    include!(concat!(env!("HARNESS_APP_SRC"), "/persistence.rs"));
}

#[cfg(test)]
mod control_plane {
    use serde::Serialize;
    use std::collections::HashMap;

    #[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
    #[serde(rename_all = "kebab-case")]
    pub enum TaskStatus {
        Pending,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Task {
        pub id: String,
        pub session_id: String,
        pub title: String,
        pub description: String,
        pub status: TaskStatus,
        pub status_timestamps: HashMap<TaskStatus, i64>,
        pub assigned_pane_id: Option<String>,
        pub assigned_role: Option<String>,
        pub baseline_ref: Option<String>,
        pub worktree_path: Option<String>,
        pub commit_message: Option<String>,
        pub result_summary: Option<String>,
        pub created_at: i64,
        pub updated_at: i64,
    }

    #[derive(Debug, Serialize)]
    #[serde(rename_all = "camelCase", tag = "kind", content = "value")]
    pub enum ControlResponse {
        Task(Task),
    }
}


mod protocol {
    include!(concat!(env!("HARNESS_APP_SRC"), "/protocol.rs"));
}

mod dedicated_cli {
    use serde::Serialize;
    use uuid::Uuid;

    pub const COMMAND_SCHEMA_VERSION: u16 = 1;

    #[derive(Clone, Debug, Serialize)]
    pub struct Command {
        args: Vec<String>,
    }

    pub struct Invocation {
        pub command: Command,
    }

    pub fn parse_args(args: Vec<String>) -> Result<Invocation, String> {
        Ok(Invocation {
            command: Command { args },
        })
    }

    #[derive(Clone, Debug, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct CliControlRequest {
        pub schema_version: u16,
        pub operation_id: Uuid,
        pub expected_revision: Option<u64>,
        pub command: Command,
    }
}

mod app {
    pub mod spawn_daemon {
        use interprocess::local_socket::prelude::LocalSocketStream;
        use std::io;

        pub fn connect_daemon() -> io::Result<LocalSocketStream> {
            Err(io::Error::new(
                io::ErrorKind::NotConnected,
                "isolated remote-v2 test does not start the daemon",
            ))
        }
    }
}

mod remote {
    pub mod protocol {
        include!(concat!(env!("HARNESS_APP_SRC"), "/remote/protocol.rs"));
    }

    pub mod config {
        include!(concat!(env!("HARNESS_APP_SRC"), "/remote/config.rs"));
    }

    pub mod devices {
        include!(concat!(env!("HARNESS_APP_SRC"), "/remote/devices.rs"));
    }

    pub mod identity {
        include!(concat!(env!("HARNESS_APP_SRC"), "/remote/identity.rs"));
    }

    pub mod layout_order {
        include!(concat!(env!("HARNESS_APP_SRC"), "/remote/layout_order.rs"));
    }

    pub mod v2 {
        use sha2::{Digest, Sha256};

        pub const PROTOCOL_VERSION: u16 = 2;
        pub const SUBPROTOCOL: &str = "vibelink-remote-v2";
        pub mod generated {
            include!(concat!(env!("HARNESS_APP_SRC"), "/remote/v2/generated.rs"));
        }
        pub use generated::GENERATED_CONTRACT_SHA256 as CONTRACT_SHA256;
        pub const CONTRACT_JSON: &str = include_str!(concat!(
            env!("HARNESS_APP_ROOT"),
            "/contracts/remote-v2.json"
        ));

        pub fn contract_hash() -> String {
            Sha256::digest(CONTRACT_JSON.as_bytes())
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect()
        }

        pub mod wire {
            include!(concat!(env!("HARNESS_APP_SRC"), "/remote/v2/wire.rs"));
        }

        pub mod secure {
            include!(concat!(env!("HARNESS_APP_SRC"), "/remote/v2/secure.rs"));
        }

        pub mod relay {
            include!(concat!(env!("HARNESS_APP_SRC"), "/remote/v2/relay.rs"));
        }

        #[cfg(test)]
        mod tests {
            use super::*;

            #[test]
            fn embedded_remote_v2_contract_matches_declared_hash() {
                assert_eq!(contract_hash(), CONTRACT_SHA256);
                let contract: serde_json::Value =
                    serde_json::from_str(CONTRACT_JSON).expect("parse remote-v2 contract");
                assert_eq!(contract["protocolVersion"], PROTOCOL_VERSION);
                assert_eq!(contract["subprotocol"], SUBPROTOCOL);
                assert_eq!(contract["binaryFrame"]["headerBytes"], wire::BINARY_HEADER_BYTES);
                assert_eq!(
                    contract["compatibility"]["v1SubprotocolUnchanged"],
                    crate::remote::protocol::SUBPROTOCOL
                );
            }
        }
    }

    pub mod server {
        include!(concat!(env!("HARNESS_APP_SRC"), "/remote/server.rs"));
    }

    pub mod bridge {
        include!(concat!(env!("HARNESS_APP_SRC"), "/remote/bridge.rs"));
    }
}

#[cfg(test)]
mod fixture_tests {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    use serde_json::Value;
    use std::collections::BTreeSet;

    const FIXTURE_JSON: &str = include_str!(concat!(
        env!("HARNESS_APP_ROOT"),
        "/contracts/remote-v2-fixture.json"
    ));

    const SCENARIO_IDS: &[&str] = &[
        "workspace-list-two-workspaces",
        "pane-catalog-eight-ordered",
        "terminal-snapshot-then-live",
        "terminal-resize",
        "lease-same-owner-renew-update",
        "lease-competing-owner-busy",
        "lease-explicit-revoke",
        "terminal-sequence-gap-resync",
        "endpoint-delayed-success",
        "endpoint-stale-failure",
        "identity-mismatch",
        "certificate-pin-mismatch",
    ];

    fn fixture() -> Value {
        serde_json::from_str(FIXTURE_JSON).expect("parse deterministic remote-v2 fixture")
    }

    fn array<'a>(value: &'a Value, label: &str) -> &'a Vec<Value> {
        value
            .as_array()
            .unwrap_or_else(|| panic!("{label} must be an array"))
    }

    fn find_by<'a>(items: &'a [Value], key: &str, expected: &str) -> &'a Value {
        items
            .iter()
            .find(|item| item[key].as_str() == Some(expected))
            .unwrap_or_else(|| panic!("missing {key}={expected}"))
    }

    fn keys(value: &Value) -> BTreeSet<String> {
        value
            .as_object()
            .expect("value must be an object")
            .keys()
            .cloned()
            .collect()
    }

    fn expected_keys(values: &[&str]) -> BTreeSet<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    fn assert_no_legacy_keys(value: &Value) {
        const LEGACY_KEYS: &[&str] = &[
            "workspace_id",
            "pane_id",
            "subscription_id",
            "stream_id",
            "view_generation",
            "data_base64",
            "lease_id",
            "lease_revision",
            "viewport_revision",
            "pane_generation",
            "first_live_sequence",
            "snapshot_bytes",
            "snapshot_chunks",
        ];

        match value {
            Value::Object(object) => {
                for (key, child) in object {
                    assert!(
                        !LEGACY_KEYS.contains(&key.as_str()),
                        "legacy key {key} is forbidden"
                    );
                    assert_no_legacy_keys(child);
                }
            }
            Value::Array(items) => {
                for item in items {
                    assert_no_legacy_keys(item);
                }
            }
            _ => {}
        }
    }

    #[test]
    fn fixture_is_deterministic_complete_and_isolated() {
        let fixture = fixture();
        assert_eq!(fixture["fixtureVersion"], 1);
        assert_eq!(fixture["contractVersion"], 3);
        assert_eq!(fixture["protocolVersion"], 2);
        assert_eq!(fixture["subprotocol"], "vibelink-remote-v2");
        assert_eq!(fixture["generatedAt"], "2026-01-02T03:04:05.000Z");

        let scenario_ids: Vec<_> = array(&fixture["scenarioIds"], "scenarioIds")
            .iter()
            .map(|value| value.as_str().expect("scenario id string"))
            .collect();
        assert_eq!(scenario_ids.as_slice(), SCENARIO_IDS);

        assert_eq!(fixture["isolation"]["startsDaemon"], false);
        assert_eq!(fixture["isolation"]["bindsPorts"], false);
        assert_eq!(fixture["isolation"]["mutatesUserState"], false);
        assert_eq!(
            fixture["isolation"]["usesDocumentationEndpointsOnly"],
            true
        );
        assert_no_legacy_keys(&fixture);
    }

    #[test]
    fn fixture_preserves_workspace_and_pane_identity_order() {
        let fixture = fixture();
        let workspaces = array(&fixture["workspaces"], "workspaces");
        assert_eq!(workspaces.len(), 2);
        assert_eq!(
            keys(&workspaces[0]),
            expected_keys(&["id", "name", "workspaceFolder", "paneCount"])
        );
        assert_eq!(
            keys(&workspaces[1]),
            expected_keys(&["id", "name", "workspaceFolder", "paneCount"])
        );
        assert_eq!(workspaces[0]["id"], "workspace-alpha");
        assert_eq!(workspaces[0]["name"], "Alpha 작업공간");
        assert_eq!(workspaces[0]["paneCount"], 5);
        assert_eq!(workspaces[1]["id"], "workspace-beta");
        assert_eq!(workspaces[1]["name"], "Beta 🚀");
        assert_eq!(workspaces[1]["paneCount"], 3);

        const EXPECTED_PANES: &[(&str, &str, &str, &str, u64)] = &[
            ("pane-alpha-shell", "workspace-alpha", "Shell / 셸", "shell", 0),
            ("pane-alpha-agent", "workspace-alpha", "Agent 🤖", "agent", 1),
            ("pane-alpha-server", "workspace-alpha", "Dev Server", "server", 2),
            ("pane-alpha-tests", "workspace-alpha", "테스트 🧪", "test", 3),
            ("pane-alpha-git", "workspace-alpha", "Git Review", "git", 4),
            ("pane-beta-shell", "workspace-beta", "PowerShell", "shell", 0),
            ("pane-beta-logs", "workspace-beta", "로그 📋", "logs", 1),
            ("pane-beta-review", "workspace-beta", "Review 완료", "review", 2),
        ];
        const REMOTE_PANE_KEYS: &[&str] = &[
            "id",
            "workspaceId",
            "title",
            "role",
            "alive",
            "order",
            "groupId",
            "groupOrder",
            "tabOrder",
            "desktopActive",
            "cols",
            "rows",
            "paneGeneration",
            "activity",
            "unreadCount",
            "lastOutputAt",
            "streamId",
        ];

        let panes = array(&fixture["panes"], "panes");
        assert_eq!(panes.len(), EXPECTED_PANES.len());
        for (pane, (id, workspace_id, title, role, order)) in
            panes.iter().zip(EXPECTED_PANES.iter())
        {
            assert_eq!(keys(pane), expected_keys(REMOTE_PANE_KEYS));
            assert_eq!(pane["id"], *id);
            assert_eq!(pane["workspaceId"], *workspace_id);
            assert_eq!(pane["title"], *title);
            assert_eq!(pane["role"], *role);
            assert_eq!(pane["order"].as_u64(), Some(*order));
            assert!(pane["lastOutputAt"].is_u64());
            assert!(pane["streamId"].is_u64());
            assert!(matches!(
                pane["activity"].as_str(),
                Some("idle" | "running" | "waiting" | "done" | "error")
            ));
        }
    }

    #[test]
    fn fixture_uses_exact_canonical_method_and_event_payload_keys() {
        let fixture = fixture();
        let methods = array(&fixture["methodPayloads"], "methodPayloads");
        let expected_requests: &[(&str, &[&str])] = &[
            ("workspace.list", &[]),
            ("workspace.attach", &["workspaceId"]),
            ("workspace.detach", &["workspaceId"]),
            (
                "terminal.subscribe",
                &["workspaceId", "paneId", "viewGeneration"],
            ),
            ("terminal.unsubscribe", &["subscriptionId"]),
            ("terminal.snapshot", &["subscriptionId", "reason"]),
            (
                "terminal.input",
                &["subscriptionId", "leaseId", "dataBase64"],
            ),
            ("terminal.ack", &["subscriptionId", "sequence"]),
            (
                "terminal.lease.claim",
                &[
                    "workspaceId",
                    "paneId",
                    "leaseId",
                    "cols",
                    "rows",
                    "viewportRevision",
                ],
            ),
            (
                "terminal.lease.release",
                &["leaseId", "leaseRevision"],
            ),
            (
                "terminal.lease.status",
                &["workspaceId", "paneId"],
            ),
            ("appearance.get", &[]),
        ];
        assert_eq!(methods.len(), expected_requests.len());
        for (method, expected) in expected_requests {
            let sample = find_by(methods, "method", method);
            assert_eq!(keys(&sample["request"]), expected_keys(expected));
        }

        let subscribe = find_by(methods, "method", "terminal.subscribe");
        assert_eq!(
            keys(&subscribe["result"]),
            expected_keys(&[
                "subscriptionId",
                "streamId",
                "paneGeneration",
                "cols",
                "rows",
                "alive",
                "firstLiveSequence",
                "snapshotBytes",
                "snapshotChunks",
            ])
        );
        assert!(subscribe["result"]["streamId"].is_u64());

        let events = array(&fixture["eventPayloads"], "eventPayloads");
        let expected_events: &[(&str, &[&str])] = &[
            ("workspace.changed", &["viewGeneration", "workspaces"]),
            ("pane.state", &["viewGeneration", "pane"]),
            (
                "terminal.resized",
                &[
                    "workspaceId",
                    "paneId",
                    "viewGeneration",
                    "paneGeneration",
                    "cols",
                    "rows",
                ],
            ),
            (
                "terminal.lease.changed",
                &["viewGeneration", "lease"],
            ),
            (
                "terminal.lease.lost",
                &[
                    "workspaceId",
                    "paneId",
                    "leaseId",
                    "leaseRevision",
                    "reason",
                ],
            ),
            (
                "appearance.changed",
                &["viewGeneration", "appearance"],
            ),
        ];
        assert_eq!(events.len(), expected_events.len());
        for (event, expected) in expected_events {
            let sample = find_by(events, "event", event);
            assert_eq!(keys(&sample["payload"]), expected_keys(expected));
        }
    }

    #[test]
    fn fixture_orders_snapshot_before_live_and_injects_one_gap_resync() {
        let fixture = fixture();
        let transcript = &fixture["terminalTranscript"];
        let subscription = &transcript["subscription"];
        assert_eq!(transcript["workspaceId"], "workspace-alpha");
        assert_eq!(transcript["paneId"], "pane-alpha-shell");
        assert_eq!(transcript["viewGeneration"], 17);
        assert_eq!(subscription["subscriptionId"], "subscription-alpha-shell");
        assert_eq!(subscription["streamId"], 1001);
        assert_eq!(subscription["firstLiveSequence"], 3);
        assert_eq!(subscription["snapshotBytes"], 94);
        assert_eq!(subscription["snapshotChunks"], 2);

        let records = array(&transcript["records"], "terminalTranscript.records");
        let frames: Vec<_> = records
            .iter()
            .filter(|record| record["kind"] == "binaryFrame")
            .collect();
        let sequences: Vec<_> = frames
            .iter()
            .map(|frame| frame["sequence"].as_u64().expect("frame sequence"))
            .collect();
        assert_eq!(sequences, vec![1, 2, 3, 4, 5, 7, 8, 9]);
        for expected in 1..=5 {
            assert_eq!(sequences[(expected - 1) as usize], expected);
        }

        let first_live = frames
            .iter()
            .position(|frame| frame["channel"] == "terminalOutput")
            .expect("initial live frame");
        assert_eq!(first_live, 2);
        assert!(frames[..first_live]
            .iter()
            .all(|frame| frame["channel"] == "terminalSnapshot"));
        assert_eq!(
            frames[first_live]["sequence"],
            subscription["firstLiveSequence"]
        );

        let initial_snapshot_bytes: usize = frames[..first_live]
            .iter()
            .map(|frame| {
                STANDARD
                    .decode(frame["dataBase64"].as_str().expect("snapshot dataBase64"))
                    .expect("valid snapshot base64")
                    .len()
            })
            .sum();
        assert_eq!(initial_snapshot_bytes as u64, 94);
        assert_eq!(first_live as u64, 2);

        let gap_frames: Vec<_> = frames
            .iter()
            .filter(|frame| !frame["injectedGap"].is_null())
            .collect();
        assert_eq!(gap_frames.len(), 1);
        let gap = gap_frames[0];
        assert_eq!(gap["sequence"], 7);
        assert_eq!(gap["injectedGap"]["expectedSequence"], 6);
        assert_eq!(gap["injectedGap"]["observedSequence"], 7);
        assert!(array(&gap["flags"], "gap flags")
            .iter()
            .any(|flag| flag == "resync"));

        let descriptor_indexes: Vec<_> = records
            .iter()
            .enumerate()
            .filter(|(_, record)| record["kind"] == "resyncSnapshotDescriptor")
            .collect();
        assert_eq!(descriptor_indexes.len(), 1);
        let (descriptor_index, descriptor) = descriptor_indexes[0];
        assert_eq!(descriptor["scenarioId"], "terminal-sequence-gap-resync");
        assert_eq!(descriptor["trigger"], "FLAG_RESYNC");
        assert_eq!(descriptor["method"], "terminal.snapshot");
        assert_eq!(
            keys(&descriptor["request"]),
            expected_keys(&["subscriptionId", "reason"])
        );
        assert_eq!(descriptor["request"]["reason"], "gap");
        assert_eq!(records[descriptor_index + 1]["channel"], "terminalSnapshot");
        assert_eq!(records[descriptor_index + 1]["sequence"], 8);

        let resize_events: Vec<_> = records
            .iter()
            .filter(|record| record["scenarioId"] == "terminal-resize")
            .collect();
        assert_eq!(resize_events.len(), 1);
        assert_eq!(resize_events[0]["event"], "terminal.resized");
        assert_eq!(resize_events[0]["payload"]["cols"], 120);
        assert_eq!(resize_events[0]["payload"]["rows"], 40);

        let mut combined_text = String::new();
        for frame in frames {
            let decoded = STANDARD
                .decode(frame["dataBase64"].as_str().expect("frame dataBase64"))
                .expect("valid frame base64");
            let decoded = String::from_utf8(decoded).expect("UTF-8 terminal fixture");
            assert_eq!(decoded, frame["textUtf8"].as_str().expect("textUtf8"));
            combined_text.push_str(&decoded);
        }
        assert!(combined_text.contains("\u{1b}[32m"));
        assert!(combined_text.contains("데스크톱"));
        assert!(combined_text.contains("컴파일 완료"));
        assert!(combined_text.contains('✅'));
        assert!(combined_text.contains('🚀'));
        assert!(combined_text.contains('🧪'));
    }

    #[test]
    fn fixture_covers_lease_renew_contention_and_explicit_revoke() {
        let fixture = fixture();
        let scenarios = array(&fixture["leaseScenarios"], "leaseScenarios");
        assert_eq!(scenarios.len(), 3);

        let same_owner = find_by(
            scenarios,
            "scenarioId",
            "lease-same-owner-renew-update",
        );
        assert_eq!(same_owner["ownerDeviceId"], "device-owner-a");
        let transitions = array(&same_owner["transitions"], "lease transitions");
        let actions: Vec<_> = transitions
            .iter()
            .map(|transition| transition["action"].as_str().expect("lease action"))
            .collect();
        assert_eq!(actions, vec!["claim", "renew", "update"]);
        let revisions: Vec<_> = transitions
            .iter()
            .map(|transition| {
                transition["leaseRevision"]
                    .as_u64()
                    .expect("lease revision")
            })
            .collect();
        assert_eq!(revisions, vec![1, 2, 3]);
        assert!(transitions
            .iter()
            .all(|transition| transition["leaseId"] == "lease-alpha-shell"));
        assert_eq!(transitions[2]["cols"], 120);
        assert_eq!(transitions[2]["rows"], 40);
        assert_eq!(transitions[2]["viewportRevision"], 43);

        let busy = find_by(
            scenarios,
            "scenarioId",
            "lease-competing-owner-busy",
        );
        assert_eq!(busy["ownerDeviceId"], "device-owner-a");
        assert_eq!(busy["competingDeviceId"], "device-owner-b");
        assert_eq!(busy["outcome"]["status"], "error");
        assert_eq!(busy["outcome"]["code"], "pane_busy");

        let revoke = find_by(scenarios, "scenarioId", "lease-explicit-revoke");
        let revoke_transitions = array(&revoke["transitions"], "revoke transitions");
        assert_eq!(revoke_transitions.len(), 2);
        assert_eq!(revoke_transitions[0]["event"], "terminal.lease.lost");
        assert_eq!(revoke_transitions[0]["state"], "lost");
        assert_eq!(revoke_transitions[0]["reason"], "explicit_revoke");
        assert_eq!(revoke_transitions[1]["event"], "terminal.lease.changed");
        assert_eq!(revoke_transitions[1]["state"], "released");
        assert_eq!(revoke_transitions[1]["leaseRevision"], 4);
    }

    #[test]
    fn fixture_covers_endpoint_success_staleness_and_identity_failures() {
        let fixture = fixture();
        let scenarios = array(&fixture["endpointScenarios"], "endpointScenarios");
        let ids: Vec<_> = scenarios
            .iter()
            .map(|scenario| scenario["scenarioId"].as_str().expect("endpoint scenario id"))
            .collect();
        assert_eq!(
            ids,
            vec![
                "endpoint-delayed-success",
                "endpoint-stale-failure",
                "identity-mismatch",
                "certificate-pin-mismatch",
            ]
        );
        assert!(scenarios.iter().all(|scenario| scenario["endpoint"]
            .as_str()
            .expect("endpoint")
            .contains("/remote-v2")));

        let delayed = find_by(scenarios, "scenarioId", "endpoint-delayed-success");
        assert_eq!(delayed["delayMs"], 750);
        assert_eq!(delayed["outcome"]["status"], "success");
        assert_eq!(
            delayed["outcome"]["connectedAt"],
            "2026-01-02T03:04:15.750Z"
        );

        let stale = find_by(scenarios, "scenarioId", "endpoint-stale-failure");
        assert_eq!(stale["staleAfterMs"], 60000);
        assert_eq!(stale["outcome"]["status"], "error");
        assert_eq!(stale["outcome"]["code"], "stale_endpoint");

        let identity = find_by(scenarios, "scenarioId", "identity-mismatch");
        assert_ne!(identity["expectedIdentity"], identity["observedIdentity"]);
        assert_eq!(identity["outcome"]["code"], "identity_mismatch");

        let pin = find_by(scenarios, "scenarioId", "certificate-pin-mismatch");
        assert_ne!(pin["expectedPin"], pin["observedPin"]);
        assert_eq!(pin["outcome"]["code"], "certificate_pin_mismatch");
    }
}

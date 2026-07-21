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
        pub const CONTRACT_SHA256: &str =
            "164255ade8e7025b9d8991cef60de89a4c66545eaac88fc7f94413df41705789";
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

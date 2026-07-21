use sha2::{Digest, Sha256};

pub mod relay;
pub mod secure;
pub mod wire;

pub const PROTOCOL_VERSION: u16 = 2;
pub const SUBPROTOCOL: &str = "vibelink-remote-v2";
pub const CONTRACT_SHA256: &str =
    "164255ade8e7025b9d8991cef60de89a4c66545eaac88fc7f94413df41705789";
pub const CONTRACT_JSON: &str = include_str!("../../../../contracts/remote-v2.json");

pub fn contract_hash() -> String {
    Sha256::digest(CONTRACT_JSON.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
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
        assert_eq!(contract["contractVersion"], 2);
        assert_eq!(contract["envelope"]["required"][6], "revocationEpoch");
        assert_eq!(
            contract["binaryFrame"]["headerBytes"],
            wire::BINARY_HEADER_BYTES
        );
        assert_eq!(
            contract["binaryFrame"]["maxPayloadBytes"],
            wire::MAX_BINARY_PAYLOAD_BYTES
        );
        assert_eq!(contract["binaryFrame"]["channels"]["terminalOutput"], 1);
        assert_eq!(contract["revocation"]["disconnectDeadlineMs"], 5000);
        assert_eq!(
            contract["compatibility"]["v1SubprotocolUnchanged"],
            crate::remote::protocol::SUBPROTOCOL
        );
    }
}

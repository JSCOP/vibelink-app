use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use snow::resolvers::{CryptoResolver, DefaultResolver};
use snow::{params::NoiseParams, Builder, HandshakeState, TransportState};
use zeroize::Zeroizing;

const NOISE_PATTERN: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2s";
const MAX_HANDSHAKE_FRAME: usize = 65_535;
const MAX_SECURE_PAYLOAD: usize = 63 * 1024;
const KEYRING_SERVICE: &str = "vibelink.remote.v2";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SecureFrameKind {
    Control,
    Binary,
    Notification,
    TerminalInput,
    TerminalOutput,
    Snapshot,
    Event,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SecureFrame {
    pub sequence: u64,
    pub ack: u64,
    pub kind: SecureFrameKind,
    #[serde(with = "serde_bytes")]
    pub payload: Vec<u8>,
}

pub struct DeviceIdentity {
    private_key: Zeroizing<Vec<u8>>,
    public_key: Vec<u8>,
}

impl DeviceIdentity {
    pub fn load_or_create(account: &str) -> Result<Self> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)?;
        match entry.get_password() {
            Ok(encoded) => Self::from_private_key(
                URL_SAFE_NO_PAD
                    .decode(encoded)
                    .context("decode remote-v2 identity")?,
            ),
            Err(keyring::Error::NoEntry) => {
                let identity = Self::generate()?;
                entry
                    .set_password(&URL_SAFE_NO_PAD.encode(identity.private_key.as_slice()))
                    .context("store remote-v2 identity")?;
                Ok(identity)
            }
            Err(error) => Err(error).context("load remote-v2 identity"),
        }
    }

    pub fn generate() -> Result<Self> {
        let builder = noise_builder()?;
        let keypair = builder
            .generate_keypair()
            .context("generate Noise identity")?;
        Ok(Self {
            private_key: Zeroizing::new(keypair.private),
            public_key: keypair.public,
        })
    }

    pub fn public_key(&self) -> &[u8] {
        &self.public_key
    }

    pub fn fingerprint(&self) -> String {
        fingerprint(&self.public_key)
    }

    fn from_private_key(private_key: Vec<u8>) -> Result<Self> {
        if private_key.len() != 32 {
            bail!("invalid remote-v2 private key length");
        }
        let params: NoiseParams = NOISE_PATTERN.parse().expect("valid Noise pattern");
        let resolver = DefaultResolver;
        let mut keypair = resolver
            .resolve_dh(&params.dh)
            .context("resolve Noise DH")?;
        keypair.set(&private_key);
        let public_key = keypair.pubkey().to_vec();
        if public_key.len() != 32 {
            bail!("invalid derived remote-v2 public key");
        }
        Ok(Self {
            private_key: Zeroizing::new(private_key),
            public_key,
        })
    }
}

pub struct SecureHandshake {
    state: HandshakeState,
}

impl SecureHandshake {
    pub fn initiator(identity: &DeviceIdentity) -> Result<Self> {
        Ok(Self {
            state: noise_builder()?
                .local_private_key(identity.private_key.as_slice())
                .build_initiator()
                .context("build Noise initiator")?,
        })
    }

    pub fn responder(identity: &DeviceIdentity) -> Result<Self> {
        Ok(Self {
            state: noise_builder()?
                .local_private_key(identity.private_key.as_slice())
                .build_responder()
                .context("build Noise responder")?,
        })
    }

    pub fn write(&mut self, payload: &[u8]) -> Result<Vec<u8>> {
        if payload.len() > MAX_SECURE_PAYLOAD {
            bail!("remote-v2 handshake payload too large");
        }
        let mut output = vec![0; MAX_HANDSHAKE_FRAME];
        let written = self
            .state
            .write_message(payload, &mut output)
            .context("write Noise handshake")?;
        output.truncate(written);
        Ok(output)
    }

    pub fn read(&mut self, frame: &[u8]) -> Result<Vec<u8>> {
        if frame.is_empty() || frame.len() > MAX_HANDSHAKE_FRAME {
            bail!("invalid remote-v2 handshake frame length");
        }
        let mut output = vec![0; MAX_HANDSHAKE_FRAME];
        let read = self
            .state
            .read_message(frame, &mut output)
            .context("read Noise handshake")?;
        output.truncate(read);
        Ok(output)
    }

    pub fn finish(self, expected_peer_fingerprint: Option<&str>) -> Result<SecureTransport> {
        if !self.state.is_handshake_finished() {
            bail!("remote-v2 handshake is incomplete");
        }
        let remote_static = self
            .state
            .get_remote_static()
            .context("remote-v2 peer did not present a static identity")?;
        let peer_fingerprint = fingerprint(remote_static);
        if let Some(expected) = expected_peer_fingerprint {
            if expected != peer_fingerprint {
                bail!("remote-v2 peer identity mismatch");
            }
        }
        Ok(SecureTransport {
            state: self
                .state
                .into_transport_mode()
                .context("enter Noise transport mode")?,
            peer_fingerprint,
            next_send_sequence: 1,
            next_receive_sequence: 1,
            last_received_sequence: 0,
            last_acked_by_peer: 0,
        })
    }
}

pub struct SecureTransport {
    state: TransportState,
    peer_fingerprint: String,
    next_send_sequence: u64,
    next_receive_sequence: u64,
    last_received_sequence: u64,
    last_acked_by_peer: u64,
}

impl SecureTransport {
    pub fn peer_fingerprint(&self) -> &str {
        &self.peer_fingerprint
    }

    pub fn last_acked_by_peer(&self) -> u64 {
        self.last_acked_by_peer
    }

    pub fn seal(&mut self, kind: SecureFrameKind, payload: &[u8]) -> Result<Vec<u8>> {
        if payload.len() > MAX_SECURE_PAYLOAD {
            bail!("remote-v2 secure payload too large");
        }
        let frame = SecureFrame {
            sequence: self.next_send_sequence,
            ack: self.last_received_sequence,
            kind,
            payload: payload.to_vec(),
        };
        let encoded = rmp_serde::to_vec_named(&frame).context("encode secure frame")?;
        let mut output = vec![0; encoded.len() + 32];
        let written = self
            .state
            .write_message(&encoded, &mut output)
            .context("encrypt secure frame")?;
        output.truncate(written);
        self.next_send_sequence = self
            .next_send_sequence
            .checked_add(1)
            .context("remote-v2 send sequence exhausted")?;
        Ok(output)
    }

    pub fn open(&mut self, ciphertext: &[u8]) -> Result<SecureFrame> {
        if ciphertext.is_empty() || ciphertext.len() > MAX_HANDSHAKE_FRAME {
            bail!("invalid remote-v2 ciphertext length");
        }
        let mut plaintext = vec![0; ciphertext.len()];
        let read = self
            .state
            .read_message(ciphertext, &mut plaintext)
            .context("decrypt secure frame")?;
        plaintext.truncate(read);
        let frame: SecureFrame =
            rmp_serde::from_slice(&plaintext).context("decode secure frame")?;
        if frame.sequence != self.next_receive_sequence {
            bail!(
                "remote-v2 sequence gap: expected {}, received {}",
                self.next_receive_sequence,
                frame.sequence
            );
        }
        if frame.ack >= self.next_send_sequence {
            bail!("remote-v2 peer acknowledged an unsent frame");
        }
        if frame.payload.len() > MAX_SECURE_PAYLOAD {
            bail!("remote-v2 secure payload too large");
        }
        self.last_received_sequence = frame.sequence;
        self.next_receive_sequence = self
            .next_receive_sequence
            .checked_add(1)
            .context("remote-v2 receive sequence exhausted")?;
        self.last_acked_by_peer = self.last_acked_by_peer.max(frame.ack);
        Ok(frame)
    }
}

fn noise_builder() -> Result<Builder<'static>> {
    let params: NoiseParams = NOISE_PATTERN.parse().context("parse Noise pattern")?;
    Ok(Builder::new(params))
}

fn fingerprint(public_key: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(public_key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transports() -> (SecureTransport, SecureTransport) {
        let initiator_identity = DeviceIdentity::generate().expect("initiator identity");
        let responder_identity = DeviceIdentity::generate().expect("responder identity");
        let mut initiator = SecureHandshake::initiator(&initiator_identity).expect("initiator");
        let mut responder = SecureHandshake::responder(&responder_identity).expect("responder");
        let message_one = initiator.write(b"").expect("message one");
        responder.read(&message_one).expect("read one");
        let message_two = responder.write(b"").expect("message two");
        initiator.read(&message_two).expect("read two");
        let message_three = initiator.write(b"").expect("message three");
        responder.read(&message_three).expect("read three");
        let initiator_transport = initiator
            .finish(Some(&responder_identity.fingerprint()))
            .expect("initiator transport");
        let responder_transport = responder
            .finish(Some(&initiator_identity.fingerprint()))
            .expect("responder transport");
        (initiator_transport, responder_transport)
    }

    #[test]
    fn noise_xx_roundtrip_preserves_order_and_acknowledgement() {
        let (mut initiator, mut responder) = transports();
        let first = initiator
            .seal(SecureFrameKind::TerminalInput, b"pwd\r")
            .expect("seal first");
        let opened = responder.open(&first).expect("open first");
        assert_eq!(opened.sequence, 1);
        assert_eq!(opened.payload, b"pwd\r");
        let response = responder
            .seal(SecureFrameKind::TerminalOutput, b"E:/workspace")
            .expect("seal response");
        initiator.open(&response).expect("open response");
        assert_eq!(initiator.last_acked_by_peer(), 1);
    }

    #[test]
    fn replayed_ciphertext_is_rejected() {
        let (mut initiator, mut responder) = transports();
        let frame = initiator
            .seal(SecureFrameKind::Control, b"status")
            .expect("seal frame");
        responder.open(&frame).expect("open once");
        assert!(responder.open(&frame).is_err());
    }

    #[test]
    fn unexpected_peer_identity_is_rejected() {
        let initiator_identity = DeviceIdentity::generate().expect("initiator identity");
        let responder_identity = DeviceIdentity::generate().expect("responder identity");
        let mut initiator = SecureHandshake::initiator(&initiator_identity).expect("initiator");
        let mut responder = SecureHandshake::responder(&responder_identity).expect("responder");
        responder
            .read(&initiator.write(b"").expect("one"))
            .expect("read one");
        initiator
            .read(&responder.write(b"").expect("two"))
            .expect("read two");
        responder
            .read(&initiator.write(b"").expect("three"))
            .expect("read three");
        assert!(initiator.finish(Some("wrong-fingerprint")).is_err());
    }

    #[test]
    fn notification_metadata_is_only_visible_after_noise_decryption() {
        let (mut initiator, mut responder) = transports();
        let metadata = super::super::wire::OpaqueNotificationMetadata {
            notification_id: "notification-1".to_string(),
            global_sequence: 7,
            kind: "automation.completed".to_string(),
            entity_id: Some("run-1".to_string()),
            metadata: serde_json::json!({"status": "completed"}),
        };
        metadata.validate().unwrap();
        let plaintext = rmp_serde::to_vec_named(&metadata).unwrap();
        let ciphertext = initiator
            .seal(SecureFrameKind::Notification, &plaintext)
            .unwrap();
        assert!(!ciphertext
            .windows("automation.completed".len())
            .any(|window| window == b"automation.completed"));
        let opened = responder.open(&ciphertext).unwrap();
        let decoded: super::super::wire::OpaqueNotificationMetadata =
            rmp_serde::from_slice(&opened.payload).unwrap();
        assert_eq!(decoded, metadata);
    }
}

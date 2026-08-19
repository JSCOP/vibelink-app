use crate::storage::{
    load_with_recovery, parse_json, require_supported_schema, write_json, DocumentError, LoadSource,
};
use anyhow::Result;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const DEVICES_SCHEMA_VERSION: u64 = 1;
const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const LOCKOUT_DURATION: Duration = Duration::from_secs(60);
const MAX_FAILED_ATTEMPTS: u8 = 5;
pub const TERMINAL_VIEW_GRANT: &str = "terminal.view";
pub const TERMINAL_INPUT_GRANT: &str = "terminal.input";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    #[serde(default)]
    pub noise_fingerprint: Option<String>,
    #[serde(default = "initial_revocation_epoch")]
    pub revocation_epoch: u64,
    pub created_at: i64,
    pub last_seen_at: i64,
    #[serde(default = "default_grants")]
    pub grants: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePublic {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
    pub grants: Vec<String>,
    pub revocation_epoch: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeviceAuthorization {
    pub grants: Vec<String>,
    pub revocation_epoch: u64,
}

impl From<&DeviceRecord> for DevicePublic {
    fn from(value: &DeviceRecord) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            created_at: value.created_at,
            last_seen_at: value.last_seen_at,
            grants: value.grants.clone(),
            revocation_epoch: value.revocation_epoch,
        }
    }
}

#[derive(Clone, Debug)]
pub struct PairingInfo {
    pub code: String,
    pub expires_at: i64,
}

#[derive(Clone, Debug)]
struct ActivePairing {
    code: String,
    expires_at: SystemTime,
}

#[derive(Debug)]
pub enum AuthFailure {
    Failed,
    PairExpired,
    RateLimited,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DevicesDocument {
    schema_version: u64,
    #[serde(default)]
    devices: Vec<DeviceRecord>,
    #[serde(default)]
    re_pair_required: bool,
}

struct LoadedDevices {
    document: DevicesDocument,
    legacy: bool,
}

impl Default for LoadedDevices {
    fn default() -> Self {
        Self {
            document: DevicesDocument {
                schema_version: DEVICES_SCHEMA_VERSION,
                devices: Vec::new(),
                re_pair_required: false,
            },
            legacy: false,
        }
    }
}

#[derive(Debug)]
pub struct DeviceStore {
    path: PathBuf,
    records: Vec<DeviceRecord>,
    re_pair_required: bool,
    pairing: Option<ActivePairing>,
    failed_attempts: u8,
    locked_until: Option<SystemTime>,
}

impl DeviceStore {
    pub fn load(path: PathBuf) -> Result<Self> {
        let report = load_with_recovery(&path, LoadedDevices::default(), parse_devices)?;
        let recovered_without_backup =
            report.source == LoadSource::Default && !report.quarantined.is_empty();
        let rewrite = report.value.legacy || report.source == LoadSource::Default;
        let mut records = report.value.document.devices;
        for record in &mut records {
            record.grants.retain(|grant| is_known_grant(grant));
        }
        let store = Self {
            path,
            records,
            re_pair_required: report.value.document.re_pair_required || recovered_without_backup,
            pairing: None,
            failed_attempts: 0,
            locked_until: None,
        };
        if rewrite {
            store.save()?;
        }
        Ok(store)
    }

    pub fn list_public(&self) -> Vec<DevicePublic> {
        self.records.iter().map(DevicePublic::from).collect()
    }

    pub fn contains(&self, device_id: &str) -> bool {
        self.records.iter().any(|record| record.id == device_id)
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    pub fn re_pair_required(&self) -> bool {
        self.re_pair_required
    }

    pub fn create_pairing_code(&mut self) -> PairingInfo {
        let code = format!("{:08}", OsRng.gen_range(0..100_000_000_u32));
        let expires_at = SystemTime::now() + PAIRING_TTL;
        self.pairing = Some(ActivePairing {
            code: code.clone(),
            expires_at,
        });
        PairingInfo {
            code,
            expires_at: unix_secs(expires_at),
        }
    }

    pub fn consume_pairing(
        &mut self,
        code: &str,
        device_name: &str,
    ) -> std::result::Result<(DeviceRecord, String), AuthFailure> {
        self.check_lockout()?;
        let Some(pairing) = self.pairing.clone() else {
            return Err(self.record_failure(AuthFailure::PairExpired));
        };
        if SystemTime::now() > pairing.expires_at {
            self.pairing = None;
            return Err(self.record_failure(AuthFailure::PairExpired));
        }
        if !constant_time_eq(pairing.code.as_bytes(), code.as_bytes()) {
            return Err(self.record_failure(AuthFailure::Failed));
        }

        self.pairing = None;
        self.reset_failures();
        let mut token_bytes = [0_u8; 32];
        OsRng.fill_bytes(&mut token_bytes);
        let token = URL_SAFE_NO_PAD.encode(token_bytes);
        let now = unix_secs(SystemTime::now());
        let record = DeviceRecord {
            id: Uuid::new_v4().to_string(),
            name: sanitize_device_name(device_name),
            token_hash: token_hash(&token),
            noise_fingerprint: None,
            revocation_epoch: initial_revocation_epoch(),
            created_at: now,
            last_seen_at: now,
            grants: default_grants(),
        };
        let previous_re_pair_required = self.re_pair_required;
        self.records.push(record.clone());
        self.re_pair_required = false;
        if self.save().is_err() {
            self.records.pop();
            self.re_pair_required = previous_re_pair_required;
            return Err(AuthFailure::Failed);
        }
        Ok((record, token))
    }

    pub fn verify_token(
        &mut self,
        device_id: &str,
        token: &str,
    ) -> std::result::Result<bool, AuthFailure> {
        self.check_lockout()?;
        let candidate = token_hash(token);
        let Some(record) = self
            .records
            .iter_mut()
            .find(|record| record.id == device_id)
        else {
            return Err(self.record_failure(AuthFailure::Failed));
        };
        if !constant_time_eq(record.token_hash.as_bytes(), candidate.as_bytes()) {
            return Err(self.record_failure(AuthFailure::Failed));
        }
        record.last_seen_at = unix_secs(SystemTime::now());
        self.reset_failures();
        let _ = self.save();
        Ok(true)
    }
    pub fn consume_v2_pairing(
        &mut self,
        code: &str,
        device_name: &str,
        noise_fingerprint: &str,
    ) -> std::result::Result<DeviceRecord, AuthFailure> {
        self.check_lockout()?;
        let Some(pairing) = self.pairing.clone() else {
            return Err(self.record_failure(AuthFailure::PairExpired));
        };
        if SystemTime::now() > pairing.expires_at {
            self.pairing = None;
            return Err(self.record_failure(AuthFailure::PairExpired));
        }
        if !constant_time_eq(pairing.code.as_bytes(), code.as_bytes()) {
            return Err(self.record_failure(AuthFailure::Failed));
        }
        self.pairing = None;
        self.reset_failures();
        let now = unix_secs(SystemTime::now());
        let record = DeviceRecord {
            id: Uuid::new_v4().to_string(),
            name: sanitize_device_name(device_name),
            token_hash: String::new(),
            noise_fingerprint: Some(noise_fingerprint.to_string()),
            revocation_epoch: initial_revocation_epoch(),
            created_at: now,
            last_seen_at: now,
            grants: remote_v2_default_grants(),
        };
        self.records.push(record.clone());
        if self.save().is_err() {
            self.records.pop();
            return Err(AuthFailure::Failed);
        }
        Ok(record)
    }

    pub fn verify_v2_identity(
        &mut self,
        device_id: &str,
        noise_fingerprint: &str,
    ) -> std::result::Result<bool, AuthFailure> {
        self.check_lockout()?;
        let Some(record) = self
            .records
            .iter_mut()
            .find(|record| record.id == device_id)
        else {
            return Err(self.record_failure(AuthFailure::Failed));
        };
        let Some(expected) = record.noise_fingerprint.as_deref() else {
            return Err(self.record_failure(AuthFailure::Failed));
        };
        if !constant_time_eq(expected.as_bytes(), noise_fingerprint.as_bytes()) {
            return Err(self.record_failure(AuthFailure::Failed));
        }
        record.last_seen_at = unix_secs(SystemTime::now());
        self.reset_failures();
        let _ = self.save();
        Ok(true)
    }

    pub fn grants_for(&self, device_id: &str) -> Option<Vec<String>> {
        self.records
            .iter()
            .find(|record| record.id == device_id)
            .map(|record| record.grants.clone())
    }

    pub fn v2_authorization(
        &self,
        device_id: &str,
        noise_fingerprint: &str,
    ) -> Option<DeviceAuthorization> {
        self.records
            .iter()
            .find(|record| {
                record.id == device_id
                    && record.noise_fingerprint.as_deref().is_some_and(|expected| {
                        constant_time_eq(expected.as_bytes(), noise_fingerprint.as_bytes())
                    })
            })
            .map(|record| DeviceAuthorization {
                grants: record.grants.clone(),
                revocation_epoch: record.revocation_epoch,
            })
    }

    pub fn update_grants(&mut self, device_id: &str, grants: Vec<String>) -> Result<u64> {
        if grants.iter().any(|grant| !is_known_grant(grant)) {
            anyhow::bail!("unknown remote grant");
        }
        let record = self
            .records
            .iter_mut()
            .find(|record| record.id == device_id)
            .ok_or_else(|| anyhow::anyhow!("remote device not found"))?;
        record.grants = grants;
        record.revocation_epoch = record.revocation_epoch.saturating_add(1);
        let epoch = record.revocation_epoch;
        self.save()?;
        Ok(epoch)
    }

    pub fn revoke(&mut self, device_id: &str) -> Result<()> {
        self.records.retain(|record| record.id != device_id);
        self.save()
    }

    pub fn reset_for_identity_change(&mut self) -> Result<()> {
        self.records.clear();
        self.pairing = None;
        self.re_pair_required = true;
        self.save()
    }

    fn check_lockout(&mut self) -> std::result::Result<(), AuthFailure> {
        if let Some(until) = self.locked_until {
            if SystemTime::now() < until {
                return Err(AuthFailure::RateLimited);
            }
            self.reset_failures();
        }
        Ok(())
    }

    fn record_failure(&mut self, original: AuthFailure) -> AuthFailure {
        self.failed_attempts = self.failed_attempts.saturating_add(1);
        if self.failed_attempts >= MAX_FAILED_ATTEMPTS {
            self.locked_until = Some(SystemTime::now() + LOCKOUT_DURATION);
            AuthFailure::RateLimited
        } else {
            original
        }
    }

    fn reset_failures(&mut self) {
        self.failed_attempts = 0;
        self.locked_until = None;
    }

    fn save(&self) -> Result<()> {
        write_json(
            &self.path,
            &DevicesDocument {
                schema_version: DEVICES_SCHEMA_VERSION,
                devices: self.records.clone(),
                re_pair_required: self.re_pair_required,
            },
        )
    }
}
fn default_grants() -> Vec<String> {
    vec![
        TERMINAL_VIEW_GRANT.to_string(),
        TERMINAL_INPUT_GRANT.to_string(),
    ]
}

fn initial_revocation_epoch() -> u64 {
    1
}

fn remote_v2_default_grants() -> Vec<String> {
    // Least privilege, and what the contract's `defaultPairingGrants` declares.
    // A freshly paired phone sees only the terminal; everything else is granted
    // per device in Settings > Remote. Handing out `admin` on pairing made the
    // grant model decorative.
    vec![
        TERMINAL_VIEW_GRANT.to_string(),
        TERMINAL_INPUT_GRANT.to_string(),
    ]
}

fn is_known_grant(grant: &str) -> bool {
    matches!(
        grant,
        TERMINAL_VIEW_GRANT
            | TERMINAL_INPUT_GRANT
            | "orchestration.view"
            | "orchestration.control"
            | "browser.view"
            | "browser.control"
            | "files.view"
            | "git.write"
            | "computer.observe"
            | "computer.control"
            | "admin"
    )
}

fn parse_devices(bytes: &[u8]) -> std::result::Result<LoadedDevices, DocumentError> {
    let value: serde_json::Value = parse_json(bytes)?;
    if value.get("schemaVersion").is_some() {
        let document: DevicesDocument = serde_json::from_value(value)?;
        require_supported_schema(document.schema_version, DEVICES_SCHEMA_VERSION)?;
        Ok(LoadedDevices {
            document,
            legacy: false,
        })
    } else {
        Ok(LoadedDevices {
            document: DevicesDocument {
                schema_version: DEVICES_SCHEMA_VERSION,
                devices: serde_json::from_value(value)?,
                re_pair_required: false,
            },
            legacy: true,
        })
    }
}

fn token_hash(token: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(token.as_bytes()))
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |diff, (a, b)| diff | (a ^ b))
        == 0
}

fn sanitize_device_name(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "Android device".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn unix_secs(value: SystemTime) -> i64 {
    value
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn store() -> DeviceStore {
        DeviceStore::load(
            std::env::temp_dir().join(format!("vibelink-remote-devices-{}.json", Uuid::new_v4())),
        )
        .unwrap()
    }

    fn path(label: &str) -> PathBuf {
        std::env::temp_dir()
            .join(format!(
                "vibelink-remote-devices-{label}-{}",
                Uuid::new_v4()
            ))
            .join("devices.json")
    }

    #[test]
    fn pairing_consumes_once_and_tokens_verify() {
        let path = path("pairing");
        let mut store = DeviceStore::load(path.clone()).unwrap();
        let pairing = store.create_pairing_code();
        let (record, token) = store.consume_pairing(&pairing.code, "Phone").unwrap();
        assert!(store.verify_token(&record.id, &token).unwrap());
        assert!(matches!(
            store.consume_pairing(&pairing.code, "Other"),
            Err(AuthFailure::PairExpired)
        ));
        let _ = fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn five_failures_trigger_rate_limit() {
        let path = path("rate-limit");
        let mut store = DeviceStore::load(path.clone()).unwrap();
        let pairing = store.create_pairing_code();
        for _ in 0..4 {
            assert!(matches!(
                store.consume_pairing("00000000", "Phone"),
                Err(AuthFailure::Failed)
            ));
        }
        assert!(matches!(
            store.consume_pairing("00000000", "Phone"),
            Err(AuthFailure::RateLimited)
        ));
        assert!(matches!(
            store.consume_pairing(&pairing.code, "Phone"),
            Err(AuthFailure::RateLimited)
        ));
    }

    #[test]
    fn v2_authorization_rechecks_identity_grants_and_epoch() {
        let mut store = store();
        let pairing = store.create_pairing_code();
        let record = store
            .consume_v2_pairing(&pairing.code, "Phone", "noise-fingerprint")
            .unwrap();
        let initial = store
            .v2_authorization(&record.id, "noise-fingerprint")
            .unwrap();
        assert_eq!(initial.revocation_epoch, 1);
        assert!(store
            .v2_authorization(&record.id, "wrong-identity")
            .is_none());

        let next_epoch = store
            .update_grants(&record.id, vec![TERMINAL_VIEW_GRANT.to_string()])
            .unwrap();
        let changed = store
            .v2_authorization(&record.id, "noise-fingerprint")
            .unwrap();
        assert_eq!(changed.revocation_epoch, next_epoch);
        assert_eq!(changed.grants, vec![TERMINAL_VIEW_GRANT]);

        store.revoke(&record.id).unwrap();
        assert!(store
            .v2_authorization(&record.id, "noise-fingerprint")
            .is_none());
    }
}

use anyhow::{Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, Rng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use uuid::Uuid;

const PAIRING_TTL: Duration = Duration::from_secs(5 * 60);
const LOCKOUT_DURATION: Duration = Duration::from_secs(60);
const MAX_FAILED_ATTEMPTS: u8 = 5;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    pub id: String,
    pub name: String,
    pub token_hash: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePublic {
    pub id: String,
    pub name: String,
    pub created_at: i64,
    pub last_seen_at: i64,
}

impl From<&DeviceRecord> for DevicePublic {
    fn from(value: &DeviceRecord) -> Self {
        Self {
            id: value.id.clone(),
            name: value.name.clone(),
            created_at: value.created_at,
            last_seen_at: value.last_seen_at,
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

pub struct DeviceStore {
    path: PathBuf,
    records: Vec<DeviceRecord>,
    pairing: Option<ActivePairing>,
    failed_attempts: u8,
    locked_until: Option<SystemTime>,
}

impl DeviceStore {
    pub fn load(path: PathBuf) -> Result<Self> {
        let records = if path.exists() {
            serde_json::from_slice(
                &fs::read(&path).with_context(|| format!("read {}", path.display()))?,
            )
            .with_context(|| format!("parse {}", path.display()))?
        } else {
            Vec::new()
        };
        Ok(Self {
            path,
            records,
            pairing: None,
            failed_attempts: 0,
            locked_until: None,
        })
    }

    pub fn list_public(&self) -> Vec<DevicePublic> {
        self.records.iter().map(DevicePublic::from).collect()
    }

    pub fn contains(&self, device_id: &str) -> bool {
        self.records.iter().any(|record| record.id == device_id)
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
            created_at: now,
            last_seen_at: now,
        };
        self.records.push(record.clone());
        if self.save().is_err() {
            self.records.pop();
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

    pub fn revoke(&mut self, device_id: &str) -> Result<()> {
        self.records.retain(|record| record.id != device_id);
        self.save()
    }

    pub fn revoke_all(&mut self) -> Result<()> {
        self.records.clear();
        self.pairing = None;
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
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = temporary_path(&self.path);
        fs::write(&temporary, serde_json::to_vec_pretty(&self.records)?)?;
        fs::rename(&temporary, &self.path)?;
        Ok(())
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

fn temporary_path(path: &Path) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(".tmp");
    PathBuf::from(value)
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

    fn store() -> DeviceStore {
        DeviceStore::load(
            std::env::temp_dir().join(format!("vibelink-remote-devices-{}.json", Uuid::new_v4())),
        )
        .unwrap()
    }

    #[test]
    fn pairing_consumes_once_and_tokens_verify() {
        let mut store = store();
        let pairing = store.create_pairing_code();
        let (record, token) = store.consume_pairing(&pairing.code, "Phone").unwrap();
        assert!(store.verify_token(&record.id, &token).unwrap());
        assert!(matches!(
            store.consume_pairing(&pairing.code, "Other"),
            Err(AuthFailure::PairExpired)
        ));
    }

    #[test]
    fn five_failures_trigger_rate_limit() {
        let mut store = store();
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
}

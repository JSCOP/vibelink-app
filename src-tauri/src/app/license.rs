use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, RwLock},
    time::Duration,
};
use uuid::Uuid;

const LICENSE_API_ORIGIN: &str = env!("VIBELINK_LICENSE_API_URL");
const CREDENTIAL_ACCOUNT: &str = "active-license";
const PRO_REQUIRED_ERROR: &str = "VibeLink Pro license required.";

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseDeviceDto {
    pub activation_id: String,
    pub device_id: String,
    pub device_name: String,
    pub app_version: String,
    pub status: String,
    pub activated_at: Option<String>,
    pub last_validated_at: Option<String>,
    pub current: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatusDto {
    pub state: String,
    pub entitled: bool,
    pub provider: Option<String>,
    pub masked_key: Option<String>,
    pub activation_id: Option<String>,
    pub device_id: String,
    pub device_name: String,
    pub max_devices: u8,
    pub devices: Vec<LicenseDeviceDto>,
    pub validated_at: Option<String>,
    pub offline_grace_until: Option<String>,
    pub purchase_url: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiLicenseDto {
    valid: bool,
    provider: String,
    entitlement: String,
    activation_id: String,
    masked_key: String,
    max_devices: u8,
    devices: Vec<LicenseDeviceDto>,
    validated_at: String,
    offline_grace_until: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiBusinessError {
    code: String,
    provider: Option<String>,
    masked_key: Option<String>,
    max_devices: Option<u8>,
    devices: Option<Vec<LicenseDeviceDto>>,
    validated_at: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLicense {
    license_key: String,
    provider: String,
    masked_key: String,
    activation_id: String,
    max_devices: u8,
    devices: Vec<LicenseDeviceDto>,
    validated_at: String,
    offline_grace_until: String,
    last_observed_at: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    device_id: String,
    device_name: String,
}

pub struct LicenseService {
    agent: ureq::Agent,
    device: DeviceIdentity,
    credential: Entry,
    cache: RwLock<Option<StoredLicense>>,
}

impl LicenseService {
    pub fn new() -> Result<Self> {
        let service = if cfg!(debug_assertions) {
            "com.vibelink.desktop.dev.license"
        } else {
            "com.vibelink.desktop.license"
        };
        let credential = Entry::new(service, CREDENTIAL_ACCOUNT)
            .context("open Windows Credential Manager entry")?;
        let cache = match credential.get_password() {
            Ok(json) => Some(serde_json::from_str(&json).context("parse stored license credential")?),
            Err(keyring::Error::NoEntry) => None,
            Err(error) => return Err(anyhow!(error).context("read Windows Credential Manager")),
        };
        Ok(Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(5))
                .timeout_read(Duration::from_secs(10))
                .user_agent(&format!("VibeLink/{}", env!("CARGO_PKG_VERSION")))
                .build(),
            device: load_or_create_device_identity()?,
            credential,
            cache: RwLock::new(cache),
        })
    }

    pub fn status(&self) -> Result<LicenseStatusDto> {
        let cache = self.cache.read().map_err(|_| anyhow!("license cache poisoned"))?;
        Ok(status_from_cache(cache.as_ref(), &self.device, Utc::now()))
    }

    pub fn activate(&self, license_key: String) -> Result<LicenseStatusDto> {
        let body = serde_json::json!({
            "licenseKey": license_key,
            "deviceId": self.device.device_id,
            "deviceName": self.device.device_name,
            "appVersion": env!("CARGO_PKG_VERSION"),
        });
        match self.post("/api/license/activate", body) {
            Ok(api) => self.store_online(license_key, api),
            Err(HttpOutcome::Business(error)) => Ok(self.business_status(error)),
            Err(HttpOutcome::Unavailable) => {
                let mut status = self.network_status();
                if !status.entitled {
                    status.state = "configurationError".to_string();
                    status.message = format!("License service is unreachable at {LICENSE_API_ORIGIN}.");
                }
                Ok(status)
            }
            Err(HttpOutcome::Malformed(message)) => Err(anyhow!(message)),
        }
    }

    pub fn revalidate(&self) -> Result<LicenseStatusDto> {
        let stored = self.cache.read().map_err(|_| anyhow!("license cache poisoned"))?.clone();
        let Some(stored) = stored else {
            return self.status();
        };
        let body = serde_json::json!({
            "licenseKey": stored.license_key,
            "activationId": stored.activation_id,
            "deviceId": self.device.device_id,
            "appVersion": env!("CARGO_PKG_VERSION"),
        });
        match self.post("/api/license/validate", body) {
            Ok(api) => self.store_online(stored.license_key, api),
            Err(HttpOutcome::Business(error)) => {
                if error.code == "LICENSE_INACTIVE" {
                    self.clear_credential()?;
                }
                Ok(self.business_status(error))
            }
            Err(HttpOutcome::Unavailable) => Ok(self.network_status()),
            Err(HttpOutcome::Malformed(message)) => Err(anyhow!(message)),
        }
    }

    pub fn deactivate_device(&self, activation_id: String) -> Result<LicenseStatusDto> {
        let stored = self.cache.read().map_err(|_| anyhow!("license cache poisoned"))?.clone();
        let Some(stored) = stored else {
            return self.status();
        };
        let target = stored.devices.iter().find(|device| device.activation_id == activation_id);
        let target_device_id = target.map(|device| device.device_id.clone()).unwrap_or_else(|| self.device.device_id.clone());
        let body = serde_json::json!({
            "licenseKey": stored.license_key,
            "activationId": activation_id,
            "deviceId": target_device_id,
        });
        match self.post("/api/license/deactivate", body) {
            Ok(api) => {
                if api.activation_id == stored.activation_id || target_device_id == self.device.device_id {
                    self.clear_credential()?;
                    self.status()
                } else {
                    self.store_online(stored.license_key, api)
                }
            }
            Err(HttpOutcome::Business(error)) => Ok(self.business_status(error)),
            Err(HttpOutcome::Unavailable) => Ok(self.network_status()),
            Err(HttpOutcome::Malformed(message)) => Err(anyhow!(message)),
        }
    }

    pub fn forget_local(&self) -> Result<LicenseStatusDto> {
        self.clear_credential()?;
        self.status()
    }

    pub fn require_pro_cached(&self) -> Result<()> {
        let status = self.status()?;
        if status.entitled {
            Ok(())
        } else {
            Err(anyhow!(PRO_REQUIRED_ERROR))
        }
    }

    fn post(&self, path: &str, body: serde_json::Value) -> std::result::Result<ApiLicenseDto, HttpOutcome> {
        let url = format!("{LICENSE_API_ORIGIN}{path}");
        match self.agent.post(&url).send_json(body) {
            Ok(response) => response.into_json::<ApiLicenseDto>().map_err(|error| HttpOutcome::Malformed(error.to_string())),
            Err(ureq::Error::Status(status, response)) => {
                let error = response.into_json::<ApiBusinessError>().map_err(|parse| HttpOutcome::Malformed(parse.to_string()))?;
                if status == 403 || status == 409 {
                    Err(HttpOutcome::Business(error))
                } else if status == 429 || status >= 500 {
                    Err(HttpOutcome::Unavailable)
                } else {
                    Err(HttpOutcome::Malformed(format!("license API returned HTTP {status}")))
                }
            }
            Err(ureq::Error::Transport(_)) => Err(HttpOutcome::Unavailable),
        }
    }

    fn store_online(&self, license_key: String, api: ApiLicenseDto) -> Result<LicenseStatusDto> {
        if !api.valid || api.entitlement != "pro" || api.max_devices != 3 {
            return Err(anyhow!("license API returned an invalid entitlement"));
        }
        let now = Utc::now().to_rfc3339();
        let stored = StoredLicense {
            license_key,
            provider: api.provider.clone(),
            masked_key: api.masked_key.clone(),
            activation_id: api.activation_id.clone(),
            max_devices: api.max_devices,
            devices: api.devices.clone(),
            validated_at: api.validated_at.clone(),
            offline_grace_until: api.offline_grace_until.clone(),
            last_observed_at: now,
        };
        self.write_credential(&stored)?;
        *self.cache.write().map_err(|_| anyhow!("license cache poisoned"))? = Some(stored);
        Ok(LicenseStatusDto {
            state: "validOnline".to_string(),
            entitled: true,
            provider: Some(api.provider),
            masked_key: Some(api.masked_key),
            activation_id: Some(api.activation_id),
            device_id: self.device.device_id.clone(),
            device_name: self.device.device_name.clone(),
            max_devices: api.max_devices,
            devices: api.devices,
            validated_at: Some(api.validated_at),
            offline_grace_until: Some(api.offline_grace_until),
            purchase_url: purchase_url(),
            message: "VibeLink Pro is active.".to_string(),
        })
    }

    fn business_status(&self, error: ApiBusinessError) -> LicenseStatusDto {
        let state = match error.code.as_str() {
            "ACTIVATION_LIMIT_REACHED" => "activationLimit",
            "ACTIVATION_REVIEW_REQUIRED" => "reviewRequired",
            "LICENSE_INACTIVE" => "revoked",
            _ => "invalid",
        };
        LicenseStatusDto {
            state: state.to_string(),
            entitled: false,
            provider: error.provider,
            masked_key: error.masked_key,
            activation_id: None,
            device_id: self.device.device_id.clone(),
            device_name: self.device.device_name.clone(),
            max_devices: error.max_devices.unwrap_or(3),
            devices: error.devices.unwrap_or_default(),
            validated_at: error.validated_at,
            offline_grace_until: None,
            purchase_url: purchase_url(),
            message: error.code,
        }
    }

    fn network_status(&self) -> LicenseStatusDto {
        self.status().unwrap_or_else(|_| configuration_error_status(&self.device, "License service is unavailable."))
    }

    fn write_credential(&self, stored: &StoredLicense) -> Result<()> {
        self.credential
            .set_password(&serde_json::to_string(stored)?)
            .map_err(|error| anyhow!(error).context("write Windows Credential Manager"))
    }

    fn clear_credential(&self) -> Result<()> {
        match self.credential.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => {}
            Err(error) => return Err(anyhow!(error).context("delete Windows Credential Manager entry")),
        }
        *self.cache.write().map_err(|_| anyhow!("license cache poisoned"))? = None;
        Ok(())
    }
}

pub struct HeadlessLicenseCache {
    stored: Option<StoredLicense>,
}

impl HeadlessLicenseCache {
    pub fn load() -> Result<Self> {
        let service = if cfg!(debug_assertions) {
            "com.vibelink.desktop.dev.license"
        } else {
            "com.vibelink.desktop.license"
        };
        let entry = Entry::new(service, CREDENTIAL_ACCOUNT)
            .context("open Windows Credential Manager entry")?;
        let stored = match entry.get_password() {
            Ok(json) => Some(serde_json::from_str(&json).context("parse stored license credential")?),
            Err(keyring::Error::NoEntry) => None,
            Err(error) => return Err(anyhow!(error).context("read Windows Credential Manager")),
        };
        Ok(Self { stored })
    }

    pub fn require_pro(&self) -> Result<()> {
        let Some(stored) = self.stored.as_ref() else {
            return Err(anyhow!(PRO_REQUIRED_ERROR));
        };
        let now = Utc::now();
        let validated_at = DateTime::parse_from_rfc3339(&stored.validated_at)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|_| anyhow!(PRO_REQUIRED_ERROR))?;
        let grace_until = DateTime::parse_from_rfc3339(&stored.offline_grace_until)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|_| anyhow!(PRO_REQUIRED_ERROR))?;
        let last_observed = DateTime::parse_from_rfc3339(&stored.last_observed_at)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|_| anyhow!(PRO_REQUIRED_ERROR))?;
        if now > grace_until
            || now < validated_at - ChronoDuration::minutes(5)
            || now < last_observed - ChronoDuration::minutes(5)
        {
            return Err(anyhow!(PRO_REQUIRED_ERROR));
        }
        Ok(())
    }

    pub fn is_entitled(&self) -> bool {
        self.require_pro().is_ok()
    }
}

#[derive(Debug)]
enum HttpOutcome {
    Business(ApiBusinessError),
    Unavailable,
    Malformed(String),
}

fn status_from_cache(stored: Option<&StoredLicense>, device: &DeviceIdentity, now: DateTime<Utc>) -> LicenseStatusDto {
    let Some(stored) = stored else {
        return unlicensed_status(device);
    };
    let validated_at = DateTime::parse_from_rfc3339(&stored.validated_at).map(|value| value.with_timezone(&Utc));
    let grace_until = DateTime::parse_from_rfc3339(&stored.offline_grace_until).map(|value| value.with_timezone(&Utc));
    let last_observed = DateTime::parse_from_rfc3339(&stored.last_observed_at).map(|value| value.with_timezone(&Utc));
    let rollback = validated_at.as_ref().is_ok_and(|value| now < *value - ChronoDuration::minutes(5))
        || last_observed.as_ref().is_ok_and(|value| now < *value - ChronoDuration::minutes(5));
    let entitled = !rollback && grace_until.as_ref().is_ok_and(|value| now <= *value);
    LicenseStatusDto {
        state: if rollback {
            "invalid".to_string()
        } else if entitled {
            "validOffline".to_string()
        } else {
            "invalid".to_string()
        },
        entitled,
        provider: Some(stored.provider.clone()),
        masked_key: Some(stored.masked_key.clone()),
        activation_id: Some(stored.activation_id.clone()),
        device_id: device.device_id.clone(),
        device_name: device.device_name.clone(),
        max_devices: stored.max_devices,
        devices: stored.devices.clone(),
        validated_at: Some(stored.validated_at.clone()),
        offline_grace_until: Some(stored.offline_grace_until.clone()),
        purchase_url: purchase_url(),
        message: if rollback {
            "System clock rollback detected. Connect to validate VibeLink Pro.".to_string()
        } else if entitled {
            "Using the last online validation within the 7-day offline grace period.".to_string()
        } else {
            "Connect to validate VibeLink Pro.".to_string()
        },
    }
}

fn unlicensed_status(device: &DeviceIdentity) -> LicenseStatusDto {
    LicenseStatusDto {
        state: "unlicensed".to_string(),
        entitled: false,
        provider: None,
        masked_key: None,
        activation_id: None,
        device_id: device.device_id.clone(),
        device_name: device.device_name.clone(),
        max_devices: 3,
        devices: Vec::new(),
        validated_at: None,
        offline_grace_until: None,
        purchase_url: purchase_url(),
        message: "Activate VibeLink Pro to unlock agent workflows.".to_string(),
    }
}

fn configuration_error_status(device: &DeviceIdentity, message: &str) -> LicenseStatusDto {
    let mut status = unlicensed_status(device);
    status.state = "configurationError".to_string();
    status.message = message.to_string();
    status
}

fn purchase_url() -> String {
    format!("{LICENSE_API_ORIGIN}/pricing")
}

fn load_or_create_device_identity() -> Result<DeviceIdentity> {
    let path = crate::daemon::paths::daemon_paths()?.data_dir.join("license-device.json");
    if path.exists() {
        let identity: DeviceIdentity = serde_json::from_str(&fs::read_to_string(&path).context("read license device identity")?)
            .context("parse license device identity")?;
        Uuid::parse_str(&identity.device_id).context("validate license device id")?;
        return Ok(identity);
    }
    let device_name = std::env::var("COMPUTERNAME")
        .unwrap_or_else(|_| "Windows device".to_string())
        .chars()
        .filter(|character| !character.is_control())
        .take(64)
        .collect::<String>();
    let identity = DeviceIdentity {
        device_id: Uuid::new_v4().to_string(),
        device_name: if device_name.is_empty() { "Windows device".to_string() } else { device_name },
    };
    write_atomic_json(path, &identity)?;
    Ok(identity)
}

fn write_atomic_json(path: PathBuf, value: &impl Serialize) -> Result<()> {
    let parent = path.parent().ok_or_else(|| anyhow!("license device path has no parent"))?;
    fs::create_dir_all(parent)?;
    let temp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&temp).context("create license device temp file")?;
        file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
        file.flush()?;
        file.sync_all()?;
    }
    fs::rename(&temp, &path).context("replace license device identity")?;
    Ok(())
}

#[tauri::command]
pub async fn license_status(service: tauri::State<'_, Arc<LicenseService>>) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.status().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_activate(service: tauri::State<'_, Arc<LicenseService>>, license_key: String) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.activate(license_key).map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_revalidate(service: tauri::State<'_, Arc<LicenseService>>) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.revalidate().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_deactivate_device(service: tauri::State<'_, Arc<LicenseService>>, activation_id: String) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.deactivate_device(activation_id).map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_forget_local(service: tauri::State<'_, Arc<LicenseService>>) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.forget_local().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device() -> DeviceIdentity {
        DeviceIdentity { device_id: Uuid::new_v4().to_string(), device_name: "Test device".to_string() }
    }

    fn stored(validated_at: DateTime<Utc>, grace_until: DateTime<Utc>, last_observed_at: DateTime<Utc>) -> StoredLicense {
        StoredLicense {
            license_key: "VBL-7F3K-9PQ2-XR8M-4DZH".to_string(),
            provider: "vibelink".to_string(),
            masked_key: "VBL-••••-••••-••••-4DZH".to_string(),
            activation_id: Uuid::new_v4().to_string(),
            max_devices: 3,
            devices: Vec::new(),
            validated_at: validated_at.to_rfc3339(),
            offline_grace_until: grace_until.to_rfc3339(),
            last_observed_at: last_observed_at.to_rfc3339(),
        }
    }

    #[test]
    fn offline_grace_includes_exact_boundary_and_excludes_after() {
        let now = Utc::now();
        let cache = stored(now - ChronoDuration::days(7), now, now - ChronoDuration::hours(1));
        assert!(status_from_cache(Some(&cache), &device(), now).entitled);
        assert!(!status_from_cache(Some(&cache), &device(), now + ChronoDuration::milliseconds(1)).entitled);
    }

    #[test]
    fn clock_rollback_locks_offline_entitlement() {
        let now = Utc::now();
        let cache = stored(now + ChronoDuration::minutes(6), now + ChronoDuration::days(7), now);
        let status = status_from_cache(Some(&cache), &device(), now);
        assert!(!status.entitled);
        assert_eq!(status.state, "invalid");
    }
}

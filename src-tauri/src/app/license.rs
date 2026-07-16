use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use keyring::Entry;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{Arc, RwLock},
    time::Duration,
};
use uuid::Uuid;

const LICENSE_API_ORIGIN: &str = env!("VIBELINK_LICENSE_API_URL");
const CREDENTIAL_ACCOUNT: &str = "moobang-account";
const LEGACY_CREDENTIAL_ACCOUNT: &str = "active-license";
const ACCOUNT_CLIENT_ID: &str = "vibelink-desktop";
const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";
const ACCOUNT_PROVIDER: &str = "moobang";
const PRO_REQUIRED_ERROR: &str = "VibeLink Pro license required.";

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LicenseStatusDto {
    pub state: String,
    pub entitled: bool,
    pub plan: Option<String>,
    pub provider: Option<String>,
    pub email: Option<String>,
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

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSignInStartDto {
    pub user_code: String,
    pub verification_uri_complete: String,
    pub device_code: String,
    pub interval: u64,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum AccountSignInPollResult {
    Pending(String),
    Status(LicenseStatusDto),
}

#[derive(Clone, Debug, Deserialize)]
struct ApiDeviceCodeDto {
    device_code: String,
    user_code: String,
    verification_uri_complete: String,
    interval: u64,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiDeviceTokenDto {
    access_token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiAccountEntitlementDto {
    state: String,
    entitled: bool,
    plan: String,
    provider: Option<String>,
    email: String,
    activation_id: Option<String>,
    device_id: String,
    device_name: String,
    max_devices: u8,
    devices: Vec<LicenseDeviceDto>,
    validated_at: Option<String>,
    offline_grace_until: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiAccountOverviewDto {
    plan: String,
    devices: Vec<LicenseDeviceDto>,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiErrorDto {
    #[serde(alias = "error")]
    code: String,
    #[serde(default, alias = "error_description")]
    description: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAccount {
    session_token: String,
    plan: Option<String>,
    provider: Option<String>,
    email: Option<String>,
    activation_id: Option<String>,
    max_devices: u8,
    devices: Vec<LicenseDeviceDto>,
    validated_at: Option<String>,
    offline_grace_until: Option<String>,
    last_observed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_session_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_device_code: Option<String>,
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
    cache: RwLock<Option<StoredAccount>>,
}

impl LicenseService {
    pub fn new() -> Result<Self> {
        let service = credential_service();
        remove_legacy_credential(service)?;
        let credential = Entry::new(service, CREDENTIAL_ACCOUNT)
            .context("open Windows Credential Manager account entry")?;
        let cache = read_credential(&credential)?;
        Ok(Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(5))
                .timeout_read(Duration::from_secs(10))
                .redirects(0)
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

    pub fn start_sign_in(&self) -> Result<AccountSignInStartDto> {
        let body = serde_json::json!({
            "client_id": ACCOUNT_CLIENT_ID,
            "scope": "openid profile email",
        });
        let api: ApiDeviceCodeDto = match self.post_json("/api/auth/device/code", body, None) {
            Ok(api) => api,
            Err(HttpOutcome::Business(error)) => return Err(api_error(error)),
            Err(HttpOutcome::Unavailable) => {
                return Err(anyhow!("Account service is unreachable at {LICENSE_API_ORIGIN}."));
            }
            Err(HttpOutcome::Malformed(message)) => return Err(anyhow!(message)),
        };
        if api.device_code.is_empty() || api.user_code.is_empty() || api.interval == 0 {
            return Err(anyhow!("account service returned an invalid device authorization response"));
        }
        let expected_prefix = format!("{LICENSE_API_ORIGIN}/");
        if !api.verification_uri_complete.starts_with(&expected_prefix) {
            return Err(anyhow!("account service returned a verification URL outside the configured origin"));
        }
        Ok(AccountSignInStartDto {
            user_code: api.user_code,
            verification_uri_complete: api.verification_uri_complete,
            device_code: api.device_code,
            interval: api.interval,
        })
    }

    pub fn poll_sign_in(&self, device_code: String) -> Result<AccountSignInPollResult> {
        if device_code.is_empty() {
            return Err(anyhow!("device code is required"));
        }
        let retry_token = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?
            .as_ref()
            .filter(|stored| stored.pending_device_code.as_deref() == Some(device_code.as_str()))
            .map(|stored| {
                stored
                    .pending_session_token
                    .clone()
                    .unwrap_or_else(|| stored.session_token.clone())
            });
        let session_token = if let Some(token) = retry_token {
            token
        } else {
            let body = serde_json::json!({
                "grant_type": DEVICE_CODE_GRANT,
                "device_code": device_code,
                "client_id": ACCOUNT_CLIENT_ID,
            });
            let token: ApiDeviceTokenDto = match self.post_json("/api/auth/device/token", body, None) {
                Ok(token) => token,
                Err(HttpOutcome::Business(error)) if token_error_is_pending(&error.code) => {
                    return Ok(AccountSignInPollResult::Pending("pending".to_string()));
                }
                Err(HttpOutcome::Business(error)) => return Err(api_error(error)),
                Err(HttpOutcome::Unavailable) => {
                    return Ok(AccountSignInPollResult::Status(self.configuration_or_offline_status(
                        &format!("Account service is unreachable at {LICENSE_API_ORIGIN}."),
                    )));
                }
                Err(HttpOutcome::Malformed(message)) => return Err(anyhow!(message)),
            };
            if token.access_token.is_empty() {
                return Err(anyhow!("account service returned an empty session token"));
            }
            let mut pending = self
                .cache
                .read()
                .map_err(|_| anyhow!("license cache poisoned"))?
                .clone()
                .unwrap_or_else(|| StoredAccount {
                    session_token: String::new(),
                    plan: None,
                    provider: None,
                    email: None,
                    activation_id: None,
                    max_devices: 3,
                    devices: Vec::new(),
                    validated_at: None,
                    offline_grace_until: None,
                    last_observed_at: None,
                    pending_session_token: None,
                    pending_device_code: None,
                });
            if pending.plan.is_some() && !pending.session_token.is_empty() {
                pending.pending_session_token = Some(token.access_token.clone());
            } else {
                pending.session_token = token.access_token.clone();
                pending.pending_session_token = None;
            }
            pending.pending_device_code = Some(device_code);
            self.store_credential(pending)?;
            token.access_token
        };
        Ok(AccountSignInPollResult::Status(self.resolve_entitlement(&session_token, true)?))
    }

    pub fn revalidate(&self) -> Result<LicenseStatusDto> {
        let stored = self.cache.read().map_err(|_| anyhow!("license cache poisoned"))?.clone();
        let Some(stored) = stored else {
            return self.status();
        };
        self.resolve_entitlement(&stored.session_token, false)
    }

    pub fn deactivate_device(&self, activation_id: String) -> Result<LicenseStatusDto> {
        let stored = self.cache.read().map_err(|_| anyhow!("license cache poisoned"))?.clone();
        let Some(mut stored) = stored else {
            return self.status();
        };
        let removing_current = stored.activation_id.as_deref() == Some(activation_id.as_str())
            || stored.devices.iter().any(|device| {
                device.activation_id == activation_id
                    && (device.current || device.device_id == self.device.device_id)
            });
        let body = serde_json::json!({ "activationId": activation_id });
        match self.post_json::<ApiAccountOverviewDto>(
            "/api/account/device/deactivate",
            body,
            Some(&stored.session_token),
        ) {
            Ok(overview) => {
                if removing_current {
                    self.clear_credential()?;
                    self.status()
                } else {
                    if overview.plan != "pro" {
                        return Err(anyhow!("account service returned an invalid device overview"));
                    }
                    stored.plan = Some(overview.plan);
                    stored.provider = Some(ACCOUNT_PROVIDER.to_string());
                    stored.devices = overview.devices;
                    stored.last_observed_at = Some(Utc::now().to_rfc3339());
                    self.store_credential(stored.clone())?;
                    Ok(status_from_online_store(&stored, &self.device))
                }
            }
            Err(HttpOutcome::Business(error)) if error.code == "AUTH_REQUIRED" => {
                self.clear_credential()?;
                self.status()
            }
            Err(HttpOutcome::Business(error)) if removing_current && error.code == "ACTIVATION_NOT_FOUND" => {
                self.clear_credential()?;
                self.status()
            }
            Err(HttpOutcome::Business(error)) => Ok(self.business_status(error)),
            Err(HttpOutcome::Unavailable) => Ok(self.network_status()),
            Err(HttpOutcome::Malformed(message)) => Err(anyhow!(message)),
        }
    }

    pub fn sign_out(&self) -> Result<LicenseStatusDto> {
        let stored = self.cache.read().map_err(|_| anyhow!("license cache poisoned"))?.clone();
        if let Some(stored) = stored.as_ref() {
            if let Some(activation_id) = stored.activation_id.as_ref() {
                let _ = self.post_json::<ApiAccountOverviewDto>(
                    "/api/account/device/deactivate",
                    serde_json::json!({ "activationId": activation_id }),
                    Some(&stored.session_token),
                );
            }
        }
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

    fn resolve_entitlement(&self, session_token: &str, register: bool) -> Result<LicenseStatusDto> {
        let body = serde_json::json!({
            "clientId": ACCOUNT_CLIENT_ID,
            "deviceId": self.device.device_id,
            "deviceName": self.device.device_name,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "register": register,
        });
        match self.post_json::<ApiAccountEntitlementDto>(
            "/api/account/entitlement",
            body,
            Some(session_token),
        ) {
            Ok(api) => self.store_online(session_token.to_string(), api),
            Err(HttpOutcome::Business(error)) if error.code == "AUTH_REQUIRED" => {
                self.clear_credential()?;
                let mut status = self.status()?;
                status.state = "revoked".to_string();
                status.message = error.code;
                Ok(status)
            }
            Err(HttpOutcome::Business(error)) => {
                if matches!(error.code.as_str(), "DEVICE_NOT_REGISTERED" | "LICENSE_INACTIVE") {
                    self.invalidate_cached_activation()?;
                }
                Ok(self.business_status(error))
            }
            Err(HttpOutcome::Unavailable) => Ok(self.network_status()),
            Err(HttpOutcome::Malformed(message)) => Err(anyhow!(message)),
        }
    }

    fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
        bearer: Option<&str>,
    ) -> std::result::Result<T, HttpOutcome> {
        let url = format!("{LICENSE_API_ORIGIN}{path}");
        let mut request = self.agent.post(&url).set("Accept", "application/json");
        if let Some(token) = bearer {
            request = request.set("Authorization", &format!("Bearer {token}"));
        }
        match request.send_json(body) {
            Ok(response) => response
                .into_json::<T>()
                .map_err(|error| HttpOutcome::Malformed(error.to_string())),
            Err(ureq::Error::Status(status, response)) => {
                if status == 429 || status >= 500 {
                    return Err(HttpOutcome::Unavailable);
                }
                let error = response
                    .into_json::<ApiErrorDto>()
                    .map_err(|parse| HttpOutcome::Malformed(parse.to_string()))?;
                Err(HttpOutcome::Business(error))
            }
            Err(ureq::Error::Transport(_)) => Err(HttpOutcome::Unavailable),
        }
    }

    fn store_online(&self, session_token: String, api: ApiAccountEntitlementDto) -> Result<LicenseStatusDto> {
        let stored = stored_from_api(session_token, &api, &self.device)?;
        self.store_credential(stored.clone())?;
        Ok(status_from_online_store(&stored, &self.device))
    }

    fn invalidate_cached_activation(&self) -> Result<()> {
        let stored = self.cache.read().map_err(|_| anyhow!("license cache poisoned"))?.clone();
        let Some(mut stored) = stored else {
            return Ok(());
        };
        stored.activation_id = None;
        stored.validated_at = None;
        stored.offline_grace_until = None;
        stored.last_observed_at = None;
        stored.devices.retain(|device| device.device_id != self.device.device_id);
        self.store_credential(stored)
    }

    fn business_status(&self, error: ApiErrorDto) -> LicenseStatusDto {
        let mut status = self.network_status();
        status.state = match error.code.as_str() {
            "ACTIVATION_LIMIT_REACHED" => "activationLimit",
            "DEVICE_NOT_REGISTERED" | "ACTIVATION_REVIEW_REQUIRED" => "reviewRequired",
            "LICENSE_INACTIVE" => "revoked",
            _ => "invalid",
        }
        .to_string();
        status.entitled = false;
        if error.code == "ACTIVATION_LIMIT_REACHED" {
            status.plan = Some("pro".to_string());
        }
        status.message = error.code;
        status
    }

    fn network_status(&self) -> LicenseStatusDto {
        self.status().unwrap_or_else(|_| {
            configuration_error_status(&self.device, "Account service is unavailable.")
        })
    }

    fn configuration_or_offline_status(&self, message: &str) -> LicenseStatusDto {
        let status = self.network_status();
        if status.entitled || status.plan.is_some() {
            status
        } else {
            configuration_error_status(&self.device, message)
        }
    }

    fn store_credential(&self, stored: StoredAccount) -> Result<()> {
        let json = serde_json::to_string(&stored)?;
        self.credential
            .set_password(&json)
            .map_err(|error| anyhow!(error).context("write Windows Credential Manager account entry"))?;
        *self.cache.write().map_err(|_| anyhow!("license cache poisoned"))? = Some(stored);
        Ok(())
    }

    fn clear_credential(&self) -> Result<()> {
        let deletion = match self.credential.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(anyhow!(error).context("delete Windows Credential Manager account entry")),
        };
        *self.cache.write().map_err(|_| anyhow!("license cache poisoned"))? = None;
        deletion
    }
}

pub struct HeadlessLicenseCache {
    stored: Option<StoredAccount>,
}

impl HeadlessLicenseCache {
    pub fn load() -> Result<Self> {
        let service = credential_service();
        remove_legacy_credential(service)?;
        let entry = Entry::new(service, CREDENTIAL_ACCOUNT)
            .context("open Windows Credential Manager account entry")?;
        Ok(Self { stored: read_credential(&entry)? })
    }

    pub fn require_pro(&self) -> Result<()> {
        let Some(stored) = self.stored.as_ref().filter(|stored| stored.plan.as_deref() == Some("pro")) else {
            return Err(anyhow!(PRO_REQUIRED_ERROR));
        };
        let now = Utc::now();
        let validated_at = parse_optional_time(stored.validated_at.as_deref()).ok_or_else(|| anyhow!(PRO_REQUIRED_ERROR))?;
        let grace_until = parse_optional_time(stored.offline_grace_until.as_deref()).ok_or_else(|| anyhow!(PRO_REQUIRED_ERROR))?;
        let last_observed = parse_optional_time(stored.last_observed_at.as_deref()).ok_or_else(|| anyhow!(PRO_REQUIRED_ERROR))?;
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
    Business(ApiErrorDto),
    Unavailable,
    Malformed(String),
}

fn credential_service() -> &'static str {
    if cfg!(debug_assertions) {
        "com.vibelink.desktop.dev.license"
    } else {
        "com.vibelink.desktop.license"
    }
}

fn remove_legacy_credential(service: &str) -> Result<()> {
    let legacy = Entry::new(service, LEGACY_CREDENTIAL_ACCOUNT)
        .context("open legacy Windows Credential Manager license entry")?;
    match legacy.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(anyhow!(error).context("delete legacy Windows Credential Manager license entry")),
    }
}

fn read_credential(entry: &Entry) -> Result<Option<StoredAccount>> {
    match entry.get_password() {
        Ok(json) => Ok(Some(
            serde_json::from_str(&json).context("parse stored Moobang account credential")?,
        )),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(anyhow!(error).context("read Windows Credential Manager account entry")),
    }
}

fn stored_from_api(
    session_token: String,
    api: &ApiAccountEntitlementDto,
    device: &DeviceIdentity,
) -> Result<StoredAccount> {
    if session_token.is_empty()
        || api.email.is_empty()
        || api.device_id != device.device_id
        || api.device_name != device.device_name
        || api.max_devices != 3
    {
        return Err(anyhow!("account service returned an invalid entitlement"));
    }
    match api.plan.as_str() {
        "core"
            if api.state == "core"
                && !api.entitled
                && api.provider.is_none()
                && api.activation_id.is_none()
                && api.validated_at.is_none()
                && api.offline_grace_until.is_none() => {}
        "pro"
            if api.state == "validOnline"
                && api.entitled
                && api.provider.is_some()
                && api.activation_id.is_some()
                && api.validated_at.is_some()
                && api.offline_grace_until.is_some() => {}
        _ => return Err(anyhow!("account service returned an invalid entitlement")),
    }
    Ok(StoredAccount {
        session_token,
        plan: Some(api.plan.clone()),
        provider: (api.plan == "pro").then(|| ACCOUNT_PROVIDER.to_string()),
        email: Some(api.email.clone()),
        activation_id: api.activation_id.clone(),
        max_devices: api.max_devices,
        devices: api.devices.clone(),
        validated_at: api.validated_at.clone(),
        offline_grace_until: api.offline_grace_until.clone(),
        last_observed_at: Some(Utc::now().to_rfc3339()),
        pending_session_token: None,
        pending_device_code: None,
    })
}

fn status_from_cache(
    stored: Option<&StoredAccount>,
    device: &DeviceIdentity,
    now: DateTime<Utc>,
) -> LicenseStatusDto {
    let Some(stored) = stored else {
        return unlicensed_status(device);
    };
    match stored.plan.as_deref() {
        Some("core") => core_status(stored, device),
        Some("pro") => pro_status_from_cache(stored, device, now),
        _ => {
            let mut status = configuration_error_status(
                device,
                "Moobang account sign-in is waiting for entitlement validation.",
            );
            status.email = stored.email.clone();
            status
        }
    }
}

fn pro_status_from_cache(
    stored: &StoredAccount,
    device: &DeviceIdentity,
    now: DateTime<Utc>,
) -> LicenseStatusDto {
    let validated_at = parse_optional_time(stored.validated_at.as_deref());
    let grace_until = parse_optional_time(stored.offline_grace_until.as_deref());
    let last_observed = parse_optional_time(stored.last_observed_at.as_deref());
    let rollback = validated_at.is_some_and(|value| now < value - ChronoDuration::minutes(5))
        || last_observed.is_some_and(|value| now < value - ChronoDuration::minutes(5));
    let entitled = !rollback && grace_until.is_some_and(|value| now <= value);
    LicenseStatusDto {
        state: if rollback {
            "invalid"
        } else if entitled {
            "validOffline"
        } else {
            "invalid"
        }
        .to_string(),
        entitled,
        plan: Some("pro".to_string()),
        provider: stored.provider.clone(),
        email: stored.email.clone(),
        masked_key: None,
        activation_id: stored.activation_id.clone(),
        device_id: device.device_id.clone(),
        device_name: device.device_name.clone(),
        max_devices: stored.max_devices,
        devices: stored.devices.clone(),
        validated_at: stored.validated_at.clone(),
        offline_grace_until: stored.offline_grace_until.clone(),
        purchase_url: purchase_url(),
        message: if rollback {
            "System clock rollback detected. Connect to validate VibeLink Pro."
        } else if entitled {
            "Using the last online validation within the 7-day offline grace period."
        } else {
            "Connect to validate VibeLink Pro."
        }
        .to_string(),
    }
}

fn status_from_online_store(stored: &StoredAccount, device: &DeviceIdentity) -> LicenseStatusDto {
    match stored.plan.as_deref() {
        Some("core") => core_status(stored, device),
        Some("pro") => LicenseStatusDto {
            state: "validOnline".to_string(),
            entitled: true,
            plan: Some("pro".to_string()),
            provider: stored.provider.clone(),
            email: stored.email.clone(),
            masked_key: None,
            activation_id: stored.activation_id.clone(),
            device_id: device.device_id.clone(),
            device_name: device.device_name.clone(),
            max_devices: stored.max_devices,
            devices: stored.devices.clone(),
            validated_at: stored.validated_at.clone(),
            offline_grace_until: stored.offline_grace_until.clone(),
            purchase_url: purchase_url(),
            message: "VibeLink Pro is active on this Moobang account.".to_string(),
        },
        _ => configuration_error_status(device, "Moobang account entitlement is unavailable."),
    }
}

fn core_status(stored: &StoredAccount, device: &DeviceIdentity) -> LicenseStatusDto {
    LicenseStatusDto {
        state: "core".to_string(),
        entitled: false,
        plan: Some("core".to_string()),
        provider: None,
        email: stored.email.clone(),
        masked_key: None,
        activation_id: None,
        device_id: device.device_id.clone(),
        device_name: device.device_name.clone(),
        max_devices: stored.max_devices,
        devices: Vec::new(),
        validated_at: None,
        offline_grace_until: None,
        purchase_url: purchase_url(),
        message: "VibeLink Core is active. Upgrade to Pro for account entitlement.".to_string(),
    }
}

fn unlicensed_status(device: &DeviceIdentity) -> LicenseStatusDto {
    LicenseStatusDto {
        state: "unlicensed".to_string(),
        entitled: false,
        plan: None,
        provider: None,
        email: None,
        masked_key: None,
        activation_id: None,
        device_id: device.device_id.clone(),
        device_name: device.device_name.clone(),
        max_devices: 3,
        devices: Vec::new(),
        validated_at: None,
        offline_grace_until: None,
        purchase_url: purchase_url(),
        message: "Sign in with a Moobang account to use VibeLink Core or Pro.".to_string(),
    }
}

fn configuration_error_status(device: &DeviceIdentity, message: &str) -> LicenseStatusDto {
    let mut status = unlicensed_status(device);
    status.state = "configurationError".to_string();
    status.message = message.to_string();
    status
}

fn token_error_is_pending(code: &str) -> bool {
    matches!(code, "authorization_pending" | "slow_down")
}

fn api_error(error: ApiErrorDto) -> anyhow::Error {
    match error.description {
        Some(description) if !description.is_empty() => anyhow!("{}: {description}", error.code),
        _ => anyhow!(error.code),
    }
}

fn parse_optional_time(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|value| DateTime::parse_from_rfc3339(value).ok())
        .map(|value| value.with_timezone(&Utc))
}

fn purchase_url() -> String {
    format!("{LICENSE_API_ORIGIN}/checkout")
}

fn load_or_create_device_identity() -> Result<DeviceIdentity> {
    let path = crate::daemon::paths::daemon_paths()?.data_dir.join("license-device.json");
    if path.exists() {
        let identity: DeviceIdentity = serde_json::from_str(
            &fs::read_to_string(&path).context("read license device identity")?,
        )
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
        device_name: if device_name.is_empty() {
            "Windows device".to_string()
        } else {
            device_name
        },
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
pub async fn license_status(
    service: tauri::State<'_, Arc<LicenseService>>,
) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.status().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn account_sign_in_start(
    service: tauri::State<'_, Arc<LicenseService>>,
) -> std::result::Result<AccountSignInStartDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.start_sign_in().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn account_sign_in_poll(
    service: tauri::State<'_, Arc<LicenseService>>,
    device_code: String,
) -> std::result::Result<AccountSignInPollResult, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.poll_sign_in(device_code).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_revalidate(
    service: tauri::State<'_, Arc<LicenseService>>,
) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.revalidate().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_deactivate_device(
    service: tauri::State<'_, Arc<LicenseService>>,
    activation_id: String,
) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.deactivate_device(activation_id).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn account_sign_out(
    service: tauri::State<'_, Arc<LicenseService>>,
) -> std::result::Result<LicenseStatusDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || service.sign_out().map_err(|error| error.to_string()))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_forget_local(
    service: tauri::State<'_, Arc<LicenseService>>,
) -> std::result::Result<LicenseStatusDto, String> {
    account_sign_out(service).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device() -> DeviceIdentity {
        DeviceIdentity {
            device_id: Uuid::new_v4().to_string(),
            device_name: "Test device".to_string(),
        }
    }

    fn stored_core() -> StoredAccount {
        StoredAccount {
            session_token: "session-token".to_string(),
            plan: Some("core".to_string()),
            provider: None,
            email: Some("core@example.com".to_string()),
            activation_id: None,
            max_devices: 3,
            devices: Vec::new(),
            validated_at: None,
            offline_grace_until: None,
            last_observed_at: Some(Utc::now().to_rfc3339()),
            pending_session_token: None,
            pending_device_code: None,
        }
    }

    fn stored_pro(
        validated_at: DateTime<Utc>,
        grace_until: DateTime<Utc>,
        last_observed_at: DateTime<Utc>,
    ) -> StoredAccount {
        StoredAccount {
            session_token: "session-token".to_string(),
            plan: Some("pro".to_string()),
            provider: Some(ACCOUNT_PROVIDER.to_string()),
            email: Some("pro@example.com".to_string()),
            activation_id: Some(Uuid::new_v4().to_string()),
            max_devices: 3,
            devices: Vec::new(),
            validated_at: Some(validated_at.to_rfc3339()),
            offline_grace_until: Some(grace_until.to_rfc3339()),
            last_observed_at: Some(last_observed_at.to_rfc3339()),
            pending_session_token: None,
            pending_device_code: None,
        }
    }

    #[test]
    fn signed_in_core_cache_is_not_unlicensed() {
        let status = status_from_cache(Some(&stored_core()), &device(), Utc::now());
        assert_eq!(status.state, "core");
        assert_eq!(status.plan.as_deref(), Some("core"));
        assert_eq!(status.email.as_deref(), Some("core@example.com"));
        assert!(!status.entitled);
        assert!(status.masked_key.is_none());
        assert_eq!(status.purchase_url, format!("{LICENSE_API_ORIGIN}/checkout"));
    }

    #[test]
    fn pro_offline_grace_includes_exact_boundary_and_excludes_after() {
        let now = Utc::now();
        let cache = stored_pro(now - ChronoDuration::days(7), now, now - ChronoDuration::hours(1));
        let boundary = status_from_cache(Some(&cache), &device(), now);
        assert!(boundary.entitled);
        assert_eq!(boundary.state, "validOffline");
        assert!(!status_from_cache(
            Some(&cache),
            &device(),
            now + ChronoDuration::milliseconds(1),
        )
        .entitled);
    }

    #[test]
    fn clock_rollback_locks_cached_pro_entitlement() {
        let now = Utc::now();
        let cache = stored_pro(now + ChronoDuration::minutes(6), now + ChronoDuration::days(7), now);
        let status = status_from_cache(Some(&cache), &device(), now);
        assert!(!status.entitled);
        assert_eq!(status.state, "invalid");
        assert_eq!(status.plan.as_deref(), Some("pro"));
    }

    #[test]
    fn pending_token_errors_are_classified_without_accepting_terminal_errors() {
        assert!(token_error_is_pending("authorization_pending"));
        assert!(token_error_is_pending("slow_down"));
        assert!(!token_error_is_pending("access_denied"));
        assert!(!token_error_is_pending("expired_token"));
        assert!(!token_error_is_pending("invalid_grant"));
    }

    #[test]
    fn account_store_and_status_dto_have_no_legacy_key_fields() {
        let device = device();
        let api = ApiAccountEntitlementDto {
            state: "core".to_string(),
            entitled: false,
            plan: "core".to_string(),
            provider: None,
            email: "core@example.com".to_string(),
            activation_id: None,
            device_id: device.device_id.clone(),
            device_name: device.device_name.clone(),
            max_devices: 3,
            devices: Vec::new(),
            validated_at: None,
            offline_grace_until: None,
        };
        let stored = stored_from_api("session-token".to_string(), &api, &device).unwrap();
        let stored_json = serde_json::to_value(&stored).unwrap();
        assert_eq!(stored_json.get("sessionToken").and_then(serde_json::Value::as_str), Some("session-token"));
        assert!(stored_json.get("licenseKey").is_none());
        assert!(stored_json.get("maskedKey").is_none());

        let status_json = serde_json::to_value(status_from_online_store(&stored, &device)).unwrap();
        assert_eq!(status_json.get("plan").and_then(serde_json::Value::as_str), Some("core"));
        assert_eq!(status_json.get("email").and_then(serde_json::Value::as_str), Some("core@example.com"));
        assert_eq!(status_json.get("provider").and_then(serde_json::Value::as_str), None);
        assert_eq!(status_json.get("maskedKey"), Some(&serde_json::Value::Null));

        let start_json = serde_json::to_value(AccountSignInStartDto {
            user_code: "ABCD-1234".to_string(),
            verification_uri_complete: format!("{LICENSE_API_ORIGIN}/device?user_code=ABCD1234"),
            device_code: "device-code".to_string(),
            interval: 5,
        })
        .unwrap();
        assert_eq!(
            start_json,
            serde_json::json!({
                "userCode": "ABCD-1234",
                "verificationUriComplete": format!("{LICENSE_API_ORIGIN}/device?user_code=ABCD1234"),
                "deviceCode": "device-code",
                "interval": 5,
            }),
        );
        assert_eq!(
            serde_json::to_value(AccountSignInPollResult::Pending("pending".to_string())).unwrap(),
            serde_json::Value::String("pending".to_string()),
        );
    }
}

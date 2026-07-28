use super::authorization::{AuthorizationSnapshot, AuthorizationState, Capability};
use super::entitlement::EntitlementSupervisor;
use crate::storage::{
    load_with_recovery, parse_json, require_supported_schema, write_json, DocumentError, LoadSource,
};
use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use keyring::Entry;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    path::Path,
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
const TRIAL_LOCK_ERROR: &str =
    "VibeLink trial expired or not signed in. Open VibeLink to sign in or purchase.";
const DEVICE_IDENTITY_SCHEMA_VERSION: u64 = 1;
const ENFORCE_LICENSE_ENV: &str = "VIBELINK_ENFORCE_LICENSE";

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
    pub trial_ends_at: Option<String>,
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
#[serde(rename_all = "camelCase")]
pub struct BugReportInputDto {
    pub category: String,
    pub title: String,
    pub description: String,
    pub steps_to_reproduce: Option<String>,
    pub contact_allowed: bool,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BugReportCreatedDto {
    pub id: String,
    pub created_at: String,
}

#[derive(Clone, Debug, PartialEq)]
struct NormalizedBugReport {
    category: String,
    title: String,
    description: String,
    steps_to_reproduce: Option<String>,
    contact_allowed: bool,
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
    #[serde(default)]
    trial_ends_at: Option<String>,
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
    #[serde(default)]
    trial_ends_at: Option<String>,
    last_observed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_session_token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pending_device_code: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentity {
    device_id: String,
    device_name: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceIdentityDocument {
    schema_version: u64,
    device_id: String,
    device_name: String,
}

struct LoadedDeviceIdentity {
    identity: DeviceIdentity,
    legacy: bool,
}

pub struct LicenseService {
    agent: ureq::Agent,
    device: DeviceIdentity,
    credential: Entry,
    cache: RwLock<Option<StoredAccount>>,
    development_entitlement: bool,
}

impl LicenseService {
    pub fn new() -> Result<Self> {
        let development_entitlement = development_entitlement_enabled();
        let service = credential_service();
        let credential = Entry::new(service, CREDENTIAL_ACCOUNT)
            .context("open Windows Credential Manager account entry")?;
        let cache = if development_entitlement {
            None
        } else {
            remove_legacy_credential(service)?;
            read_credential(&credential)?
        };
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
            development_entitlement,
        })
    }

    pub fn status(&self) -> Result<LicenseStatusDto> {
        if self.development_entitlement {
            return Ok(development_status(&self.device));
        }
        let cache = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?;
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
                return Err(anyhow!(
                    "Account service is unreachable at {LICENSE_API_ORIGIN}."
                ));
            }
            Err(HttpOutcome::Malformed(message)) => return Err(anyhow!(message)),
        };
        if api.device_code.is_empty() || api.user_code.is_empty() || api.interval == 0 {
            return Err(anyhow!(
                "account service returned an invalid device authorization response"
            ));
        }
        let expected_prefix = format!("{LICENSE_API_ORIGIN}/");
        if !api.verification_uri_complete.starts_with(&expected_prefix) {
            return Err(anyhow!(
                "account service returned a verification URL outside the configured origin"
            ));
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
            let token: ApiDeviceTokenDto =
                match self.post_json("/api/auth/device/token", body, None) {
                    Ok(token) => token,
                    Err(HttpOutcome::Business(error)) if token_error_is_pending(&error.code) => {
                        return Ok(AccountSignInPollResult::Pending("pending".to_string()));
                    }
                    Err(HttpOutcome::Business(error)) => return Err(api_error(error)),
                    Err(HttpOutcome::Unavailable) => {
                        return Ok(AccountSignInPollResult::Status(
                            self.configuration_or_offline_status(&format!(
                                "Account service is unreachable at {LICENSE_API_ORIGIN}."
                            )),
                        ));
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
                    trial_ends_at: None,
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
        Ok(AccountSignInPollResult::Status(
            self.resolve_entitlement(&session_token, true)?,
        ))
    }

    pub fn revalidate(&self) -> Result<LicenseStatusDto> {
        if self.development_entitlement {
            return Ok(development_status(&self.device));
        }
        let stored = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?
            .clone();
        let Some(stored) = stored else {
            return self.status();
        };
        self.resolve_entitlement(&stored.session_token, false)
    }

    pub fn deactivate_device(&self, activation_id: String) -> Result<LicenseStatusDto> {
        let stored = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?
            .clone();
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
                        return Err(anyhow!(
                            "account service returned an invalid device overview"
                        ));
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
            Err(HttpOutcome::Business(error))
                if removing_current && error.code == "ACTIVATION_NOT_FOUND" =>
            {
                self.clear_credential()?;
                self.status()
            }
            Err(HttpOutcome::Business(error)) => Ok(self.business_status(error)),
            Err(HttpOutcome::Unavailable) => Ok(self.network_status()),
            Err(HttpOutcome::Malformed(message)) => Err(anyhow!(message)),
        }
    }

    pub fn sign_out(&self) -> Result<LicenseStatusDto> {
        let stored = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?
            .clone();
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

    pub fn submit_bug_report(&self, input: BugReportInputDto) -> Result<BugReportCreatedDto> {
        let report = normalize_bug_report(input)?;
        let stored = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?
            .clone()
            .filter(|stored| !stored.session_token.is_empty() && stored.email.is_some())
            .ok_or_else(|| {
                anyhow!("Sign in with your Moobang account before submitting a bug report.")
            })?;
        let url = format!("{LICENSE_API_ORIGIN}/api/account/bug-reports");
        let body = serde_json::json!({
            "source": "desktop",
            "category": report.category,
            "title": report.title,
            "description": report.description,
            "stepsToReproduce": report.steps_to_reproduce,
            "appVersion": env!("CARGO_PKG_VERSION"),
            "platform": format!("{} {}", std::env::consts::OS, std::env::consts::ARCH),
            "contactAllowed": report.contact_allowed,
        });
        let request = self
            .agent
            .post(&url)
            .set("Accept", "application/json")
            .set("Authorization", &format!("Bearer {}", stored.session_token));
        match request.send_json(body) {
            Ok(response) => response
                .into_json::<BugReportCreatedDto>()
                .map_err(|error| {
                    anyhow!("Bug report service returned an invalid response: {error}")
                }),
            Err(ureq::Error::Status(401, _)) => Err(anyhow!(
                "Your Moobang account session expired. Sign in again before submitting the report."
            )),
            Err(ureq::Error::Status(429, _)) => Err(anyhow!(
                "Daily bug report limit reached (20 reports per account)."
            )),
            Err(ureq::Error::Status(422, _)) => {
                Err(anyhow!("Check the bug report fields and try again."))
            }
            Err(ureq::Error::Status(status, _)) if status >= 500 => {
                Err(anyhow!("Bug report service is temporarily unavailable."))
            }
            Err(ureq::Error::Status(status, response)) => {
                let code = response
                    .into_json::<ApiErrorDto>()
                    .ok()
                    .map(|error| error.code)
                    .unwrap_or_else(|| format!("HTTP_{status}"));
                Err(anyhow!("Bug report submission failed: {code}"))
            }
            Err(ureq::Error::Transport(_)) => Err(anyhow!(
                "Bug report service is unreachable. Check your connection and try again."
            )),
        }
    }

    pub fn authorization_snapshot(&self, policy_epoch: u64) -> Result<AuthorizationSnapshot> {
        let cache = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?;
        Ok(authorization_snapshot_from_cache(
            cache.as_ref(),
            &self.device,
            Utc::now(),
            policy_epoch,
        ))
    }

    pub fn authorization_snapshot_for_status(
        &self,
        status: LicenseStatusDto,
        policy_epoch: u64,
    ) -> Result<AuthorizationSnapshot> {
        let observed_at = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?
            .as_ref()
            .and_then(|stored| parse_optional_time(stored.last_observed_at.as_deref()))
            .or_else(|| parse_optional_time(status.validated_at.as_deref()))
            .unwrap_or_else(Utc::now);
        Ok(authorization_snapshot_from_status(
            status,
            observed_at,
            Utc::now(),
            policy_epoch,
        ))
    }

    pub fn persist_observed_now(&self) -> Result<()> {
        let stored = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?
            .clone();
        let Some(mut stored) = stored else {
            return Ok(());
        };
        let now = Utc::now();
        if parse_optional_time(stored.last_observed_at.as_deref())
            .is_some_and(|previous| now <= previous)
        {
            return Ok(());
        }
        stored.last_observed_at = Some(now.to_rfc3339());
        self.store_credential(stored)
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
                if matches!(
                    error.code.as_str(),
                    "DEVICE_NOT_REGISTERED" | "LICENSE_INACTIVE"
                ) {
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

    fn store_online(
        &self,
        session_token: String,
        api: ApiAccountEntitlementDto,
    ) -> Result<LicenseStatusDto> {
        let stored = stored_from_api(session_token, &api, &self.device)?;
        self.store_credential(stored.clone())?;
        Ok(status_from_online_store(&stored, &self.device))
    }

    fn invalidate_cached_activation(&self) -> Result<()> {
        let stored = self
            .cache
            .read()
            .map_err(|_| anyhow!("license cache poisoned"))?
            .clone();
        let Some(mut stored) = stored else {
            return Ok(());
        };
        stored.activation_id = None;
        stored.validated_at = None;
        stored.offline_grace_until = None;
        stored.last_observed_at = None;
        stored
            .devices
            .retain(|device| device.device_id != self.device.device_id);
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
        self.credential.set_password(&json).map_err(|error| {
            anyhow!(error).context("write Windows Credential Manager account entry")
        })?;
        *self
            .cache
            .write()
            .map_err(|_| anyhow!("license cache poisoned"))? = Some(stored);
        Ok(())
    }

    fn clear_credential(&self) -> Result<()> {
        let deletion = match self.credential.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => {
                Err(anyhow!(error).context("delete Windows Credential Manager account entry"))
            }
        };
        *self
            .cache
            .write()
            .map_err(|_| anyhow!("license cache poisoned"))? = None;
        deletion
    }
}

pub struct HeadlessLicenseCache {
    stored: Option<StoredAccount>,
    device: DeviceIdentity,
    development_entitlement: bool,
}

impl HeadlessLicenseCache {
    pub fn load() -> Result<Self> {
        let development_entitlement = development_entitlement_enabled();
        let device = load_or_create_device_identity()?;
        if development_entitlement {
            return Ok(Self {
                stored: None,
                device,
                development_entitlement,
            });
        }
        let service = credential_service();
        remove_legacy_credential(service)?;
        let entry = Entry::new(service, CREDENTIAL_ACCOUNT)
            .context("open Windows Credential Manager account entry")?;
        Ok(Self {
            stored: read_credential(&entry)?,
            device,
            development_entitlement,
        })
    }

    pub fn authorization_snapshot(&self, policy_epoch: u64) -> AuthorizationSnapshot {
        if self.development_entitlement {
            let now = Utc::now();
            return AuthorizationSnapshot {
                state: AuthorizationState::ValidOnline,
                entitled: true,
                observed_at: now,
                lease_until: now + ChronoDuration::days(3650),
                offline_grace_until: None,
                policy_epoch,
            };
        }
        authorization_snapshot_from_cache(
            self.stored.as_ref(),
            &self.device,
            Utc::now(),
            policy_epoch,
        )
    }

    pub fn require_capability(&self, capability: Capability) -> Result<()> {
        self.authorization_snapshot(0)
            .authorize(capability, Utc::now())
            .map_err(|denied| anyhow!(denied.code.as_str()))
    }

    pub fn require_entitled(&self) -> Result<()> {
        self.require_capability(Capability::CliControl)
            .map_err(|_| anyhow!(TRIAL_LOCK_ERROR))
    }

    pub fn is_entitled(&self) -> bool {
        self.require_entitled().is_ok()
    }
}

#[derive(Debug)]
enum HttpOutcome {
    Business(ApiErrorDto),
    Unavailable,
    Malformed(String),
}

fn development_entitlement_enabled() -> bool {
    development_entitlement_policy(
        cfg!(debug_assertions),
        std::env::var(ENFORCE_LICENSE_ENV).ok().as_deref(),
    )
}

fn development_entitlement_policy(debug_build: bool, enforce_license: Option<&str>) -> bool {
    if !debug_build {
        return false;
    }
    !enforce_license.is_some_and(|value| {
        let value = value.trim();
        value == "1"
            || value.eq_ignore_ascii_case("true")
            || value.eq_ignore_ascii_case("yes")
            || value.eq_ignore_ascii_case("on")
    })
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
        Err(error) => {
            Err(anyhow!(error).context("delete legacy Windows Credential Manager license entry"))
        }
    }
}

fn read_credential(entry: &Entry) -> Result<Option<StoredAccount>> {
    match entry.get_password() {
        Ok(json) => match serde_json::from_str(&json) {
            Ok(stored) => Ok(Some(stored)),
            Err(error) => {
                tracing::warn!(?error, "discarding invalid Moobang account credential");
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => Ok(None),
                    Err(delete_error) => Err(anyhow!(delete_error)
                        .context("delete invalid Windows Credential Manager account entry")),
                }
            }
        },
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
        "pro"
            if api.state == "validOnline"
                && api.entitled
                && api.provider.is_some()
                && api.activation_id.is_some()
                && api.validated_at.is_some()
                && api.offline_grace_until.is_some() => {}
        "trial"
            if api.state == "trial"
                && api.entitled
                && api.activation_id.is_none()
                && api.validated_at.is_some()
                && api.offline_grace_until.is_some()
                && api.trial_ends_at.is_some() => {}
        "none" if api.state == "trialExpired" && !api.entitled && api.trial_ends_at.is_some() => {}
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
        trial_ends_at: api.trial_ends_at.clone(),
        last_observed_at: Some(Utc::now().to_rfc3339()),
        pending_session_token: None,
        pending_device_code: None,
    })
}
fn authorization_snapshot_from_cache(
    stored: Option<&StoredAccount>,
    device: &DeviceIdentity,
    now: DateTime<Utc>,
    policy_epoch: u64,
) -> AuthorizationSnapshot {
    let status = status_from_cache(stored, device, now);
    let observed_at = stored
        .and_then(|account| parse_optional_time(account.last_observed_at.as_deref()))
        .or_else(|| parse_optional_time(status.validated_at.as_deref()))
        .unwrap_or(now);
    authorization_snapshot_from_status(status, observed_at, now, policy_epoch)
}

fn authorization_snapshot_from_status(
    status: LicenseStatusDto,
    observed_at: DateTime<Utc>,
    now: DateTime<Utc>,
    policy_epoch: u64,
) -> AuthorizationSnapshot {
    let offline_grace_until = parse_optional_time(status.offline_grace_until.as_deref());
    let lease_until = offline_grace_until
        .or_else(|| parse_optional_time(status.trial_ends_at.as_deref()))
        .unwrap_or(observed_at.min(now));
    let state = match status.state.as_str() {
        "trial" => AuthorizationState::Trial,
        "trialExpired" => AuthorizationState::TrialExpired,
        "validOnline" | "validOffline" => AuthorizationState::ValidOnline,
        "unlicensed" | "revoked" => AuthorizationState::Unlicensed,
        _ => AuthorizationState::ConfigurationError,
    };
    AuthorizationSnapshot {
        state,
        entitled: status.entitled,
        observed_at,
        offline_grace_until,
        lease_until,
        policy_epoch,
    }
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
        Some("pro") | Some("trial") => entitled_status_from_cache(stored, device, now),
        Some("none") => trial_expired_status(stored, device),
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

fn entitled_status_from_cache(
    stored: &StoredAccount,
    device: &DeviceIdentity,
    now: DateTime<Utc>,
) -> LicenseStatusDto {
    let is_trial = stored.plan.as_deref() == Some("trial");
    let validated_at = parse_optional_time(stored.validated_at.as_deref());
    let grace_until = parse_optional_time(stored.offline_grace_until.as_deref());
    let last_observed = parse_optional_time(stored.last_observed_at.as_deref());
    let rollback = validated_at.is_some_and(|value| now < value - ChronoDuration::minutes(5))
        || last_observed.is_some_and(|value| now < value - ChronoDuration::minutes(5));
    // The server caps offline_grace_until at trialEndsAt for trials, so the same
    // grace check enforces trial expiry offline.
    let entitled = !rollback && grace_until.is_some_and(|value| now <= value);
    let plan = if is_trial { "trial" } else { "pro" };
    let state = if rollback {
        "invalid"
    } else if entitled {
        if is_trial {
            "trial"
        } else {
            "validOffline"
        }
    } else if is_trial {
        "trialExpired"
    } else {
        "invalid"
    };
    let message = if rollback {
        if is_trial {
            "System clock rollback detected. Connect to validate your VibeLink trial.".to_string()
        } else {
            "System clock rollback detected. Connect to validate VibeLink Pro.".to_string()
        }
    } else if entitled {
        if is_trial {
            "Your 7-day VibeLink trial is active. Purchase to keep VibeLink after it ends."
                .to_string()
        } else {
            "Using the last online validation within the 7-day offline grace period.".to_string()
        }
    } else if is_trial {
        "Your 7-day VibeLink trial has ended. Purchase VibeLink Pro to continue.".to_string()
    } else {
        "Connect to validate VibeLink Pro.".to_string()
    };
    LicenseStatusDto {
        state: state.to_string(),
        entitled,
        plan: Some(plan.to_string()),
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
        trial_ends_at: stored.trial_ends_at.clone(),
        purchase_url: purchase_url(),
        message,
    }
}

fn trial_expired_status(stored: &StoredAccount, device: &DeviceIdentity) -> LicenseStatusDto {
    LicenseStatusDto {
        state: "trialExpired".to_string(),
        entitled: false,
        plan: Some("none".to_string()),
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
        trial_ends_at: stored.trial_ends_at.clone(),
        purchase_url: purchase_url(),
        message: "Your 7-day VibeLink trial has ended. Purchase VibeLink Pro to continue."
            .to_string(),
    }
}

fn status_from_online_store(stored: &StoredAccount, device: &DeviceIdentity) -> LicenseStatusDto {
    match stored.plan.as_deref() {
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
            trial_ends_at: None,
            purchase_url: purchase_url(),
            message: "VibeLink Pro is active on this Moobang account.".to_string(),
        },
        Some("trial") => LicenseStatusDto {
            state: "trial".to_string(),
            entitled: true,
            plan: Some("trial".to_string()),
            provider: None,
            email: stored.email.clone(),
            masked_key: None,
            activation_id: None,
            device_id: device.device_id.clone(),
            device_name: device.device_name.clone(),
            max_devices: stored.max_devices,
            devices: stored.devices.clone(),
            validated_at: stored.validated_at.clone(),
            offline_grace_until: stored.offline_grace_until.clone(),
            trial_ends_at: stored.trial_ends_at.clone(),
            purchase_url: purchase_url(),
            message:
                "Your 7-day VibeLink trial is active. Purchase to keep VibeLink after it ends."
                    .to_string(),
        },
        Some("none") => trial_expired_status(stored, device),
        _ => configuration_error_status(device, "Moobang account entitlement is unavailable."),
    }
}

fn development_status(device: &DeviceIdentity) -> LicenseStatusDto {
    LicenseStatusDto {
        state: "development".to_string(),
        entitled: true,
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
        trial_ends_at: None,
        purchase_url: purchase_url(),
        message: "Development build: entitlement checks are disabled. Release builds still require a Moobang account entitlement.".to_string(),
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
        trial_ends_at: None,
        purchase_url: purchase_url(),
        message: "Sign in with your Moobang account to start your 7-day free trial.".to_string(),
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

fn normalize_bug_report(input: BugReportInputDto) -> Result<NormalizedBugReport> {
    if !matches!(
        input.category.as_str(),
        "crash" | "terminal" | "agent" | "account" | "billing" | "remote" | "other"
    ) {
        return Err(anyhow!("Choose a valid bug report area."));
    }
    let title = normalize_report_text(input.title, 4, 120, "summary")?;
    let description = normalize_report_text(input.description, 10, 4000, "description")?;
    let steps_to_reproduce = match input.steps_to_reproduce {
        Some(value) if !value.trim().is_empty() => {
            Some(normalize_report_text(value, 1, 4000, "reproduction steps")?)
        }
        _ => None,
    };
    Ok(NormalizedBugReport {
        category: input.category,
        title,
        description,
        steps_to_reproduce,
        contact_allowed: input.contact_allowed,
    })
}

fn normalize_report_text(value: String, min: usize, max: usize, label: &str) -> Result<String> {
    let normalized = value.trim().to_string();
    let length = normalized.chars().count();
    if length < min || length > max {
        return Err(anyhow!(
            "Bug report {label} must be {min}-{max} characters."
        ));
    }
    if normalized
        .chars()
        .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
    {
        return Err(anyhow!(
            "Bug report {label} contains unsupported control characters."
        ));
    }
    Ok(normalized)
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
    let path = crate::daemon::paths::daemon_paths()?
        .data_dir
        .join("license-device.json");
    load_or_create_device_identity_at(&path)
}

fn load_or_create_device_identity_at(path: &Path) -> Result<DeviceIdentity> {
    let report = load_with_recovery(
        path,
        LoadedDeviceIdentity {
            identity: DeviceIdentity {
                device_id: String::new(),
                device_name: String::new(),
            },
            legacy: false,
        },
        parse_device_identity,
    )?;
    let mut loaded = report.value;
    if report.source == LoadSource::Default {
        loaded.identity = new_device_identity();
        write_device_identity(path, &loaded.identity)?;
    } else if loaded.legacy {
        write_device_identity(path, &loaded.identity)?;
    }
    Ok(loaded.identity)
}

fn parse_device_identity(bytes: &[u8]) -> std::result::Result<LoadedDeviceIdentity, DocumentError> {
    let value: serde_json::Value = parse_json(bytes)?;
    let (identity, legacy) = if value.get("schemaVersion").is_some() {
        let document: DeviceIdentityDocument = serde_json::from_value(value)?;
        require_supported_schema(document.schema_version, DEVICE_IDENTITY_SCHEMA_VERSION)?;
        (
            DeviceIdentity {
                device_id: document.device_id,
                device_name: document.device_name,
            },
            false,
        )
    } else {
        (serde_json::from_value(value)?, true)
    };
    Uuid::parse_str(&identity.device_id).map_err(|_| {
        DocumentError::Invalid(anyhow!(
            "license device identity contains an invalid device id"
        ))
    })?;
    if identity.device_name.trim().is_empty() {
        return Err(DocumentError::Invalid(anyhow!(
            "license device identity contains an empty device name"
        )));
    }
    Ok(LoadedDeviceIdentity { identity, legacy })
}

fn write_device_identity(path: &Path, identity: &DeviceIdentity) -> Result<()> {
    write_json(
        path,
        &DeviceIdentityDocument {
            schema_version: DEVICE_IDENTITY_SCHEMA_VERSION,
            device_id: identity.device_id.clone(),
            device_name: identity.device_name.clone(),
        },
    )
}

fn new_device_identity() -> DeviceIdentity {
    let device_name = std::env::var("COMPUTERNAME")
        .unwrap_or_else(|_| "Windows device".to_string())
        .chars()
        .filter(|character| !character.is_control())
        .take(64)
        .collect::<String>();
    DeviceIdentity {
        device_id: Uuid::new_v4().to_string(),
        device_name: if device_name.is_empty() {
            "Windows device".to_string()
        } else {
            device_name
        },
    }
}

#[tauri::command]
pub async fn license_status(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
) -> std::result::Result<LicenseStatusDto, String> {
    let service = supervisor.service();
    tauri::async_runtime::spawn_blocking(move || {
        service.status().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn account_sign_in_start(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
) -> std::result::Result<AccountSignInStartDto, String> {
    let service = supervisor.service();
    tauri::async_runtime::spawn_blocking(move || {
        service.start_sign_in().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn account_sign_in_poll(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    device_code: String,
) -> std::result::Result<AccountSignInPollResult, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let result = supervisor
            .service()
            .poll_sign_in(device_code)
            .map_err(|error| error.to_string())?;
        if let AccountSignInPollResult::Status(status) = &result {
            supervisor
                .publish_status(status.clone())
                .map_err(|error| error.to_string())?;
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_revalidate(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
) -> std::result::Result<LicenseStatusDto, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || {
        supervisor.refresh_now().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_deactivate_device(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
    activation_id: String,
) -> std::result::Result<LicenseStatusDto, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let status = supervisor
            .service()
            .deactivate_device(activation_id)
            .map_err(|error| error.to_string())?;
        supervisor
            .publish_status(status.clone())
            .map_err(|error| error.to_string())?;
        Ok(status)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn account_sign_out(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
) -> std::result::Result<LicenseStatusDto, String> {
    let supervisor = Arc::clone(supervisor.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let status = supervisor
            .service()
            .sign_out()
            .map_err(|error| error.to_string())?;
        supervisor
            .publish_status(status.clone())
            .map_err(|error| error.to_string())?;
        Ok(status)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn license_forget_local(
    supervisor: tauri::State<'_, Arc<EntitlementSupervisor>>,
) -> std::result::Result<LicenseStatusDto, String> {
    account_sign_out(supervisor).await
}

#[tauri::command]
pub async fn bug_report_submit(
    service: tauri::State<'_, Arc<LicenseService>>,
    input: BugReportInputDto,
) -> std::result::Result<BugReportCreatedDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service
            .submit_bug_report(input)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
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

    fn temp_storage_path(label: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "vibelink-license-storage-{label}-{}",
            Uuid::new_v4()
        ));
        std::fs::create_dir_all(&root).expect("create license test directory");
        root.join("license-device.json")
    }

    fn cleanup_storage_path(path: &Path) {
        if let Some(root) = path.parent() {
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn malformed_account_credential_is_deleted_and_loads_locked() {
        let entry = Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        entry
            .set_password(r#"{"sessionToken":"secret""#)
            .expect("store malformed credential");

        assert!(read_credential(&entry)
            .expect("clear malformed credential")
            .is_none());
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        assert!(!status_from_cache(None, &device(), Utc::now()).entitled);
    }

    #[test]
    fn credential_store_read_failures_are_preserved() {
        let credential = keyring::mock::MockCredential::default();
        credential.set_error(keyring::Error::NoStorageAccess(Box::new(
            std::io::Error::other("credential store locked"),
        )));
        let entry = Entry::new_with_credential(Box::new(credential));

        let error = read_credential(&entry).expect_err("storage failure should propagate");
        assert!(error
            .to_string()
            .contains("read Windows Credential Manager account entry"));
    }

    #[test]
    fn device_identity_migrates_legacy_shape_to_schema_v1() {
        let path = temp_storage_path("legacy");
        let legacy = device();
        std::fs::write(&path, serde_json::to_vec_pretty(&legacy).unwrap()).unwrap();

        let loaded = load_or_create_device_identity_at(&path).expect("load legacy identity");
        let document: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();

        assert_eq!(loaded.device_id, legacy.device_id);
        assert_eq!(document["schemaVersion"], DEVICE_IDENTITY_SCHEMA_VERSION);
        assert_eq!(document["deviceId"], legacy.device_id);
        cleanup_storage_path(&path);
    }

    #[test]
    fn device_identity_recovers_valid_backup() {
        let path = temp_storage_path("backup");
        let first = device();
        let second = device();
        write_device_identity(&path, &first).unwrap();
        write_device_identity(&path, &second).unwrap();
        std::fs::write(&path, b"{").unwrap();

        let loaded = load_or_create_device_identity_at(&path).expect("recover identity backup");
        let primary = parse_device_identity(&std::fs::read(&path).unwrap()).unwrap();

        assert_eq!(loaded.device_id, first.device_id);
        assert_eq!(primary.identity.device_id, first.device_id);
        cleanup_storage_path(&path);
    }

    #[test]
    fn device_identity_newer_schema_errors_without_overwrite() {
        let path = temp_storage_path("newer");
        let future = br#"{"schemaVersion":2,"deviceId":"00000000-0000-0000-0000-000000000001","deviceName":"Future"}"#;
        std::fs::write(&path, future).unwrap();

        let error = load_or_create_device_identity_at(&path)
            .expect_err("future identity schema should fail");

        assert!(error.to_string().contains("unsupported storage schema 2"));
        assert!(!path.exists());
        let quarantined = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .find(|entry| entry.file_name().to_string_lossy().contains(".corrupt-"))
            .expect("future identity quarantine");
        assert_eq!(std::fs::read(quarantined.path()).unwrap(), future);
        cleanup_storage_path(&path);
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
            trial_ends_at: None,
            last_observed_at: Some(last_observed_at.to_rfc3339()),
            pending_session_token: None,
            pending_device_code: None,
        }
    }

    fn stored_trial(
        validated_at: DateTime<Utc>,
        grace_until: DateTime<Utc>,
        last_observed_at: DateTime<Utc>,
        trial_ends_at: DateTime<Utc>,
    ) -> StoredAccount {
        StoredAccount {
            session_token: "session-token".to_string(),
            plan: Some("trial".to_string()),
            provider: None,
            email: Some("trial@example.com".to_string()),
            activation_id: None,
            max_devices: 3,
            devices: Vec::new(),
            validated_at: Some(validated_at.to_rfc3339()),
            offline_grace_until: Some(grace_until.to_rfc3339()),
            trial_ends_at: Some(trial_ends_at.to_rfc3339()),
            last_observed_at: Some(last_observed_at.to_rfc3339()),
            pending_session_token: None,
            pending_device_code: None,
        }
    }

    #[test]
    fn active_trial_cache_is_entitled_with_trial_state() {
        let now = Utc::now();
        let cache = stored_trial(
            now - ChronoDuration::days(1),
            now + ChronoDuration::days(6),
            now - ChronoDuration::hours(1),
            now + ChronoDuration::days(6),
        );
        let status = status_from_cache(Some(&cache), &device(), now);
        assert!(status.entitled);
        assert_eq!(status.state, "trial");
        assert_eq!(status.plan.as_deref(), Some("trial"));
        assert_eq!(
            status.trial_ends_at.as_deref(),
            cache.trial_ends_at.as_deref()
        );
        assert_eq!(status.email.as_deref(), Some("trial@example.com"));
        assert!(status.masked_key.is_none());
    }

    #[test]
    fn expired_trial_cache_is_locked() {
        let now = Utc::now();
        // grace already elapsed (server caps grace at trial end)
        let cache = stored_trial(
            now - ChronoDuration::days(8),
            now - ChronoDuration::days(1),
            now - ChronoDuration::days(1),
            now - ChronoDuration::days(1),
        );
        let status = status_from_cache(Some(&cache), &device(), now);
        assert!(!status.entitled);
        assert_eq!(status.state, "trialExpired");
        assert_eq!(status.plan.as_deref(), Some("trial"));
        assert!(status.trial_ends_at.is_some());
    }

    #[test]
    fn trial_expired_plan_none_maps_to_locked() {
        let mut cache = stored_trial(Utc::now(), Utc::now(), Utc::now(), Utc::now());
        cache.plan = Some("none".to_string());
        let status = status_from_cache(Some(&cache), &device(), Utc::now());
        assert!(!status.entitled);
        assert_eq!(status.state, "trialExpired");
        assert_eq!(status.plan.as_deref(), Some("none"));
    }

    #[test]
    fn clock_rollback_locks_cached_trial_entitlement() {
        let now = Utc::now();
        let cache = stored_trial(
            now + ChronoDuration::minutes(6),
            now + ChronoDuration::days(6),
            now,
            now + ChronoDuration::days(6),
        );
        let status = status_from_cache(Some(&cache), &device(), now);
        assert!(!status.entitled);
        assert_eq!(status.state, "invalid");
        assert_eq!(status.plan.as_deref(), Some("trial"));
    }

    #[test]
    fn pro_offline_grace_includes_exact_boundary_and_excludes_after() {
        let now = Utc::now();
        let cache = stored_pro(
            now - ChronoDuration::days(7),
            now,
            now - ChronoDuration::hours(1),
        );
        let boundary = status_from_cache(Some(&cache), &device(), now);
        assert!(boundary.entitled);
        assert_eq!(boundary.state, "validOffline");
        assert!(
            !status_from_cache(
                Some(&cache),
                &device(),
                now + ChronoDuration::milliseconds(1),
            )
            .entitled
        );
    }

    #[test]
    fn clock_rollback_locks_cached_pro_entitlement() {
        let now = Utc::now();
        let cache = stored_pro(
            now + ChronoDuration::minutes(6),
            now + ChronoDuration::days(7),
            now,
        );
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
    fn trial_store_round_trips_and_status_dto_has_no_legacy_key_fields() {
        let device = device();
        let now = Utc::now();
        let api = ApiAccountEntitlementDto {
            state: "trial".to_string(),
            entitled: true,
            plan: "trial".to_string(),
            provider: None,
            email: "trial@example.com".to_string(),
            activation_id: None,
            device_id: device.device_id.clone(),
            device_name: device.device_name.clone(),
            max_devices: 3,
            devices: Vec::new(),
            validated_at: Some(now.to_rfc3339()),
            offline_grace_until: Some((now + ChronoDuration::days(6)).to_rfc3339()),
            trial_ends_at: Some((now + ChronoDuration::days(6)).to_rfc3339()),
        };
        let stored = stored_from_api("session-token".to_string(), &api, &device).unwrap();
        let stored_json = serde_json::to_value(&stored).unwrap();
        assert_eq!(
            stored_json
                .get("sessionToken")
                .and_then(serde_json::Value::as_str),
            Some("session-token")
        );
        assert_eq!(
            stored_json
                .get("trialEndsAt")
                .and_then(serde_json::Value::as_str),
            api.trial_ends_at.as_deref()
        );
        assert!(stored_json.get("licenseKey").is_none());
        assert!(stored_json.get("maskedKey").is_none());

        // StoredAccount round-trips trialEndsAt through serde.
        let reparsed: StoredAccount = serde_json::from_value(stored_json.clone()).unwrap();
        assert_eq!(reparsed.trial_ends_at, stored.trial_ends_at);

        let status_json = serde_json::to_value(status_from_online_store(&stored, &device)).unwrap();
        assert_eq!(
            status_json.get("plan").and_then(serde_json::Value::as_str),
            Some("trial")
        );
        assert_eq!(
            status_json.get("state").and_then(serde_json::Value::as_str),
            Some("trial")
        );
        assert_eq!(
            status_json.get("email").and_then(serde_json::Value::as_str),
            Some("trial@example.com")
        );
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

    #[test]
    fn development_entitlement_is_debug_only_and_can_be_forced_off() {
        assert!(development_entitlement_policy(true, None));
        assert!(development_entitlement_policy(true, Some("0")));
        assert!(!development_entitlement_policy(true, Some("1")));
        assert!(!development_entitlement_policy(true, Some("true")));
        assert!(!development_entitlement_policy(false, None));
        assert!(!development_entitlement_policy(false, Some("0")));

        let status = development_status(&device());
        assert_eq!(status.state, "development");
        assert!(status.entitled);
        assert!(status.plan.is_none());
        assert!(status.email.is_none());

        let headless = HeadlessLicenseCache {
            stored: None,
            device: device(),
            development_entitlement: true,
        };
        assert!(headless.require_entitled().is_ok());
    }

    #[test]
    fn headless_require_entitled_accepts_active_trial_and_rejects_expired() {
        let now = Utc::now();
        let active = HeadlessLicenseCache {
            stored: Some(stored_trial(
                now - ChronoDuration::hours(1),
                now + ChronoDuration::days(6),
                now - ChronoDuration::minutes(1),
                now + ChronoDuration::days(6),
            )),
            device: device(),
            development_entitlement: false,
        };
        assert!(active.require_capability(Capability::CliControl).is_ok());

        let expired = HeadlessLicenseCache {
            stored: Some(stored_trial(
                now - ChronoDuration::days(8),
                now - ChronoDuration::days(1),
                now - ChronoDuration::days(1),
                now - ChronoDuration::days(1),
            )),
            device: device(),
            development_entitlement: false,
        };
        assert!(expired.require_capability(Capability::CliControl).is_err());
    }

    #[test]
    fn headless_policy_returns_stable_entitlement_error() {
        let now = Utc::now();
        let expired = HeadlessLicenseCache {
            stored: Some(stored_trial(
                now - ChronoDuration::days(8),
                now - ChronoDuration::days(1),
                now - ChronoDuration::days(1),
                now - ChronoDuration::days(1),
            )),
            device: device(),
            development_entitlement: false,
        };
        assert_eq!(
            expired
                .require_capability(Capability::TerminalWrite)
                .unwrap_err()
                .to_string(),
            "ENTITLEMENT_REQUIRED"
        );
    }

    #[test]
    fn business_revocation_status_overrides_an_entitled_cache_snapshot() {
        let now = Utc::now();
        let mut status = status_from_cache(
            Some(&stored_pro(
                now - ChronoDuration::hours(1),
                now + ChronoDuration::days(1),
                now,
            )),
            &device(),
            now,
        );
        status.state = "revoked".to_string();
        status.entitled = false;
        let snapshot = authorization_snapshot_from_status(status, now, now, 7);
        assert_eq!(snapshot.state, AuthorizationState::Unlicensed);
        assert_eq!(snapshot.policy_epoch, 7);
        assert_eq!(
            snapshot
                .authorize(Capability::WorkspaceMutate, now)
                .unwrap_err()
                .code
                .as_str(),
            "ENTITLEMENT_REQUIRED"
        );
    }

    #[test]
    fn bug_report_input_is_trimmed_without_collecting_extra_diagnostics() {
        let report = normalize_bug_report(BugReportInputDto {
            category: "terminal".to_string(),
            title: "  Terminal turns blank  ".to_string(),
            description: "  The pane becomes blank after restore.  ".to_string(),
            steps_to_reproduce: Some("  Open two panes and maximize one.  ".to_string()),
            contact_allowed: true,
        })
        .unwrap();
        assert_eq!(report.category, "terminal");
        assert_eq!(report.title, "Terminal turns blank");
        assert_eq!(report.description, "The pane becomes blank after restore.");
        assert_eq!(
            report.steps_to_reproduce.as_deref(),
            Some("Open two panes and maximize one.")
        );
        assert!(report.contact_allowed);
    }

    #[test]
    fn bug_report_input_rejects_invalid_category_and_oversized_content() {
        let invalid_category = normalize_bug_report(BugReportInputDto {
            category: "security-token".to_string(),
            title: "Valid summary".to_string(),
            description: "A sufficiently detailed description.".to_string(),
            steps_to_reproduce: None,
            contact_allowed: false,
        });
        assert!(invalid_category.is_err());

        let oversized = normalize_bug_report(BugReportInputDto {
            category: "other".to_string(),
            title: "Valid summary".to_string(),
            description: "x".repeat(4001),
            steps_to_reproduce: None,
            contact_allowed: false,
        });
        assert!(oversized.is_err());
    }
}

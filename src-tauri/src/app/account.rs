//! Optional Moobang account sign-in.
//!
//! VibeLink is free and open source; nothing in the app is gated on an account.
//! The only thing a session buys is the ability to file a bug report against a
//! real identity, so this module is deliberately small: an RFC 8628 device-code
//! sign-in, the session token in Windows Credential Manager, and one POST.

use anyhow::{anyhow, Context, Result};
use keyring::Entry;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::{
    sync::{Arc, RwLock},
    time::Duration,
};

const ACCOUNT_API_ORIGIN: &str = env!("VIBELINK_API_URL");
const CREDENTIAL_ACCOUNT: &str = "moobang-account";
const LEGACY_CREDENTIAL_ACCOUNT: &str = "active-license";
const ACCOUNT_CLIENT_ID: &str = "vibelink-desktop";
const DEVICE_CODE_GRANT: &str = "urn:ietf:params:oauth:grant-type:device_code";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountStatusDto {
    pub signed_in: bool,
    pub email: Option<String>,
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
    Status(AccountStatusDto),
}

#[derive(Clone, Debug, PartialEq, Deserialize)]
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

/// Better Auth's `GET /api/auth/get-session` payload. Only the address is read;
/// nothing else about the account is stored on this machine.
#[derive(Clone, Debug, Deserialize)]
struct ApiSessionDto {
    user: ApiSessionUserDto,
}

#[derive(Clone, Debug, Deserialize)]
struct ApiSessionUserDto {
    email: String,
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
    email: Option<String>,
}

enum HttpOutcome {
    Business(ApiErrorDto),
    Unavailable,
    Malformed(String),
}

pub struct AccountService {
    agent: ureq::Agent,
    credential: Entry,
    cache: RwLock<Option<StoredAccount>>,
}

impl AccountService {
    pub fn new() -> Result<Self> {
        let service = credential_service();
        let credential = Entry::new(service, CREDENTIAL_ACCOUNT)
            .context("open Windows Credential Manager account entry")?;
        remove_legacy_credential(service)?;
        let cache = read_credential(&credential)?;
        Ok(Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(5))
                .timeout_read(Duration::from_secs(10))
                .redirects(0)
                .user_agent(&format!("VibeLink/{}", env!("CARGO_PKG_VERSION")))
                .build(),
            credential,
            cache: RwLock::new(cache),
        })
    }

    pub fn status(&self) -> Result<AccountStatusDto> {
        Ok(status_from_cache(self.read_cache()?.as_ref()))
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
                    "Account service is unreachable at {ACCOUNT_API_ORIGIN}."
                ));
            }
            Err(HttpOutcome::Malformed(message)) => return Err(anyhow!(message)),
        };
        if api.device_code.is_empty() || api.user_code.is_empty() || api.interval == 0 {
            return Err(anyhow!(
                "account service returned an invalid device authorization response"
            ));
        }
        let expected_prefix = format!("{ACCOUNT_API_ORIGIN}/");
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
                return Err(anyhow!(
                    "Account service is unreachable at {ACCOUNT_API_ORIGIN}."
                ));
            }
            Err(HttpOutcome::Malformed(message)) => return Err(anyhow!(message)),
        };
        if token.access_token.is_empty() {
            return Err(anyhow!("account service returned an empty session token"));
        }
        let email = self.fetch_email(&token.access_token)?;
        let stored = StoredAccount {
            session_token: token.access_token,
            email: Some(email),
        };
        self.store_credential(stored.clone())?;
        Ok(AccountSignInPollResult::Status(status_from_cache(Some(
            &stored,
        ))))
    }

    pub fn sign_out(&self) -> Result<AccountStatusDto> {
        self.clear_credential()?;
        Ok(AccountStatusDto::default())
    }

    /// Bearer token for account-scoped API calls (config sync). None when the
    /// user has not signed in on this machine.
    pub fn session_token(&self) -> Result<Option<String>> {
        Ok(self
            .read_cache()?
            .map(|stored| stored.session_token)
            .filter(|token| !token.is_empty()))
    }

    pub fn submit_bug_report(&self, input: BugReportInputDto) -> Result<BugReportCreatedDto> {
        let report = normalize_bug_report(input)?;
        let stored = self
            .read_cache()?
            .filter(|stored| !stored.session_token.is_empty())
            .ok_or_else(|| {
                anyhow!("Sign in with your Moobang account before submitting a bug report.")
            })?;
        let url = format!("{ACCOUNT_API_ORIGIN}/api/account/bug-reports");
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

    fn fetch_email(&self, session_token: &str) -> Result<String> {
        let url = format!("{ACCOUNT_API_ORIGIN}/api/auth/get-session");
        let response = self
            .agent
            .get(&url)
            .set("Accept", "application/json")
            .set("Authorization", &format!("Bearer {session_token}"))
            .call()
            .map_err(|_| anyhow!("Account service is unreachable at {ACCOUNT_API_ORIGIN}."))?;
        let session: ApiSessionDto = response
            .into_json()
            .map_err(|_| anyhow!("account service returned an invalid session response"))?;
        if session.user.email.is_empty() {
            return Err(anyhow!("account service returned an empty account email"));
        }
        Ok(session.user.email)
    }

    fn read_cache(&self) -> Result<Option<StoredAccount>> {
        Ok(self
            .cache
            .read()
            .map_err(|_| anyhow!("account cache poisoned"))?
            .clone())
    }

    fn post_json<T: DeserializeOwned>(
        &self,
        path: &str,
        body: serde_json::Value,
        bearer: Option<&str>,
    ) -> std::result::Result<T, HttpOutcome> {
        let url = format!("{ACCOUNT_API_ORIGIN}{path}");
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

    fn store_credential(&self, stored: StoredAccount) -> Result<()> {
        let json = serde_json::to_string(&stored)?;
        self.credential.set_password(&json).map_err(|error| {
            anyhow!(error).context("write Windows Credential Manager account entry")
        })?;
        *self
            .cache
            .write()
            .map_err(|_| anyhow!("account cache poisoned"))? = Some(stored);
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
            .map_err(|_| anyhow!("account cache poisoned"))? = None;
        deletion
    }
}

fn status_from_cache(stored: Option<&StoredAccount>) -> AccountStatusDto {
    match stored.filter(|stored| !stored.session_token.is_empty()) {
        Some(stored) => AccountStatusDto {
            signed_in: true,
            email: stored.email.clone(),
        },
        None => AccountStatusDto::default(),
    }
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

/// A credential written by an older build carries license fields this struct no
/// longer models; serde ignores them, so the session token still survives the
/// upgrade. Only genuinely unparseable JSON is discarded.
fn read_credential(entry: &Entry) -> Result<Option<StoredAccount>> {
    match entry.get_password() {
        Ok(json) => match serde_json::from_str(&json) {
            Ok(stored) => Ok(Some(stored)),
            Err(_) => {
                match entry.delete_credential() {
                    Ok(()) | Err(keyring::Error::NoEntry) => {}
                    Err(error) => {
                        return Err(anyhow!(error)
                            .context("delete malformed Windows Credential Manager account entry"))
                    }
                }
                Ok(None)
            }
        },
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(anyhow!(error).context("read Windows Credential Manager account entry")),
    }
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

#[tauri::command]
pub async fn account_status(
    service: tauri::State<'_, Arc<AccountService>>,
) -> std::result::Result<AccountStatusDto, String> {
    service.status().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn account_sign_in_start(
    service: tauri::State<'_, Arc<AccountService>>,
) -> std::result::Result<AccountSignInStartDto, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service.start_sign_in().map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn account_sign_in_poll(
    service: tauri::State<'_, Arc<AccountService>>,
    device_code: String,
) -> std::result::Result<AccountSignInPollResult, String> {
    let service = Arc::clone(service.inner());
    tauri::async_runtime::spawn_blocking(move || {
        service
            .poll_sign_in(device_code)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn account_sign_out(
    service: tauri::State<'_, Arc<AccountService>>,
) -> std::result::Result<AccountStatusDto, String> {
    service.sign_out().map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn bug_report_submit(
    service: tauri::State<'_, Arc<AccountService>>,
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

    #[test]
    fn malformed_account_credential_is_deleted_and_reports_signed_out() {
        let entry = Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        entry
            .set_password(r#"{"sessionToken":"secret""#)
            .expect("store malformed credential");

        assert!(read_credential(&entry)
            .expect("clear malformed credential")
            .is_none());
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        assert_eq!(status_from_cache(None), AccountStatusDto::default());
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

    /// A 0.5.x credential carries license fields that no longer exist. Users who
    /// were already signed in must stay signed in across the upgrade.
    #[test]
    fn legacy_license_credential_keeps_the_session_and_email() {
        let entry = Entry::new_with_credential(Box::new(keyring::mock::MockCredential::default()));
        entry
            .set_password(
                r#"{"sessionToken":"tok","plan":"pro","provider":"moobang","email":"a@b.test","activationId":"x","maxDevices":3,"devices":[],"validatedAt":null,"offlineGraceUntil":null,"trialEndsAt":null,"lastObservedAt":null}"#,
            )
            .expect("store legacy credential");

        let stored = read_credential(&entry)
            .expect("legacy credential parses")
            .expect("legacy credential is present");
        assert_eq!(
            status_from_cache(Some(&stored)),
            AccountStatusDto {
                signed_in: true,
                email: Some("a@b.test".to_string()),
            }
        );
    }

    #[test]
    fn an_empty_session_token_is_signed_out() {
        let stored = StoredAccount {
            session_token: String::new(),
            email: Some("a@b.test".to_string()),
        };
        assert_eq!(
            status_from_cache(Some(&stored)),
            AccountStatusDto::default()
        );
    }

    #[test]
    fn pending_token_errors_are_classified_without_accepting_terminal_errors() {
        assert!(token_error_is_pending("authorization_pending"));
        assert!(token_error_is_pending("slow_down"));
        assert!(!token_error_is_pending("access_denied"));
        assert!(!token_error_is_pending("expired_token"));
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

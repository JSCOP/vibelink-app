use super::DeviceCodeInfo;
use anyhow::{anyhow, Context, Result};
use keyring::Entry;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
const GITHUB_DEVICE_FLOW_UNAVAILABLE: &str =
    "github device flow is not configured in this build; use a personal access token";
const GITHUB_OAUTH_CLIENT_ID: Option<&str> = option_env!("VIBELINK_GITHUB_CLIENT_ID");

static DEVICE_FLOWS: LazyLock<Mutex<HashMap<String, PendingDeviceFlow>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Serialize, Deserialize)]
struct StoredToken {
    kind: String,
    token: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    credential_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    provider: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    scopes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScopedToken {
    pub credential_id: String,
    pub provider: String,
    pub scopes: Vec<String>,
    pub token: String,
}

#[derive(Clone)]
struct PendingDeviceFlow {
    device_code: String,
    expires_at: Instant,
    next_poll_at: Instant,
    interval: Duration,
}

#[derive(Deserialize)]
struct GithubDeviceCodeResponse {
    device_code: String,
    user_code: String,
    verification_uri: String,
    expires_in: u64,
    interval: Option<u64>,
}

#[derive(Deserialize)]
struct GithubAccessTokenResponse {
    access_token: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

pub(crate) fn set_token(host: &str, token: &str) -> Result<()> {
    let host = normalize_host(host)?;
    let token = token.trim();
    if token.is_empty() {
        return Err(anyhow!("personal access token is empty"));
    }
    let existing = read_stored_token(&host).ok().flatten();
    write_stored_token(
        &host,
        StoredToken {
            kind: "pat".to_string(),
            token: token.to_string(),
            credential_id: existing
                .as_ref()
                .and_then(|stored| stored.credential_id.clone()),
            provider: existing.as_ref().and_then(|stored| stored.provider.clone()),
            scopes: existing.map(|stored| stored.scopes).unwrap_or_default(),
        },
    )
}

pub(crate) fn set_scoped_token(
    host: &str,
    token: &str,
    credential_id: &str,
    provider: &str,
    scopes: &[String],
) -> Result<()> {
    let host = normalize_host(host)?;
    let token = token.trim();
    if token.is_empty()
        || credential_id.trim().is_empty()
        || provider.trim().is_empty()
        || scopes.is_empty()
    {
        return Err(anyhow!("scoped provider credential is incomplete"));
    }
    write_stored_token(
        &host,
        StoredToken {
            kind: "pat".to_string(),
            token: token.to_string(),
            credential_id: Some(credential_id.to_string()),
            provider: Some(provider.to_string()),
            scopes: scopes.to_vec(),
        },
    )
}

pub(crate) fn clear_token(host: &str) -> Result<()> {
    let host = normalize_host(host)?;
    let entry = credential_entry(&host)?;
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(anyhow!(redact_error(
            &host,
            &format!("delete Windows Credential Manager Git hosting entry: {error}"),
        ))),
    }
}

pub(crate) fn token_status(host: &str) -> Result<bool> {
    Ok(read_token(host)?.is_some())
}

pub(crate) fn read_token(host: &str) -> Result<Option<String>> {
    Ok(read_stored_token(host)?.map(|stored| stored.token))
}

pub(crate) fn read_scoped_token(host: &str) -> Result<Option<ScopedToken>> {
    let Some(stored) = read_stored_token(host)? else {
        return Ok(None);
    };
    let Some(credential_id) = stored.credential_id else {
        return Ok(None);
    };
    let Some(provider) = stored.provider else {
        return Ok(None);
    };
    if stored.scopes.is_empty() {
        return Ok(None);
    }
    Ok(Some(ScopedToken {
        credential_id,
        provider,
        scopes: stored.scopes,
        token: stored.token,
    }))
}

pub(crate) fn redact(error: &str, token: Option<&str>) -> String {
    match token.filter(|token| !token.is_empty()) {
        Some(token) => error.replace(token, "[REDACTED]"),
        None => error.to_string(),
    }
}

pub(crate) fn redact_error(host: &str, error: &str) -> String {
    let token = read_token(host).ok().flatten();
    redact(error, token.as_deref())
}

pub(crate) fn github_device_start() -> Result<DeviceCodeInfo> {
    let client_id = github_client_id()?;
    let response = http_agent()
        .post(GITHUB_DEVICE_CODE_URL)
        .set("Accept", "application/json")
        .send_form(&[("client_id", client_id), ("scope", "repo")])
        .map_err(device_http_error)?
        .into_json::<GithubDeviceCodeResponse>()
        .context("parse GitHub device authorization response")?;

    if response.device_code.is_empty()
        || response.user_code.is_empty()
        || response.verification_uri.is_empty()
        || response.expires_in == 0
    {
        return Err(anyhow!(
            "GitHub returned an invalid device authorization response"
        ));
    }

    let interval_secs = response.interval.unwrap_or(5).max(1);
    let handle = uuid::Uuid::new_v4().to_string();
    let now = Instant::now();
    let pending = PendingDeviceFlow {
        device_code: response.device_code,
        expires_at: now + Duration::from_secs(response.expires_in),
        next_poll_at: now,
        interval: Duration::from_secs(interval_secs),
    };
    DEVICE_FLOWS
        .lock()
        .map_err(|_| anyhow!("GitHub device flow state is unavailable"))?
        .insert(handle.clone(), pending);

    Ok(DeviceCodeInfo {
        user_code: response.user_code,
        verification_uri: response.verification_uri,
        interval: interval_secs,
        device_code_handle: handle,
    })
}

pub(crate) fn github_device_poll(handle: &str) -> Result<bool> {
    let client_id = github_client_id()?;
    let now = Instant::now();
    let pending = {
        let mut flows = DEVICE_FLOWS
            .lock()
            .map_err(|_| anyhow!("GitHub device flow state is unavailable"))?;
        let pending = flows
            .get_mut(handle)
            .ok_or_else(|| anyhow!("GitHub device flow handle is invalid or expired"))?;
        if now >= pending.expires_at {
            flows.remove(handle);
            return Err(anyhow!("GitHub device authorization expired; start again"));
        }
        if now < pending.next_poll_at {
            return Ok(false);
        }
        pending.next_poll_at = now + pending.interval;
        pending.clone()
    };

    let response = http_agent()
        .post(GITHUB_ACCESS_TOKEN_URL)
        .set("Accept", "application/json")
        .send_form(&[
            ("client_id", client_id),
            ("device_code", pending.device_code.as_str()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .map_err(device_http_error)?
        .into_json::<GithubAccessTokenResponse>()
        .context("parse GitHub device token response")?;

    if let Some(token) = response.access_token.filter(|token| !token.is_empty()) {
        remove_device_flow(handle);
        set_token("github.com", &token)
            .map_err(|error| anyhow!(redact(&error.to_string(), Some(&token))))?;
        return Ok(true);
    }

    match response.error.as_deref() {
        Some("authorization_pending") => Ok(false),
        Some("slow_down") => {
            let mut flows = DEVICE_FLOWS
                .lock()
                .map_err(|_| anyhow!("GitHub device flow state is unavailable"))?;
            if let Some(flow) = flows.get_mut(handle) {
                flow.interval += Duration::from_secs(5);
                flow.next_poll_at = Instant::now() + flow.interval;
            }
            Ok(false)
        }
        None => {
            remove_device_flow(handle);
            Err(anyhow!("GitHub returned an invalid device token response"))
        }
        Some("expired_token") => {
            remove_device_flow(handle);
            Err(anyhow!("GitHub device authorization expired; start again"))
        }
        Some("access_denied") => {
            remove_device_flow(handle);
            Err(anyhow!("GitHub device authorization was denied"))
        }
        Some(error) => {
            remove_device_flow(handle);
            let description = response
                .error_description
                .as_deref()
                .unwrap_or("GitHub device authorization failed");
            Err(anyhow!("{description} ({error})"))
        }
    }
}

pub(crate) fn normalize_host(host: &str) -> Result<String> {
    let host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty()
        || host.contains("//")
        || host.contains('/')
        || host.contains('\\')
        || host.contains('@')
        || host.chars().any(char::is_whitespace)
    {
        return Err(anyhow!("invalid Git hosting host"));
    }

    let mut host_and_port = host.split(':');
    let hostname = host_and_port.next().unwrap_or_default();
    if let Some(port) = host_and_port.next() {
        if host_and_port.next().is_some() || !matches!(port.parse::<u16>(), Ok(1..=u16::MAX)) {
            return Err(anyhow!("invalid Git hosting host"));
        }
    }
    if hostname.split('.').any(|label| {
        label.is_empty()
            || label.starts_with('-')
            || label.ends_with('-')
            || !label
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    }) {
        return Err(anyhow!("invalid Git hosting host"));
    }
    Ok(host)
}

fn credential_service() -> &'static str {
    if cfg!(debug_assertions) {
        "com.vibelink.desktop.dev.git-hosting"
    } else {
        "com.vibelink.desktop.git-hosting"
    }
}

fn credential_entry(host: &str) -> Result<Entry> {
    Entry::new(credential_service(), host)
        .context("open Windows Credential Manager Git hosting entry")
}

fn read_stored_token(host: &str) -> Result<Option<StoredToken>> {
    let host = normalize_host(host)?;
    let entry = credential_entry(&host)?;
    let json = match entry.get_password() {
        Ok(json) => json,
        Err(keyring::Error::NoEntry) => return Ok(None),
        Err(error) => {
            return Err(anyhow!(
                "read Windows Credential Manager Git hosting entry: {error}"
            ))
        }
    };
    parse_stored_token_record(&json).map(Some)
}

fn write_stored_token(host: &str, stored: StoredToken) -> Result<()> {
    let token = stored.token.clone();
    let secret = serde_json::to_string(&stored).context("serialize Git hosting credential")?;
    credential_entry(host)?
        .set_password(&secret)
        .map_err(|error| {
            anyhow!(redact(
                &format!("write Windows Credential Manager Git hosting entry: {error}"),
                Some(&token),
            ))
        })
}

fn parse_stored_token_record(json: &str) -> Result<StoredToken> {
    let stored: StoredToken =
        serde_json::from_str(json).context("parse stored Git hosting credential")?;
    if stored.kind != "pat" || stored.token.is_empty() {
        return Err(anyhow!("stored Git hosting credential is invalid"));
    }
    Ok(stored)
}

#[cfg(test)]
fn parse_stored_token(json: &str) -> Result<String> {
    Ok(parse_stored_token_record(json)?.token)
}

fn github_client_id() -> Result<&'static str> {
    GITHUB_OAUTH_CLIENT_ID
        .and_then(|client_id| {
            let client_id = client_id.trim();
            (!client_id.is_empty()).then_some(client_id)
        })
        .ok_or_else(|| anyhow!(GITHUB_DEVICE_FLOW_UNAVAILABLE))
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(15))
        .redirects(0)
        .user_agent(&format!("VibeLink/{}", env!("CARGO_PKG_VERSION")))
        .build()
}

fn device_http_error(error: ureq::Error) -> anyhow::Error {
    match error {
        ureq::Error::Status(status, _) => {
            anyhow!("GitHub device authorization request failed with HTTP {status}")
        }
        ureq::Error::Transport(_) => anyhow!("GitHub device authorization service is unavailable"),
    }
}

fn remove_device_flow(handle: &str) {
    if let Ok(mut flows) = DEVICE_FLOWS.lock() {
        flows.remove(handle);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stored_pat_round_trips_without_exposing_it_in_errors() {
        let token = "ghp_test-secret-value";
        let json = serde_json::to_string(&StoredToken {
            kind: "pat".to_string(),
            token: token.to_string(),
            credential_id: None,
            provider: None,
            scopes: Vec::new(),
        })
        .expect("serialize token");
        assert_eq!(parse_stored_token(&json).expect("parse token"), token);
        assert_eq!(json, format!(r#"{{"kind":"pat","token":"{token}"}}"#));

        let message = redact(
            &format!("request with {token} failed and repeated {token}"),
            Some(token),
        );
        assert_eq!(
            message,
            "request with [REDACTED] failed and repeated [REDACTED]"
        );
        assert!(!message.contains(token));
    }

    #[test]
    fn stored_token_requires_pat_kind_and_nonempty_secret() {
        let wrong_kind = r#"{"kind":"oauth","token":"secret"}"#;
        let empty = r#"{"kind":"pat","token":""}"#;
        assert!(parse_stored_token(wrong_kind).is_err());
        assert!(parse_stored_token(empty).is_err());
    }

    #[test]
    fn scoped_token_metadata_round_trips_without_changing_secret_reads() {
        let json = serde_json::to_string(&StoredToken {
            kind: "pat".to_string(),
            token: "secret".to_string(),
            credential_id: Some("credential-1".to_string()),
            provider: Some("github".to_string()),
            scopes: vec!["repositories:read".to_string()],
        })
        .expect("serialize scoped token");
        let stored = parse_stored_token_record(&json).expect("parse scoped token");
        assert_eq!(stored.credential_id.as_deref(), Some("credential-1"));
        assert_eq!(stored.provider.as_deref(), Some("github"));
        assert_eq!(stored.scopes, vec!["repositories:read"]);
        assert_eq!(parse_stored_token(&json).expect("read token"), "secret");
    }

    #[test]
    fn host_normalization_rejects_credential_account_injection() {
        assert_eq!(normalize_host(" GitHub.COM. ").unwrap(), "github.com");
        assert_eq!(
            normalize_host("Git.Example:8443").unwrap(),
            "git.example:8443"
        );
        for invalid in [
            "",
            "https://github.com",
            "git@github.com",
            "a/b",
            "a b",
            ":",
            "-bad.test",
            "bad..test",
            "host:not-a-port",
        ] {
            assert!(normalize_host(invalid).is_err(), "accepted {invalid}");
        }
    }
    #[test]
    fn credential_service_is_flavor_scoped() {
        let expected = if cfg!(debug_assertions) {
            "com.vibelink.desktop.dev.git-hosting"
        } else {
            "com.vibelink.desktop.git-hosting"
        };
        assert_eq!(credential_service(), expected);
    }

    #[test]
    fn missing_device_client_id_has_pat_only_error() {
        if GITHUB_OAUTH_CLIENT_ID
            .filter(|client_id| !client_id.trim().is_empty())
            .is_none()
        {
            let error = github_client_id().unwrap_err().to_string();
            assert!(error.contains("personal access token"));
            assert!(error.contains("not configured"));
        }
    }
}

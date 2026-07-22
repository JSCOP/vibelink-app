use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::time::Duration;
use url::form_urlencoded;
use uuid::Uuid;
use zeroize::Zeroize;

use crate::app::license::LicenseService;
use std::sync::Arc;
#[cfg(windows)]
use tauri::Manager;
use tauri::{AppHandle, State};

const MAX_DISCOVERY_RESULTS: usize = 100;
const MAX_COMMENT_BYTES: usize = 64 * 1024;
const MAX_ACCOUNT_BYTES: usize = 255;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Github,
    Gitlab,
    Linear,
}

impl ProviderKind {
    fn id(self) -> &'static str {
        match self {
            Self::Github => "github",
            Self::Gitlab => "gitlab",
            Self::Linear => "linear",
        }
    }

    fn default_account(self) -> &'static str {
        match self {
            Self::Github => "github.com",
            Self::Gitlab => "gitlab.com",
            Self::Linear => "api.linear.app",
        }
    }

    fn allowed_scopes(self) -> &'static [&'static str] {
        match self {
            Self::Github | Self::Gitlab => &[
                "repositories:read",
                "issues:read",
                "reviews:read",
                "reviews:comment",
            ],
            Self::Linear => &["issues:read", "issues:comment"],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialReference {
    pub credential_id: String,
    pub provider: ProviderKind,
    pub account: String,
    pub scopes: Vec<String>,
}

struct StoredCredential {
    credential_id: String,
    provider: ProviderKind,
    account: String,
    scopes: Vec<String>,
    secret: String,
}

impl Drop for StoredCredential {
    fn drop(&mut self) {
        self.secret.zeroize();
    }
}

struct CapturedSecret(String);

impl CapturedSecret {
    fn expose(&self) -> &str {
        self.0.trim()
    }
}

impl Drop for CapturedSecret {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryResource {
    Repositories,
    Issues,
    Reviews,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveryRequest {
    pub credential: CredentialReference,
    pub resource: DiscoveryResource,
    #[serde(default)]
    pub query: String,
    #[serde(default = "default_discovery_limit")]
    pub limit: usize,
}

fn default_discovery_limit() -> usize {
    30
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProviderItem {
    Repository {
        id: String,
        name: String,
        owner: String,
        web_url: String,
        clone_url: String,
        default_branch: Option<String>,
        private: bool,
    },
    Issue {
        id: String,
        identifier: String,
        title: String,
        state: String,
        web_url: String,
        repository: Option<String>,
        clone_url: Option<String>,
    },
    Review {
        id: String,
        identifier: String,
        title: String,
        state: String,
        web_url: String,
        repository: String,
        clone_url: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssignedProviderItem {
    pub provider_id: String,
    pub provider: ProviderKind,
    pub source: String,
    pub kind: String,
    pub identifier: String,
    pub title: String,
    pub state: String,
    pub repository: Option<String>,
    pub project: Option<String>,
    pub web_url: String,
    pub updated_at: Option<String>,
    pub workspace_input_capable: bool,
    pub workspace_item: Option<ProviderItem>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssignedProviderFailure {
    pub source: String,
    pub failure: ProviderFailure,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AssignedProviderResult {
    pub items: Vec<AssignedProviderItem>,
    pub failures: Vec<AssignedProviderFailure>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssignedProviderRequest {
    pub credential: CredentialReference,
    #[serde(default = "default_discovery_limit")]
    pub limit: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceCreationInput {
    pub name: String,
    pub source_kind: String,
    pub clone_url: Option<String>,
    pub suggested_directory_name: Option<String>,
    pub provider: ProviderKind,
    pub source_id: String,
    pub source_url: String,
    pub source_title: Option<String>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommentRequest {
    pub credential: CredentialReference,
    pub repository: Option<String>,
    pub target_id: String,
    pub body: String,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewCommentResult {
    pub id: String,
    pub web_url: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFailure {
    pub code: String,
    pub message: String,
    pub retryable: bool,
}

impl std::fmt::Display for ProviderFailure {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for ProviderFailure {}

impl ProviderFailure {
    fn new(code: &str, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            code: code.to_string(),
            message: message.into(),
            retryable,
        }
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message, false)
    }

    fn scope(scope: &str) -> Self {
        Self::new(
            "scope_denied",
            format!("credential does not grant required scope {scope}"),
            false,
        )
    }
}

pub fn provider_scopes(provider: ProviderKind) -> Vec<String> {
    provider
        .allowed_scopes()
        .iter()
        .map(|scope| (*scope).to_string())
        .collect()
}

pub fn capture_credential(
    request: CredentialReference,
    parent_hwnd: isize,
) -> std::result::Result<CredentialReference, ProviderFailure> {
    let account = normalize_account(request.provider, &request.account)?;
    let scopes = normalize_scopes(request.provider, request.scopes)?;
    let credential_id = normalize_credential_id(&request.credential_id)?;
    let secret = prompt_for_provider_secret(parent_hwnd, request.provider, &account)?;
    if secret.expose().is_empty() {
        return Err(ProviderFailure::invalid("provider credential is empty"));
    }
    crate::app::git::hosting::auth::set_scoped_token(
        &account,
        secret.expose(),
        &credential_id,
        request.provider.id(),
        &scopes,
    )
    .map_err(|error| {
        ProviderFailure::new(
            "credential_store_failed",
            redact_message(&error.to_string(), &[secret.expose()]),
            false,
        )
    })?;
    Ok(CredentialReference {
        credential_id,
        provider: request.provider,
        account,
        scopes,
    })
}

pub fn credential_status(
    provider: ProviderKind,
    account: &str,
) -> std::result::Result<Option<CredentialReference>, ProviderFailure> {
    let account = normalize_account(provider, account)?;
    let Some(scoped) =
        crate::app::git::hosting::auth::read_scoped_token(&account).map_err(|error| {
            ProviderFailure::new("credential_read_failed", error.to_string(), false)
        })?
    else {
        return Ok(None);
    };
    let stored = stored_from_scoped(provider, account, scoped)?;
    Ok(Some(reference_from_stored(&stored)))
}

pub fn delete_credential(
    reference: &CredentialReference,
) -> std::result::Result<(), ProviderFailure> {
    let stored = load_credential(reference)?;
    crate::app::git::hosting::auth::clear_token(&stored.account).map_err(|error| {
        ProviderFailure::new(
            "credential_delete_failed",
            redact_message(&error.to_string(), &[stored.secret.as_str()]),
            false,
        )
    })
}

pub fn discover(
    request: DiscoveryRequest,
) -> std::result::Result<Vec<ProviderItem>, ProviderFailure> {
    let credential = load_credential(&request.credential)?;
    let required_scope = match request.resource {
        DiscoveryResource::Repositories => "repositories:read",
        DiscoveryResource::Issues => "issues:read",
        DiscoveryResource::Reviews => "reviews:read",
    };
    require_scope(&credential, required_scope)?;
    let limit = request.limit.clamp(1, MAX_DISCOVERY_RESULTS);
    let query = request.query.trim();
    let result = match credential.provider {
        ProviderKind::Github => discover_github(&credential, request.resource, query, limit),
        ProviderKind::Gitlab => discover_gitlab(&credential, request.resource, query, limit),
        ProviderKind::Linear => discover_linear(&credential, request.resource, query, limit),
    };
    result.map_err(|error| redact_failure(error, &[credential.secret.as_str()]))
}

pub fn assigned_items(
    request: AssignedProviderRequest,
) -> std::result::Result<AssignedProviderResult, ProviderFailure> {
    let credential = load_credential(&request.credential)?;
    let limit = request.limit.clamp(1, MAX_DISCOVERY_RESULTS);
    let mut result = match credential.provider {
        ProviderKind::Github => assigned_github(&credential, limit),
        ProviderKind::Gitlab => assigned_gitlab(&credential, limit),
        ProviderKind::Linear => assigned_linear(&credential, limit),
    }
    .map_err(|error| redact_failure(error, &[credential.secret.as_str()]))?;
    for source_failure in &mut result.failures {
        source_failure.failure.message = redact_message(
            &source_failure.failure.message,
            &[credential.secret.as_str()],
        );
    }
    Ok(result)
}

pub fn workspace_creation_input(
    item: ProviderItem,
    provider: ProviderKind,
) -> WorkspaceCreationInput {
    match item {
        ProviderItem::Repository {
            id,
            name,
            web_url,
            clone_url,
            ..
        } => WorkspaceCreationInput {
            name: name.clone(),
            source_kind: "repository".to_string(),
            clone_url: Some(clone_url),
            suggested_directory_name: Some(sanitize_directory_name(&name)),
            provider,
            source_id: id,
            source_url: web_url,
            source_title: None,
        },
        ProviderItem::Issue {
            id,
            identifier,
            title,
            web_url,
            clone_url,
            ..
        } => WorkspaceCreationInput {
            name: format!("{identifier} {title}"),
            source_kind: "issue".to_string(),
            suggested_directory_name: clone_url
                .as_ref()
                .and_then(|url| repository_name_from_clone_url(url))
                .map(|name| sanitize_directory_name(&name)),
            clone_url,
            provider,
            source_id: id,
            source_url: web_url,
            source_title: Some(title),
        },
        ProviderItem::Review {
            id,
            identifier,
            title,
            web_url,
            clone_url,
            ..
        } => WorkspaceCreationInput {
            name: format!("{identifier} {title}"),
            source_kind: "review".to_string(),
            suggested_directory_name: clone_url
                .as_ref()
                .and_then(|url| repository_name_from_clone_url(url))
                .map(|name| sanitize_directory_name(&name)),
            clone_url,
            provider,
            source_id: id,
            source_url: web_url,
            source_title: Some(title),
        },
    }
}

pub fn create_review_comment(
    request: ReviewCommentRequest,
) -> std::result::Result<ReviewCommentResult, ProviderFailure> {
    let credential = load_credential(&request.credential)?;
    let body = request.body.trim();
    if body.is_empty() {
        return Err(ProviderFailure::invalid("review comment body is empty"));
    }
    if body.len() > MAX_COMMENT_BYTES {
        return Err(ProviderFailure::invalid(format!(
            "review comment exceeds {MAX_COMMENT_BYTES} bytes"
        )));
    }
    let result = match credential.provider {
        ProviderKind::Github => {
            require_scope(&credential, "reviews:comment")?;
            let repository = required_repository(request.repository.as_deref())?;
            github_review_comment(&credential, repository, &request.target_id, body)
        }
        ProviderKind::Gitlab => {
            require_scope(&credential, "reviews:comment")?;
            let repository = required_repository(request.repository.as_deref())?;
            gitlab_review_comment(&credential, repository, &request.target_id, body)
        }
        ProviderKind::Linear => {
            require_scope(&credential, "issues:comment")?;
            linear_issue_comment(&credential, &request.target_id, body)
        }
    };
    result.map_err(|error| redact_failure(error, &[credential.secret.as_str()]))
}

fn required_repository(repository: Option<&str>) -> std::result::Result<&str, ProviderFailure> {
    let repository = repository.unwrap_or_default().trim();
    if repository.is_empty()
        || repository.starts_with('/')
        || repository.ends_with('/')
        || repository.contains("..")
        || repository.contains('\\')
    {
        return Err(ProviderFailure::invalid(
            "repository must be a provider path such as owner/name",
        ));
    }
    Ok(repository)
}

fn normalize_account(
    provider: ProviderKind,
    account: &str,
) -> std::result::Result<String, ProviderFailure> {
    let account = if account.trim().is_empty() {
        provider.default_account()
    } else {
        account.trim()
    };
    let normalized = account
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.len() > MAX_ACCOUNT_BYTES
        || normalized.contains('/')
        || normalized.contains('\\')
        || normalized.contains('@')
        || normalized.chars().any(char::is_whitespace)
    {
        return Err(ProviderFailure::invalid("invalid provider account host"));
    }
    if provider == ProviderKind::Linear && normalized != "api.linear.app" {
        return Err(ProviderFailure::invalid(
            "Linear credentials must use api.linear.app",
        ));
    }
    Ok(normalized)
}

fn normalize_credential_id(value: &str) -> std::result::Result<String, ProviderFailure> {
    let parsed = Uuid::parse_str(value.trim())
        .map_err(|_| ProviderFailure::invalid("credential id must be a UUID"))?;
    Ok(parsed.hyphenated().to_string())
}

#[cfg(windows)]
fn prompt_for_provider_secret(
    parent_hwnd: isize,
    provider: ProviderKind,
    account: &str,
) -> std::result::Result<CapturedSecret, ProviderFailure> {
    use std::mem::size_of;
    use windows_sys::Win32::Foundation::{ERROR_CANCELLED, ERROR_SUCCESS, HWND};
    use windows_sys::Win32::Security::Credentials::{
        CredUIPromptForCredentialsW, CREDUI_FLAGS_ALWAYS_SHOW_UI, CREDUI_FLAGS_DO_NOT_PERSIST,
        CREDUI_FLAGS_GENERIC_CREDENTIALS, CREDUI_FLAGS_KEEP_USERNAME, CREDUI_INFOW,
    };

    const USERNAME_CAPACITY: usize = 513;
    const SECRET_CAPACITY: usize = 256;

    let caption = wide_null_terminated("VibeLink provider credential");
    let message = wide_null_terminated(&format!(
        "Enter the {} credential for {account} in the password field. It will be stored directly in Windows Credential Manager.",
        provider.id()
    ));
    let target = wide_null_terminated(&format!("VibeLink/{}/{account}", provider.id()));
    let mut username = vec![0u16; USERNAME_CAPACITY];
    copy_wide_to_buffer(account, &mut username);
    let mut secret_buffer = vec![0u16; SECRET_CAPACITY];
    let mut save = 0;
    let info = CREDUI_INFOW {
        cbSize: size_of::<CREDUI_INFOW>() as u32,
        hwndParent: parent_hwnd as HWND,
        pszMessageText: message.as_ptr(),
        pszCaptionText: caption.as_ptr(),
        hbmBanner: std::ptr::null_mut(),
    };
    let result = unsafe {
        CredUIPromptForCredentialsW(
            &info,
            target.as_ptr(),
            std::ptr::null(),
            0,
            username.as_mut_ptr(),
            username.len() as u32,
            secret_buffer.as_mut_ptr(),
            secret_buffer.len() as u32,
            &mut save,
            CREDUI_FLAGS_ALWAYS_SHOW_UI
                | CREDUI_FLAGS_DO_NOT_PERSIST
                | CREDUI_FLAGS_GENERIC_CREDENTIALS
                | CREDUI_FLAGS_KEEP_USERNAME,
        )
    };
    username.zeroize();
    if result == ERROR_CANCELLED {
        secret_buffer.zeroize();
        return Err(ProviderFailure::new(
            "credential_capture_cancelled",
            "Windows credential capture was cancelled",
            false,
        ));
    }
    if result != ERROR_SUCCESS {
        secret_buffer.zeroize();
        return Err(ProviderFailure::new(
            "credential_capture_failed",
            format!(
                "Windows credential capture failed: {}",
                std::io::Error::from_raw_os_error(result as i32)
            ),
            false,
        ));
    }

    let secret_len = secret_buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(secret_buffer.len());
    let decoded = String::from_utf16(&secret_buffer[..secret_len]);
    secret_buffer.zeroize();
    decoded.map(CapturedSecret).map_err(|_| {
        ProviderFailure::new(
            "credential_capture_failed",
            "Windows returned an invalid credential",
            false,
        )
    })
}

#[cfg(not(windows))]
fn prompt_for_provider_secret(
    _parent_hwnd: isize,
    _provider: ProviderKind,
    _account: &str,
) -> std::result::Result<CapturedSecret, ProviderFailure> {
    Err(ProviderFailure::new(
        "unsupported_platform",
        "Provider credential capture requires Windows Credential Manager",
        false,
    ))
}

#[cfg(windows)]
fn provider_prompt_parent(app: &AppHandle) -> isize {
    app.get_webview_window("main")
        .and_then(|window| window.hwnd().ok())
        .map(|hwnd| hwnd.0 as isize)
        .unwrap_or_default()
}

#[cfg(not(windows))]
fn provider_prompt_parent(_app: &AppHandle) -> isize {
    0
}

#[cfg(windows)]
fn wide_null_terminated(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(windows)]
fn copy_wide_to_buffer(value: &str, buffer: &mut [u16]) {
    let capacity = buffer.len().saturating_sub(1);
    for (target, source) in buffer.iter_mut().take(capacity).zip(value.encode_utf16()) {
        *target = source;
    }
}

fn normalize_scopes(
    provider: ProviderKind,
    scopes: Vec<String>,
) -> std::result::Result<Vec<String>, ProviderFailure> {
    let allowed = provider.allowed_scopes();
    let scopes: BTreeSet<String> = scopes
        .into_iter()
        .map(|scope| scope.trim().to_ascii_lowercase())
        .filter(|scope| !scope.is_empty())
        .collect();
    if scopes.is_empty() {
        return Err(ProviderFailure::invalid(
            "at least one explicit provider scope is required",
        ));
    }
    if let Some(scope) = scopes
        .iter()
        .find(|scope| !allowed.contains(&scope.as_str()))
    {
        return Err(ProviderFailure::invalid(format!(
            "scope {scope} is not valid for {}",
            provider.id()
        )));
    }
    Ok(scopes.into_iter().collect())
}

fn stored_from_scoped(
    provider: ProviderKind,
    account: String,
    scoped: crate::app::git::hosting::auth::ScopedToken,
) -> std::result::Result<StoredCredential, ProviderFailure> {
    if scoped.provider != provider.id() || scoped.token.is_empty() {
        return Err(ProviderFailure::new(
            "credential_invalid",
            "stored provider credential is invalid",
            false,
        ));
    }
    let credential_id = normalize_credential_id(&scoped.credential_id).map_err(|_| {
        ProviderFailure::new(
            "credential_invalid",
            "stored provider credential is invalid",
            false,
        )
    })?;
    let scopes = normalize_scopes(provider, scoped.scopes).map_err(|_| {
        ProviderFailure::new(
            "credential_invalid",
            "stored provider credential is invalid",
            false,
        )
    })?;
    Ok(StoredCredential {
        credential_id,
        provider,
        account,
        scopes,
        secret: scoped.token,
    })
}

fn load_credential(
    reference: &CredentialReference,
) -> std::result::Result<StoredCredential, ProviderFailure> {
    let account = normalize_account(reference.provider, &reference.account)?;
    let scoped = crate::app::git::hosting::auth::read_scoped_token(&account)
        .map_err(|error| ProviderFailure::new("credential_read_failed", error.to_string(), false))?
        .ok_or_else(|| {
            ProviderFailure::new(
                "credential_not_found",
                "provider credential was removed or is unavailable",
                false,
            )
        })?;
    let stored = stored_from_scoped(reference.provider, account.clone(), scoped)?;
    if stored.credential_id != reference.credential_id
        || stored.provider != reference.provider
        || stored.account != account
    {
        return Err(ProviderFailure::new(
            "stale_credential_ref",
            "provider credential reference is stale",
            false,
        ));
    }
    Ok(stored)
}

fn reference_from_stored(stored: &StoredCredential) -> CredentialReference {
    CredentialReference {
        credential_id: stored.credential_id.clone(),
        provider: stored.provider,
        account: stored.account.clone(),
        scopes: stored.scopes.clone(),
    }
}

fn require_scope(
    credential: &StoredCredential,
    scope: &str,
) -> std::result::Result<(), ProviderFailure> {
    if credential.scopes.iter().any(|candidate| candidate == scope) {
        Ok(())
    } else {
        Err(ProviderFailure::scope(scope))
    }
}

fn http_agent() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .timeout_connect(Duration::from_secs(5))
        .timeout_read(Duration::from_secs(20))
        .redirects(0)
        .user_agent(&format!("VibeLink/{}", env!("CARGO_PKG_VERSION")))
        .build()
}

fn assigned_github(
    credential: &StoredCredential,
    limit: usize,
) -> std::result::Result<AssignedProviderResult, ProviderFailure> {
    let base = if credential.account == "github.com" {
        "https://api.github.com".to_string()
    } else {
        format!("https://{}/api/v3", credential.account)
    };
    let mut result = AssignedProviderResult {
        items: Vec::new(),
        failures: Vec::new(),
    };

    if credential.scopes.iter().any(|scope| scope == "issues:read") {
        collect_assigned_source(
            &mut result,
            "githubAssignedIssue",
            github_get(
                credential,
                &format!("{base}/issues?filter=assigned&state=open&per_page={limit}"),
            )
            .and_then(|body| {
                parse_github_assigned(&body, credential, "githubAssignedIssue", "issue")
            }),
        );
    } else {
        result.failures.push(AssignedProviderFailure {
            source: "githubAssignedIssue".into(),
            failure: ProviderFailure::scope("issues:read"),
        });
    }

    if credential
        .scopes
        .iter()
        .any(|scope| scope == "reviews:read")
    {
        for (source, query) in [
            ("githubAuthoredReview", "is:pr is:open author:@me"),
            (
                "githubReviewRequested",
                "is:pr is:open review-requested:@me",
            ),
        ] {
            let url = format!(
                "{base}/search/issues?q={}&per_page={limit}",
                encode_query(query)
            );
            collect_assigned_source(
                &mut result,
                source,
                github_get(credential, &url)
                    .and_then(|body| parse_github_assigned(&body, credential, source, "review")),
            );
        }
    } else {
        result.failures.push(AssignedProviderFailure {
            source: "githubReviews".into(),
            failure: ProviderFailure::scope("reviews:read"),
        });
    }
    Ok(result)
}

fn assigned_gitlab(
    credential: &StoredCredential,
    limit: usize,
) -> std::result::Result<AssignedProviderResult, ProviderFailure> {
    let base = format!("https://{}/api/v4", credential.account);
    let mut result = AssignedProviderResult {
        items: Vec::new(),
        failures: Vec::new(),
    };
    if credential.scopes.iter().any(|scope| scope == "issues:read") {
        collect_assigned_source(
            &mut result,
            "gitlabAssignedIssue",
            gitlab_get(
                credential,
                &format!("{base}/issues?scope=assigned_to_me&state=opened&per_page={limit}"),
            )
            .and_then(|body| {
                parse_gitlab_assigned(&body, credential, "gitlabAssignedIssue", "issue")
            }),
        );
    } else {
        result.failures.push(AssignedProviderFailure {
            source: "gitlabAssignedIssue".into(),
            failure: ProviderFailure::scope("issues:read"),
        });
    }
    if credential
        .scopes
        .iter()
        .any(|scope| scope == "reviews:read")
    {
        collect_assigned_source(
            &mut result,
            "gitlabAssignedReview",
            gitlab_get(
                credential,
                &format!(
                    "{base}/merge_requests?scope=assigned_to_me&state=opened&per_page={limit}"
                ),
            )
            .and_then(|body| {
                parse_gitlab_assigned(&body, credential, "gitlabAssignedReview", "review")
            }),
        );
    } else {
        result.failures.push(AssignedProviderFailure {
            source: "gitlabAssignedReview".into(),
            failure: ProviderFailure::scope("reviews:read"),
        });
    }
    Ok(result)
}

fn assigned_linear(
    credential: &StoredCredential,
    limit: usize,
) -> std::result::Result<AssignedProviderResult, ProviderFailure> {
    require_scope(credential, "issues:read")?;
    let response = linear_post(
        credential,
        json!({
            "query": "query VibeLinkAssigned($first: Int!) { viewer { assignedIssues(first: $first) { nodes { id identifier title url updatedAt state { name } team { name } project { name } } } } }",
            "variables": {"first": limit},
        }),
    );
    let mut result = AssignedProviderResult {
        items: Vec::new(),
        failures: Vec::new(),
    };
    collect_assigned_source(
        &mut result,
        "linearAssignedIssue",
        response.and_then(|body| parse_linear_assigned(&body, credential)),
    );
    Ok(result)
}

fn collect_assigned_source(
    result: &mut AssignedProviderResult,
    source: &str,
    next: std::result::Result<Vec<AssignedProviderItem>, ProviderFailure>,
) {
    match next {
        Ok(mut items) => result.items.append(&mut items),
        Err(failure) => result.failures.push(AssignedProviderFailure {
            source: source.into(),
            failure,
        }),
    }
}

fn parse_github_assigned(
    body: &str,
    credential: &StoredCredential,
    source: &str,
    kind: &str,
) -> std::result::Result<Vec<AssignedProviderItem>, ProviderFailure> {
    let value: Value =
        serde_json::from_str(body).map_err(|error| parse_failure("GitHub", error.into()))?;
    let values = value
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .ok_or_else(|| parse_failure("GitHub", anyhow!("expected an item array")))?;
    let mut items = Vec::new();
    for value in values {
        let is_review = value.get("pull_request").is_some();
        if (kind == "issue" && is_review) || (kind == "review" && !is_review) {
            continue;
        }
        let repository_api = required_string(value, "repository_url")
            .map_err(|error| parse_failure("GitHub", error))?;
        let repository = repository_api
            .split("/repos/")
            .nth(1)
            .unwrap_or_default()
            .trim_matches('/')
            .to_string();
        let number =
            required_u64(value, "number").map_err(|error| parse_failure("GitHub", error))?;
        let identifier = if kind == "review" {
            format!("PR #{number}")
        } else {
            format!("#{number}")
        };
        let title =
            required_string(value, "title").map_err(|error| parse_failure("GitHub", error))?;
        let web_url =
            required_string(value, "html_url").map_err(|error| parse_failure("GitHub", error))?;
        let provider_item = if kind == "review" {
            ProviderItem::Review {
                id: value
                    .get("id")
                    .map(value_id)
                    .unwrap_or_else(|| number.to_string()),
                identifier: identifier.clone(),
                title: title.clone(),
                state: optional_string(value, "state").unwrap_or_else(|| "open".into()),
                web_url: web_url.clone(),
                repository: repository.clone(),
                clone_url: Some(format!("https://{}/{repository}.git", credential.account)),
            }
        } else {
            ProviderItem::Issue {
                id: value
                    .get("id")
                    .map(value_id)
                    .unwrap_or_else(|| number.to_string()),
                identifier: identifier.clone(),
                title: title.clone(),
                state: optional_string(value, "state").unwrap_or_else(|| "open".into()),
                web_url: web_url.clone(),
                repository: Some(repository.clone()),
                clone_url: Some(format!("https://{}/{repository}.git", credential.account)),
            }
        };
        items.push(assigned_from_provider_item(
            credential.provider,
            source,
            kind,
            identifier,
            title,
            optional_string(value, "state").unwrap_or_else(|| "open".into()),
            Some(repository.clone()),
            Some(repository),
            web_url,
            optional_string(value, "updated_at"),
            provider_item,
        ));
    }
    Ok(items)
}

fn parse_gitlab_assigned(
    body: &str,
    credential: &StoredCredential,
    source: &str,
    kind: &str,
) -> std::result::Result<Vec<AssignedProviderItem>, ProviderFailure> {
    let values: Vec<Value> =
        serde_json::from_str(body).map_err(|error| parse_failure("GitLab", error.into()))?;
    values
        .into_iter()
        .map(|value| {
            let provider_item = if kind == "review" {
                parse_gitlab_review(&value).map_err(|error| parse_failure("GitLab", error))?
            } else {
                parse_gitlab_issue(&value).map_err(|error| parse_failure("GitLab", error))?
            };
            let (identifier, title, state, web_url, repository) = match &provider_item {
                ProviderItem::Issue {
                    identifier,
                    title,
                    state,
                    web_url,
                    repository,
                    ..
                } => (
                    identifier.clone(),
                    title.clone(),
                    state.clone(),
                    web_url.clone(),
                    repository.clone(),
                ),
                ProviderItem::Review {
                    identifier,
                    title,
                    state,
                    web_url,
                    repository,
                    ..
                } => (
                    identifier.clone(),
                    title.clone(),
                    state.clone(),
                    web_url.clone(),
                    Some(repository.clone()),
                ),
                ProviderItem::Repository { .. } => unreachable!(),
            };
            Ok(assigned_from_provider_item(
                credential.provider,
                source,
                kind,
                identifier,
                title,
                state,
                repository.clone(),
                repository,
                web_url,
                optional_string(&value, "updated_at"),
                provider_item,
            ))
        })
        .collect()
}

fn parse_linear_assigned(
    body: &str,
    credential: &StoredCredential,
) -> std::result::Result<Vec<AssignedProviderItem>, ProviderFailure> {
    let value: Value =
        serde_json::from_str(body).map_err(|error| parse_failure("Linear", error.into()))?;
    if let Some(errors) = value.get("errors").and_then(Value::as_array) {
        let message = errors
            .iter()
            .filter_map(|error| error.get("message").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("; ");
        return Err(ProviderFailure::new(
            "provider_request_failed",
            message,
            false,
        ));
    }
    let nodes = value
        .pointer("/data/viewer/assignedIssues/nodes")
        .and_then(Value::as_array)
        .ok_or_else(|| parse_failure("Linear", anyhow!("response omitted assigned issues")))?;
    nodes
        .iter()
        .map(|value| {
            let id =
                required_string(value, "id").map_err(|error| parse_failure("Linear", error))?;
            let identifier = required_string(value, "identifier")
                .map_err(|error| parse_failure("Linear", error))?;
            let title =
                required_string(value, "title").map_err(|error| parse_failure("Linear", error))?;
            let web_url =
                required_string(value, "url").map_err(|error| parse_failure("Linear", error))?;
            let state = value
                .pointer("/state/name")
                .and_then(Value::as_str)
                .unwrap_or("open")
                .to_string();
            let project = value
                .pointer("/project/name")
                .and_then(Value::as_str)
                .or_else(|| value.pointer("/team/name").and_then(Value::as_str))
                .map(ToOwned::to_owned);
            let provider_item = ProviderItem::Issue {
                id: id.clone(),
                identifier: identifier.clone(),
                title: title.clone(),
                state: state.clone(),
                web_url: web_url.clone(),
                repository: None,
                clone_url: None,
            };
            Ok(assigned_from_provider_item(
                credential.provider,
                "linearAssignedIssue",
                "issue",
                identifier,
                title,
                state,
                None,
                project,
                web_url,
                optional_string(value, "updatedAt"),
                provider_item,
            ))
        })
        .collect()
}

#[allow(clippy::too_many_arguments)]
fn assigned_from_provider_item(
    provider: ProviderKind,
    source: &str,
    kind: &str,
    identifier: String,
    title: String,
    state: String,
    repository: Option<String>,
    project: Option<String>,
    web_url: String,
    updated_at: Option<String>,
    workspace_item: ProviderItem,
) -> AssignedProviderItem {
    let provider_id = match &workspace_item {
        ProviderItem::Repository { id, .. }
        | ProviderItem::Issue { id, .. }
        | ProviderItem::Review { id, .. } => id.clone(),
    };
    AssignedProviderItem {
        provider_id,
        provider,
        source: source.into(),
        kind: kind.into(),
        identifier,
        title,
        state,
        repository,
        project,
        web_url,
        updated_at,
        workspace_input_capable: true,
        workspace_item: Some(workspace_item),
    }
}

fn discover_github(
    credential: &StoredCredential,
    resource: DiscoveryResource,
    query: &str,
    limit: usize,
) -> std::result::Result<Vec<ProviderItem>, ProviderFailure> {
    let base = if credential.account == "github.com" {
        "https://api.github.com".to_string()
    } else {
        format!("https://{}/api/v3", credential.account)
    };
    let encoded = encode_query(query);
    let url = match resource {
        DiscoveryResource::Repositories if query.is_empty() => {
            format!("{base}/user/repos?sort=updated&per_page={limit}")
        }
        DiscoveryResource::Repositories => {
            format!("{base}/search/repositories?q={encoded}%20in:name&per_page={limit}")
        }
        DiscoveryResource::Issues if query.is_empty() => {
            format!("{base}/issues?filter=all&state=open&per_page={limit}")
        }
        DiscoveryResource::Issues => {
            format!("{base}/search/issues?q={encoded}%20type:issue&per_page={limit}")
        }
        DiscoveryResource::Reviews if query.is_empty() => {
            format!("{base}/issues?filter=all&state=open&per_page={limit}")
        }
        DiscoveryResource::Reviews => {
            format!("{base}/search/issues?q={encoded}%20type:pr&per_page={limit}")
        }
    };
    let body = github_get(credential, &url)?;
    parse_github_discovery(resource, &body, &credential.account)
        .map_err(|error| parse_failure("GitHub", error))
}

fn discover_gitlab(
    credential: &StoredCredential,
    resource: DiscoveryResource,
    query: &str,
    limit: usize,
) -> std::result::Result<Vec<ProviderItem>, ProviderFailure> {
    let base = format!("https://{}/api/v4", credential.account);
    let search = if query.is_empty() {
        String::new()
    } else {
        format!("&search={}", encode_query(query))
    };
    let url = match resource {
        DiscoveryResource::Repositories => {
            format!("{base}/projects?membership=true&simple=true&per_page={limit}{search}")
        }
        DiscoveryResource::Issues => {
            format!("{base}/issues?scope=all&state=opened&per_page={limit}{search}")
        }
        DiscoveryResource::Reviews => {
            format!("{base}/merge_requests?scope=all&state=opened&per_page={limit}{search}")
        }
    };
    let body = gitlab_get(credential, &url)?;
    parse_gitlab_discovery(resource, &body).map_err(|error| parse_failure("GitLab", error))
}

fn discover_linear(
    credential: &StoredCredential,
    resource: DiscoveryResource,
    query: &str,
    limit: usize,
) -> std::result::Result<Vec<ProviderItem>, ProviderFailure> {
    if resource == DiscoveryResource::Repositories || resource == DiscoveryResource::Reviews {
        return Err(ProviderFailure::new(
            "unsupported_operation",
            "Linear supports issue discovery, not repository or code-review discovery",
            false,
        ));
    }
    let filter = if query.is_empty() {
        Value::Null
    } else {
        json!({"title": {"containsIgnoreCase": query}})
    };
    let payload = json!({
        "query": "query VibeLinkIssues($first: Int!, $filter: IssueFilter) { issues(first: $first, filter: $filter) { nodes { id identifier title url state { name } } } }",
        "variables": {"first": limit, "filter": filter},
    });
    let body = linear_post(credential, payload)?;
    parse_linear_discovery(&body).map_err(|error| parse_failure("Linear", error))
}

fn github_get(
    credential: &StoredCredential,
    url: &str,
) -> std::result::Result<String, ProviderFailure> {
    provider_response(
        http_agent()
            .get(url)
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {}", credential.secret))
            .set("X-GitHub-Api-Version", "2022-11-28")
            .call(),
        "GitHub",
    )
}

fn gitlab_get(
    credential: &StoredCredential,
    url: &str,
) -> std::result::Result<String, ProviderFailure> {
    provider_response(
        http_agent()
            .get(url)
            .set("Accept", "application/json")
            .set("PRIVATE-TOKEN", &credential.secret)
            .call(),
        "GitLab",
    )
}

fn linear_post(
    credential: &StoredCredential,
    payload: Value,
) -> std::result::Result<String, ProviderFailure> {
    provider_response(
        http_agent()
            .post("https://api.linear.app/graphql")
            .set("Accept", "application/json")
            .set("Authorization", &credential.secret)
            .send_json(payload),
        "Linear",
    )
}

fn github_review_comment(
    credential: &StoredCredential,
    repository: &str,
    target_id: &str,
    body: &str,
) -> std::result::Result<ReviewCommentResult, ProviderFailure> {
    let number = parse_positive_id(target_id, "GitHub pull request number")?;
    let url = if credential.account == "github.com" {
        format!("https://api.github.com/repos/{repository}/issues/{number}/comments")
    } else {
        format!(
            "https://{}/api/v3/repos/{repository}/issues/{number}/comments",
            credential.account
        )
    };
    let response = provider_response(
        http_agent()
            .post(&url)
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {}", credential.secret))
            .set("X-GitHub-Api-Version", "2022-11-28")
            .send_json(json!({"body": body})),
        "GitHub",
    )?;
    #[derive(Deserialize)]
    struct Comment {
        id: u64,
        html_url: Option<String>,
    }
    let comment: Comment =
        serde_json::from_str(&response).map_err(|error| parse_failure("GitHub", error.into()))?;
    Ok(ReviewCommentResult {
        id: comment.id.to_string(),
        web_url: comment.html_url,
    })
}

fn gitlab_review_comment(
    credential: &StoredCredential,
    repository: &str,
    target_id: &str,
    body: &str,
) -> std::result::Result<ReviewCommentResult, ProviderFailure> {
    let number = parse_positive_id(target_id, "GitLab merge request number")?;
    let project = encode_query(repository);
    let url = format!(
        "https://{}/api/v4/projects/{project}/merge_requests/{number}/notes",
        credential.account
    );
    let response = provider_response(
        http_agent()
            .post(&url)
            .set("Accept", "application/json")
            .set("PRIVATE-TOKEN", &credential.secret)
            .send_json(json!({"body": body})),
        "GitLab",
    )?;
    #[derive(Deserialize)]
    struct Note {
        id: u64,
    }
    let note: Note =
        serde_json::from_str(&response).map_err(|error| parse_failure("GitLab", error.into()))?;
    Ok(ReviewCommentResult {
        id: note.id.to_string(),
        web_url: None,
    })
}

fn linear_issue_comment(
    credential: &StoredCredential,
    target_id: &str,
    body: &str,
) -> std::result::Result<ReviewCommentResult, ProviderFailure> {
    if target_id.trim().is_empty() {
        return Err(ProviderFailure::invalid("Linear issue id is required"));
    }
    let response = linear_post(
        credential,
        json!({
            "query": "mutation VibeLinkComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id url } } }",
            "variables": {"input": {"issueId": target_id.trim(), "body": body}},
        }),
    )?;
    #[derive(Deserialize)]
    struct Envelope {
        data: Option<CommentData>,
        errors: Option<Vec<GraphQlError>>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct CommentData {
        comment_create: CommentPayload,
    }
    #[derive(Deserialize)]
    struct CommentPayload {
        success: bool,
        comment: Option<LinearComment>,
    }
    #[derive(Deserialize)]
    struct LinearComment {
        id: String,
        url: Option<String>,
    }
    let envelope: Envelope =
        serde_json::from_str(&response).map_err(|error| parse_failure("Linear", error.into()))?;
    if let Some(errors) = envelope.errors {
        return Err(graphql_failure(errors));
    }
    let payload = envelope
        .data
        .map(|data| data.comment_create)
        .ok_or_else(|| {
            ProviderFailure::new(
                "provider_parse_failed",
                "Linear omitted comment result",
                false,
            )
        })?;
    let comment = payload.comment.filter(|_| payload.success).ok_or_else(|| {
        ProviderFailure::new(
            "provider_request_failed",
            "Linear did not create the comment",
            false,
        )
    })?;
    Ok(ReviewCommentResult {
        id: comment.id,
        web_url: comment.url,
    })
}

fn parse_positive_id(value: &str, label: &str) -> std::result::Result<u64, ProviderFailure> {
    value
        .trim()
        .parse::<u64>()
        .ok()
        .filter(|value| *value > 0)
        .ok_or_else(|| ProviderFailure::invalid(format!("{label} is invalid")))
}

fn provider_response(
    response: std::result::Result<ureq::Response, ureq::Error>,
    provider: &str,
) -> std::result::Result<String, ProviderFailure> {
    match response {
        Ok(response) => response.into_string().map_err(|error| {
            ProviderFailure::new(
                "provider_response_failed",
                format!("read {provider} response: {error}"),
                true,
            )
        }),
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            let message = provider_error_message(&body).unwrap_or_else(|| format!("HTTP {status}"));
            let code = if status == 401 || status == 403 {
                "authentication_failed"
            } else if status == 404 {
                "not_found"
            } else if status == 409 {
                "conflict"
            } else if status == 429 {
                "rate_limited"
            } else {
                "provider_request_failed"
            };
            Err(ProviderFailure::new(
                code,
                format!("{provider} request failed (HTTP {status}): {message}"),
                status == 429 || status >= 500,
            ))
        }
        Err(ureq::Error::Transport(error)) => Err(ProviderFailure::new(
            "provider_unavailable",
            format!("{provider} request failed: {error}"),
            true,
        )),
    }
}

fn provider_error_message(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    if let Some(message) = value.get("message").and_then(Value::as_str) {
        return Some(message.to_string());
    }
    value
        .get("error")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn parse_failure(provider: &str, error: anyhow::Error) -> ProviderFailure {
    ProviderFailure::new(
        "provider_parse_failed",
        format!("parse {provider} response: {error}"),
        false,
    )
}

fn redact_failure(mut failure: ProviderFailure, secrets: &[&str]) -> ProviderFailure {
    failure.message = redact_message(&failure.message, secrets);
    failure
}

pub fn redact_message(message: &str, secrets: &[&str]) -> String {
    let mut redacted = message.to_string();
    for secret in secrets.iter().copied().filter(|secret| !secret.is_empty()) {
        redacted = redacted.replace(secret, "[REDACTED]");
    }
    for marker in ["Authorization: Bearer ", "PRIVATE-TOKEN: ", "access_token="] {
        let mut search_from = 0usize;
        while let Some(offset) = redacted[search_from..].find(marker) {
            let start = search_from + offset;
            let value_start = start + marker.len();
            let value_end = redacted[value_start..]
                .find(|character: char| {
                    character.is_whitespace() || character == '&' || character == ','
                })
                .map(|offset| value_start + offset)
                .unwrap_or(redacted.len());
            if value_start == value_end {
                break;
            }
            if &redacted[value_start..value_end] != "[REDACTED]" {
                redacted.replace_range(value_start..value_end, "[REDACTED]");
            }
            search_from = value_start + "[REDACTED]".len();
        }
    }
    redacted
}

fn parse_github_discovery(
    resource: DiscoveryResource,
    body: &str,
    account: &str,
) -> Result<Vec<ProviderItem>> {
    let value: Value = serde_json::from_str(body).context("decode JSON")?;
    let items = value
        .get("items")
        .and_then(Value::as_array)
        .or_else(|| value.as_array())
        .context("expected an item array")?;
    items
        .iter()
        .filter_map(|item| match resource {
            DiscoveryResource::Repositories => parse_github_repository(item),
            DiscoveryResource::Issues => {
                if item.get("pull_request").is_some() {
                    None
                } else {
                    parse_github_issue(item, account)
                }
            }
            DiscoveryResource::Reviews => {
                if item.get("pull_request").is_some() {
                    parse_github_review(item, account)
                } else {
                    None
                }
            }
        })
        .collect::<Result<Vec<_>>>()
}

fn parse_github_repository(value: &Value) -> Option<Result<ProviderItem>> {
    Some((|| {
        let full_name = required_string(value, "full_name")?;
        let (owner, name) = full_name
            .split_once('/')
            .context("GitHub repository full_name is invalid")?;
        Ok(ProviderItem::Repository {
            id: value
                .get("id")
                .map(value_id)
                .unwrap_or_else(|| full_name.clone()),
            name: name.to_string(),
            owner: owner.to_string(),
            web_url: required_string(value, "html_url")?,
            clone_url: required_string(value, "clone_url")?,
            default_branch: optional_string(value, "default_branch"),
            private: value
                .get("private")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    })())
}

fn parse_github_issue(value: &Value, account: &str) -> Option<Result<ProviderItem>> {
    Some((|| {
        let repository_api = required_string(value, "repository_url")?;
        let repository = repository_api
            .split("/repos/")
            .nth(1)
            .context("GitHub issue repository_url is invalid")?
            .trim_matches('/')
            .to_string();
        let number = required_u64(value, "number")?;
        Ok(ProviderItem::Issue {
            id: value
                .get("id")
                .map(value_id)
                .unwrap_or_else(|| number.to_string()),
            identifier: format!("#{number}"),
            title: required_string(value, "title")?,
            state: optional_string(value, "state").unwrap_or_else(|| "open".to_string()),
            web_url: required_string(value, "html_url")?,
            repository: Some(repository.clone()),
            clone_url: Some(format!("https://{account}/{repository}.git")),
        })
    })())
}

fn parse_github_review(value: &Value, account: &str) -> Option<Result<ProviderItem>> {
    Some((|| {
        let repository_api = required_string(value, "repository_url")?;
        let repository = repository_api
            .split("/repos/")
            .nth(1)
            .context("GitHub review repository_url is invalid")?
            .trim_matches('/')
            .to_string();
        let number = required_u64(value, "number")?;
        Ok(ProviderItem::Review {
            id: value
                .get("id")
                .map(value_id)
                .unwrap_or_else(|| number.to_string()),
            identifier: format!("PR #{number}"),
            title: required_string(value, "title")?,
            state: optional_string(value, "state").unwrap_or_else(|| "open".to_string()),
            web_url: required_string(value, "html_url")?,
            repository: repository.clone(),
            clone_url: Some(format!("https://{account}/{repository}.git")),
        })
    })())
}

fn parse_gitlab_discovery(resource: DiscoveryResource, body: &str) -> Result<Vec<ProviderItem>> {
    let items: Vec<Value> = serde_json::from_str(body).context("decode JSON array")?;
    items
        .iter()
        .map(|item| match resource {
            DiscoveryResource::Repositories => parse_gitlab_repository(item),
            DiscoveryResource::Issues => parse_gitlab_issue(item),
            DiscoveryResource::Reviews => parse_gitlab_review(item),
        })
        .collect()
}

fn parse_gitlab_repository(value: &Value) -> Result<ProviderItem> {
    let path = required_string(value, "path_with_namespace")?;
    let (owner, name) = path
        .rsplit_once('/')
        .context("GitLab project path_with_namespace is invalid")?;
    Ok(ProviderItem::Repository {
        id: value
            .get("id")
            .map(value_id)
            .unwrap_or_else(|| path.clone()),
        name: name.to_string(),
        owner: owner.to_string(),
        web_url: required_string(value, "web_url")?,
        clone_url: required_string(value, "http_url_to_repo")?,
        default_branch: optional_string(value, "default_branch"),
        private: optional_string(value, "visibility").as_deref() == Some("private"),
    })
}

fn parse_gitlab_issue(value: &Value) -> Result<ProviderItem> {
    let web_url = required_string(value, "web_url")?;
    let project_url = web_url
        .split("/-/issues/")
        .next()
        .unwrap_or_default()
        .to_string();
    let repository = project_url
        .split_once("://")
        .map(|(_, rest)| {
            rest.split_once('/')
                .map(|(_, path)| path)
                .unwrap_or_default()
        })
        .unwrap_or_default()
        .to_string();
    let iid = required_u64(value, "iid")?;
    Ok(ProviderItem::Issue {
        id: value
            .get("id")
            .map(value_id)
            .unwrap_or_else(|| iid.to_string()),
        identifier: format!("#{iid}"),
        title: required_string(value, "title")?,
        state: optional_string(value, "state").unwrap_or_else(|| "opened".to_string()),
        web_url,
        repository: (!repository.is_empty()).then_some(repository),
        clone_url: (!project_url.is_empty()).then(|| format!("{project_url}.git")),
    })
}

fn parse_gitlab_review(value: &Value) -> Result<ProviderItem> {
    let web_url = required_string(value, "web_url")?;
    let project_url = web_url
        .split("/-/merge_requests/")
        .next()
        .unwrap_or_default()
        .to_string();
    let repository = project_url
        .split_once("://")
        .map(|(_, rest)| {
            rest.split_once('/')
                .map(|(_, path)| path)
                .unwrap_or_default()
        })
        .unwrap_or_default()
        .to_string();
    let iid = required_u64(value, "iid")?;
    Ok(ProviderItem::Review {
        id: value
            .get("id")
            .map(value_id)
            .unwrap_or_else(|| iid.to_string()),
        identifier: format!("MR !{iid}"),
        title: required_string(value, "title")?,
        state: optional_string(value, "state").unwrap_or_else(|| "opened".to_string()),
        web_url,
        repository,
        clone_url: (!project_url.is_empty()).then(|| format!("{project_url}.git")),
    })
}

#[derive(Deserialize)]
struct GraphQlError {
    message: String,
}

fn parse_linear_discovery(body: &str) -> Result<Vec<ProviderItem>> {
    #[derive(Deserialize)]
    struct Envelope {
        data: Option<Data>,
        errors: Option<Vec<GraphQlError>>,
    }
    #[derive(Deserialize)]
    struct Data {
        issues: Connection,
    }
    #[derive(Deserialize)]
    struct Connection {
        nodes: Vec<LinearIssue>,
    }
    #[derive(Deserialize)]
    struct LinearIssue {
        id: String,
        identifier: String,
        title: String,
        url: String,
        state: LinearState,
    }
    #[derive(Deserialize)]
    struct LinearState {
        name: String,
    }
    let envelope: Envelope = serde_json::from_str(body).context("decode GraphQL JSON")?;
    if let Some(errors) = envelope.errors {
        return Err(anyhow!(graphql_failure(errors).message));
    }
    let data = envelope.data.context("Linear response omitted data")?;
    Ok(data
        .issues
        .nodes
        .into_iter()
        .map(|issue| ProviderItem::Issue {
            id: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            state: issue.state.name,
            web_url: issue.url,
            repository: None,
            clone_url: None,
        })
        .collect())
}

fn graphql_failure(errors: Vec<GraphQlError>) -> ProviderFailure {
    ProviderFailure::new(
        "provider_request_failed",
        errors
            .into_iter()
            .map(|error| error.message)
            .collect::<Vec<_>>()
            .join("; "),
        false,
    )
}

fn required_string(value: &Value, field: &str) -> Result<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .with_context(|| format!("missing {field}"))
}

fn optional_string(value: &Value, field: &str) -> Option<String> {
    value
        .get(field)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn required_u64(value: &Value, field: &str) -> Result<u64> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .with_context(|| format!("missing {field}"))
}

fn value_id(value: &Value) -> String {
    value
        .as_str()
        .map(ToOwned::to_owned)
        .or_else(|| value.as_u64().map(|value| value.to_string()))
        .unwrap_or_default()
}

fn encode_query(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn sanitize_directory_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches(['.', '-', ' '])
        .to_string();
    if sanitized.is_empty() {
        "workspace".to_string()
    } else {
        sanitized
    }
}

fn repository_name_from_clone_url(url: &str) -> Option<String> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()
        .map(|name| name.trim_end_matches(".git").to_string())
        .filter(|name| !name.is_empty())
}

#[tauri::command]
pub async fn provider_scopes_list(
    license: State<'_, Arc<LicenseService>>,
    provider: ProviderKind,
) -> std::result::Result<Vec<String>, ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    Ok(provider_scopes(provider))
}

#[tauri::command]
pub async fn provider_credential_capture(
    app: AppHandle,
    license: State<'_, Arc<LicenseService>>,
    request: CredentialReference,
) -> std::result::Result<CredentialReference, ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    let parent_hwnd = provider_prompt_parent(&app);
    tauri::async_runtime::spawn_blocking(move || capture_credential(request, parent_hwnd))
        .await
        .map_err(|error| ProviderFailure::new("internal", error.to_string(), false))?
}

#[tauri::command]
pub async fn provider_credential_status(
    license: State<'_, Arc<LicenseService>>,
    provider: ProviderKind,
    account: String,
) -> std::result::Result<Option<CredentialReference>, ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    tauri::async_runtime::spawn_blocking(move || credential_status(provider, &account))
        .await
        .map_err(|error| ProviderFailure::new("internal", error.to_string(), false))?
}

#[tauri::command]
pub async fn provider_credential_delete(
    license: State<'_, Arc<LicenseService>>,
    reference: CredentialReference,
) -> std::result::Result<(), ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    tauri::async_runtime::spawn_blocking(move || delete_credential(&reference))
        .await
        .map_err(|error| ProviderFailure::new("internal", error.to_string(), false))?
}

#[tauri::command]
pub async fn provider_discover(
    license: State<'_, Arc<LicenseService>>,
    request: DiscoveryRequest,
) -> std::result::Result<Vec<ProviderItem>, ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    tauri::async_runtime::spawn_blocking(move || discover(request))
        .await
        .map_err(|error| ProviderFailure::new("internal", error.to_string(), false))?
}

#[tauri::command]
pub async fn provider_assigned_items(
    license: State<'_, Arc<LicenseService>>,
    request: AssignedProviderRequest,
) -> std::result::Result<AssignedProviderResult, ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    tauri::async_runtime::spawn_blocking(move || assigned_items(request))
        .await
        .map_err(|error| ProviderFailure::new("internal", error.to_string(), false))?
}

#[tauri::command]
pub async fn provider_workspace_input(
    license: State<'_, Arc<LicenseService>>,
    provider: ProviderKind,
    item: ProviderItem,
) -> std::result::Result<WorkspaceCreationInput, ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    Ok(workspace_creation_input(item, provider))
}

#[tauri::command]
pub async fn provider_review_comment(
    license: State<'_, Arc<LicenseService>>,
    request: ReviewCommentRequest,
) -> std::result::Result<ReviewCommentResult, ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    tauri::async_runtime::spawn_blocking(move || create_review_comment(request))
        .await
        .map_err(|error| ProviderFailure::new("internal", error.to_string(), false))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(provider: ProviderKind, scopes: &[&str]) -> StoredCredential {
        StoredCredential {
            credential_id: Uuid::nil().to_string(),
            provider,
            account: provider.default_account().into(),
            scopes: scopes.iter().map(|scope| (*scope).into()).collect(),
            secret: String::new(),
        }
    }

    #[test]
    fn validates_explicit_provider_scopes() {
        let scopes = normalize_scopes(
            ProviderKind::Github,
            vec!["reviews:read".into(), "repositories:read".into()],
        )
        .expect("valid scopes");
        assert_eq!(scopes, vec!["repositories:read", "reviews:read"]);
        assert!(normalize_scopes(ProviderKind::Linear, vec![]).is_err());
        assert!(normalize_scopes(ProviderKind::Linear, vec!["repositories:read".into()]).is_err());
    }

    #[test]
    fn denies_operations_without_the_required_scope() {
        let credential = stored(ProviderKind::Github, &["repositories:read"]);
        let error = require_scope(&credential, "reviews:comment").expect_err("scope denial");
        assert_eq!(error.code, "scope_denied");
        assert!(error.message.contains("reviews:comment"));
    }

    #[test]
    fn parses_github_repository_issue_and_review_discovery() {
        let repositories = parse_github_discovery(
            DiscoveryResource::Repositories,
            r#"{"items":[{"id":1,"full_name":"acme/widget","html_url":"https://github.com/acme/widget","clone_url":"https://github.com/acme/widget.git","default_branch":"main","private":true}]}"#,
            "github.com",
        )
        .expect("repositories");
        assert!(
            matches!(&repositories[0], ProviderItem::Repository { owner, private: true, .. } if owner == "acme")
        );

        let issue = r#"{"items":[{"id":2,"number":17,"title":"Fix it","state":"open","html_url":"https://github.com/acme/widget/issues/17","repository_url":"https://api.github.com/repos/acme/widget"}]}"#;
        let issues =
            parse_github_discovery(DiscoveryResource::Issues, issue, "github.com").expect("issues");
        assert!(
            matches!(&issues[0], ProviderItem::Issue { identifier, clone_url: Some(url), .. } if identifier == "#17" && url.ends_with("acme/widget.git"))
        );

        let review = r#"{"items":[{"id":3,"number":18,"title":"Ship it","state":"open","html_url":"https://github.com/acme/widget/pull/18","repository_url":"https://api.github.com/repos/acme/widget","pull_request":{}}]}"#;
        let reviews = parse_github_discovery(DiscoveryResource::Reviews, review, "github.com")
            .expect("reviews");
        assert!(
            matches!(&reviews[0], ProviderItem::Review { identifier, repository, .. } if identifier == "PR #18" && repository == "acme/widget")
        );
    }

    #[test]
    fn parses_gitlab_and_linear_discovery() {
        let projects = parse_gitlab_discovery(
            DiscoveryResource::Repositories,
            r#"[{"id":9,"path_with_namespace":"group/widget","web_url":"https://gitlab.com/group/widget","http_url_to_repo":"https://gitlab.com/group/widget.git","default_branch":"main","visibility":"private"}]"#,
        )
        .expect("GitLab projects");
        assert!(
            matches!(&projects[0], ProviderItem::Repository { owner, private: true, .. } if owner == "group")
        );

        let issues = parse_linear_discovery(
            r#"{"data":{"issues":{"nodes":[{"id":"lin-1","identifier":"ENG-42","title":"Fix sync","url":"https://linear.app/acme/issue/ENG-42/fix-sync","state":{"name":"Todo"}}]}}}"#,
        )
        .expect("Linear issues");
        assert!(
            matches!(&issues[0], ProviderItem::Issue { identifier, repository: None, .. } if identifier == "ENG-42")
        );
    }

    #[test]
    fn builds_workspace_inputs_without_duplicating_git_operations() {
        let input = workspace_creation_input(
            ProviderItem::Issue {
                id: "issue-1".into(),
                identifier: "ENG-42".into(),
                title: "Fix sync".into(),
                state: "Todo".into(),
                web_url: "https://linear.app/acme/issue/ENG-42".into(),
                repository: None,
                clone_url: None,
            },
            ProviderKind::Linear,
        );
        assert_eq!(input.source_kind, "issue");
        assert_eq!(input.name, "ENG-42 Fix sync");
        assert!(input.clone_url.is_none());
    }
}

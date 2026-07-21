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
use tauri::State;

const MAX_DISCOVERY_RESULTS: usize = 100;
const MAX_COMMENT_BYTES: usize = 64 * 1024;

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

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreCredentialRequest {
    pub provider: ProviderKind,
    #[serde(default)]
    pub account: String,
    pub token: String,
    pub scopes: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CredentialReference {
    pub id: String,
    pub provider: ProviderKind,
    pub account: String,
    pub scopes: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredCredential {
    version: u8,
    id: String,
    provider: ProviderKind,
    account: String,
    scopes: Vec<String>,
    token: String,
}

impl Drop for StoredCredential {
    fn drop(&mut self) {
        self.token.zeroize();
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

pub fn store_credential(
    request: StoreCredentialRequest,
) -> std::result::Result<CredentialReference, ProviderFailure> {
    let account = normalize_account(request.provider, &request.account)?;
    let token = request.token.trim();
    if token.is_empty() {
        return Err(ProviderFailure::invalid("provider token is empty"));
    }
    let scopes = normalize_scopes(request.provider, request.scopes)?;
    let stored = StoredCredential {
        version: 1,
        id: Uuid::new_v4().to_string(),
        provider: request.provider,
        account: account.clone(),
        scopes: scopes.clone(),
        token: token.to_string(),
    };
    crate::app::git::hosting::auth::set_scoped_token(
        &account,
        token,
        &stored.id,
        request.provider.id(),
        &scopes,
    )
    .map_err(|error| {
        ProviderFailure::new(
            "credential_store_failed",
            redact_message(&error.to_string(), &[token]),
            false,
        )
    })?;
    Ok(reference_from_stored(&stored))
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
            redact_message(&error.to_string(), &[stored.token.as_str()]),
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
    result.map_err(|error| redact_failure(error, &[credential.token.as_str()]))
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
    result.map_err(|error| redact_failure(error, &[credential.token.as_str()]))
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
    if scoped.credential_id.is_empty()
        || scoped.provider != provider.id()
        || scoped.token.is_empty()
        || scoped.scopes.is_empty()
    {
        return Err(ProviderFailure::new(
            "credential_invalid",
            "stored provider credential is invalid",
            false,
        ));
    }
    Ok(StoredCredential {
        version: 1,
        id: scoped.credential_id,
        provider,
        account,
        scopes: scoped.scopes,
        token: scoped.token,
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
    if stored.id != reference.id
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
        id: stored.id.clone(),
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
            .set("Authorization", &format!("Bearer {}", credential.token))
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
            .set("PRIVATE-TOKEN", &credential.token)
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
            .set("Authorization", &credential.token)
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
            .set("Authorization", &format!("Bearer {}", credential.token))
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
            .set("PRIVATE-TOKEN", &credential.token)
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
pub async fn provider_credential_store(
    license: State<'_, Arc<LicenseService>>,
    request: StoreCredentialRequest,
) -> std::result::Result<CredentialReference, ProviderFailure> {
    license
        .require_entitled_cached()
        .map_err(|error| ProviderFailure::new("denied_capability", error.to_string(), false))?;
    tauri::async_runtime::spawn_blocking(move || store_credential(request))
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
            version: 1,
            id: "credential-id".into(),
            provider,
            account: provider.default_account().into(),
            scopes: scopes.iter().map(|scope| (*scope).into()).collect(),
            token: "secret-token".into(),
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
    fn redacts_exact_and_header_secrets() {
        let message = "request secret-token Authorization: Bearer another-secret PRIVATE-TOKEN: third access_token=fourth&x=1";
        let redacted = redact_message(message, &["secret-token"]);
        assert!(!redacted.contains("secret-token"));
        assert!(!redacted.contains("another-secret"));
        assert!(!redacted.contains("third"));
        assert!(!redacted.contains("fourth"));
        assert!(redacted.contains("[REDACTED]"));
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

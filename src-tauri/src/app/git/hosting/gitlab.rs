use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

use super::{
    CiCheck, CiStatus, CreatePrRequest, HostingClient, PrCreated, PrDetail, PrInfo,
    ProviderMergeState,
};

pub(crate) struct GitlabClient {
    agent: ureq::Agent,
    pub(crate) base_url: String,
    project: String,
    token: String,
}

impl GitlabClient {
    pub(crate) fn new(
        host: impl AsRef<str>,
        owner: impl AsRef<str>,
        repo: impl AsRef<str>,
        token: impl Into<String>,
    ) -> Self {
        let host = host
            .as_ref()
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/');
        Self::with_base_url(format!("https://{host}/api/v4"), owner, repo, token)
    }

    pub(crate) fn with_base_url(
        base_url: impl Into<String>,
        owner: impl AsRef<str>,
        repo: impl AsRef<str>,
        token: impl Into<String>,
    ) -> Self {
        let project_path = format!("{}/{}", owner.as_ref(), repo.as_ref());
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(5))
                .timeout_read(Duration::from_secs(15))
                .user_agent(&format!("VibeLink/{}", env!("CARGO_PKG_VERSION")))
                .build(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            project: percent_encode(&project_path),
            token: token.into(),
        }
    }

    fn project_url(&self, suffix: &str) -> String {
        format!("{}/projects/{}{}", self.base_url, self.project, suffix)
    }

    fn request(&self, method: &str, url: &str) -> ureq::Request {
        self.agent
            .request(method, url)
            .set("Accept", "application/json")
            .set("PRIVATE-TOKEN", &self.token)
    }

    fn get(&self, url: &str) -> Result<String> {
        response_body(self.request("GET", url).call(), "GitLab", &self.token)
    }

    fn post(&self, url: &str, body: serde_json::Value) -> Result<String> {
        response_body(
            self.request("POST", url).send_json(body),
            "GitLab",
            &self.token,
        )
    }

    fn put(&self, url: &str, body: serde_json::Value) -> Result<String> {
        response_body(
            self.request("PUT", url).send_json(body),
            "GitLab",
            &self.token,
        )
    }

    fn ci_for_ref(&self, ref_name: &str) -> Result<CiStatus> {
        let body = self.get(&self.project_url(&format!(
            "/pipelines?ref={}&per_page=100",
            percent_encode(ref_name)
        )))?;
        parse_gitlab_ci(&body)
    }

    fn ci_for_merge(&self, source_branch: &str, head_sha: &str) -> Result<CiStatus> {
        let body = self.get(&self.project_url(&format!(
            "/pipelines?ref={}&sha={}&per_page=100",
            percent_encode(source_branch),
            percent_encode(head_sha),
        )))?;
        parse_gitlab_ci(&body)
    }
}

impl HostingClient for GitlabClient {
    fn list_prs(&self) -> Result<Vec<PrInfo>> {
        let body = self.get(&self.project_url("/merge_requests?state=opened&per_page=100"))?;
        parse_gitlab_pr_list(&body)
    }

    fn create_pr(&self, request: &CreatePrRequest) -> Result<PrCreated> {
        let title = if request.draft
            && !request.title.starts_with("Draft:")
            && !request.title.starts_with("WIP:")
        {
            format!("Draft: {}", request.title)
        } else {
            request.title.clone()
        };
        let body = self.post(
            &self.project_url("/merge_requests"),
            json!({
                "title": title,
                "description": request.body,
                "source_branch": request.source_branch,
                "target_branch": request.target_branch,
            }),
        )?;
        parse_gitlab_pr_created(&body)
    }

    fn pr_detail(&self, number: u64) -> Result<PrDetail> {
        let body = self.get(&self.project_url(&format!("/merge_requests/{number}")))?;
        let parsed = parse_gitlab_pr_detail_base(&body)?;
        let ci = self.ci_for_ref(&parsed.source_branch)?;
        Ok(parsed.into_detail(ci.checks))
    }

    fn ci_status(&self, ref_name: &str) -> Result<CiStatus> {
        self.ci_for_ref(ref_name)
    }

    fn merge_state(&self, number: u64) -> Result<ProviderMergeState> {
        let body = self.get(&self.project_url(&format!(
            "/merge_requests/{number}?include_rebase_in_progress=true"
        )))?;
        let value: serde_json::Value =
            serde_json::from_str(&body).context("parse GitLab merge request state")?;
        let source_branch = value
            .get("source_branch")
            .and_then(serde_json::Value::as_str)
            .context("GitLab merge request has no source branch")?
            .to_string();
        let target_branch = value
            .get("target_branch")
            .and_then(serde_json::Value::as_str)
            .context("GitLab merge request has no target branch")?
            .to_string();
        let head_sha = value
            .get("sha")
            .and_then(serde_json::Value::as_str)
            .or_else(|| {
                value
                    .pointer("/diff_refs/head_sha")
                    .and_then(serde_json::Value::as_str)
            })
            .context("GitLab merge request has no head SHA")?
            .to_string();
        let detailed = value
            .get("detailed_merge_status")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let has_conflicts = value
            .get("has_conflicts")
            .and_then(serde_json::Value::as_bool);
        let conflict_free = match (has_conflicts, detailed) {
            (Some(false), "mergeable" | "ci_must_pass" | "ci_still_running" | "not_approved") => {
                Some(true)
            }
            (Some(true), _) => Some(false),
            _ => None,
        };
        let ci = self.ci_for_merge(&source_branch, &head_sha)?;
        let required_checks_known = !ci.checks.is_empty();
        Ok(ProviderMergeState {
            number,
            source_branch,
            target_branch,
            head_sha,
            conflict_free,
            required_checks_known,
            required_checks: ci.checks,
        })
    }

    fn merge_pr(&self, number: u64, expected_head_sha: &str) -> Result<(Option<String>, String)> {
        let body = self.put(
            &self.project_url(&format!("/merge_requests/{number}/merge")),
            json!({ "sha": expected_head_sha, "should_remove_source_branch": false }),
        )?;
        let value: serde_json::Value =
            serde_json::from_str(&body).context("parse GitLab merge response")?;
        if value.get("state").and_then(serde_json::Value::as_str) != Some("merged") {
            anyhow::bail!(
                "GitLab refused merge: {}",
                value
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown reason")
            );
        }
        Ok((
            value
                .get("merge_commit_sha")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            "merged".to_string(),
        ))
    }
}

fn response_body(
    response: std::result::Result<ureq::Response, ureq::Error>,
    provider: &str,
    token: &str,
) -> Result<String> {
    match response {
        Ok(response) => response
            .into_string()
            .with_context(|| format!("read {provider} API response")),
        Err(ureq::Error::Status(status, response)) => {
            let body = response.into_string().unwrap_or_default();
            Err(http_status_error(provider, status, &body, token))
        }
        Err(ureq::Error::Transport(error)) => Err(anyhow!(
            "{provider} API request failed: {}",
            redact_secret(&error.to_string(), token)
        )),
    }
}

pub(crate) fn http_status_error(
    provider: &str,
    status: u16,
    body: &str,
    token: &str,
) -> anyhow::Error {
    if status == 401 || status == 403 {
        return anyhow!("AUTH:{provider} authentication failed (HTTP {status})");
    }

    let message = api_error_message(body).unwrap_or_else(|| format!("HTTP {status}"));
    anyhow!(
        "{provider} API request failed (HTTP {status}): {}",
        redact_secret(&message, token)
    )
}

fn api_error_message(body: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(body).ok()?;
    match value.get("message")? {
        serde_json::Value::String(message) => Some(message.clone()),
        message => Some(message.to_string()),
    }
}

fn redact_secret(message: &str, token: &str) -> String {
    if token.is_empty() {
        message.to_string()
    } else {
        message.replace(token, "[REDACTED]")
    }
}

pub(crate) fn percent_encode(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(char::from(byte));
        } else {
            encoded.push('%');
            encoded.push(char::from(b"0123456789ABCDEF"[(byte >> 4) as usize]));
            encoded.push(char::from(b"0123456789ABCDEF"[(byte & 0x0f) as usize]));
        }
    }
    encoded
}

#[derive(Deserialize)]
struct GitlabAuthor {
    #[serde(default)]
    username: String,
    #[serde(default)]
    name: String,
}

impl GitlabAuthor {
    fn display_name(self) -> String {
        if self.username.is_empty() {
            self.name
        } else {
            self.username
        }
    }
}

#[derive(Deserialize)]
struct GitlabMergeRequest {
    iid: u64,
    title: String,
    #[serde(default)]
    description: Option<String>,
    author: GitlabAuthor,
    source_branch: String,
    target_branch: String,
    #[serde(default)]
    draft: bool,
    #[serde(default)]
    work_in_progress: bool,
    web_url: String,
    state: String,
    #[serde(default)]
    sha: Option<String>,
}

impl GitlabMergeRequest {
    fn is_draft(&self) -> bool {
        self.draft
            || self.work_in_progress
            || self.title.starts_with("Draft:")
            || self.title.starts_with("WIP:")
    }

    fn into_info(self) -> PrInfo {
        let draft = self.is_draft();
        PrInfo {
            number: self.iid,
            title: self.title,
            author: self.author.display_name(),
            source_branch: self.source_branch,
            target_branch: self.target_branch,
            draft,
            url: self.web_url,
            state: self.state,
        }
    }
}

struct GitlabPrDetailBase {
    merge_request: GitlabMergeRequest,
    source_branch: String,
}

impl GitlabPrDetailBase {
    fn into_detail(self, checks: Vec<CiCheck>) -> PrDetail {
        let draft = self.merge_request.is_draft();
        PrDetail {
            number: self.merge_request.iid,
            title: self.merge_request.title,
            body: self.merge_request.description.unwrap_or_default(),
            author: self.merge_request.author.display_name(),
            source_branch: self.merge_request.source_branch,
            target_branch: self.merge_request.target_branch,
            draft,
            url: self.merge_request.web_url,
            state: self.merge_request.state,
            head_sha: self.merge_request.sha,
            checks,
        }
    }
}

pub(crate) fn parse_gitlab_pr_list(body: &str) -> Result<Vec<PrInfo>> {
    let merge_requests: Vec<GitlabMergeRequest> =
        serde_json::from_str(body).context("parse GitLab merge request list")?;
    Ok(merge_requests
        .into_iter()
        .map(GitlabMergeRequest::into_info)
        .collect())
}

pub(crate) fn parse_gitlab_pr_created(body: &str) -> Result<PrCreated> {
    #[derive(Deserialize)]
    struct Created {
        iid: u64,
        web_url: String,
    }

    let created: Created =
        serde_json::from_str(body).context("parse GitLab merge request creation response")?;
    Ok(PrCreated {
        number: created.iid,
        url: created.web_url,
    })
}

fn parse_gitlab_pr_detail_base(body: &str) -> Result<GitlabPrDetailBase> {
    let merge_request: GitlabMergeRequest =
        serde_json::from_str(body).context("parse GitLab merge request detail")?;
    let source_branch = merge_request.source_branch.clone();
    Ok(GitlabPrDetailBase {
        merge_request,
        source_branch,
    })
}

#[cfg(test)]
pub(crate) fn parse_gitlab_pr_detail(body: &str, checks: Vec<CiCheck>) -> Result<PrDetail> {
    Ok(parse_gitlab_pr_detail_base(body)?.into_detail(checks))
}

#[derive(Deserialize)]
struct GitlabPipeline {
    id: u64,
    status: String,
    #[serde(default)]
    web_url: Option<String>,
}

pub(crate) fn parse_gitlab_ci(body: &str) -> Result<CiStatus> {
    let pipelines: Vec<GitlabPipeline> =
        serde_json::from_str(body).context("parse GitLab pipelines")?;
    let checks: Vec<CiCheck> = pipelines
        .into_iter()
        .map(|pipeline| CiCheck {
            name: format!("pipeline #{}", pipeline.id),
            state: normalize_gitlab_ci_state(&pipeline.status).to_string(),
            url: pipeline.web_url,
        })
        .collect();

    Ok(CiStatus {
        state: aggregate_ci_state(checks.iter().map(|check| check.state.as_str())).to_string(),
        checks,
    })
}

fn normalize_gitlab_ci_state(status: &str) -> &'static str {
    match status {
        "success" | "skipped" => "success",
        "created"
        | "waiting_for_resource"
        | "preparing"
        | "pending"
        | "running"
        | "scheduled"
        | "manual" => "pending",
        "" => "none",
        _ => "failure",
    }
}

fn aggregate_ci_state<'a>(states: impl IntoIterator<Item = &'a str>) -> &'static str {
    let mut saw_pending = false;
    let mut saw_success = false;
    for state in states {
        match state {
            "failure" => return "failure",
            "pending" => saw_pending = true,
            "success" => saw_success = true,
            _ => {}
        }
    }
    if saw_pending {
        "pending"
    } else if saw_success {
        "success"
    } else {
        "none"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MERGE_REQUEST: &str = r#"{
        "iid": 17,
        "title": "Draft: Ship hosting",
        "description": "Adds GitLab support",
        "author": {"username": "tanuki", "name": "GitLab User"},
        "source_branch": "feature/hosting",
        "target_branch": "main",
        "draft": true,
        "work_in_progress": false,
        "web_url": "https://gitlab.example/acme/widget/-/merge_requests/17",
        "state": "opened"
    }"#;

    #[test]
    fn parses_merge_request_list_fixture() {
        let requests = parse_gitlab_pr_list(&format!("[{MERGE_REQUEST}]")).expect("parse list");
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0].number, 17);
        assert_eq!(requests[0].author, "tanuki");
        assert_eq!(requests[0].target_branch, "main");
        assert!(requests[0].draft);
    }

    #[test]
    fn parses_create_fixture() {
        let created = parse_gitlab_pr_created(
            r#"{"iid":17,"web_url":"https://gitlab.example/acme/widget/-/merge_requests/17"}"#,
        )
        .expect("parse created");
        assert_eq!(created.number, 17);
        assert_eq!(
            created.url,
            "https://gitlab.example/acme/widget/-/merge_requests/17"
        );
    }

    #[test]
    fn parses_detail_fixture_with_checks() {
        let checks = vec![CiCheck {
            name: "pipeline #99".into(),
            state: "success".into(),
            url: Some("https://gitlab.example/acme/widget/-/pipelines/99".into()),
        }];
        let detail = parse_gitlab_pr_detail(MERGE_REQUEST, checks).expect("parse detail");
        assert_eq!(detail.body, "Adds GitLab support");
        assert_eq!(detail.checks[0].name, "pipeline #99");
        assert!(detail.checks[0].url.is_some());
    }

    #[test]
    fn parses_pipelines_with_failure_precedence_and_urls() {
        let ci = parse_gitlab_ci(
            r#"[
                {"id":101,"status":"success","web_url":"https://gitlab.example/pipelines/101"},
                {"id":102,"status":"running","web_url":"https://gitlab.example/pipelines/102"},
                {"id":103,"status":"failed","web_url":"https://gitlab.example/pipelines/103"}
            ]"#,
        )
        .expect("parse pipelines");
        assert_eq!(ci.state, "failure");
        assert_eq!(ci.checks[0].state, "success");
        assert_eq!(ci.checks[1].state, "pending");
        assert_eq!(ci.checks[2].state, "failure");
        assert_eq!(
            ci.checks[2].url.as_deref(),
            Some("https://gitlab.example/pipelines/103")
        );

        let pending = parse_gitlab_ci(
            r#"[
                {"id":201,"status":"success","web_url":null},
                {"id":202,"status":"running","web_url":null}
            ]"#,
        )
        .expect("parse pending pipelines");
        assert_eq!(pending.state, "pending");

        let success = parse_gitlab_ci(r#"[{"id":203,"status":"skipped","web_url":null}]"#)
            .expect("parse successful pipeline");
        assert_eq!(success.state, "success");

        let none = parse_gitlab_ci("[]").expect("parse empty pipelines");
        assert_eq!(none.state, "none");
    }

    #[test]
    fn auth_status_errors_are_prefixed_and_other_errors_redact_tokens() {
        let auth = http_status_error("GitLab", 403, r#"{"message":"denied"}"#, "secret");
        assert!(auth.to_string().starts_with("AUTH:"));

        let error = http_status_error(
            "GitLab",
            400,
            r#"{"message":"token secret is invalid"}"#,
            "secret",
        );
        assert!(!error.to_string().contains("secret"));
        assert!(error.to_string().contains("[REDACTED]"));
    }

    #[test]
    fn encodes_nested_project_paths_and_query_refs() {
        assert_eq!(
            percent_encode("group/subgroup/repo"),
            "group%2Fsubgroup%2Frepo"
        );
        assert_eq!(percent_encode("feature/a b"), "feature%2Fa%20b");
    }

    #[test]
    fn self_hosted_constructor_builds_https_v4_base_url() {
        let client = GitlabClient::new("gitlab.example/", "group", "repo", "token");
        assert_eq!(client.base_url, "https://gitlab.example/api/v4");
        assert_eq!(client.project, "group%2Frepo");
    }
}

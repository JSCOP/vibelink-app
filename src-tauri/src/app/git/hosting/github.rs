use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::json;
use std::time::Duration;

use super::{
    CiCheck, CiStatus, CreatePrRequest, HostingClient, PrCreated, PrDetail, PrInfo,
    ProviderMergeState,
};

const GITHUB_API_URL: &str = "https://api.github.com";

pub(crate) struct GithubClient {
    agent: ureq::Agent,
    pub(crate) base_url: String,
    owner: String,
    repo: String,
    token: String,
}

impl GithubClient {
    pub(crate) fn new(
        owner: impl Into<String>,
        repo: impl Into<String>,
        token: impl Into<String>,
    ) -> Self {
        Self::with_base_url(GITHUB_API_URL, owner, repo, token)
    }

    pub(crate) fn with_base_url(
        base_url: impl Into<String>,
        owner: impl Into<String>,
        repo: impl Into<String>,
        token: impl Into<String>,
    ) -> Self {
        Self {
            agent: ureq::AgentBuilder::new()
                .timeout_connect(Duration::from_secs(5))
                .timeout_read(Duration::from_secs(15))
                .user_agent(&format!("VibeLink/{}", env!("CARGO_PKG_VERSION")))
                .build(),
            base_url: base_url.into().trim_end_matches('/').to_string(),
            owner: owner.into(),
            repo: repo.into(),
            token: token.into(),
        }
    }

    fn repo_url(&self, suffix: &str) -> String {
        format!(
            "{}/repos/{}/{}{}",
            self.base_url, self.owner, self.repo, suffix
        )
    }

    fn request(&self, method: &str, url: &str) -> ureq::Request {
        self.agent
            .request(method, url)
            .set("Accept", "application/vnd.github+json")
            .set("Authorization", &format!("Bearer {}", self.token))
            .set("X-GitHub-Api-Version", "2022-11-28")
    }

    fn get(&self, url: &str) -> Result<String> {
        response_body(self.request("GET", url).call(), "GitHub", &self.token)
    }

    fn post(&self, url: &str, body: serde_json::Value) -> Result<String> {
        response_body(
            self.request("POST", url).send_json(body),
            "GitHub",
            &self.token,
        )
    }

    fn put(&self, url: &str, body: serde_json::Value) -> Result<String> {
        response_body(
            self.request("PUT", url).send_json(body),
            "GitHub",
            &self.token,
        )
    }

    fn ci_for_ref(&self, ref_name: &str) -> Result<CiStatus> {
        let encoded_ref = percent_encode_segment(ref_name);
        let check_runs =
            self.get(&self.repo_url(&format!("/commits/{encoded_ref}/check-runs?per_page=100")))?;
        let commit_status =
            self.get(&self.repo_url(&format!("/commits/{encoded_ref}/status?per_page=100")))?;
        parse_github_ci(&check_runs, &commit_status)
    }
}

impl HostingClient for GithubClient {
    fn list_prs(&self) -> Result<Vec<PrInfo>> {
        let body = self.get(&self.repo_url("/pulls?state=open&per_page=100"))?;
        parse_github_pr_list(&body)
    }

    fn create_pr(&self, request: &CreatePrRequest) -> Result<PrCreated> {
        let body = self.post(
            &self.repo_url("/pulls"),
            json!({
                "title": request.title,
                "body": request.body,
                "head": request.source_branch,
                "base": request.target_branch,
                "draft": request.draft,
            }),
        )?;
        parse_github_pr_created(&body)
    }

    fn pr_detail(&self, number: u64) -> Result<PrDetail> {
        let body = self.get(&self.repo_url(&format!("/pulls/{number}")))?;
        let parsed = parse_github_pr_detail_base(&body)?;
        let ci = self.ci_for_ref(&parsed.head_sha)?;
        Ok(parsed.into_detail(ci.checks))
    }

    fn ci_status(&self, ref_name: &str) -> Result<CiStatus> {
        self.ci_for_ref(ref_name)
    }

    fn merge_state(&self, number: u64) -> Result<ProviderMergeState> {
        let body = self.get(&self.repo_url(&format!("/pulls/{number}")))?;
        let pull: serde_json::Value =
            serde_json::from_str(&body).context("parse GitHub pull request merge state")?;
        let source_branch = json_string(&pull, &["head", "ref"])
            .context("GitHub pull request has no source branch")?;
        let target_branch = json_string(&pull, &["base", "ref"])
            .context("GitHub pull request has no target branch")?;
        let head_sha =
            json_string(&pull, &["head", "sha"]).context("GitHub pull request has no head SHA")?;
        let conflict_free = pull.get("mergeable").and_then(serde_json::Value::as_bool);
        let protection = self.get(&self.repo_url(&format!(
            "/branches/{}/protection/required_status_checks",
            percent_encode_segment(&target_branch)
        )))?;
        let protection: serde_json::Value =
            serde_json::from_str(&protection).context("parse GitHub required status checks")?;
        let mut required_names = protection
            .get("contexts")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(serde_json::Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        required_names.extend(
            protection
                .get("checks")
                .and_then(serde_json::Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|check| check.get("context").and_then(serde_json::Value::as_str))
                .map(str::to_string),
        );
        required_names.sort();
        required_names.dedup();
        let ci = self.ci_for_ref(&head_sha)?;
        let required_checks = required_names
            .into_iter()
            .map(|name| {
                ci.checks
                    .iter()
                    .find(|check| check.name == name)
                    .cloned()
                    .unwrap_or(CiCheck {
                        name,
                        state: "pending".into(),
                        url: None,
                    })
            })
            .collect();
        Ok(ProviderMergeState {
            number,
            source_branch,
            target_branch,
            head_sha,
            conflict_free,
            required_checks_known: true,
            required_checks,
        })
    }

    fn merge_pr(&self, number: u64, expected_head_sha: &str) -> Result<(Option<String>, String)> {
        let body = self.put(
            &self.repo_url(&format!("/pulls/{number}/merge")),
            json!({ "sha": expected_head_sha }),
        )?;
        let value: serde_json::Value =
            serde_json::from_str(&body).context("parse GitHub merge response")?;
        if value.get("merged").and_then(serde_json::Value::as_bool) != Some(true) {
            anyhow::bail!(
                "GitHub refused merge: {}",
                value
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("unknown reason")
            );
        }
        Ok((
            value
                .get("sha")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string),
            value
                .get("message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("merged")
                .to_string(),
        ))
    }
}

fn json_string(value: &serde_json::Value, path: &[&str]) -> Option<String> {
    path.iter()
        .try_fold(value, |current, key| current.get(*key))
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
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

fn percent_encode_segment(value: &str) -> String {
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
struct GithubUser {
    login: String,
}

#[derive(Deserialize)]
struct GithubRef {
    #[serde(rename = "ref")]
    ref_name: String,
    #[serde(default)]
    sha: String,
}

#[derive(Deserialize)]
struct GithubPull {
    number: u64,
    title: String,
    #[serde(default)]
    body: Option<String>,
    user: GithubUser,
    head: GithubRef,
    base: GithubRef,
    #[serde(default)]
    draft: bool,
    html_url: String,
    state: String,
}

impl GithubPull {
    fn into_info(self) -> PrInfo {
        PrInfo {
            number: self.number,
            title: self.title,
            author: self.user.login,
            source_branch: self.head.ref_name,
            target_branch: self.base.ref_name,
            draft: self.draft,
            url: self.html_url,
            state: self.state,
        }
    }
}

struct GithubPrDetailBase {
    pull: GithubPull,
    head_sha: String,
}

impl GithubPrDetailBase {
    fn into_detail(self, checks: Vec<CiCheck>) -> PrDetail {
        PrDetail {
            number: self.pull.number,
            title: self.pull.title,
            body: self.pull.body.unwrap_or_default(),
            author: self.pull.user.login,
            source_branch: self.pull.head.ref_name,
            target_branch: self.pull.base.ref_name,
            draft: self.pull.draft,
            url: self.pull.html_url,
            state: self.pull.state,
            head_sha: Some(self.head_sha),
            checks,
        }
    }
}

pub(crate) fn parse_github_pr_list(body: &str) -> Result<Vec<PrInfo>> {
    let pulls: Vec<GithubPull> =
        serde_json::from_str(body).context("parse GitHub pull request list")?;
    Ok(pulls.into_iter().map(GithubPull::into_info).collect())
}

pub(crate) fn parse_github_pr_created(body: &str) -> Result<PrCreated> {
    #[derive(Deserialize)]
    struct Created {
        number: u64,
        html_url: String,
    }

    let created: Created =
        serde_json::from_str(body).context("parse GitHub pull request creation response")?;
    Ok(PrCreated {
        number: created.number,
        url: created.html_url,
    })
}

fn parse_github_pr_detail_base(body: &str) -> Result<GithubPrDetailBase> {
    let pull: GithubPull =
        serde_json::from_str(body).context("parse GitHub pull request detail")?;
    let head_sha = pull.head.sha.clone();
    if head_sha.is_empty() {
        return Err(anyhow!("GitHub pull request detail omitted head SHA"));
    }
    Ok(GithubPrDetailBase { pull, head_sha })
}

#[cfg(test)]
pub(crate) fn parse_github_pr_detail(body: &str, checks: Vec<CiCheck>) -> Result<PrDetail> {
    Ok(parse_github_pr_detail_base(body)?.into_detail(checks))
}

#[derive(Deserialize)]
struct GithubCheckRuns {
    #[serde(default)]
    check_runs: Vec<GithubCheckRun>,
}

#[derive(Deserialize)]
struct GithubCheckRun {
    name: String,
    status: String,
    conclusion: Option<String>,
    details_url: Option<String>,
    html_url: Option<String>,
}

#[derive(Deserialize)]
struct GithubCommitStatuses {
    #[serde(default)]
    statuses: Vec<GithubCommitStatus>,
}

#[derive(Deserialize)]
struct GithubCommitStatus {
    context: String,
    state: String,
    target_url: Option<String>,
}

pub(crate) fn parse_github_ci(check_runs_body: &str, commit_status_body: &str) -> Result<CiStatus> {
    let check_runs: GithubCheckRuns =
        serde_json::from_str(check_runs_body).context("parse GitHub check runs")?;
    let commit_statuses: GithubCommitStatuses =
        serde_json::from_str(commit_status_body).context("parse GitHub commit statuses")?;

    let mut checks =
        Vec::with_capacity(check_runs.check_runs.len() + commit_statuses.statuses.len());
    for check in check_runs.check_runs {
        checks.push(CiCheck {
            name: check.name,
            state: github_check_state(&check.status, check.conclusion.as_deref()).to_string(),
            url: check.details_url.or(check.html_url),
        });
    }
    for status in commit_statuses.statuses {
        checks.push(CiCheck {
            name: status.context,
            state: normalize_ci_state(&status.state).to_string(),
            url: status.target_url,
        });
    }

    Ok(CiStatus {
        state: aggregate_ci_state(checks.iter().map(|check| check.state.as_str())).to_string(),
        checks,
    })
}

fn github_check_state(status: &str, conclusion: Option<&str>) -> &'static str {
    if status != "completed" {
        return "pending";
    }
    match conclusion.unwrap_or_default() {
        "success" | "neutral" | "skipped" => "success",
        "" => "pending",
        _ => "failure",
    }
}

fn normalize_ci_state(state: &str) -> &'static str {
    match state {
        "success" => "success",
        "pending" | "queued" | "in_progress" | "requested" | "waiting" => "pending",
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

    const PULL: &str = r#"{
        "number": 42,
        "title": "Ship hosting",
        "body": "Adds both providers",
        "user": {"login": "octocat"},
        "head": {"ref": "feature/hosting", "sha": "abc123"},
        "base": {"ref": "main", "sha": "def456"},
        "draft": true,
        "html_url": "https://github.com/acme/widget/pull/42",
        "state": "open"
    }"#;

    #[test]
    fn parses_pull_list_fixture() {
        let pulls = parse_github_pr_list(&format!("[{PULL}]")).expect("parse list");
        assert_eq!(pulls.len(), 1);
        assert_eq!(pulls[0].number, 42);
        assert_eq!(pulls[0].author, "octocat");
        assert_eq!(pulls[0].source_branch, "feature/hosting");
        assert!(pulls[0].draft);
    }

    #[test]
    fn parses_create_fixture() {
        let created = parse_github_pr_created(
            r#"{"number":42,"html_url":"https://github.com/acme/widget/pull/42"}"#,
        )
        .expect("parse created");
        assert_eq!(created.number, 42);
        assert_eq!(created.url, "https://github.com/acme/widget/pull/42");
    }

    #[test]
    fn parses_detail_fixture_with_checks() {
        let checks = vec![CiCheck {
            name: "build".into(),
            state: "success".into(),
            url: Some("https://github.com/acme/widget/actions/runs/1".into()),
        }];
        let detail = parse_github_pr_detail(PULL, checks).expect("parse detail");
        assert_eq!(detail.body, "Adds both providers");
        assert_eq!(detail.checks[0].name, "build");
        assert!(detail.checks[0].url.is_some());
    }

    #[test]
    fn combines_check_runs_and_statuses_with_failure_precedence() {
        let ci = parse_github_ci(
            r#"{"check_runs":[
                {"name":"build","status":"completed","conclusion":"success","details_url":"https://checks/build","html_url":null},
                {"name":"lint","status":"in_progress","conclusion":null,"details_url":null,"html_url":"https://checks/lint"}
            ]}"#,
            r#"{"state":"failure","statuses":[
                {"context":"deploy","state":"failure","target_url":"https://checks/deploy"}
            ]}"#,
        )
        .expect("parse CI");
        assert_eq!(ci.state, "failure");
        assert_eq!(ci.checks.len(), 3);
        assert_eq!(ci.checks[0].url.as_deref(), Some("https://checks/build"));
        assert_eq!(ci.checks[1].state, "pending");
        assert_eq!(ci.checks[2].state, "failure");

        let pending = parse_github_ci(
            r#"{"check_runs":[{"name":"build","status":"completed","conclusion":"success","details_url":null,"html_url":null}]}"#,
            r#"{"statuses":[{"context":"deploy","state":"pending","target_url":null}]}"#,
        )
        .expect("parse pending CI");
        assert_eq!(pending.state, "pending");

        let success = parse_github_ci(
            r#"{"check_runs":[{"name":"build","status":"completed","conclusion":"neutral","details_url":null,"html_url":null}]}"#,
            r#"{"statuses":[]}"#,
        )
        .expect("parse successful CI");
        assert_eq!(success.state, "success");

        let none =
            parse_github_ci(r#"{"check_runs":[]}"#, r#"{"statuses":[]}"#).expect("parse empty CI");
        assert_eq!(none.state, "none");
    }

    #[test]
    fn auth_status_errors_are_prefixed_and_other_errors_redact_tokens() {
        let auth = http_status_error("GitHub", 401, r#"{"message":"bad"}"#, "secret");
        assert!(auth.to_string().starts_with("AUTH:"));

        let error = http_status_error(
            "GitHub",
            422,
            r#"{"message":"token secret is invalid"}"#,
            "secret",
        );
        assert!(!error.to_string().contains("secret"));
        assert!(error.to_string().contains("[REDACTED]"));
    }

    #[test]
    fn encodes_branch_names_as_path_segments() {
        assert_eq!(percent_encode_segment("feature/a b"), "feature%2Fa%20b");
    }
    #[test]
    fn constructors_expose_overridable_base_url() {
        let default = GithubClient::new("acme", "widget", "token");
        assert_eq!(default.base_url, GITHUB_API_URL);

        let fixture =
            GithubClient::with_base_url("http://127.0.0.1:1234/", "acme", "widget", "token");
        assert_eq!(fixture.base_url, "http://127.0.0.1:1234");
    }
}

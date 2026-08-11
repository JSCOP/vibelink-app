pub(crate) mod auth;
pub(crate) mod detect;
pub(crate) mod github;
pub(crate) mod gitlab;

use crate::app::git::exec::git_read;
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostingInfo {
    pub provider: Option<String>,
    pub host: Option<String>,
    pub owner: Option<String>,
    pub repo: Option<String>,
    pub web_url: Option<String>,
    pub token_present: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePrRequest {
    pub title: String,
    pub body: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrInfo {
    pub number: u64,
    pub title: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
    pub url: String,
    pub state: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrCreated {
    pub number: u64,
    pub url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiCheck {
    pub name: String,
    pub state: String,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CiStatus {
    pub state: String,
    pub checks: Vec<CiCheck>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrDetail {
    pub number: u64,
    pub title: String,
    pub body: String,
    pub author: String,
    pub source_branch: String,
    pub target_branch: String,
    pub draft: bool,
    pub url: String,
    pub state: String,
    pub head_sha: Option<String>,
    pub checks: Vec<CiCheck>,
}

#[derive(Clone, Debug)]
pub struct ProviderMergeState {
    pub number: u64,
    pub source_branch: String,
    pub target_branch: String,
    pub head_sha: String,
    pub conflict_free: Option<bool>,
    pub required_checks_known: bool,
    pub required_checks: Vec<CiCheck>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePrRequest {
    pub number: u64,
    pub expected_head_sha: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergePrResult {
    pub number: u64,
    pub source_branch: String,
    pub target_branch: String,
    pub head_sha: String,
    pub merge_sha: Option<String>,
    pub message: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCodeInfo {
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub device_code_handle: String,
}

pub(crate) trait HostingClient {
    fn list_prs(&self) -> Result<Vec<PrInfo>>;
    fn create_pr(&self, request: &CreatePrRequest) -> Result<PrCreated>;
    fn pr_detail(&self, number: u64) -> Result<PrDetail>;
    fn ci_status(&self, ref_name: &str) -> Result<CiStatus>;
    fn merge_state(&self, number: u64) -> Result<ProviderMergeState>;
    fn merge_pr(&self, number: u64, expected_head_sha: &str) -> Result<(Option<String>, String)>;
}

#[tauri::command]
pub async fn hosting_detect(workspace_folder: String) -> Result<HostingInfo, String> {
    tauri::async_runtime::spawn_blocking(move || detect::detect_hosting(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_token_set(host: String, token: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || auth::set_token(&host, &token))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_token_clear(host: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || auth::clear_token(&host))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_token_status(host: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || auth::token_status(&host))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_provider_override(host: String, provider: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || detect::set_provider_override(&host, &provider))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_github_device_start() -> Result<DeviceCodeInfo, String> {
    tauri::async_runtime::spawn_blocking(auth::github_device_start)
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_github_device_poll(handle: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || auth::github_device_poll(&handle))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_prs_list(workspace_folder: String) -> Result<Vec<PrInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_client(&workspace_folder, |client| client.list_prs())
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_pr_create(
    workspace_folder: String,
    request: CreatePrRequest,
) -> Result<PrCreated, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.title.trim().is_empty()
            || request.source_branch.trim().is_empty()
            || request.target_branch.trim().is_empty()
        {
            bail!("pull request title, source branch, and target branch are required");
        }
        with_client(&workspace_folder, |client| client.create_pr(&request))
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_pr_detail(
    workspace_folder: String,
    number: u64,
) -> Result<PrDetail, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_client(&workspace_folder, |client| client.pr_detail(number))
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn hosting_pr_merge(
    workspace_folder: String,
    request: MergePrRequest,
) -> Result<MergePrResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        with_client(&workspace_folder, |client| {
            let state = client.merge_state(request.number)?;
            validate_merge_gate(&workspace_folder, &request, &state)?;
            let (merge_sha, message) = client.merge_pr(request.number, &state.head_sha)?;
            Ok(MergePrResult {
                number: state.number,
                source_branch: state.source_branch,
                target_branch: state.target_branch,
                head_sha: state.head_sha,
                merge_sha,
                message,
            })
        })
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

fn validate_merge_gate(
    workspace_folder: &str,
    request: &MergePrRequest,
    state: &ProviderMergeState,
) -> Result<()> {
    if state.number != request.number {
        bail!("stale_view: provider returned a different review identity")
    }
    let expected = request.expected_head_sha.trim();
    if expected.is_empty() || state.head_sha != expected {
        bail!("stale_view: provider head changed before merge")
    }
    let branch = String::from_utf8(git_read(workspace_folder, ["branch", "--show-current"])?)
        .context("decode current branch")?
        .trim()
        .to_string();
    if branch != state.source_branch {
        bail!(
            "merge blocked: active branch {branch:?} does not match review source {:?}",
            state.source_branch
        )
    }
    let status = git_read(
        workspace_folder,
        ["status", "--porcelain=v1", "--untracked-files=normal"],
    )?;
    if status.split(|byte| *byte == b'\n').any(|line| {
        if line.len() < 2 {
            return false;
        }
        matches!(
            &line[..2],
            b"DD" | b"AU" | b"UD" | b"UA" | b"DU" | b"AA" | b"UU"
        )
    }) {
        bail!("merge blocked: conflicts remain; open Workbench Changes")
    }
    if !status.is_empty() {
        bail!("merge blocked: staged, unstaged, or untracked files remain")
    }
    let local_head = String::from_utf8(git_read(workspace_folder, ["rev-parse", "HEAD"])?)
        .context("decode local HEAD")?
        .trim()
        .to_string();
    if local_head != state.head_sha {
        bail!("merge blocked: local HEAD does not equal provider head SHA")
    }
    let upstream_head =
        String::from_utf8(git_read(workspace_folder, ["rev-parse", "@{upstream}"])?)
            .context("decode upstream HEAD")?
            .trim()
            .to_string();
    if upstream_head != local_head {
        bail!("merge blocked: upstream remote ref does not equal local HEAD")
    }
    if state.conflict_free != Some(true) {
        bail!("merge blocked: provider conflict status is not conclusively clean")
    }
    if !state.required_checks_known {
        bail!("merge blocked: required CI metadata is unavailable")
    }
    if state
        .required_checks
        .iter()
        .any(|check| check.state != "success")
    {
        bail!("merge blocked: required CI is failing or pending")
    }
    Ok(())
}

#[tauri::command]
pub async fn hosting_ci_status(
    workspace_folder: String,
    ref_name: String,
) -> Result<CiStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if ref_name.trim().is_empty() {
            bail!("CI reference must not be empty");
        }
        with_client(&workspace_folder, |client| client.ci_status(&ref_name))
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

fn with_client<T, F>(repo: &str, operation: F) -> Result<T>
where
    F: FnOnce(&dyn HostingClient) -> Result<T>,
{
    let info = detect::detect_hosting(repo)?;
    let provider = info
        .provider
        .context("no supported Git hosting provider detected")?;
    let host = info.host.context("Git hosting remote has no host")?;
    let owner = info.owner.context("Git hosting remote has no owner")?;
    let repository = info.repo.context("Git hosting remote has no repository")?;
    let token = auth::read_token(&host)?
        .ok_or_else(|| anyhow::anyhow!("AUTH: no token stored for {host}"))?;
    let client: Box<dyn HostingClient> = match provider.as_str() {
        "github" if host.eq_ignore_ascii_case("github.com") => {
            Box::new(github::GithubClient::new(owner, repository, token))
        }
        "github" => Box::new(github::GithubClient::with_base_url(
            format!("https://{host}/api/v3"),
            owner,
            repository,
            token,
        )),
        "gitlab" => Box::new(gitlab::GitlabClient::new(&host, owner, repository, token)),
        _ => bail!("unsupported Git hosting provider {provider}"),
    };
    operation(client.as_ref())
        .map_err(|error| anyhow::anyhow!(auth::redact_error(&host, &error.to_string())))
}


fn to_string(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::git::exec::git_write_output;
    use crate::app::git::test_support::{file_url, run_git, run_git_at, test_repo, unique_path};

    fn merge_state(head_sha: String) -> ProviderMergeState {
        ProviderMergeState {
            number: 42,
            source_branch: "feature/review".into(),
            target_branch: "main".into(),
            head_sha,
            conflict_free: Some(true),
            required_checks_known: true,
            required_checks: vec![CiCheck {
                name: "required/build".into(),
                state: "success".into(),
                url: None,
            }],
        }
    }

    fn head(repo: &std::path::Path) -> String {
        String::from_utf8(run_git(repo, &["rev-parse", "HEAD"]))
            .expect("decode head")
            .trim()
            .to_string()
    }

    fn merge_gate_repo() -> (std::path::PathBuf, std::path::PathBuf) {
        let repo = test_repo();
        let remote = unique_path("merge-gate-remote");
        std::fs::create_dir_all(&remote).expect("create bare remote");
        run_git_at(&remote, &["init", "--bare"]);
        std::fs::write(repo.join("guard.txt"), "base\n").expect("write base");
        run_git(&repo, &["add", "guard.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        run_git(&repo, &["branch", "-M", "feature/review"]);
        run_git(&repo, &["remote", "add", "origin", &file_url(&remote)]);
        run_git(&repo, &["push", "-u", "origin", "feature/review"]);
        (repo, remote)
    }

    #[test]
    fn hosting_merge_gate_refuses_stale_dirty_unpushed_conflicted_and_pending_required_ci() {
        let (repo, remote) = merge_gate_repo();
        let repo_text = repo.to_str().expect("utf8 repo");
        let clean_head = head(&repo);
        let request = MergePrRequest {
            number: 42,
            expected_head_sha: clean_head.clone(),
        };
        validate_merge_gate(repo_text, &request, &merge_state(clean_head.clone()))
            .expect("clean synchronized checkout passes gate");

        let changed_provider = merge_state("b".repeat(40));
        assert!(validate_merge_gate(repo_text, &request, &changed_provider)
            .unwrap_err()
            .to_string()
            .contains("provider head changed"));

        std::fs::write(repo.join("dirty.txt"), "dirty\n").expect("write dirty file");
        assert!(
            validate_merge_gate(repo_text, &request, &merge_state(clean_head.clone()))
                .unwrap_err()
                .to_string()
                .contains("files remain")
        );
        std::fs::remove_file(repo.join("dirty.txt")).expect("remove dirty file");

        std::fs::write(repo.join("unpushed.txt"), "local\n").expect("write unpushed file");
        run_git(&repo, &["add", "unpushed.txt"]);
        run_git(&repo, &["commit", "-m", "unpushed"]);
        let unpushed_head = head(&repo);
        let unpushed_request = MergePrRequest {
            number: 42,
            expected_head_sha: unpushed_head.clone(),
        };
        assert!(validate_merge_gate(
            repo_text,
            &unpushed_request,
            &merge_state(unpushed_head.clone())
        )
        .unwrap_err()
        .to_string()
        .contains("upstream remote ref"));
        run_git(&repo, &["push", "origin", "feature/review"]);

        let mut pending = merge_state(unpushed_head.clone());
        pending.required_checks[0].state = "pending".into();
        assert!(validate_merge_gate(repo_text, &unpushed_request, &pending)
            .unwrap_err()
            .to_string()
            .contains("required CI"));
        let mut unknown = merge_state(unpushed_head);
        unknown.required_checks_known = false;
        assert!(validate_merge_gate(repo_text, &unpushed_request, &unknown)
            .unwrap_err()
            .to_string()
            .contains("metadata is unavailable"));

        run_git(&repo, &["checkout", "-b", "conflict-side"]);
        std::fs::write(repo.join("guard.txt"), "side\n").expect("write side");
        run_git(&repo, &["add", "guard.txt"]);
        run_git(&repo, &["commit", "-m", "side"]);
        run_git(&repo, &["checkout", "feature/review"]);
        std::fs::write(repo.join("guard.txt"), "feature\n").expect("write feature");
        run_git(&repo, &["add", "guard.txt"]);
        run_git(&repo, &["commit", "-m", "feature"]);
        run_git(&repo, &["push", "origin", "feature/review"]);
        let conflict_head = head(&repo);
        let conflict_request = MergePrRequest {
            number: 42,
            expected_head_sha: conflict_head.clone(),
        };
        let conflict_output =
            git_write_output(repo_text, ["merge", "conflict-side"]).expect("run conflicting merge");
        assert!(!conflict_output.status.success());
        assert!(
            validate_merge_gate(repo_text, &conflict_request, &merge_state(conflict_head))
                .unwrap_err()
                .to_string()
                .contains("conflicts remain")
        );
        git_write_output(repo_text, ["merge", "--abort"]).expect("abort conflict");

        std::fs::remove_dir_all(repo).expect("cleanup repo");
        std::fs::remove_dir_all(remote).expect("cleanup remote");
    }
}

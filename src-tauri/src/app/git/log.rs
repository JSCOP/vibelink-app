use super::exec::{git_read, git_read_output};
use super::paths::{validate_base_ref, validate_repo_relative_path};
use super::{merge_numstat, parse_name_status, to_string, ChangedFile};
use crate::app::{authorization::Capability, entitlement::EntitlementSupervisor};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogOptions {
    pub ref_name: Option<String>,
    pub path: Option<String>,
    pub skip: u32,
    pub limit: u32,
    pub search: Option<String>,
    pub author: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    pub commits: Vec<CommitInfo>,
    pub has_more: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitInfo {
    pub sha: String,
    pub parents: Vec<String>,
    pub refs: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub subject: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitDetail {
    pub sha: String,
    pub parents: Vec<String>,
    pub author_name: String,
    pub author_email: String,
    pub author_date: String,
    pub committer_name: String,
    pub committer_date: String,
    pub body: String,
    pub files: Vec<ChangedFile>,
}

#[tauri::command]
pub async fn git_log(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    workspace_folder: String,
    options: LogOptions,
) -> Result<LogPage, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || git_log_native(&workspace_folder, options))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_commit_detail(
    supervisor: State<'_, Arc<EntitlementSupervisor>>,
    workspace_folder: String,
    sha: String,
) -> Result<CommitDetail, String> {
    supervisor
        .authorize(Capability::WorkspaceRead)
        .map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || git_commit_detail_native(&workspace_folder, &sha))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

pub(crate) fn git_log_native(repo: &str, options: LogOptions) -> Result<LogPage> {
    let limit = options.limit.clamp(1, 200);
    let mut args = vec![
        "log".to_string(),
        "--topo-order".to_string(),
        "-z".to_string(),
        "--format=%H%x01%P%x01%D%x01%an%x01%ae%x01%aI%x01%s".to_string(),
        format!("--skip={}", options.skip),
        format!("-n{}", limit + 1),
    ];
    if let Some(search) = options.search.filter(|value| !value.trim().is_empty()) {
        args.push(format!("--grep={search}"));
        args.push("--regexp-ignore-case".to_string());
    }
    if let Some(author) = options.author.filter(|value| !value.trim().is_empty()) {
        args.push(format!("--author={author}"));
    }
    if let Some(ref_name) = options.ref_name {
        validate_base_ref(&ref_name)?;
        args.push(ref_name);
    }
    if let Some(path) = options.path {
        validate_repo_relative_path(&path)?;
        args.push("--".to_string());
        args.push(path);
    }
    let output = git_read_output(repo, &args)?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("does not have any commits") || stderr.contains("unknown revision") {
            return Ok(LogPage {
                commits: Vec::new(),
                has_more: false,
            });
        }
        return Err(anyhow!(super::exec::stderr_or_status(&output)));
    }
    let mut commits = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(parse_commit_info)
        .collect::<Vec<_>>();
    let has_more = commits.len() > limit as usize;
    commits.truncate(limit as usize);
    Ok(LogPage { commits, has_more })
}

pub(crate) fn git_commit_detail_native(repo: &str, sha: &str) -> Result<CommitDetail> {
    validate_base_ref(sha)?;
    let metadata = git_read(
        repo,
        [
            "show",
            "--no-patch",
            "-z",
            "--format=%H%x01%P%x01%an%x01%ae%x01%aI%x01%cn%x01%cI%x01%B",
            sha,
        ],
    )?;
    let fields = metadata
        .splitn(8, |byte| *byte == 1)
        .map(|field| {
            String::from_utf8_lossy(field)
                .trim_end_matches('\0')
                .to_string()
        })
        .collect::<Vec<_>>();
    if fields.len() != 8 {
        return Err(anyhow!("git returned malformed commit metadata"));
    }
    let mut files = changed_files_for_commit(repo, sha)?;
    files.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(CommitDetail {
        sha: fields[0].clone(),
        parents: split_words(&fields[1]),
        author_name: fields[2].clone(),
        author_email: fields[3].clone(),
        author_date: fields[4].clone(),
        committer_name: fields[5].clone(),
        committer_date: fields[6].clone(),
        body: fields[7].clone(),
        files,
    })
}

fn changed_files_for_commit(repo: &str, sha: &str) -> Result<Vec<ChangedFile>> {
    let parent = format!("{sha}^");
    let name_output = git_read_output(
        repo,
        [
            "diff-tree",
            "--no-commit-id",
            "-r",
            "-z",
            "--name-status",
            "-M",
            &parent,
            sha,
        ],
    )?;
    let (names, stats) = if name_output.status.success() {
        (
            name_output.stdout,
            git_read(
                repo,
                [
                    "diff-tree",
                    "--no-commit-id",
                    "-r",
                    "-z",
                    "--numstat",
                    "-M",
                    &parent,
                    sha,
                ],
            )?,
        )
    } else {
        (
            git_read(
                repo,
                [
                    "diff-tree",
                    "--no-commit-id",
                    "-r",
                    "--root",
                    "-z",
                    "--name-status",
                    "-M",
                    sha,
                ],
            )?,
            git_read(
                repo,
                [
                    "diff-tree",
                    "--no-commit-id",
                    "-r",
                    "--root",
                    "-z",
                    "--numstat",
                    "-M",
                    sha,
                ],
            )?,
        )
    };
    let mut files = parse_name_status(&names);
    merge_numstat(&mut files, &stats);
    Ok(files)
}

fn parse_commit_info(record: &[u8]) -> Option<CommitInfo> {
    let fields = record
        .splitn(7, |byte| *byte == 1)
        .map(|field| String::from_utf8_lossy(field).to_string())
        .collect::<Vec<_>>();
    (fields.len() == 7).then(|| CommitInfo {
        sha: fields[0].clone(),
        parents: split_words(&fields[1]),
        refs: fields[2]
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect(),
        author_name: fields[3].clone(),
        author_email: fields[4].clone(),
        author_date: fields[5].clone(),
        subject: fields[6].clone(),
    })
}

fn split_words(value: &str) -> Vec<String> {
    value.split_whitespace().map(str::to_string).collect()
}

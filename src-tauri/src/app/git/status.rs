use super::exec::{git_read, git_read_output};
use super::{change_type_from_status, to_string, ChangeType};
use crate::app::license::LicenseService;
use anyhow::Result;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::State;

const STATUS_ENTRY_LIMIT: usize = 5_000;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub detached_sha: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub state: RepoState,
    pub remotes: Vec<RemoteInfo>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoState {
    #[default]
    Clean,
    Merging,
    Rebasing,
    CherryPicking,
    Reverting,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
    pub name: String,
    pub url: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkingStatus {
    pub staged: Vec<StatusEntry>,
    pub unstaged: Vec<StatusEntry>,
    pub untracked: Vec<StatusEntry>,
    pub conflicted: Vec<StatusEntry>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub change_type: ChangeType,
}

#[tauri::command]
pub async fn git_repo_info(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<RepoInfo, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || git_repo_info_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_working_status(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<WorkingStatus, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || git_working_status_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

pub(crate) fn git_repo_info_native(workspace_folder: &str) -> Result<RepoInfo> {
    let root_output = git_read_output(workspace_folder, ["rev-parse", "--show-toplevel"])?;
    if !root_output.status.success() {
        return Ok(RepoInfo::default());
    }
    let root = String::from_utf8_lossy(&root_output.stdout).trim().to_string();
    let status = git_read(
        &root,
        ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"],
    )?;
    let mut info = RepoInfo {
        is_repo: true,
        root: Some(root.clone()),
        ..RepoInfo::default()
    };
    parse_branch_headers(&status, &mut info);
    if info.branch.is_none() {
        let sha = git_read(&root, ["rev-parse", "HEAD"])?;
        let sha = String::from_utf8_lossy(&sha).trim().to_string();
        if !sha.is_empty() {
            info.detached_sha = Some(sha);
        }
    }
    info.state = repo_state(&root)?;
    info.remotes = parse_remotes(&git_read(&root, ["remote", "-v"])?);
    Ok(info)
}

pub(crate) fn git_working_status_native(workspace_folder: &str) -> Result<WorkingStatus> {
    let output = git_read_output(
        workspace_folder,
        ["status", "--porcelain=v2", "-z", "--untracked-files=all"],
    )?;
    if !output.status.success()
        && String::from_utf8_lossy(&output.stderr).contains("not a git repository")
    {
        return Ok(WorkingStatus::default());
    }
    if !output.status.success() {
        return Err(anyhow::anyhow!(super::exec::stderr_or_status(&output)));
    }
    Ok(parse_working_status(&output.stdout))
}

fn parse_branch_headers(bytes: &[u8], info: &mut RepoInfo) {
    let text = String::from_utf8_lossy(bytes);
    for line in text.split(['\0', '\n']) {
        if let Some(value) = line.strip_prefix("# branch.head ") {
            if value != "(detached)" && value != "(unknown)" {
                info.branch = Some(value.to_string());
            }
        } else if let Some(value) = line.strip_prefix("# branch.upstream ") {
            info.upstream = Some(value.to_string());
        } else if let Some(value) = line.strip_prefix("# branch.ab ") {
            for part in value.split_whitespace() {
                if let Some(ahead) = part.strip_prefix('+') {
                    info.ahead = ahead.parse().unwrap_or(0);
                } else if let Some(behind) = part.strip_prefix('-') {
                    info.behind = behind.parse().unwrap_or(0);
                }
            }
        }
    }
}

fn repo_state(root: &str) -> Result<RepoState> {
    let git_dir = String::from_utf8_lossy(&git_read(root, ["rev-parse", "--git-dir"])?).trim().to_string();
    let path = if Path::new(&git_dir).is_absolute() {
        PathBuf::from(git_dir)
    } else {
        Path::new(root).join(git_dir)
    };
    let state = if path.join("MERGE_HEAD").exists() {
        RepoState::Merging
    } else if path.join("rebase-merge").exists() || path.join("rebase-apply").exists() {
        RepoState::Rebasing
    } else if path.join("CHERRY_PICK_HEAD").exists() {
        RepoState::CherryPicking
    } else if path.join("REVERT_HEAD").exists() {
        RepoState::Reverting
    } else {
        RepoState::Clean
    };
    Ok(state)
}

fn parse_remotes(bytes: &[u8]) -> Vec<RemoteInfo> {
    let mut remotes = Vec::<RemoteInfo>::new();
    for line in String::from_utf8_lossy(bytes).lines() {
        let mut fields = line.split_whitespace();
        let Some(name) = fields.next() else { continue };
        let Some(url) = fields.next() else { continue };
        if !remotes.iter().any(|remote| remote.name == name) {
            remotes.push(RemoteInfo {
                name: name.to_string(),
                url: url.to_string(),
            });
        }
    }
    remotes
}

pub(crate) fn parse_working_status(bytes: &[u8]) -> WorkingStatus {
    let records = bytes
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .map(|record| String::from_utf8_lossy(record).to_string())
        .collect::<Vec<_>>();
    let mut result = WorkingStatus::default();
    let mut index = 0;
    let mut total = 0usize;
    while index < records.len() {
        if total >= STATUS_ENTRY_LIMIT {
            result.truncated = true;
            break;
        }
        let record = &records[index];
        index += 1;
        let Some(kind) = record.chars().next() else { continue };
        match kind {
            '?' => {
                let path = record.strip_prefix("? ").unwrap_or_default().to_string();
                result.untracked.push(StatusEntry {
                    path,
                    old_path: None,
                    change_type: ChangeType::Untracked,
                });
                total += 1;
            }
            'u' => {
                if let Some((xy, path)) = status_fields(record, 11) {
                    result.conflicted.push(StatusEntry {
                        path,
                        old_path: None,
                        change_type: change_type_for_xy(&xy),
                    });
                    total += 1;
                }
            }
            '1' | '2' => {
                let field_count = if kind == '2' { 10 } else { 9 };
                let Some((xy, path)) = status_fields(record, field_count) else { continue };
                let old_path = if kind == '2' && index < records.len() {
                    let old = records[index].clone();
                    index += 1;
                    Some(old)
                } else {
                    None
                };
                let x = xy.chars().next().unwrap_or('.');
                let y = xy.chars().nth(1).unwrap_or('.');
                if x != '.' {
                    result.staged.push(StatusEntry {
                        path: path.clone(),
                        old_path: old_path.clone(),
                        change_type: change_type_from_status(x),
                    });
                    total += 1;
                }
                if y != '.' && total < STATUS_ENTRY_LIMIT {
                    result.unstaged.push(StatusEntry {
                        path,
                        old_path,
                        change_type: change_type_from_status(y),
                    });
                    total += 1;
                }
            }
            _ => {}
        }
    }
    if total >= STATUS_ENTRY_LIMIT && index < records.len() {
        result.truncated = true;
    }
    result
}

fn status_fields(record: &str, field_count: usize) -> Option<(String, String)> {
    let fields = record.splitn(field_count, ' ').collect::<Vec<_>>();
    if fields.len() != field_count {
        return None;
    }
    Some((fields[1].to_string(), fields[field_count - 1].to_string()))
}

fn change_type_for_xy(xy: &str) -> ChangeType {
    xy.chars()
        .find(|status| *status != '.' && *status != ' ')
        .map(change_type_from_status)
        .unwrap_or(ChangeType::Modified)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2_rename_cjk_and_spaces() {
        let bytes = b"2 R. N... 100644 100644 100644 aaaaaaa bbbbbbb R100 \xeb\xb3\x80\xea\xb2\xbd \xed\x8c\x8c\xec\x9d\xbc.txt\0old name.txt\0? loose file.txt\0";
        let status = parse_working_status(bytes);
        assert_eq!(status.staged.len(), 1);
        assert_eq!(status.staged[0].path, "변경 파일.txt");
        assert_eq!(status.staged[0].old_path.as_deref(), Some("old name.txt"));
        assert!(matches!(status.staged[0].change_type, ChangeType::Renamed));
        assert_eq!(status.untracked[0].path, "loose file.txt");
    }
}

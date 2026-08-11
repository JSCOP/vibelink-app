use super::exec::{git_command, git_read, git_read_output};
use super::paths::{contain_path, validate_repo_relative_path};
use super::{change_type_from_status, to_string, ChangeType};
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Stdio;

const STATUS_ENTRY_LIMIT: usize = 5_000;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
    pub is_repo: bool,
    pub root: Option<String>,
    pub branch: Option<String>,
    pub detached_sha: Option<String>,
    pub head_sha: Option<String>,
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

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum RepoKind {
    Submodule,
    NestedRepo,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmoduleState {
    pub commit_changed: bool,
    pub modified: bool,
    pub untracked: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
    pub path: String,
    pub old_path: Option<String>,
    pub change_type: ChangeType,
    pub repo_kind: Option<RepoKind>,
    pub submodule_state: Option<SubmoduleState>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitDirEntry {
    pub name: String,
    pub is_dir: bool,
    pub repo_kind: Option<RepoKind>,
    pub repository_initialized: Option<bool>,
    pub ignored: bool,
}

#[tauri::command]
pub async fn git_repo_info(
    workspace_folder: String,
) -> Result<RepoInfo, String> {
    tauri::async_runtime::spawn_blocking(move || git_repo_info_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_working_status(
    workspace_folder: String,
) -> Result<WorkingStatus, String> {
    tauri::async_runtime::spawn_blocking(move || git_working_status_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_check_ignored(
    workspace_folder: String,
    rel_paths: Vec<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        check_ignored_native(&workspace_folder, &rel_paths)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_dir_entries(
    workspace_folder: String,
    rel_path: String,
) -> Result<Vec<GitDirEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || dir_entries_native(&workspace_folder, &rel_path))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}
fn dir_entries_native(repo: &str, rel_path: &str) -> Result<Vec<GitDirEntry>> {
    let rel = rel_path.trim_end_matches('/');
    let directory = contain_path(Path::new(repo), rel)?;
    if !directory.is_dir() {
        anyhow::bail!("directory does not exist");
    }
    let gitlinks = gitlink_paths(repo, rel)?;
    let mut entries = Vec::new();
    let mut rel_paths = Vec::new();
    for entry in std::fs::read_dir(&directory)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".git" {
            continue;
        }
        let is_dir = entry.file_type()?.is_dir();
        let child_rel = if rel.is_empty() {
            name.clone()
        } else {
            format!("{rel}/{name}")
        };
        let repo_kind = if is_dir {
            if gitlinks.contains(&child_rel) {
                Some(RepoKind::Submodule)
            } else {
                repo_kind_for_dir(&entry.path())
            }
        } else {
            None
        };
        let repository_initialized = repo_kind.map(|kind| match kind {
            RepoKind::Submodule => entry.path().join(".git").exists(),
            RepoKind::NestedRepo => true,
        });
        rel_paths.push(child_rel);
        entries.push(GitDirEntry {
            name,
            is_dir,
            repo_kind,
            repository_initialized,
            ignored: false,
        });
    }
    for gitlink in &gitlinks {
        let Some(name) = direct_child_name(rel, gitlink) else {
            continue;
        };
        if entries.iter().any(|entry| entry.name == name) {
            continue;
        }
        rel_paths.push(gitlink.clone());
        entries.push(GitDirEntry {
            name,
            is_dir: true,
            repo_kind: Some(RepoKind::Submodule),
            repository_initialized: Some(false),
            ignored: false,
        });
    }
    let ignored = check_ignored_native(repo, &rel_paths)?
        .into_iter()
        .collect::<HashSet<_>>();
    for (entry, child_rel) in entries.iter_mut().zip(&rel_paths) {
        entry.ignored = ignored.contains(child_rel);
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

fn direct_child_name(parent: &str, child: &str) -> Option<String> {
    let remainder = if parent.is_empty() {
        child
    } else {
        child.strip_prefix(&format!("{parent}/"))?
    };
    (!remainder.is_empty() && !remainder.contains('/')).then(|| remainder.to_string())
}

fn gitlink_paths(repo: &str, rel: &str) -> Result<HashSet<String>> {
    let mut args = vec![
        "ls-files".to_string(),
        "-z".to_string(),
        "--stage".to_string(),
    ];
    if !rel.is_empty() {
        args.push("--".to_string());
        args.push(format!("{rel}/"));
    }
    let output = git_read_output(repo, args)?;
    if !output.status.success() {
        return Ok(HashSet::new());
    }
    let mut paths = HashSet::new();
    for record in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
    {
        let text = String::from_utf8_lossy(record);
        if let Some((meta, path)) = text.split_once('\t') {
            if meta.starts_with("160000") {
                paths.insert(path.to_string());
            }
        }
    }
    Ok(paths)
}

fn repo_kind_for_dir(path: &Path) -> Option<RepoKind> {
    let git_path = path.join(".git");
    if git_path.is_dir() {
        Some(RepoKind::NestedRepo)
    } else if git_path.is_file() {
        Some(RepoKind::Submodule)
    } else {
        None
    }
}

fn annotate_untracked_repos(repo: &str, status: &mut WorkingStatus) {
    for entry in status.untracked.iter_mut() {
        if !entry.path.ends_with('/') {
            continue;
        }
        let Ok(path) = contain_path(Path::new(repo), entry.path.trim_end_matches('/')) else {
            continue;
        };
        entry.repo_kind = repo_kind_for_dir(&path);
    }
}

fn check_ignored_native(repo: &str, rel_paths: &[String]) -> Result<Vec<String>> {
    if rel_paths.is_empty() {
        return Ok(Vec::new());
    }
    for path in rel_paths {
        validate_repo_relative_path(path)?;
    }
    let mut child = git_command(repo, ["check-ignore", "--stdin", "-z"], true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    if let Some(stdin) = child.stdin.as_mut() {
        for path in rel_paths {
            stdin.write_all(path.as_bytes())?;
            stdin.write_all(&[0])?;
        }
    }
    let output = child.wait_with_output()?;
    if output.status.success() {
        Ok(output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|part| !part.is_empty())
            .map(|part| String::from_utf8_lossy(part).to_string())
            .collect())
    } else if output.status.code() == Some(1) {
        Ok(Vec::new())
    } else {
        Err(anyhow!(super::exec::stderr_or_status(&output)))
    }
}

pub(crate) fn git_repo_info_native(workspace_folder: &str) -> Result<RepoInfo> {
    let root_output = git_read_output(workspace_folder, ["rev-parse", "--show-toplevel"])?;
    if !root_output.status.success() {
        return Ok(RepoInfo::default());
    }
    let root = String::from_utf8_lossy(&root_output.stdout)
        .trim()
        .to_string();
    let status = git_read(
        &root,
        [
            "status",
            "--porcelain=v2",
            "--branch",
            "-z",
            "--untracked-files=no",
        ],
    )?;
    let mut info = RepoInfo {
        is_repo: true,
        root: Some(root.clone()),
        ..RepoInfo::default()
    };
    parse_branch_headers(&status, &mut info);
    if info.branch.is_none() {
        if let Some(sha) = info.head_sha.clone() {
            info.detached_sha = Some(sha);
        } else {
            let sha = git_read(&root, ["rev-parse", "HEAD"])?;
            let sha = String::from_utf8_lossy(&sha).trim().to_string();
            if !sha.is_empty() {
                info.head_sha = Some(sha.clone());
                info.detached_sha = Some(sha);
            }
        }
    }
    info.state = repo_state(&root)?;
    info.remotes = parse_remotes(&git_read(&root, ["remote", "-v"])?);
    Ok(info)
}

pub(crate) fn git_working_status_native(workspace_folder: &str) -> Result<WorkingStatus> {
    let output = git_read_output(
        workspace_folder,
        [
            "status",
            "--porcelain=v2",
            "-z",
            "--untracked-files=all",
            "--ignore-submodules=none",
        ],
    )?;
    if !output.status.success()
        && String::from_utf8_lossy(&output.stderr).contains("not a git repository")
    {
        return Ok(WorkingStatus::default());
    }
    if !output.status.success() {
        return Err(anyhow::anyhow!(super::exec::stderr_or_status(&output)));
    }
    let mut status = parse_working_status(&output.stdout);
    annotate_untracked_repos(workspace_folder, &mut status);
    Ok(status)
}

fn parse_branch_headers(bytes: &[u8], info: &mut RepoInfo) {
    let text = String::from_utf8_lossy(bytes);
    for line in text.split(['\0', '\n']) {
        if let Some(value) = line.strip_prefix("# branch.oid ") {
            if value != "(initial)" && value != "(unknown)" {
                info.head_sha = Some(value.to_string());
            }
        } else if let Some(value) = line.strip_prefix("# branch.head ") {
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
    let git_dir = String::from_utf8_lossy(&git_read(root, ["rev-parse", "--git-dir"])?)
        .trim()
        .to_string();
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
        let Some(kind) = record.chars().next() else {
            continue;
        };
        match kind {
            '?' => {
                let path = record.strip_prefix("? ").unwrap_or_default().to_string();
                result.untracked.push(StatusEntry {
                    path,
                    old_path: None,
                    change_type: ChangeType::Untracked,
                    repo_kind: None,
                    submodule_state: None,
                });
                total += 1;
            }
            'u' => {
                if let Some((xy, sub, path)) = status_fields(record, 11) {
                    let submodule_state = submodule_state_from_sub(&sub);
                    result.conflicted.push(StatusEntry {
                        path,
                        old_path: None,
                        change_type: change_type_for_xy(&xy),
                        repo_kind: submodule_state.map(|_| RepoKind::Submodule),
                        submodule_state,
                    });
                    total += 1;
                }
            }
            '1' | '2' => {
                let field_count = if kind == '2' { 10 } else { 9 };
                let Some((xy, sub, path)) = status_fields(record, field_count) else {
                    continue;
                };
                let old_path = if kind == '2' && index < records.len() {
                    let old = records[index].clone();
                    index += 1;
                    Some(old)
                } else {
                    None
                };
                let submodule_state = submodule_state_from_sub(&sub);
                let repo_kind = submodule_state.map(|_| RepoKind::Submodule);
                let x = xy.chars().next().unwrap_or('.');
                let y = xy.chars().nth(1).unwrap_or('.');
                if x != '.' {
                    result.staged.push(StatusEntry {
                        path: path.clone(),
                        old_path: old_path.clone(),
                        change_type: change_type_from_status(x),
                        repo_kind,
                        submodule_state,
                    });
                    total += 1;
                }
                if y != '.' && total < STATUS_ENTRY_LIMIT {
                    result.unstaged.push(StatusEntry {
                        path,
                        old_path,
                        change_type: change_type_from_status(y),
                        repo_kind,
                        submodule_state,
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

fn status_fields(record: &str, field_count: usize) -> Option<(String, String, String)> {
    let fields = record.splitn(field_count, ' ').collect::<Vec<_>>();
    if fields.len() != field_count {
        return None;
    }
    Some((
        fields[1].to_string(),
        fields[2].to_string(),
        fields[field_count - 1].to_string(),
    ))
}

fn submodule_state_from_sub(sub: &str) -> Option<SubmoduleState> {
    let mut chars = sub.chars();
    (chars.next()? == 'S').then(|| SubmoduleState {
        commit_changed: chars.next() == Some('C'),
        modified: chars.next() == Some('M'),
        untracked: chars.next() == Some('U'),
    })
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
    fn repository_info_tracks_head_revision() {
        use crate::app::git::test_support::{run_git, test_repo};

        let repo = test_repo();
        std::fs::write(repo.join("tracked.txt"), "first\n").expect("write first");
        run_git(&repo, &["add", "tracked.txt"]);
        run_git(&repo, &["commit", "-m", "first"]);
        let first = git_repo_info_native(repo.to_str().expect("utf8 repo")).expect("first info");

        std::fs::write(repo.join("tracked.txt"), "second\n").expect("write second");
        run_git(&repo, &["add", "tracked.txt"]);
        run_git(&repo, &["commit", "-m", "second"]);
        let second = git_repo_info_native(repo.to_str().expect("utf8 repo")).expect("second info");

        assert!(first.head_sha.is_some());
        assert!(second.head_sha.is_some());
        assert_ne!(first.head_sha, second.head_sha);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

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
    #[test]
    fn preserves_porcelain_v2_submodule_state() {
        let bytes = b"1 .M SCMU 160000 160000 160000 aaaaaaa bbbbbbb vendor/lib\0? plain.txt\0";
        let status = parse_working_status(bytes);
        assert_eq!(status.unstaged.len(), 1);
        assert_eq!(status.unstaged[0].repo_kind, Some(RepoKind::Submodule));
        assert_eq!(
            status.unstaged[0].submodule_state,
            Some(SubmoduleState {
                commit_changed: true,
                modified: true,
                untracked: true,
            })
        );
        assert_eq!(status.untracked[0].repo_kind, None);
    }

    #[test]
    fn lists_dir_entries_with_nested_repo_detection() {
        let repo = crate::app::git::test_support::test_repo();
        std::fs::create_dir_all(repo.join("src")).expect("mkdir src");
        std::fs::write(repo.join("src/main.rs"), "fn main() {}").expect("write file");
        let nested = repo.join("nested");
        std::fs::create_dir_all(nested.join(".git")).expect("mkdir nested repo");
        std::fs::write(repo.join(".gitignore"), "skipme/\n").expect("write gitignore");
        std::fs::create_dir_all(repo.join("skipme")).expect("mkdir skipme");
        let entries = dir_entries_native(repo.to_str().expect("utf8 repo"), "").expect("list");
        let nested_entry = entries
            .iter()
            .find(|entry| entry.name == "nested")
            .expect("nested entry");
        assert_eq!(nested_entry.repo_kind, Some(RepoKind::NestedRepo));
        let src_entry = entries
            .iter()
            .find(|entry| entry.name == "src")
            .expect("src entry");
        assert!(src_entry.is_dir);
        assert_eq!(src_entry.repo_kind, None);
        let skip_entry = entries
            .iter()
            .find(|entry| entry.name == "skipme")
            .expect("skipme entry");
        assert!(skip_entry.ignored);
        assert!(!entries.iter().any(|entry| entry.name == ".git"));
        let children =
            dir_entries_native(repo.to_str().expect("utf8 repo"), "src").expect("list src");
        assert_eq!(children.len(), 1);
        assert_eq!(children[0].name, "main.rs");
        assert!(!children[0].is_dir);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn lists_missing_registered_submodule_as_uninitialized() {
        use crate::app::git::test_support::run_git;

        let repo = crate::app::git::test_support::test_repo();
        std::fs::write(repo.join("README.md"), "root\n").expect("write root file");
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);
        let sha = String::from_utf8(run_git(&repo, &["rev-parse", "HEAD"]))
            .expect("utf8 sha")
            .trim()
            .to_string();
        let cache_info = format!("160000,{sha},module");
        run_git(
            &repo,
            &["update-index", "--add", "--cacheinfo", &cache_info],
        );

        let entries = dir_entries_native(repo.to_str().expect("utf8 repo"), "").expect("list");
        let submodule = entries
            .iter()
            .find(|entry| entry.name == "module")
            .expect("submodule");
        assert_eq!(submodule.repo_kind, Some(RepoKind::Submodule));
        assert_eq!(submodule.repository_initialized, Some(false));
        assert!(submodule.is_dir);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn returns_only_ignored_paths() {
        let repo = crate::app::git::test_support::test_repo();
        std::fs::write(repo.join(".gitignore"), "ignored.txt\n").expect("write gitignore");
        std::fs::write(repo.join("ignored.txt"), "ignored").expect("write ignored");
        std::fs::write(repo.join("visible.txt"), "visible").expect("write visible");
        let ignored = check_ignored_native(
            repo.to_str().expect("utf8 repo"),
            &["ignored.txt".to_string(), "visible.txt".to_string()],
        )
        .expect("check ignored");
        assert_eq!(ignored, vec!["ignored.txt"]);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }
}

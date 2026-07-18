use super::exec::{ensure_success, git_read, git_read_output, git_write, git_write_output_with_env};
use super::paths::{validate_base_ref, validate_repo_relative_path};
use super::to_string;
use crate::app::license::LicenseService;
use anyhow::{bail, Result};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    pub name: String,
    pub is_head: bool,
    pub is_remote: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub last_commit_subject: String,
    pub last_commit_date: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagInfo {
    pub name: String,
    pub sha: String,
    pub message: Option<String>,
}

#[tauri::command]
pub async fn git_branches(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<Vec<BranchInfo>, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || branches_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

macro_rules! unit_command {
    ($name:ident, ($($arg:ident : $ty:ty),*), $body:expr) => {
        #[tauri::command]
        pub async fn $name(
            license: State<'_, Arc<LicenseService>>,
            workspace_folder: String,
            $($arg: $ty),*
        ) -> Result<(), String> {
            license.require_entitled_cached().map_err(to_string)?;
            tauri::async_runtime::spawn_blocking(move || $body(&workspace_folder, $($arg),*))
                .await
                .map_err(to_string)?
                .map_err(to_string)
        }
    };
}

unit_command!(git_branch_create, (name: String, from_ref: Option<String>, checkout: bool), branch_create_native);
unit_command!(git_checkout, (ref_name: String), checkout_native);
unit_command!(git_branch_delete, (name: String, force: bool), branch_delete_native);
unit_command!(git_branch_rename, (old_name: String, new_name: String), branch_rename_native);
unit_command!(git_merge, (ref_name: String), merge_native);
unit_command!(git_rebase, (ref_name: String), rebase_native);
unit_command!(git_conflict_take, (paths: Vec<String>, side: String), conflict_take_native);
unit_command!(git_tag_create, (name: String, ref_name: Option<String>, message: Option<String>), tag_create_native);
unit_command!(git_tag_delete, (name: String), tag_delete_native);

#[tauri::command]
pub async fn git_merge_abort(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_simple(workspace_folder, vec!["merge".into(), "--abort".into()]).await
}

#[tauri::command]
pub async fn git_rebase_abort(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_simple(workspace_folder, vec!["rebase".into(), "--abort".into()]).await
}

#[tauri::command]
pub async fn git_rebase_continue(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        ensure_success(git_write_output_with_env(
            &workspace_folder,
            ["rebase", "--continue"],
            &[("GIT_EDITOR", "true")],
        )?)
        .map(|_| ())
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_tag_list(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<Vec<TagInfo>, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || tag_list_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

fn branches_native(repo: &str) -> Result<Vec<BranchInfo>> {
    let bytes = git_read(
        repo,
        [
            "for-each-ref",
            "refs/heads",
            "refs/remotes",
            "--format=%(refname)%01%(refname:short)%01%(HEAD)%01%(upstream:short)%01%(upstream:track)%01%(contents:subject)%01%(committerdate:iso-strict)",
        ],
    )?;
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| {
            let fields = line.splitn(7, '\x01').collect::<Vec<_>>();
            if fields.len() != 7 || fields[1].ends_with("/HEAD") {
                return None;
            }
            let (ahead, behind) = parse_track(fields[4]);
            Some(BranchInfo {
                name: fields[1].to_string(),
                is_head: fields[2].trim() == "*",
                is_remote: fields[0].starts_with("refs/remotes/"),
                upstream: (!fields[3].is_empty()).then(|| fields[3].to_string()),
                ahead,
                behind,
                last_commit_subject: fields[5].to_string(),
                last_commit_date: fields[6].to_string(),
            })
        })
        .collect())
}

fn branch_create_native(
    repo: &str,
    name: String,
    from_ref: Option<String>,
    checkout: bool,
) -> Result<()> {
    validate_branch_name(repo, &name)?;
    if let Some(from_ref) = &from_ref {
        validate_base_ref(from_ref)?;
    }
    let mut args = if checkout {
        vec!["switch".to_string(), "-c".to_string(), name]
    } else {
        vec!["branch".to_string(), name]
    };
    if let Some(from_ref) = from_ref {
        args.push(from_ref);
    }
    git_write(repo, &args).map(|_| ())
}

fn checkout_native(repo: &str, ref_name: String) -> Result<()> {
    validate_base_ref(&ref_name)?;
    git_write(repo, ["switch", "--guess", &ref_name]).map(|_| ())
}

fn branch_delete_native(repo: &str, name: String, force: bool) -> Result<()> {
    validate_branch_name(repo, &name)?;
    git_write(repo, ["branch", if force { "-D" } else { "-d" }, &name]).map(|_| ())
}

fn branch_rename_native(repo: &str, old_name: String, new_name: String) -> Result<()> {
    validate_branch_name(repo, &old_name)?;
    validate_branch_name(repo, &new_name)?;
    git_write(repo, ["branch", "-m", &old_name, &new_name]).map(|_| ())
}

fn merge_native(repo: &str, ref_name: String) -> Result<()> {
    validate_base_ref(&ref_name)?;
    git_write(repo, ["merge", &ref_name]).map(|_| ())
}

fn rebase_native(repo: &str, ref_name: String) -> Result<()> {
    validate_base_ref(&ref_name)?;
    git_write(repo, ["rebase", &ref_name]).map(|_| ())
}

fn conflict_take_native(repo: &str, paths: Vec<String>, side: String) -> Result<()> {
    if side != "ours" && side != "theirs" {
        bail!("git conflict side must be 'ours' or 'theirs'");
    }
    for path in &paths {
        validate_repo_relative_path(path)?;
    }
    if paths.is_empty() {
        return Ok(());
    }
    let mut checkout = vec!["checkout".to_string(), format!("--{side}"), "--".to_string()];
    checkout.extend(paths.iter().cloned());
    git_write(repo, &checkout)?;
    let mut add = vec!["add".to_string(), "--".to_string()];
    add.extend(paths);
    git_write(repo, &add).map(|_| ())
}

fn tag_list_native(repo: &str) -> Result<Vec<TagInfo>> {
    let bytes = git_read(
        repo,
        ["for-each-ref", "refs/tags", "--format=%(refname:short)%01%(objectname)%01%(contents:subject)"],
    )?;
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| {
            let fields = line.splitn(3, '\x01').collect::<Vec<_>>();
            (fields.len() == 3).then(|| TagInfo {
                name: fields[0].to_string(),
                sha: fields[1].to_string(),
                message: (!fields[2].is_empty()).then(|| fields[2].to_string()),
            })
        })
        .collect())
}

fn tag_create_native(repo: &str, name: String, ref_name: Option<String>, message: Option<String>) -> Result<()> {
    validate_tag_name(repo, &name)?;
    if let Some(ref_name) = &ref_name {
        validate_base_ref(ref_name)?;
    }
    let mut args = vec!["tag".to_string()];
    if let Some(message) = message.filter(|value| !value.trim().is_empty()) {
        args.extend(["-a".to_string(), name, "-m".to_string(), message]);
    } else {
        args.push(name);
    }
    if let Some(ref_name) = ref_name {
        args.push(ref_name);
    }
    git_write(repo, &args).map(|_| ())
}

fn tag_delete_native(repo: &str, name: String) -> Result<()> {
    validate_tag_name(repo, &name)?;
    git_write(repo, ["tag", "-d", &name]).map(|_| ())
}

fn validate_branch_name(repo: &str, name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') {
        bail!("invalid git branch name");
    }
    let output = git_read_output(repo, ["check-ref-format", "--branch", name])?;
    if output.status.success() {
        Ok(())
    } else {
        bail!("invalid git branch name")
    }
}

fn validate_tag_name(repo: &str, name: &str) -> Result<()> {
    if name.is_empty() || name.starts_with('-') {
        bail!("invalid git tag name");
    }
    let full = format!("refs/tags/{name}");
    if git_read_output(repo, ["check-ref-format", &full])?.status.success() {
        Ok(())
    } else {
        bail!("invalid git tag name")
    }
}

fn parse_track(value: &str) -> (u32, u32) {
    let mut ahead = 0;
    let mut behind = 0;
    let trimmed = value.trim_matches(['[', ']']);
    for part in trimmed.split(',').map(str::trim) {
        if let Some(value) = part.strip_prefix("ahead ") {
            ahead = value.parse().unwrap_or(0);
        } else if let Some(value) = part.strip_prefix("behind ") {
            behind = value.parse().unwrap_or(0);
        }
    }
    (ahead, behind)
}

async fn spawn_simple(workspace_folder: String, args: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || git_write(&workspace_folder, &args).map(|_| ()))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::git::test_support::{run_git, test_repo};

    #[test]
    fn conflict_take_ours_stages_current_branch_content() {
        let repo = test_repo();
        run_git(&repo, &["branch", "-M", "main"]);
        std::fs::write(repo.join("conflict.txt"), "base\n").expect("write base");
        run_git(&repo, &["add", "conflict.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        branch_create_native(
            repo.to_str().expect("utf8 repo"),
            "feature".to_string(),
            None,
            true,
        )
        .expect("create feature");
        std::fs::write(repo.join("conflict.txt"), "feature\n").expect("write feature");
        run_git(&repo, &["commit", "-am", "feature"]);
        checkout_native(repo.to_str().expect("utf8 repo"), "main".to_string()).expect("checkout main");
        std::fs::write(repo.join("conflict.txt"), "main\n").expect("write main");
        run_git(&repo, &["commit", "-am", "main"]);
        assert!(merge_native(repo.to_str().expect("utf8 repo"), "feature".to_string()).is_err());
        conflict_take_native(
            repo.to_str().expect("utf8 repo"),
            vec!["conflict.txt".to_string()],
            "ours".to_string(),
        )
        .expect("take ours");
        let staged = run_git(&repo, &["show", ":0:conflict.txt"]);
        assert_eq!(String::from_utf8_lossy(&staged), "main\n");
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }
}

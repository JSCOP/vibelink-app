use super::exec::{ensure_success, git_read, git_read_output, git_write, git_write_output};
use super::paths::{resolve_repo_file_path, validate_repo_relative_path};
use super::to_string;
use crate::app::license::LicenseService;
use anyhow::{bail, Result};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: u32,
    pub message: String,
}

#[tauri::command]
pub async fn git_init(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_unit(move || git_write(&workspace_folder, ["init"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_stage(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    paths: Vec<String>,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_unit(move || stage_native(&workspace_folder, &paths)).await
}

#[tauri::command]
pub async fn git_unstage(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    paths: Vec<String>,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_unit(move || unstage_native(&workspace_folder, &paths)).await
}

#[tauri::command]
pub async fn git_stage_all(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_unit(move || git_write(&workspace_folder, ["add", "-A"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage_all(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_unit(move || unstage_all_native(&workspace_folder)).await
}

#[tauri::command]
pub async fn git_discard(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    paths: Vec<String>,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_unit(move || discard_native(&workspace_folder, &paths)).await
}

#[tauri::command]
pub async fn git_commit(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    message: String,
    amend: bool,
    signoff: bool,
) -> Result<String, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        commit_native(&workspace_folder, &message, amend, signoff)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_stash_save(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    message: String,
    include_untracked: bool,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    spawn_unit(move || stash_save_native(&workspace_folder, &message, include_untracked)).await
}

#[tauri::command]
pub async fn git_stash_list(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<Vec<StashInfo>, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || stash_list_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

macro_rules! stash_command {
    ($name:ident, $verb:literal) => {
        #[tauri::command]
        pub async fn $name(
            license: State<'_, Arc<LicenseService>>,
            workspace_folder: String,
            index: u32,
        ) -> Result<(), String> {
            license.require_entitled_cached().map_err(to_string)?;
            spawn_unit(move || {
                let stash_ref = format!("stash@{{{index}}}");
                git_write(&workspace_folder, ["stash", $verb, &stash_ref]).map(|_| ())
            })
            .await
        }
    };
}

stash_command!(git_stash_apply, "apply");
stash_command!(git_stash_pop, "pop");
stash_command!(git_stash_drop, "drop");

fn stage_native(repo: &str, paths: &[String]) -> Result<()> {
    validate_paths(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec!["add".to_string(), "--".to_string()];
    args.extend(paths.iter().cloned());
    git_write(repo, &args).map(|_| ())
}

fn unstage_native(repo: &str, paths: &[String]) -> Result<()> {
    validate_paths(paths)?;
    if paths.is_empty() {
        return Ok(());
    }
    let mut args = vec![
        "restore".to_string(),
        "--staged".to_string(),
        "--".to_string(),
    ];
    args.extend(paths.iter().cloned());
    let output = git_write_output(repo, &args)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("could not resolve HEAD")
        || stderr.contains("unknown revision")
        || stderr.contains("ambiguous argument 'HEAD'")
    {
        let mut fallback = vec!["rm".to_string(), "--cached".to_string(), "--".to_string()];
        fallback.extend(paths.iter().cloned());
        git_write(repo, &fallback).map(|_| ())
    } else {
        ensure_success(output).map(|_| ())
    }
}

fn unstage_all_native(repo: &str) -> Result<()> {
    let output = git_write_output(repo, ["reset"])?;
    if output.status.success() {
        return Ok(());
    }
    if !git_read_output(repo, ["rev-parse", "--verify", "HEAD"])?
        .status
        .success()
    {
        Ok(())
    } else {
        ensure_success(output).map(|_| ())
    }
}

fn discard_native(repo: &str, paths: &[String]) -> Result<()> {
    validate_paths(paths)?;
    for path in paths {
        let tracked = git_read_output(repo, ["ls-files", "--error-unmatch", "--", path])?
            .status
            .success();
        if tracked {
            git_write(repo, ["restore", "--worktree", "--source=HEAD", "--", path])?;
        } else {
            let absolute = resolve_repo_file_path(repo, path)?;
            if absolute.exists() {
                trash::delete(&absolute)?;
            }
        }
    }
    Ok(())
}

fn commit_native(repo: &str, message: &str, amend: bool, signoff: bool) -> Result<String> {
    if message.trim().is_empty() {
        bail!("commit message is empty");
    }
    let mut args = vec!["commit", "-m", message];
    if amend {
        args.push("--amend");
    }
    if signoff {
        args.push("--signoff");
    }
    git_write(repo, args)?;
    let sha = git_read(repo, ["rev-parse", "HEAD"])?;
    Ok(String::from_utf8_lossy(&sha).trim().to_string())
}

fn stash_save_native(repo: &str, message: &str, include_untracked: bool) -> Result<()> {
    let mut args = vec!["stash", "push"];
    if include_untracked {
        args.push("--include-untracked");
    }
    if !message.trim().is_empty() {
        args.extend(["-m", message]);
    }
    git_write(repo, args).map(|_| ())
}

fn stash_list_native(repo: &str) -> Result<Vec<StashInfo>> {
    let output = git_read(repo, ["stash", "list", "-z", "--format=%gd%x01%gs"])?;
    Ok(output
        .split(|byte| *byte == 0)
        .filter(|record| !record.is_empty())
        .filter_map(|record| {
            let mut fields = record.splitn(2, |byte| *byte == 1);
            let reference = String::from_utf8_lossy(fields.next()?).to_string();
            let message = String::from_utf8_lossy(fields.next()?).to_string();
            let index = reference
                .strip_prefix("stash@{")?
                .strip_suffix('}')?
                .parse()
                .ok()?;
            Some(StashInfo { index, message })
        })
        .collect())
}

fn validate_paths(paths: &[String]) -> Result<()> {
    for path in paths {
        validate_repo_relative_path(path)?;
    }
    Ok(())
}

async fn spawn_unit<F>(operation: F) -> Result<(), String>
where
    F: FnOnce() -> Result<()> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::git::log::{git_log_native, LogOptions};
    use crate::app::git::test_support::test_repo;

    #[test]
    fn stage_commit_and_log_round_trip() {
        let repo = test_repo();
        std::fs::write(repo.join("hello.txt"), "hello\n").expect("write file");
        stage_native(
            repo.to_str().expect("utf8 repo"),
            &["hello.txt".to_string()],
        )
        .expect("stage");
        let sha = commit_native(repo.to_str().expect("utf8 repo"), "initial", false, false)
            .expect("commit");
        let page = git_log_native(
            repo.to_str().expect("utf8 repo"),
            LogOptions {
                ref_name: None,
                path: None,
                skip: 0,
                limit: 20,
                search: None,
                author: None,
            },
        )
        .expect("log");
        assert_eq!(page.commits.len(), 1);
        assert_eq!(page.commits[0].sha, sha);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }
}

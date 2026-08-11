use super::exec::{ensure_success, git_command, git_write_output};
use super::paths::validate_base_ref;
use super::to_string;
use anyhow::{bail, Result};
use serde::Serialize;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::Stdio;
use tauri::{ipc::Channel, AppHandle};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneProgress {
    pub line: String,
    pub done: bool,
}

#[tauri::command]
pub async fn git_fetch(
    workspace_folder: String,
    remote: Option<String>,
    prune: bool,
    refspec: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        fetch_native(&workspace_folder, remote, prune, refspec)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_pull(
    workspace_folder: String,
    rebase: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_sync(
            &workspace_folder,
            ["pull", if rebase { "--rebase" } else { "--no-rebase" }],
        )
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_push(
    workspace_folder: String,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        push_native(
            &workspace_folder,
            remote,
            branch,
            set_upstream,
            force_with_lease,
        )
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_clone(
    _app: AppHandle,
    url: String,
    target_dir: String,
    channel: Channel<CloneProgress>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || clone_native(&url, &target_dir, channel))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

fn fetch_native(
    repo: &str,
    remote: Option<String>,
    prune: bool,
    refspec: Option<String>,
) -> Result<()> {
    let mut args = vec!["fetch".to_string()];
    if prune {
        args.push("--prune".to_string());
    }
    if let Some(remote) = remote {
        validate_base_ref(&remote)?;
        args.push(remote);
    }
    if let Some(refspec) = refspec {
        validate_refspec(&refspec)?;
        args.push(refspec);
    }
    run_sync(repo, &args)
}

fn push_native(
    repo: &str,
    remote: Option<String>,
    branch: Option<String>,
    set_upstream: bool,
    force_with_lease: bool,
) -> Result<()> {
    let mut args = vec!["push".to_string()];
    if set_upstream {
        args.push("--set-upstream".to_string());
    }
    if force_with_lease {
        args.push("--force-with-lease".to_string());
    }
    if let Some(remote) = remote {
        validate_base_ref(&remote)?;
        args.push(remote);
    }
    if let Some(branch) = branch {
        validate_base_ref(&branch)?;
        args.push(branch);
    }
    run_sync(repo, &args)
}

fn run_sync<I, S>(repo: &str, args: I) -> Result<()>
where
    I: IntoIterator<Item = S> + Clone,
    S: AsRef<std::ffi::OsStr>,
{
    let output = git_write_output(repo, args)?;
    if output.status.success() {
        return Ok(());
    }
    let message = super::exec::stderr_or_status(&output);
    if message.contains("Authentication failed") || message.contains("could not read Username") {
        bail!("git authentication failed — configure Git Credential Manager or sign in under Settings → Git Hosting");
    }
    ensure_success(output).map(|_| ())
}

fn clone_native(url: &str, target_dir: &str, channel: Channel<CloneProgress>) -> Result<()> {
    if !(url.starts_with("https://") || url.starts_with("git@") || url.starts_with("ssh://")) {
        bail!("git clone URL must use https://, git@, or ssh://");
    }
    let target = Path::new(target_dir);
    if !target.is_absolute() {
        bail!("git clone target directory must be absolute");
    }
    let Some(parent) = target.parent() else {
        bail!("git clone target directory has no parent");
    };
    if !parent.exists() {
        bail!("git clone target parent directory does not exist");
    }
    let mut child = git_command(
        parent.to_string_lossy().as_ref(),
        ["clone", "--progress", url, target_dir],
        false,
    )
    .stderr(Stdio::piped())
    .stdout(Stdio::null())
    .spawn()?;
    if let Some(stderr) = child.stderr.take() {
        for line in BufReader::new(stderr).lines() {
            let line = line?;
            let _ = channel.send(CloneProgress { line, done: false });
        }
    }
    let status = child.wait()?;
    if status.success() {
        let _ = channel.send(CloneProgress {
            line: String::new(),
            done: true,
        });
        Ok(())
    } else {
        bail!("git clone exited with status {status}")
    }
}

pub(crate) fn validate_refspec(refspec: &str) -> Result<()> {
    let value = refspec.strip_prefix('+').unwrap_or(refspec);
    let Some((source, target)) = value.split_once(':') else {
        bail!("invalid git refspec");
    };
    if target.contains(':') || !valid_refspec_side(source) || !valid_refspec_side(target) {
        bail!("invalid git refspec");
    }
    Ok(())
}

fn valid_refspec_side(value: &str) -> bool {
    value.starts_with("refs/")
        && value.len() > 5
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '/' | '_' | '-' | '*'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_option_injection_and_invalid_refspecs() {
        assert!(validate_refspec("+refs/pull/1/head:refs/remotes/origin/pr/1").is_ok());
        assert!(validate_refspec("--upload-pack=evil").is_err());
        assert!(validate_refspec("refs/heads/main:../escape").is_err());
    }

    #[test]
    fn pushes_fetches_and_reports_behind_against_bare_remote() {
        use crate::app::git::status::git_repo_info_native;
        use crate::app::git::test_support::{
            file_url, run_git, run_git_at, test_repo, unique_path,
        };

        let repo = test_repo();
        run_git(&repo, &["branch", "-M", "main"]);
        std::fs::write(repo.join("file.txt"), "one\n").expect("write first");
        run_git(&repo, &["add", "file.txt"]);
        run_git(&repo, &["commit", "-m", "first"]);

        let bare = unique_path("bare");
        std::fs::create_dir_all(&bare).expect("create bare");
        run_git_at(&bare, &["init", "--bare"]);
        run_git_at(&bare, &["symbolic-ref", "HEAD", "refs/heads/main"]);
        let url = file_url(&bare);
        run_git(&repo, &["remote", "add", "origin", &url]);
        push_native(
            repo.to_str().expect("utf8 repo"),
            Some("origin".to_string()),
            Some("main".to_string()),
            true,
            false,
        )
        .expect("push initial");

        let clone = unique_path("clone");
        let clone_string = clone.to_string_lossy().to_string();
        run_git_at(
            std::env::temp_dir().as_path(),
            &["clone", &url, &clone_string],
        );
        run_git(
            &clone,
            &["config", "user.email", "vibelink@example.invalid"],
        );
        run_git(&clone, &["config", "user.name", "VibeLink Test"]);
        std::fs::write(clone.join("file.txt"), "two\n").expect("write second");
        run_git(&clone, &["commit", "-am", "second"]);
        run_git(&clone, &["push", "origin", "main"]);

        fetch_native(
            repo.to_str().expect("utf8 repo"),
            Some("origin".to_string()),
            false,
            None,
        )
        .expect("fetch");
        let info = git_repo_info_native(repo.to_str().expect("utf8 repo")).expect("repo info");
        assert_eq!(info.behind, 1);

        std::fs::remove_dir_all(repo).expect("cleanup repo");
        std::fs::remove_dir_all(clone).expect("cleanup clone");
        std::fs::remove_dir_all(bare).expect("cleanup bare");
    }
}

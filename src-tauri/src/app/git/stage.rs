use super::exec::{
    ensure_success, git_read, git_read_output, git_write, git_write_output, git_write_stdin,
};
use super::paths::{resolve_repo_file_path, validate_repo_relative_path};
use super::to_string;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StashInfo {
    pub index: u32,
    pub message: String,
}

#[tauri::command]
pub async fn git_init(workspace_folder: String) -> Result<(), String> {
    spawn_unit(move || git_write(&workspace_folder, ["init"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_stage(workspace_folder: String, paths: Vec<String>) -> Result<(), String> {
    spawn_unit(move || stage_native(&workspace_folder, &paths)).await
}

#[tauri::command]
pub async fn git_unstage(workspace_folder: String, paths: Vec<String>) -> Result<(), String> {
    spawn_unit(move || unstage_native(&workspace_folder, &paths)).await
}

#[tauri::command]
pub async fn git_stage_all(workspace_folder: String) -> Result<(), String> {
    spawn_unit(move || git_write(&workspace_folder, ["add", "-A"]).map(|_| ())).await
}

#[tauri::command]
pub async fn git_unstage_all(workspace_folder: String) -> Result<(), String> {
    spawn_unit(move || unstage_all_native(&workspace_folder)).await
}

#[tauri::command]
pub async fn git_discard(workspace_folder: String, paths: Vec<String>) -> Result<(), String> {
    spawn_unit(move || discard_native(&workspace_folder, &paths)).await
}

#[tauri::command]
pub async fn git_commit(
    workspace_folder: String,
    message: String,
    amend: bool,
    signoff: bool,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        commit_native(&workspace_folder, &message, amend, signoff)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_stash_save(
    workspace_folder: String,
    message: String,
    include_untracked: bool,
) -> Result<(), String> {
    spawn_unit(move || stash_save_native(&workspace_folder, &message, include_untracked)).await
}

#[tauri::command]
pub async fn git_stash_list(workspace_folder: String) -> Result<Vec<StashInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || stash_list_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

macro_rules! stash_command {
    ($name:ident, $verb:literal) => {
        #[tauri::command]
        pub async fn $name(workspace_folder: String, index: u32) -> Result<(), String> {
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

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum GitDiffArea {
    Unstaged,
    Staged,
    Review,
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GitHunkAction {
    Stage,
    Unstage,
    Discard,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDiffLine {
    pub kind: String,
    pub text: String,
    pub old_line: Option<u32>,
    pub new_line: Option<u32>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedDiffHunk {
    pub id: String,
    pub header: String,
    pub old_start: u32,
    pub old_count: u32,
    pub new_start: u32,
    pub new_count: u32,
    pub lines: Vec<UnifiedDiffLine>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnifiedFileDiff {
    pub path: String,
    pub area: GitDiffArea,
    pub binary: bool,
    pub hunks: Vec<UnifiedDiffHunk>,
}

struct ParsedFileDiff {
    public: UnifiedFileDiff,
    preamble: String,
    raw_hunks: Vec<(String, String)>,
    whole_file_only: bool,
}

#[tauri::command]
pub async fn git_diff_hunks(
    workspace_folder: String,
    path: String,
    area: GitDiffArea,
    base_ref: Option<String>,
    head_ref: Option<String>,
) -> Result<UnifiedFileDiff, String> {
    tauri::async_runtime::spawn_blocking(move || {
        diff_hunks_native(
            &workspace_folder,
            &path,
            area,
            base_ref.as_deref(),
            head_ref.as_deref(),
        )
        .map(|parsed| parsed.public)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_apply_hunk(
    workspace_folder: String,
    path: String,
    area: GitDiffArea,
    hunk_id: String,
    action: GitHunkAction,
) -> Result<(), String> {
    spawn_unit(move || apply_hunk_native(&workspace_folder, &path, area, &hunk_id, action)).await
}

fn diff_hunks_native(
    repo: &str,
    path: &str,
    area: GitDiffArea,
    base_ref: Option<&str>,
    head_ref: Option<&str>,
) -> Result<ParsedFileDiff> {
    validate_repo_relative_path(path)?;
    let mut args = vec![
        "diff".to_string(),
        "--no-ext-diff".to_string(),
        "--no-color".to_string(),
        "--unified=3".to_string(),
    ];
    match area {
        GitDiffArea::Staged => args.push("--cached".to_string()),
        GitDiffArea::Review => match (
            base_ref.filter(|value| !value.trim().is_empty()),
            head_ref.filter(|value| !value.trim().is_empty()),
        ) {
            (Some(base), Some(head)) => args.push(format!("{}..{}", base.trim(), head.trim())),
            (Some(base), None) => args.push(base.trim().to_string()),
            (None, Some(_)) => bail!("review diff requires baseRef when headRef is provided"),
            (None, None) => bail!("review diff requires baseRef"),
        },
        GitDiffArea::Unstaged => {}
    }
    args.push("--".to_string());
    args.push(path.to_string());
    let bytes = git_read(repo, args)?;
    parse_unified_diff(path, area, &String::from_utf8_lossy(&bytes))
}

fn parse_unified_diff(path: &str, area: GitDiffArea, diff: &str) -> Result<ParsedFileDiff> {
    let binary = diff.contains("GIT binary patch")
        || diff.lines().any(|line| line.starts_with("Binary files "));
    let whole_file_only = binary
        || diff.lines().any(|line| {
            line.starts_with("rename from ")
                || line.starts_with("rename to ")
                || line.starts_with("copy from ")
                || line.starts_with("copy to ")
                || line.starts_with("old mode ")
                || line.starts_with("new mode ")
        });
    let lines = diff.split_inclusive('\n').collect::<Vec<_>>();
    let first_hunk = lines
        .iter()
        .position(|line| line.starts_with("@@ "))
        .unwrap_or(lines.len());
    let preamble = lines[..first_hunk].concat();
    let mut hunks = Vec::new();
    let mut raw_hunks = Vec::new();
    let mut index = first_hunk;
    while index < lines.len() {
        if !lines[index].starts_with("@@ ") {
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        while index < lines.len() && !lines[index].starts_with("@@ ") {
            index += 1;
        }
        let raw = lines[start..index].concat();
        let header = lines[start].trim_end_matches(['\r', '\n']).to_string();
        let (old_start, old_count, new_start, new_count) = parse_hunk_header(&header)?;
        let mut old_line = old_start;
        let mut new_line = new_start;
        let mut parsed_lines = Vec::new();
        for line in &lines[start + 1..index] {
            let trimmed = line.trim_end_matches(['\r', '\n']);
            if let Some(text) = trimmed.strip_prefix('+') {
                parsed_lines.push(UnifiedDiffLine {
                    kind: "addition".into(),
                    text: text.into(),
                    old_line: None,
                    new_line: Some(new_line),
                });
                new_line = new_line.saturating_add(1);
            } else if let Some(text) = trimmed.strip_prefix('-') {
                parsed_lines.push(UnifiedDiffLine {
                    kind: "deletion".into(),
                    text: text.into(),
                    old_line: Some(old_line),
                    new_line: None,
                });
                old_line = old_line.saturating_add(1);
            } else if let Some(text) = trimmed.strip_prefix(' ') {
                parsed_lines.push(UnifiedDiffLine {
                    kind: "context".into(),
                    text: text.into(),
                    old_line: Some(old_line),
                    new_line: Some(new_line),
                });
                old_line = old_line.saturating_add(1);
                new_line = new_line.saturating_add(1);
            } else if trimmed.starts_with("\\ No newline") {
                parsed_lines.push(UnifiedDiffLine {
                    kind: "noNewline".into(),
                    text: trimmed.into(),
                    old_line: None,
                    new_line: None,
                });
            }
        }
        let area_name = match area {
            GitDiffArea::Unstaged => "unstaged",
            GitDiffArea::Staged => "staged",
            GitDiffArea::Review => "review",
        };
        let digest = Sha256::digest(format!("{area_name}\0{path}\0{raw}").as_bytes());
        let id = format!("{:x}", digest);
        if !whole_file_only {
            hunks.push(UnifiedDiffHunk {
                id: id.clone(),
                header,
                old_start,
                old_count,
                new_start,
                new_count,
                lines: parsed_lines,
            });
        }
        raw_hunks.push((id, raw));
    }
    Ok(ParsedFileDiff {
        public: UnifiedFileDiff {
            path: path.to_string(),
            area,
            binary,
            hunks,
        },
        preamble,
        raw_hunks,
        whole_file_only,
    })
}

fn parse_hunk_header(header: &str) -> Result<(u32, u32, u32, u32)> {
    let marker_end = header[3..]
        .find(" @@")
        .map(|index| index + 3)
        .ok_or_else(|| anyhow::anyhow!("invalid unified diff hunk header"))?;
    let ranges = header[3..marker_end].split_whitespace().collect::<Vec<_>>();
    if ranges.len() != 2 {
        bail!("invalid unified diff hunk ranges")
    }
    let parse_range = |value: &str, sign: char| -> Result<(u32, u32)> {
        let value = value
            .strip_prefix(sign)
            .ok_or_else(|| anyhow::anyhow!("invalid unified diff range"))?;
        let mut pieces = value.split(',');
        let start = pieces.next().unwrap_or_default().parse::<u32>()?;
        let count = pieces
            .next()
            .map(str::parse::<u32>)
            .transpose()?
            .unwrap_or(1);
        Ok((start, count))
    };
    let (old_start, old_count) = parse_range(ranges[0], '-')?;
    let (new_start, new_count) = parse_range(ranges[1], '+')?;
    Ok((old_start, old_count, new_start, new_count))
}

fn apply_hunk_native(
    repo: &str,
    path: &str,
    area: GitDiffArea,
    hunk_id: &str,
    action: GitHunkAction,
) -> Result<()> {
    let parsed = diff_hunks_native(repo, path, area, None, None)?;
    if parsed.whole_file_only {
        bail!("binary, rename, copy, and type-change diffs require a whole-file action")
    }
    let raw = parsed
        .raw_hunks
        .iter()
        .find(|(id, _)| id == hunk_id)
        .map(|(_, raw)| raw)
        .ok_or_else(|| {
            anyhow::anyhow!("stale_view: hunk is no longer present in the current diff")
        })?;
    let patch = format!("{}{}", parsed.preamble, raw);
    let args: Vec<&str> = match (area, action) {
        (GitDiffArea::Unstaged, GitHunkAction::Stage) => {
            vec!["apply", "--cached", "--whitespace=nowarn", "-"]
        }
        (GitDiffArea::Staged, GitHunkAction::Unstage) => {
            vec!["apply", "--cached", "--reverse", "--whitespace=nowarn", "-"]
        }
        (GitDiffArea::Unstaged, GitHunkAction::Discard) => {
            vec!["apply", "--reverse", "--whitespace=nowarn", "-"]
        }
        _ => bail!("hunk action is incompatible with the selected diff area"),
    };
    ensure_success(git_write_stdin(repo, args, patch.as_bytes())?)?;
    Ok(())
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

    #[test]
    fn git_diff_hunks_actions_regenerate_current_diff_and_reject_stale_ids() {
        let repo = test_repo();
        let repo_text = repo.to_str().expect("utf8 repo");
        let original = (1..=20)
            .map(|line| format!("line {line}\n"))
            .collect::<String>();
        std::fs::write(repo.join("notes.txt"), &original).expect("write original");
        stage_native(repo_text, &["notes.txt".to_string()]).expect("stage original");
        commit_native(repo_text, "initial", false, false).expect("commit original");
        let changed = original
            .replace("line 2\n", "line two\n")
            .replace("line 18\n", "line eighteen\n");
        std::fs::write(repo.join("notes.txt"), changed).expect("write changes");

        let unstaged = diff_hunks_native(repo_text, "notes.txt", GitDiffArea::Unstaged, None, None)
            .expect("unstaged diff");
        assert_eq!(unstaged.public.hunks.len(), 2);
        let first_id = unstaged.public.hunks[0].id.clone();
        apply_hunk_native(
            repo_text,
            "notes.txt",
            GitDiffArea::Unstaged,
            &first_id,
            GitHunkAction::Stage,
        )
        .expect("stage hunk");
        let staged = diff_hunks_native(repo_text, "notes.txt", GitDiffArea::Staged, None, None)
            .expect("staged diff");
        assert_eq!(staged.public.hunks.len(), 1);
        apply_hunk_native(
            repo_text,
            "notes.txt",
            GitDiffArea::Staged,
            &staged.public.hunks[0].id,
            GitHunkAction::Unstage,
        )
        .expect("unstage hunk");
        let unstaged = diff_hunks_native(repo_text, "notes.txt", GitDiffArea::Unstaged, None, None)
            .expect("unstaged after reverse");
        assert_eq!(unstaged.public.hunks.len(), 2);
        let first_id = unstaged.public.hunks[0].id.clone();
        apply_hunk_native(
            repo_text,
            "notes.txt",
            GitDiffArea::Unstaged,
            &first_id,
            GitHunkAction::Stage,
        )
        .expect("restage hunk");
        let remaining =
            diff_hunks_native(repo_text, "notes.txt", GitDiffArea::Unstaged, None, None)
                .expect("remaining unstaged diff");
        assert_eq!(remaining.public.hunks.len(), 1);
        apply_hunk_native(
            repo_text,
            "notes.txt",
            GitDiffArea::Unstaged,
            &remaining.public.hunks[0].id,
            GitHunkAction::Discard,
        )
        .expect("discard hunk");
        assert!(
            diff_hunks_native(repo_text, "notes.txt", GitDiffArea::Unstaged, None, None)
                .expect("clean unstaged diff")
                .public
                .hunks
                .is_empty()
        );
        assert!(apply_hunk_native(
            repo_text,
            "notes.txt",
            GitDiffArea::Unstaged,
            &first_id,
            GitHunkAction::Discard
        )
        .unwrap_err()
        .to_string()
        .contains("stale_view"));
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn git_diff_hunks_binary_and_rename_fall_back_to_whole_file_actions() {
        let binary = parse_unified_diff(
            "asset.bin",
            GitDiffArea::Unstaged,
            "diff --git a/asset.bin b/asset.bin\nBinary files a/asset.bin and b/asset.bin differ\n",
        )
        .expect("parse binary diff");
        assert!(binary.public.binary);
        assert!(binary.public.hunks.is_empty());
        assert!(binary.whole_file_only);

        let renamed = parse_unified_diff(
            "new.txt",
            GitDiffArea::Unstaged,
            "diff --git a/old.txt b/new.txt\nsimilarity index 90%\nrename from old.txt\nrename to new.txt\n--- a/old.txt\n+++ b/new.txt\n@@ -1 +1 @@\n-old\n+new\n",
        )
        .expect("parse rename diff");
        assert!(!renamed.public.binary);
        assert!(renamed.public.hunks.is_empty());
        assert!(renamed.whole_file_only);
    }
}

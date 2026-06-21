use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChangeType {
    Added,
    Modified,
    Deleted,
    Renamed,
    Copied,
    TypeChanged,
    Untracked,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    pub path: String,
    pub old_path: Option<String>,
    pub change_type: ChangeType,
    pub additions: u32,
    pub deletions: u32,
    pub binary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContents {
    pub old: String,
    pub new: String,
    pub binary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeInfo {
    pub worktree_path: String,
    pub branch: String,
}

#[tauri::command]
pub async fn git_is_available(workspace_folder: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git_status(&workspace_folder, &["rev-parse", "--is-inside-work-tree"])
            .map(|status| status.success())
            .map_err(to_string)
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
pub async fn git_snapshot_baseline(workspace_folder: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot_baseline_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_changed_files(
    workspace_folder: String,
    base_ref: String,
) -> Result<Vec<ChangedFile>, String> {
    tauri::async_runtime::spawn_blocking(move || changed_files_native(&workspace_folder, &base_ref))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_file_contents(
    workspace_folder: String,
    base_ref: String,
    path: String,
) -> Result<FileContents, String> {
    tauri::async_runtime::spawn_blocking(move || {
        file_contents_native(&workspace_folder, &base_ref, &path)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_worktree_create(
    workspace_folder: String,
    task_id: String,
) -> Result<WorktreeInfo, String> {
    tauri::async_runtime::spawn_blocking(move || worktree_create_native(&workspace_folder, &task_id))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_worktree_remove(
    workspace_folder: String,
    worktree_path: String,
    branch: String,
    force: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        worktree_remove_native(&workspace_folder, &worktree_path, &branch, force)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

fn snapshot_baseline_native(repo: &str) -> Result<String> {
    let stash = git_output(repo, &["stash", "create"])?;
    let stash = String::from_utf8_lossy(&stash).trim().to_string();
    if !stash.is_empty() {
        return Ok(stash);
    }
    let head = git_output(repo, &["rev-parse", "HEAD"])?;
    let head = String::from_utf8_lossy(&head).trim().to_string();
    if head.is_empty() {
        Err(anyhow!("git rev-parse HEAD returned an empty ref"))
    } else {
        Ok(head)
    }
}

fn changed_files_native(repo: &str, base_ref: &str) -> Result<Vec<ChangedFile>> {
    let mut files = parse_name_status(&git_output(
        repo,
        &["diff", "-M", "-C", "-z", "--name-status", base_ref],
    )?);
    let stats = parse_numstat(&git_output(repo, &["diff", "--numstat", "-z", base_ref])?);
    for file in &mut files {
        if let Some((additions, deletions, binary)) = stats
            .iter()
            .find(|(path, _)| path == &file.path)
            .map(|(_, stats)| *stats)
        {
            file.additions = additions;
            file.deletions = deletions;
            file.binary = binary;
        }
    }

    let untracked = git_output(repo, &["ls-files", "--others", "--exclude-standard", "-z"])?;
    for path in split_nul(&untracked) {
        if path.is_empty() {
            continue;
        }
        files.push(ChangedFile {
            path,
            old_path: None,
            change_type: ChangeType::Untracked,
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }
    Ok(files)
}

fn file_contents_native(repo: &str, base_ref: &str, path: &str) -> Result<FileContents> {
    let old_bytes = git_output_allow_fail(repo, &["show", &format!("{base_ref}:{path}")])?
        .unwrap_or_default();
    let new_path = Path::new(repo).join(path);
    let new_bytes = match std::fs::read(&new_path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(err) => return Err(err).with_context(|| format!("read {}", new_path.display())),
    };

    let old = String::from_utf8(old_bytes);
    let new = String::from_utf8(new_bytes);
    match (old, new) {
        (Ok(old), Ok(new)) => Ok(FileContents {
            old,
            new,
            binary: false,
        }),
        _ => Ok(FileContents {
            old: String::new(),
            new: String::new(),
            binary: true,
        }),
    }
}

fn worktree_create_native(repo: &str, task_id: &str) -> Result<WorktreeInfo> {
    let short = short_task_id(task_id);
    let branch = format!("awt/task-{short}");
    let data_dir = crate::daemon::paths::daemon_paths()?.data_dir;
    let worktree_path = data_dir.join("worktrees").join(&short);
    std::fs::create_dir_all(parent_dir(&worktree_path)?)?;
    let path_string = worktree_path.to_string_lossy().to_string();
    git_output(
        repo,
        &[
            "worktree",
            "add",
            "-b",
            &branch,
            &path_string,
            "HEAD",
        ],
    )?;
    Ok(WorktreeInfo {
        worktree_path: path_string,
        branch,
    })
}

fn worktree_remove_native(repo: &str, worktree_path: &str, branch: &str, force: bool) -> Result<()> {
    let mut remove_args = vec!["worktree", "remove"];
    if force {
        remove_args.push("--force");
    }
    remove_args.push(worktree_path);
    git_output(repo, &remove_args)?;
    git_output(repo, &["branch", "-D", branch])?;
    Ok(())
}

fn parse_name_status(bytes: &[u8]) -> Vec<ChangedFile> {
    let tokens = split_nul(bytes);
    let mut files = Vec::new();
    let mut index = 0;
    while index < tokens.len() {
        let status = &tokens[index];
        index += 1;
        if status.is_empty() || index >= tokens.len() {
            continue;
        }
        let code = status.chars().next().unwrap_or('M');
        let (old_path, path) = if matches!(code, 'R' | 'C') && index + 1 < tokens.len() {
            let old_path = tokens[index].clone();
            let path = tokens[index + 1].clone();
            index += 2;
            (Some(old_path), path)
        } else {
            let path = tokens[index].clone();
            index += 1;
            (None, path)
        };
        files.push(ChangedFile {
            path,
            old_path,
            change_type: change_type_from_status(code),
            additions: 0,
            deletions: 0,
            binary: false,
        });
    }
    files
}

fn parse_numstat(bytes: &[u8]) -> Vec<(String, (u32, u32, bool))> {
    split_nul(bytes)
        .into_iter()
        .filter_map(|record| {
            let mut fields = record.split('\t');
            let additions = fields.next()?;
            let deletions = fields.next()?;
            let path = fields.next()?.to_string();
            let binary = additions == "-" || deletions == "-";
            Some((
                path,
                (
                    additions.parse().unwrap_or(0),
                    deletions.parse().unwrap_or(0),
                    binary,
                ),
            ))
        })
        .collect()
}

fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect()
}

fn change_type_from_status(status: char) -> ChangeType {
    match status {
        'A' => ChangeType::Added,
        'D' => ChangeType::Deleted,
        'R' => ChangeType::Renamed,
        'C' => ChangeType::Copied,
        'T' => ChangeType::TypeChanged,
        _ => ChangeType::Modified,
    }
}

fn git_output(repo: &str, args: &[&str]) -> Result<Vec<u8>> {
    let output = git_command(repo, args).output()?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        Err(anyhow!(stderr_or_status(&output)))
    }
}

fn git_output_allow_fail(repo: &str, args: &[&str]) -> Result<Option<Vec<u8>>> {
    let output = git_command(repo, args).output()?;
    if output.status.success() {
        Ok(Some(output.stdout))
    } else {
        Ok(None)
    }
}

fn git_status(repo: &str, args: &[&str]) -> Result<std::process::ExitStatus> {
    Ok(git_command(repo, args).status()?)
}

fn git_command(repo: &str, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command.arg("-C").arg(repo).arg("-c").arg("core.quotepath=false");
    command.args(args);
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

fn stderr_or_status(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if stderr.is_empty() {
        format!("git exited with status {}", output.status)
    } else {
        stderr
    }
}

fn short_task_id(task_id: &str) -> String {
    let short: String = task_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == '_')
        .take(12)
        .collect();
    if short.is_empty() {
        "task".to_string()
    } else {
        short
    }
}

fn parent_dir(path: &Path) -> Result<PathBuf> {
    path.parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| anyhow!("{} has no parent directory", path.display()))
}

fn to_string(err: impl std::fmt::Display) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn snapshot_and_diff_return_old_and_new_contents() {
        let repo = test_repo();
        std::fs::write(repo.join("tracked.txt"), "old\n").expect("write tracked");
        run_git(&repo, &["add", "tracked.txt"]);
        run_git(&repo, &["commit", "-m", "initial"]);

        let base = snapshot_baseline_native(repo.to_str().expect("utf8 path")).expect("baseline");
        assert!(!base.is_empty());

        std::fs::write(repo.join("tracked.txt"), "old\nnew\n").expect("modify tracked");
        std::fs::write(repo.join("untracked.txt"), "loose\n").expect("write untracked");

        let files = changed_files_native(repo.to_str().expect("utf8 path"), &base).expect("files");
        assert!(files.iter().any(|file| {
            file.path == "tracked.txt" && matches!(file.change_type, ChangeType::Modified)
        }));
        assert!(files.iter().any(|file| {
            file.path == "untracked.txt" && matches!(file.change_type, ChangeType::Untracked)
        }));

        let contents = file_contents_native(repo.to_str().expect("utf8 path"), &base, "tracked.txt")
            .expect("contents");
        assert!(!contents.binary);
        assert_eq!(contents.old, "old\n");
        assert_eq!(contents.new, "old\nnew\n");

        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    fn test_repo() -> PathBuf {
        let repo = std::env::temp_dir().join(format!("awt-git-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).expect("create repo");
        run_git_at(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "awt@example.invalid"]);
        run_git(&repo, &["config", "user.name", "AWT Test"]);
        repo
    }

    fn run_git(repo: &Path, args: &[&str]) {
        let repo_str = repo.to_str().expect("utf8 path");
        let mut scoped_args = vec!["-C", repo_str];
        scoped_args.extend_from_slice(args);
        run_git_at(repo, &scoped_args);
    }

    fn run_git_at(repo: &Path, args: &[&str]) {
        let mut command = Command::new("git");
        command.current_dir(repo).args(args);
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);
        let output = command.output().expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

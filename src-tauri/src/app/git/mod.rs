pub(crate) mod branch;
pub(crate) mod diff;
pub(crate) mod discover;
mod exec;
pub(crate) mod hosting;
pub(crate) mod log;
pub(crate) mod paths;
pub(crate) mod remote;
pub(crate) mod stage;
pub(crate) mod status;
pub(crate) mod submodule;
#[cfg(test)]
mod test_support;
pub(crate) mod worktree;

use self::exec::{
    git_exit_status, git_read as git_output, git_read_allow_fail as git_output_allow_fail,
    git_write,
};
use self::paths::{resolve_repo_file_path, validate_base_ref};
use self::worktree::{
    WorktreeEntry, WorktreeInfo, WorktreeStorage, WorktreeStorageOptions, WorktreeStorageResolution,
};
use super::license::LicenseService;
use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use std::sync::Arc;
use tauri::State;

#[cfg(test)]
use self::exec::CREATE_NO_WINDOW;
#[cfg(all(test, windows))]
use std::os::windows::process::CommandExt;
#[cfg(test)]
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::process::Command;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
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

#[tauri::command]
pub async fn git_worktree_storage_options() -> Result<WorktreeStorageOptions, String> {
    tauri::async_runtime::spawn_blocking(worktree::storage_options)
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_worktree_resolve_root(
    workspace_folder: String,
    storage: WorktreeStorage,
    name: Option<String>,
) -> Result<WorktreeStorageResolution, String> {
    tauri::async_runtime::spawn_blocking(move || {
        worktree::resolve_root(&workspace_folder, &storage, name.as_deref())
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_is_available(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<bool, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        git_exit_status(&workspace_folder, ["rev-parse", "--is-inside-work-tree"])
            .map(|status| status.success())
            .map_err(to_string)
    })
    .await
    .map_err(to_string)?
}

#[tauri::command]
pub async fn git_snapshot_baseline(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<String, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || snapshot_baseline_native(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_changed_files(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    base_ref: String,
) -> Result<Vec<ChangedFile>, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || changed_files_native(&workspace_folder, &base_ref))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_file_contents(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    base_ref: String,
    path: String,
) -> Result<FileContents, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        file_contents_native(&workspace_folder, &base_ref, &path)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_worktree_create(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    task_id: String,
) -> Result<WorktreeInfo, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        worktree::create_for_task(&workspace_folder, &task_id)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_worktree_create_named(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    name: String,
    start_ref: String,
    branch: String,
    storage: WorktreeStorage,
) -> Result<WorktreeInfo, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        worktree::create_named(&workspace_folder, &name, &start_ref, &branch, &storage)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_worktree_list(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
) -> Result<Vec<WorktreeEntry>, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || worktree::list(&workspace_folder))
        .await
        .map_err(to_string)?
        .map_err(to_string)
}

#[tauri::command]
pub async fn git_worktree_remove(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    worktree_path: String,
    branch: String,
    force: bool,
    delete_branch: bool,
) -> Result<(), String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        worktree::remove(
            &workspace_folder,
            &worktree_path,
            &branch,
            force,
            delete_branch,
        )
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

#[tauri::command]
pub async fn git_worktree_move(
    license: State<'_, Arc<LicenseService>>,
    workspace_folder: String,
    worktree_path: String,
    destination_path: String,
) -> Result<WorktreeInfo, String> {
    license.require_entitled_cached().map_err(to_string)?;
    tauri::async_runtime::spawn_blocking(move || {
        worktree::move_to(&workspace_folder, &worktree_path, &destination_path)
    })
    .await
    .map_err(to_string)?
    .map_err(to_string)
}

fn snapshot_baseline_native(repo: &str) -> Result<String> {
    let stash = git_write(repo, ["stash", "create"])?;
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
    validate_base_ref(base_ref)?;
    let mut files = parse_name_status(&git_output(
        repo,
        ["diff", "-M", "-C", "-z", "--name-status", base_ref, "--"],
    )?);
    let stats = git_output(repo, ["diff", "-M", "--numstat", "-z", base_ref, "--"])?;
    merge_numstat(&mut files, &stats);

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
    validate_base_ref(base_ref)?;
    let new_path = resolve_repo_file_path(repo, path)?;
    let old_bytes =
        git_output_allow_fail(repo, &["show", &format!("{base_ref}:{path}")])?.unwrap_or_default();
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

pub(crate) fn parse_name_status(bytes: &[u8]) -> Vec<ChangedFile> {
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

pub(crate) fn parse_numstat(bytes: &[u8]) -> Vec<(String, (u32, u32, bool))> {
    let records = bytes
        .split(|byte| *byte == 0)
        .map(|record| String::from_utf8_lossy(record).to_string())
        .collect::<Vec<_>>();
    let mut stats = Vec::new();
    let mut index = 0;
    while index < records.len() {
        let record = &records[index];
        index += 1;
        if record.is_empty() {
            continue;
        }
        let mut fields = record.splitn(3, '\t');
        let Some(additions) = fields.next() else {
            continue;
        };
        let Some(deletions) = fields.next() else {
            continue;
        };
        let Some(path) = fields.next() else { continue };
        let path = if path.is_empty() && index + 1 < records.len() {
            index += 1;
            let new_path = records[index].clone();
            index += 1;
            new_path
        } else {
            path.to_string()
        };
        let binary = additions == "-" || deletions == "-";
        stats.push((
            path,
            (
                additions.parse().unwrap_or(0),
                deletions.parse().unwrap_or(0),
                binary,
            ),
        ));
    }
    stats
}

pub(crate) fn merge_numstat(files: &mut [ChangedFile], bytes: &[u8]) {
    let stats = parse_numstat(bytes);
    for file in files {
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
}

pub(crate) fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| String::from_utf8_lossy(part).to_string())
        .collect()
}

pub(crate) fn change_type_from_status(status: char) -> ChangeType {
    match status {
        'A' => ChangeType::Added,
        'D' => ChangeType::Deleted,
        'R' => ChangeType::Renamed,
        'C' => ChangeType::Copied,
        'T' => ChangeType::TypeChanged,
        _ => ChangeType::Modified,
    }
}

pub(crate) fn to_string(err: impl std::fmt::Display) -> String {
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

        let contents =
            file_contents_native(repo.to_str().expect("utf8 path"), &base, "tracked.txt")
                .expect("contents");
        assert!(!contents.binary);
        assert_eq!(contents.old, "old\n");
        assert_eq!(contents.new, "old\nnew\n");

        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn direct_ref_compare_uses_exact_local_and_remote_trees() {
        let repo = test_repo();
        std::fs::write(repo.join("tracked.txt"), "base\n").expect("write base");
        run_git(&repo, &["add", "tracked.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        run_git(&repo, &["checkout", "-b", "remote"]);
        std::fs::write(repo.join("tracked.txt"), "remote\n").expect("write remote");
        run_git(&repo, &["commit", "-am", "remote"]);
        run_git(&repo, &["checkout", "-b", "local", "HEAD~1"]);
        std::fs::write(repo.join("tracked.txt"), "local\n").expect("write local");
        run_git(&repo, &["commit", "-am", "local"]);

        let files = diff::compare_refs_native(repo.to_str().expect("utf8 path"), "local", "remote")
            .expect("compare refs");
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].path, "tracked.txt");
        let contents = diff::compare_refs_file_native(
            repo.to_str().expect("utf8 path"),
            "local",
            "remote",
            "tracked.txt",
        )
        .expect("compare contents");
        assert_eq!(contents.old, "local\n");
        assert_eq!(contents.new, "remote\n");
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn file_contents_rejects_paths_outside_workspace() {
        let repo = test_repo();
        let repo_str = repo.to_str().expect("utf8 path");
        let absolute = if cfg!(windows) {
            r"C:\Windows\win.ini"
        } else {
            "/etc/passwd"
        };

        let absolute_err = file_contents_native(repo_str, "HEAD", absolute)
            .expect_err("absolute path should be rejected")
            .to_string();
        let dotdot_err = file_contents_native(repo_str, "HEAD", "../secret.txt")
            .expect_err("dotdot path should be rejected")
            .to_string();

        assert!(absolute_err.contains("relative"));
        assert!(dotdot_err.contains("workspace"));
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn file_contents_rejects_unsafe_base_refs() {
        let repo = test_repo();
        let repo_str = repo.to_str().expect("utf8 path");

        assert!(file_contents_native(repo_str, "-HEAD", "tracked.txt")
            .expect_err("leading dash ref should be rejected")
            .to_string()
            .contains("must not start"));
        assert!(file_contents_native(repo_str, "main:secret", "tracked.txt")
            .expect_err("colon ref should be rejected")
            .to_string()
            .contains("unsupported"));
        assert!(validate_base_ref("feature/foo_1-2.3@~^").is_ok());
        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    #[test]
    fn named_worktree_creates_lists_moves_and_removes() {
        let repo = test_repo();
        std::fs::write(repo.join("tracked.txt"), "base\n").expect("write tracked");
        run_git(&repo, &["add", "tracked.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        let repo_str = repo.to_str().expect("utf8 repo");
        let root = repo
            .parent()
            .expect("temp parent")
            .join(format!("vibelink-worktrees-{}", Uuid::new_v4()));

        let created = worktree::create_named_at(
            repo_str,
            "Fix Login Flow",
            "HEAD",
            "vibelink/fix-login-flow",
            &root,
        )
        .expect("create named worktree");

        assert_eq!(created.branch, "vibelink/fix-login-flow");
        assert!(Path::new(&created.worktree_path)
            .join("tracked.txt")
            .is_file());
        assert!(Path::new(&created.worktree_path)
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("fix-login-flow-")));

        std::fs::write(
            Path::new(&created.worktree_path).join("tracked.txt"),
            "dirty\n",
        )
        .expect("dirty the worktree");
        let listed = worktree::list(repo_str).expect("list worktrees");
        let entry = listed
            .iter()
            .find(|entry| entry.branch == created.branch)
            .expect("created worktree is listed");
        assert!(!entry.is_main && entry.exists && entry.dirty);
        assert!(listed.iter().any(|entry| entry.is_main));

        let moved_path = root.join("moved-fix-login-flow");
        let moved = worktree::move_to(
            repo_str,
            &created.worktree_path,
            moved_path.to_str().expect("utf8 destination"),
        )
        .expect("move worktree");
        assert_eq!(moved.branch, created.branch);
        assert!(moved_path.join("tracked.txt").is_file());
        assert!(!Path::new(&created.worktree_path).exists());

        // A dirty checkout must not be removed without force.
        assert!(
            worktree::remove(repo_str, &moved.worktree_path, &moved.branch, false, false).is_err()
        );
        worktree::remove(repo_str, &moved.worktree_path, &moved.branch, true, true)
            .expect("force remove worktree and branch");
        assert!(!moved_path.exists());
        assert!(worktree::list(repo_str)
            .expect("list after removal")
            .iter()
            .all(|entry| entry.branch != created.branch));
        assert!(!String::from_utf8_lossy(
            &git_output(repo_str, ["branch", "--list", &created.branch]).expect("list branches")
        )
        .contains("fix-login-flow"));

        std::fs::remove_dir_all(repo).expect("cleanup repo");
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn named_worktree_rejects_unsafe_ref_branch_and_name() {
        let repo = test_repo();
        std::fs::write(repo.join("tracked.txt"), "base\n").expect("write tracked");
        run_git(&repo, &["add", "tracked.txt"]);
        run_git(&repo, &["commit", "-m", "base"]);
        let root = repo
            .parent()
            .expect("temp parent")
            .join(format!("vibelink-worktrees-{}", Uuid::new_v4()));
        let repo_str = repo.to_str().expect("utf8 repo");

        assert!(
            worktree::create_named_at(repo_str, "...", "HEAD", "vibelink/empty", &root)
                .expect_err("empty slug should fail")
                .to_string()
                .contains("letter or number")
        );
        assert!(
            worktree::create_named_at(repo_str, "safe", "-HEAD", "vibelink/safe", &root)
                .expect_err("unsafe start ref should fail")
                .to_string()
                .contains("must not start")
        );
        assert!(
            worktree::create_named_at(repo_str, "safe", "HEAD", "bad branch", &root)
                .expect_err("unsafe branch should fail")
                .to_string()
                .contains("unsupported")
        );

        std::fs::remove_dir_all(repo).expect("cleanup repo");
    }

    fn test_repo() -> PathBuf {
        let repo = std::env::temp_dir().join(format!("vibelink-git-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&repo).expect("create repo");
        run_git_at(&repo, &["init"]);
        run_git(&repo, &["config", "user.email", "vibelink@example.invalid"]);
        run_git(&repo, &["config", "user.name", "VibeLink Test"]);
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

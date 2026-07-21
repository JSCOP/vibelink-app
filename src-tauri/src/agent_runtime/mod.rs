mod process;

pub use process::{HermesAcpOwner, HermesOwnedRuntime, PtyProcessRuntime};

use crate::orchestration::WorktreeAssignment;
use anyhow::{bail, Context, Result};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, LazyLock, Mutex, Weak},
};

static WORKTREE_OPERATION_LOCKS: LazyLock<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug)]
pub struct WorktreeManager {
    root: Arc<PathBuf>,
    operation_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeAuthority {
    pub repository_root: PathBuf,
    pub relative_prefix: PathBuf,
}

impl WorktreeAuthority {
    pub fn repository_root_string(&self) -> String {
        self.repository_root.to_string_lossy().to_string()
    }

    pub fn relative_prefix_string(&self) -> String {
        self.relative_prefix.to_string_lossy().replace('\\', "/")
    }
}

impl WorktreeManager {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)
            .with_context(|| format!("create worktree root {}", root.display()))?;
        let registry_key = root
            .canonicalize()
            .with_context(|| format!("canonicalize worktree root {}", root.display()))?;
        let operation_lock = {
            let mut locks = WORKTREE_OPERATION_LOCKS
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if let Some(shared) = locks.get(&registry_key).and_then(Weak::upgrade) {
                shared
            } else {
                let shared = Arc::new(Mutex::new(()));
                locks.insert(registry_key, Arc::downgrade(&shared));
                shared
            }
        };
        Ok(Self {
            root: Arc::new(root),
            operation_lock,
        })
    }

    pub fn root(&self) -> &Path {
        self.root.as_path()
    }

    pub fn authority(&self, workspace: &Path) -> Result<WorktreeAuthority> {
        require_git_repository(workspace)?;
        let workspace = workspace
            .canonicalize()
            .with_context(|| format!("canonicalize workspace {}", workspace.display()))?;
        let repository_root = PathBuf::from(git_text(
            workspace.as_path(),
            &["rev-parse", "--show-toplevel"],
        )?);
        let repository_root = repository_root
            .canonicalize()
            .with_context(|| format!("canonicalize Git root {}", repository_root.display()))?;
        let relative_prefix = workspace
            .strip_prefix(&repository_root)
            .with_context(|| {
                format!(
                    "workspace {} is outside Git root {}",
                    workspace.display(),
                    repository_root.display()
                )
            })?
            .to_path_buf();
        Ok(WorktreeAuthority {
            repository_root,
            relative_prefix,
        })
    }

    pub fn plan(
        &self,
        authority: &WorktreeAuthority,
        run_id: &str,
        task_id: &str,
        attempt: u32,
    ) -> Result<WorktreeAssignment> {
        let _operation = self
            .operation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        require_git_repository(&authority.repository_root)?;
        let base_revision = git_text(&authority.repository_root, &["stash", "create"])?;
        let base_revision = if base_revision.trim().is_empty() {
            git_text(&authority.repository_root, &["rev-parse", "HEAD"])?
        } else {
            base_revision
        };
        let run_short = short_id(run_id);
        let task_short = short_id(task_id);
        Ok(WorktreeAssignment {
            base_revision: base_revision.trim().to_string(),
            branch: format!("vibelink/run-{run_short}/task-{task_short}-attempt-{attempt}"),
            worktree_path: self
                .root
                .join(run_short)
                .join(format!("{task_short}-{attempt}"))
                .to_string_lossy()
                .to_string(),
        })
    }

    pub fn materialize(
        &self,
        authority: &WorktreeAuthority,
        assignment: &WorktreeAssignment,
    ) -> Result<()> {
        let _operation = self
            .operation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        require_git_repository(&authority.repository_root)?;
        if !assignment.branch.starts_with("vibelink/") {
            bail!("refusing to create an unmanaged worktree branch");
        }
        let path = PathBuf::from(&assignment.worktree_path);
        ensure_managed_path(&self.root, &path)?;
        let registered_branch = registered_worktree_branch(&authority.repository_root, &path)?;
        if registered_branch.as_deref() == Some(assignment.branch.as_str()) {
            return Ok(());
        }
        if registered_branch.is_some() || path.exists() {
            bail!(
                "recorded worktree path is owned by another checkout: {}",
                path.display()
            );
        }
        if !git_text(
            &authority.repository_root,
            &["branch", "--list", &assignment.branch],
        )?
        .is_empty()
        {
            bail!(
                "recorded worktree branch already exists without its checkout: {}",
                assignment.branch
            );
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let output = Command::new("git")
            .args(["worktree", "add", "-b", &assignment.branch])
            .arg(&path)
            .arg(assignment.base_revision.trim())
            .current_dir(&authority.repository_root)
            .output()
            .context("create isolated Git worktree")?;
        if !output.status.success() {
            rollback_failed_create(
                &authority.repository_root,
                &path,
                &assignment.branch,
                &self.root,
            )?;
            bail!(
                "create isolated Git worktree failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(())
    }

    pub fn launch_path(
        &self,
        authority: &WorktreeAuthority,
        assignment: &WorktreeAssignment,
    ) -> Result<PathBuf> {
        let worktree_root = PathBuf::from(&assignment.worktree_path);
        ensure_managed_path(&self.root, &worktree_root)?;
        let worktree_root = worktree_root
            .canonicalize()
            .with_context(|| format!("canonicalize worktree {}", worktree_root.display()))?;
        let launch_path = worktree_root.join(&authority.relative_prefix);
        let launch_path = launch_path.canonicalize().with_context(|| {
            format!(
                "workspace prefix is unavailable in worktree: {}",
                launch_path.display()
            )
        })?;
        if !launch_path.starts_with(&worktree_root) {
            bail!("worktree workspace prefix escaped its managed checkout");
        }
        Ok(launch_path)
    }

    pub fn create(
        &self,
        repository: &Path,
        run_id: &str,
        task_id: &str,
        attempt: u32,
    ) -> Result<WorktreeAssignment> {
        let authority = self.authority(repository)?;
        let assignment = self.plan(&authority, run_id, task_id, attempt)?;
        self.materialize(&authority, &assignment)?;
        Ok(assignment)
    }

    pub fn cleanup(
        &self,
        repository: &Path,
        assignment: &WorktreeAssignment,
        force: bool,
    ) -> Result<()> {
        let _operation = self
            .operation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let repository_root = self.authority(repository)?.repository_root;
        if !assignment.branch.starts_with("vibelink/") {
            bail!("refusing to remove an unmanaged worktree branch");
        }
        let worktree_path = PathBuf::from(&assignment.worktree_path);
        ensure_managed_path(&self.root, &worktree_path)?;
        if worktree_path.exists() {
            let mut command = Command::new("git");
            command.args(["worktree", "remove"]);
            if force {
                command.arg("--force");
            }
            let output = command
                .arg(&worktree_path)
                .current_dir(&repository_root)
                .output()
                .context("remove isolated Git worktree")?;
            if !output.status.success() {
                if force {
                    if worktree_path.exists() {
                        fs::remove_dir_all(&worktree_path).with_context(|| {
                            format!(
                                "force-remove isolated worktree after Git cleanup failed: {}",
                                String::from_utf8_lossy(&output.stderr).trim()
                            )
                        })?;
                    }
                } else {
                    bail!(
                        "remove isolated Git worktree failed: {}",
                        String::from_utf8_lossy(&output.stderr).trim()
                    );
                }
            }
        }
        let _ = Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(&repository_root)
            .status();
        let branch_output = Command::new("git")
            .args(["branch", "-D", &assignment.branch])
            .current_dir(&repository_root)
            .output()
            .context("delete isolated worktree branch")?;
        if !branch_output.status.success()
            && !String::from_utf8_lossy(&branch_output.stderr).contains("not found")
        {
            bail!(
                "delete isolated worktree branch failed: {}",
                String::from_utf8_lossy(&branch_output.stderr).trim()
            );
        }
        remove_empty_parents(&worktree_path, &self.root);
        Ok(())
    }

    pub fn merge(&self, repository: &Path, assignment: &WorktreeAssignment) -> Result<String> {
        let _operation = self
            .operation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let repository_root = self.authority(repository)?.repository_root;
        if !assignment.branch.starts_with("vibelink/") {
            bail!("refusing to merge an unmanaged worktree branch");
        }
        let output = Command::new("git")
            .args(["merge", "--no-ff", "--no-edit", &assignment.branch])
            .current_dir(&repository_root)
            .output()
            .context("merge approved worktree branch")?;
        if !output.status.success() {
            bail!(
                "merge approved worktree failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(git_text(&repository_root, &["rev-parse", "HEAD"])?
            .trim()
            .to_string())
    }

    pub fn diff_summary(
        &self,
        repository: &Path,
        assignment: &WorktreeAssignment,
    ) -> Result<String> {
        let _operation = self
            .operation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let repository_root = self.authority(repository)?.repository_root;
        git_text(
            &repository_root,
            &[
                "diff",
                "--stat",
                &format!("{}..{}", assignment.base_revision, assignment.branch),
            ],
        )
    }
}

fn require_git_repository(repository: &Path) -> Result<()> {
    if !repository.is_dir() {
        bail!("repository path is unavailable: {}", repository.display());
    }
    let output = Command::new("git")
        .args(["rev-parse", "--is-inside-work-tree"])
        .current_dir(repository)
        .output()
        .context("inspect Git repository")?;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != "true" {
        bail!(
            "workspace is not a Git repository: {}",
            repository.display()
        );
    }
    Ok(())
}

fn git_text(repository: &Path, arguments: &[&str]) -> Result<String> {
    let output = Command::new("git")
        .args(arguments)
        .current_dir(repository)
        .output()
        .with_context(|| format!("run git {}", arguments.join(" ")))?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn registered_worktree_branch(repository: &Path, candidate: &Path) -> Result<Option<String>> {
    let candidate = if candidate.exists() {
        candidate
            .canonicalize()
            .context("canonicalize registered worktree path")?
    } else {
        candidate.to_path_buf()
    };
    let listing = git_text(repository, &["worktree", "list", "--porcelain"])?;
    let mut current_path: Option<PathBuf> = None;
    for line in listing.lines().chain(std::iter::once("")) {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(PathBuf::from(path));
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(path) = current_path.as_ref() {
                let comparable = path.canonicalize().unwrap_or_else(|_| path.clone());
                if comparable == candidate {
                    return Ok(Some(branch.to_string()));
                }
            }
        } else if line.is_empty() {
            current_path = None;
        }
    }
    Ok(None)
}

fn rollback_failed_create(
    repository: &Path,
    path: &Path,
    branch: &str,
    managed_root: &Path,
) -> Result<()> {
    let mut errors = Vec::new();
    if path.exists() {
        let remove = Command::new("git")
            .args(["worktree", "remove", "--force"])
            .arg(path)
            .current_dir(repository)
            .output();
        if remove
            .as_ref()
            .map_or(true, |output| !output.status.success())
            && path.exists()
        {
            if let Err(error) = fs::remove_dir_all(path) {
                errors.push(format!("remove {}: {error}", path.display()));
            }
        }
    }
    let _ = Command::new("git")
        .args(["worktree", "prune"])
        .current_dir(repository)
        .status();
    let branch_cleanup = Command::new("git")
        .args(["branch", "-D", branch])
        .current_dir(repository)
        .output();
    if branch_cleanup.as_ref().map_or(true, |output| {
        !output.status.success() && !String::from_utf8_lossy(&output.stderr).contains("not found")
    }) {
        errors.push(format!("delete branch {branch}"));
    }
    remove_empty_parents(path, managed_root);
    if errors.is_empty() {
        Ok(())
    } else {
        bail!("worktree rollback incomplete: {}", errors.join(", "))
    }
}

fn ensure_managed_path(root: &Path, candidate: &Path) -> Result<()> {
    let relative = candidate
        .strip_prefix(root)
        .context("worktree path is outside the managed root")?;
    if relative.as_os_str().is_empty()
        || !relative
            .components()
            .all(|component| matches!(component, std::path::Component::Normal(_)))
    {
        bail!("worktree path is outside the managed root");
    }

    let canonical_root = root.canonicalize().context("canonicalize worktree root")?;
    let mut existing_ancestor = candidate;
    while !existing_ancestor.exists() {
        existing_ancestor = existing_ancestor
            .parent()
            .context("worktree path has no existing managed ancestor")?;
    }
    let canonical_ancestor = existing_ancestor
        .canonicalize()
        .context("canonicalize worktree ancestor")?;
    if !canonical_ancestor.starts_with(&canonical_root)
        || canonical_ancestor == canonical_root && candidate == root
    {
        bail!("worktree path is outside the managed root");
    }
    Ok(())
}

fn remove_empty_parents(path: &Path, root: &Path) {
    let mut current = path.parent();
    while let Some(directory) = current {
        if directory == root || !directory.starts_with(root) {
            break;
        }
        if fs::remove_dir(directory).is_err() {
            break;
        }
        current = directory.parent();
    }
}

fn short_id(value: &str) -> &str {
    value.get(..8).unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn git(repository: &Path, arguments: &[&str]) {
        let status = Command::new("git")
            .args(arguments)
            .current_dir(repository)
            .status()
            .expect("run git");
        assert!(status.success(), "git {arguments:?}");
    }

    #[test]
    fn isolated_worktree_preserves_selected_subdirectory_and_cleans_recorded_root() {
        let root = std::env::temp_dir().join(format!("vibelink-worktree-test-{}", Uuid::new_v4()));
        let repository = root.join("repository");
        let selected_workspace = repository.join("subproject");
        let managed = root.join("managed");
        fs::create_dir_all(&selected_workspace).expect("create selected workspace");
        git(&repository, &["init"]);
        git(&repository, &["config", "user.email", "test@example.com"]);
        git(&repository, &["config", "user.name", "VibeLink Test"]);
        fs::write(selected_workspace.join("file.txt"), "base\n").expect("write file");
        git(&repository, &["add", "subproject/file.txt"]);
        git(&repository, &["commit", "-m", "base"]);

        let manager = WorktreeManager::new(managed.clone()).expect("manager");
        let authority = manager.authority(&selected_workspace).expect("authority");
        assert_eq!(
            authority.repository_root,
            repository.canonicalize().expect("Git root")
        );
        assert_eq!(authority.relative_prefix, PathBuf::from("subproject"));
        let assignment = manager
            .plan(
                &authority,
                &Uuid::new_v4().to_string(),
                &Uuid::new_v4().to_string(),
                1,
            )
            .expect("plan worktree");
        manager
            .materialize(&authority, &assignment)
            .expect("materialize worktree");
        let worktree_path = PathBuf::from(&assignment.worktree_path);
        let launch_path = manager
            .launch_path(&authority, &assignment)
            .expect("launch path");
        assert!(worktree_path.is_dir());
        assert!(worktree_path.starts_with(&managed));
        assert_eq!(
            launch_path,
            worktree_path
                .canonicalize()
                .expect("worktree root")
                .join("subproject")
        );
        assert!(launch_path.join("file.txt").is_file());
        assert!(assignment.branch.starts_with("vibelink/run-"));

        manager
            .cleanup(&authority.repository_root, &assignment, true)
            .expect("cleanup worktree");
        assert!(!worktree_path.exists());
        let branches = git_text(
            &authority.repository_root,
            &["branch", "--list", &assignment.branch],
        )
        .expect("list branch");
        assert!(branches.is_empty());
        let _ = fs::remove_dir_all(root);
    }
}

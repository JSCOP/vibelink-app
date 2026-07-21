mod process;

pub use process::{HermesAcpOwner, HermesOwnedRuntime, PtyProcessRuntime};

use crate::orchestration::WorktreeAssignment;
use anyhow::{bail, Context, Result};
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Clone, Debug)]
pub struct WorktreeManager {
    root: PathBuf,
}

impl WorktreeManager {
    pub fn new(root: PathBuf) -> Result<Self> {
        fs::create_dir_all(&root)
            .with_context(|| format!("create worktree root {}", root.display()))?;
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn create(
        &self,
        repository: &Path,
        run_id: &str,
        task_id: &str,
        attempt: u32,
    ) -> Result<WorktreeAssignment> {
        require_git_repository(repository)?;
        let base_revision = git_text(repository, &["stash", "create"])?;
        let base_revision = if base_revision.trim().is_empty() {
            git_text(repository, &["rev-parse", "HEAD"])?
        } else {
            base_revision
        };
        let run_short = short_id(run_id);
        let task_short = short_id(task_id);
        let branch = format!("vibelink/run-{run_short}/task-{task_short}-attempt-{attempt}");
        let path = self
            .root
            .join(run_short)
            .join(format!("{task_short}-{attempt}"));
        if path.exists() {
            bail!("recorded worktree path already exists: {}", path.display());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let output = Command::new("git")
            .args(["worktree", "add", "-b", &branch])
            .arg(&path)
            .arg(base_revision.trim())
            .current_dir(repository)
            .output()
            .context("create isolated Git worktree")?;
        if !output.status.success() {
            bail!(
                "create isolated Git worktree failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(WorktreeAssignment {
            base_revision: base_revision.trim().to_string(),
            branch,
            worktree_path: path.to_string_lossy().to_string(),
        })
    }

    pub fn cleanup(
        &self,
        repository: &Path,
        assignment: &WorktreeAssignment,
        force: bool,
    ) -> Result<()> {
        require_git_repository(repository)?;
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
                .current_dir(repository)
                .output()
                .context("remove isolated Git worktree")?;
            if !output.status.success() {
                bail!(
                    "remove isolated Git worktree failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }
        }
        let branch_output = Command::new("git")
            .args(["branch", "-D", &assignment.branch])
            .current_dir(repository)
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
        let _ = Command::new("git")
            .args(["worktree", "prune"])
            .current_dir(repository)
            .status();
        remove_empty_parents(&worktree_path, &self.root);
        Ok(())
    }

    pub fn merge(&self, repository: &Path, assignment: &WorktreeAssignment) -> Result<String> {
        require_git_repository(repository)?;
        if !assignment.branch.starts_with("vibelink/") {
            bail!("refusing to merge an unmanaged worktree branch");
        }
        let output = Command::new("git")
            .args(["merge", "--no-ff", "--no-edit", &assignment.branch])
            .current_dir(repository)
            .output()
            .context("merge approved worktree branch")?;
        if !output.status.success() {
            bail!(
                "merge approved worktree failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(git_text(repository, &["rev-parse", "HEAD"])?
            .trim()
            .to_string())
    }

    pub fn diff_summary(
        &self,
        repository: &Path,
        assignment: &WorktreeAssignment,
    ) -> Result<String> {
        require_git_repository(repository)?;
        git_text(
            repository,
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

fn ensure_managed_path(root: &Path, candidate: &Path) -> Result<()> {
    let root = root.canonicalize().context("canonicalize worktree root")?;
    let comparable = if candidate.exists() {
        candidate
            .canonicalize()
            .context("canonicalize worktree path")?
    } else {
        let parent = candidate
            .parent()
            .context("worktree path has no parent")?
            .canonicalize()
            .context("canonicalize worktree parent")?;
        parent.join(candidate.file_name().context("worktree path has no name")?)
    };
    if !comparable.starts_with(&root) || comparable == root {
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
    fn isolated_worktree_is_created_and_cleaned_from_recorded_path() {
        let root = std::env::temp_dir().join(format!("vibelink-worktree-test-{}", Uuid::new_v4()));
        let repository = root.join("repository");
        let managed = root.join("managed");
        fs::create_dir_all(&repository).expect("create repository");
        git(&repository, &["init"]);
        git(&repository, &["config", "user.email", "test@example.com"]);
        git(&repository, &["config", "user.name", "VibeLink Test"]);
        fs::write(repository.join("file.txt"), "base\n").expect("write file");
        git(&repository, &["add", "file.txt"]);
        git(&repository, &["commit", "-m", "base"]);

        let manager = WorktreeManager::new(managed.clone()).expect("manager");
        let assignment = manager
            .create(
                &repository,
                &Uuid::new_v4().to_string(),
                &Uuid::new_v4().to_string(),
                1,
            )
            .expect("create worktree");
        let worktree_path = PathBuf::from(&assignment.worktree_path);
        assert!(worktree_path.is_dir());
        assert!(worktree_path.starts_with(&managed));
        assert!(assignment.branch.starts_with("vibelink/run-"));

        manager
            .cleanup(&repository, &assignment, true)
            .expect("cleanup worktree");
        assert!(!worktree_path.exists());
        let branches =
            git_text(&repository, &["branch", "--list", &assignment.branch]).expect("list branch");
        assert!(branches.is_empty());
        let _ = fs::remove_dir_all(root);
    }
}

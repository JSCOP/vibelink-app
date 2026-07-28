mod process;

pub use process::{HermesAcpOwner, HermesOwnedRuntime, PtyProcessRuntime};

use crate::app::git::worktree_registry::WorktreeRegistry;
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

#[derive(Clone)]
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
    pub fn new(root: PathBuf, _registry: Arc<WorktreeRegistry>) -> Result<Self> {
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
        _authority: &WorktreeAuthority,
        run_id: &str,
        task_id: &str,
        attempt: u32,
    ) -> Result<WorktreeAssignment> {
        let _operation = self
            .operation_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let run_short = short_id(run_id);
        let task_short = short_id(task_id);
        Ok(WorktreeAssignment {
            worktree_id: None,
            instance_id: None,
            base_revision: String::new(),
            branch: format!("vibelink/run-{run_short}/task-{task_short}-attempt-{attempt}"),
            worktree_path: self
                .root
                .join(run_short)
                .join(format!("{task_short}-{attempt}"))
                .to_string_lossy()
                .to_string(),
        })
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

fn short_id(value: &str) -> &str {
    value.get(..8).unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control_plane::ControlPlane;
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
    fn planning_preserves_selected_subdirectory_without_git_mutation_authority() {
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

        let control = Arc::new(ControlPlane::open(&root.join("control")).expect("control"));
        let registry = Arc::new(WorktreeRegistry::new(control));
        let manager = WorktreeManager::new(managed.clone(), registry).expect("manager");
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
        assert!(assignment.branch.starts_with("vibelink/run-"));
        assert!(!Path::new(&assignment.worktree_path).exists());
        let _ = fs::remove_dir_all(root);
    }
}

use super::{
    types::{AutomationRecord, AutomationRunWorktree},
    AutomationWorktreeProvision,
};
use crate::{
    agent_runtime::WorktreeManager,
    app::git::worktree_registry::WorktreeRegistry,
    orchestration::WorktreeAssignment,
    worktree_storage::{requested_root, WorktreeStorage},
};
use anyhow::{bail, Context, Result};
use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
    sync::Arc,
};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CleanupReason {
    PrecheckFailed,
    SetupUnavailable,
    Completed,
    DispatchFailed,
    Cancelled,
    InteractiveAuth,
}

impl CleanupReason {
    fn label(self) -> &'static str {
        match self {
            Self::PrecheckFailed => "precheck failed",
            Self::SetupUnavailable => "setup unavailable",
            Self::Completed => "completed",
            Self::DispatchFailed => "dispatch failed",
            Self::Cancelled => "cancelled",
            Self::InteractiveAuth => "interactive authentication required",
        }
    }

    fn retain_without_cleanup(self) -> bool {
        matches!(self, Self::Completed)
    }

    fn retain_when_dirty(self) -> bool {
        matches!(
            self,
            Self::DispatchFailed | Self::Cancelled | Self::InteractiveAuth
        )
    }
}

#[derive(Clone)]
pub struct PreparedWorkspace {
    pub cwd: PathBuf,
    pub worktree: AutomationRunWorktree,
    pub owned: bool,
    ownership: PreparedOwnership,
}

#[derive(Clone)]
enum PreparedOwnership {
    Existing,
    NewPerRun {
        repository_root: PathBuf,
        assignment: WorktreeAssignment,
    },
}

#[derive(Clone, Debug, PartialEq)]
pub struct CleanupOutcome {
    pub worktree: AutomationRunWorktree,
    pub error: Option<String>,
}

#[derive(Clone)]
pub struct AutomationWorktreeController {
    manager: WorktreeManager,
    registry: Arc<WorktreeRegistry>,
}

impl AutomationWorktreeController {
    pub fn new(manager: WorktreeManager, registry: Arc<WorktreeRegistry>) -> Self {
        Self { manager, registry }
    }

    pub fn prepare_with_worktree<F>(
        &self,
        run_id: &str,
        run_number: u64,
        automation: &AutomationRecord,
        base_workspace: &Path,
        create_worktree: F,
    ) -> Result<PreparedWorkspace>
    where
        F: FnOnce(&WorktreeAssignment) -> Result<AutomationWorktreeProvision>,
    {
        if !base_workspace.is_dir() {
            bail!(
                "automation workspace is unavailable: {}",
                base_workspace.display()
            );
        }
        match automation.workspace_mode.as_str() {
            "existing" => self.prepare_existing(automation, base_workspace),
            "new_per_run" => self.prepare_new(
                run_id,
                run_number,
                automation,
                base_workspace,
                create_worktree,
            ),
            mode => bail!("unsupported automation workspace mode '{mode}'"),
        }
    }

    #[cfg(test)]
    pub fn prepare(
        &self,
        run_id: &str,
        run_number: u64,
        automation: &AutomationRecord,
        base_workspace: &Path,
    ) -> Result<PreparedWorkspace> {
        self.prepare_with_worktree(run_id, run_number, automation, base_workspace, |planned| {
            let output = Command::new("git")
                .args([
                    "worktree",
                    "add",
                    "-b",
                    &planned.branch,
                    &planned.worktree_path,
                    &planned.base_revision,
                ])
                .current_dir(base_workspace)
                .output()
                .context("create test automation worktree")?;
            if !output.status.success() {
                bail!(
                    "create test automation worktree failed: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                );
            }
            Ok(AutomationWorktreeProvision {
                session_id: "test-session".into(),
                assignment: planned.clone(),
            })
        })
    }
    pub fn cleanup_if_safe(
        &self,
        prepared: &PreparedWorkspace,
        reason: CleanupReason,
    ) -> CleanupOutcome {
        let mut record = prepared.worktree.clone();
        let PreparedOwnership::NewPerRun {
            repository_root,
            assignment,
        } = &prepared.ownership
        else {
            record.disposition = "retained".into();
            return CleanupOutcome {
                worktree: record,
                error: None,
            };
        };

        if reason.retain_without_cleanup() {
            record.disposition = "retained".into();
            return CleanupOutcome {
                worktree: record,
                error: None,
            };
        }

        let target = Path::new(&assignment.worktree_path);
        if let Err(error) = exact_owned_worktree(repository_root, target, &assignment.branch) {
            return cleanup_failed(record, reason, error);
        }
        let clean = match status_is_clean(target) {
            Ok(clean) => clean,
            Err(error) => return cleanup_failed(record, reason, error),
        };
        if !clean && reason.retain_when_dirty() {
            record.disposition = "retained".into();
            return CleanupOutcome {
                worktree: record,
                error: None,
            };
        }

        // Lifecycle-managed automation worktrees stay registered and visible until the
        // user removes them through the shared preflight/acknowledgement flow.
        record.disposition = "retained".into();
        CleanupOutcome {
            worktree: record,
            error: None,
        }
    }

    fn prepare_existing(
        &self,
        automation: &AutomationRecord,
        workspace: &Path,
    ) -> Result<PreparedWorkspace> {
        let cwd = workspace
            .canonicalize()
            .with_context(|| format!("canonicalize workspace {}", workspace.display()))?;
        let is_git = is_git_repository(&cwd)?;
        if automation.precheck.require_git && !is_git {
            bail!("workspace is not a Git repository: {}", cwd.display());
        }
        let (branch, base_revision) = if is_git {
            (
                git_text(&cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
                    .context("resolve existing workspace branch")?,
                git_text(&cwd, &["rev-parse", "HEAD"])
                    .context("resolve existing workspace revision")?,
            )
        } else {
            (String::new(), String::new())
        };
        Ok(PreparedWorkspace {
            cwd: cwd.clone(),
            worktree: AutomationRunWorktree {
                worktree_id: None,
                instance_id: None,
                session_id: None,
                path: cwd.to_string_lossy().into_owned(),
                branch,
                base_revision,
                disposition: "retained".into(),
            },
            owned: false,
            ownership: PreparedOwnership::Existing,
        })
    }

    fn prepare_new<F>(
        &self,
        run_id: &str,
        run_number: u64,
        automation: &AutomationRecord,
        workspace: &Path,
        create_worktree: F,
    ) -> Result<PreparedWorkspace>
    where
        F: FnOnce(&WorktreeAssignment) -> Result<AutomationWorktreeProvision>,
    {
        if run_id.trim().is_empty() {
            bail!("automation run id must not be empty");
        }
        let authority = self
            .manager
            .authority(workspace)
            .context("validate automation Git workspace")?;
        let base_revision = resolve_base_revision(
            &authority.repository_root,
            automation.base_ref.as_deref().unwrap_or("HEAD"),
        )?;
        let storage: WorktreeStorage = serde_json::from_value(automation.worktree_storage.clone())
            .context("decode automation worktree storage")?;
        let automation_short = short_component(&automation.id);
        let run_short = short_component(run_id);
        let name = format!("automation-{automation_short}-run-{run_number}-{run_short}");
        let mut root = requested_root(&authority.repository_root, &storage, self.manager.root())
            .context("resolve automation worktree storage")?;
        if storage.group_by_repository {
            root = root.join(repository_folder(&authority.repository_root));
        }
        let manager = WorktreeManager::new(root, Arc::clone(&self.registry))
            .context("initialize automation worktree storage")?;
        let branch = format!("vibelink/automation/{automation_short}/run-{run_number}-{run_short}");
        git_text(
            &authority.repository_root,
            &["check-ref-format", "--branch", &branch],
        )
        .context("validate automation worktree branch")?;
        let unique = Uuid::new_v4().simple().to_string();
        let planned = WorktreeAssignment {
            worktree_id: None,
            instance_id: None,
            base_revision: base_revision.clone(),
            branch,
            worktree_path: manager
                .root()
                .join(format!("{name}-{}", &unique[..8]))
                .to_string_lossy()
                .into_owned(),
        };
        let provision = create_worktree(&planned).context("create automation worktree")?;
        let assignment = provision.assignment;
        let cwd = manager
            .launch_path(&authority, &assignment)
            .context("resolve automation worktree workspace")?;
        Ok(PreparedWorkspace {
            cwd,
            worktree: AutomationRunWorktree {
                worktree_id: assignment.worktree_id.clone(),
                instance_id: assignment.instance_id.clone(),
                session_id: Some(provision.session_id),
                path: assignment.worktree_path.clone(),
                branch: assignment.branch.clone(),
                base_revision: assignment.base_revision.clone(),
                disposition: "live".into(),
            },
            owned: true,
            ownership: PreparedOwnership::NewPerRun {
                repository_root: authority.repository_root,
                assignment,
            },
        })
    }
}

fn cleanup_failed(
    mut worktree: AutomationRunWorktree,
    reason: CleanupReason,
    error: impl std::fmt::Display,
) -> CleanupOutcome {
    worktree.disposition = "cleanup_failed".into();
    CleanupOutcome {
        worktree,
        error: Some(format!(
            "automation worktree cleanup after {} failed: {error}",
            reason.label()
        )),
    }
}

fn resolve_base_revision(repository: &Path, base_ref: &str) -> Result<String> {
    let base_ref = base_ref.trim();
    if base_ref.is_empty() {
        bail!("automation base ref must not be empty");
    }
    git_text(
        repository,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            "--end-of-options",
            &format!("{base_ref}^{{commit}}"),
        ],
    )
    .with_context(|| format!("resolve automation base ref {base_ref}"))
}

fn exact_owned_worktree(repository: &Path, target: &Path, branch: &str) -> Result<()> {
    let listing = git_text(repository, &["worktree", "list", "--porcelain"])?;
    let mut current_path: Option<PathBuf> = None;
    let mut current_branch: Option<&str> = None;
    for line in listing.lines().chain(std::iter::once("")) {
        if let Some(path) = line.strip_prefix("worktree ") {
            current_path = Some(PathBuf::from(path));
        } else if let Some(value) = line.strip_prefix("branch refs/heads/") {
            current_branch = Some(value);
        } else if line.is_empty() {
            if current_branch == Some(branch)
                && current_path
                    .as_deref()
                    .is_some_and(|path| same_path(path, target))
            {
                return Ok(());
            }
            current_path = None;
            current_branch = None;
        }
    }
    bail!(
        "recorded automation worktree is not registered at its exact owned path: {}",
        target.display()
    )
}

fn same_path(left: &Path, right: &Path) -> bool {
    match (left.canonicalize(), right.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => left == right,
    }
}

fn status_is_clean(worktree: &Path) -> Result<bool> {
    Ok(git_text(
        worktree,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?
    .is_empty())
}

fn is_git_repository(workspace: &Path) -> Result<bool> {
    let output = git_output(workspace, &["rev-parse", "--is-inside-work-tree"])?;
    Ok(output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true")
}

fn git_text(repository: &Path, arguments: &[&str]) -> Result<String> {
    let output = git_output(repository, arguments)?;
    if !output.status.success() {
        bail!(
            "git {} failed: {}",
            arguments.join(" "),
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn git_output(repository: &Path, arguments: &[&str]) -> Result<Output> {
    let mut command = Command::new("git");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
        .args(arguments)
        .current_dir(repository)
        .output()
        .with_context(|| format!("run git {}", arguments.join(" ")))
}

fn short_component(value: &str) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for ch in value.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() && slug.len() < 8 {
                slug.push('-');
            }
            if slug.len() < 8 {
                slug.push(ch.to_ascii_lowercase());
            }
            separator = false;
        } else if !slug.is_empty() {
            separator = true;
        }
        if slug.len() >= 8 {
            break;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        slug.push_str("id");
    }
    format!("{slug}-{}", stable_hash6(value))
}

fn repository_folder(repository: &Path) -> String {
    let normalized = repository.to_string_lossy().replace('\\', "/");
    let normalized = normalized.trim_end_matches('/');
    let name = normalized
        .rsplit('/')
        .find(|part| !part.is_empty())
        .unwrap_or("repository");
    let slug = slug_worktree_name(name);
    let slug = if slug.is_empty() {
        "repository".to_string()
    } else {
        slug
    };
    format!(
        "{slug}-{}",
        &stable_hash_hex(&normalized.to_ascii_lowercase())[..8]
    )
}

fn slug_worktree_name(name: &str) -> String {
    let mut slug = String::with_capacity(name.len());
    let mut separator_pending = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            if separator_pending && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(ch.to_ascii_lowercase());
            separator_pending = false;
        } else if !slug.is_empty() {
            separator_pending = true;
        }
    }
    slug
}

fn stable_hash_hex(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn stable_hash6(value: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in value.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")[..6].to_string()
}

#[cfg(test)]
mod tests {
    use super::super::types::AutomationPrecheck;
    use super::*;
    use serde_json::json;
    use std::fs;

    struct Fixture {
        root: PathBuf,
        repo: PathBuf,
        storage: PathBuf,
        controller: AutomationWorktreeController,
    }

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("vibelink-auto-wt-{}", Uuid::new_v4()));
            let repo = root.join("repo");
            let storage = root.join("mock-other-volume");
            fs::create_dir_all(&repo).expect("repo");
            git(&repo, &["init"]);
            git(&repo, &["config", "user.email", "test@example.com"]);
            git(&repo, &["config", "user.name", "VibeLink Test"]);
            git(&repo, &["config", "core.autocrlf", "false"]);
            fs::write(repo.join("tracked.txt"), "base\n").expect("file");
            git(&repo, &["add", "tracked.txt"]);
            git(&repo, &["commit", "-m", "base"]);
            let control = Arc::new(
                crate::control_plane::ControlPlane::open(&root.join("control"))
                    .expect("control plane"),
            );
            let registry = Arc::new(WorktreeRegistry::new(control));
            let controller = AutomationWorktreeController::new(
                WorktreeManager::new(root.join("default-managed"), Arc::clone(&registry))
                    .expect("manager"),
                registry,
            );
            Self {
                root,
                repo,
                storage,
                controller,
            }
        }

        fn automation(&self, mode: &str) -> AutomationRecord {
            AutomationRecord {
                id: "automation-12345678-abcdef".into(),
                session_id: "session".into(),
                name: "Audit".into(),
                prompt: "Audit dependencies".into(),
                agent: "hermes".into(),
                provider: None,
                model: None,
                use_agent_default_model: true,
                toolsets: vec!["hermes-acp".into()],
                skills: vec![],
                max_turns: 50,
                timeout_seconds: 1_800,
                schedule_kind: "daily".into(),
                schedule_value: "09:00".into(),
                timezone: "UTC".into(),
                dtstart: None,
                next_run_at: None,
                last_run_at: None,
                enabled: true,
                requires_review: false,
                missed_run_grace_minutes: 720,
                missed_run_policy: "run_once_within_grace".into(),
                workspace_mode: mode.into(),
                worktree_storage: json!({
                    "mode": "custom",
                    "customRoot": self.storage.to_string_lossy(),
                    "groupByRepository": false
                }),
                base_ref: None,
                precheck: AutomationPrecheck {
                    command: None,
                    timeout_seconds: 60,
                    require_workspace: true,
                    require_git: true,
                },
                source: None,
                created_at: 0,
                updated_at: 0,
            }
        }

        fn remove(self) {
            let _ = fs::remove_dir_all(self.root);
        }
    }

    fn git(repo: &Path, args: &[&str]) {
        let output = git_output(repo, args).expect("git");
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn clean(f: &Fixture, prepared: &PreparedWorkspace) {
        assert_eq!(
            f.controller
                .cleanup_if_safe(prepared, CleanupReason::SetupUnavailable)
                .worktree
                .disposition,
            "retained"
        );
        git(
            &f.repo,
            &["worktree", "remove", "--force", &prepared.worktree.path],
        );
    }

    #[test]
    fn creates_new_per_run_worktree_in_configured_storage() {
        let f = Fixture::new();
        let prepared = f
            .controller
            .prepare("run-one", 1, &f.automation("new_per_run"), &f.repo)
            .expect("prepare");
        assert!(prepared.owned);
        assert!(prepared.cwd.join("tracked.txt").is_file());
        assert!(Path::new(&prepared.worktree.path).starts_with(&f.storage));
        assert_ne!(prepared.cwd, f.repo);
        clean(&f, &prepared);
        f.remove();
    }

    #[test]
    fn run_identity_makes_branch_and_path_unique() {
        let f = Fixture::new();
        let automation = f.automation("new_per_run");
        let one = f
            .controller
            .prepare("shared-prefix-one", 1, &automation, &f.repo)
            .unwrap();
        let two = f
            .controller
            .prepare("shared-prefix-two", 2, &automation, &f.repo)
            .unwrap();
        assert_ne!(one.worktree.branch, two.worktree.branch);
        assert_ne!(one.worktree.path, two.worktree.path);
        clean(&f, &one);
        clean(&f, &two);
        f.remove();
    }

    #[test]
    fn base_ref_selects_revision_without_mutating_source() {
        let f = Fixture::new();
        let base = git_text(&f.repo, &["rev-parse", "HEAD"]).unwrap();
        fs::write(f.repo.join("tracked.txt"), "later\n").unwrap();
        git(&f.repo, &["add", "tracked.txt"]);
        git(&f.repo, &["commit", "-m", "later"]);
        let mut automation = f.automation("new_per_run");
        automation.base_ref = Some(base.clone());
        let prepared = f
            .controller
            .prepare("base-run", 3, &automation, &f.repo)
            .unwrap();
        assert_eq!(prepared.worktree.base_revision, base);
        assert_eq!(
            fs::read_to_string(prepared.cwd.join("tracked.txt")).unwrap(),
            "base\n"
        );
        assert_eq!(
            fs::read_to_string(f.repo.join("tracked.txt")).unwrap(),
            "later\n"
        );
        clean(&f, &prepared);
        f.remove();
    }

    #[test]
    fn custom_root_models_cross_volume_without_manual_move() {
        let f = Fixture::new();
        let prepared = f
            .controller
            .prepare("cross", 4, &f.automation("new_per_run"), &f.repo)
            .unwrap();
        assert!(Path::new(&prepared.worktree.path).starts_with(&f.storage));
        assert!(!Path::new(&prepared.worktree.path).starts_with(f.controller.manager.root()));
        clean(&f, &prepared);
        f.remove();
    }

    #[test]
    fn existing_mode_is_never_owned_or_deleted() {
        let f = Fixture::new();
        let prepared = f
            .controller
            .prepare("existing", 5, &f.automation("existing"), &f.repo)
            .unwrap();
        let outcome = f
            .controller
            .cleanup_if_safe(&prepared, CleanupReason::SetupUnavailable);
        assert!(!prepared.owned);
        assert_eq!(outcome.worktree.disposition, "retained");
        assert!(f.repo.is_dir());
        f.remove();
    }

    #[test]
    fn clean_worktree_is_removed_safely() {
        let f = Fixture::new();
        let prepared = f
            .controller
            .prepare("clean", 6, &f.automation("new_per_run"), &f.repo)
            .unwrap();
        let path = PathBuf::from(&prepared.worktree.path);
        clean(&f, &prepared);
        assert!(!path.exists());
        f.remove();
    }

    #[test]
    fn dirty_cancelled_worktree_is_retained() {
        let f = Fixture::new();
        let prepared = f
            .controller
            .prepare("dirty", 7, &f.automation("new_per_run"), &f.repo)
            .unwrap();
        fs::write(prepared.cwd.join("result.txt"), "keep\n").unwrap();
        let outcome = f
            .controller
            .cleanup_if_safe(&prepared, CleanupReason::Cancelled);
        assert_eq!(outcome.worktree.disposition, "retained");
        assert!(Path::new(&prepared.worktree.path).is_dir());
        fs::remove_file(prepared.cwd.join("result.txt")).unwrap();
        clean(&f, &prepared);
        f.remove();
    }

    #[test]
    fn locked_worktree_is_retained_for_shared_removal_flow() {
        let f = Fixture::new();
        let prepared = f
            .controller
            .prepare("locked", 8, &f.automation("new_per_run"), &f.repo)
            .unwrap();
        git(&f.repo, &["worktree", "lock", &prepared.worktree.path]);
        let outcome = f
            .controller
            .cleanup_if_safe(&prepared, CleanupReason::SetupUnavailable);
        assert_eq!(outcome.worktree.disposition, "retained");
        assert!(Path::new(&outcome.worktree.path).is_dir());
        assert!(outcome.error.is_none());
        git(&f.repo, &["worktree", "unlock", &prepared.worktree.path]);
        clean(&f, &prepared);
        f.remove();
    }

    #[test]
    fn validates_git_workspace_and_base_ref() {
        let f = Fixture::new();
        let non_git = f.root.join("not-git");
        fs::create_dir_all(&non_git).unwrap();
        assert!(f
            .controller
            .prepare("bad", 9, &f.automation("new_per_run"), &non_git)
            .is_err());
        let mut automation = f.automation("new_per_run");
        automation.base_ref = Some("--bad".into());
        assert!(f
            .controller
            .prepare("bad-ref", 10, &automation, &f.repo)
            .is_err());
        f.remove();
    }
}

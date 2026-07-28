use super::paths::validate_base_ref;
use super::worktree::{
    normalize_path_for_comparison, paths_equal, resolve_root, NativeWorktree, RepositoryIdentity,
};
use super::worktree_copy::{
    copy_regular_files, rollback_copy_journal, validate_linked_file_paths,
    validate_regular_file_sources, WorktreeCopyJournal,
};
use super::worktree_operation::{
    NativeWorktreeCommandRunner, WorktreeCancellation, WorktreeCommandFailure,
    WorktreeCommandOutput, WorktreeCommandRunner, WorktreeCommandSpec, GIT_FETCH_TIMEOUT,
    GIT_READ_TIMEOUT, GIT_SPARSE_TIMEOUT, GIT_WORKTREE_TIMEOUT, SETUP_TIMEOUT,
};
use super::worktree_registry::{
    WorktreeBlockerKind, WorktreeCreateRequest, WorktreeLifecycle, WorktreeMoveRequest,
    WorktreeOperationClaim, WorktreeRecord, WorktreeRegistry, WorktreeRemovalPreflightRequest,
    WorktreeRemovalResult, WorktreeRemoveRequest, WorktreeRuntimeBlockers,
};
use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCommandReport {
    pub stage: String,
    pub program: String,
    pub args: Vec<String>,
    pub output: WorktreeCommandOutput,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorktreeProgress {
    pub operation_id: Uuid,
    pub stage: String,
}

pub(crate) trait WorktreeProgressSink: Send + Sync {
    fn progress(&self, progress: WorktreeProgress);
}

#[derive(Default)]
struct NoopProgressSink;
impl WorktreeProgressSink for NoopProgressSink {
    fn progress(&self, _progress: WorktreeProgress) {}
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeSetupCommand {
    pub program: String,
    pub args: Vec<String>,
}

pub(crate) trait WorktreeProvisioningResolver: Send + Sync {
    fn resolve_sparse_preset(&self, repository: &Path, preset_id: &str) -> Result<Vec<String>>;
    fn resolve_setup_command(
        &self,
        repository: &Path,
        setup_policy: &str,
    ) -> Result<Option<WorktreeSetupCommand>>;
}

const MAX_WORKTREE_POLICY_BYTES: u64 = 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RepositoryWorktreePolicy {
    #[serde(default)]
    sparse_presets: BTreeMap<String, Vec<String>>,
}

#[derive(Default)]
struct NativeProvisioningResolver;
impl WorktreeProvisioningResolver for NativeProvisioningResolver {
    fn resolve_sparse_preset(&self, repository: &Path, preset_id: &str) -> Result<Vec<String>> {
        let preset_id = preset_id.trim();
        if preset_id.is_empty() {
            bail!("sparse preset id is empty");
        }
        let policy_dir = repository.join(".vibelink");
        let policy_path = policy_dir.join("worktree.json");
        let directory_metadata = std::fs::symlink_metadata(&policy_dir).with_context(|| {
            format!(
                "sparse preset {preset_id} requires {}",
                policy_path.display()
            )
        })?;
        if !directory_metadata.is_dir() || metadata_is_reparse(&directory_metadata) {
            bail!("worktree policy directory must be a regular directory");
        }
        let metadata = std::fs::symlink_metadata(&policy_path)
            .with_context(|| format!("read worktree policy metadata {}", policy_path.display()))?;
        if !metadata.is_file() || metadata_is_reparse(&metadata) {
            bail!("worktree policy must be a regular file");
        }
        if metadata.len() > MAX_WORKTREE_POLICY_BYTES {
            bail!("worktree policy exceeds the 1 MiB size limit");
        }
        let bytes = std::fs::read(&policy_path)
            .with_context(|| format!("read worktree policy {}", policy_path.display()))?;
        let policy: RepositoryWorktreePolicy = serde_json::from_slice(&bytes)
            .with_context(|| format!("parse worktree policy {}", policy_path.display()))?;
        policy
            .sparse_presets
            .get(preset_id)
            .cloned()
            .with_context(|| format!("unknown sparse preset: {preset_id}"))
    }

    fn resolve_setup_command(
        &self,
        repository: &Path,
        setup_policy: &str,
    ) -> Result<Option<WorktreeSetupCommand>> {
        validate_setup_policy(setup_policy)?;
        if setup_policy == "skip" {
            return Ok(None);
        }
        #[cfg(windows)]
        let (relative, command) = (
            PathBuf::from(".vibelink").join("setup.ps1"),
            WorktreeSetupCommand {
                program: "powershell.exe".into(),
                args: vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-ExecutionPolicy".into(),
                    "Bypass".into(),
                    "-File".into(),
                    ".vibelink/setup.ps1".into(),
                ],
            },
        );
        #[cfg(not(windows))]
        let (relative, command) = (
            PathBuf::from(".vibelink").join("setup.sh"),
            WorktreeSetupCommand {
                program: "sh".into(),
                args: vec![".vibelink/setup.sh".into()],
            },
        );
        let configured = repository.join(relative).is_file();
        if setup_policy == "run" && !configured {
            bail!("setup policy is 'run' but the repository has no configured setup command");
        }
        Ok(configured.then_some(command))
    }
}

fn metadata_is_reparse(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateResult {
    pub worktree: WorktreeRecord,
    pub session_id: String,
    pub base_sha: String,
    #[serde(default)]
    pub command_outputs: Vec<WorktreeCommandReport>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMoveResult {
    pub worktree: WorktreeRecord,
    pub previous_path: String,
}

#[derive(Clone)]
pub(crate) struct WorktreeLifecycleService {
    registry: Arc<WorktreeRegistry>,
    runner: Arc<dyn WorktreeCommandRunner>,
    resolver: Arc<dyn WorktreeProvisioningResolver>,
    progress: Arc<dyn WorktreeProgressSink>,
}

impl WorktreeLifecycleService {
    pub fn native(registry: Arc<WorktreeRegistry>) -> Self {
        Self {
            registry,
            runner: Arc::new(NativeWorktreeCommandRunner::default()),
            resolver: Arc::new(NativeProvisioningResolver),
            progress: Arc::new(NoopProgressSink),
        }
    }

    #[cfg(test)]
    fn with_components(
        registry: Arc<WorktreeRegistry>,
        runner: Arc<dyn WorktreeCommandRunner>,
        resolver: Arc<dyn WorktreeProvisioningResolver>,
        progress: Arc<dyn WorktreeProgressSink>,
    ) -> Self {
        Self {
            registry,
            runner,
            resolver,
            progress,
        }
    }

    pub fn create<F, R>(
        &self,
        request: WorktreeCreateRequest,
        create_session: F,
        remove_session: R,
    ) -> Result<WorktreeCreateResult>
    where
        F: FnOnce(&WorktreeRecord) -> Result<String>,
        R: FnOnce(&str) -> Result<()>,
    {
        let operation_id = request.operation_id;
        let cancellation =
            WorktreeCancellation::from_flag(self.registry.cancellation_flag(operation_id));
        let result = self.create_cancellable(request, cancellation, create_session, remove_session);
        self.registry.clear_cancellation(operation_id);
        result
    }

    pub(crate) fn create_cancellable<F, R>(
        &self,
        request: WorktreeCreateRequest,
        cancellation: WorktreeCancellation,
        create_session: F,
        remove_session: R,
    ) -> Result<WorktreeCreateResult>
    where
        F: FnOnce(&WorktreeRecord) -> Result<String>,
        R: FnOnce(&str) -> Result<()>,
    {
        validate_operation_id(request.operation_id)?;
        match self
            .registry
            .claim_operation(request.operation_id, "create", &request)?
        {
            WorktreeOperationClaim::Replay {
                result_json: Some(result),
                error: None,
            } => return serde_json::from_str(&result).context("parse replayed create result"),
            WorktreeOperationClaim::Replay {
                error: Some(error), ..
            } => bail!(error),
            WorktreeOperationClaim::Replay { .. } => {
                bail!("worktree create operation is still running")
            }
            WorktreeOperationClaim::Claimed => {}
        }
        let result = self.create_claimed(&request, &cancellation, create_session, remove_session);
        match &result {
            Ok(result) => self
                .registry
                .complete_operation(request.operation_id, result)?,
            Err(error) => {
                let stage = if error_is_cancelled(error) {
                    "cancelled"
                } else {
                    "failed"
                };
                self.registry
                    .fail_operation(request.operation_id, stage, &error.to_string())?;
                self.progress.progress(WorktreeProgress {
                    operation_id: request.operation_id,
                    stage: stage.into(),
                });
            }
        }
        result
    }

    fn create_claimed<F, R>(
        &self,
        request: &WorktreeCreateRequest,
        cancellation: &WorktreeCancellation,
        create_session: F,
        remove_session: R,
    ) -> Result<WorktreeCreateResult>
    where
        F: FnOnce(&WorktreeRecord) -> Result<String>,
        R: FnOnce(&str) -> Result<()>,
    {
        let mut reports = Vec::new();
        let mut journal = CreateJournal::default();
        let mut remove_session = Some(remove_session);
        let attempted = (|| -> Result<WorktreeCreateResult> {
            self.stage(request.operation_id, "validating", cancellation)?;
            let slug = slug_name(&request.name)?;
            validate_base_ref(&request.start_ref).context("validate worktree start ref")?;
            let base_branch = request
                .branch
                .clone()
                .unwrap_or_else(|| format!("vibelink/{slug}"));
            validate_setup_policy(&request.setup_policy)?;
            let linked_files = validate_linked_file_paths(&request.linked_files)?;
            let repository = self.resolve_repository(
                Path::new(&request.repository_path),
                cancellation,
                &mut reports,
            )?;
            journal.repository_path = Some(repository.repository_path.clone());
            validate_regular_file_sources(Path::new(&repository.repository_path), &linked_files)?;
            self.validate_branch_name(
                &repository.repository_path,
                &base_branch,
                cancellation,
                &mut reports,
            )?;
            let sparse_paths = request
                .sparse_preset
                .as_deref()
                .map(|preset| {
                    self.resolver
                        .resolve_sparse_preset(Path::new(&repository.repository_path), preset)
                        .and_then(validate_sparse_paths)
                })
                .transpose()?;
            let setup_command = self.resolver.resolve_setup_command(
                Path::new(&repository.repository_path),
                &request.setup_policy,
            )?;
            let resolution = resolve_root(
                &repository.repository_path,
                &request.storage,
                Some(&request.name),
            )?;
            let root = validate_absolute_traversal_free(PathBuf::from(resolution.root))?;

            if request.fetch {
                self.stage(request.operation_id, "fetching", cancellation)?;
                let remote = self.configured_remote(
                    &repository.repository_path,
                    cancellation,
                    &mut reports,
                )?;
                self.run_success(
                    "fetching",
                    WorktreeCommandSpec::git(
                        &repository.repository_path,
                        ["fetch", "--prune", remote.as_str()],
                        GIT_FETCH_TIMEOUT,
                        false,
                    ),
                    cancellation,
                    &mut reports,
                )?;
                cancellation.check().map_err(anyhow::Error::new)?;
            }

            let base_sha = self.resolve_creation_base(
                &repository.repository_path,
                &request.start_ref,
                cancellation,
                &mut reports,
            )?;
            journal.base_sha = Some(base_sha.clone());

            self.stage(request.operation_id, "creating", cancellation)?;
            let (managed_root, created_directories) = create_safe_directory_chain(&root)?;
            journal.created_directories = created_directories;
            let (destination, branch, snapshot) = self.create_collision_bounded(
                &repository,
                &managed_root,
                &slug,
                &base_branch,
                &base_sha,
                cancellation,
                &mut reports,
            )?;
            journal.branch = Some(branch.clone());
            journal.worktree_path = Some(destination.clone());
            journal.git_dir_identity = Some(snapshot.native.git_dir_identity.clone());
            cancellation.check().map_err(anyhow::Error::new)?;

            if !linked_files.is_empty() {
                self.stage(request.operation_id, "copying", cancellation)?;
                journal.copy = Some(copy_regular_files(
                    Path::new(&repository.repository_path),
                    &destination,
                    &linked_files,
                    cancellation,
                )?);
                cancellation.check().map_err(anyhow::Error::new)?;
            }

            if let Some(paths) = sparse_paths.as_ref() {
                self.stage(request.operation_id, "sparse", cancellation)?;
                self.run_success(
                    "sparse",
                    WorktreeCommandSpec::git(
                        &destination,
                        ["sparse-checkout", "init", "--cone"],
                        GIT_SPARSE_TIMEOUT,
                        false,
                    ),
                    cancellation,
                    &mut reports,
                )?;
                let mut args = vec!["sparse-checkout".into(), "set".into(), "--".into()];
                args.extend(paths.iter().cloned());
                self.run_success(
                    "sparse",
                    WorktreeCommandSpec::git(&destination, args, GIT_SPARSE_TIMEOUT, false),
                    cancellation,
                    &mut reports,
                )?;
                cancellation.check().map_err(anyhow::Error::new)?;
            }

            if let Some(setup) = setup_command {
                self.stage(request.operation_id, "setup", cancellation)?;
                self.run_success(
                    "setup",
                    WorktreeCommandSpec {
                        program: setup.program,
                        args: setup.args,
                        current_dir: destination.clone(),
                        timeout: SETUP_TIMEOUT,
                        read_only: false,
                    },
                    cancellation,
                    &mut reports,
                )?;
                cancellation.check().map_err(anyhow::Error::new)?;
            }

            let registered_snapshot =
                self.native_snapshot(&repository, &destination, cancellation, &mut reports)?;
            verify_created_snapshot(&registered_snapshot, &branch, &base_sha)?;
            let mut persisted_request = request.clone();
            persisted_request.start_ref.clone_from(&base_sha);
            let record = self.registry.register_created(
                &repository,
                &registered_snapshot.native,
                &persisted_request,
                None,
            )?;
            journal.record = Some((record.id.clone(), record.instance_id.clone()));

            self.stage(request.operation_id, "binding", cancellation)?;
            let session_id = create_session(&record)?;
            journal.session_id = Some(session_id.clone());
            let worktree =
                self.registry
                    .bind_session(&record.id, &record.instance_id, &session_id)?;
            cancellation.check().map_err(anyhow::Error::new)?;

            self.stage(request.operation_id, "launching", cancellation)?;
            let final_snapshot =
                self.native_snapshot(&repository, &destination, cancellation, &mut reports)?;
            verify_created_snapshot(&final_snapshot, &branch, &base_sha)?;
            if worktree.session_id.as_deref() != Some(session_id.as_str())
                || worktree.git_dir_identity != final_snapshot.native.git_dir_identity
                || !paths_equal(
                    &worktree.worktree_path,
                    &final_snapshot.native.worktree_path,
                )
            {
                bail!("created worktree identity or session binding changed before completion");
            }
            self.stage(request.operation_id, "complete", cancellation)?;
            Ok(WorktreeCreateResult {
                worktree,
                session_id,
                base_sha,
                command_outputs: reports.clone(),
            })
        })();

        match attempted {
            Ok(result) => Ok(result),
            Err(error) => {
                let _ = self.stage_without_cancellation(request.operation_id, "rolling_back");
                let retained = self.rollback_create(&journal, &mut remove_session, &mut reports);
                let mut message = error.to_string();
                if !retained.is_empty() {
                    message.push_str("; retained artifacts: ");
                    message.push_str(&retained.join(", "));
                    message.push_str("; recovery instruction: inspect the retained identity and remove it explicitly after preserving any work");
                }
                if error_is_cancelled(&error) {
                    Err(anyhow!(WorktreeCommandFailure::Cancelled {
                        output: WorktreeCommandOutput {
                            stderr_tail: message,
                            ..WorktreeCommandOutput::default()
                        }
                    }))
                } else {
                    bail!(message)
                }
            }
        }
    }

    pub fn move_checkout(&self, request: WorktreeMoveRequest) -> Result<WorktreeMoveResult> {
        validate_operation_id(request.operation_id)?;
        match self
            .registry
            .claim_operation(request.operation_id, "move", &request)?
        {
            WorktreeOperationClaim::Replay {
                result_json: Some(result),
                error: None,
            } => return serde_json::from_str(&result).context("parse replayed move result"),
            WorktreeOperationClaim::Replay {
                error: Some(error), ..
            } => bail!(error),
            WorktreeOperationClaim::Replay { .. } => {
                bail!("worktree move operation is still running")
            }
            WorktreeOperationClaim::Claimed => {}
        }
        let cancellation =
            WorktreeCancellation::from_flag(self.registry.cancellation_flag(request.operation_id));
        let result = self.move_claimed(&request, &cancellation);
        let persistence = match &result {
            Ok(result) => self
                .registry
                .complete_operation(request.operation_id, result),
            Err(error) => {
                self.registry
                    .fail_operation(request.operation_id, "failed", &error.to_string())
            }
        };
        self.registry.clear_cancellation(request.operation_id);
        persistence?;
        result
    }

    fn move_claimed(
        &self,
        request: &WorktreeMoveRequest,
        cancellation: &WorktreeCancellation,
    ) -> Result<WorktreeMoveResult> {
        let mut reports = Vec::new();
        let record = self.registry.read_record(&request.worktree_id)?;
        require_active_instance(&record, &request.expected_instance_id)?;
        let repository = self.resolve_repository(
            Path::new(&record.repository_path),
            cancellation,
            &mut reports,
        )?;
        let source = PathBuf::from(&record.worktree_path);
        let source_snapshot =
            self.native_snapshot(&repository, &source, cancellation, &mut reports)?;
        verify_record_snapshot(&record, &repository, &source_snapshot)?;
        if source_snapshot.native.is_main {
            bail!("the main checkout cannot be moved by the managed lifecycle");
        }
        let managed_root = git_compatible_path(
            &source
                .parent()
                .context("managed worktree path has no storage root")?
                .canonicalize()
                .context("canonicalize managed worktree root")?,
        );
        let destination =
            validate_move_destination(PathBuf::from(&request.destination_path), &managed_root)?;
        let parent = destination
            .parent()
            .context("worktree destination has no parent")?;
        let (canonical_parent, created_directories) = create_safe_directory_chain(parent)?;
        if canonical_parent != managed_root && !canonical_parent.starts_with(&managed_root) {
            rollback_empty_directories(&created_directories);
            bail!("worktree destination must remain inside the selected managed root");
        }
        let destination = canonical_parent.join(
            destination
                .file_name()
                .context("worktree destination has no leaf name")?,
        );
        if std::fs::symlink_metadata(&destination).is_ok() {
            rollback_empty_directories(&created_directories);
            bail!("worktree destination already exists");
        }

        self.stage(request.operation_id, "moving", cancellation)?;
        self.run_success(
            "moving",
            WorktreeCommandSpec::git(
                &repository.repository_path,
                vec![
                    "worktree".into(),
                    "move".into(),
                    source.to_string_lossy().to_string(),
                    destination.to_string_lossy().to_string(),
                ],
                GIT_WORKTREE_TIMEOUT,
                false,
            ),
            cancellation,
            &mut reports,
        )?;
        let update = (|| -> Result<WorktreeRecord> {
            let moved_snapshot =
                self.native_snapshot(&repository, &destination, cancellation, &mut reports)?;
            verify_move_snapshot(&source_snapshot, &moved_snapshot)?;
            self.registry.compare_and_swap_path(
                &record.id,
                &record.instance_id,
                &record.worktree_path,
                &moved_snapshot.native,
            )
        })();
        let updated = match update {
            Ok(updated) => updated,
            Err(move_error) => {
                let cleanup_cancellation = WorktreeCancellation::default();
                let rollback = self.run_success(
                    "rolling_back",
                    WorktreeCommandSpec::git(
                        &repository.repository_path,
                        vec![
                            "worktree".into(),
                            "move".into(),
                            destination.to_string_lossy().to_string(),
                            source.to_string_lossy().to_string(),
                        ],
                        GIT_WORKTREE_TIMEOUT,
                        false,
                    ),
                    &cleanup_cancellation,
                    &mut reports,
                );
                if let Err(rollback_error) = rollback {
                    bail!(
                        "{move_error}; move-back failed: {rollback_error}; retained path: {}",
                        destination.display()
                    );
                }
                let rollback_identity = self
                    .native_snapshot(&repository, &source, &cleanup_cancellation, &mut reports)
                    .and_then(|snapshot| verify_move_snapshot(&source_snapshot, &snapshot));
                if let Err(identity_error) = rollback_identity {
                    bail!(
                        "{move_error}; move-back identity validation failed: {identity_error}; retained path: {}",
                        source.display()
                    );
                }
                rollback_empty_directories(&created_directories);
                return Err(move_error);
            }
        };
        Ok(WorktreeMoveResult {
            worktree: updated,
            previous_path: record.worktree_path,
        })
    }

    pub(crate) fn remove<C, F>(
        &self,
        request: WorktreeRemoveRequest,
        runtime: WorktreeRuntimeBlockers,
        cleanup_resources: C,
        finalize_session: F,
    ) -> Result<WorktreeRemovalResult>
    where
        C: FnOnce(&WorktreeRecord) -> Result<()>,
        F: FnOnce(&str) -> Result<bool>,
    {
        validate_operation_id(request.operation_id)?;
        match self
            .registry
            .claim_operation(request.operation_id, "remove", &request)?
        {
            WorktreeOperationClaim::Replay {
                result_json: Some(result),
                error: None,
            } => return serde_json::from_str(&result).context("parse replayed remove result"),
            WorktreeOperationClaim::Replay {
                error: Some(error), ..
            } => bail!(error),
            WorktreeOperationClaim::Replay { .. } => {
                bail!("worktree remove operation is still running")
            }
            WorktreeOperationClaim::Claimed => {}
        }
        let cancellation =
            WorktreeCancellation::from_flag(self.registry.cancellation_flag(request.operation_id));
        let result = self.remove_claimed(
            &request,
            runtime,
            &cancellation,
            cleanup_resources,
            finalize_session,
        );
        let persistence = match &result {
            Ok(result) => self
                .registry
                .complete_operation(request.operation_id, result),
            Err(error) => {
                self.registry
                    .fail_operation(request.operation_id, "failed", &error.to_string())
            }
        };
        self.registry.clear_cancellation(request.operation_id);
        persistence?;
        result
    }

    fn remove_claimed<C, F>(
        &self,
        request: &WorktreeRemoveRequest,
        runtime: WorktreeRuntimeBlockers,
        cancellation: &WorktreeCancellation,
        cleanup_resources: C,
        finalize_session: F,
    ) -> Result<WorktreeRemovalResult>
    where
        C: FnOnce(&WorktreeRecord) -> Result<()>,
        F: FnOnce(&str) -> Result<bool>,
    {
        let mut reports = Vec::new();
        self.stage(request.operation_id, "validating", cancellation)?;
        let preflight = self.registry.removal_preflight(
            &WorktreeRemovalPreflightRequest {
                worktree_id: request.worktree_id.clone(),
                delete_branch: request.delete_branch,
            },
            runtime,
        )?;
        self.registry
            .validate_removal_request(request, &preflight)?;
        let record = self
            .registry
            .prepare_removal(&request.worktree_id, &request.expected_instance_id)?;
        let attempted = (|| -> Result<WorktreeRemovalResult> {
            self.stage(request.operation_id, "cleaning", cancellation)?;
            cleanup_resources(&record)?;
            cancellation.check().map_err(anyhow::Error::new)?;

            let missing_registration = preflight
                .blockers
                .iter()
                .any(|blocker| blocker.kind == WorktreeBlockerKind::MissingRegistration)
                && matches!(
                    std::fs::symlink_metadata(&record.worktree_path),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound
                );
            if !missing_registration {
                let repository = self.resolve_repository(
                    Path::new(&record.repository_path),
                    cancellation,
                    &mut reports,
                )?;
                let snapshot = self.native_snapshot(
                    &repository,
                    Path::new(&record.worktree_path),
                    cancellation,
                    &mut reports,
                )?;
                verify_record_snapshot(&record, &repository, &snapshot)?;
                self.stage(request.operation_id, "removing", cancellation)?;
                let force_git = request.force
                    && preflight.blockers.iter().any(|blocker| {
                        matches!(
                            blocker.kind,
                            WorktreeBlockerKind::Dirty | WorktreeBlockerKind::Conflicted
                        ) && request.acknowledged_blockers.contains(&blocker.kind)
                    });
                let mut args = vec!["worktree".into(), "remove".into()];
                if force_git {
                    args.push("--force".into());
                }
                args.push(record.worktree_path.clone());
                self.run_success(
                    "removing",
                    WorktreeCommandSpec::git(
                        &record.repository_path,
                        args,
                        GIT_WORKTREE_TIMEOUT,
                        false,
                    ),
                    cancellation,
                    &mut reports,
                )?;
            }
            let mut branch_deleted = false;
            let mut branch_preserved_reason = None;
            if request.delete_branch && !record.branch.is_empty() {
                let current_head = self.resolve_commit(
                    &record.repository_path,
                    &format!("refs/heads/{}", record.branch),
                    cancellation,
                    &mut reports,
                )?;
                if current_head != record.head {
                    branch_preserved_reason = Some(
                        "branch changed after preflight; exact-head deletion was refused".into(),
                    );
                } else {
                    let safely_merged = self.branch_safely_merged(
                        &record.repository_path,
                        &record.branch,
                        &record.head,
                        cancellation,
                        &mut reports,
                    )?;
                    let force_delete = request.force
                        && request.provider_merged_head.as_deref() == Some(record.head.as_str());
                    if safely_merged || force_delete {
                        let delete_spec = WorktreeCommandSpec::git(
                            &record.repository_path,
                            vec![
                                "update-ref".into(),
                                "-d".into(),
                                format!("refs/heads/{}", record.branch),
                                record.head.clone(),
                            ],
                            GIT_READ_TIMEOUT,
                            false,
                        );
                        match self.runner.run(&delete_spec, cancellation) {
                            Ok(output) => {
                                reports.push(command_report("removing", &delete_spec, output));
                                branch_deleted = true;
                            }
                            Err(WorktreeCommandFailure::Exit { message, output }) => {
                                reports.push(command_report("removing", &delete_spec, output));
                                branch_preserved_reason = Some(bounded_text(&message));
                            }
                            Err(error) => return Err(anyhow!(error)),
                        }
                    } else {
                        branch_preserved_reason = Some(
                            "branch is not fully merged; safe exact-head deletion was refused"
                                .into(),
                        );
                    }
                }
            }

            let session_removed = record
                .session_id
                .as_deref()
                .map(finalize_session)
                .transpose()?
                .unwrap_or(false);
            self.registry
                .finalize_removal(&record.id, &record.instance_id)?;
            Ok(WorktreeRemovalResult {
                checkout_removed: true,
                branch_deleted,
                branch_preserved_reason,
                session_removed,
                metadata_removed: true,
            })
        })();
        match attempted {
            Ok(result) => Ok(result),
            Err(error) => match self.registry.abort_removal(&record.id, &record.instance_id) {
                Ok(()) => Err(error),
                Err(abort_error) => {
                    bail!("{error}; failed to abort removal lifecycle: {abort_error}")
                }
            },
        }
    }

    fn rollback_create<R>(
        &self,
        journal: &CreateJournal,
        remove_session: &mut Option<R>,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Vec<String>
    where
        R: FnOnce(&str) -> Result<()>,
    {
        let cancellation = WorktreeCancellation::default();
        let mut retained = Vec::new();
        if let Some(session_id) = journal.session_id.as_deref() {
            if remove_session
                .take()
                .map(|remove| remove(session_id))
                .transpose()
                .is_err()
            {
                retained.push(format!("session:{session_id}"));
            }
        }
        if let Some((worktree_id, instance_id)) = journal.record.as_ref() {
            if !self
                .registry
                .remove_metadata_if_instance(worktree_id, instance_id)
                .unwrap_or(false)
            {
                retained.push(format!("metadata:{worktree_id}/{instance_id}"));
            }
        }

        if let (Some(repository), Some(path), Some(expected_identity)) = (
            journal.repository_path.as_deref(),
            journal.worktree_path.as_deref(),
            journal.git_dir_identity.as_deref(),
        ) {
            let exact = self
                .resolve_repository(Path::new(repository), &cancellation, reports)
                .and_then(|identity| self.native_snapshot(&identity, path, &cancellation, reports));
            let proven = exact
                .as_ref()
                .map(|snapshot| snapshot.native.git_dir_identity.as_str() == expected_identity)
                .unwrap_or(false);
            if proven {
                let remove = self.run_success(
                    "rolling_back",
                    WorktreeCommandSpec::git(
                        repository,
                        vec![
                            "worktree".into(),
                            "remove".into(),
                            "--force".into(),
                            path.to_string_lossy().to_string(),
                        ],
                        GIT_WORKTREE_TIMEOUT,
                        false,
                    ),
                    &cancellation,
                    reports,
                );
                if remove.is_err() {
                    retained.push(format!("path:{}", path.display()));
                }
            } else {
                retained.push(format!("path:{}", path.display()));
                if let Some(copy) = journal.copy.as_ref() {
                    rollback_copy_journal(copy);
                }
            }
        }

        if let (Some(repository), Some(branch), Some(base_sha)) = (
            journal.repository_path.as_deref(),
            journal.branch.as_deref(),
            journal.base_sha.as_deref(),
        ) {
            let current = self
                .resolve_commit(
                    repository,
                    &format!("refs/heads/{branch}"),
                    &cancellation,
                    reports,
                )
                .ok();
            if current.as_deref() == Some(base_sha) {
                if self
                    .run_success(
                        "rolling_back",
                        WorktreeCommandSpec::git(
                            repository,
                            vec![
                                "update-ref".into(),
                                "-d".into(),
                                format!("refs/heads/{branch}"),
                                base_sha.to_string(),
                            ],
                            GIT_READ_TIMEOUT,
                            false,
                        ),
                        &cancellation,
                        reports,
                    )
                    .is_err()
                {
                    retained.push(format!("branch:{branch}"));
                }
            } else if current.is_some() {
                retained.push(format!("branch:{branch}"));
            }
        }
        rollback_empty_directories(&journal.created_directories);
        retained
    }

    fn create_collision_bounded(
        &self,
        repository: &RepositoryIdentity,
        root: &Path,
        slug: &str,
        base_branch: &str,
        base_sha: &str,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<(PathBuf, String, NativeSnapshot)> {
        for number in 1..=25 {
            cancellation.check().map_err(anyhow::Error::new)?;
            let suffix = if number == 1 {
                String::new()
            } else {
                format!("-{number}")
            };
            let branch = format!("{base_branch}{suffix}");
            self.validate_branch_name(&repository.repository_path, &branch, cancellation, reports)?;
            let destination = root.join(format!("{slug}{suffix}"));
            match std::fs::symlink_metadata(&destination) {
                Ok(_) => continue,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    return Err(error).with_context(|| {
                        format!("inspect worktree destination {}", destination.display())
                    })
                }
            }
            if self.branch_exists(&repository.repository_path, &branch, cancellation, reports)? {
                continue;
            }
            let spec = WorktreeCommandSpec::git(
                &repository.repository_path,
                vec![
                    "worktree".into(),
                    "add".into(),
                    "--no-track".into(),
                    "-b".into(),
                    branch.clone(),
                    destination.to_string_lossy().to_string(),
                    base_sha.to_string(),
                ],
                GIT_WORKTREE_TIMEOUT,
                false,
            );
            match self.runner.run(&spec, cancellation) {
                Ok(output) => {
                    reports.push(command_report("creating", &spec, output));
                    let snapshot = self.native_snapshot(
                        repository,
                        &destination,
                        &WorktreeCancellation::default(),
                        reports,
                    );
                    match snapshot {
                        Ok(snapshot) => return Ok((destination, branch, snapshot)),
                        Err(error) => bail!(
                            "worktree add succeeded but identity could not be proven: {error}; retained artifacts: path:{}, branch:{}; recovery instruction: inspect the retained Git worktree identity before explicit cleanup",
                            destination.display(),
                            branch
                        ),
                    }
                }
                Err(error) if is_collision_failure(&error) => continue,
                Err(error) => return Err(anyhow!(error).context("create Git worktree")),
            }
        }
        bail!("worktree name and branch collided for every candidate from the base name through suffix -25")
    }

    fn resolve_repository(
        &self,
        repository: &Path,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<RepositoryIdentity> {
        let top = self.run_success(
            "validating",
            WorktreeCommandSpec::git(
                repository,
                ["rev-parse", "--show-toplevel"],
                GIT_READ_TIMEOUT,
                true,
            ),
            cancellation,
            reports,
        )?;
        let top = resolve_git_path(repository, &output_text(&top, "repository top level")?)
            .canonicalize()
            .context("canonicalize repository top level")?;
        let common = self.run_success(
            "validating",
            WorktreeCommandSpec::git(
                &top,
                ["rev-parse", "--git-common-dir"],
                GIT_READ_TIMEOUT,
                true,
            ),
            cancellation,
            reports,
        )?;
        let common = resolve_git_path(&top, &output_text(&common, "repository common directory")?)
            .canonicalize()
            .context("canonicalize repository common directory")?;
        let normalized_common_dir = normalize_path_for_comparison(&common.to_string_lossy());
        Ok(RepositoryIdentity {
            repository_id: digest_hex(normalized_common_dir.as_bytes()),
            repository_path: top.to_string_lossy().to_string(),
            common_dir: common.to_string_lossy().to_string(),
            normalized_common_dir,
        })
    }

    fn resolve_creation_base(
        &self,
        repository: &str,
        start_ref: &str,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<String> {
        if start_ref != "HEAD" {
            return self.resolve_commit(repository, start_ref, cancellation, reports);
        }
        let spec = WorktreeCommandSpec::git(
            repository,
            ["stash", "create", "vibelink worktree base snapshot"],
            GIT_READ_TIMEOUT,
            false,
        );
        let output = self.run_success("validating", spec, cancellation, reports)?;
        let snapshot = output.stdout_tail.trim();
        if snapshot.is_empty() {
            self.resolve_commit(repository, "HEAD", cancellation, reports)
        } else if output.stdout_truncated
            || snapshot.len() < 40
            || !snapshot
                .chars()
                .all(|character| character.is_ascii_hexdigit())
        {
            bail!("Git returned an invalid dirty worktree base snapshot")
        } else {
            Ok(snapshot.to_ascii_lowercase())
        }
    }

    fn resolve_commit(
        &self,
        repository: &str,
        start_ref: &str,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<String> {
        let commit_ref = format!("{start_ref}^{{commit}}");
        let output = self.run_success(
            "validating",
            WorktreeCommandSpec::git(
                repository,
                ["rev-parse", "--verify", "--quiet", commit_ref.as_str()],
                GIT_READ_TIMEOUT,
                true,
            ),
            cancellation,
            reports,
        )?;
        let sha = output_text(&output, "resolved worktree base SHA")?;
        if sha.len() < 40 || !sha.chars().all(|character| character.is_ascii_hexdigit()) {
            bail!("Git returned an invalid exact base SHA");
        }
        Ok(sha.to_ascii_lowercase())
    }

    fn configured_remote(
        &self,
        repository: &str,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<String> {
        let remotes = self.run_success(
            "validating",
            WorktreeCommandSpec::git(repository, ["remote"], GIT_READ_TIMEOUT, true),
            cancellation,
            reports,
        )?;
        let remotes = remotes
            .stdout_tail
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>();
        if remotes.is_empty() {
            bail!("fetch was requested but the repository has no configured remote");
        }
        let spec = WorktreeCommandSpec::git(
            repository,
            ["config", "--get", "remote.pushDefault"],
            GIT_READ_TIMEOUT,
            true,
        );
        let preferred = match self.runner.run(&spec, cancellation) {
            Ok(output) => {
                reports.push(command_report("validating", &spec, output.clone()));
                Some(output_text(&output, "configured fetch remote")?)
            }
            Err(WorktreeCommandFailure::Exit { output, .. }) if output.exit_code == Some(1) => {
                reports.push(command_report("validating", &spec, output));
                None
            }
            Err(error) => return Err(anyhow!(error)),
        };
        if let Some(preferred) = preferred {
            if remotes.contains(&preferred) {
                return Ok(preferred);
            }
            bail!("configured remote does not exist: {preferred}");
        }
        Ok(if remotes.iter().any(|remote| remote == "origin") {
            "origin".into()
        } else {
            remotes[0].clone()
        })
    }

    fn validate_branch_name(
        &self,
        repository: &str,
        branch: &str,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<()> {
        if branch.trim().is_empty() || branch.starts_with('-') || branch.contains('\0') {
            bail!("worktree branch is empty or unsafe");
        }
        self.run_success(
            "validating",
            WorktreeCommandSpec::git(
                repository,
                ["check-ref-format", "--branch", branch],
                GIT_READ_TIMEOUT,
                true,
            ),
            cancellation,
            reports,
        )?;
        Ok(())
    }

    fn branch_safely_merged(
        &self,
        repository: &str,
        branch: &str,
        branch_head: &str,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<bool> {
        let upstream_spec = WorktreeCommandSpec::git(
            repository,
            vec![
                "for-each-ref".into(),
                "--format=%(upstream)".into(),
                format!("refs/heads/{branch}"),
            ],
            GIT_READ_TIMEOUT,
            true,
        );
        let upstream_output = self.run_success("removing", upstream_spec, cancellation, reports)?;
        if upstream_output.stdout_truncated {
            bail!("branch upstream exceeded the bounded command output limit");
        }
        let target = upstream_output.stdout_tail.trim();
        let target = if target.is_empty() { "HEAD" } else { target };
        let target_head = self.resolve_commit(repository, target, cancellation, reports)?;
        let merge_spec = WorktreeCommandSpec::git(
            repository,
            [
                "merge-base",
                "--is-ancestor",
                branch_head,
                target_head.as_str(),
            ],
            GIT_READ_TIMEOUT,
            true,
        );
        match self.runner.run(&merge_spec, cancellation) {
            Ok(output) => {
                reports.push(command_report("removing", &merge_spec, output));
                Ok(true)
            }
            Err(WorktreeCommandFailure::Exit { output, .. }) if output.exit_code == Some(1) => {
                reports.push(command_report("removing", &merge_spec, output));
                Ok(false)
            }
            Err(error) => Err(anyhow!(error)),
        }
    }

    fn branch_exists(
        &self,
        repository: &str,
        branch: &str,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<bool> {
        let spec = WorktreeCommandSpec::git(
            repository,
            vec![
                "show-ref".into(),
                "--verify".into(),
                "--quiet".into(),
                format!("refs/heads/{branch}"),
            ],
            GIT_READ_TIMEOUT,
            true,
        );
        match self.runner.run(&spec, cancellation) {
            Ok(output) => {
                reports.push(command_report("creating", &spec, output));
                Ok(true)
            }
            Err(WorktreeCommandFailure::Exit { output, .. }) if output.exit_code == Some(1) => {
                reports.push(command_report("creating", &spec, output));
                Ok(false)
            }
            Err(error) => Err(anyhow!(error)),
        }
    }

    fn native_snapshot(
        &self,
        repository: &RepositoryIdentity,
        path: &Path,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<NativeSnapshot> {
        let metadata = std::fs::symlink_metadata(path)
            .with_context(|| format!("inspect worktree path {}", path.display()))?;
        if !metadata.is_dir() || is_link_or_reparse(&metadata) {
            bail!(
                "worktree path is not a regular directory: {}",
                path.display()
            );
        }
        let path = path
            .canonicalize()
            .with_context(|| format!("canonicalize worktree path {}", path.display()))?;
        let head = self.resolve_commit(&path.to_string_lossy(), "HEAD", cancellation, reports)?;
        let git_dir = self.run_success(
            "validating",
            WorktreeCommandSpec::git(&path, ["rev-parse", "--git-dir"], GIT_READ_TIMEOUT, true),
            cancellation,
            reports,
        )?;
        let git_dir = resolve_git_path(&path, &output_text(&git_dir, "worktree git directory")?)
            .canonicalize()
            .context("canonicalize worktree git directory")?;
        let git_dir_identity =
            digest_hex(normalize_path_for_comparison(&git_dir.to_string_lossy()).as_bytes());
        let common = self.run_success(
            "validating",
            WorktreeCommandSpec::git(
                &path,
                ["rev-parse", "--git-common-dir"],
                GIT_READ_TIMEOUT,
                true,
            ),
            cancellation,
            reports,
        )?;
        let common = resolve_git_path(&path, &output_text(&common, "worktree common directory")?)
            .canonicalize()
            .context("canonicalize worktree common directory")?;
        let normalized_common_dir = normalize_path_for_comparison(&common.to_string_lossy());
        let branch_spec = WorktreeCommandSpec::git(
            &path,
            ["symbolic-ref", "--quiet", "--short", "HEAD"],
            GIT_READ_TIMEOUT,
            true,
        );
        let (branch, detached) = match self.runner.run(&branch_spec, cancellation) {
            Ok(output) => {
                reports.push(command_report("validating", &branch_spec, output.clone()));
                (Some(output_text(&output, "worktree branch")?), false)
            }
            Err(WorktreeCommandFailure::Exit { output, .. }) if output.exit_code == Some(1) => {
                reports.push(command_report("validating", &branch_spec, output));
                (None, true)
            }
            Err(error) => return Err(anyhow!(error)),
        };
        let status = self.run_success(
            "validating",
            WorktreeCommandSpec::git(
                &path,
                [
                    "status",
                    "--porcelain=v2",
                    "-z",
                    "--branch",
                    "--untracked-files=all",
                ],
                GIT_READ_TIMEOUT,
                true,
            ),
            cancellation,
            reports,
        )?;
        let (mut dirty, mut untracked, mut conflicts, ahead, behind) =
            parse_status_summary(status.stdout_tail.as_bytes());
        if status.stdout_truncated {
            dirty = true;
            untracked = true;
            conflicts = true;
        }
        Ok(NativeSnapshot {
            normalized_common_dir,
            native: NativeWorktree {
                worktree_path: path.to_string_lossy().to_string(),
                normalized_path: normalize_path_for_comparison(&path.to_string_lossy()),
                git_dir_identity,
                head,
                branch,
                detached,
                bare: false,
                locked: false,
                lock_reason: None,
                prunable: false,
                prunable_reason: None,
                exists: true,
                is_main: paths_equal(&path.to_string_lossy(), &repository.repository_path),
                dirty,
                untracked,
                has_conflicts: conflicts,
                ahead,
                behind,
            },
        })
    }

    fn run_success(
        &self,
        stage: &str,
        spec: WorktreeCommandSpec,
        cancellation: &WorktreeCancellation,
        reports: &mut Vec<WorktreeCommandReport>,
    ) -> Result<WorktreeCommandOutput> {
        match self.runner.run(&spec, cancellation) {
            Ok(output) => {
                reports.push(command_report(stage, &spec, output.clone()));
                Ok(output)
            }
            Err(error) => {
                if let Some(output) = error.output() {
                    reports.push(command_report(stage, &spec, output.clone()));
                }
                Err(anyhow!(error))
            }
        }
    }

    fn stage(
        &self,
        operation_id: Uuid,
        stage: &str,
        cancellation: &WorktreeCancellation,
    ) -> Result<()> {
        cancellation.check().map_err(anyhow::Error::new)?;
        self.stage_without_cancellation(operation_id, stage)?;
        cancellation.check().map_err(anyhow::Error::new)
    }

    fn stage_without_cancellation(&self, operation_id: Uuid, stage: &str) -> Result<()> {
        self.registry.operation_stage(operation_id, stage)?;
        self.progress.progress(WorktreeProgress {
            operation_id,
            stage: stage.into(),
        });
        Ok(())
    }
}

#[derive(Default)]
struct CreateJournal {
    repository_path: Option<String>,
    worktree_path: Option<PathBuf>,
    git_dir_identity: Option<String>,
    branch: Option<String>,
    base_sha: Option<String>,
    record: Option<(String, String)>,
    session_id: Option<String>,
    copy: Option<WorktreeCopyJournal>,
    created_directories: Vec<PathBuf>,
}

#[derive(Clone, Debug)]
struct NativeSnapshot {
    normalized_common_dir: String,
    native: NativeWorktree,
}

fn validate_setup_policy(policy: &str) -> Result<()> {
    if matches!(policy, "run" | "skip" | "inherit") {
        Ok(())
    } else {
        bail!("invalid setup policy: {policy}")
    }
}

fn validate_sparse_paths(paths: Vec<String>) -> Result<Vec<String>> {
    if paths.is_empty() {
        bail!("sparse preset resolved to no paths");
    }
    let mut normalized = Vec::with_capacity(paths.len());
    let mut seen = HashSet::new();
    for path in paths {
        let relative = PathBuf::from(path.trim());
        if relative.as_os_str().is_empty()
            || relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            bail!("sparse preset paths must be contained repository-relative paths");
        }
        let value = relative.to_string_lossy().replace('\\', "/");
        if seen.insert(value.clone()) {
            normalized.push(value);
        }
    }
    Ok(normalized)
}

fn slug_name(name: &str) -> Result<String> {
    let mut slug = String::new();
    let mut separated = false;
    for character in name.chars() {
        if character.is_alphanumeric() {
            slug.extend(character.to_lowercase());
            separated = false;
        } else if !slug.is_empty() && !separated {
            slug.push('-');
            separated = true;
        }
    }
    while slug.ends_with('-') {
        slug.pop();
    }
    if slug.is_empty() {
        bail!("worktree name must contain a Unicode letter or number");
    }
    Ok(slug)
}

fn validate_absolute_traversal_free(path: PathBuf) -> Result<PathBuf> {
    if !path.is_absolute() {
        bail!("worktree path must be absolute");
    }
    if path
        .components()
        .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
    {
        bail!("worktree path must not contain traversal components");
    }
    Ok(path)
}

#[cfg(windows)]
fn git_compatible_path(path: &Path) -> PathBuf {
    let rendered = path.to_string_lossy();
    if let Some(tail) = rendered.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{tail}"))
    } else if let Some(tail) = rendered.strip_prefix(r"\\?\") {
        PathBuf::from(tail)
    } else {
        path.to_path_buf()
    }
}

#[cfg(not(windows))]
fn git_compatible_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}

fn create_safe_directory_chain(path: &Path) -> Result<(PathBuf, Vec<PathBuf>)> {
    let path = validate_absolute_traversal_free(path.to_path_buf())?;
    let mut missing = Vec::new();
    let mut current = path.as_path();
    let ancestor = loop {
        match std::fs::symlink_metadata(current) {
            Ok(metadata) => {
                if !metadata.is_dir() || is_link_or_reparse(&metadata) {
                    bail!(
                        "managed root crosses a symlink, reparse point, or non-directory: {}",
                        current.display()
                    );
                }
                break current.canonicalize()?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing.push(current.to_path_buf());
                current = current
                    .parent()
                    .context("managed root has no existing ancestor")?;
            }
            Err(error) => return Err(error).context("inspect managed root"),
        }
    };
    let mut created = Vec::new();
    for directory in missing.iter().rev() {
        std::fs::create_dir(directory)
            .with_context(|| format!("create managed root directory {}", directory.display()))?;
        let metadata = std::fs::symlink_metadata(directory)?;
        let canonical = directory.canonicalize()?;
        if !metadata.is_dir()
            || is_link_or_reparse(&metadata)
            || (canonical != ancestor && !canonical.starts_with(&ancestor))
        {
            rollback_empty_directories(&created);
            bail!("created managed root directory became unsafe");
        }
        created.push(canonical);
    }
    Ok((git_compatible_path(&path.canonicalize()?), created))
}

fn validate_move_destination(destination: PathBuf, managed_root: &Path) -> Result<PathBuf> {
    let destination = validate_absolute_traversal_free(destination)?;
    match std::fs::symlink_metadata(&destination) {
        Ok(_) => bail!("worktree destination already exists"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("inspect worktree destination"),
    }
    let ancestor = nearest_existing_ancestor(&destination)
        .context("worktree destination has no existing ancestor")?;
    let metadata = std::fs::symlink_metadata(&ancestor)?;
    if !metadata.is_dir() || is_link_or_reparse(&metadata) {
        bail!("worktree destination ancestor is unsafe");
    }
    let ancestor = git_compatible_path(&ancestor.canonicalize()?);
    if ancestor != managed_root && !ancestor.starts_with(managed_root) {
        bail!("worktree destination must remain inside the selected managed root");
    }
    Ok(destination)
}

fn nearest_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(candidate) = current {
        if std::fs::symlink_metadata(candidate).is_ok() {
            return Some(candidate.to_path_buf());
        }
        current = candidate.parent();
    }
    None
}

fn verify_created_snapshot(snapshot: &NativeSnapshot, branch: &str, base_sha: &str) -> Result<()> {
    if snapshot.native.git_dir_identity.is_empty()
        || snapshot.native.head != base_sha
        || snapshot.native.branch.as_deref() != Some(branch)
        || snapshot.native.detached
        || snapshot.native.bare
        || !snapshot.native.exists
    {
        bail!("created worktree failed final native identity validation");
    }
    Ok(())
}

fn verify_record_snapshot(
    record: &WorktreeRecord,
    repository: &RepositoryIdentity,
    snapshot: &NativeSnapshot,
) -> Result<()> {
    if record.repository_id != repository.repository_id
        || snapshot.normalized_common_dir != repository.normalized_common_dir
        || record.normalized_worktree_path != snapshot.native.normalized_path
        || record.git_dir_identity != snapshot.native.git_dir_identity
        || record.head != snapshot.native.head
        || (!record.branch.is_empty()
            && snapshot.native.branch.as_deref() != Some(record.branch.as_str()))
    {
        bail!("worktree native identity changed");
    }
    Ok(())
}

fn verify_move_snapshot(source: &NativeSnapshot, destination: &NativeSnapshot) -> Result<()> {
    if source.normalized_common_dir != destination.normalized_common_dir
        || source.native.git_dir_identity != destination.native.git_dir_identity
        || source.native.head != destination.native.head
        || source.native.branch != destination.native.branch
    {
        bail!("moved worktree identity changed");
    }
    Ok(())
}

fn require_active_instance(record: &WorktreeRecord, expected_instance_id: &str) -> Result<()> {
    if record.instance_id != expected_instance_id {
        bail!("worktree instance changed");
    }
    if record.lifecycle != WorktreeLifecycle::Active || !record.exists {
        bail!("worktree must be an active managed checkout");
    }
    Ok(())
}

fn output_text(output: &WorktreeCommandOutput, label: &str) -> Result<String> {
    if output.stdout_truncated {
        bail!("{label} exceeded the bounded command output limit");
    }
    let value = output.stdout_tail.trim();
    if value.is_empty() {
        bail!("{label} was empty");
    }
    Ok(value.to_string())
}

fn resolve_git_path(base: &Path, value: &str) -> PathBuf {
    let path = PathBuf::from(value);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn parse_status_summary(bytes: &[u8]) -> (bool, bool, bool, u64, u64) {
    let mut dirty = false;
    let mut untracked = false;
    let mut conflicts = false;
    let mut ahead = 0;
    let mut behind = 0;
    for entry in bytes.split(|byte| *byte == 0) {
        if entry.starts_with(b"? ") {
            untracked = true;
        } else if entry.starts_with(b"u ") {
            dirty = true;
            conflicts = true;
        } else if entry.starts_with(b"1 ") || entry.starts_with(b"2 ") {
            dirty = true;
        } else if let Some(value) = entry.strip_prefix(b"# branch.ab ") {
            for field in String::from_utf8_lossy(value).split_whitespace() {
                if let Some(value) = field.strip_prefix('+') {
                    ahead = value.parse().unwrap_or(0);
                } else if let Some(value) = field.strip_prefix('-') {
                    behind = value.parse().unwrap_or(0);
                }
            }
        }
    }
    (dirty, untracked, conflicts, ahead, behind)
}

fn command_report(
    stage: &str,
    spec: &WorktreeCommandSpec,
    output: WorktreeCommandOutput,
) -> WorktreeCommandReport {
    WorktreeCommandReport {
        stage: stage.into(),
        program: spec.program.clone(),
        args: spec.args.clone(),
        output,
    }
}

fn is_collision_failure(error: &WorktreeCommandFailure) -> bool {
    let WorktreeCommandFailure::Exit { message, output } = error else {
        return false;
    };
    let text = format!("{message}\n{}", output.stderr_tail).to_ascii_lowercase();
    text.contains("already exists")
        || text.contains("already checked out")
        || text.contains("missing but already registered worktree")
}

fn error_is_cancelled(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<WorktreeCommandFailure>()
            .map(WorktreeCommandFailure::is_cancelled)
            .unwrap_or(false)
    })
}

fn digest_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn bounded_text(value: &str) -> String {
    value.chars().take(4_096).collect()
}

fn rollback_empty_directories(directories: &[PathBuf]) {
    for directory in directories.iter().rev() {
        let _ = std::fs::remove_dir(directory);
    }
}

fn validate_operation_id(operation_id: Uuid) -> Result<()> {
    if operation_id.is_nil() {
        bail!("operation id must not be nil");
    }
    Ok(())
}

#[cfg(windows)]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_type().is_symlink()
        || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_link_or_reparse(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::git::test_support::{run_git, test_repo, unique_path};
    use crate::app::git::worktree::{WorktreeStorage, WorktreeStorageMode};

    #[test]
    fn native_sparse_resolver_reads_repository_policy_and_rejects_unknown_ids() {
        let repository = unique_path("vibelink-sparse-policy");
        let policy_dir = repository.join(".vibelink");
        std::fs::create_dir_all(&policy_dir).expect("policy directory");
        std::fs::write(
            policy_dir.join("worktree.json"),
            r#"{"sparsePresets":{"frontend":["src","package.json"]}}"#,
        )
        .expect("policy");
        let resolver = NativeProvisioningResolver;
        assert_eq!(
            resolver
                .resolve_sparse_preset(&repository, "frontend")
                .expect("preset"),
            vec!["src".to_string(), "package.json".to_string()]
        );
        assert!(resolver
            .resolve_sparse_preset(&repository, "missing")
            .expect_err("unknown preset")
            .to_string()
            .contains("unknown sparse preset"));
        let _ = std::fs::remove_dir_all(repository);
    }

    #[cfg(windows)]
    #[test]
    fn strips_verbatim_prefix_before_passing_worktree_paths_to_git() {
        assert_eq!(
            git_compatible_path(Path::new(r"\\?\C:\workspace\repo")),
            PathBuf::from(r"C:\workspace\repo")
        );
        assert_eq!(
            git_compatible_path(Path::new(r"\\?\UNC\server\share\repo")),
            PathBuf::from(r"\\server\share\repo")
        );
    }
    use crate::app::git::worktree_registry::{WorktreeListRequest, WorktreeOrigin};
    use crate::control_plane::ControlPlane;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    #[derive(Default)]
    struct TestResolver {
        setup: Option<WorktreeSetupCommand>,
        sparse: Option<Vec<String>>,
    }

    impl WorktreeProvisioningResolver for TestResolver {
        fn resolve_sparse_preset(
            &self,
            _repository: &Path,
            _preset_id: &str,
        ) -> Result<Vec<String>> {
            self.sparse.clone().context("unknown test sparse preset")
        }

        fn resolve_setup_command(
            &self,
            _repository: &Path,
            setup_policy: &str,
        ) -> Result<Option<WorktreeSetupCommand>> {
            if setup_policy == "run" && self.setup.is_none() {
                bail!("missing test setup command");
            }
            Ok(if setup_policy == "skip" {
                None
            } else {
                self.setup.clone()
            })
        }
    }

    #[derive(Default)]
    struct RecordingProgress(Mutex<Vec<String>>);

    impl WorktreeProgressSink for RecordingProgress {
        fn progress(&self, progress: WorktreeProgress) {
            self.0.lock().expect("progress lock").push(progress.stage);
        }
    }

    struct InjectingRunner {
        native: NativeWorktreeCommandRunner,
        fail_token: Option<String>,
        cancel_after_add: Option<WorktreeCancellation>,
        collide_all: bool,
        mutate_on_move: Option<Arc<dyn Fn() + Send + Sync>>,
        mutated: AtomicBool,
        calls: Mutex<Vec<Vec<String>>>,
    }

    impl InjectingRunner {
        fn native() -> Self {
            Self {
                native: NativeWorktreeCommandRunner::default(),
                fail_token: None,
                cancel_after_add: None,
                collide_all: false,
                mutate_on_move: None,
                mutated: AtomicBool::new(false),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn injected_exit(message: &str) -> WorktreeCommandFailure {
            WorktreeCommandFailure::Exit {
                message: message.into(),
                output: WorktreeCommandOutput {
                    exit_code: Some(1),
                    stderr_tail: message.into(),
                    ..WorktreeCommandOutput::default()
                },
            }
        }
    }

    impl WorktreeCommandRunner for InjectingRunner {
        fn run(
            &self,
            spec: &WorktreeCommandSpec,
            cancellation: &WorktreeCancellation,
        ) -> std::result::Result<WorktreeCommandOutput, WorktreeCommandFailure> {
            self.calls
                .lock()
                .expect("calls lock")
                .push(spec.args.clone());
            if self.collide_all && spec.args.iter().any(|arg| arg == "show-ref") {
                return Ok(WorktreeCommandOutput {
                    exit_code: Some(0),
                    ..WorktreeCommandOutput::default()
                });
            }
            if let Some(token) = self.fail_token.as_deref() {
                if spec.program == token || spec.args.iter().any(|arg| arg == token) {
                    return Err(Self::injected_exit("injected command failure"));
                }
            }
            let is_move = contains_arg_pair(&spec.args, "worktree", "move");
            let is_add = contains_arg_pair(&spec.args, "worktree", "add");
            let output = self.native.run(spec, cancellation)?;
            if is_add {
                if let Some(token) = self.cancel_after_add.as_ref() {
                    token.cancel();
                }
            }
            if is_move && !self.mutated.swap(true, Ordering::SeqCst) {
                if let Some(mutate) = self.mutate_on_move.as_ref() {
                    mutate();
                }
            }
            Ok(output)
        }
    }
    fn contains_arg_pair(args: &[String], left: &str, right: &str) -> bool {
        args.windows(2).any(|pair| {
            pair.first().map(String::as_str) == Some(left)
                && pair.get(1).map(String::as_str) == Some(right)
        })
    }

    fn request(
        repo: &Path,
        storage_root: &Path,
        branch: &str,
        setup_policy: &str,
    ) -> WorktreeCreateRequest {
        WorktreeCreateRequest {
            operation_id: Uuid::new_v4(),
            repository_path: repo.to_string_lossy().to_string(),
            parent_session_id: Uuid::new_v4().to_string(),
            parent_worktree_id: None,
            name: branch.replace('/', "-"),
            start_ref: "HEAD".into(),
            branch: Some(branch.into()),
            storage: WorktreeStorage {
                mode: WorktreeStorageMode::Custom,
                drive: String::new(),
                folder_name: String::new(),
                custom_root: storage_root.to_string_lossy().to_string(),
                group_by_repository: false,
            },
            fetch: false,
            setup_policy: setup_policy.into(),
            sparse_preset: None,
            linked_files: Vec::new(),
            profile_id: None,
            initial_agent: None,
            initial_prompt: None,
            origin: WorktreeOrigin::Manual,
        }
    }

    fn service(
        runner: Arc<dyn WorktreeCommandRunner>,
        resolver: Arc<dyn WorktreeProvisioningResolver>,
    ) -> (PathBuf, Arc<WorktreeRegistry>, WorktreeLifecycleService) {
        let data = unique_path("lifecycle-data");
        std::fs::create_dir_all(&data).expect("create data");
        let control = Arc::new(ControlPlane::open(&data).expect("control plane"));
        let registry = Arc::new(WorktreeRegistry::new(control));
        let lifecycle = WorktreeLifecycleService::with_components(
            Arc::clone(&registry),
            runner,
            resolver,
            Arc::new(RecordingProgress::default()),
        );
        (data, registry, lifecycle)
    }

    fn branch_exists_for_test(repo: &Path, branch: &str) -> bool {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(repo)
            .args([
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{branch}"),
            ])
            .output()
            .expect("inspect branch");
        output.status.success()
    }

    #[test]
    fn fetch_failure_precedes_git_creation() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        run_git(&repo, &["remote", "add", "origin", repo.to_str().unwrap()]);
        let storage = unique_path("fetch-failure-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let mut runner = InjectingRunner::native();
        runner.fail_token = Some("fetch".into());
        let (_data, registry, lifecycle) =
            service(Arc::new(runner), Arc::new(TestResolver::default()));
        let mut input = request(&repo, &storage, "fetch-failure", "skip");
        input.fetch = true;
        lifecycle
            .create(input, |_| Ok(Uuid::new_v4().to_string()), |_| Ok(()))
            .expect_err("fetch must fail");
        assert!(!branch_exists_for_test(&repo, "fetch-failure"));
        assert!(registry
            .list(WorktreeListRequest {
                repository_path: Some(repo.to_string_lossy().to_string()),
                include_external: false,
                include_hidden: true,
            })
            .expect("list")
            .iter()
            .all(
                |row| row.record.as_ref().map(|record| record.branch.as_str())
                    != Some("fetch-failure")
            ));
    }

    #[test]
    fn setup_failure_rolls_back_checkout_branch_and_metadata() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        let storage = unique_path("setup-failure-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let mut runner = InjectingRunner::native();
        runner.fail_token = Some("fake-setup".into());
        let (_data, registry, lifecycle) = service(
            Arc::new(runner),
            Arc::new(TestResolver {
                setup: Some(WorktreeSetupCommand {
                    program: "fake-setup".into(),
                    args: Vec::new(),
                }),
                sparse: None,
            }),
        );
        lifecycle
            .create(
                request(&repo, &storage, "setup-failure", "run"),
                |_| Ok(Uuid::new_v4().to_string()),
                |_| Ok(()),
            )
            .expect_err("setup must fail");
        assert!(!branch_exists_for_test(&repo, "setup-failure"));
        assert!(registry
            .list(WorktreeListRequest {
                repository_path: Some(repo.to_string_lossy().to_string()),
                include_external: false,
                include_hidden: true,
            })
            .expect("list")
            .iter()
            .all(
                |row| row.record.as_ref().map(|record| record.branch.as_str())
                    != Some("setup-failure")
            ));
    }

    #[test]
    fn bind_failure_rolls_back_registered_identity() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        let storage = unique_path("bind-failure-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let (_data, _registry, lifecycle) = service(
            Arc::new(InjectingRunner::native()),
            Arc::new(TestResolver::default()),
        );
        lifecycle
            .create(
                request(&repo, &storage, "bind-failure", "skip"),
                |_| bail!("injected bind failure"),
                |_| Ok(()),
            )
            .expect_err("bind must fail");
        assert!(!branch_exists_for_test(&repo, "bind-failure"));
    }

    #[test]
    fn cancellation_after_add_rolls_back_with_uncancelled_cleanup_token() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        let storage = unique_path("cancel-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let cancellation = WorktreeCancellation::default();
        let mut runner = InjectingRunner::native();
        runner.cancel_after_add = Some(cancellation.clone());
        let (_data, _registry, lifecycle) =
            service(Arc::new(runner), Arc::new(TestResolver::default()));
        let error = lifecycle
            .create_cancellable(
                request(&repo, &storage, "cancelled-create", "skip"),
                cancellation,
                |_| Ok(Uuid::new_v4().to_string()),
                |_| Ok(()),
            )
            .expect_err("creation must cancel");
        assert!(error_is_cancelled(&error));
        assert!(!branch_exists_for_test(&repo, "cancelled-create"));
    }

    #[test]
    fn collisions_are_bounded_at_unsuffixed_through_25() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        let storage = unique_path("collision-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let runner = Arc::new(InjectingRunner {
            collide_all: true,
            ..InjectingRunner::native()
        });
        let runner_trait: Arc<dyn WorktreeCommandRunner> = runner.clone();
        let (_data, _registry, lifecycle) =
            service(runner_trait, Arc::new(TestResolver::default()));
        let error = lifecycle
            .create(
                request(&repo, &storage, "bounded-collision", "skip"),
                |_| Ok(Uuid::new_v4().to_string()),
                |_| Ok(()),
            )
            .expect_err("collisions must exhaust");
        assert!(error.to_string().contains("suffix -25"));
        assert_eq!(
            runner
                .calls
                .lock()
                .expect("calls")
                .iter()
                .filter(|args| args.iter().any(|arg| arg == "show-ref"))
                .count(),
            25
        );
    }

    #[test]
    fn move_cas_failure_performs_one_move_back() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        let storage = unique_path("move-cas-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let (_data, registry, creator) = service(
            Arc::new(InjectingRunner::native()),
            Arc::new(TestResolver::default()),
        );
        let created = creator
            .create(
                request(&repo, &storage, "move-cas", "skip"),
                |_| Ok(Uuid::new_v4().to_string()),
                |_| Ok(()),
            )
            .expect("create");
        let registry_for_race = Arc::clone(&registry);
        let id = created.worktree.id.clone();
        let runner = Arc::new(InjectingRunner {
            mutate_on_move: Some(Arc::new(move || {
                let record = registry_for_race.read_record(&id).expect("record");
                let mut native = NativeWorktree {
                    worktree_path: format!("{}-race", record.worktree_path),
                    normalized_path: format!("{}-race", record.normalized_worktree_path),
                    git_dir_identity: record.git_dir_identity.clone(),
                    head: record.head.clone(),
                    branch: Some(record.branch.clone()),
                    detached: false,
                    bare: false,
                    locked: false,
                    lock_reason: None,
                    prunable: false,
                    prunable_reason: None,
                    exists: true,
                    is_main: false,
                    dirty: false,
                    untracked: false,
                    has_conflicts: false,
                    ahead: 0,
                    behind: 0,
                };
                native.normalized_path = normalize_path_for_comparison(&native.worktree_path);
                let _ = registry_for_race.compare_and_swap_path(
                    &record.id,
                    &record.instance_id,
                    &record.worktree_path,
                    &native,
                );
            })),
            ..InjectingRunner::native()
        });
        let runner_trait: Arc<dyn WorktreeCommandRunner> = runner.clone();
        let mover = WorktreeLifecycleService::with_components(
            Arc::clone(&registry),
            runner_trait,
            Arc::new(TestResolver::default()),
            Arc::new(RecordingProgress::default()),
        );
        let created_id = created.worktree.id.clone();
        let created_instance = created.worktree.instance_id.clone();
        let created_path = created.worktree.worktree_path.clone();
        mover
            .move_checkout(WorktreeMoveRequest {
                operation_id: Uuid::new_v4(),
                worktree_id: created_id,
                expected_instance_id: created_instance,
                destination_path: storage.join("moved-cas").to_string_lossy().to_string(),
            })
            .expect_err("CAS must fail");
        assert!(Path::new(&created_path).is_dir());
        assert_eq!(
            runner
                .calls
                .lock()
                .expect("calls")
                .iter()
                .filter(|args| contains_arg_pair(args, "worktree", "move"))
                .count(),
            2
        );
    }

    #[test]
    fn safe_delete_refusal_preserves_branch_without_force_escalation() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        let storage = unique_path("preserve-branch-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let mut runner = InjectingRunner::native();
        runner.fail_token = Some("merge-base".into());
        let (_data, _registry, lifecycle) =
            service(Arc::new(runner), Arc::new(TestResolver::default()));
        let created = lifecycle
            .create(
                request(&repo, &storage, "preserve-branch", "skip"),
                |_| Ok(Uuid::new_v4().to_string()),
                |_| Ok(()),
            )
            .expect("create");
        let result = lifecycle
            .remove(
                WorktreeRemoveRequest {
                    operation_id: Uuid::new_v4(),
                    worktree_id: created.worktree.id,
                    expected_instance_id: created.worktree.instance_id,
                    force: false,
                    delete_branch: true,
                    provider_merged_head: None,
                    acknowledged_blockers: Vec::new(),
                },
                WorktreeRuntimeBlockers::default(),
                |_| Ok(()),
                |_| Ok(true),
            )
            .expect("checkout removal must survive safe branch refusal");
        assert!(result.checkout_removed);
        assert!(!result.branch_deleted);
        assert!(result.branch_preserved_reason.is_some());
        assert!(branch_exists_for_test(&repo, "preserve-branch"));
    }

    #[test]
    fn dirty_head_is_pinned_and_add_uses_no_track() {
        let repo = test_repo();
        std::fs::write(repo.join("tracked.txt"), b"committed").expect("write tracked file");
        run_git(&repo, &["add", "tracked.txt"]);
        run_git(&repo, &["commit", "-m", "initial"]);
        let main_head = String::from_utf8(run_git(&repo, &["rev-parse", "HEAD"]))
            .expect("head utf8")
            .trim()
            .to_string();
        std::fs::write(repo.join("tracked.txt"), b"dirty snapshot").expect("modify tracked file");
        let storage = unique_path("dirty-snapshot-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let runner = Arc::new(InjectingRunner::native());
        let runner_trait: Arc<dyn WorktreeCommandRunner> = runner.clone();
        let (_data, _registry, lifecycle) =
            service(runner_trait, Arc::new(TestResolver::default()));
        let created = lifecycle
            .create(
                request(&repo, &storage, "dirty-snapshot", "skip"),
                |_| Ok(Uuid::new_v4().to_string()),
                |_| Ok(()),
            )
            .expect("create from dirty snapshot");
        assert_ne!(created.base_sha, main_head);
        assert_eq!(
            std::fs::read(Path::new(&created.worktree.worktree_path).join("tracked.txt"))
                .expect("read snapshot file"),
            b"dirty snapshot"
        );
        let calls = runner.calls.lock().expect("calls");
        let add = calls
            .iter()
            .find(|args| contains_arg_pair(args, "worktree", "add"))
            .expect("worktree add call");
        assert!(add.iter().any(|arg| arg == "--no-track"));
        assert!(add.iter().any(|arg| arg == &created.base_sha));
    }

    #[test]
    fn path_and_branch_share_the_same_collision_suffix() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        let storage = unique_path("shared-suffix-storage");
        std::fs::create_dir_all(storage.join("shared-name")).expect("create base collision");
        let (_data, _registry, lifecycle) = service(
            Arc::new(InjectingRunner::native()),
            Arc::new(TestResolver::default()),
        );
        let created = lifecycle
            .create(
                request(&repo, &storage, "shared-name", "skip"),
                |_| Ok(Uuid::new_v4().to_string()),
                |_| Ok(()),
            )
            .expect("create suffixed worktree");
        assert_eq!(created.worktree.branch, "shared-name-2");
        assert_eq!(
            Path::new(&created.worktree.worktree_path)
                .file_name()
                .and_then(|name| name.to_str()),
            Some("shared-name-2")
        );
    }

    #[test]
    fn unknown_sparse_preset_fails_before_worktree_add() {
        let repo = test_repo();
        run_git(&repo, &["commit", "--allow-empty", "-m", "initial"]);
        let storage = unique_path("unknown-sparse-storage");
        std::fs::create_dir_all(&storage).expect("create storage");
        let runner = Arc::new(InjectingRunner::native());
        let runner_trait: Arc<dyn WorktreeCommandRunner> = runner.clone();
        let (_data, _registry, lifecycle) =
            service(runner_trait, Arc::new(TestResolver::default()));
        let mut input = request(&repo, &storage, "unknown-sparse", "skip");
        input.sparse_preset = Some("missing".into());
        lifecycle
            .create(input, |_| Ok(Uuid::new_v4().to_string()), |_| Ok(()))
            .expect_err("unknown preset must fail");
        assert!(runner
            .calls
            .lock()
            .expect("calls")
            .iter()
            .all(|args| !contains_arg_pair(args, "worktree", "add")));
    }
}

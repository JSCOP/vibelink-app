use super::exec::{git_read, git_read_allow_fail, git_write};
use super::worktree::{
    normalize_path_for_comparison, paths_equal, resolve_repository_identity, scan_native_worktrees,
    NativeWorktree, RepositoryIdentity,
};
use crate::control_plane::ControlPlane;
use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{params, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const WORKTREE_COLUMNS: &str = "id,instance_id,repository_id,repository_path,worktree_path,branch,head,base_ref,session_id,parent_session_id,parent_worktree_id,parent_instance_id,origin,lifecycle,locked,lock_reason,prunable,prunable_reason,dirty,untracked,has_conflicts,ahead,behind,\"exists\",setup_policy,sparse_preset,linked_files_json,initial_agent,initial_prompt,comment,review_target,created_at,updated_at,last_activity_at,normalized_repository_path,normalized_worktree_path,git_dir_identity";

pub(crate) const WORKTREE_METHOD_LIST: &str = "worktree.list";
pub(crate) const WORKTREE_METHOD_RECONCILE: &str = "worktree.reconcile";
pub(crate) const WORKTREE_METHOD_IMPORT: &str = "worktree.import";
pub(crate) const WORKTREE_METHOD_CREATE: &str = "worktree.create";
pub(crate) const WORKTREE_METHOD_MOVE: &str = "worktree.move";
pub(crate) const WORKTREE_METHOD_PREFLIGHT_REMOVE: &str = "worktree.preflight_remove";
pub(crate) const WORKTREE_METHOD_REMOVE: &str = "worktree.remove";
pub(crate) const WORKTREE_METHOD_SET: &str = "worktree.set";
pub(crate) const WORKTREE_METHOD_CHECKPOINT: &str = "worktree.checkpoint";
pub(crate) const WORKTREE_METHOD_CHECKPOINTS: &str = "worktree.checkpoints";
pub(crate) const WORKTREE_METHOD_REVIEW_COMMENT_PUT: &str = "worktree.review_comment.put";
pub(crate) const WORKTREE_METHOD_REVIEW_COMMENTS: &str = "worktree.review_comments";
pub(crate) const WORKTREE_METHOD_CANCEL: &str = "worktree.cancel";

/// Cancellation flags for operations currently running in this process. The
/// durable `worktree_operations` row records the outcome; this map is only the
/// live signal a running operation polls between stages.
static CANCELLATION_FLAGS: LazyLock<Mutex<HashMap<Uuid, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn lock_cancellation_flags() -> std::sync::MutexGuard<'static, HashMap<Uuid, Arc<AtomicBool>>> {
    CANCELLATION_FLAGS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeOrigin {
    Manual,
    Cli,
    Mcp,
    Orchestration,
    Automation,
    ExternalImport,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeLifecycle {
    Active,
    Missing,
    Stale,
    Conflicted,
    Removing,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeReconcileState {
    Managed,
    External,
    Missing,
    Stale,
    Conflicted,
    Untrusted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorktreeBlockerKind {
    MainCheckout,
    GitLocked,
    IdentityMismatch,
    Dirty,
    Conflicted,
    Unpushed,
    LiveSession,
    LivePanes,
    MissingRegistration,
    OrphanDirectory,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRecord {
    pub id: String,
    pub instance_id: String,
    pub repository_id: String,
    pub repository_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub head: String,
    pub base_ref: String,
    pub session_id: Option<String>,
    pub parent_session_id: Option<String>,
    pub parent_worktree_id: Option<String>,
    pub parent_instance_id: Option<String>,
    pub origin: WorktreeOrigin,
    pub lifecycle: WorktreeLifecycle,
    pub locked: bool,
    pub lock_reason: Option<String>,
    pub prunable: bool,
    pub prunable_reason: Option<String>,
    pub dirty: bool,
    pub untracked: bool,
    pub has_conflicts: bool,
    pub ahead: u64,
    pub behind: u64,
    pub exists: bool,
    pub setup_policy: String,
    pub sparse_preset: Option<String>,
    pub linked_files: Vec<String>,
    pub initial_agent: Option<String>,
    pub initial_prompt: Option<String>,
    pub comment: Option<String>,
    pub review_target: Option<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub last_activity_at: u64,
    #[serde(skip_serializing, default)]
    pub normalized_repository_path: String,
    #[serde(skip_serializing, default)]
    pub normalized_worktree_path: String,
    #[serde(skip_serializing, default)]
    pub git_dir_identity: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeProjection {
    pub id: String,
    pub instance_id: Option<String>,
    pub state: WorktreeReconcileState,
    pub record: Option<WorktreeRecord>,
    pub native: Option<NativeWorktree>,
    pub parent_worktree_id: Option<String>,
    pub child_worktree_ids: Vec<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeListRequest {
    pub repository_path: Option<String>,
    #[serde(default)]
    pub include_external: bool,
    #[serde(default)]
    pub include_hidden: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeIdRequest {
    pub worktree_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeOperationIdRequest {
    pub operation_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegacyWorktreeRow {
    pub session_id: String,
    pub parent_session_id: String,
    pub source_workspace_folder: String,
    pub worktree_path: String,
    #[serde(default)]
    pub branch: String,
    #[serde(default)]
    pub start_ref: String,
    #[serde(default)]
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReconcileRequest {
    pub repository_path: String,
    #[serde(default)]
    pub legacy_rows: Vec<LegacyWorktreeRow>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeImportRequest {
    pub repository_path: String,
    pub worktree_path: String,
    pub parent_session_id: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCreateRequest {
    pub operation_id: Uuid,
    pub repository_path: String,
    pub parent_session_id: String,
    pub parent_worktree_id: Option<String>,
    pub name: String,
    pub start_ref: String,
    pub branch: Option<String>,
    pub storage: super::worktree::WorktreeStorage,
    #[serde(default)]
    pub fetch: bool,
    pub setup_policy: String,
    pub sparse_preset: Option<String>,
    #[serde(default)]
    pub linked_files: Vec<String>,
    pub profile_id: Option<String>,
    pub initial_agent: Option<String>,
    pub initial_prompt: Option<String>,
    pub origin: WorktreeOrigin,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeMoveRequest {
    pub operation_id: Uuid,
    pub worktree_id: String,
    pub expected_instance_id: String,
    pub destination_path: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovalPreflightRequest {
    pub worktree_id: String,
    #[serde(default)]
    pub delete_branch: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemoveRequest {
    pub operation_id: Uuid,
    pub worktree_id: String,
    pub expected_instance_id: String,
    #[serde(default)]
    pub force: bool,
    #[serde(default)]
    pub delete_branch: bool,
    #[serde(default)]
    pub provider_merged_head: Option<String>,
    #[serde(default)]
    pub acknowledged_blockers: Vec<WorktreeBlockerKind>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovalResult {
    pub checkout_removed: bool,
    pub branch_deleted: bool,
    pub branch_preserved_reason: Option<String>,
    pub session_removed: bool,
    pub metadata_removed: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeSetRequest {
    pub worktree_id: String,
    pub expected_instance_id: String,
    pub comment: Option<String>,
    pub review_target: Option<String>,
    pub parent_worktree_id: Option<String>,
    #[serde(default)]
    pub clear_parent: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCheckpointRequest {
    pub worktree_id: String,
    pub kind: String,
    pub label: String,
    pub comment: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReviewCommentRequest {
    pub worktree_id: String,
    pub expected_instance_id: String,
    pub base_head: String,
    pub head: String,
    pub path: String,
    pub side: String,
    pub line: Option<u32>,
    pub range: Option<Value>,
    pub hunk_id: Option<String>,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeCheckpoint {
    pub id: String,
    pub worktree_id: String,
    pub kind: String,
    pub label: String,
    pub head: String,
    pub comment: Option<String>,
    pub created_at: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeReviewComment {
    pub id: String,
    pub worktree_id: String,
    pub instance_id: String,
    pub base_head: String,
    pub head: String,
    pub path: String,
    pub side: String,
    pub line: Option<u32>,
    pub range: Option<Value>,
    pub hunk_id: Option<String>,
    pub body: String,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Default)]
pub struct WorktreeRuntimeBlockers {
    pub live_session: bool,
    pub live_panes: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeBlocker {
    pub kind: WorktreeBlockerKind,
    pub hard: bool,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeRemovalPreflight {
    pub worktree_id: String,
    pub instance_id: String,
    pub repository_path: String,
    pub worktree_path: String,
    pub branch: String,
    pub head: String,
    pub blockers: Vec<WorktreeBlocker>,
    pub warnings: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum WorktreeOperationClaim {
    Claimed,
    Replay {
        result_json: Option<String>,
        error: Option<String>,
    },
}

#[derive(Clone)]
pub struct WorktreeRegistry {
    control: Arc<ControlPlane>,
}

impl WorktreeRegistry {
    pub fn new(control: Arc<ControlPlane>) -> Self {
        Self { control }
    }

    pub fn record(&self, id: &str) -> Result<WorktreeRecord> {
        self.read_record(id)
    }

    pub fn list(&self, request: WorktreeListRequest) -> Result<Vec<WorktreeProjection>> {
        if let Some(repository_path) = request.repository_path {
            return self
                .reconcile(WorktreeReconcileRequest {
                    repository_path,
                    legacy_rows: Vec::new(),
                })
                .map(|mut projections| {
                    projections.retain(|projection| {
                        (request.include_external || projection.record.is_some())
                            && (request.include_hidden || !self.hidden_external(projection))
                    });
                    projections
                });
        }

        let records = self.read_records(None)?;
        let mut repositories = records
            .iter()
            .map(|record| record.repository_path.clone())
            .collect::<Vec<_>>();
        repositories.sort_by_key(|path| normalize_path_for_comparison(path));
        repositories.dedup_by(|left, right| paths_equal(left, right));
        let mut projections = Vec::new();
        let mut seen = HashSet::new();
        for repository_path in repositories {
            match self.reconcile(WorktreeReconcileRequest {
                repository_path: repository_path.clone(),
                legacy_rows: Vec::new(),
            }) {
                Ok(rows) => {
                    for row in rows {
                        if seen.insert(row.id.clone()) {
                            projections.push(row);
                        }
                    }
                }
                Err(_) => {
                    for record in records
                        .iter()
                        .filter(|record| paths_equal(&record.repository_path, &repository_path))
                    {
                        if seen.insert(record.id.clone()) {
                            projections.push(projection_for_record(
                                record.clone(),
                                WorktreeReconcileState::Untrusted,
                                None,
                            ));
                        }
                    }
                }
            }
        }
        projections.retain(|projection| {
            (request.include_external || projection.record.is_some())
                && (request.include_hidden || !self.hidden_external(projection))
        });
        apply_lineage(&mut projections);
        Ok(projections)
    }

    pub fn reconcile(&self, request: WorktreeReconcileRequest) -> Result<Vec<WorktreeProjection>> {
        if is_remote_path(&request.repository_path) {
            let normalized = normalize_path_for_comparison(&request.repository_path);
            let mut projections = self
                .read_records(None)?
                .into_iter()
                .filter(|record| record.normalized_repository_path == normalized)
                .map(|record| {
                    projection_for_record(record, WorktreeReconcileState::Untrusted, None)
                })
                .collect::<Vec<_>>();
            apply_lineage(&mut projections);
            return Ok(projections);
        }
        let repository = resolve_repository_identity(&request.repository_path)?;
        let native = scan_native_worktrees(&request.repository_path)?;
        if !request.legacy_rows.is_empty() {
            self.import_legacy_rows(&repository, &native, &request.legacy_rows)?;
        }
        self.reconcile_scan(repository, native)
    }

    pub fn import_external(&self, request: WorktreeImportRequest) -> Result<WorktreeProjection> {
        let repository = resolve_repository_identity(&request.repository_path)?;
        let native_rows = scan_native_worktrees(&request.repository_path)?;
        let normalized = normalize_path_for_comparison(&request.worktree_path);
        let native = native_rows
            .iter()
            .find(|entry| entry.normalized_path == normalized)
            .cloned()
            .ok_or_else(|| {
                anyhow!(
                    "worktree is not registered with Git: {}",
                    request.worktree_path
                )
            })?;
        if native.git_dir_identity.is_empty() {
            bail!("worktree identity is unavailable");
        }
        let parent = self.validated_parent_for_session(
            &repository,
            &native_rows,
            &normalized,
            request.parent_session_id.as_deref(),
        )?;
        if let Some(record) = self.read_record_by_path(&repository.repository_id, &normalized)? {
            let projection = self.reconcile_matched_record(&repository, record, native.clone())?;
            let reconciled = projection
                .record
                .as_ref()
                .context("reconciled worktree record is unavailable")?;
            if request.session_id.is_some() || request.parent_session_id.is_some() {
                let session_id = request
                    .session_id
                    .as_deref()
                    .or(reconciled.session_id.as_deref());
                let parent_session_id = request
                    .parent_session_id
                    .as_deref()
                    .or(reconciled.parent_session_id.as_deref());
                let (parent_worktree_id, parent_instance_id) =
                    if request.parent_session_id.is_some() {
                        (
                            parent.as_ref().map(|value| value.id.as_str()),
                            parent.as_ref().map(|value| value.instance_id.as_str()),
                        )
                    } else {
                        (
                            reconciled.parent_worktree_id.as_deref(),
                            reconciled.parent_instance_id.as_deref(),
                        )
                    };
                self.control.with_connection(|connection| {
                    connection.execute(
                        "UPDATE worktrees SET session_id=?1,parent_session_id=?2,parent_worktree_id=?3,parent_instance_id=?4,updated_at=?5 WHERE id=?6 AND instance_id=?7",
                        params![session_id, parent_session_id, parent_worktree_id, parent_instance_id, now_millis(), reconciled.id, reconciled.instance_id],
                    )
                })?;
                let rebound = self.read_record(&reconciled.id)?;
                return Ok(projection_for_record(
                    rebound,
                    WorktreeReconcileState::Managed,
                    Some(native),
                ));
            }
            return Ok(projection);
        }
        let record = self.insert_native_record(
            &repository,
            &native,
            request.session_id,
            request.parent_session_id,
            parent.as_ref(),
            WorktreeOrigin::ExternalImport,
            "inherit",
            None,
            Vec::new(),
            None,
            None,
            "",
        )?;
        Ok(projection_for_record(
            record,
            WorktreeReconcileState::Managed,
            Some(native),
        ))
    }

    pub fn removal_preflight(
        &self,
        request: &WorktreeRemovalPreflightRequest,
        runtime: WorktreeRuntimeBlockers,
    ) -> Result<WorktreeRemovalPreflight> {
        let record = self.read_record(&request.worktree_id)?;
        let native_rows = scan_native_worktrees(&record.repository_path)?;
        let native = native_rows
            .into_iter()
            .find(|entry| entry.normalized_path == record.normalized_worktree_path);
        let mut blockers = Vec::new();
        let mut warnings = Vec::new();
        match native.as_ref() {
            Some(native) => {
                if native.is_main {
                    blockers.push(blocker(
                        WorktreeBlockerKind::MainCheckout,
                        true,
                        "The main checkout cannot be removed.",
                    ));
                }
                if native.locked {
                    blockers.push(blocker(
                        WorktreeBlockerKind::GitLocked,
                        true,
                        native
                            .lock_reason
                            .as_deref()
                            .unwrap_or("Git reports this worktree as locked."),
                    ));
                }
                if native.git_dir_identity.is_empty()
                    || record.git_dir_identity.is_empty()
                    || native.git_dir_identity != record.git_dir_identity
                {
                    blockers.push(blocker(
                        WorktreeBlockerKind::IdentityMismatch,
                        true,
                        "The checkout instance identity cannot be proven against the registration.",
                    ));
                }
                if native.dirty || native.untracked {
                    blockers.push(blocker(
                        WorktreeBlockerKind::Dirty,
                        false,
                        "The checkout contains tracked or untracked changes.",
                    ));
                }
                if native.has_conflicts {
                    blockers.push(blocker(
                        WorktreeBlockerKind::Conflicted,
                        false,
                        "The checkout contains unresolved conflicts.",
                    ));
                }
                let has_unpushed_commits = native.ahead > 0
                    || (!record.branch.is_empty()
                        && branch_has_commits_beyond_base(&record).unwrap_or(true));
                if has_unpushed_commits {
                    blockers.push(blocker(WorktreeBlockerKind::Unpushed, false, "The branch may contain commits not preserved by a remote or review target."));
                }
            }
            None => {
                if path_entry_exists(&record.worktree_path) {
                    blockers.push(blocker(WorktreeBlockerKind::OrphanDirectory, true, "The directory exists but is not a registered Git worktree; it will not be deleted recursively."));
                } else {
                    warnings.push("Git registration and checkout directory are already absent; metadata cleanup is available.".to_string());
                    blockers.push(blocker(
                        WorktreeBlockerKind::MissingRegistration,
                        false,
                        "The Git worktree registration is missing.",
                    ));
                }
            }
        }
        if runtime.live_session {
            blockers.push(blocker(
                WorktreeBlockerKind::LiveSession,
                false,
                "A bound workspace session is still live.",
            ));
        }
        if runtime.live_panes {
            blockers.push(blocker(
                WorktreeBlockerKind::LivePanes,
                false,
                "The bound workspace still owns live panes.",
            ));
        }
        let head = native
            .as_ref()
            .map(|entry| entry.head.clone())
            .unwrap_or_else(|| record.head.clone());
        let branch = native
            .as_ref()
            .and_then(|entry| entry.branch.clone())
            .unwrap_or_else(|| record.branch.clone());
        if request.delete_branch && branch.is_empty() {
            warnings.push(
                "The checkout is detached, so there is no local branch to delete.".to_string(),
            );
        }
        Ok(WorktreeRemovalPreflight {
            worktree_id: record.id,
            instance_id: record.instance_id,
            repository_path: record.repository_path,
            worktree_path: record.worktree_path,
            branch,
            head,
            blockers,
            warnings,
        })
    }

    pub fn validate_removal_request(
        &self,
        request: &WorktreeRemoveRequest,
        preflight: &WorktreeRemovalPreflight,
    ) -> Result<()> {
        validate_removal_acknowledgements(request, preflight)
    }

    pub(crate) fn prepare_removal(
        &self,
        worktree_id: &str,
        expected_instance_id: &str,
    ) -> Result<WorktreeRecord> {
        self.control.with_connection_mut(|connection| -> Result<WorktreeRecord> {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let record = read_record_connection(&transaction, worktree_id)?;
            require_instance(&record, expected_instance_id)?;
            let changed = transaction.execute(
                "UPDATE worktrees SET lifecycle='removing',updated_at=?1 WHERE id=?2 AND instance_id=?3 AND lifecycle<>'removing'",
                params![now_millis(), worktree_id, expected_instance_id],
            )?;
            if changed == 0 && record.lifecycle != WorktreeLifecycle::Removing {
                bail!("worktree lifecycle changed before removal");
            }
            transaction.commit()?;
            Ok(WorktreeRecord { lifecycle: WorktreeLifecycle::Removing, ..record })
        })
    }

    pub fn remove_checkout_and_branch(
        &self,
        request: &WorktreeRemoveRequest,
        preflight: &WorktreeRemovalPreflight,
    ) -> Result<WorktreeRemovalResult> {
        validate_removal_acknowledgements(request, preflight)?;
        let hard = preflight.blockers.iter().find(|blocker| blocker.hard);
        if let Some(blocker) = hard {
            bail!("removal blocked by {:?}: {}", blocker.kind, blocker.message);
        }
        let orphan = preflight
            .blockers
            .iter()
            .any(|blocker| blocker.kind == WorktreeBlockerKind::OrphanDirectory);
        if orphan {
            bail!("orphan directories are preserved; repair or remove them outside the managed lifecycle");
        }
        let current = self.read_record(&request.worktree_id)?;
        require_instance(&current, &request.expected_instance_id)?;
        if current.lifecycle != WorktreeLifecycle::Removing {
            bail!("worktree is not prepared for removal");
        }
        if preflight.instance_id != request.expected_instance_id
            || !paths_equal(&current.worktree_path, &preflight.worktree_path)
            || !paths_equal(&current.repository_path, &preflight.repository_path)
        {
            bail!("worktree removal identity changed after preflight");
        }
        let missing = preflight
            .blockers
            .iter()
            .any(|blocker| blocker.kind == WorktreeBlockerKind::MissingRegistration)
            && !path_entry_exists(&preflight.worktree_path);
        let mut checkout_removed = missing;
        if !missing {
            let native = scan_native_worktrees(&current.repository_path)?
                .into_iter()
                .find(|native| native.normalized_path == current.normalized_worktree_path)
                .ok_or_else(|| anyhow!("worktree Git registration changed after preflight"))?;
            if native.is_main
                || native.locked
                || native.git_dir_identity.is_empty()
                || current.git_dir_identity.is_empty()
                || native.git_dir_identity != current.git_dir_identity
            {
                bail!("worktree identity cannot be proven immediately before removal");
            }
            let current_branch = native.branch.clone().unwrap_or_default();
            if native.head != preflight.head || current_branch != preflight.branch {
                bail!("worktree branch or head changed after removal preflight");
            }
            let dirty_acknowledged = preflight
                .blockers
                .iter()
                .any(|blocker| blocker.kind == WorktreeBlockerKind::Dirty);
            let conflict_acknowledged = preflight
                .blockers
                .iter()
                .any(|blocker| blocker.kind == WorktreeBlockerKind::Conflicted);
            if ((native.dirty || native.untracked) && !dirty_acknowledged)
                || (native.has_conflicts && !conflict_acknowledged)
            {
                bail!("worktree status changed after removal preflight");
            }
            let force_git = request.force
                && preflight.blockers.iter().any(|blocker| {
                    matches!(
                        blocker.kind,
                        WorktreeBlockerKind::Dirty | WorktreeBlockerKind::Conflicted
                    )
                });
            let mut args = vec!["worktree", "remove"];
            if force_git {
                args.push("--force");
            }
            args.push(&preflight.worktree_path);
            git_write(&preflight.repository_path, args)?;
            checkout_removed = true;
        }

        let mut branch_deleted = false;
        let mut branch_preserved_reason = None;
        if request.delete_branch && !preflight.branch.is_empty() {
            let unpushed = preflight
                .blockers
                .iter()
                .any(|blocker| blocker.kind == WorktreeBlockerKind::Unpushed);
            let provider_merge_proven =
                request.provider_merged_head.as_deref() == Some(preflight.head.as_str());
            if unpushed && !provider_merge_proven {
                branch_preserved_reason =
                    Some("branch contains unpushed commits and was preserved".to_string());
            } else if preflight.head.is_empty() {
                branch_preserved_reason = Some("branch head identity is unavailable".to_string());
            } else {
                let branch_ref = format!("refs/heads/{}", preflight.branch);
                match git_write(
                    &preflight.repository_path,
                    [
                        "update-ref",
                        "-d",
                        branch_ref.as_str(),
                        preflight.head.as_str(),
                    ],
                ) {
                    Ok(_) => branch_deleted = true,
                    Err(error) => {
                        branch_preserved_reason = Some(bounded_error(&error.to_string()));
                    }
                }
            }
        }
        Ok(WorktreeRemovalResult {
            checkout_removed,
            branch_deleted,
            branch_preserved_reason,
            session_removed: false,
            metadata_removed: false,
        })
    }

    pub(crate) fn finalize_removal(
        &self,
        worktree_id: &str,
        expected_instance_id: &str,
    ) -> Result<()> {
        let changed = self.control.with_connection(|connection| {
            connection.execute(
                "DELETE FROM worktrees WHERE id=?1 AND instance_id=?2 AND lifecycle='removing'",
                params![worktree_id, expected_instance_id],
            )
        })?;
        if changed != 1 {
            bail!("worktree removal metadata compare-and-swap failed");
        }
        Ok(())
    }

    pub(crate) fn abort_removal(
        &self,
        worktree_id: &str,
        expected_instance_id: &str,
    ) -> Result<()> {
        let changed = self.control.with_connection(|connection| {
            connection.execute(
                "UPDATE worktrees SET lifecycle='active',updated_at=?1 WHERE id=?2 AND instance_id=?3 AND lifecycle='removing'",
                params![now_millis(), worktree_id, expected_instance_id],
            )
        })?;
        if changed != 1 {
            bail!("worktree removal abort compare-and-swap failed");
        }
        Ok(())
    }

    pub fn set(&self, request: WorktreeSetRequest) -> Result<WorktreeRecord> {
        let known = self.read_record(&request.worktree_id)?;
        require_instance(&known, &request.expected_instance_id)?;
        let repository = resolve_repository_identity(&known.repository_path)?;
        if repository.repository_id != known.repository_id
            || known.lifecycle != WorktreeLifecycle::Active
            || !known.exists
        {
            bail!("worktree metadata target is not a current active checkout");
        }
        let native_rows = scan_native_worktrees(&known.repository_path)?;
        let native = native_rows
            .iter()
            .find(|native| native.normalized_path == known.normalized_worktree_path)
            .ok_or_else(|| anyhow!("worktree metadata target is not registered with Git"))?;
        if native.git_dir_identity.is_empty() || native.git_dir_identity != known.git_dir_identity {
            bail!("worktree metadata target instance identity cannot be proven");
        }
        self.control.with_connection_mut(|connection| -> Result<WorktreeRecord> {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let current = read_record_connection(&transaction, &request.worktree_id)?;
            require_instance(&current, &request.expected_instance_id)?;
            let (parent_id, parent_instance, parent_session) = if request.clear_parent {
                (None, None, None)
            } else if let Some(parent_id) = request.parent_worktree_id.as_deref() {
                let parent = self.validated_parent_record(
                    &repository,
                    &native_rows,
                    &current.normalized_worktree_path,
                    read_record_connection(&transaction, parent_id)?,
                )?;
                let mut ancestor = parent.clone();
                loop {
                    if ancestor.id == current.id {
                        bail!("parent worktree assignment would create a lineage cycle");
                    }
                    let Some(next_id) = ancestor.parent_worktree_id.as_deref() else {
                        break;
                    };
                    let next = read_record_connection(&transaction, next_id)?;
                    if ancestor.parent_instance_id.as_deref() != Some(next.instance_id.as_str()) {
                        break;
                    }
                    if next.repository_id != current.repository_id {
                        bail!("parent worktree lineage crosses repository identity");
                    }
                    ancestor = next;
                }
                (Some(parent.id), Some(parent.instance_id), parent.session_id)
            } else {
                (current.parent_worktree_id.clone(), current.parent_instance_id.clone(), current.parent_session_id.clone())
            };
            let comment_present = request.comment.is_some();
            let review_target_present = request.review_target.is_some();
            let comment = request.comment.and_then(nonempty);
            let review_target = request.review_target.and_then(nonempty);
            let changed = transaction.execute(
                "UPDATE worktrees SET comment=CASE WHEN ?1<>0 THEN ?2 ELSE comment END,review_target=CASE WHEN ?3<>0 THEN ?4 ELSE review_target END,parent_worktree_id=?5,parent_instance_id=?6,parent_session_id=?7,updated_at=?8 WHERE id=?9 AND instance_id=?10",
                params![comment_present as i64, comment, review_target_present as i64, review_target, parent_id, parent_instance, parent_session, now_millis(), request.worktree_id, request.expected_instance_id],
            )?;
            if changed != 1 {
                bail!("worktree metadata compare-and-swap failed");
            }
            let updated = read_record_connection(&transaction, &request.worktree_id)?;
            transaction.commit()?;
            Ok(updated)
        })
    }

    pub fn checkpoint(&self, request: WorktreeCheckpointRequest) -> Result<WorktreeCheckpoint> {
        validate_checkpoint_kind(&request.kind)?;
        let record = self.read_record(&request.worktree_id)?;
        let repository = resolve_repository_identity(&record.repository_path)?;
        if repository.repository_id != record.repository_id {
            bail!("checkpoint repository identity changed");
        }
        if record.lifecycle == WorktreeLifecycle::Removing {
            bail!("checkpoint cannot be created while worktree removal is in progress");
        }
        let native = scan_native_worktrees(&record.repository_path)?
            .into_iter()
            .find(|native| native.normalized_path == record.normalized_worktree_path)
            .ok_or_else(|| anyhow!("checkpoint worktree is not registered with Git"))?;
        if native.git_dir_identity.is_empty() || native.git_dir_identity != record.git_dir_identity
        {
            bail!("checkpoint worktree instance changed");
        }
        update_record_from_native(&self.control, &record.id, &repository, &native)?;
        let checkpoint = WorktreeCheckpoint {
            id: Uuid::new_v4().to_string(),
            worktree_id: record.id,
            kind: request.kind,
            label: required_text(&request.label, "checkpoint label")?,
            head: native.head,
            comment: request.comment.and_then(nonempty),
            created_at: now_millis(),
        };
        self.control.with_connection(|connection| {
            connection.execute(
                "INSERT INTO worktree_checkpoints(id,worktree_id,kind,label,head,comment,created_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",
                params![checkpoint.id, checkpoint.worktree_id, checkpoint.kind, checkpoint.label, checkpoint.head, checkpoint.comment, checkpoint.created_at],
            )
        })?;
        Ok(checkpoint)
    }

    pub fn list_checkpoints(&self, worktree_id: &str) -> Result<Vec<WorktreeCheckpoint>> {
        self.control.with_connection(|connection| -> Result<Vec<WorktreeCheckpoint>> {
            let mut statement = connection.prepare("SELECT id,worktree_id,kind,label,head,comment,created_at FROM worktree_checkpoints WHERE worktree_id=?1 ORDER BY created_at,id")?;
            let rows = statement.query_map([worktree_id], |row| Ok(WorktreeCheckpoint {
                id: row.get(0)?, worktree_id: row.get(1)?, kind: row.get(2)?, label: row.get(3)?, head: row.get(4)?, comment: row.get(5)?, created_at: nonnegative(row.get::<_, i64>(6)?),
            }))?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    pub fn put_review_comment(
        &self,
        request: WorktreeReviewCommentRequest,
    ) -> Result<WorktreeReviewComment> {
        let record = self.read_record(&request.worktree_id)?;
        require_instance(&record, &request.expected_instance_id)?;
        let now = now_millis();
        let base_head = required_text(&request.base_head, "base head")?;
        let head = required_text(&request.head, "head")?;
        let path = required_text(&request.path, "comment path")?;
        let side = required_text(&request.side, "comment side")?;
        let hunk_id = request.hunk_id.and_then(nonempty);
        let body = required_text(&request.body, "comment body")?;
        let range_json = request.range.as_ref().map(Value::to_string);
        self.control.with_connection_mut(|connection| -> Result<WorktreeReviewComment> {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let existing = transaction.query_row(
                "SELECT id,created_at FROM worktree_review_comments WHERE worktree_id=?1 AND instance_id=?2 AND base_head=?3 AND head=?4 AND path=?5 AND side=?6 AND line IS ?7 AND range_json IS ?8 AND hunk_id IS ?9 ORDER BY created_at,id LIMIT 1",
                params![record.id, record.instance_id, base_head, head, path, side, request.line, range_json, hunk_id],
                |row| Ok((row.get::<_, String>(0)?, nonnegative(row.get::<_, i64>(1)?))),
            ).optional()?;
            let existed = existing.is_some();
            let (id, created_at) = existing.unwrap_or_else(|| (Uuid::new_v4().to_string(), now));
            let comment = WorktreeReviewComment {
                id,
                worktree_id: record.id,
                instance_id: record.instance_id,
                base_head,
                head,
                path,
                side,
                line: request.line,
                range: request.range,
                hunk_id,
                body,
                created_at,
                updated_at: now,
            };
            if existed {
                transaction.execute(
                    "UPDATE worktree_review_comments SET body=?1,updated_at=?2 WHERE id=?3",
                    params![comment.body, comment.updated_at, comment.id],
                )?;
                transaction.execute(
                    "DELETE FROM worktree_review_comments WHERE id<>?1 AND worktree_id=?2 AND instance_id=?3 AND base_head=?4 AND head=?5 AND path=?6 AND side=?7 AND line IS ?8 AND range_json IS ?9 AND hunk_id IS ?10",
                    params![comment.id, comment.worktree_id, comment.instance_id, comment.base_head, comment.head, comment.path, comment.side, comment.line, range_json, comment.hunk_id],
                )?;
            } else {
                transaction.execute(
                    "INSERT INTO worktree_review_comments(id,worktree_id,instance_id,base_head,head,path,side,line,range_json,hunk_id,body,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                    params![comment.id, comment.worktree_id, comment.instance_id, comment.base_head, comment.head, comment.path, comment.side, comment.line, range_json, comment.hunk_id, comment.body, comment.created_at, comment.updated_at],
                )?;
            }
            transaction.commit()?;
            Ok(comment)
        })
    }

    pub fn list_review_comments(&self, worktree_id: &str) -> Result<Vec<WorktreeReviewComment>> {
        self.control.with_connection(|connection| -> Result<Vec<WorktreeReviewComment>> {
            let mut statement = connection.prepare("SELECT id,worktree_id,instance_id,base_head,head,path,side,line,range_json,hunk_id,body,created_at,updated_at FROM worktree_review_comments WHERE worktree_id=?1 ORDER BY created_at,id")?;
            let rows = statement.query_map([worktree_id], |row| {
                let range: Option<String> = row.get(8)?;
                Ok(WorktreeReviewComment {
                    id: row.get(0)?, worktree_id: row.get(1)?, instance_id: row.get(2)?, base_head: row.get(3)?, head: row.get(4)?, path: row.get(5)?, side: row.get(6)?, line: row.get::<_, Option<i64>>(7)?.map(nonnegative).map(|value| value as u32), range: range.and_then(|value| serde_json::from_str(&value).ok()), hunk_id: row.get(9)?, body: row.get(10)?, created_at: nonnegative(row.get::<_, i64>(11)?), updated_at: nonnegative(row.get::<_, i64>(12)?),
                })
            })?.collect::<rusqlite::Result<Vec<_>>>()?;
            Ok(rows)
        })
    }

    /// Registers and returns the cancellation flag a running operation polls.
    /// Calling it again for the same operation returns the same flag, so a
    /// cancel that arrived before the operation claimed its flag still lands.
    pub(crate) fn cancellation_flag(&self, operation_id: Uuid) -> Arc<AtomicBool> {
        Arc::clone(
            lock_cancellation_flags()
                .entry(operation_id)
                .or_insert_with(|| Arc::new(AtomicBool::new(false))),
        )
    }

    /// Drops the live flag once an operation has settled. The durable row keeps
    /// the outcome, so nothing is lost by forgetting the in-process signal.
    pub(crate) fn clear_cancellation(&self, operation_id: Uuid) {
        lock_cancellation_flags().remove(&operation_id);
    }

    /// Signals cancellation for a running operation. Returns false when no
    /// operation with that id is running in this process, so a caller can tell
    /// "asked too late" from "cancellation requested".
    pub(crate) fn request_cancel(&self, operation_id: Uuid) -> Result<bool> {
        let running = self.control.with_connection(|connection| {
            connection
                .query_row(
                    "SELECT 1 FROM worktree_operations WHERE operation_id=?1 AND status='running'",
                    [operation_id.to_string()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
        })?;
        if running.is_none() {
            return Ok(false);
        }
        let flag = lock_cancellation_flags().get(&operation_id).map(Arc::clone);
        match flag {
            Some(flag) => {
                flag.store(true, Ordering::SeqCst);
                Ok(true)
            }
            None => Ok(false),
        }
    }

    pub(crate) fn claim_operation<T: Serialize>(
        &self,
        operation_id: Uuid,
        kind: &str,
        request: &T,
    ) -> Result<WorktreeOperationClaim> {
        let request_json = serde_json::to_string(request)?;
        let request_hash = digest_hex(request_json.as_bytes());
        self.control.with_connection_mut(|connection| -> Result<WorktreeOperationClaim> {
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let stored = transaction.query_row(
                "SELECT request_hash,result_json,error FROM worktree_operations WHERE operation_id=?1",
                [operation_id.to_string()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?, row.get::<_, Option<String>>(2)?)),
            ).optional()?;
            if let Some((stored_hash, result_json, error)) = stored {
                if stored_hash != request_hash {
                    bail!("operation id conflict");
                }
                transaction.commit()?;
                return Ok(WorktreeOperationClaim::Replay { result_json, error });
            }
            let now = now_millis();
            transaction.execute(
                "INSERT INTO worktree_operations(operation_id,kind,stage,status,request_hash,request_json,created_at,updated_at) VALUES(?1,?2,'validating','running',?3,?4,?5,?5)",
                params![operation_id.to_string(), kind, request_hash, request_json, now],
            )?;
            transaction.commit()?;
            Ok(WorktreeOperationClaim::Claimed)
        })
    }

    pub(crate) fn operation_stage(&self, operation_id: Uuid, stage: &str) -> Result<()> {
        validate_operation_stage(stage)?;
        self.control.with_connection(|connection| connection.execute(
            "UPDATE worktree_operations SET stage=?1,updated_at=?2 WHERE operation_id=?3 AND status='running'",
            params![stage, now_millis(), operation_id.to_string()],
        ))?;
        Ok(())
    }

    pub(crate) fn complete_operation<T: Serialize>(
        &self,
        operation_id: Uuid,
        result: &T,
    ) -> Result<()> {
        let now = now_millis();
        let result_json = serde_json::to_string(result)?;
        let changed = self.control.with_connection(|connection| connection.execute(
            "UPDATE worktree_operations SET stage='complete',status='completed',result_json=?1,error=NULL,updated_at=?2,completed_at=?2 WHERE operation_id=?3 AND status='running'",
            params![result_json, now, operation_id.to_string()],
        ))?;
        if changed != 1 {
            bail!("worktree operation is not running");
        }
        Ok(())
    }

    pub(crate) fn fail_operation(
        &self,
        operation_id: Uuid,
        stage: &str,
        error: &str,
    ) -> Result<()> {
        validate_operation_stage(stage)?;
        let status = if stage == "cancelled" {
            "cancelled"
        } else {
            "failed"
        };
        let now = now_millis();
        self.control.with_connection(|connection| connection.execute(
            "UPDATE worktree_operations SET stage=?1,status=?2,error=?3,updated_at=?4,completed_at=?4 WHERE operation_id=?5 AND status='running'",
            params![stage, status, bounded_error(error), now, operation_id.to_string()],
        ))?;
        Ok(())
    }

    pub(crate) fn register_created(
        &self,
        repository: &RepositoryIdentity,
        native: &NativeWorktree,
        request: &WorktreeCreateRequest,
        session_id: Option<String>,
    ) -> Result<WorktreeRecord> {
        let native_rows = scan_native_worktrees(&repository.repository_path)?;
        let parent = if let Some(parent_id) = request.parent_worktree_id.as_deref() {
            let parent = self.read_record(parent_id)?;
            Some(self.validated_parent_record(
                repository,
                &native_rows,
                &native.normalized_path,
                parent,
            )?)
        } else {
            self.validated_parent_for_session(
                repository,
                &native_rows,
                &native.normalized_path,
                Some(&request.parent_session_id),
            )?
        };
        self.insert_native_record(
            repository,
            native,
            session_id,
            Some(request.parent_session_id.clone()),
            parent.as_ref(),
            request.origin,
            &request.setup_policy,
            request.sparse_preset.clone(),
            request.linked_files.clone(),
            request.initial_agent.clone(),
            request.initial_prompt.clone(),
            &request.start_ref,
        )
    }

    pub(crate) fn bind_session(
        &self,
        worktree_id: &str,
        expected_instance_id: &str,
        session_id: &str,
    ) -> Result<WorktreeRecord> {
        let changed = self.control.with_connection(|connection| {
            connection.execute(
                "UPDATE worktrees SET session_id=?1,updated_at=?2 WHERE id=?3 AND instance_id=?4",
                params![session_id, now_millis(), worktree_id, expected_instance_id],
            )
        })?;
        if changed != 1 {
            bail!("worktree session compare-and-swap failed");
        }
        self.read_record(worktree_id)
    }

    pub(crate) fn compare_and_swap_path(
        &self,
        worktree_id: &str,
        expected_instance_id: &str,
        expected_path: &str,
        native: &NativeWorktree,
    ) -> Result<WorktreeRecord> {
        let changed = self.control.with_connection(|connection| connection.execute(
            "UPDATE worktrees SET worktree_path=?1,normalized_worktree_path=?2,git_dir_identity=?3,head=?4,branch=?5,updated_at=?6,last_activity_at=?6 WHERE id=?7 AND instance_id=?8 AND normalized_worktree_path=?9",
            params![native.worktree_path, native.normalized_path, native.git_dir_identity, native.head, native.branch.clone().unwrap_or_default(), now_millis(), worktree_id, expected_instance_id, normalize_path_for_comparison(expected_path)],
        ))?;
        if changed != 1 {
            bail!("worktree path compare-and-swap failed");
        }
        self.read_record(worktree_id)
    }

    pub(crate) fn remove_metadata_if_instance(
        &self,
        worktree_id: &str,
        expected_instance_id: &str,
    ) -> Result<bool> {
        Ok(self.control.with_connection(|connection| {
            connection.execute(
                "DELETE FROM worktrees WHERE id=?1 AND instance_id=?2",
                params![worktree_id, expected_instance_id],
            )
        })? == 1)
    }

    pub fn read_record(&self, worktree_id: &str) -> Result<WorktreeRecord> {
        self.control
            .with_connection(|connection| read_record_connection(connection, worktree_id))
    }

    fn read_records(&self, repository_id: Option<&str>) -> Result<Vec<WorktreeRecord>> {
        self.control.with_connection(|connection| -> Result<Vec<WorktreeRecord>> {
            let sql = if repository_id.is_some() {
                format!("SELECT {WORKTREE_COLUMNS} FROM worktrees WHERE repository_id=?1 ORDER BY created_at,id")
            } else {
                format!("SELECT {WORKTREE_COLUMNS} FROM worktrees ORDER BY created_at,id")
            };
            let mut statement = connection.prepare(&sql)?;
            let records = if let Some(repository_id) = repository_id {
                statement.query_map([repository_id], worktree_record_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?
            } else {
                statement.query_map([], worktree_record_from_row)?.collect::<rusqlite::Result<Vec<_>>>()?
            };
            Ok(records)
        })
    }

    fn read_record_by_path(
        &self,
        repository_id: &str,
        normalized_path: &str,
    ) -> Result<Option<WorktreeRecord>> {
        self.control.with_connection(|connection| {
            connection.query_row(
                &format!("SELECT {WORKTREE_COLUMNS} FROM worktrees WHERE repository_id=?1 AND normalized_worktree_path=?2"),
                params![repository_id, normalized_path],
                worktree_record_from_row,
            ).optional().map_err(Into::into)
        })
    }

    fn read_record_by_session(&self, session_id: &str) -> Result<Option<WorktreeRecord>> {
        self.control.with_connection(|connection| {
            connection.query_row(
                &format!("SELECT {WORKTREE_COLUMNS} FROM worktrees WHERE session_id=?1 ORDER BY created_at LIMIT 1"),
                [session_id],
                worktree_record_from_row,
            ).optional().map_err(Into::into)
        })
    }

    fn reconcile_scan(
        &self,
        repository: RepositoryIdentity,
        native: Vec<NativeWorktree>,
    ) -> Result<Vec<WorktreeProjection>> {
        let records = self.read_records(Some(&repository.repository_id))?;
        let all_records = self.read_records(None)?;
        let mut by_path = records
            .iter()
            .enumerate()
            .map(|(index, record)| (record.normalized_worktree_path.clone(), index))
            .collect::<HashMap<_, _>>();
        let foreign_paths = all_records
            .iter()
            .filter(|record| record.repository_id != repository.repository_id)
            .map(|record| record.normalized_worktree_path.clone())
            .collect::<HashSet<_>>();
        let mut projections = Vec::new();
        let mut matched = HashSet::new();
        for native in native {
            if foreign_paths.contains(&native.normalized_path) {
                projections.push(WorktreeProjection {
                    id: external_projection_id(
                        &repository.repository_id,
                        &native.normalized_path,
                        &native.git_dir_identity,
                    ),
                    instance_id: None,
                    state: WorktreeReconcileState::Conflicted,
                    record: None,
                    native: Some(native),
                    parent_worktree_id: None,
                    child_worktree_ids: Vec::new(),
                });
                continue;
            }
            let Some(index) = by_path.remove(&native.normalized_path) else {
                projections.push(WorktreeProjection {
                    id: external_projection_id(
                        &repository.repository_id,
                        &native.normalized_path,
                        &native.git_dir_identity,
                    ),
                    instance_id: None,
                    state: if native.git_dir_identity.is_empty() {
                        WorktreeReconcileState::Untrusted
                    } else {
                        WorktreeReconcileState::External
                    },
                    record: None,
                    native: Some(native),
                    parent_worktree_id: None,
                    child_worktree_ids: Vec::new(),
                });
                continue;
            };
            let record = records[index].clone();
            matched.insert(record.id.clone());
            projections.push(self.reconcile_matched_record(&repository, record, native)?);
        }
        for record in records
            .into_iter()
            .filter(|record| !matched.contains(&record.id))
        {
            let path_exists = path_entry_exists(&record.worktree_path);
            let state = if is_remote_path(&record.worktree_path) {
                WorktreeReconcileState::Untrusted
            } else if path_exists {
                match resolve_repository_identity(&record.worktree_path) {
                    Ok(identity) if identity.repository_id != record.repository_id => {
                        WorktreeReconcileState::Conflicted
                    }
                    _ => WorktreeReconcileState::Stale,
                }
            } else {
                WorktreeReconcileState::Missing
            };
            let lifecycle = if record.lifecycle == WorktreeLifecycle::Removing {
                WorktreeLifecycle::Removing
            } else {
                match state {
                    WorktreeReconcileState::Missing => WorktreeLifecycle::Missing,
                    WorktreeReconcileState::Stale => WorktreeLifecycle::Stale,
                    WorktreeReconcileState::Conflicted | WorktreeReconcileState::Untrusted => {
                        WorktreeLifecycle::Conflicted
                    }
                    _ => record.lifecycle,
                }
            };
            if record.lifecycle != WorktreeLifecycle::Removing {
                self.control.with_connection(|connection| {
                    connection.execute(
                        "UPDATE worktrees SET lifecycle=?1,\"exists\"=?2,updated_at=?3 WHERE id=?4 AND lifecycle<>'removing'",
                        params![lifecycle_text(lifecycle), path_exists as i64, now_millis(), record.id],
                    )
                })?;
            }
            projections.push(projection_for_record(
                WorktreeRecord {
                    lifecycle,
                    exists: path_exists,
                    ..record
                },
                state,
                None,
            ));
        }
        apply_lineage(&mut projections);
        Ok(projections)
    }

    fn reconcile_matched_record(
        &self,
        repository: &RepositoryIdentity,
        record: WorktreeRecord,
        native: NativeWorktree,
    ) -> Result<WorktreeProjection> {
        if record.lifecycle == WorktreeLifecycle::Removing {
            let state = if native.git_dir_identity.is_empty() {
                WorktreeReconcileState::Untrusted
            } else if record.git_dir_identity == native.git_dir_identity {
                WorktreeReconcileState::Managed
            } else {
                WorktreeReconcileState::Conflicted
            };
            return Ok(projection_for_record(record, state, Some(native)));
        }
        if native.git_dir_identity.is_empty() {
            self.set_reconcile_lifecycle(&record.id, WorktreeLifecycle::Conflicted)?;
            return Ok(projection_for_record(
                WorktreeRecord {
                    lifecycle: WorktreeLifecycle::Conflicted,
                    ..record
                },
                WorktreeReconcileState::Untrusted,
                Some(native),
            ));
        }
        if matches!(
            record.lifecycle,
            WorktreeLifecycle::Missing | WorktreeLifecycle::Stale | WorktreeLifecycle::Failed
        ) {
            let new_instance_id = Uuid::new_v4().to_string();
            let changed = self.control.with_connection(|connection| connection.execute(
                "UPDATE worktrees SET instance_id=?1,session_id=NULL,parent_session_id=NULL,parent_worktree_id=NULL,parent_instance_id=NULL,git_dir_identity=?2,worktree_path=?3,repository_path=?4,normalized_repository_path=?5,normalized_worktree_path=?6,branch=?7,head=?8,lifecycle='active',locked=?9,lock_reason=?10,prunable=?11,prunable_reason=?12,dirty=?13,untracked=?14,has_conflicts=?15,ahead=?16,behind=?17,\"exists\"=?18,updated_at=?19,last_activity_at=?19 WHERE id=?20 AND lifecycle IN ('missing','stale','failed')",
                params![new_instance_id, native.git_dir_identity, native.worktree_path, repository.repository_path, normalize_path_for_comparison(&repository.repository_path), native.normalized_path, native.branch.clone().unwrap_or_default(), native.head, native.locked as i64, native.lock_reason, native.prunable as i64, native.prunable_reason, native.dirty as i64, native.untracked as i64, native.has_conflicts as i64, native.ahead as i64, native.behind as i64, native.exists as i64, now_millis(), record.id],
            ))?;
            if changed != 1 {
                bail!("worktree instance changed during reconciliation");
            }
            return Ok(projection_for_record(
                self.read_record(&record.id)?,
                WorktreeReconcileState::Managed,
                Some(native),
            ));
        }
        if record.git_dir_identity == native.git_dir_identity {
            update_record_from_native(&self.control, &record.id, repository, &native)?;
            return Ok(projection_for_record(
                self.read_record(&record.id)?,
                WorktreeReconcileState::Managed,
                Some(native),
            ));
        }
        self.set_reconcile_lifecycle(&record.id, WorktreeLifecycle::Conflicted)?;
        Ok(projection_for_record(
            WorktreeRecord {
                lifecycle: WorktreeLifecycle::Conflicted,
                ..record
            },
            WorktreeReconcileState::Conflicted,
            Some(native),
        ))
    }

    fn set_reconcile_lifecycle(&self, id: &str, lifecycle: WorktreeLifecycle) -> Result<()> {
        self.control.with_connection(|connection| {
            connection.execute(
                "UPDATE worktrees SET lifecycle=?1,updated_at=?2 WHERE id=?3 AND lifecycle<>'removing'",
                params![lifecycle_text(lifecycle), now_millis(), id],
            )
        })?;
        Ok(())
    }

    fn insert_native_record(
        &self,
        repository: &RepositoryIdentity,
        native: &NativeWorktree,
        session_id: Option<String>,
        parent_session_id: Option<String>,
        parent: Option<&WorktreeRecord>,
        origin: WorktreeOrigin,
        setup_policy: &str,
        sparse_preset: Option<String>,
        linked_files: Vec<String>,
        initial_agent: Option<String>,
        initial_prompt: Option<String>,
        base_ref: &str,
    ) -> Result<WorktreeRecord> {
        validate_setup_policy(setup_policy)?;
        let id = Uuid::new_v4().to_string();
        let instance_id = Uuid::new_v4().to_string();
        let now = now_millis();
        let linked_files_json = serde_json::to_string(&linked_files)?;
        self.control.with_connection(|connection| connection.execute(
            "INSERT INTO worktrees(id,instance_id,repository_id,repository_path,worktree_path,branch,head,base_ref,session_id,parent_session_id,parent_worktree_id,parent_instance_id,origin,lifecycle,locked,lock_reason,prunable,prunable_reason,dirty,untracked,has_conflicts,ahead,behind,\"exists\",setup_policy,sparse_preset,linked_files_json,initial_agent,initial_prompt,created_at,updated_at,last_activity_at,normalized_repository_path,normalized_worktree_path,git_dir_identity) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,'active',?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25,?26,?27,?28,?29,?29,?29,?30,?31,?32)",
            params![id, instance_id, repository.repository_id, repository.repository_path, native.worktree_path, native.branch.clone().unwrap_or_default(), native.head, base_ref, session_id, parent_session_id, parent.map(|value| value.id.clone()), parent.map(|value| value.instance_id.clone()), origin_text(origin), native.locked as i64, native.lock_reason, native.prunable as i64, native.prunable_reason, native.dirty as i64, native.untracked as i64, native.has_conflicts as i64, native.ahead as i64, native.behind as i64, native.exists as i64, setup_policy, sparse_preset, linked_files_json, initial_agent, initial_prompt, now, normalize_path_for_comparison(&repository.repository_path), native.normalized_path, native.git_dir_identity],
        ))?;
        self.read_record(&id)
    }

    fn import_legacy_rows(
        &self,
        repository: &RepositoryIdentity,
        native: &[NativeWorktree],
        rows: &[LegacyWorktreeRow],
    ) -> Result<()> {
        let main_native = native.iter().find(|entry| entry.is_main);
        for row in rows {
            if self.read_record_by_session(&row.session_id)?.is_some() {
                continue;
            }
            let normalized = normalize_path_for_comparison(&row.worktree_path);
            let base_ref =
                proven_commit_id(&repository.repository_path, &row.start_ref)?.unwrap_or_default();
            let mut source_proven = false;
            let parent = if let Some(parent) = self
                .read_record_by_session(&row.parent_session_id)?
                .filter(|parent| {
                    parent.repository_id == repository.repository_id
                        && parent.normalized_worktree_path != normalized
                        && parent.lifecycle == WorktreeLifecycle::Active
                        && parent.exists
                        && !parent.git_dir_identity.is_empty()
                        && native.iter().any(|entry| {
                            entry.normalized_path == parent.normalized_worktree_path
                                && !entry.git_dir_identity.is_empty()
                                && entry.git_dir_identity == parent.git_dir_identity
                        })
                }) {
                source_proven = true;
                Some(parent)
            } else if repository_path_belongs_to_identity(&row.source_workspace_folder, repository)
            {
                source_proven = true;
                if let Some(main) = main_native {
                    if let Some(mut existing) =
                        self.read_record_by_path(&repository.repository_id, &main.normalized_path)?
                    {
                        if existing.git_dir_identity.is_empty()
                            || existing.git_dir_identity != main.git_dir_identity
                        {
                            source_proven = false;
                            None
                        } else if existing.session_id.as_deref()
                            == Some(row.parent_session_id.as_str())
                        {
                            Some(existing)
                        } else if existing.session_id.is_none() {
                            self.control.with_connection(|connection| {
                                connection.execute(
                                    "UPDATE worktrees SET session_id=?1,updated_at=?2 WHERE id=?3 AND instance_id=?4 AND session_id IS NULL",
                                    params![row.parent_session_id, now_millis(), existing.id, existing.instance_id],
                                )
                            })?;
                            existing.session_id = Some(row.parent_session_id.clone());
                            Some(existing)
                        } else {
                            source_proven = false;
                            None
                        }
                    } else {
                        Some(self.insert_native_record(
                            repository,
                            main,
                            Some(row.parent_session_id.clone()),
                            None,
                            None,
                            WorktreeOrigin::Manual,
                            "inherit",
                            None,
                            Vec::new(),
                            None,
                            None,
                            &main.head,
                        )?)
                    }
                } else {
                    source_proven = false;
                    None
                }
            } else {
                None
            };
            let matching_native = native
                .iter()
                .find(|entry| entry.normalized_path == normalized);
            if source_proven {
                if let Some(native) = matching_native {
                    self.insert_native_record(
                        repository,
                        native,
                        Some(row.session_id.clone()),
                        Some(row.parent_session_id.clone()),
                        parent.as_ref(),
                        WorktreeOrigin::Manual,
                        "inherit",
                        None,
                        Vec::new(),
                        None,
                        None,
                        &base_ref,
                    )?;
                    continue;
                }
            }
            let now = row.created_at.max(1);
            let lifecycle = if source_proven { "stale" } else { "conflicted" };
            self.control.with_connection(|connection| connection.execute(
                "INSERT OR IGNORE INTO worktrees(id,instance_id,repository_id,repository_path,worktree_path,branch,head,base_ref,session_id,parent_session_id,parent_worktree_id,parent_instance_id,origin,lifecycle,created_at,updated_at,last_activity_at,normalized_repository_path,normalized_worktree_path,git_dir_identity) VALUES(?1,?2,?3,?4,?5,?6,'',?7,?8,?9,?10,?11,'manual',?12,?13,?13,?13,?14,?15,'')",
                params![Uuid::new_v4().to_string(), Uuid::new_v4().to_string(), repository.repository_id, repository.repository_path, row.worktree_path, row.branch, base_ref, row.session_id, row.parent_session_id, parent.as_ref().map(|value| value.id.clone()), parent.as_ref().map(|value| value.instance_id.clone()), lifecycle, now, normalize_path_for_comparison(&repository.repository_path), normalized],
            ))?;
        }
        Ok(())
    }

    fn validated_parent_for_session(
        &self,
        repository: &RepositoryIdentity,
        native_rows: &[NativeWorktree],
        child_normalized_path: &str,
        parent_session_id: Option<&str>,
    ) -> Result<Option<WorktreeRecord>> {
        let Some(parent_session_id) = parent_session_id else {
            return Ok(None);
        };
        let Some(parent) = self.read_record_by_session(parent_session_id)? else {
            return Ok(None);
        };
        self.validated_parent_record(repository, native_rows, child_normalized_path, parent)
            .map(Some)
    }

    fn validated_parent_record(
        &self,
        repository: &RepositoryIdentity,
        native_rows: &[NativeWorktree],
        child_normalized_path: &str,
        parent: WorktreeRecord,
    ) -> Result<WorktreeRecord> {
        if parent.repository_id != repository.repository_id
            || parent.normalized_worktree_path == child_normalized_path
            || parent.lifecycle != WorktreeLifecycle::Active
            || !parent.exists
            || parent.git_dir_identity.is_empty()
        {
            bail!("parent does not identify a current checkout in the same repository");
        }
        let parent_native = native_rows
            .iter()
            .find(|native| native.normalized_path == parent.normalized_worktree_path)
            .ok_or_else(|| anyhow!("parent worktree is not registered with Git"))?;
        if parent_native.git_dir_identity.is_empty()
            || parent_native.git_dir_identity != parent.git_dir_identity
        {
            bail!("parent worktree instance identity cannot be proven");
        }
        Ok(parent)
    }

    fn hidden_external(&self, projection: &WorktreeProjection) -> bool {
        if projection.record.is_some() {
            return false;
        }
        let Some(native) = projection.native.as_ref() else {
            return false;
        };
        let scratch = self
            .control
            .data_dir()
            .join("automation-artifacts")
            .join("worktrees");
        path_starts_with(&native.worktree_path, &scratch)
    }
}

fn update_record_from_native(
    control: &ControlPlane,
    id: &str,
    repository: &RepositoryIdentity,
    native: &NativeWorktree,
) -> Result<()> {
    control.with_connection(|connection| connection.execute(
        "UPDATE worktrees SET repository_path=?1,worktree_path=?2,branch=?3,head=?4,lifecycle='active',locked=?5,lock_reason=?6,prunable=?7,prunable_reason=?8,dirty=?9,untracked=?10,has_conflicts=?11,ahead=?12,behind=?13,\"exists\"=?14,updated_at=?15,normalized_repository_path=?16,normalized_worktree_path=?17,git_dir_identity=?18 WHERE id=?19 AND lifecycle<>'removing'",
        params![repository.repository_path, native.worktree_path, native.branch.clone().unwrap_or_default(), native.head, native.locked as i64, native.lock_reason, native.prunable as i64, native.prunable_reason, native.dirty as i64, native.untracked as i64, native.has_conflicts as i64, native.ahead as i64, native.behind as i64, native.exists as i64, now_millis(), normalize_path_for_comparison(&repository.repository_path), native.normalized_path, native.git_dir_identity, id],
    ))?;
    Ok(())
}

fn read_record_connection(
    connection: &rusqlite::Connection,
    worktree_id: &str,
) -> Result<WorktreeRecord> {
    connection
        .query_row(
            &format!("SELECT {WORKTREE_COLUMNS} FROM worktrees WHERE id=?1"),
            [worktree_id],
            worktree_record_from_row,
        )
        .optional()?
        .ok_or_else(|| anyhow!("worktree not found: {worktree_id}"))
}

fn worktree_record_from_row(row: &Row<'_>) -> rusqlite::Result<WorktreeRecord> {
    let linked: String = row.get(26)?;
    Ok(WorktreeRecord {
        id: row.get(0)?,
        instance_id: row.get(1)?,
        repository_id: row.get(2)?,
        repository_path: row.get(3)?,
        worktree_path: row.get(4)?,
        branch: row.get(5)?,
        head: row.get(6)?,
        base_ref: row.get(7)?,
        session_id: row.get(8)?,
        parent_session_id: row.get(9)?,
        parent_worktree_id: row.get(10)?,
        parent_instance_id: row.get(11)?,
        origin: parse_origin(&row.get::<_, String>(12)?),
        lifecycle: parse_lifecycle(&row.get::<_, String>(13)?),
        locked: row.get::<_, i64>(14)? != 0,
        lock_reason: row.get(15)?,
        prunable: row.get::<_, i64>(16)? != 0,
        prunable_reason: row.get(17)?,
        dirty: row.get::<_, i64>(18)? != 0,
        untracked: row.get::<_, i64>(19)? != 0,
        has_conflicts: row.get::<_, i64>(20)? != 0,
        ahead: nonnegative(row.get(21)?),
        behind: nonnegative(row.get(22)?),
        exists: row.get::<_, i64>(23)? != 0,
        setup_policy: row.get(24)?,
        sparse_preset: row.get(25)?,
        linked_files: serde_json::from_str(&linked).unwrap_or_default(),
        initial_agent: row.get(27)?,
        initial_prompt: row.get(28)?,
        comment: row.get(29)?,
        review_target: row.get(30)?,
        created_at: nonnegative(row.get(31)?),
        updated_at: nonnegative(row.get(32)?),
        last_activity_at: nonnegative(row.get(33)?),
        normalized_repository_path: row.get(34)?,
        normalized_worktree_path: row.get(35)?,
        git_dir_identity: row.get(36)?,
    })
}

fn projection_for_record(
    record: WorktreeRecord,
    state: WorktreeReconcileState,
    native: Option<NativeWorktree>,
) -> WorktreeProjection {
    WorktreeProjection {
        id: record.id.clone(),
        instance_id: Some(record.instance_id.clone()),
        parent_worktree_id: record.parent_worktree_id.clone(),
        record: Some(record),
        state,
        native,
        child_worktree_ids: Vec::new(),
    }
}

fn apply_lineage(projections: &mut [WorktreeProjection]) {
    let current = projections
        .iter()
        .filter_map(|projection| {
            let record = projection.record.as_ref()?;
            let native = projection.native.as_ref()?;
            (projection.state == WorktreeReconcileState::Managed
                && projection.instance_id.as_deref() == Some(record.instance_id.as_str())
                && record.exists
                && native.exists
                && !native.git_dir_identity.is_empty()
                && native.git_dir_identity == record.git_dir_identity)
                .then(|| (record.id.clone(), record.clone()))
        })
        .collect::<HashMap<_, _>>();
    let mut parent_by_child = HashMap::new();
    for projection in projections.iter() {
        let Some(record) = projection.record.as_ref() else {
            continue;
        };
        if !current.contains_key(&record.id) {
            continue;
        }
        let Some(parent_id) = record.parent_worktree_id.as_ref() else {
            continue;
        };
        let Some(parent) = current.get(parent_id) else {
            continue;
        };
        if parent.id == record.id
            || parent.repository_id != record.repository_id
            || record.parent_instance_id.as_deref() != Some(parent.instance_id.as_str())
        {
            continue;
        }
        parent_by_child.insert(record.id.clone(), parent.id.clone());
    }
    let mut cycle_nodes = HashSet::new();
    for start in parent_by_child.keys() {
        let mut positions = HashMap::new();
        let mut path = Vec::new();
        let mut cursor = start.as_str();
        while let Some(parent) = parent_by_child.get(cursor) {
            if let Some(position) = positions.get(cursor).copied() {
                cycle_nodes.extend(path[position..].iter().cloned());
                break;
            }
            positions.insert(cursor.to_string(), path.len());
            path.push(cursor.to_string());
            cursor = parent;
        }
    }
    parent_by_child
        .retain(|child, parent| !cycle_nodes.contains(child) && !cycle_nodes.contains(parent));
    let mut children: HashMap<String, Vec<String>> = HashMap::new();
    for (child, parent) in &parent_by_child {
        children
            .entry(parent.clone())
            .or_default()
            .push(child.clone());
    }
    for values in children.values_mut() {
        values.sort();
    }
    for projection in projections {
        projection.parent_worktree_id = parent_by_child.get(&projection.id).cloned();
        projection.child_worktree_ids = children.remove(&projection.id).unwrap_or_default();
    }
}

fn validate_removal_acknowledgements(
    request: &WorktreeRemoveRequest,
    preflight: &WorktreeRemovalPreflight,
) -> Result<()> {
    if let Some(blocker) = preflight.blockers.iter().find(|blocker| blocker.hard) {
        bail!("removal blocked by {:?}: {}", blocker.kind, blocker.message);
    }
    let provider_merge_proven = provider_merge_proven(request, preflight)?;
    let forceable = preflight
        .blockers
        .iter()
        .filter(|blocker| {
            !blocker.hard
                && !matches!(blocker.kind, WorktreeBlockerKind::MissingRegistration)
                && !(blocker.kind == WorktreeBlockerKind::Unpushed && provider_merge_proven)
        })
        .map(|blocker| blocker.kind)
        .collect::<HashSet<_>>();
    if !forceable.is_empty() && !request.force {
        bail!("force is required for removal blockers");
    }
    for blocker in forceable {
        if !request.acknowledged_blockers.contains(&blocker) {
            bail!("removal blocker was not acknowledged: {:?}", blocker);
        }
    }
    Ok(())
}

fn proven_commit_id(repository_path: &str, candidate: &str) -> Result<Option<String>> {
    let candidate = candidate.trim();
    if !matches!(candidate.len(), 40 | 64)
        || !candidate.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Ok(None);
    }
    let commit_ref = format!("{candidate}^{{commit}}");
    let Some(output) = git_read_allow_fail(
        repository_path,
        ["rev-parse", "--verify", commit_ref.as_str()],
    )?
    else {
        return Ok(None);
    };
    let resolved = String::from_utf8(output)?;
    Ok(resolved
        .trim()
        .eq_ignore_ascii_case(candidate)
        .then(|| resolved.trim().to_ascii_lowercase()))
}

fn branch_has_commits_beyond_base(record: &WorktreeRecord) -> Result<bool> {
    if record.branch.trim().is_empty() {
        return Ok(false);
    }
    let Some(base_ref) = proven_commit_id(&record.repository_path, &record.base_ref)? else {
        return Ok(true);
    };
    let range = format!("{base_ref}..{}", record.branch);
    let output = git_read(
        &record.repository_path,
        ["rev-list", "--count", range.as_str()],
    )?;
    Ok(String::from_utf8(output)?.trim().parse::<u64>()? > 0)
}

fn provider_merge_proven(
    request: &WorktreeRemoveRequest,
    preflight: &WorktreeRemovalPreflight,
) -> Result<bool> {
    let Some(expected) = request
        .provider_merged_head
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(false);
    };
    let reference = format!("refs/heads/{}", preflight.branch);
    let actual = git_read(
        &preflight.repository_path,
        ["rev-parse", "--verify", reference.as_str()],
    )?;
    if String::from_utf8(actual)?.trim() != expected {
        bail!("provider merge proof does not match the local branch head");
    }
    Ok(true)
}

fn blocker(kind: WorktreeBlockerKind, hard: bool, message: impl Into<String>) -> WorktreeBlocker {
    WorktreeBlocker {
        kind,
        hard,
        message: message.into(),
    }
}

fn require_instance(record: &WorktreeRecord, expected_instance_id: &str) -> Result<()> {
    if record.instance_id != expected_instance_id {
        bail!("worktree instance changed");
    }
    Ok(())
}

fn validate_checkpoint_kind(kind: &str) -> Result<()> {
    if matches!(
        kind,
        "creation_complete"
            | "review_ready"
            | "committed"
            | "pushed"
            | "pr_opened"
            | "merged"
            | "manual"
    ) {
        Ok(())
    } else {
        bail!("invalid checkpoint kind: {kind}")
    }
}

fn validate_setup_policy(policy: &str) -> Result<()> {
    if matches!(policy, "run" | "skip" | "inherit") {
        Ok(())
    } else {
        bail!("invalid setup policy: {policy}")
    }
}

fn validate_operation_stage(stage: &str) -> Result<()> {
    if matches!(
        stage,
        "validating"
            | "fetching"
            | "creating"
            | "copying"
            | "sparse"
            | "setup"
            | "configuring"
            | "binding"
            | "launching"
            | "moving"
            | "cleaning"
            | "removing"
            | "complete"
            | "rolling_back"
            | "failed"
            | "cancelled"
    ) {
        Ok(())
    } else {
        bail!("invalid worktree operation stage: {stage}")
    }
}

fn origin_text(origin: WorktreeOrigin) -> &'static str {
    match origin {
        WorktreeOrigin::Manual => "manual",
        WorktreeOrigin::Cli => "cli",
        WorktreeOrigin::Mcp => "mcp",
        WorktreeOrigin::Orchestration => "orchestration",
        WorktreeOrigin::Automation => "automation",
        WorktreeOrigin::ExternalImport => "external_import",
    }
}

fn parse_origin(value: &str) -> WorktreeOrigin {
    match value {
        "cli" => WorktreeOrigin::Cli,
        "mcp" => WorktreeOrigin::Mcp,
        "orchestration" => WorktreeOrigin::Orchestration,
        "automation" => WorktreeOrigin::Automation,
        "external_import" => WorktreeOrigin::ExternalImport,
        _ => WorktreeOrigin::Manual,
    }
}

fn lifecycle_text(lifecycle: WorktreeLifecycle) -> &'static str {
    match lifecycle {
        WorktreeLifecycle::Active => "active",
        WorktreeLifecycle::Missing => "missing",
        WorktreeLifecycle::Stale => "stale",
        WorktreeLifecycle::Conflicted => "conflicted",
        WorktreeLifecycle::Removing => "removing",
        WorktreeLifecycle::Failed => "failed",
    }
}

fn parse_lifecycle(value: &str) -> WorktreeLifecycle {
    match value {
        "missing" => WorktreeLifecycle::Missing,
        "stale" => WorktreeLifecycle::Stale,
        "conflicted" => WorktreeLifecycle::Conflicted,
        "removing" => WorktreeLifecycle::Removing,
        "failed" => WorktreeLifecycle::Failed,
        _ => WorktreeLifecycle::Active,
    }
}

fn external_projection_id(
    repository_id: &str,
    normalized_path: &str,
    git_dir_identity: &str,
) -> String {
    let digest = Sha256::digest(
        format!("{repository_id}\0{normalized_path}\0{git_dir_identity}").as_bytes(),
    );
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x50;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Uuid::from_bytes(bytes).to_string()
}

fn digest_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn required_text(value: &str, field: &str) -> Result<String> {
    let value = value.trim();
    if value.is_empty() {
        bail!("{field} is required");
    }
    Ok(value.to_string())
}

fn nonempty(value: String) -> Option<String> {
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn bounded_error(value: &str) -> String {
    value.chars().take(4_096).collect()
}
fn nonnegative(value: i64) -> u64 {
    value.max(0) as u64
}
fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn is_remote_path(path: &str) -> bool {
    path.starts_with("ssh://")
        || path.starts_with("wsl://")
        || path.to_ascii_lowercase().starts_with(r"\\wsl$\")
}
fn path_entry_exists(path: &str) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

fn repository_path_belongs_to_identity(path: &str, repository: &RepositoryIdentity) -> bool {
    if is_remote_path(path) {
        return false;
    }
    paths_equal(path, &repository.repository_path)
        || resolve_repository_identity(path)
            .map(|identity| identity.repository_id == repository.repository_id)
            .unwrap_or(false)
}
fn path_starts_with(path: &str, root: &Path) -> bool {
    let path = normalize_path_for_comparison(path);
    let root = normalize_path_for_comparison(&root.to_string_lossy());
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|suffix| suffix.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::git::test_support::{run_git, test_repo, unique_path};

    fn committed_repo() -> PathBuf {
        let repo = test_repo();
        std::fs::write(repo.join("README.md"), "registry\n").expect("write fixture");
        run_git(&repo, &["add", "README.md"]);
        run_git(&repo, &["commit", "-m", "initial"]);
        repo
    }

    fn registry() -> (PathBuf, WorktreeRegistry) {
        let data = unique_path("registry-data");
        let control = Arc::new(ControlPlane::open(&data).expect("open control plane"));
        (data, WorktreeRegistry::new(control))
    }

    #[test]
    fn external_import_and_recreated_checkout_keep_record_but_change_instance() {
        let repo = committed_repo();
        let linked = unique_path("registry-linked");
        let linked_text = linked.to_str().expect("utf8 linked");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "registry-linked",
                linked_text,
                "HEAD",
            ],
        );
        let (data, registry) = registry();
        let reconcile_request = WorktreeReconcileRequest {
            repository_path: repo.to_string_lossy().to_string(),
            legacy_rows: Vec::new(),
        };
        let external_id = registry
            .reconcile(reconcile_request.clone())
            .expect("discover external")
            .into_iter()
            .find(|projection| {
                projection
                    .native
                    .as_ref()
                    .is_some_and(|native| paths_equal(&native.worktree_path, linked_text))
            })
            .filter(|projection| {
                projection.state == WorktreeReconcileState::External && projection.record.is_none()
            })
            .expect("external projection")
            .id;
        let rediscovered_id = registry
            .reconcile(reconcile_request.clone())
            .expect("rediscover external")
            .into_iter()
            .find(|projection| {
                projection
                    .native
                    .as_ref()
                    .is_some_and(|native| paths_equal(&native.worktree_path, linked_text))
            })
            .expect("same external projection")
            .id;
        assert_eq!(rediscovered_id, external_id);
        let imported = registry
            .import_external(WorktreeImportRequest {
                repository_path: repo.to_string_lossy().to_string(),
                worktree_path: linked_text.to_string(),
                parent_session_id: None,
                session_id: Some("session-old".to_string()),
            })
            .expect("import external");
        let record = imported.record.expect("record");
        assert_ne!(record.id, external_id);
        Uuid::parse_str(&record.id).expect("durable record UUID");
        Uuid::parse_str(&record.instance_id).expect("durable instance UUID");
        assert!(record.base_ref.is_empty());
        let reconciled = registry
            .reconcile(reconcile_request.clone())
            .expect("preserve imported base provenance")
            .into_iter()
            .find(|projection| projection.id == record.id)
            .and_then(|projection| projection.record)
            .expect("reconciled imported record");
        assert!(reconciled.base_ref.is_empty());
        run_git(&repo, &["worktree", "remove", linked_text]);
        run_git(&repo, &["branch", "-D", "registry-linked"]);
        let missing = registry
            .reconcile(reconcile_request.clone())
            .expect("observe missing checkout")
            .into_iter()
            .find(|projection| projection.id == record.id)
            .expect("missing projection");
        assert_eq!(missing.state, WorktreeReconcileState::Missing);
        std::fs::create_dir_all(&linked).expect("create orphan directory");
        let stale = registry
            .reconcile(reconcile_request.clone())
            .expect("observe stale checkout")
            .into_iter()
            .find(|projection| projection.id == record.id)
            .expect("stale projection");
        assert_eq!(stale.state, WorktreeReconcileState::Stale);
        std::fs::remove_dir_all(&linked).expect("remove orphan directory");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "registry-linked-two",
                linked_text,
                "HEAD",
            ],
        );
        let projections = registry
            .reconcile(WorktreeReconcileRequest {
                repository_path: repo.to_string_lossy().to_string(),
                legacy_rows: Vec::new(),
            })
            .expect("reconcile recreated");
        let recreated = projections
            .into_iter()
            .find(|projection| projection.id == record.id)
            .expect("recreated record")
            .record
            .expect("record");

        assert_ne!(recreated.instance_id, record.instance_id);
        assert_eq!(recreated.id, record.id);
        assert!(recreated.session_id.is_none());
        let rebound = registry
            .import_external(WorktreeImportRequest {
                repository_path: repo.to_string_lossy().to_string(),
                worktree_path: linked_text.to_string(),
                parent_session_id: None,
                session_id: Some("session-new".to_string()),
            })
            .expect("rebind recreated checkout")
            .record
            .expect("rebound record");
        assert_eq!(rebound.id, record.id);
        assert_eq!(rebound.instance_id, recreated.instance_id);
        assert_eq!(rebound.session_id.as_deref(), Some("session-new"));
        registry
            .control
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE worktrees SET lifecycle='active',git_dir_identity='wrong-active-identity' WHERE id=?1",
                    [&record.id],
                )
            })
            .expect("seed identity conflict");
        let conflicted = registry
            .reconcile(reconcile_request)
            .expect("reconcile identity conflict")
            .into_iter()
            .find(|projection| projection.id == record.id)
            .expect("conflicted projection");
        assert_eq!(conflicted.state, WorktreeReconcileState::Conflicted);
        run_git(&repo, &["worktree", "remove", linked_text]);
        run_git(&repo, &["branch", "-D", "registry-linked-two"]);
        drop(registry);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
        std::fs::remove_dir_all(data).expect("cleanup data");
    }

    #[test]
    fn legacy_rows_require_source_provenance_and_pin_only_exact_bases() {
        let repo = committed_repo();
        let known_path = unique_path("registry-legacy-known");
        let unknown_path = unique_path("registry-legacy-unknown");
        let known_text = known_path.to_str().expect("utf8 known path");
        let unknown_text = unknown_path.to_str().expect("utf8 unknown path");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "registry-legacy-known",
                known_text,
                "HEAD",
            ],
        );
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "registry-legacy-unknown",
                unknown_text,
                "HEAD",
            ],
        );
        let (data, registry) = registry();
        let projections = registry
            .reconcile(WorktreeReconcileRequest {
                repository_path: repo.to_string_lossy().to_string(),
                legacy_rows: vec![
                    LegacyWorktreeRow {
                        session_id: "legacy-known".to_string(),
                        parent_session_id: "legacy-parent".to_string(),
                        source_workspace_folder: repo.to_string_lossy().to_string(),
                        worktree_path: known_text.to_string(),
                        branch: "registry-legacy-known".to_string(),
                        start_ref: "HEAD".to_string(),
                        created_at: 10,
                    },
                    LegacyWorktreeRow {
                        session_id: "legacy-unknown".to_string(),
                        parent_session_id: "legacy-unknown-parent".to_string(),
                        source_workspace_folder: unique_path("foreign-source")
                            .to_string_lossy()
                            .to_string(),
                        worktree_path: unknown_text.to_string(),
                        branch: "registry-legacy-unknown".to_string(),
                        start_ref: "HEAD".to_string(),
                        created_at: 11,
                    },
                ],
            })
            .expect("reconcile legacy rows");
        let known = projections
            .iter()
            .find(|projection| {
                projection
                    .record
                    .as_ref()
                    .is_some_and(|record| record.session_id.as_deref() == Some("legacy-known"))
            })
            .expect("known legacy projection");
        assert_eq!(known.state, WorktreeReconcileState::Managed);
        let known_record = known.record.as_ref().expect("known legacy record");
        assert!(known_record.base_ref.is_empty());
        assert!(known_record.parent_worktree_id.is_some());
        assert!(known_record.parent_instance_id.is_some());
        let unknown = projections
            .iter()
            .find(|projection| {
                projection
                    .record
                    .as_ref()
                    .is_some_and(|record| record.session_id.as_deref() == Some("legacy-unknown"))
            })
            .expect("unknown legacy projection");
        assert_eq!(unknown.state, WorktreeReconcileState::Conflicted);
        assert!(unknown
            .record
            .as_ref()
            .expect("unknown legacy record")
            .git_dir_identity
            .is_empty());

        run_git(&repo, &["worktree", "remove", "--force", known_text]);
        run_git(&repo, &["worktree", "remove", "--force", unknown_text]);
        run_git(&repo, &["branch", "-D", "registry-legacy-known"]);
        run_git(&repo, &["branch", "-D", "registry-legacy-unknown"]);
        drop(registry);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
        std::fs::remove_dir_all(data).expect("cleanup data");
    }

    #[test]
    fn removal_preflight_detects_only_real_unpushed_commits_and_accepts_exact_provider_proof() {
        let repo = committed_repo();
        let linked = unique_path("registry-removal-linked");
        let linked_text = linked.to_str().expect("utf8 linked");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "registry-removal",
                linked_text,
                "HEAD",
            ],
        );
        let (data, registry) = registry();
        let record = registry
            .import_external(WorktreeImportRequest {
                repository_path: repo.to_string_lossy().to_string(),
                worktree_path: linked_text.to_string(),
                parent_session_id: None,
                session_id: None,
            })
            .expect("import worktree")
            .record
            .expect("record");
        let unknown_base = registry
            .removal_preflight(
                &WorktreeRemovalPreflightRequest {
                    worktree_id: record.id.clone(),
                    delete_branch: true,
                },
                WorktreeRuntimeBlockers::default(),
            )
            .expect("unknown base preflight");
        assert!(unknown_base
            .blockers
            .iter()
            .any(|blocker| blocker.kind == WorktreeBlockerKind::Unpushed));
        registry
            .control
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE worktrees SET git_dir_identity='' WHERE id=?1",
                    [&record.id],
                )
            })
            .expect("clear stored identity");
        let unproven_identity = registry
            .removal_preflight(
                &WorktreeRemovalPreflightRequest {
                    worktree_id: record.id.clone(),
                    delete_branch: true,
                },
                WorktreeRuntimeBlockers::default(),
            )
            .expect("unproven identity preflight");
        assert!(unproven_identity.blockers.iter().any(|blocker| {
            blocker.kind == WorktreeBlockerKind::IdentityMismatch && blocker.hard
        }));
        let hard_request = WorktreeRemoveRequest {
            operation_id: Uuid::new_v4(),
            worktree_id: record.id.clone(),
            expected_instance_id: record.instance_id.clone(),
            force: true,
            delete_branch: false,
            provider_merged_head: None,
            acknowledged_blockers: vec![WorktreeBlockerKind::IdentityMismatch],
        };
        assert!(registry
            .validate_removal_request(&hard_request, &unproven_identity)
            .expect_err("hard identity mismatch must reject force")
            .to_string()
            .contains("IdentityMismatch"));
        registry
            .control
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE worktrees SET git_dir_identity=?1 WHERE id=?2",
                    params![record.git_dir_identity, record.id],
                )
            })
            .expect("restore stored identity");
        registry
            .control
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE worktrees SET base_ref='HEAD' WHERE id=?1",
                    [&record.id],
                )
            })
            .expect("seed symbolic base");
        let symbolic_base = registry
            .removal_preflight(
                &WorktreeRemovalPreflightRequest {
                    worktree_id: record.id.clone(),
                    delete_branch: true,
                },
                WorktreeRuntimeBlockers::default(),
            )
            .expect("symbolic base preflight");
        assert!(symbolic_base
            .blockers
            .iter()
            .any(|blocker| blocker.kind == WorktreeBlockerKind::Unpushed));
        let proven_base = String::from_utf8(run_git(&repo, &["rev-parse", "HEAD"]))
            .expect("utf8 base")
            .trim()
            .to_string();
        registry
            .control
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE worktrees SET base_ref=?1 WHERE id=?2",
                    params![proven_base, record.id],
                )
            })
            .expect("pin proven base");

        let clean = registry
            .removal_preflight(
                &WorktreeRemovalPreflightRequest {
                    worktree_id: record.id.clone(),
                    delete_branch: true,
                },
                WorktreeRuntimeBlockers::default(),
            )
            .expect("clean preflight");
        assert!(!clean
            .blockers
            .iter()
            .any(|blocker| blocker.kind == WorktreeBlockerKind::Unpushed));

        std::fs::write(linked.join("change.txt"), "unpublished\n").expect("write change");
        run_git(&linked, &["add", "change.txt"]);
        run_git(&linked, &["commit", "-m", "unpublished"]);
        let head = String::from_utf8(run_git(&linked, &["rev-parse", "HEAD"]))
            .expect("utf8 head")
            .trim()
            .to_string();
        let unpushed = registry
            .removal_preflight(
                &WorktreeRemovalPreflightRequest {
                    worktree_id: record.id.clone(),
                    delete_branch: true,
                },
                WorktreeRuntimeBlockers::default(),
            )
            .expect("unpushed preflight");
        assert!(unpushed
            .blockers
            .iter()
            .any(|blocker| blocker.kind == WorktreeBlockerKind::Unpushed));

        let request = WorktreeRemoveRequest {
            operation_id: Uuid::new_v4(),
            worktree_id: record.id.clone(),
            expected_instance_id: record.instance_id.clone(),
            force: false,
            delete_branch: true,
            provider_merged_head: Some(head.clone()),
            acknowledged_blockers: Vec::new(),
        };
        registry
            .validate_removal_request(&request, &unpushed)
            .expect("exact provider proof");
        let mismatch = WorktreeRemoveRequest {
            provider_merged_head: Some("0".repeat(40)),
            ..request.clone()
        };
        assert!(registry
            .validate_removal_request(&mismatch, &unpushed)
            .expect_err("mismatch must fail")
            .to_string()
            .contains("does not match"));
        registry
            .prepare_removal(&record.id, &record.instance_id)
            .expect("prepare guarded removal");
        registry
            .control
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE worktrees SET git_dir_identity='' WHERE id=?1",
                    [&record.id],
                )
            })
            .expect("invalidate identity after preflight");
        assert!(registry
            .remove_checkout_and_branch(&request, &unpushed)
            .expect_err("mutation must revalidate identity")
            .to_string()
            .contains("cannot be proven"));
        assert!(linked.exists());
        registry
            .control
            .with_connection(|connection| {
                connection.execute(
                    "UPDATE worktrees SET lifecycle='active',git_dir_identity=?1 WHERE id=?2",
                    params![record.git_dir_identity, record.id],
                )
            })
            .expect("restore fixture lifecycle");

        let preserve_request = WorktreeRemoveRequest {
            operation_id: Uuid::new_v4(),
            worktree_id: record.id.clone(),
            expected_instance_id: record.instance_id.clone(),
            force: true,
            delete_branch: true,
            provider_merged_head: None,
            acknowledged_blockers: vec![WorktreeBlockerKind::Unpushed],
        };
        registry
            .prepare_removal(&record.id, &record.instance_id)
            .expect("prepare preserving removal");
        let preserved = registry
            .remove_checkout_and_branch(&preserve_request, &unpushed)
            .expect("remove checkout and preserve branch");
        assert!(preserved.checkout_removed);
        assert!(!preserved.branch_deleted);
        assert!(preserved
            .branch_preserved_reason
            .as_deref()
            .is_some_and(|reason| reason.contains("unpushed")));
        registry
            .finalize_removal(&record.id, &record.instance_id)
            .expect("finalize preserved removal");
        let branch_head = String::from_utf8(run_git(
            &repo,
            &["rev-parse", "refs/heads/registry-removal"],
        ))
        .expect("utf8 branch head");
        assert_eq!(branch_head.trim(), head);
        run_git(&repo, &["branch", "-D", "registry-removal"]);
        drop(registry);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
        std::fs::remove_dir_all(data).expect("cleanup data");
    }

    #[test]
    fn untrusted_native_and_scratch_component_boundaries_are_explicit() {
        let repo = committed_repo();
        let (data, registry) = registry();
        let repository = resolve_repository_identity(repo.to_str().expect("utf8 repo"))
            .expect("repository identity");
        let path = unique_path("registry-untrusted")
            .to_string_lossy()
            .to_string();
        let native = NativeWorktree {
            normalized_path: normalize_path_for_comparison(&path),
            worktree_path: path,
            git_dir_identity: String::new(),
            head: String::new(),
            branch: None,
            detached: true,
            bare: false,
            locked: false,
            lock_reason: None,
            prunable: true,
            prunable_reason: Some("identity unavailable".to_string()),
            exists: false,
            is_main: false,
            dirty: false,
            untracked: false,
            has_conflicts: false,
            ahead: 0,
            behind: 0,
        };
        let projection = registry
            .reconcile_scan(repository, vec![native])
            .expect("untrusted reconcile")
            .into_iter()
            .find(|projection| projection.state == WorktreeReconcileState::Untrusted)
            .expect("untrusted projection");
        assert!(projection.record.is_none());

        let scratch = data.join("automation-artifacts").join("worktrees");
        assert!(path_starts_with(
            &scratch.join("run").to_string_lossy(),
            &scratch
        ));
        assert!(!path_starts_with(
            &data
                .join("automation-artifacts")
                .join("worktrees-user")
                .to_string_lossy(),
            &scratch
        ));
        let scratch_projection = WorktreeProjection {
            id: "scratch".to_string(),
            instance_id: None,
            parent_worktree_id: None,
            record: None,
            state: WorktreeReconcileState::External,
            native: Some(NativeWorktree {
                worktree_path: scratch.join("run").to_string_lossy().to_string(),
                normalized_path: normalize_path_for_comparison(
                    &scratch.join("run").to_string_lossy(),
                ),
                git_dir_identity: "scratch-git-dir".to_string(),
                head: String::new(),
                branch: None,
                detached: true,
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
            }),
            child_worktree_ids: Vec::new(),
        };
        assert!(registry.hidden_external(&scratch_projection));
        let mut visible_neighbor = scratch_projection;
        let neighbor_path = data
            .join("automation-artifacts")
            .join("worktrees-user")
            .to_string_lossy()
            .to_string();
        visible_neighbor
            .native
            .as_mut()
            .expect("native")
            .worktree_path = neighbor_path;
        assert!(!registry.hidden_external(&visible_neighbor));

        drop(registry);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
        std::fs::remove_dir_all(data).expect("cleanup data");
    }

    #[test]
    fn metadata_clear_comment_upsert_and_checkpoint_use_current_instance_head() {
        let repo = committed_repo();
        let linked = unique_path("registry-metadata-linked");
        let linked_text = linked.to_str().expect("utf8 linked");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "registry-metadata",
                linked_text,
                "HEAD",
            ],
        );
        let (data, registry) = registry();
        let record = registry
            .import_external(WorktreeImportRequest {
                repository_path: repo.to_string_lossy().to_string(),
                worktree_path: linked_text.to_string(),
                parent_session_id: None,
                session_id: None,
            })
            .expect("import metadata worktree")
            .record
            .expect("metadata record");

        let set = registry
            .set(WorktreeSetRequest {
                worktree_id: record.id.clone(),
                expected_instance_id: record.instance_id.clone(),
                comment: Some("note".to_string()),
                review_target: Some("main".to_string()),
                parent_worktree_id: None,
                clear_parent: false,
            })
            .expect("set metadata");
        assert_eq!(set.comment.as_deref(), Some("note"));
        let cleared = registry
            .set(WorktreeSetRequest {
                worktree_id: record.id.clone(),
                expected_instance_id: record.instance_id.clone(),
                comment: Some(String::new()),
                review_target: Some(String::new()),
                parent_worktree_id: None,
                clear_parent: false,
            })
            .expect("clear metadata");
        assert!(cleared.comment.is_none() && cleared.review_target.is_none());

        let request = |body: &str| WorktreeReviewCommentRequest {
            worktree_id: record.id.clone(),
            expected_instance_id: record.instance_id.clone(),
            base_head: "base".to_string(),
            head: record.head.clone(),
            path: "src/lib.rs".to_string(),
            side: "right".to_string(),
            line: Some(7),
            range: None,
            hunk_id: Some("hunk".to_string()),
            body: body.to_string(),
        };
        let first = registry
            .put_review_comment(request("first"))
            .expect("put first comment");
        let second = registry
            .put_review_comment(request("updated"))
            .expect("update comment");
        assert_eq!(first.id, second.id);
        assert_eq!(first.created_at, second.created_at);
        let comments = registry
            .list_review_comments(&record.id)
            .expect("list comments");
        assert_eq!(comments.len(), 1);
        assert_eq!(comments[0].body, "updated");

        std::fs::write(linked.join("checkpoint.txt"), "checkpoint\n").expect("write checkpoint");
        run_git(&linked, &["add", "checkpoint.txt"]);
        run_git(&linked, &["commit", "-m", "checkpoint"]);
        let current_head = String::from_utf8(run_git(&linked, &["rev-parse", "HEAD"]))
            .expect("utf8 checkpoint head")
            .trim()
            .to_string();
        let checkpoint = registry
            .checkpoint(WorktreeCheckpointRequest {
                worktree_id: record.id.clone(),
                kind: "manual".to_string(),
                label: "Current head".to_string(),
                comment: None,
            })
            .expect("create checkpoint");
        assert_eq!(checkpoint.head, current_head);
        assert_eq!(
            registry
                .list_checkpoints(&record.id)
                .expect("list checkpoints")
                .len(),
            1
        );

        run_git(&repo, &["worktree", "remove", "--force", linked_text]);
        run_git(&repo, &["branch", "-D", "registry-metadata"]);
        drop(registry);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
        std::fs::remove_dir_all(data).expect("cleanup data");
    }

    #[test]
    fn cycle_edges_are_removed_from_every_participant() {
        let record = |id: &str, parent: &str| WorktreeRecord {
            id: id.to_string(),
            instance_id: format!("{id}-instance"),
            repository_id: "repo".into(),
            repository_path: "E:/repo".into(),
            worktree_path: format!("E:/{id}"),
            branch: id.into(),
            head: "head".into(),
            base_ref: "HEAD".into(),
            session_id: None,
            parent_session_id: None,
            parent_worktree_id: Some(parent.to_string()),
            parent_instance_id: Some(format!("{parent}-instance")),
            origin: WorktreeOrigin::Manual,
            lifecycle: WorktreeLifecycle::Active,
            locked: false,
            lock_reason: None,
            prunable: false,
            prunable_reason: None,
            dirty: false,
            untracked: false,
            has_conflicts: false,
            ahead: 0,
            behind: 0,
            exists: true,
            setup_policy: "inherit".into(),
            sparse_preset: None,
            linked_files: Vec::new(),
            initial_agent: None,
            initial_prompt: None,
            comment: None,
            review_target: None,
            created_at: 1,
            updated_at: 1,
            last_activity_at: 1,
            normalized_repository_path: "e:/repo".into(),
            normalized_worktree_path: format!("e:/{id}"),
            git_dir_identity: id.into(),
        };
        let projection = |record: WorktreeRecord| {
            let native = NativeWorktree {
                worktree_path: record.worktree_path.clone(),
                normalized_path: record.normalized_worktree_path.clone(),
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
            projection_for_record(record, WorktreeReconcileState::Managed, Some(native))
        };
        let mut projections = vec![
            projection(record("a", "b")),
            projection(record("b", "c")),
            projection(record("c", "a")),
        ];
        apply_lineage(&mut projections);
        assert!(projections
            .iter()
            .all(|projection| projection.parent_worktree_id.is_none()
                && projection.child_worktree_ids.is_empty()));
    }

    #[test]
    fn set_rejects_indirect_lineage_cycles() {
        let repo = committed_repo();
        let first_path = unique_path("registry-lineage-first");
        let second_path = unique_path("registry-lineage-second");
        let first_text = first_path.to_str().expect("utf8 first path");
        let second_text = second_path.to_str().expect("utf8 second path");
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "registry-lineage-first",
                first_text,
                "HEAD",
            ],
        );
        run_git(
            &repo,
            &[
                "worktree",
                "add",
                "-b",
                "registry-lineage-second",
                second_text,
                "HEAD",
            ],
        );
        let repository =
            resolve_repository_identity(&repo.to_string_lossy()).expect("repository identity");
        let native =
            scan_native_worktrees(&repository.repository_path).expect("scan native worktrees");
        let (data, registry) = registry();
        let mut records = native
            .iter()
            .map(|entry| {
                registry
                    .insert_native_record(
                        &repository,
                        entry,
                        None,
                        None,
                        None,
                        WorktreeOrigin::Manual,
                        "inherit",
                        None,
                        Vec::new(),
                        None,
                        None,
                        "",
                    )
                    .expect("insert native record")
            })
            .collect::<Vec<_>>();
        records.sort_by(|left, right| left.worktree_path.cmp(&right.worktree_path));
        let a = records[0].clone();
        let b = records[1].clone();
        let c = records[2].clone();
        let set_parent = |child: &WorktreeRecord, parent: &WorktreeRecord| WorktreeSetRequest {
            worktree_id: child.id.clone(),
            expected_instance_id: child.instance_id.clone(),
            comment: None,
            review_target: None,
            parent_worktree_id: Some(parent.id.clone()),
            clear_parent: false,
        };
        registry.set(set_parent(&a, &b)).expect("set a parent");
        registry.set(set_parent(&b, &c)).expect("set b parent");
        assert!(registry
            .set(set_parent(&c, &a))
            .expect_err("reject indirect cycle")
            .to_string()
            .contains("lineage cycle"));

        run_git(&repo, &["worktree", "remove", "--force", first_text]);
        run_git(&repo, &["worktree", "remove", "--force", second_text]);
        run_git(&repo, &["branch", "-D", "registry-lineage-first"]);
        run_git(&repo, &["branch", "-D", "registry-lineage-second"]);
        drop(registry);
        std::fs::remove_dir_all(repo).expect("cleanup repo");
        std::fs::remove_dir_all(data).expect("cleanup data");
    }

    #[test]
    fn operation_ids_replay_and_reject_conflicting_payloads() {
        let (data, registry) = registry();
        let operation = Uuid::new_v4();
        assert_eq!(
            registry
                .claim_operation(operation, "create", &serde_json::json!({"name":"one"}))
                .expect("claim"),
            WorktreeOperationClaim::Claimed
        );
        registry
            .complete_operation(operation, &serde_json::json!({"ok":true}))
            .expect("complete");
        assert!(matches!(
            registry
                .claim_operation(operation, "create", &serde_json::json!({"name":"one"}))
                .expect("replay"),
            WorktreeOperationClaim::Replay {
                result_json: Some(_),
                error: None
            }
        ));
        assert!(registry
            .claim_operation(operation, "create", &serde_json::json!({"name":"two"}))
            .is_err());
        drop(registry);
        std::fs::remove_dir_all(data).expect("cleanup data");
    }
}

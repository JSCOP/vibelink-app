// Typed client for the daemon worktree registry/lifecycle route. Every DTO here
// mirrors `src-tauri/src/app/git/worktree_registry.rs` and
// `src-tauri/src/app/git/worktree_lifecycle.rs` field for field; the Tauri
// commands are thin adapters over the single `worktree.*` daemon route, so this
// module is the only place the frontend speaks worktree lifecycle.
import { invoke } from '@tauri-apps/api/core'
import type { WorktreeStorage, WorktreeStorageOptions, WorktreeStorageResolution } from './types'

export type WorktreeOrigin = 'manual' | 'cli' | 'mcp' | 'orchestration' | 'automation' | 'external_import'
export type WorktreeLifecycle = 'active' | 'missing' | 'stale' | 'conflicted' | 'removing' | 'failed'
export type WorktreeReconcileState = 'managed' | 'external' | 'missing' | 'stale' | 'conflicted' | 'untrusted'
export type WorktreeBlockerKind =
  | 'main_checkout'
  | 'git_locked'
  | 'identity_mismatch'
  | 'dirty'
  | 'conflicted'
  | 'unpushed'
  | 'live_session'
  | 'live_panes'
  | 'missing_registration'
  | 'orphan_directory'
export type WorktreeSetupPolicy = 'run' | 'skip' | 'inherit'

export type NativeWorktree = {
  worktreePath: string
  normalizedPath: string
  gitDirIdentity: string
  head: string
  branch: string | null
  detached: boolean
  bare: boolean
  locked: boolean
  lockReason: string | null
  prunable: boolean
  prunableReason: string | null
  exists: boolean
  isMain: boolean
  dirty: boolean
  untracked: boolean
  hasConflicts: boolean
  ahead: number
  behind: number
}

export type WorktreeRecord = {
  id: string
  instanceId: string
  repositoryId: string
  repositoryPath: string
  worktreePath: string
  branch: string
  head: string
  baseRef: string
  sessionId: string | null
  parentSessionId: string | null
  parentWorktreeId: string | null
  parentInstanceId: string | null
  origin: WorktreeOrigin
  lifecycle: WorktreeLifecycle
  locked: boolean
  lockReason: string | null
  prunable: boolean
  prunableReason: string | null
  dirty: boolean
  untracked: boolean
  hasConflicts: boolean
  ahead: number
  behind: number
  exists: boolean
  setupPolicy: WorktreeSetupPolicy
  sparsePreset: string | null
  linkedFiles: string[]
  initialAgent: string | null
  initialPrompt: string | null
  comment: string | null
  reviewTarget: string | null
  createdAt: number
  updatedAt: number
  lastActivityAt: number
}

export type WorktreeProjection = {
  id: string
  instanceId: string | null
  state: WorktreeReconcileState
  record: WorktreeRecord | null
  native: NativeWorktree | null
  parentWorktreeId: string | null
  childWorktreeIds: string[]
}

export type WorktreeBlocker = { kind: WorktreeBlockerKind; hard: boolean; message: string }

export type WorktreeRemovalPreflight = {
  worktreeId: string
  instanceId: string
  repositoryPath: string
  worktreePath: string
  branch: string
  blockers: WorktreeBlocker[]
  warnings: string[]
}

export type WorktreeCheckpointKind = 'creation_complete' | 'review_ready' | 'committed' | 'pushed' | 'pr_opened' | 'merged' | 'manual'

export type WorktreeCheckpoint = {
  id: string
  worktreeId: string
  kind: WorktreeCheckpointKind
  label: string
  head: string
  comment: string | null
  createdAt: number
}

export type WorktreeReviewComment = {
  id: string
  worktreeId: string
  instanceId: string
  baseHead: string
  head: string
  path: string
  side: string
  line: number | null
  range: unknown
  hunkId: string | null
  body: string
  createdAt: number
  updatedAt: number
}

// Flattened shape of the pre-registry `settings.workspaceWorktrees` map, sent to
// `worktree.reconcile` exactly once so the daemon owns the migration.
export type LegacyWorktreeRow = {
  sessionId: string
  parentSessionId: string
  sourceWorkspaceFolder: string
  worktreePath: string
  branch: string
  startRef: string
  createdAt: number
}

export type WorktreeListRequest = {
  repositoryPath: string | null
  includeExternal: boolean
  includeHidden: boolean
}

export type WorktreeReconcileRequest = {
  repositoryPath: string
  legacyRows: LegacyWorktreeRow[]
}

export type WorktreeImportRequest = {
  repositoryPath: string
  worktreePath: string
  parentSessionId: string | null
  sessionId: string | null
}

export type WorktreeCreateRequest = {
  operationId: string
  repositoryPath: string
  parentSessionId: string
  parentWorktreeId: string | null
  name: string
  startRef: string
  branch: string | null
  storage: WorktreeStorage
  fetch: boolean
  setupPolicy: WorktreeSetupPolicy
  sparsePreset: string | null
  linkedFiles: string[]
  profileId: string | null
  initialAgent: string | null
  initialPrompt: string | null
  origin: WorktreeOrigin
}

export type WorktreeMoveRequest = {
  operationId: string
  worktreeId: string
  expectedInstanceId: string
  destinationPath: string
}

export type WorktreeRemovalPreflightRequest = {
  worktreeId: string
  deleteBranch: boolean
}

export type WorktreeRemoveRequest = {
  operationId: string
  worktreeId: string
  expectedInstanceId: string
  force: boolean
  deleteBranch: boolean
  providerMergedHead: string | null
  acknowledgedBlockers: WorktreeBlockerKind[]
}

export type WorktreeSetRequest = {
  worktreeId: string
  expectedInstanceId: string
  comment: string | null
  reviewTarget: string | null
  parentWorktreeId: string | null
  clearParent: boolean
}

export type WorktreeCheckpointRequest = {
  worktreeId: string
  kind: WorktreeCheckpointKind
  label: string
  comment: string | null
}

export type WorktreeReviewCommentRequest = {
  worktreeId: string
  expectedInstanceId: string
  baseHead: string
  head: string
  path: string
  side: string
  line: number | null
  range: unknown
  hunkId: string | null
  body: string
}

export type WorktreeCreateResult = { worktree: WorktreeRecord; sessionId: string }
export type WorktreeMoveResult = { worktree: WorktreeRecord; previousPath: string }
export type WorktreeRemovalResult = {
  checkoutRemoved: boolean
  branchDeleted: boolean
  branchPreservedReason: string | null
  sessionRemoved: boolean
  metadataRemoved: boolean
}

export function listWorktrees(request: WorktreeListRequest): Promise<WorktreeProjection[]> {
  return invoke<WorktreeProjection[]>('worktree_registry_list', { request })
}

export function reconcileWorktrees(request: WorktreeReconcileRequest): Promise<WorktreeProjection[]> {
  return invoke<WorktreeProjection[]>('worktree_registry_reconcile', { request })
}

export function importWorktree(request: WorktreeImportRequest): Promise<WorktreeProjection> {
  return invoke<WorktreeProjection>('worktree_registry_import', { request })
}

export function createWorktree(request: WorktreeCreateRequest): Promise<WorktreeCreateResult> {
  return invoke<WorktreeCreateResult>('worktree_lifecycle_create', { request })
}

// Signals the daemon-side cancellation flag for an in-flight operation. Resolves
// false when no live operation carried that id, so callers must keep the pending
// row until the originating promise itself settles.
export function cancelWorktreeOperation(operationId: string): Promise<boolean> {
  return invoke<boolean>('worktree_lifecycle_cancel', { request: { operationId } })
}

export function moveWorktree(request: WorktreeMoveRequest): Promise<WorktreeMoveResult> {
  return invoke<WorktreeMoveResult>('worktree_lifecycle_move', { request })
}

export function preflightWorktreeRemoval(request: WorktreeRemovalPreflightRequest): Promise<WorktreeRemovalPreflight> {
  return invoke<WorktreeRemovalPreflight>('worktree_removal_preflight', { request })
}

export function removeWorktree(request: WorktreeRemoveRequest): Promise<WorktreeRemovalResult> {
  return invoke<WorktreeRemovalResult>('worktree_lifecycle_remove', { request })
}

export function setWorktreeMetadata(request: WorktreeSetRequest): Promise<WorktreeRecord> {
  return invoke<WorktreeRecord>('worktree_registry_set', { request })
}

export function createWorktreeCheckpoint(request: WorktreeCheckpointRequest): Promise<WorktreeCheckpoint> {
  return invoke<WorktreeCheckpoint>('worktree_checkpoint_create', { request })
}

export function putWorktreeReviewComment(request: WorktreeReviewCommentRequest): Promise<WorktreeReviewComment> {
  return invoke<WorktreeReviewComment>('worktree_review_comment_create', { request })
}

export function worktreeStorageOptions(): Promise<WorktreeStorageOptions> {
  return invoke<WorktreeStorageOptions>('git_worktree_storage_options')
}

export function resolveWorktreeStorageRoot(
  workspaceFolder: string,
  storage: WorktreeStorage,
  name: string,
): Promise<WorktreeStorageResolution> {
  return invoke<WorktreeStorageResolution>('git_worktree_resolve_root', { workspaceFolder, storage, name })
}

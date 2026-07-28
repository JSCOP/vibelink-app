// Projection-side helpers for the worktree registry. DTOs live in
// `src/ipc/worktrees.ts` (the daemon contract); this module owns only the pure
// derivations the store and UI need — indexes, session lookup, legacy migration
// payloads, and pending-creation bookkeeping.
import type {
  LegacyWorktreeRow,
  WorktreeCreateRequest,
  WorktreeProjection,
  WorktreeRecord,
} from '../ipc/worktrees'

// Re-exported so consumers can keep a single worktree-domain import; the DTOs
// themselves stay owned by the daemon contract in `src/ipc/worktrees.ts`.
export type {
  NativeWorktree,
  WorktreeBlocker,
  WorktreeBlockerKind,
  WorktreeCheckpoint,
  WorktreeCheckpointKind,
  WorktreeLifecycle,
  WorktreeOrigin,
  WorktreeProjection,
  WorktreeReconcileState,
  WorktreeRecord,
  WorktreeRemovalPreflight,
  WorktreeRemovalResult,
  WorktreeReviewComment,
  WorktreeSetupPolicy,
} from '../ipc/worktrees'

// The pre-registry `settings.workspaceWorktrees` value shape.
export type LegacyWorkspaceWorktree = {
  parentSessionId: string
  sourceWorkspaceFolder: string
  worktreePath: string
  branch: string
  startRef: string
  createdAt: string
}

// Fixed by the lifecycle service; the daemon persists exactly these literals.
export type WorktreeCreationStage =
  | 'validating'
  | 'fetching'
  | 'creating'
  | 'copying'
  | 'sparse'
  | 'setup'
  | 'binding'
  | 'launching'
  | 'complete'
  | 'rolling_back'
  | 'failed'
  | 'cancelled'

export type PendingWorktreeCreation = {
  operationId: string
  parentSessionId: string
  repositoryPath: string
  name: string
  branch: string
  startRef: string
  stage: WorktreeCreationStage
  startedAt: number
  updatedAt: number
  cancelRequested: boolean
  // Raw daemon error. On a preserved rollback it carries the retained artifact
  // paths and recovery instruction verbatim, so it is rendered as-is rather
  // than parsed into fields the daemon does not promise.
  error: string | null
  sessionId: string | null
  request: WorktreeCreateRequest
}

export type WorktreeIndex = {
  worktreesById: Record<string, WorktreeProjection>
  worktreeIdsBySessionId: Record<string, string>
}

export function indexWorktrees(projections: WorktreeProjection[]): WorktreeIndex {
  const worktreesById: Record<string, WorktreeProjection> = {}
  const worktreeIdsBySessionId: Record<string, string> = {}
  for (const projection of projections) {
    worktreesById[projection.id] = projection
    const sessionId = projection.record?.sessionId
    if (sessionId) worktreeIdsBySessionId[sessionId] = projection.id
  }
  return { worktreesById, worktreeIdsBySessionId }
}

export function worktreeBySession(worktrees: WorktreeProjection[], sessionId: string): WorktreeProjection | undefined {
  return worktrees.find((projection) => projection.record?.sessionId === sessionId)
}

export function managedWorktreeRecords(worktrees: WorktreeProjection[]): WorktreeRecord[] {
  return worktrees.flatMap((projection) => projection.record ? [projection.record] : [])
}

// A projection the sidebar/manage dialog must render explicitly instead of
// nesting under a workspace session: it has no bound workspace of its own.
export function isDetachedProjection(projection: WorktreeProjection): boolean {
  if (projection.native?.isMain) return false
  return !projection.record?.sessionId
}

export function projectionLabel(projection: WorktreeProjection): string {
  const branch = projection.record?.branch || projection.native?.branch
  if (branch) return branch
  const path = worktreePathOf(projection)
  if (!path) return 'detached'
  const normalized = path.replace(/[\\/]+$/, '')
  const separator = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return normalized.slice(separator + 1) || 'detached'
}

export function worktreePathOf(projection: WorktreeProjection): string {
  return projection.record?.worktreePath ?? projection.native?.worktreePath ?? ''
}

// Groups the legacy localStorage map into one reconcile payload per source
// repository. The daemon proves or rejects each row; the frontend never decides
// which legacy relations survive.
export function legacyRowsByRepository(
  legacy: Record<string, LegacyWorkspaceWorktree>,
): Map<string, LegacyWorktreeRow[]> {
  const byRepository = new Map<string, LegacyWorktreeRow[]>()
  for (const [sessionId, relation] of Object.entries(legacy)) {
    const rows = byRepository.get(relation.sourceWorkspaceFolder) ?? []
    rows.push({
      sessionId,
      parentSessionId: relation.parentSessionId,
      sourceWorkspaceFolder: relation.sourceWorkspaceFolder,
      worktreePath: relation.worktreePath,
      branch: relation.branch,
      startRef: relation.startRef,
      createdAt: Date.parse(relation.createdAt) || 0,
    })
    byRepository.set(relation.sourceWorkspaceFolder, rows)
  }
  return byRepository
}

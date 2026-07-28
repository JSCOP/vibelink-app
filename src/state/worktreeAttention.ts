import type { SessionMeta } from '../ipc/types'
import type { PaneCompletionHighlight } from './store'
import type { HermesStatus, PendingPermission } from './hermes'
import type { WorkspaceSortMode } from './profiles'
import { flattenWorkspaceRows, workspaceRows, type WorkspaceGroup, type WorkspaceRow } from './workspaceGroups'
import type { WorktreeProjection } from './worktrees'

export const EXPLICIT_ATTENTION_TTL_MS = 30 * 60 * 1_000
export const NEW_WORKSPACE_GRACE_MS = 5 * 60 * 1_000

export type NativeAttentionState = 'idle' | 'working' | 'waiting' | 'blocked' | 'error' | 'done'
export type NativeAttentionPane = {
  workspaceId: string
  paneId: string
  state: NativeAttentionState
  stateUpdatedAt: number
  lastOutputAt: number
  unreadCount: number
  interrupted: boolean
  source: string
  alive: boolean
  title: string
}
export type AttentionSnapshot = { capturedAt: number; panes: NativeAttentionPane[] }
export type WorkspaceAttentionState = 'blocked' | 'done' | 'working' | 'idle'
export type WorkspaceAttention = {
  attentionClass: 1 | 2 | 3 | 4
  timestamp: number
  recentActivity: number
  state: WorkspaceAttentionState
  unreadCount: number
  completionCount: number
  source: string
  cause: string
}
export type AttentionFallbacks = {
  completionHighlights: Record<string, PaneCompletionHighlight>
  hermesStatus: Record<string, HermesStatus>
  hermesPermissions?: Record<string, PendingPermission[]>
  conflictSessionIds?: ReadonlySet<string>
  reviewedPaneIds?: ReadonlySet<string>
}
export type DerivedWorkspaceOrder = {
  rows: WorkspaceRow[]
  sessions: SessionMeta[]
  sessionIds: string[]
}

type ResolvedPaneAttention = {
  attentionClass: 1 | 2 | 3 | 4
  timestamp: number
  source: string
  cause: string
  freshNativeEvidence: boolean
}

type AttentionAggregate = {
  attentionClass: 1 | 2 | 3 | 4
  timestamp: number
  sources: Set<string>
  causes: Set<string>
}


function compareText(left: string, right: string): number {
  const normalizedLeft = left.trim().normalize('NFKC').toLowerCase()
  const normalizedRight = right.trim().normalize('NFKC').toLowerCase()
  return normalizedLeft < normalizedRight ? -1 : normalizedLeft > normalizedRight ? 1 : 0
}

function finiteTimestamp(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function isFreshNativeEvidence(pane: NativeAttentionPane, now: number): boolean {
  const updatedAt = finiteTimestamp(pane.stateUpdatedAt)
  return updatedAt > 0 && now - updatedAt <= EXPLICIT_ATTENTION_TTL_MS
}

export function resolveAttention(
  pane: NativeAttentionPane,
  now: number,
  explicitlyReviewed = false,
): ResolvedPaneAttention {
  const stateTimestamp = finiteTimestamp(pane.stateUpdatedAt)
  const fallbackTimestamp = Math.max(stateTimestamp, finiteTimestamp(pane.lastOutputAt))
  const freshNativeEvidence = isFreshNativeEvidence(pane, now)
  if (freshNativeEvidence) {
    if (pane.state === 'blocked' || pane.state === 'waiting' || pane.state === 'error') {
      return { attentionClass: 1, timestamp: stateTimestamp, source: pane.source, cause: pane.state, freshNativeEvidence }
    }
    if (pane.state === 'done' && !pane.interrupted && !explicitlyReviewed) {
      return { attentionClass: 2, timestamp: stateTimestamp, source: pane.source, cause: 'done', freshNativeEvidence }
    }
    if (pane.state === 'working') {
      return { attentionClass: 3, timestamp: stateTimestamp, source: pane.source, cause: 'working', freshNativeEvidence }
    }
    return { attentionClass: 4, timestamp: 0, source: pane.source, cause: pane.interrupted ? 'interrupted' : 'idle', freshNativeEvidence }
  }
  if (pane.alive && /permission|approve|confirm|allow|waiting for input/i.test(pane.title)) {
    return { attentionClass: 1, timestamp: fallbackTimestamp, source: 'terminal-title', cause: 'permission', freshNativeEvidence }
  }
  if (pane.alive && /working|running|thinking|executing|building|testing/i.test(pane.title)) {
    return { attentionClass: 3, timestamp: fallbackTimestamp, source: 'terminal-title', cause: 'working', freshNativeEvidence }
  }
  return { attentionClass: 4, timestamp: 0, source: pane.source, cause: pane.interrupted ? 'interrupted' : 'idle', freshNativeEvidence }
}

export function effectiveRecentActivity(
  session: SessionMeta,
  projection: WorktreeProjection | undefined,
  panes: NativeAttentionPane[],
  now: number,
): number {
  const createdAt = finiteTimestamp(session.createdAt * 1_000)
  const nativeActivity = panes.reduce((latest, pane) => Math.max(latest, finiteTimestamp(pane.lastOutputAt), finiteTimestamp(pane.stateUpdatedAt)), 0)
  const registryActivity = finiteTimestamp(projection?.record?.lastActivityAt ?? 0)
  const observed = Math.max(createdAt, nativeActivity, registryActivity)
  return createdAt > 0 && now < createdAt + NEW_WORKSPACE_GRACE_MS
    ? Math.max(observed, createdAt + NEW_WORKSPACE_GRACE_MS)
    : observed
}

export function buildAttentionByWorkspace(
  sessions: SessionMeta[],
  worktrees: WorktreeProjection[],
  snapshot: AttentionSnapshot | null,
  fallbacks: AttentionFallbacks,
  now = Date.now(),
): Record<string, WorkspaceAttention> {
  const projectionsBySession = new Map(worktrees.flatMap((projection) => projection.record?.sessionId ? [[projection.record.sessionId, projection] as const] : []))
  const panesByWorkspace = new Map<string, NativeAttentionPane[]>()
  for (const pane of snapshot?.panes ?? []) {
    const rows = panesByWorkspace.get(pane.workspaceId) ?? []
    rows.push(pane)
    panesByWorkspace.set(pane.workspaceId, rows)
  }
  const highlightsByWorkspace = new Map<string, [string, PaneCompletionHighlight][]>()
  for (const entry of Object.entries(fallbacks.completionHighlights)) {
    const rows = highlightsByWorkspace.get(entry[1].sessionId) ?? []
    rows.push(entry)
    highlightsByWorkspace.set(entry[1].sessionId, rows)
  }

  const result: Record<string, WorkspaceAttention> = {}
  for (const session of sessions) {
    const panes = panesByWorkspace.get(session.id) ?? []
    const paneById = new Map(panes.map((pane) => [pane.paneId, pane]))
    let best: AttentionAggregate = {
      attentionClass: 4,
      timestamp: 0,
      sources: new Set<string>(),
      causes: new Set<string>(),
    }
    let hasFreshNative = false
    const completedPaneIds = new Set<string>()

    const consider = (current: AttentionAggregate, attentionClass: 1 | 2 | 3 | 4, candidateTimestamp: number, source: string, cause: string): AttentionAggregate => {
      if (attentionClass < current.attentionClass) {
        current.attentionClass = attentionClass
        current.timestamp = candidateTimestamp
        current.sources.clear()
        current.causes.clear()
      }
      if (attentionClass !== current.attentionClass) return current
      current.timestamp = Math.max(current.timestamp, candidateTimestamp)
      if (source) current.sources.add(source)
      if (cause) current.causes.add(cause)
      return current
    }

    for (const pane of panes) {
      const resolved = resolveAttention(pane, now, fallbacks.reviewedPaneIds?.has(pane.paneId))
      hasFreshNative ||= resolved.freshNativeEvidence
      best = consider(best, resolved.attentionClass, resolved.timestamp, resolved.source, resolved.cause)
      if (resolved.attentionClass === 2) completedPaneIds.add(pane.paneId)
    }

    for (const [paneId, highlight] of highlightsByWorkspace.get(session.id) ?? []) {
      const pane = paneById.get(paneId)
      if (snapshot && !pane) continue
      if (fallbacks.reviewedPaneIds?.has(paneId) || pane?.interrupted || (pane && isFreshNativeEvidence(pane, now))) continue
      completedPaneIds.add(paneId)
      best = consider(best, 2, finiteTimestamp(highlight.completedAt), highlight.source, 'completion-marker')
    }

    if (!hasFreshNative) {
      if (fallbacks.conflictSessionIds?.has(session.id)) best = consider(best, 1, now, 'git', 'conflict')
      const permissions = fallbacks.hermesPermissions?.[session.id]?.length ?? 0
      if (permissions > 0) best = consider(best, 1, now, 'hermes', 'permission')
      else if (fallbacks.hermesStatus[session.id] === 'busy' || fallbacks.hermesStatus[session.id] === 'running') best = consider(best, 3, now, 'hermes', 'working')
    }

    const state: WorkspaceAttentionState = best.attentionClass === 1 ? 'blocked' : best.attentionClass === 2 ? 'done' : best.attentionClass === 3 ? 'working' : 'idle'
    result[session.id] = {
      attentionClass: best.attentionClass,
      timestamp: best.attentionClass === 4 ? 0 : best.timestamp,
      recentActivity: effectiveRecentActivity(session, projectionsBySession.get(session.id), panes, now),
      state,
      unreadCount: panes.reduce((count, pane) => count + Math.max(0, pane.unreadCount), 0),
      completionCount: completedPaneIds.size,
      source: [...best.sources].sort().join(', '),
      cause: [...best.causes].sort().join(', '),
    }
  }
  return result
}

export function buildWorkspaceComparator(
  mode: WorkspaceSortMode,
  attention: Record<string, WorkspaceAttention>,
  projections: WorktreeProjection[],
  manualOrder: string[],
): (left: SessionMeta, right: SessionMeta) => number {
  const projectionBySession = new Map(projections.flatMap((projection) => projection.record?.sessionId ? [[projection.record.sessionId, projection] as const] : []))
  const manualPosition = new Map(manualOrder.map((id, index) => [id, index]))
  return (left, right) => {
    if (mode === 'manual') {
      const leftPosition = manualPosition.get(left.id) ?? Number.MAX_SAFE_INTEGER
      const rightPosition = manualPosition.get(right.id) ?? Number.MAX_SAFE_INTEGER
      if (leftPosition !== rightPosition) return leftPosition < rightPosition ? -1 : 1
    } else if (mode === 'smart') {
      const leftClass = attention[left.id]?.attentionClass ?? 4
      const rightClass = attention[right.id]?.attentionClass ?? 4
      if (leftClass !== rightClass) return leftClass - rightClass
      const leftTimestamp = finiteTimestamp(attention[left.id]?.timestamp ?? 0)
      const rightTimestamp = finiteTimestamp(attention[right.id]?.timestamp ?? 0)
      if (leftTimestamp !== rightTimestamp) return rightTimestamp - leftTimestamp
      const leftRecent = finiteTimestamp(attention[left.id]?.recentActivity ?? left.createdAt * 1_000)
      const rightRecent = finiteTimestamp(attention[right.id]?.recentActivity ?? right.createdAt * 1_000)
      if (leftRecent !== rightRecent) return rightRecent - leftRecent
    } else if (mode === 'recent') {
      const recent = finiteTimestamp(attention[right.id]?.recentActivity ?? right.createdAt * 1_000) - finiteTimestamp(attention[left.id]?.recentActivity ?? left.createdAt * 1_000)
      if (recent !== 0) return recent
    } else if (mode === 'repository') {
      const leftRepository = projectionBySession.get(left.id)?.record?.repositoryPath ?? left.workspaceFolder ?? ''
      const rightRepository = projectionBySession.get(right.id)?.record?.repositoryPath ?? right.workspaceFolder ?? ''
      const repository = compareText(leftRepository.replace(/^.*[\\/]/, ''), rightRepository.replace(/^.*[\\/]/, ''))
      if (repository !== 0) return repository
    }
    const name = compareText(left.name, right.name)
    if (name !== 0) return name
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  }
}

export function deriveVisibleWorkspaceOrder(
  sessions: SessionMeta[],
  groups: WorkspaceGroup[],
  groupIds: Record<string, string>,
  worktrees: WorktreeProjection[],
  mode: WorkspaceSortMode,
  attention: Record<string, WorkspaceAttention>,
  manualOrder: string[],
): DerivedWorkspaceOrder {
  const sortedSessions = [...sessions].sort(buildWorkspaceComparator(mode, attention, worktrees, manualOrder))
  const rows = workspaceRows(sessions, groups, groupIds, sortedSessions.map((session) => session.id), worktrees)
  const visibleSessions = flattenWorkspaceRows(rows)
  return { rows, sessions: visibleSessions, sessionIds: visibleSessions.map((session) => session.id) }
}

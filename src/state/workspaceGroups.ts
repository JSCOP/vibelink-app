import type { SessionMeta } from '../ipc/types'
import { orderSessions } from './profiles'
import type { WorktreeProjection } from './worktrees'

export type WorkspaceGroup = {
  id: string
  name: string
  collapsed: boolean
  rootFolder?: string | null
}

export type WorkspaceWorktreeNode = {
  session: SessionMeta
  worktree: WorktreeProjection
  worktrees: WorkspaceWorktreeNode[]
}
export type WorkspaceSessionNode = {
  session: SessionMeta
  worktrees: WorkspaceWorktreeNode[]
  // Registry rows for this repository that own no workspace session: missing,
  // stale, conflicted, or untrusted checkouts. They are rendered explicitly so a
  // broken checkout is visible instead of silently absent.
  detached: WorktreeProjection[]
}

export type WorkspaceRow =
  | { kind: 'group'; group: WorkspaceGroup; sessions: WorkspaceSessionNode[] }
  | { kind: 'session'; node: WorkspaceSessionNode }


function workspaceFolderKey(folder: string | null | undefined): string | null {
  const normalized = folder?.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalized || null
}

export function workspaceGroupRootNode(group: WorkspaceGroup, nodes: readonly WorkspaceSessionNode[]): WorkspaceSessionNode | null {
  const rootFolder = workspaceFolderKey(group.rootFolder)
  if (!rootFolder) return null
  return nodes.find((node) => workspaceFolderKey(node.session.workspaceFolder) === rootFolder) ?? null
}

export type RecoveredWorkspaceGroups = {
  groups: WorkspaceGroup[]
  groupIds: Record<string, string>
}

/**
 * Recovers the structural group that existed before WebView localStorage was
 * cleared while daemon-owned sessions survived. Only a workspace with at least
 * two direct child workspaces is strong enough evidence; a one-child folder is
 * left alone so ordinary nested repositories are not grouped by surprise.
 */
export function recoverWorkspaceGroups(sessions: readonly SessionMeta[]): RecoveredWorkspaceGroups | null {
  const groups: WorkspaceGroup[] = []
  const groupIds: Record<string, string> = {}
  const folderBySession = new Map(sessions.flatMap((session) => {
    const folder = session.workspaceFolder?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
    return folder ? [[session.id, folder] as const] : []
  }))

  for (const root of sessions) {
    const rootFolder = folderBySession.get(root.id)
    const rootKey = workspaceFolderKey(rootFolder)
    if (!rootFolder || !rootKey) continue
    const children = sessions.filter((candidate) => {
      if (candidate.id === root.id) return false
      const folder = folderBySession.get(candidate.id)
      if (!folder) return false
      const separator = folder.lastIndexOf('/')
      return separator > 0 && workspaceFolderKey(folder.slice(0, separator)) === rootKey
    })
    if (children.length < 2) continue

    const id = `recovered-${root.id}`
    const separator = rootFolder.lastIndexOf('/')
    groups.push({
      id,
      name: rootFolder.slice(separator + 1) || root.name,
      collapsed: false,
      rootFolder,
    })
    for (const member of [root, ...children]) groupIds[member.id] = id
  }

  return groups.length > 0 ? { groups, groupIds } : null
}

function normalizeRepositoryPath(path: string | null | undefined): string {
  return (path ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}
export function workspaceRows(
  sessions: SessionMeta[],
  groups: WorkspaceGroup[],
  groupIds: Record<string, string>,
  order: string[],
  worktrees: WorktreeProjection[] = [],
): WorkspaceRow[] {
  const ordered = orderSessions(sessions, order)
  const sessionsById = new Map(ordered.map((session) => [session.id, session]))
  const orderRank = new Map(ordered.map((session, index) => [session.id, index]))
  const projectionBySession = new Map(worktrees.flatMap((projection) => {
    const sessionId = projection.record?.sessionId
    return sessionId && sessionsById.has(sessionId) ? [[sessionId, projection] as const] : []
  }))
  const projectionById = new Map(worktrees.map((projection) => [projection.id, projection]))
  const nodesBySession = new Map<string, WorkspaceWorktreeNode>()

  // Registry lineage is the only nesting authority. The daemon strips
  // `parentWorktreeId` from every edge that participates in a cycle or fails an
  // instance guard, so a rejected edge surfaces its child at root level instead
  // of being re-derived from session relations.
  const boundChildIdsByParentId = new Map<string, string[]>()
  for (const projection of worktrees) {
    const sessionId = projection.record?.sessionId
    const parentId = projection.parentWorktreeId
    if (!sessionId || !projectionBySession.has(sessionId) || !parentId || parentId === projection.id) continue
    const parent = projectionById.get(parentId)
    if (!parent?.record?.sessionId || !projectionBySession.has(parent.record.sessionId)) continue
    const siblings = boundChildIdsByParentId.get(parentId) ?? []
    siblings.push(projection.id)
    boundChildIdsByParentId.set(parentId, siblings)
  }

  const byVisibleOrder = (left: WorkspaceWorktreeNode, right: WorkspaceWorktreeNode) => {
    const leftRank = orderRank.get(left.session.id) ?? Number.MAX_SAFE_INTEGER
    const rightRank = orderRank.get(right.session.id) ?? Number.MAX_SAFE_INTEGER
    return leftRank === rightRank ? left.session.id.localeCompare(right.session.id) : leftRank - rightRank
  }

  const buildNode = (projection: WorktreeProjection, lineage: Set<string>): WorkspaceWorktreeNode | null => {
    const existing = nodesBySession.get(projection.record?.sessionId ?? '')
    if (existing) return existing
    const sessionId = projection.record?.sessionId
    const session = sessionId ? sessionsById.get(sessionId) : undefined
    if (!session || !sessionId || lineage.has(projection.id)) return null
    const nextLineage = new Set(lineage).add(projection.id)
    const children = (boundChildIdsByParentId.get(projection.id) ?? [])
      .flatMap((childId) => {
        const child = projectionById.get(childId)
        if (!child) return []
        const node = buildNode(child, nextLineage)
        return node ? [node] : []
      })
      .sort(byVisibleOrder)
    const node = { session, worktree: projection, worktrees: children }
    nodesBySession.set(sessionId, node)
    return node
  }

  // A worktree whose lineage edge was rejected, or whose parent is a plain
  // repository workspace, hangs off that repository session directly.
  const rootWorktreesByParentSession = new Map<string, WorkspaceWorktreeNode[]>()
  const attachedSessionIds = new Set<string>()
  for (const projection of worktrees) {
    const record = projection.record
    const sessionId = record?.sessionId
    if (!sessionId || !projectionBySession.has(sessionId)) continue
    if (projection.parentWorktreeId && boundChildIdsByParentId.get(projection.parentWorktreeId)?.includes(projection.id)) continue
    const parentSessionId = record?.parentSessionId
    if (!parentSessionId || parentSessionId === sessionId) continue
    if (!sessionsById.has(parentSessionId) || projectionBySession.has(parentSessionId)) continue
    const node = buildNode(projection, new Set())
    if (!node) continue
    const siblings = rootWorktreesByParentSession.get(parentSessionId) ?? []
    siblings.push(node)
    rootWorktreesByParentSession.set(parentSessionId, siblings)
    for (const attached of [node, ...flattenWorktreeNodes(node.worktrees)]) attachedSessionIds.add(attached.session.id)
  }
  for (const siblings of rootWorktreesByParentSession.values()) siblings.sort(byVisibleOrder)

  const detachedByRepository = new Map<string, WorktreeProjection[]>()
  for (const projection of worktrees) {
    const record = projection.record
    if (!record || record.sessionId || projection.native?.isMain) continue
    const repository = normalizeRepositoryPath(record.repositoryPath)
    if (!repository) continue
    const rows = detachedByRepository.get(repository) ?? []
    rows.push(projection)
    detachedByRepository.set(repository, rows)
  }

  const groupIdByRootFolder = new Map<string, string>()
  for (const group of groups) {
    const rootFolder = workspaceFolderKey(group.rootFolder)
    if (rootFolder && !groupIdByRootFolder.has(rootFolder)) groupIdByRootFolder.set(rootFolder, group.id)
  }

  const membersByGroup = new Map(groups.map((group) => [group.id, [] as WorkspaceSessionNode[]]))
  const ungrouped: WorkspaceSessionNode[] = []
  for (const session of ordered) {
    if (attachedSessionIds.has(session.id)) continue
    const isWorktreeSession = projectionBySession.has(session.id)
    const node: WorkspaceSessionNode = {
      session,
      worktrees: rootWorktreesByParentSession.get(session.id) ?? [],
      detached: isWorktreeSession ? [] : detachedByRepository.get(normalizeRepositoryPath(session.workspaceFolder)) ?? [],
    }
    const rootGroupId = workspaceFolderKey(session.workspaceFolder)
    const members = membersByGroup.get((rootGroupId && groupIdByRootFolder.get(rootGroupId)) || groupIds[session.id])
    if (members) members.push(node)
    else ungrouped.push(node)
  }

  return [
    ...groups.map((group) => ({ kind: 'group' as const, group, sessions: membersByGroup.get(group.id) ?? [] })),
    ...ungrouped.map((node) => ({ kind: 'session' as const, node })),
  ]
}

export function flattenWorkspaceRows(rows: WorkspaceRow[]): SessionMeta[] {
  const sessions: SessionMeta[] = []
  for (const row of rows) {
    const nodes = row.kind === 'group' ? row.sessions : [row.node]
    for (const node of nodes) {
      sessions.push(node.session, ...flattenWorktreeNodes(node.worktrees).map((worktree) => worktree.session))
    }
  }
  return sessions
}

export function workspaceRootSessions(rows: WorkspaceRow[]): SessionMeta[] {
  return rows.flatMap((row) => row.kind === 'group' ? row.sessions.map((node) => node.session) : [row.node.session])
}

export function flattenWorktreeNodes(nodes: WorkspaceWorktreeNode[]): WorkspaceWorktreeNode[] {
  const flattened: WorkspaceWorktreeNode[] = []
  for (const node of nodes) {
    flattened.push(node, ...flattenWorktreeNodes(node.worktrees))
  }
  return flattened
}

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

function normalizedWorkspaceFolder(folder: string | null | undefined): string | null {
  const normalized = folder?.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  return normalized || null
}

function olderSession(left: SessionMeta, right: SessionMeta): SessionMeta {
  return left.createdAt < right.createdAt || (left.createdAt === right.createdAt && left.id.localeCompare(right.id) < 0) ? left : right
}

export function workspaceGroupRootNode(group: WorkspaceGroup, nodes: readonly WorkspaceSessionNode[]): WorkspaceSessionNode | null {
  const rootFolder = workspaceFolderKey(group.rootFolder)
  if (!rootFolder) return null
  return nodes
    .filter((node) => workspaceFolderKey(node.session.workspaceFolder) === rootFolder)
    .reduce<WorkspaceSessionNode | null>((oldest, node) => !oldest || olderSession(node.session, oldest.session) === node.session ? node : oldest, null)
}

export type RecoveredWorkspaceGroups = {
  groups: WorkspaceGroup[]
  groupIds: Record<string, string>
}

export function recoverWorkspaceGroupRoots(
  groups: WorkspaceGroup[],
  groupIds: Readonly<Record<string, string>>,
  sessions: readonly SessionMeta[],
): WorkspaceGroup[] {
  let changed = false
  const repaired = groups.map((group) => {
    if (workspaceFolderKey(group.rootFolder)) return group
    const childrenByParent = new Map<string, { folder: string; children: Set<string> }>()
    for (const session of sessions) {
      if (groupIds[session.id] !== group.id) continue
      const folder = normalizedWorkspaceFolder(session.workspaceFolder)
      const separator = folder?.lastIndexOf('/') ?? -1
      if (!folder || separator <= 0) continue
      const parent = folder.slice(0, separator)
      const key = workspaceFolderKey(parent)
      const child = workspaceFolderKey(folder)
      if (!key || !child) continue
      const candidate = childrenByParent.get(key) ?? { folder: parent, children: new Set<string>() }
      candidate.children.add(child)
      childrenByParent.set(key, candidate)
    }
    const candidates = [...childrenByParent.values()]
      .filter((candidate) => candidate.children.size >= 2)
      .sort((left, right) => right.children.size - left.children.size || left.folder.localeCompare(right.folder))
    if (!candidates[0] || candidates[0].children.size === candidates[1]?.children.size) return group
    changed = true
    return { ...group, rootFolder: candidates[0].folder }
  })
  return changed ? repaired : groups
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
    const folder = normalizedWorkspaceFolder(session.workspaceFolder)
    return folder ? [[session.id, folder] as const] : []
  }))
  const seenRootFolders = new Set<string>()

  for (const root of [...sessions].sort((left, right) => olderSession(left, right) === left ? -1 : 1)) {
    const rootFolder = folderBySession.get(root.id)
    const rootKey = workspaceFolderKey(rootFolder)
    if (!rootFolder || !rootKey || seenRootFolders.has(rootKey)) continue
    seenRootFolders.add(rootKey)
    const childByFolder = new Map<string, SessionMeta>()
    for (const candidate of sessions) {
      if (candidate.id === root.id) continue
      const folder = folderBySession.get(candidate.id)
      if (!folder) continue
      const separator = folder.lastIndexOf('/')
      const childKey = workspaceFolderKey(folder)
      if (separator <= 0 || !childKey || workspaceFolderKey(folder.slice(0, separator)) !== rootKey) continue
      const existing = childByFolder.get(childKey)
      childByFolder.set(childKey, existing ? olderSession(existing, candidate) : candidate)
    }
    const children = [...childByFolder.values()]
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
  const groupIdByRootSession = new Map<string, string>()
  for (const group of groups) {
    const rootFolder = workspaceFolderKey(group.rootFolder)
    if (!rootFolder || groupIdByRootFolder.has(rootFolder)) continue
    groupIdByRootFolder.set(rootFolder, group.id)
    const root = ordered
      .filter((session) => workspaceFolderKey(session.workspaceFolder) === rootFolder)
      .reduce<SessionMeta | null>((oldest, session) => oldest ? olderSession(oldest, session) : session, null)
    if (root) groupIdByRootSession.set(root.id, group.id)
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
    const members = membersByGroup.get(groupIdByRootSession.get(session.id) || groupIds[session.id])
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

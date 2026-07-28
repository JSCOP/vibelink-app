import type { SessionMeta } from '../ipc/types'
import { orderSessions, type WorkspaceWorktree } from './profiles'

export type WorkspaceGroup = {
  id: string
  name: string
  collapsed: boolean
  rootFolder?: string | null
}

export type WorkspaceWorktreeNode = { session: SessionMeta; worktree: WorkspaceWorktree }
export type WorkspaceSessionNode = { session: SessionMeta; worktrees: WorkspaceWorktreeNode[] }

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
export function workspaceRows(
  sessions: SessionMeta[],
  groups: WorkspaceGroup[],
  groupIds: Record<string, string>,
  order: string[],
  worktrees: Record<string, WorkspaceWorktree> = {},
): WorkspaceRow[] {
  const ordered = orderSessions(sessions, order)
  const sessionsById = new Map(ordered.map((session) => [session.id, session]))
  const worktreesByParent = new Map<string, WorkspaceWorktreeNode[]>()
  const attachedWorktreeIds = new Set<string>()

  for (const session of ordered) {
    const worktree = worktrees[session.id]
    if (!worktree || worktree.parentSessionId === session.id || !sessionsById.has(worktree.parentSessionId)) continue
    const parentRelation = worktrees[worktree.parentSessionId]
    if (parentRelation && sessionsById.has(parentRelation.parentSessionId)) continue
    const children = worktreesByParent.get(worktree.parentSessionId) ?? []
    children.push({ session, worktree })
    worktreesByParent.set(worktree.parentSessionId, children)
    attachedWorktreeIds.add(session.id)
  }

  const groupIdByRootFolder = new Map<string, string>()
  for (const group of groups) {
    const rootFolder = workspaceFolderKey(group.rootFolder)
    if (rootFolder && !groupIdByRootFolder.has(rootFolder)) groupIdByRootFolder.set(rootFolder, group.id)
  }

  const membersByGroup = new Map(groups.map((group) => [group.id, [] as WorkspaceSessionNode[]]))
  const ungrouped: WorkspaceSessionNode[] = []
  for (const session of ordered) {
    if (attachedWorktreeIds.has(session.id)) continue
    const node = { session, worktrees: worktreesByParent.get(session.id) ?? [] }
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
    for (const node of nodes) sessions.push(node.session, ...node.worktrees.map((worktree) => worktree.session))
  }
  return sessions
}

export function workspaceRootSessions(rows: WorkspaceRow[]): SessionMeta[] {
  return rows.flatMap((row) => row.kind === 'group' ? row.sessions.map((node) => node.session) : [row.node.session])
}

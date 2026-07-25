import type { SessionMeta } from '../ipc/types'
import { orderSessions } from './profiles'

export type WorkspaceGroup = {
  id: string
  name: string
  collapsed: boolean
  rootFolder?: string | null
}

export type WorkspaceRow =
  | { kind: 'group'; group: WorkspaceGroup; sessions: SessionMeta[] }
  | { kind: 'session'; session: SessionMeta }

export function workspaceRows(
  sessions: SessionMeta[],
  groups: WorkspaceGroup[],
  groupIds: Record<string, string>,
  order: string[],
): WorkspaceRow[] {
  const membersByGroup = new Map(groups.map((group) => [group.id, [] as SessionMeta[]]))
  const ungrouped: SessionMeta[] = []

  for (const session of orderSessions(sessions, order)) {
    const members = membersByGroup.get(groupIds[session.id])
    if (members) members.push(session)
    else ungrouped.push(session)
  }

  return [
    ...groups.map((group) => ({ kind: 'group' as const, group, sessions: membersByGroup.get(group.id) ?? [] })),
    ...ungrouped.map((session) => ({ kind: 'session' as const, session })),
  ]
}

export function flattenWorkspaceRows(rows: WorkspaceRow[]): SessionMeta[] {
  const sessions: SessionMeta[] = []
  for (const row of rows) {
    if (row.kind === 'group') sessions.push(...row.sessions)
    else sessions.push(row.session)
  }
  return sessions
}

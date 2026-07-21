import type { HermesSessionInfo, HermesStatus, PendingPermission } from '../../state/hermes'

const VIEWED_STORAGE_KEY = 'vibelink:agentSessionViews'
const VIEWED_STORAGE_VERSION = 1

export type AgentSessionLiveState = {
  label: 'Waiting for input' | 'Working' | 'Idle' | 'Error' | 'Stopped'
  tone: 'waiting' | 'working' | 'idle' | 'error' | 'stopped'
  pulse: boolean
}

type ViewedSessionState = {
  version: 1
  workspaces: Record<string, Record<string, number>>
}

export function visibleAgentSessions(sessions: HermesSessionInfo[], search: string): HermesSessionInfo[] {
  const needle = search.trim().toLocaleLowerCase()
  const matches = needle
    ? sessions.filter((session) => `${session.title ?? ''}\n${session.id}\n${session.cwd ?? ''}`.toLocaleLowerCase().includes(needle))
    : sessions
  return matches
    .map((session, index) => ({ session, index, updatedAt: session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN }))
    .sort((left, right) => {
      const leftHasTime = Number.isFinite(left.updatedAt)
      const rightHasTime = Number.isFinite(right.updatedAt)
      if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1
      if (leftHasTime && rightHasTime && left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
      return left.index - right.index
    })
    .map(({ session }) => session)
}

export function agentSessionLiveState(status: HermesStatus, permissions: PendingPermission[]): AgentSessionLiveState {
  if (permissions.length > 0) return { label: 'Waiting for input', tone: 'waiting', pulse: false }
  if (status === 'starting' || status === 'busy') return { label: 'Working', tone: 'working', pulse: true }
  if (status === 'running') return { label: 'Idle', tone: 'idle', pulse: false }
  if (status === 'error') return { label: 'Error', tone: 'error', pulse: false }
  return { label: 'Stopped', tone: 'stopped', pulse: false }
}

export function agentSessionTitle(session: HermesSessionInfo): string {
  return session.title?.trim() || session.id.slice(0, 8)
}

export function compactAgentSessionCwd(cwd: string | null, workspaceFolder: string | null): string {
  if (!cwd) return 'Workspace unavailable'
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalizedWorkspace = workspaceFolder?.replace(/\\/g, '/').replace(/\/+$/, '') || ''
  if (normalizedWorkspace && normalizedCwd.toLocaleLowerCase() === normalizedWorkspace.toLocaleLowerCase()) return '.'
  if (normalizedWorkspace && normalizedCwd.toLocaleLowerCase().startsWith(`${normalizedWorkspace.toLocaleLowerCase()}/`)) {
    return `./${normalizedCwd.slice(normalizedWorkspace.length + 1)}`
  }
  const parts = normalizedCwd.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : normalizedCwd
}

export function formatAgentSessionUpdatedAt(value: string | null, now = Date.now()): string {
  if (!value) return 'Time unavailable'
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return value
  const elapsed = Math.max(0, now - timestamp)
  if (elapsed < 60_000) return 'Just now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`
  if (elapsed < 604_800_000) return `${Math.floor(elapsed / 86_400_000)}d ago`
  return new Date(timestamp).toLocaleDateString()
}

export function loadAgentSessionViews(storage: Pick<Storage, 'getItem'> | null): Record<string, Record<string, number>> {
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(VIEWED_STORAGE_KEY) || 'null') as Partial<ViewedSessionState> | null
    if (parsed?.version !== VIEWED_STORAGE_VERSION || !parsed.workspaces || typeof parsed.workspaces !== 'object') return {}
    return parsed.workspaces
  } catch {
    return {}
  }
}

export function saveAgentSessionViews(storage: Pick<Storage, 'setItem'> | null, views: Record<string, Record<string, number>>): void {
  if (!storage) return
  try {
    storage.setItem(VIEWED_STORAGE_KEY, JSON.stringify({ version: VIEWED_STORAGE_VERSION, workspaces: views } satisfies ViewedSessionState))
  } catch {
    // Session attention state is best-effort local UI metadata.
  }
}

export function agentSessionIsUnread(session: HermesSessionInfo, viewedAt: number | undefined): boolean {
  if (!session.updatedAt) return false
  const updatedAt = Date.parse(session.updatedAt)
  return Number.isFinite(updatedAt) && updatedAt > (viewedAt ?? 0)
}

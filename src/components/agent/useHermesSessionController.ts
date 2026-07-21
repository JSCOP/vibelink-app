import { useCallback, useMemo } from 'react'
import {
  hermesNewSession,
  hermesRefreshSessions,
  hermesResumeSession,
  startHermesAgent,
  type StartHermesAgentInput,
} from '../../ipc/hermes'
import type { HermesSessionInfo, HermesStatus, PendingPermission } from '../../state/hermes'
import { useWorkspaceStore } from '../../state/store'

const EMPTY_SESSIONS: HermesSessionInfo[] = []
const EMPTY_PERMISSIONS: PendingPermission[] = []

export type HermesSessionController = {
  workspaceId: string | null
  workspaceName: string
  workspaceFolder: string | null
  commandOverride: string | null
  status: HermesStatus
  error: string | null
  currentSessionId: string | null
  sessions: HermesSessionInfo[]
  permissions: PendingPermission[]
  actionsDisabled: boolean
  refreshSessions: () => Promise<boolean>
  newSession: () => Promise<string | null>
  resumeSession: (acpSessionId: string) => Promise<boolean>
}

export function useHermesSessionController(): HermesSessionController {
  const workspaceId = useWorkspaceStore((state) => state.activeSessionId ?? null)
  const workspace = useWorkspaceStore((state) => state.sessions.find((item) => item.id === state.activeSessionId))
  const commandOverride = useWorkspaceStore((state) => state.settings.hermesCommand?.trim() || null)
  const status = useWorkspaceStore((state) => workspaceId ? state.hermesStatus[workspaceId] ?? 'idle' : 'idle')
  const error = useWorkspaceStore((state) => state.error ?? null)
  const currentSessionId = useWorkspaceStore((state) => workspaceId ? state.hermesCurrentSession[workspaceId] ?? null : null)
  const nativeSessions = useWorkspaceStore((state) => workspaceId ? state.hermesSessions[workspaceId] ?? EMPTY_SESSIONS : EMPTY_SESSIONS)
  const permissions = useWorkspaceStore((state) => workspaceId ? state.hermesPermissions[workspaceId] ?? EMPTY_PERMISSIONS : EMPTY_PERMISSIONS)
  const setError = useWorkspaceStore((state) => state.setError)
  const workspaceFolder = workspace?.workspaceFolder?.trim() || null

  const sessions = useMemo(() => {
    if (!currentSessionId || nativeSessions.some((session) => session.id === currentSessionId)) return nativeSessions
    return [{ id: currentSessionId, title: null, updatedAt: null, cwd: workspaceFolder }, ...nativeSessions]
  }, [currentSessionId, nativeSessions, workspaceFolder])

  const startInput = useMemo<StartHermesAgentInput | null>(() => workspaceId ? ({
    sessionId: workspaceId,
    commandOverride,
    workspaceFolder,
  }) : null, [commandOverride, workspaceFolder, workspaceId])

  const refreshSessions = useCallback(async () => {
    if (!startInput) return false
    try {
      if (status === 'idle' || status === 'error') await startHermesAgent(startInput)
      await hermesRefreshSessions(startInput.sessionId)
      return true
    } catch (reason) {
      setError(String(reason))
      return false
    }
  }, [setError, startInput, status])

  const newSession = useCallback(async () => {
    if (!startInput || status === 'busy' || status === 'starting') return null
    try {
      return await hermesNewSession(startInput)
    } catch (reason) {
      setError(String(reason))
      return null
    }
  }, [setError, startInput, status])

  const resumeSession = useCallback(async (acpSessionId: string) => {
    if (!startInput || !acpSessionId || status === 'busy' || status === 'starting') return false
    if (acpSessionId === currentSessionId) return true
    try {
      await hermesResumeSession(startInput, acpSessionId)
      return true
    } catch (reason) {
      setError(String(reason))
      return false
    }
  }, [currentSessionId, setError, startInput, status])

  return {
    workspaceId,
    workspaceName: workspace?.name ?? '',
    workspaceFolder,
    commandOverride,
    status,
    error,
    currentSessionId,
    sessions,
    permissions,
    actionsDisabled: status === 'busy' || status === 'starting',
    refreshSessions,
    newSession,
    resumeSession,
  }
}

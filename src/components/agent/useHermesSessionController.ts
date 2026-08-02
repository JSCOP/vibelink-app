import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  hermesNewSession,
  hermesRefreshSessions,
  hermesResumeSession,
  startHermesAgent,
  type StartHermesAgentInput,
} from '../../ipc/hermes'
import { listAgentConversations, type AgentConversationInfo } from '../../ipc/agentHistory'
import type { HermesSessionInfo, HermesStatus, PendingPermission } from '../../state/hermes'
import { useWorkspaceStore } from '../../state/store'

const EMPTY_SESSIONS: HermesSessionInfo[] = []
const EMPTY_PERMISSIONS: PendingPermission[] = []
const EMPTY_CONVERSATIONS: AgentConversationInfo[] = []

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
  conversations: AgentConversationInfo[]
  conversationsLoading: boolean
  actionsDisabled: boolean
  refreshSessions: () => Promise<boolean>
  refreshConversations: () => Promise<void>
  newSession: () => Promise<string | null>
  resumeSession: (acpSessionId: string) => Promise<boolean>
}

export function useHermesSessionController(loadConversationHistory = true): HermesSessionController {
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

  const [conversationHistory, setConversationHistory] = useState<{ workspaceFolder: string; conversations: AgentConversationInfo[] } | null>(null)
  const [conversationsLoading, setConversationsLoading] = useState(false)
  const loadedConversationKeyRef = useRef<string | null>(null)
  const conversationKey = workspaceFolder ? `${workspaceFolder}\0${currentSessionId ?? ''}` : null

  // Load past agent conversations (omp / Codex / Claude on-disk transcripts) for
  // the active workspace so the panel shows a real history of prior sessions by
  // title, not just the single live ACP session. Re-runs when the workspace
  // changes or a new session is started/resumed (currentSessionId shifts).
  useEffect(() => {
    let cancelled = false
    if (!loadConversationHistory || !workspaceFolder || !conversationKey || loadedConversationKeyRef.current === conversationKey) return () => { cancelled = true }
    void Promise.resolve()
      .then(() => { if (!cancelled) setConversationsLoading(true) })
      .then(() => listAgentConversations(workspaceFolder))
      .then((list) => {
        if (cancelled) return
        loadedConversationKeyRef.current = conversationKey
        setConversationHistory({ workspaceFolder, conversations: list })
      })
      .finally(() => { if (!cancelled) setConversationsLoading(false) })
    return () => { cancelled = true }
  }, [conversationKey, loadConversationHistory, workspaceFolder])

  const startInput = useMemo<StartHermesAgentInput | null>(() => workspaceId ? ({
    sessionId: workspaceId,
    commandOverride,
    workspaceFolder,
  }) : null, [commandOverride, workspaceFolder, workspaceId])

  const reloadConversations = useCallback(async () => {
    if (!loadConversationHistory || !workspaceFolder) return
    setConversationsLoading(true)
    try {
      const list = await listAgentConversations(workspaceFolder)
      loadedConversationKeyRef.current = conversationKey
      setConversationHistory({ workspaceFolder, conversations: list })
    } finally {
      setConversationsLoading(false)
    }
  }, [conversationKey, loadConversationHistory, workspaceFolder])

  const refreshSessions = useCallback(async () => {
    void reloadConversations()
    if (!startInput) return false
    try {
      if (status === 'idle' || status === 'error') await startHermesAgent(startInput)
      await hermesRefreshSessions(startInput.sessionId)
      return true
    } catch (reason) {
      setError(String(reason))
      return false
    }
  }, [reloadConversations, setError, startInput, status])

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
  const conversationsCurrent = conversationHistory?.workspaceFolder === workspaceFolder

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
    conversations: conversationsCurrent ? conversationHistory.conversations : EMPTY_CONVERSATIONS,
    conversationsLoading: loadConversationHistory && Boolean(workspaceFolder) && (!conversationsCurrent || conversationsLoading),
    actionsDisabled: status === 'busy' || status === 'starting',
    refreshConversations: reloadConversations,
    refreshSessions,
    newSession,
    resumeSession,
  }
}

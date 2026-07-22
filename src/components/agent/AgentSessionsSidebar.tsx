import { useCallback, useMemo, useState } from 'react'
import { Bot, MessagesSquare, Plus, RefreshCw, Search } from 'lucide-react'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { useWorkspaceContentActions } from '../../layout/contentActions'
import { useWorkspaceStore } from '../../state/store'
import {
  agentConversationLabel,
  agentSessionIsUnread,
  agentSessionLiveState,
  agentSessionTitle,
  compactAgentSessionCwd,
  formatAgentSessionUpdatedAt,
  loadAgentSessionViews,
  saveAgentSessionViews,
  visibleAgentConversations,
  visibleAgentSessions,
} from './agentSessionsModel'
import { useHermesSessionController } from './useHermesSessionController'
import './AgentSessionsSidebar.css'

export type AgentSessionsSidebarProps = {
  onCollapse?: () => void
}

export function AgentSessionsSidebar({ onCollapse }: AgentSessionsSidebarProps) {
  const controller = useHermesSessionController()
  const contentActions = useWorkspaceContentActions()
  const setError = useWorkspaceStore((state) => state.setError)
  const [search, setSearch] = useState('')
  const [selection, setSelection] = useState(() => ({ workspaceId: controller.workspaceId, sessionId: controller.currentSessionId }))
  const [refreshing, setRefreshing] = useState(false)
  const [views, setViews] = useState<Record<string, Record<string, number>>>(() => loadAgentSessionViews(typeof window === 'undefined' ? null : window.localStorage))
  const shownSessions = useMemo(() => visibleAgentSessions(controller.sessions, search), [controller.sessions, search])
  const shownConversations = useMemo(() => visibleAgentConversations(controller.conversations, search), [controller.conversations, search])
  const preferredSessionId = selection.workspaceId === controller.workspaceId ? selection.sessionId : null
  const selectedSession = controller.sessions.find((session) => session.id === preferredSessionId)
    ?? controller.sessions.find((session) => session.id === controller.currentSessionId)
    ?? controller.sessions[0]
    ?? null
  const selectedSessionId = selectedSession?.id ?? null
  const workspaceViews = controller.workspaceId ? views[controller.workspaceId] ?? {} : {}
  const liveState = agentSessionLiveState(controller.status, controller.permissions)
  const selectSession = useCallback((sessionId: string) => {
    setSelection({ workspaceId: controller.workspaceId, sessionId })
  }, [controller.workspaceId])


  const markViewed = useCallback((acpSessionId: string) => {
    const workspaceId = controller.workspaceId
    if (!workspaceId) return
    setViews((current) => {
      const next = {
        ...current,
        [workspaceId]: {
          ...(current[workspaceId] ?? {}),
          [acpSessionId]: Date.now(),
        },
      }
      saveAgentSessionViews(typeof window === 'undefined' ? null : window.localStorage, next)
      return next
    })
  }, [controller.workspaceId])

  const activateAgent = useCallback(async (acpSessionId: string) => {
    try {
      const panelId = await contentActions.openContent({ kind: 'agent' })
      if (panelId) contentActions.activateContent(panelId)
      markViewed(acpSessionId)
      return true
    } catch (reason) {
      setError(String(reason))
      return false
    }
  }, [contentActions, markViewed, setError])

  const openSelected = async () => {
    if (!selectedSession) return
    if (selectedSession.id !== controller.currentSessionId) {
      if (!await controller.resumeSession(selectedSession.id)) return
    }
    selectSession(selectedSession.id)
    await activateAgent(selectedSession.id)
  }

  const createSession = async () => {
    const acpSessionId = await controller.newSession()
    if (!acpSessionId) return
    selectSession(acpSessionId)
    await activateAgent(acpSessionId)
  }

  const refresh = async () => {
    setRefreshing(true)
    try {
      await controller.refreshSessions()
    } finally {
      setRefreshing(false)
    }
  }

  const filter = (
    <label className="agent-sessions-search">
      <Search size={13} aria-hidden="true" />
      <input
        type="search"
        aria-label="Search agent sessions"
        value={search}
        placeholder="Search title, ID, or folder"
        onChange={(event) => setSearch(event.target.value)}
      />
    </label>
  )

  const headerActions = (
    <>
      <span className="agent-sessions-count" aria-label={`${shownSessions.length} shown of ${controller.sessions.length} recent sessions`}>
        {shownSessions.length}/{controller.sessions.length}
      </span>
      <button type="button" aria-label="Refresh agent sessions" title="Refresh agent sessions" disabled={refreshing || controller.status === 'starting'} onClick={() => void refresh()}>
        <RefreshCw size={13} aria-hidden="true" />
      </button>
      <button type="button" aria-label="New agent session" title="New agent session" disabled={controller.actionsDisabled || !controller.workspaceId} onClick={() => void createSession()}>
        <Plus size={13} aria-hidden="true" />
      </button>
    </>
  )

  const footer = selectedSession ? (
    <div className="agent-session-detail">
      <div className="agent-session-detail-heading">
        <strong>{agentSessionTitle(selectedSession)}</strong>
        {selectedSession.id === controller.currentSessionId ? <span>Current</span> : null}
      </div>
      <dl>
        <div><dt>Session</dt><dd><code>{selectedSession.id}</code></dd></div>
        <div><dt>Folder</dt><dd title={selectedSession.cwd ?? undefined}>{selectedSession.cwd || 'Unavailable'}</dd></div>
        <div><dt>Updated</dt><dd>{formatAgentSessionUpdatedAt(selectedSession.updatedAt)}</dd></div>
        {selectedSession.id === controller.currentSessionId ? <div><dt>Status</dt><dd>{liveState.label}</dd></div> : null}
      </dl>
      <button
        type="button"
        className="agent-session-primary-action"
        disabled={selectedSession.id !== controller.currentSessionId && controller.actionsDisabled}
        onClick={() => void openSelected()}
      >
        {selectedSession.id === controller.currentSessionId ? 'Open' : 'Resume'}
      </button>
    </div>
  ) : null

  return (
    <WorkspaceSidebarPanelShell
      title="Agent Sessions"
      icon={<MessagesSquare size={14} aria-hidden="true" />}
      actions={headerActions}
      filter={filter}
      footer={footer}
      onCollapse={onCollapse}
      collapsed={false}
      ariaLabel="Agent Sessions"
      state={controller.workspaceId && controller.sessions.length === 0 && shownConversations.length === 0
        ? { kind: refreshing || controller.conversationsLoading ? 'loading' : 'empty', message: refreshing || controller.conversationsLoading ? 'Loading agent sessions…' : 'No agent sessions yet' }
        : null}
      className="agent-sessions-sidebar"
    >
      {shownSessions.length > 0 ? (
        <>
          <div className="agent-session-group-label">Live sessions</div>
          <div className="agent-session-list" role="listbox" aria-label="Live agent sessions">
            {shownSessions.map((session) => {
              const isCurrent = session.id === controller.currentSessionId
              const isSelected = session.id === selectedSessionId
              const unread = agentSessionIsUnread(session, workspaceViews[session.id])
              return (
                <button
                  key={session.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`agent-session-row${isSelected ? ' selected' : ''}${unread ? ' unread' : ''}`}
                  onClick={() => selectSession(session.id)}
                  onDoubleClick={() => { selectSession(session.id); void openSelectedSession(session.id, isCurrent) }}
                  onKeyDown={(event) => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    void openSelectedSession(session.id, isCurrent)
                  }}
                >
                  <span className="agent-session-row-title">
                    {isCurrent ? <span role="status" className={`agent-session-status agent-session-status-${liveState.tone}${liveState.pulse ? ' pulsing' : ''}`} aria-label={liveState.label} title={liveState.label} /> : null}
                    <strong>{agentSessionTitle(session)}</strong>
                    {isCurrent ? <small>Current</small> : null}
                  </span>
                  <span className="agent-session-row-meta">
                    <span title={session.cwd ?? undefined}>{compactAgentSessionCwd(session.cwd, controller.workspaceFolder)}</span>
                    <time dateTime={session.updatedAt ?? undefined}>{formatAgentSessionUpdatedAt(session.updatedAt)}</time>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      ) : null}
      {shownConversations.length > 0 ? (
        <>
          <div className="agent-session-group-label">Recent conversations</div>
          <div className="agent-session-list" role="list" aria-label="Recent agent conversations">
            {shownConversations.map((conversation) => (
              <div key={`${conversation.agent}:${conversation.path}`} className="agent-session-row agent-conversation-row" role="listitem" title={conversation.path}>
                <span className="agent-session-row-title">
                  <Bot size={12} aria-hidden="true" />
                  <strong>{conversation.title}</strong>
                </span>
                <span className="agent-session-row-meta">
                  <span className="agent-conversation-agent">{agentConversationLabel(conversation.agent)}</span>
                  <time dateTime={conversation.updatedAt ?? undefined}>{formatAgentSessionUpdatedAt(conversation.updatedAt)}</time>
                </span>
              </div>
            ))}
          </div>
        </>
      ) : null}
    </WorkspaceSidebarPanelShell>
  )

  async function openSelectedSession(acpSessionId: string, isCurrent: boolean): Promise<void> {
    if (!isCurrent && !await controller.resumeSession(acpSessionId)) return
    selectSession(acpSessionId)
    await activateAgent(acpSessionId)
  }
}

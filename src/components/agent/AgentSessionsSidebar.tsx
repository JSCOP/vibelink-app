import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ListFilter, MessagesSquare, RefreshCw, Search, X } from 'lucide-react'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { useWorkspaceContentActions } from '../../layout/contentActions'
import { getOpenContentSnapshot, subscribeOpenContent } from '../../layout/openContentRegistry'
import { workspaceContentPanelId } from '../../layout/workspaceContentModel'
import { useWorkspaceStore } from '../../state/store'
import type { AgentConversationInfo } from '../../ipc/agentHistory'
import { ProfileIcon } from '../ProfileIcon'
import { agentIconName } from '../settings/agentBrand'
import { startAgentSessionDrag } from './agentSessionDrag'
import {
  agentConversationLabel,
  agentConversationPaneIds,
  agentResumeLaunch,
  formatAgentSessionUpdatedAt,
  visibleAgentConversations,
} from './agentSessionsModel'
import { useHermesSessionController } from './useHermesSessionController'
import './AgentSessionsSidebar.css'

export type AgentSessionsSidebarProps = {
  /** Dockview focus — header accent only. */
  active?: boolean
  /** Selected tab in its edge group. Content gating uses this, not `active`. */
  visible?: boolean
  collapsed?: boolean
  onCollapse?: () => void
}

const terminalPanelIdPrefix = workspaceContentPanelId({ kind: 'terminal', instanceId: '' })
const paneRevealTimers = new WeakMap<HTMLElement, number>()
const AGENT_SESSION_ROW_HEIGHT = 44
const AGENT_SESSION_INITIAL_ROWS = 30

export function AgentSessionsSidebar({ active = true, visible = true, collapsed = false, onCollapse }: AgentSessionsSidebarProps) {
  const enabled = visible && !collapsed
  const controller = useHermesSessionController(enabled)
  const contentActions = useWorkspaceContentActions()
  const setError = useWorkspaceStore((state) => state.setError)
  const activePaneId = useWorkspaceStore((state) => state.activePaneId)
  const panes = useWorkspaceStore((state) => state.panes)
  const openContent = useSyncExternalStore(subscribeOpenContent, getOpenContentSnapshot, getOpenContentSnapshot)
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [historyCollapsed, setHistoryCollapsed] = useState(false)
  const [hiddenAgents, setHiddenAgents] = useState<Set<string>>(() => new Set())
  const agentIds = useMemo(() => [...new Set(controller.conversations.map((conversation) => conversation.agent))]
    .sort((left, right) => agentConversationLabel(left).localeCompare(agentConversationLabel(right))), [controller.conversations])
  const hiddenAgentCount = agentIds.filter((agent) => hiddenAgents.has(agent)).length
  const enabledAgentCount = agentIds.length - hiddenAgentCount
  const shownConversations = useMemo(() => visibleAgentConversations(controller.conversations, search)
    .filter((conversation) => !hiddenAgents.has(conversation.agent)), [controller.conversations, hiddenAgents, search])
  const paneNumberById = useMemo(() => new Map(openContent.flatMap((item) => {
    if (item.kind !== 'terminal' || !item.panelId.startsWith(terminalPanelIdPrefix)) return []
    const paneId = item.panelId.slice(terminalPanelIdPrefix.length)
    return paneId ? [[paneId, 0] as const] : []
  }).map(([paneId], index) => [paneId, index + 1] as const)), [openContent])
  const listRef = useRef<HTMLDivElement | null>(null)
  // eslint-disable-next-line react-hooks/incompatible-library
  const conversationVirtualizer = useVirtualizer({
    count: enabled ? shownConversations.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: () => AGENT_SESSION_ROW_HEIGHT,
    getItemKey: (index) => {
      const conversation = shownConversations[index]
      return conversation ? `${conversation.agent}:${conversation.path}` : index
    },
    initialRect: { width: 320, height: 800 },
    overscan: 8,
  })
  const virtualRows = conversationVirtualizer.getVirtualItems()
  const conversationRows = virtualRows.length > 0
    ? virtualRows
    : Array.from({ length: Math.min(shownConversations.length, AGENT_SESSION_INITIAL_ROWS) }, (_, index) => ({
      index,
      size: AGENT_SESSION_ROW_HEIGHT,
      start: index * AGENT_SESSION_ROW_HEIGHT,
    }))

  const conversationPaneIds = useCallback((conversation: AgentConversationInfo) => agentConversationPaneIds(conversation, Object.values(panes))
    .sort((left, right) => (paneNumberById.get(left) ?? Number.MAX_SAFE_INTEGER) - (paneNumberById.get(right) ?? Number.MAX_SAFE_INTEGER)), [paneNumberById, panes])

  const revealPane = useCallback((paneId: string) => {
    contentActions.activateContent(workspaceContentPanelId({ kind: 'terminal', instanceId: paneId }))
    flashAgentSessionPane(paneId)
  }, [contentActions])

  /** Resume the conversation inside `paneId`, replacing whatever that pane is
   *  running. Without a pane the workspace opens a fresh terminal. */
  const resumeInPane = useCallback(async (conversation: AgentConversationInfo, paneId: string | undefined) => {
    const launch = agentResumeLaunch(conversation)
    if (!launch) {
      setError(`Resuming ${agentConversationLabel(conversation.agent)} conversations is not supported.`)
      return
    }
    try {
      const panelId = await contentActions.openContent({
        kind: 'terminal',
        cwd: conversation.cwd,
        shell: launch.shell,
        args: launch.args,
        title: launch.title,
        replacePaneId: paneId,
      })
      if (!panelId) return
      contentActions.activateContent(panelId)
      if (panelId.startsWith(terminalPanelIdPrefix)) flashAgentSessionPane(panelId.slice(terminalPanelIdPrefix.length))
    } catch (reason) {
      setError(String(reason))
    }
  }, [contentActions, setError])

  const resumeConversation = useCallback(async (conversation: AgentConversationInfo) => {
    const openPaneIds = conversationPaneIds(conversation)
    if (openPaneIds.length > 0) {
      revealPane(activePaneId && openPaneIds.includes(activePaneId) ? activePaneId : openPaneIds[0])
      return
    }
    await resumeInPane(conversation, activePaneId && panes[activePaneId]?.alive ? activePaneId : undefined)
  }, [activePaneId, conversationPaneIds, panes, resumeInPane, revealPane])

  const refresh = async () => {
    setRefreshing(true)
    try {
      await controller.refreshConversations()
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
        placeholder="Search sessions"
        onChange={(event) => setSearch(event.target.value)}
      />
      {search ? (
        <button type="button" className="agent-sessions-search-clear" aria-label="Clear agent session search" onClick={() => setSearch('')}>
          <X size={12} aria-hidden="true" />
        </button>
      ) : null}
    </label>
  )

  const headerActions = (
    <>
      <span
        className="agent-sessions-count"
        aria-label={`${shownConversations.length} shown of ${controller.conversations.length} conversations`}
        title={`${shownConversations.length} shown · ${controller.conversations.length} recent`}
      >
        {shownConversations.length}/{controller.conversations.length}
      </span>
      {agentIds.length > 0 ? (
        <details className="agent-sessions-view-menu">
          <summary aria-label="Agent session view options" title="View options">
            <ListFilter size={13} aria-hidden="true" />
            {hiddenAgentCount > 0 ? <span className="agent-sessions-view-badge" aria-hidden="true">{hiddenAgentCount}</span> : null}
          </summary>
          <div className="agent-sessions-view-popover">
            <span className="agent-sessions-view-title">Agents</span>
            {agentIds.map((agent) => {
              const checked = !hiddenAgents.has(agent)
              return (
                <label key={agent} className="agent-sessions-view-option">
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={checked && enabledAgentCount === 1}
                    onChange={(event) => {
                      const nextChecked = event.currentTarget.checked
                      setHiddenAgents((current) => {
                        if (!nextChecked && enabledAgentCount === 1) return current
                        const next = new Set(current)
                        if (nextChecked) next.delete(agent)
                        else next.add(agent)
                        return next
                      })
                    }}
                  />
                  <ProfileIcon name={agentIconName(agent)} size={13} />
                  <span>{agentConversationLabel(agent)}</span>
                </label>
              )
            })}
          </div>
        </details>
      ) : null}
      <button type="button" aria-label="Refresh agent sessions" title="Refresh agent sessions" disabled={refreshing || controller.conversationsLoading} onClick={() => void refresh()}>
        <RefreshCw size={13} aria-hidden="true" />
      </button>
    </>
  )

  return (
    <WorkspaceSidebarPanelShell
      title="Agent Session History"
      icon={<MessagesSquare size={14} aria-hidden="true" />}
      active={active}
      collapsed={collapsed}
      actions={headerActions}
      filter={filter}
      onCollapse={onCollapse}
      ariaLabel="Agent Sessions"
      state={!controller.workspaceId ? null
        : controller.conversations.length === 0
          ? { kind: refreshing || controller.conversationsLoading ? 'loading' : 'empty', message: refreshing || controller.conversationsLoading ? 'Loading agent sessions…' : 'No agent conversations yet' }
          : shownConversations.length === 0
            ? { kind: 'empty', message: 'No sessions match the current filters' }
            : null}
      className="agent-sessions-sidebar"
    >
      {enabled && shownConversations.length > 0 ? (
        <div className="agent-session-content">
          <button type="button" className="agent-session-group-label" aria-expanded={!historyCollapsed} onClick={() => setHistoryCollapsed((value) => !value)}>
            <ChevronRight size={14} aria-hidden="true" />
            <span>Recent conversations</span>
            <span className="agent-session-group-count">{shownConversations.length}</span>
          </button>
          <div ref={listRef} className={`agent-session-list${historyCollapsed ? ' is-collapsed' : ''}`} role="list" aria-label="Recent agent conversations">
            <div className="agent-session-list-viewport" style={{ height: conversationVirtualizer.getTotalSize() }}>
              {conversationRows.map((virtualRow) => {
                const conversation = shownConversations[virtualRow.index]
                if (!conversation) return null
                const openPaneIds = conversationPaneIds(conversation)
                const activeConversation = Boolean(activePaneId && openPaneIds.includes(activePaneId))
                const launch = agentResumeLaunch(conversation)
                const draggable = openPaneIds.length === 0 && Boolean(launch)
                const paneNumbers = openPaneIds.flatMap((paneId) => {
                  const paneNumber = paneNumberById.get(paneId)
                  return paneNumber ? [paneNumber] : []
                })
                const paneLabel = paneNumbers.length === 1 ? `Pane ${paneNumbers[0]}` : paneNumbers.length > 1 ? `Panes ${paneNumbers.join(', ')}` : null
                const actionTitle = paneLabel
                  ? `${activeConversation ? 'Active in' : 'Open in'} terminal ${paneLabel.toLocaleLowerCase()}. Click to reveal · ${conversation.path}`
                  : `Click to resume in the highlighted terminal pane, or drag onto any pane to resume there · ${conversation.path}`
                return (
                  <div key={`${conversation.agent}:${conversation.path}`} className="agent-session-list-slot" style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}>
                    <button
                      type="button"
                      className={`agent-session-row agent-conversation-row${openPaneIds.length ? ' is-open' : ''}${activeConversation ? ' is-active' : ''}${draggable ? ' is-draggable' : ''}`}
                      role="listitem"
                      aria-current={activeConversation ? 'true' : undefined}
                      aria-posinset={virtualRow.index + 1}
                      aria-setsize={shownConversations.length}
                      title={actionTitle}
                      onPointerDown={(event) => {
                        startAgentSessionDrag(event.nativeEvent, {
                          label: conversation.title,
                          canDrag: draggable,
                          onDrop: (paneId) => { void resumeInPane(conversation, paneId) },
                          onTap: () => { void resumeConversation(conversation) },
                        })
                      }}
                      onClick={() => { void resumeConversation(conversation) }}
                    >
                      <span className="agent-session-row-title">
                        <ProfileIcon name={agentIconName(conversation.agent)} size={13} className="agent-conversation-brand" />
                        <strong>{conversation.title}</strong>
                        {paneLabel ? <span className="agent-conversation-pane-badge">{paneLabel}</span> : null}
                      </span>
                      <span className="agent-session-row-meta">
                        <span className="agent-conversation-agent">{agentConversationLabel(conversation.agent)}</span>
                        <span className="agent-conversation-location" title={conversation.cwd ?? undefined}>{agentConversationFolderLabel(conversation.cwd)}</span>
                        <time dateTime={conversation.updatedAt ?? undefined}>{formatAgentSessionUpdatedAt(conversation.updatedAt)}</time>
                      </span>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      ) : null}

    </WorkspaceSidebarPanelShell>
  )
}

function agentConversationFolderLabel(value: string | null): string {
  if (!value) return 'Unknown location'
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const parts = normalized.split('/').filter(Boolean)
  return parts.slice(-2).join('/') || value
}

function flashAgentSessionPane(paneId: string): void {
  if (typeof document === 'undefined') return
  const reveal = () => {
    const shell = [...document.querySelectorAll<HTMLElement>('.terminal-panel-shell[data-pane-id]')]
      .find((candidate) => candidate.dataset.paneId === paneId)
    if (!shell) return
    const previous = paneRevealTimers.get(shell)
    if (previous !== undefined) window.clearTimeout(previous)
    shell.classList.remove('agent-session-pane-reveal')
    void shell.offsetWidth
    shell.classList.add('agent-session-pane-reveal')
    paneRevealTimers.set(shell, window.setTimeout(() => {
      shell.classList.remove('agent-session-pane-reveal')
      paneRevealTimers.delete(shell)
    }, 1000))
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal)
  else reveal()
}


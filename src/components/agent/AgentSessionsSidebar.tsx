import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { MessagesSquare, RefreshCw, Search } from 'lucide-react'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { useWorkspaceContentActions } from '../../layout/contentActions'
import { getOpenContentSnapshot, subscribeOpenContent } from '../../layout/openContentRegistry'
import { workspaceContentPanelId } from '../../layout/workspaceContentModel'
import { useWorkspaceStore } from '../../state/store'
import type { AgentConversationInfo } from '../../ipc/agentHistory'
import { ProfileIcon } from '../ProfileIcon'
import { agentIconName } from '../settings/agentBrand'
import {
  agentConversationLabel,
  agentConversationPaneIds,
  agentResumeLaunch,
  agentSessionDragEndEvent,
  clearAgentSessionDragPayload,
  formatAgentSessionUpdatedAt,
  visibleAgentConversations,
  writeAgentSessionDragPayload,
} from './agentSessionsModel'
import { useHermesSessionController } from './useHermesSessionController'
import './AgentSessionsSidebar.css'

export type AgentSessionsSidebarProps = {
  onCollapse?: () => void
}

const terminalPanelIdPrefix = workspaceContentPanelId({ kind: 'terminal', instanceId: '' })
const paneRevealTimers = new WeakMap<HTMLElement, number>()

export function AgentSessionsSidebar({ onCollapse }: AgentSessionsSidebarProps) {
  const controller = useHermesSessionController()
  const contentActions = useWorkspaceContentActions()
  const setError = useWorkspaceStore((state) => state.setError)
  const activePaneId = useWorkspaceStore((state) => state.activePaneId)
  const panes = useWorkspaceStore((state) => state.panes)
  const openContent = useSyncExternalStore(subscribeOpenContent, getOpenContentSnapshot, getOpenContentSnapshot)
  const [search, setSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const shownConversations = useMemo(() => visibleAgentConversations(controller.conversations, search), [controller.conversations, search])
  const paneNumberById = useMemo(() => new Map(openContent.flatMap((item) => {
    if (item.kind !== 'terminal' || !item.panelId.startsWith(terminalPanelIdPrefix)) return []
    const paneId = item.panelId.slice(terminalPanelIdPrefix.length)
    return paneId ? [[paneId, 0] as const] : []
  }).map(([paneId], index) => [paneId, index + 1] as const)), [openContent])

  const conversationPaneIds = useCallback((conversation: AgentConversationInfo) => agentConversationPaneIds(conversation, Object.values(panes))
    .sort((left, right) => (paneNumberById.get(left) ?? Number.MAX_SAFE_INTEGER) - (paneNumberById.get(right) ?? Number.MAX_SAFE_INTEGER)), [paneNumberById, panes])

  const revealPane = useCallback((paneId: string) => {
    contentActions.activateContent(workspaceContentPanelId({ kind: 'terminal', instanceId: paneId }))
    flashAgentSessionPane(paneId)
  }, [contentActions])

  const resumeConversation = useCallback(async (conversation: AgentConversationInfo) => {
    const openPaneIds = conversationPaneIds(conversation)
    if (openPaneIds.length > 0) {
      revealPane(activePaneId && openPaneIds.includes(activePaneId) ? activePaneId : openPaneIds[0])
      return
    }
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
        referencePaneId: activePaneId && panes[activePaneId]?.alive ? activePaneId : undefined,
      })
      if (!panelId) return
      contentActions.activateContent(panelId)
      if (panelId.startsWith(terminalPanelIdPrefix)) flashAgentSessionPane(panelId.slice(terminalPanelIdPrefix.length))
    } catch (reason) {
      setError(String(reason))
    }
  }, [activePaneId, contentActions, conversationPaneIds, panes, revealPane, setError])

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
        placeholder="Search title, agent, or folder"
        onChange={(event) => setSearch(event.target.value)}
      />
    </label>
  )

  const headerActions = (
    <>
      <span className="agent-sessions-count" aria-label={`${shownConversations.length} shown of ${controller.conversations.length} conversations`}>
        {shownConversations.length}/{controller.conversations.length}
      </span>
      <button type="button" aria-label="Refresh agent sessions" title="Refresh agent sessions" disabled={refreshing || controller.conversationsLoading} onClick={() => void refresh()}>
        <RefreshCw size={13} aria-hidden="true" />
      </button>
    </>
  )

  return (
    <WorkspaceSidebarPanelShell
      title="Agent Sessions"
      icon={<MessagesSquare size={14} aria-hidden="true" />}
      actions={headerActions}
      filter={filter}
      onCollapse={onCollapse}
      collapsed={false}
      ariaLabel="Agent Sessions"
      state={controller.workspaceId && controller.conversations.length === 0
        ? { kind: refreshing || controller.conversationsLoading ? 'loading' : 'empty', message: refreshing || controller.conversationsLoading ? 'Loading agent sessions…' : 'No agent conversations yet' }
        : null}
      className="agent-sessions-sidebar"
    >
      {shownConversations.length > 0 ? (
        <>
          <div className="agent-session-group-label">Recent conversations</div>
          <div className="agent-session-list" role="list" aria-label="Recent agent conversations">
            {shownConversations.map((conversation) => {
              const openPaneIds = conversationPaneIds(conversation)
              const active = Boolean(activePaneId && openPaneIds.includes(activePaneId))
              const launch = agentResumeLaunch(conversation)
              const draggable = openPaneIds.length === 0 && Boolean(launch)
              const paneNumbers = openPaneIds.flatMap((paneId) => {
                const paneNumber = paneNumberById.get(paneId)
                return paneNumber ? [paneNumber] : []
              })
              const paneLabel = paneNumbers.length === 1 ? `Pane ${paneNumbers[0]}` : paneNumbers.length > 1 ? `Panes ${paneNumbers.join(', ')}` : null
              const actionTitle = paneLabel
                ? `${active ? 'Active in' : 'Open in'} terminal ${paneLabel.toLocaleLowerCase()}. Click to reveal · ${conversation.path}`
                : `Click to resume beside the active terminal, or drag onto a terminal pane to replace it · ${conversation.path}`
              return (
                <button
                  key={`${conversation.agent}:${conversation.path}`}
                  type="button"
                  className={`agent-session-row agent-conversation-row${openPaneIds.length ? ' is-open' : ''}${active ? ' is-active' : ''}${draggable ? ' is-draggable' : ''}`}
                  role="listitem"
                  aria-current={active ? 'true' : undefined}
                  title={actionTitle}
                  draggable={draggable}
                  onDragStart={(event) => {
                    if (!launch || !draggable) {
                      event.preventDefault()
                      return
                    }
                    writeAgentSessionDragPayload(event.dataTransfer, { ...launch, cwd: conversation.cwd })
                    const dragIcon = event.currentTarget.querySelector('.agent-conversation-brand')
                    if (dragIcon) event.dataTransfer.setDragImage(dragIcon, 7, 7)
                  }}
                  onDragEnd={() => {
                    clearAgentSessionDragPayload()
                    window.dispatchEvent(new Event(agentSessionDragEndEvent))
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
                    <time dateTime={conversation.updatedAt ?? undefined}>{formatAgentSessionUpdatedAt(conversation.updatedAt)}</time>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      ) : null}

    </WorkspaceSidebarPanelShell>
  )
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


import { useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { WorkspaceContentActionsContext } from '../../layout/contentActions'
import { getOpenContentSnapshot, subscribeOpenContent, type OpenContentItem } from '../../layout/openContentRegistry'
import { workspaceContentPanelId } from '../../layout/workspaceContentModel'
import { useWorkspaceStore } from '../../state/store'
import { ProfileIcon } from '../ProfileIcon'
import { groupOpenContentItems } from './openContentGroups'
import { useAgentPaneStatuses } from '../../state/useAgentPaneStatuses'
import { aggregateAgentPaneStatus, type AgentPaneStatus } from '../../state/agentPaneStatus'

export type OpenWorkspaceItemsProps = {
  completionHighlights: Readonly<Record<string, unknown>>
}

const terminalPanelIdPrefix = workspaceContentPanelId({ kind: 'terminal', instanceId: '' })


function readCollapsedGroups(sessionId?: string): Set<string> {
  if (!sessionId) return new Set()
  try {
    const value = JSON.parse(window.localStorage.getItem(`vibelink:collapsed-terminal-groups:${sessionId}`) ?? '[]')
    return new Set(Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [])
  } catch {
    return new Set()
  }
}

export function OpenWorkspaceItems(props: OpenWorkspaceItemsProps) {
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  return <SessionOpenWorkspaceItems key={activeSessionId ?? ''} {...props} activeSessionId={activeSessionId} />
}

function SessionOpenWorkspaceItems({ completionHighlights, activeSessionId }: OpenWorkspaceItemsProps & { activeSessionId: string | undefined }) {
  const actions = useContext(WorkspaceContentActionsContext)
  const items = useSyncExternalStore(subscribeOpenContent, getOpenContentSnapshot, getOpenContentSnapshot)
  const groups = useMemo(() => groupOpenContentItems(items), [items])
  const agentStatuses = useAgentPaneStatuses()
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => readCollapsedGroups(activeSessionId ?? undefined))
  if (groups.length === 0) return null

  const paneIdOf = (item: OpenContentItem) => item.kind === 'terminal' && item.panelId.startsWith(terminalPanelIdPrefix)
    ? item.panelId.slice(terminalPanelIdPrefix.length) || null
    : null

  const responseCompleteFor = (item: OpenContentItem) => {
    const paneId = paneIdOf(item)
    return Boolean(paneId && completionHighlights[paneId])
  }

  const agentStatusFor = (item: OpenContentItem): AgentPaneStatus | null => {
    const paneId = paneIdOf(item)
    return paneId ? agentStatuses[paneId] ?? null : null
  }

  const activate = (item: OpenContentItem) => actions?.activateContent(item.panelId)

  const renderItem = (item: OpenContentItem) => {
    const responseComplete = responseCompleteFor(item)
    const agentStatus = agentStatusFor(item)
    return (
      <div
        key={item.panelId}
        className={`workspace-open-content-item${item.active ? ' is-active' : ''}${responseComplete ? ' is-complete' : ''}${item.kind === 'terminal' ? ' is-terminal-pane' : ''}`}
        role="button"
        tabIndex={actions ? 0 : -1}
        aria-current={item.active ? 'true' : undefined}
        aria-disabled={actions ? undefined : 'true'}
        data-open-content-panel-id={item.panelId}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); activate(item) }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          event.stopPropagation()
          activate(item)
        }}
      >
        <span className="workspace-open-content-icon" aria-hidden="true"><ProfileIcon name={item.icon} size={11} strokeWidth={1.8} /></span>
        <span className="workspace-open-content-title" title={item.title}>{item.title}</span>
        <span
          className={`workspace-open-content-status${item.active ? ' is-active' : ''}${responseComplete ? ' is-complete' : ''}${agentStatus ? ` is-agent-${agentStatus.state}${agentStatus.pulsing ? ' is-pulsing' : ''}` : ''}`}
          title={agentStatus ? agentStatus.label : responseComplete ? 'Response complete' : item.active ? 'Active item' : 'Open item'}
          aria-hidden="true"
        />
      </div>
    )
  }

  const toggleGroup = (panelId: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(panelId)) next.delete(panelId)
      else next.add(panelId)
      if (activeSessionId) window.localStorage.setItem(`vibelink:collapsed-terminal-groups:${activeSessionId}`, JSON.stringify([...next]))
      return next
    })
  }

  return (
    <div className="workspace-open-content-list" role="list" aria-label="Open workspace items">
      {groups.map((group) => {
        if (group.kind === 'item') return renderItem(group.item)
        const collapsed = collapsedGroups.has(group.window.panelId)
        const active = group.window.active || group.panes.some((pane) => pane.active)
        const completionCount = group.panes.filter(responseCompleteFor).length
        const hasCompletion = completionCount > 0
        const groupStatus = aggregateAgentPaneStatus(group.panes.flatMap((pane) => agentStatusFor(pane) ?? []))
        return (
          <div key={group.window.panelId} className={`workspace-open-content-group${active ? ' is-active' : ''}${hasCompletion ? ' has-completions' : ''}${collapsed ? ' is-collapsed' : ''}`} role="listitem">
            <button
              type="button"
              className={`workspace-open-content-group-header${hasCompletion ? ' is-complete' : ''}`}
              aria-expanded={!collapsed}
              aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${group.window.title}`}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); toggleGroup(group.window.panelId) }}
            >
              <span className="workspace-open-content-group-chevron" aria-hidden="true">{collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}</span>
              <span className="workspace-open-content-icon" aria-hidden="true"><ProfileIcon name={group.window.icon} size={11} strokeWidth={1.8} /></span>
              <span className="workspace-open-content-title" title={group.window.title}>{group.window.title}</span>
              <span className={`workspace-open-content-status${active ? ' is-active' : ''}${hasCompletion ? ' is-complete' : ''}${groupStatus ? ` is-agent-${groupStatus.state}${groupStatus.pulsing ? ' is-pulsing' : ''}` : ''}`} title={groupStatus ? `${group.window.title} · ${groupStatus.label}` : hasCompletion ? `${completionCount} completed ${completionCount === 1 ? 'pane' : 'panes'}` : active ? 'Active terminal window' : 'Open terminal window'} aria-hidden="true" />
            </button>
            {collapsed ? (
              <div className="workspace-open-content-icon-strip" role="group" aria-label={`${group.window.title} programs`}>
                {group.panes.map((pane) => {
                  const responseComplete = responseCompleteFor(pane)
                  const paneStatus = agentStatusFor(pane)
                  return (
                    <button
                      key={pane.panelId}
                      type="button"
                      className={`workspace-open-content-icon-button${pane.active ? ' is-active' : ''}${responseComplete ? ' is-complete' : ''}`}
                      title={paneStatus ? `${pane.title} · ${paneStatus.label}` : pane.title}
                      aria-label={`Activate ${pane.title}`}
                      aria-current={pane.active ? 'true' : undefined}
                      disabled={!actions}
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={(event) => { event.stopPropagation(); activate(pane) }}
                    >
                      <ProfileIcon name={pane.icon} size={12} strokeWidth={1.8} />
                      <span className={`workspace-open-content-icon-button-status${paneStatus ? ` is-agent-${paneStatus.state}${paneStatus.pulsing ? ' is-pulsing' : ''}` : ''}`} aria-hidden="true" />
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="workspace-open-content-group-members" role="group" aria-label={`${group.window.title} panes`}>
                {group.panes.map(renderItem)}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

import { useContext, useSyncExternalStore } from 'react'
import { WorkspaceContentActionsContext } from '../../layout/contentActions'
import { getOpenContentSnapshot, subscribeOpenContent } from '../../layout/openContentRegistry'
import { workspaceContentPanelId } from '../../layout/workspaceContentModel'
import { ProfileIcon } from '../ProfileIcon'

export type OpenWorkspaceItemsProps = {
  completionHighlights: Readonly<Record<string, unknown>>
}

const terminalPanelIdPrefix = workspaceContentPanelId({ kind: 'terminal', instanceId: '' })

export function OpenWorkspaceItems({ completionHighlights }: OpenWorkspaceItemsProps) {
  const actions = useContext(WorkspaceContentActionsContext)
  const items = useSyncExternalStore(subscribeOpenContent, getOpenContentSnapshot, getOpenContentSnapshot)

  if (items.length === 0) return null

  return (
    <div className="workspace-open-content-list" role="list" aria-label="Open workspace items">
      {items.map((item) => {
        const paneId = item.kind === 'terminal' && item.panelId.startsWith(terminalPanelIdPrefix)
          ? item.panelId.slice(terminalPanelIdPrefix.length) || null
          : null
        const responseComplete = Boolean(paneId && completionHighlights[paneId])
        return (
          <div
            key={item.panelId}
            className={`workspace-open-content-item${item.active ? ' is-active' : ''}${item.kind === 'terminal' ? ' is-terminal-pane' : ''}`}
            role="button"
            tabIndex={actions ? 0 : -1}
            aria-current={item.active ? 'true' : undefined}
            aria-disabled={actions ? undefined : 'true'}
            data-open-content-panel-id={item.panelId}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation()
              actions?.activateContent(item.panelId)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              event.stopPropagation()
              actions?.activateContent(item.panelId)
            }}
          >
            <span className="workspace-open-content-icon" aria-hidden="true"><ProfileIcon name={item.icon} size={13} strokeWidth={1.8} /></span>
            <span className="workspace-open-content-title" title={item.title}>{item.title}</span>
            <span
              className={`workspace-open-content-status${item.active ? ' is-active' : ''}${responseComplete ? ' is-complete' : ''}`}
              title={responseComplete ? 'Response complete' : item.active ? 'Active item' : 'Open item'}
              aria-hidden="true"
            />
          </div>
        )
      })}
    </div>
  )
}

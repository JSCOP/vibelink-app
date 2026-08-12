import { useEffect, useState, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { IDockviewPanelHeaderProps } from 'dockview-react'
import { SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react'
import { ProfileIcon } from './ProfileIcon'
import { useWorkspaceStore } from '../state/store'
import { useWorkspaceContentActions } from '../layout/contentActions'
import { parseWorkspaceContentParams, type WorkspaceContentParams } from '../layout/workspaceContentModel'
import { agentPaneStatusClassName } from '../state/agentPaneStatus'
import { useAgentPaneStatus } from '../state/useAgentPaneStatuses'

type TerminalPaneTitleBarProps = IDockviewPanelHeaderProps<WorkspaceContentParams>

/** Per-pane title bar for the INNER terminal-window Dockview. Shows the pane
 * icon, role, editable title, split, and close. Dragging the bar reorders /
 * splits the pane inside its window (native Dockview tab drag). This is NOT an
 * addable tab strip — panes never contain other window kinds. */
export function TerminalPaneTitleBar({ api, params }: TerminalPaneTitleBarProps) {
  const actions = useWorkspaceContentActions()
  const content = parseWorkspaceContentParams(params)
  const paneId = content?.kind === 'terminal' ? content.paneId : null
  const role = useWorkspaceStore((state) => paneId ? state.settings.paneRoles[paneId] : undefined)
  const hasCompletionHighlight = useWorkspaceStore((state) => paneId ? Boolean(state.paneCompletionHighlights[paneId]) : false)
  const reviewed = useWorkspaceStore((state) => paneId ? Boolean(state.paneReviewMarkers[paneId]) : false)
  const agentStatus = useAgentPaneStatus(paneId)
  const [title, setTitle] = useState(api.title ?? content?.title ?? 'Shell')
  const [draftTitle, setDraftTitle] = useState(title)
  const [isEditing, setIsEditing] = useState(false)
  const [isActive, setIsActive] = useState(api.isActive)

  useEffect(() => {
    const syncTitle = () => setTitle(api.title ?? 'Shell')
    const syncActive = () => setIsActive(api.isActive)
    const titleDisposable = api.onDidTitleChange(syncTitle)
    const activeDisposable = api.onDidActiveChange(syncActive)
    syncTitle()
    syncActive()
    return () => {
      titleDisposable.dispose()
      activeDisposable.dispose()
    }
  }, [api])

  const activateAndStop = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault()
    event.stopPropagation()
    api.setActive()
  }

  const commitTitle = () => {
    setIsEditing(false)
    const next = draftTitle.trim()
    if (paneId && next && next !== title) void actions.renameContent(api.id, next)
  }

  const startEditing = (event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target
    if (!paneId || (target instanceof Element && target.closest('.terminal-tab-actions, input'))) return
    event.preventDefault()
    event.stopPropagation()
    api.setActive()
    setDraftTitle(title)
    setIsEditing(true)
  }

  const onTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); commitTitle() }
    else if (event.key === 'Escape') { event.preventDefault(); setDraftTitle(title); setIsEditing(false) }
  }

  const accessibleTitle = [title, role ? `role ${role}` : '', agentStatus?.label ?? ''].filter(Boolean).join(' · ')

  return (
    <div
      className={`workspace-content-tab terminal-pane-title-bar workspace-content-tab-terminal${hasCompletionHighlight ? ' terminal-tab-response-complete' : ''}${reviewed ? ' terminal-tab-reviewed' : ''}${isActive ? ' is-active' : ''}`}
      title={reviewed ? `${title} · reviewed` : hasCompletionHighlight ? `${title} · response complete` : accessibleTitle}
      data-content-panel-id={api.id}
      data-pane-id={paneId ?? undefined}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      aria-label={accessibleTitle}
      onDoubleClick={startEditing}
    >
      <span aria-hidden="true"><ProfileIcon name={content?.icon} size={13} className="terminal-tab-icon" /></span>
      {agentStatus ? <span className={agentPaneStatusClassName(agentStatus)} title={agentStatus.label} aria-label={agentStatus.label} /> : null}
      {/* An unassigned role is not information; the chip only made every pane
          title bar wider. Show it when a role actually exists. */}
      {role ? <span className="terminal-tab-role" title={`Pane role: ${role}`}>{role}</span> : null}
      {isEditing && paneId ? (
        <input
          className="terminal-tab-title-input"
          aria-label="Terminal pane title"
          value={draftTitle}
          autoFocus
          onBlur={commitTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onKeyDown={onTitleKeyDown}
          onMouseDown={activateAndStop}
          onPointerDown={activateAndStop}
        />
      ) : (
        <span
          className="terminal-tab-title"
          title="Terminal pane. Drag with Dockview to move; double-click to rename."
        >
          {title}
        </span>
      )}
      <div className="terminal-tab-actions" data-dockview-dnd-disabled="true" onMouseDown={activateAndStop} onPointerDown={activateAndStop}>
        <div className="terminal-tab-quick-actions"><div>
        {paneId ? (
          <>
            <button type="button" title="Split terminal right" aria-label="Split terminal right" onClick={(event) => { activateAndStop(event); void actions.splitTerminal(paneId, 'right') }}>
              <SplitSquareVertical size={12} aria-hidden="true" />
            </button>
            <button type="button" title="Split terminal below" aria-label="Split terminal below" onClick={(event) => { activateAndStop(event); void actions.splitTerminal(paneId, 'below') }}>
              <SplitSquareHorizontal size={12} aria-hidden="true" />
            </button>
          </>
        ) : null}
        </div></div>
        <button type="button" className="terminal-tab-close" title="Close terminal" aria-label="Close terminal" onClick={(event) => { activateAndStop(event); void actions.requestCloseContent(api.id) }}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

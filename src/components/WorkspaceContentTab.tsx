import { useEffect, useState, type KeyboardEvent } from 'react'
import type { IDockviewPanelHeaderProps } from 'dockview-react'
import { CheckCircle2, Maximize2, Minimize2, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react'
import { ProfileIcon } from './ProfileIcon'
import { useWorkspaceStore } from '../state/store'
import { formatKeyChord } from '../state/keybindings'
import { useWorkspaceContentActions } from '../layout/contentActions'
import { parseWorkspaceContentParams, type WorkspaceContentParams } from '../layout/workspaceContentModel'

type WorkspaceContentTabProps = IDockviewPanelHeaderProps<WorkspaceContentParams>

export function WorkspaceContentTab({ api, containerApi, params }: WorkspaceContentTabProps) {
  const actions = useWorkspaceContentActions()
  const content = parseWorkspaceContentParams(params)
  const paneId = content?.kind === 'terminal' ? content.paneId : null
  const role = useWorkspaceStore((state) => paneId && state.license.ready && state.license.status?.entitled ? state.settings.paneRoles[paneId] : undefined)
  const hasCompletionHighlight = useWorkspaceStore((state) => paneId ? Boolean(state.paneCompletionHighlights[paneId]) : false)
  const reviewed = useWorkspaceStore((state) => paneId ? Boolean(state.paneReviewMarkers[paneId]) : false)
  const reviewShortcut = useWorkspaceStore((state) => formatKeyChord(state.settings.keybindings.togglePaneReviewed))
  const [title, setTitle] = useState(api.title ?? content?.title ?? 'Content')
  const [draftTitle, setDraftTitle] = useState(title)
  const [isEditing, setIsEditing] = useState(false)
  const [isActive, setIsActive] = useState(api.isActive)
  const [isMaximized, setIsMaximized] = useState(() => api.isMaximized())

  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => setTitle(event.title))
    return () => disposable.dispose()
  }, [api])

  useEffect(() => {
    const syncActive = () => setIsActive(api.isActive)
    const syncMaximized = () => setIsMaximized(api.isMaximized())
    const active = api.onDidActiveChange(syncActive)
    const group = api.onDidGroupChange(syncMaximized)
    const maximized = containerApi.onDidMaximizedGroupChange(syncMaximized)
    syncActive()
    syncMaximized()
    return () => {
      active.dispose()
      group.dispose()
      maximized.dispose()
    }
  }, [api, containerApi])

  const activateAndStop = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    actions.activateContent(api.id)
    event.preventDefault()
    event.stopPropagation()
  }
  const commitTitle = () => {
    const nextTitle = draftTitle.trim()
    setIsEditing(false)
    if (paneId && nextTitle && nextTitle !== title) void actions.renameTerminal(paneId, nextTitle)
  }
  const onTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      commitTitle()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setDraftTitle(title)
      setIsEditing(false)
    }
  }
  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    event.stopPropagation()
    actions.activateContent(api.id)
  }

  return (
    <div
      className={`workspace-content-tab workspace-content-tab-${content?.kind ?? 'unknown'}${hasCompletionHighlight ? ' terminal-tab-response-complete' : ''}${reviewed ? ' terminal-tab-reviewed' : ''}`}
      title={reviewed ? `${title} · reviewed` : hasCompletionHighlight ? `${title} · response complete` : title}
      data-content-panel-id={api.id}
      data-pane-id={paneId ?? undefined}
      role="tab"
      tabIndex={0}
      aria-selected={isActive}
      aria-label={title}
      onPointerDown={() => actions.activateContent(api.id)}
      onKeyDown={onRootKeyDown}
    >
      <span aria-hidden="true"><ProfileIcon name={content?.icon} size={13} className="terminal-tab-icon" /></span>
      {paneId
        ? <span className={`terminal-tab-role${role ? '' : ' terminal-tab-role-unset'}`} title={role ? `Pane role: ${role}` : 'No pane role assigned'}>{role ?? 'No role'}</span>
        : <span className="workspace-tab-kind">{content?.kind ?? 'content'}</span>}
      {isEditing && paneId ? (
        <input
          className="terminal-tab-title-input"
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
          title={paneId ? 'Terminal content. Drag with Dockview to move; double-click to rename.' : 'Workspace content. Drag with Dockview to move.'}
          onDoubleClick={() => {
            if (!paneId) return
            setDraftTitle(title)
            setIsEditing(true)
          }}
        >
          {title}
        </span>
      )}
      <div className="terminal-tab-actions" data-dockview-dnd-disabled="true" onMouseDown={activateAndStop} onPointerDown={activateAndStop}>
        {paneId ? (
          <>
            <button type="button" className={reviewed ? 'terminal-tab-review-button-active' : undefined} aria-pressed={reviewed} aria-label={reviewed ? 'Mark terminal as not reviewed' : 'Mark terminal as reviewed'} title={reviewed ? `Mark as not reviewed (${reviewShortcut})` : `Mark as reviewed (${reviewShortcut})`} onClick={(event) => { activateAndStop(event); useWorkspaceStore.getState().togglePaneReviewed(paneId) }}>
              <CheckCircle2 size={12} aria-hidden="true" />
            </button>
            <button type="button" title="Split terminal right" aria-label="Split terminal right" onClick={(event) => { activateAndStop(event); void actions.splitTerminal(paneId, 'right') }}>
              <SplitSquareVertical size={12} aria-hidden="true" />
            </button>
            <button type="button" title="Split terminal below" aria-label="Split terminal below" onClick={(event) => { activateAndStop(event); void actions.splitTerminal(paneId, 'below') }}>
              <SplitSquareHorizontal size={12} aria-hidden="true" />
            </button>
          </>
        ) : null}
        <button type="button" title={isMaximized ? 'Restore content' : 'Maximize content'} aria-label={isMaximized ? 'Restore content' : 'Maximize content'} onClick={(event) => { activateAndStop(event); actions.toggleMaximizeContent(api.id); setIsMaximized(api.isMaximized()) }}>
          {isMaximized ? <Minimize2 size={12} aria-hidden="true" /> : <Maximize2 size={12} aria-hidden="true" />}
        </button>
        <button type="button" title={paneId ? 'Close terminal' : 'Close content'} aria-label={paneId ? 'Close terminal' : 'Close content'} onClick={(event) => { activateAndStop(event); void actions.requestCloseContent(api.id) }}>
          <X size={12} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

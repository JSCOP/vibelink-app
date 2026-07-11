import { useEffect, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import type { IDockviewPanelHeaderProps } from 'dockview-react'
import { Maximize2, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react'
import { ProfileIcon } from './ProfileIcon'
import { useWorkspaceStore } from '../state/store'
import { useWorkspaceWindowActions } from '../layout/windowActions'
import { hasWorkspaceWindowDragPayload, workspaceWindowDragMime } from '../layout/windowDrag'
import type { WorkspaceWindowKind } from '../layout/workspaceLayoutModel'

type WorkspaceWindowTabProps = IDockviewPanelHeaderProps & {
  api: IDockviewPanelHeaderProps['api'] & {
    close: () => void
    maximize: () => void
    exitMaximized: () => void
    isMaximized: () => boolean
  }
  params?: {
    paneId?: string
    title?: string | null
    icon?: string | null
    kind?: WorkspaceWindowKind
  }
}

const dragDisabledSelector = 'button, input, textarea, select, [contenteditable="true"], [data-window-drag-disabled="true"]'

export function WorkspaceWindowTab({ api, params }: WorkspaceWindowTabProps) {
  const actions = useWorkspaceWindowActions()
  const panelId = api.id
  const paneId = params?.paneId
  const kind = params?.kind ?? (paneId ? 'terminal' : undefined)
  const isTerminalPane = kind === 'terminal' && Boolean(paneId)
  const role = useWorkspaceStore((state) => paneId && state.license.ready && state.license.status?.entitled ? state.settings.paneRoles[paneId] : undefined)
  const hasCompletionHighlight = useWorkspaceStore((state) => paneId
    ? Boolean(state.paneCompletionHighlights[paneId])
    : kind === 'terminal' && Object.keys(state.paneCompletionHighlights).length > 0)
  const [title, setTitle] = useState(api.title ?? params?.title ?? (kind === 'agent' ? 'VibeLink Agent' : 'Window'))
  const [draftTitle, setDraftTitle] = useState(title)
  const [isEditing, setIsEditing] = useState(false)
  const dragStartBlockedRef = useRef(false)

  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => setTitle(event.title))
    return () => disposable.dispose()
  }, [api])

  const activate = () => actions.activateWindow(panelId)
  const activateAndStop = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    activate()
    event.preventDefault()
    event.stopPropagation()
  }
  const commitTitle = () => {
    const nextTitle = draftTitle.trim()
    setIsEditing(false)
    if (paneId && nextTitle && nextTitle !== title) {
      void actions.renameTerminalTitle(paneId, nextTitle)
    }
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
  const rememberDragStartTarget = (event: { target: EventTarget | null }) => {
    dragStartBlockedRef.current = isWindowDragDisabledTarget(event.target)
  }
  const onDragStart = (event: DragEvent<HTMLElement>) => {
    const blocked = dragStartBlockedRef.current || isWindowDragDisabledTarget(event.target)
    dragStartBlockedRef.current = false
    if (isEditing || blocked) {
      event.preventDefault()
      event.stopPropagation()
      return
    }
    activate()
    event.stopPropagation()
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData(workspaceWindowDragMime, panelId)
  }
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!hasWorkspaceWindowDragPayload(event.dataTransfer.types)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
  }
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!hasWorkspaceWindowDragPayload(event.dataTransfer.types)) return
    event.preventDefault()
    event.stopPropagation()
    const sourcePanelId = event.dataTransfer.getData(workspaceWindowDragMime)
    if (sourcePanelId && sourcePanelId !== panelId) void actions.swapWindowLocations(sourcePanelId, panelId)
  }

  return (
    <div
      className={`workspace-window-tab workspace-window-tab-${kind ?? 'generic'}${hasCompletionHighlight ? ' terminal-tab-response-complete' : ''}`}
      title={hasCompletionHighlight ? `${title} · response complete` : title}
      data-window-panel-id={panelId}
      data-pane-id={paneId}
      draggable={!isEditing}
      onPointerDownCapture={rememberDragStartTarget}
      onMouseDownCapture={rememberDragStartTarget}
      onDragStartCapture={onDragStart}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <ProfileIcon name={params?.icon} size={13} className="terminal-tab-icon" />
      {isTerminalPane ? <span className={`terminal-tab-role${role ? '' : ' terminal-tab-role-unset'}`} title={role ? `Pane role: ${role}` : 'No pane role assigned'}>{role ?? 'No role'}</span> : <span className="workspace-tab-kind">Window</span>}
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
        <span className="terminal-tab-title" title={isTerminalPane ? 'Terminal pane. Drag to move. Double-click to rename.' : 'Workspace window. Drag to move.'} onDoubleClick={() => {
          if (!paneId) return
          setDraftTitle(title)
          setIsEditing(true)
        }}>
          {title}
        </span>
      )}
      <div className="terminal-tab-actions" data-window-drag-disabled="true" onMouseDown={activateAndStop} onPointerDown={activateAndStop}>
        {isTerminalPane ? (
          <>
            <button type="button" title="Split terminal pane right" onClick={(event) => { activateAndStop(event); if (paneId) void actions.splitTerminal(paneId, 'right') }}>
              <SplitSquareVertical size={12} />
            </button>
            <button type="button" title="Split terminal pane down" onClick={(event) => { activateAndStop(event); if (paneId) void actions.splitTerminal(paneId, 'below') }}>
              <SplitSquareHorizontal size={12} />
            </button>
          </>
        ) : null}
        <button type="button" title={isTerminalPane ? 'Maximize pane' : 'Maximize window'} onClick={(event) => { activateAndStop(event); actions.toggleMaximize(panelId) }}>
          <Maximize2 size={12} />
        </button>
        <button type="button" title={isTerminalPane ? 'Close terminal pane' : 'Close window'} onClick={(event) => { activateAndStop(event); void actions.closeWindow(panelId) }}>
          <X size={12} />
        </button>
      </div>
    </div>
  )
}

function isWindowDragDisabledTarget(target: EventTarget | null): boolean {
  const closest = (target as { closest?: (selector: string) => Element | null } | null)?.closest
  return typeof closest === 'function' && Boolean(closest.call(target, dragDisabledSelector))
}

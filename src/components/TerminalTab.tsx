import { useEffect, useState, type KeyboardEvent } from 'react'
import type { DockviewApi, IDockviewPanelHeaderProps } from 'dockview-react'
import { Maximize2, PanelRightClose, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react'
import { useWorkspaceActions } from '../layout/actions'

type TerminalTabProps = IDockviewPanelHeaderProps & {
  api: IDockviewPanelHeaderProps['api'] & {
    close: () => void
    maximize: () => void
    exitMaximized: () => void
    isMaximized: () => boolean
  }
  containerApi: DockviewApi
  params?: {
    paneId?: string
    title?: string | null
  }
}

export function TerminalTab({ api, params }: TerminalTabProps) {
  const actions = useWorkspaceActions()
  const [title, setTitle] = useState(api.title ?? params?.title ?? 'Shell')
  const paneId = params?.paneId
  const [draftTitle, setDraftTitle] = useState(title)
  const [isEditing, setIsEditing] = useState(false)

  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => setTitle(event.title))
    return () => disposable.dispose()
  }, [api])


  const commitTitle = () => {
    const nextTitle = draftTitle.trim()
    setIsEditing(false)
    if (paneId && nextTitle && nextTitle !== title) {
      void actions.renamePaneTitle(paneId, nextTitle)
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

  const activatePane = () => {
    if (paneId) actions.activatePane(paneId)
  }

  const stopChromeEvent = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const activatePaneAndStop = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    activatePane()
    stopChromeEvent(event)
  }

  const onMaximize = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    activatePaneAndStop(event)
    if (api.isMaximized()) api.exitMaximized()
    else api.maximize()
  }

  return (
    <div className="terminal-tab" title={title} onMouseDown={activatePane} onPointerDown={activatePane}>
      {isEditing ? (
        <input
          className="terminal-tab-title-input"
          value={draftTitle}
          autoFocus
          onBlur={commitTitle}
          onChange={(event) => setDraftTitle(event.target.value)}
          onKeyDown={onTitleKeyDown}
          onMouseDown={activatePaneAndStop}
          onPointerDown={activatePaneAndStop}
        />
      ) : (
        <span className="terminal-tab-title" title="Double-click to rename" onDoubleClick={() => { setDraftTitle(title); setIsEditing(true) }}>
          {title}
        </span>
      )}
      {paneId ? (
        <div className="terminal-tab-actions" onMouseDown={activatePaneAndStop} onPointerDown={activatePaneAndStop}>
          <button type="button" title="Split right" onClick={(event) => { activatePaneAndStop(event); void actions.splitPane(paneId, 'right') }}>
            <SplitSquareVertical size={12} />
          </button>
          <button type="button" title="Split down" onClick={(event) => { activatePaneAndStop(event); void actions.splitPane(paneId, 'below') }}>
            <SplitSquareHorizontal size={12} />
          </button>
          <button type="button" title="New tab" onClick={(event) => { activatePaneAndStop(event); void actions.newTab(paneId) }}>
            <PanelRightClose size={12} />
          </button>
          <button type="button" title="Maximize" onClick={onMaximize}>
            <Maximize2 size={12} />
          </button>
          <button type="button" title="Close pane" onClick={(event) => { activatePaneAndStop(event); api.close() }}>
            <X size={12} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

import { useEffect, useState } from 'react'
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

  useEffect(() => {
    const disposable = api.onDidTitleChange((event) => setTitle(event.title))
    return () => disposable.dispose()
  }, [api])

  const stopChromeEvent = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    event.preventDefault()
    event.stopPropagation()
  }

  const onMaximize = (event: { preventDefault: () => void; stopPropagation: () => void }) => {
    stopChromeEvent(event)
    if (api.isMaximized()) api.exitMaximized()
    else api.maximize()
  }

  return (
    <div className="terminal-tab" title={title}>
      <span className="terminal-tab-title">{title}</span>
      {paneId ? (
        <div className="terminal-tab-actions" onMouseDown={stopChromeEvent} onPointerDown={stopChromeEvent}>
          <button type="button" title="Split right" onClick={(event) => { stopChromeEvent(event); void actions.splitPane(paneId, 'right') }}>
            <SplitSquareVertical size={12} />
          </button>
          <button type="button" title="Split down" onClick={(event) => { stopChromeEvent(event); void actions.splitPane(paneId, 'below') }}>
            <SplitSquareHorizontal size={12} />
          </button>
          <button type="button" title="New tab" onClick={(event) => { stopChromeEvent(event); void actions.newTab(paneId) }}>
            <PanelRightClose size={12} />
          </button>
          <button type="button" title="Maximize" onClick={onMaximize}>
            <Maximize2 size={12} />
          </button>
          <button type="button" title="Close pane" onClick={(event) => { stopChromeEvent(event); api.close() }}>
            <X size={12} />
          </button>
        </div>
      ) : null}
    </div>
  )
}

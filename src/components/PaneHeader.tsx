import { Maximize2, PanelRightClose, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react'
import { useWorkspaceActions } from '../layout/actions'

type PaneHeaderProps = {
  paneId: string
  title?: string | null
}

export function PaneHeader({ paneId, title }: PaneHeaderProps) {
  const actions = useWorkspaceActions()

  const activatePane = () => actions.activatePane(paneId)

  return (
    <div className="pane-header" onMouseDown={activatePane} onPointerDown={activatePane}>
      <span className="pane-title">{title ?? 'Shell'}</span>
      <div className="pane-actions">
        <button type="button" title="Split right" onClick={() => { activatePane(); void actions.splitPane(paneId, 'right') }}>
          <SplitSquareVertical size={14} />
        </button>
        <button type="button" title="Split down" onClick={() => { activatePane(); void actions.splitPane(paneId, 'below') }}>
          <SplitSquareHorizontal size={14} />
        </button>
        <button type="button" title="New tab" onClick={() => { activatePane(); void actions.newTab(paneId) }}>
          <PanelRightClose size={14} />
        </button>
        <button type="button" title="Maximize" onClick={() => { activatePane(); actions.toggleMaximize(paneId) }}>
          <Maximize2 size={14} />
        </button>
        <button type="button" title="Close pane" onClick={() => { activatePane(); void actions.closePane(paneId) }}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

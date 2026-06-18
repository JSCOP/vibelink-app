import { Maximize2, PanelRightClose, SplitSquareHorizontal, SplitSquareVertical, X } from 'lucide-react'
import { useWorkspaceActions } from '../layout/actions'

type PaneHeaderProps = {
  paneId: string
  title?: string | null
}

export function PaneHeader({ paneId, title }: PaneHeaderProps) {
  const actions = useWorkspaceActions()

  return (
    <div className="pane-header">
      <span className="pane-title">{title ?? 'Shell'}</span>
      <div className="pane-actions">
        <button type="button" title="Split right" onClick={() => void actions.splitPane(paneId, 'right')}>
          <SplitSquareVertical size={14} />
        </button>
        <button type="button" title="Split down" onClick={() => void actions.splitPane(paneId, 'below')}>
          <SplitSquareHorizontal size={14} />
        </button>
        <button type="button" title="New tab" onClick={() => void actions.newTab(paneId)}>
          <PanelRightClose size={14} />
        </button>
        <button type="button" title="Maximize" onClick={() => actions.toggleMaximize(paneId)}>
          <Maximize2 size={14} />
        </button>
        <button type="button" title="Close pane" onClick={() => void actions.closePane(paneId)}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

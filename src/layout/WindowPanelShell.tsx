import { useState, type DragEvent, type ReactNode } from 'react'
import { useWorkspaceWindowActions } from './windowActions'
import { hasWorkspaceWindowDragPayload, workspaceWindowDragMime, workspaceWindowDropPositionFromPoint, type WindowDropPosition } from './windowDrag'

type WindowPanelShellProps = {
  panelId: string
  className?: string
  children: ReactNode
}

export function WindowPanelShell({ panelId, className, children }: WindowPanelShellProps) {
  const actions = useWorkspaceWindowActions()
  const [dropPosition, setDropPosition] = useState<WindowDropPosition | null>(null)

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasWorkspaceWindowDragPayload(event.dataTransfer.types)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropPosition(workspaceWindowDropPositionFromPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY))
  }

  const onDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropPosition(null)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasWorkspaceWindowDragPayload(event.dataTransfer.types)) return
    event.preventDefault()
    event.stopPropagation()
    const position = workspaceWindowDropPositionFromPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)
    setDropPosition(null)
    const sourcePanelId = event.dataTransfer.getData(workspaceWindowDragMime)
    if (!sourcePanelId || sourcePanelId === panelId) return
    if (position === 'center') void actions.swapWindowLocations(sourcePanelId, panelId)
    else void actions.moveWindowToPosition(sourcePanelId, panelId, position)
  }

  return (
    <div
      className={`workspace-window-panel${className ? ` ${className}` : ''}`}
      data-window-panel-id={panelId}
      data-drop-position={dropPosition ?? undefined}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {children}
    </div>
  )
}

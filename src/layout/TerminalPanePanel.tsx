import { useCallback, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'
import { useWorkspaceActions } from './actions'
import { hasPaneDragPayload, paneDragMime, paneDropPositionFromPoint, type PaneDropPosition } from './paneDrag'

type TerminalPanelParams = {
  paneId: string
  title?: string | null
}

export function TerminalPanePanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const paneId = props.params.paneId
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const applyTerminalTitle = useWorkspaceStore((state) => state.applyTerminalTitle)
  const actions = useWorkspaceActions()
  const [dropPosition, setDropPosition] = useState<PaneDropPosition | null>(null)
  const onTitleChange = useCallback((title: string) => {
    void applyTerminalTitle(paneId, title)
  }, [applyTerminalTitle, paneId])
  const onPaneDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasPaneDragPayload(event.dataTransfer.types)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    setDropPosition(paneDropPositionFromPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY))
  }

  const onPaneDragLeave = (event: DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    setDropPosition(null)
  }

  const onPaneDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!hasPaneDragPayload(event.dataTransfer.types)) return
    event.preventDefault()
    event.stopPropagation()
    const position = paneDropPositionFromPoint(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)
    setDropPosition(null)
    const sourcePaneId = event.dataTransfer.getData(paneDragMime)
    if (!sourcePaneId || sourcePaneId === paneId) return
    if (position === 'center') void actions.swapPaneLocations(sourcePaneId, paneId)
    else void actions.movePaneToPosition(sourcePaneId, paneId, position)
  }


  useLayoutEffect(() => {
    if (hostRef.current && activeSessionId) {
      TerminalManager.attach(paneId, hostRef.current, { sessionId: activeSessionId, onTitleChange })
    }
  }, [activeSessionId, onTitleChange, paneId])

  return (
    <div className="terminal-panel-shell" data-pane-id={paneId} data-drop-position={dropPosition ?? undefined} onDragOver={onPaneDragOver} onDragLeave={onPaneDragLeave} onDrop={onPaneDrop}>
      <div ref={hostRef} className="dock-terminal-host" />
    </div>
  )
}

export function PlaceholderPanel() {
  return <div className="placeholder-panel">Select or create a workspace.</div>
}

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'
import { useWorkspaceActions } from './actions'
import { hasPaneDragPayload, paneDragMime, paneDropPositionFromPoint, type PaneDropPosition } from './paneDrag'

type TerminalPanelParams = {
  paneId: string
  title?: string | null
}

export const TerminalPanePanel = memo(function TerminalPanePanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const paneId = props.params?.paneId
  const panelApi = props.api
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const applyTerminalTitle = useWorkspaceStore((state) => state.applyTerminalTitle)
  const completionHighlight = useWorkspaceStore((state) => paneId ? state.paneCompletionHighlights[paneId] : undefined)
  const actions = useWorkspaceActions()
  const [dropPosition, setDropPosition] = useState<PaneDropPosition | null>(null)
  const onTitleChange = useCallback((title: string) => {
    if (!paneId) return
    void applyTerminalTitle(paneId, title)
  }, [applyTerminalTitle, paneId])
  const onPaneDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!paneId) return
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
    if (!paneId) return
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

  useEffect(() => {
    if (!paneId) return
    const visibilityDisposable = panelApi.onDidVisibilityChange(({ isVisible }) => {
      if (isVisible) TerminalManager.notifyPaneVisible(paneId)
    })
    const dimensionsDisposable = panelApi.onDidDimensionsChange(() => {
      if (panelApi.isVisible) TerminalManager.reflow(paneId)
    })
    return () => {
      visibilityDisposable.dispose()
      dimensionsDisposable.dispose()
    }
  }, [panelApi, paneId])


  useLayoutEffect(() => {
    if (!paneId || !hostRef.current || !activeSessionId) return
    const host = hostRef.current
    let secondFrame: number | undefined
    TerminalManager.attach(paneId, host, { sessionId: activeSessionId, onTitleChange })
    const firstFrame = requestAnimationFrame(() => {
      TerminalManager.reflow(paneId)
      secondFrame = requestAnimationFrame(() => {
        TerminalManager.reflow(paneId)
        TerminalManager.syncPtySize(paneId)
      })
    })
    const timeout = window.setTimeout(() => {
      TerminalManager.reflow(paneId)
      TerminalManager.syncPtySize(paneId)
    }, 250)
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
      window.clearTimeout(timeout)
      if (host.parentElement) TerminalManager.reflow(paneId)
    }
  }, [activeSessionId, onTitleChange, paneId])

  if (!paneId) {
    return <div className="placeholder-panel">Terminal pane metadata is missing. Reset this layout page and open the terminal grid again.</div>
  }

  return (
    <div className="terminal-panel-shell" data-pane-id={paneId} data-drop-position={dropPosition ?? undefined} data-pane-response-complete={completionHighlight ? 'true' : undefined} onDragOver={onPaneDragOver} onDragLeave={onPaneDragLeave} onDrop={onPaneDrop}>
      <div ref={hostRef} className="dock-terminal-host" />
    </div>
  )
})

export function PlaceholderPanel() {
  return <div className="placeholder-panel">Select or create a workspace.</div>
}

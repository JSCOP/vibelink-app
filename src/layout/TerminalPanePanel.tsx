import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { ClipboardCopy, ClipboardPaste, Copy, TextSelect } from 'lucide-react'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'
import { useWorkspaceActions } from './actions'
import { hasPaneDragPayload, paneDragMime, paneDropPositionFromPoint, type PaneDropPosition } from './paneDrag'

type TerminalPanelParams = {
  paneId: string
  title?: string | null
}

type ContextMenuState = {
  x: number
  y: number
  hasSelection: boolean
}

const CONTEXT_MENU_WIDTH = 200
const CONTEXT_MENU_HEIGHT = 138

export const TerminalPanePanel = memo(function TerminalPanePanel(props: IDockviewPanelProps<TerminalPanelParams>) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const paneId = props.params?.paneId
  const panelApi = props.api
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const activePaneId = useWorkspaceStore((state) => state.activePaneId)
  // Panels can be created before their pane process exists (panel-first spawn
  // measures the host to size the PTY). Until the pane is in the store there
  // is nothing to attach to on the daemon side.
  const paneExists = useWorkspaceStore((state) => Boolean(paneId && state.panes[paneId]))
  const applyTerminalTitle = useWorkspaceStore((state) => state.applyTerminalTitle)
  const completionHighlight = useWorkspaceStore((state) => paneId ? state.paneCompletionHighlights[paneId] : undefined)
  const actions = useWorkspaceActions()
  const [dropPosition, setDropPosition] = useState<PaneDropPosition | null>(null)
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
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

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!paneId) return
    event.preventDefault()
    event.stopPropagation()
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT),
      hasSelection: TerminalManager.hasSelection(paneId),
    })
  }

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const copySelection = () => {
    if (paneId) TerminalManager.copySelectionToClipboard(paneId)
    closeContextMenu()
  }

  const pasteClipboard = () => {
    closeContextMenu()
    if (!paneId) return
    void navigator.clipboard?.readText?.()
      .then((text) => {
        TerminalManager.paste(paneId, text)
        TerminalManager.focus(paneId)
      })
      .catch(() => undefined)
  }

  const selectAll = () => {
    if (paneId) TerminalManager.selectAll(paneId)
    closeContextMenu()
  }

  const copyAll = () => {
    if (paneId) TerminalManager.copyContentsToClipboard(paneId)
    closeContextMenu()
  }

  useEffect(() => {
    if (!contextMenu) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeContextMenu, contextMenu])

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
    TerminalManager.attach(paneId, host, { sessionId: paneExists ? activeSessionId : undefined, onTitleChange })
    const firstFrame = requestAnimationFrame(() => {
      TerminalManager.reflow(paneId)
      secondFrame = requestAnimationFrame(() => {
        TerminalManager.reflow(paneId)
        if (paneExists) TerminalManager.syncPtySize(paneId)
      })
    })
    const timeout = window.setTimeout(() => {
      TerminalManager.reflow(paneId)
      if (paneExists) TerminalManager.syncPtySize(paneId)
    }, 250)
    return () => {
      cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
      window.clearTimeout(timeout)
      if (host.parentElement) TerminalManager.reflow(paneId)
    }
  }, [activeSessionId, onTitleChange, paneExists, paneId])

  if (!paneId) {
    return <div className="placeholder-panel">Terminal pane metadata is missing. Reset this layout page and open the terminal grid again.</div>
  }

  return (
    <div className="terminal-panel-shell" data-pane-id={paneId} data-active={activePaneId === paneId ? 'true' : undefined} data-drop-position={dropPosition ?? undefined} data-pane-response-complete={completionHighlight ? 'true' : undefined} onDragOver={onPaneDragOver} onDragLeave={onPaneDragLeave} onDrop={onPaneDrop} onContextMenu={onContextMenu}>
      <div ref={hostRef} className="dock-terminal-host" />
      {contextMenu ? (
        <>
          <div className="terminal-context-backdrop" onMouseDown={closeContextMenu} onContextMenu={(event) => { event.preventDefault(); closeContextMenu() }} />
          <div className="terminal-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button type="button" role="menuitem" disabled={!contextMenu.hasSelection} onClick={copySelection}>
              <Copy size={13} /> Copy
            </button>
            <button type="button" role="menuitem" onClick={pasteClipboard}>
              <ClipboardPaste size={13} /> Paste
            </button>
            <button type="button" role="menuitem" onClick={selectAll}>
              <TextSelect size={13} /> Select all
            </button>
            <button type="button" role="menuitem" onClick={copyAll}>
              <ClipboardCopy size={13} /> Copy all output
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
})

export function PlaceholderPanel() {
  return <div className="placeholder-panel">Select or create a workspace.</div>
}

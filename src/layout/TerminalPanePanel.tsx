import { invoke } from '@tauri-apps/api/core'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { ClipboardCopy, ClipboardPaste, Copy, FolderOpen, LayoutGrid, Play, Plus, Sparkles, SplitSquareHorizontal, SplitSquareVertical, TextSelect, X } from 'lucide-react'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'
import { pathFromTerminalSelection } from '../terminal/selectionPath'
import { useWorkspaceContentActions } from './contentActions'
import { getHermesRuntimeStatus } from '../ipc/hermes'
import type { WorkspaceContentParams } from './workspaceContentModel'

type TerminalPanelParams = Extract<WorkspaceContentParams, { kind: 'terminal' }>

type ContextMenuState = {
  x: number
  y: number
  hasSelection: boolean
  selectedPath: string | null
}

const CONTEXT_MENU_WIDTH = 232
const CONTEXT_MENU_HEIGHT = 416

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
  const reviewed = useWorkspaceStore((state) => paneId ? Boolean(state.paneReviewMarkers[paneId]) : false)
  const setError = useWorkspaceStore((state) => state.setError)
  const hermesCommand = useWorkspaceStore((state) => state.settings?.hermesCommand ?? '')
  const sendAgentPrompt = useWorkspaceStore((state) => state.sendAgentPrompt)
  const paneTitle = useWorkspaceStore((state) => paneId ? state.panes[paneId]?.config.title : undefined)
  const actions = useWorkspaceContentActions()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [hermesDetected, setHermesDetected] = useState(false)
  const onTitleChange = useCallback((title: string) => {
    if (!paneId) return
    void applyTerminalTitle(paneId, title)
  }, [applyTerminalTitle, paneId])
  useEffect(() => {
    let cancelled = false
    void getHermesRuntimeStatus(hermesCommand)
      .then((runtime) => { if (!cancelled) setHermesDetected(runtime.detected) })
      .catch(() => { if (!cancelled) setHermesDetected(false) })
    return () => { cancelled = true }
  }, [hermesCommand])

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!paneId) return
    event.preventDefault()
    event.stopPropagation()
    const selection = TerminalManager.getSelection(paneId)
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT),
      hasSelection: selection.length > 0,
      selectedPath: pathFromTerminalSelection(selection),
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

  const runSelectedPathAction = (command: 'open_path' | 'reveal_path', errorMessage: string) => {
    const path = contextMenu?.selectedPath
    closeContextMenu()
    if (!path) return
    void invoke(command, { path }).catch((error) => setError(`${errorMessage}: ${String(error)}`))
  }

  const askVibeLinkAgent = async () => {
    closeContextMenu()
    if (!paneId || !activeSessionId || !hermesDetected) return
    const selection = TerminalManager.getSelection(paneId)
    const captured = limitUtf8Tail(selection.trim() ? selection : TerminalManager.getRecentOutput(paneId, 120), 8 * 1024)
    const title = paneTitle?.trim() || props.params?.title?.trim() || paneId
    const prompt = `From VibeLink pane "${title}":\n\`\`\`\n${captured}\n\`\`\`\nExplain what happened and propose the next command or fix.`
    await actions.openContent({ kind: 'agent' })
    await sendAgentPrompt(activeSessionId, prompt)
  }

  const openTerminalInGroup = () => {
    const targetGroupId = props.containerApi.getPanel(props.api.id)?.group.id
    closeContextMenu()
    void actions.openContent({ kind: 'terminal', targetGroupId })
  }

  const splitTerminal = (direction: 'right' | 'below') => {
    closeContextMenu()
    if (paneId) void actions.splitTerminal(paneId, direction)
  }

  const arrangeTerminals = () => {
    closeContextMenu()
    void actions.arrangeTerminals()
  }

  const closeTerminal = () => {
    closeContextMenu()
    void actions.requestCloseContent(props.api.id)
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
    <div className="terminal-panel-shell" data-pane-id={paneId} data-content-panel-id={props.api.id} data-active={activePaneId === paneId ? 'true' : undefined} data-pane-reviewed={reviewed ? 'true' : undefined} data-pane-response-complete={completionHighlight ? 'true' : undefined} onContextMenu={onContextMenu}>
      <div ref={hostRef} className="dock-terminal-host" />
      {contextMenu ? (
        <>
          <div className="terminal-context-backdrop" onMouseDown={closeContextMenu} onContextMenu={(event) => { event.preventDefault(); closeContextMenu() }} />
          <div className="terminal-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            <button type="button" role="menuitem" disabled={!contextMenu.hasSelection} onClick={copySelection}>
              <Copy size={13} /> Copy
            </button>
            {contextMenu.selectedPath ? (
              <>
                <button type="button" role="menuitem" onClick={() => runSelectedPathAction('reveal_path', 'Could not show the selected path')}>
                  <FolderOpen size={13} /> Show in File Explorer
                </button>
                <button type="button" role="menuitem" onClick={() => runSelectedPathAction('open_path', 'Could not open the selected path')}>
                  <Play size={13} /> Open / run selected path
                </button>
              </>
            ) : null}
            <button type="button" role="menuitem" disabled={!hermesDetected} title={hermesDetected ? 'Ask VibeLink Agent about this pane' : 'Install Hermes Agent to use this'} onClick={() => void askVibeLinkAgent()}>
              <Sparkles size={13} /> Ask VibeLink Agent
            </button>
            <div className="terminal-context-separator" role="separator" />
            <button type="button" role="menuitem" onClick={openTerminalInGroup}>
              <Plus size={13} /> New terminal in this group
            </button>
            <button type="button" role="menuitem" onClick={() => splitTerminal('right')}>
              <SplitSquareVertical size={13} /> Split terminal right
            </button>
            <button type="button" role="menuitem" onClick={() => splitTerminal('below')}>
              <SplitSquareHorizontal size={13} /> Split terminal below
            </button>
            <button type="button" role="menuitem" onClick={arrangeTerminals}>
              <LayoutGrid size={13} /> Arrange Terminals
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
            <div className="terminal-context-separator" role="separator" />
            <button type="button" role="menuitem" onClick={closeTerminal}>
              <X size={13} /> Close terminal
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
})

function limitUtf8Tail(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  return new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes)).replace(/^\uFFFD/, '')
}

export function PlaceholderPanel() {
  return <div className="placeholder-panel">Select or create a workspace.</div>
}

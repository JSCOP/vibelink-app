import { invoke } from '@tauri-apps/api/core'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ClipboardCopy, ClipboardPaste, Copy, FolderOpen, LayoutGrid, Play, Plus, Sparkles, SplitSquareHorizontal, SplitSquareVertical, SquareTerminal, TextSelect, X } from 'lucide-react'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'
import { TerminalSearchBar } from '../components/TerminalSearchBar'
import { terminalSearchForgetPane } from '../terminal/search'
import { pathFromTerminalSelection } from '../terminal/selectionPath'
import { terminalImageDropText } from '../terminal/imageDrop'
import { useWorkspaceContentActions } from './contentActions'
import { getHermesRuntimeStatus } from '../ipc/hermes'
import { readClipboardText } from '../ipc/clipboard'
import { parseWorkspaceContentParams, type WorkspaceContentParams } from './workspaceContentModel'
import { reclaimAllRemotePaneLeases, reclaimRemotePaneLease, useRemotePaneLeaseStore } from '../remote/paneLease'
import { findTerminalWindowForPane } from './terminalWindowRegistry'
import { toast } from '../components/toast/toastStore'
import { agentSessionDropPaneId, subscribeAgentSessionDropPane } from '../components/agent/agentSessionDrag'
import { formatKeyChord } from '../state/keybindings'
import { getContentRect } from './workspaceDockGeometry'
import { nearestPaneIdInDirection, swapPanelsInDockviewApi, type PaneDirection } from './paneSwap'

type TerminalPanelParams = Extract<WorkspaceContentParams, { kind: 'terminal' }>

type ContextMenuState = {
  x: number
  y: number
  hasSelection: boolean
  selectedPath: string | null
  directionalTargets: Record<PaneDirection, string | null>
}

const CONTEXT_MENU_WIDTH = 232
const CONTEXT_MENU_HEIGHT = 656
const CONTEXT_MENU_SHORTCUT_STYLE = { color: 'var(--vibelink-muted)', marginLeft: 'auto' } as const

type DeferredTerminalMount = { cancelled: boolean; mount: () => void }

// One mount per frame was N frames of dead time for an N-pane workspace: at 12
// panes the last terminal only started attaching ~200 ms after the switch. The
// point was never one-per-frame, it was "do not open every xterm in the same
// frame" — so spend a frame budget instead and let a slow mount end the batch.
const TERMINAL_MOUNT_FRAME_BUDGET_MS = 8

const deferredTerminalMounts: DeferredTerminalMount[] = []
let deferredTerminalMountFrame: number | undefined

function flushDeferredTerminalMount(): void {
  deferredTerminalMountFrame = undefined
  const deadline = performance.now() + TERMINAL_MOUNT_FRAME_BUDGET_MS
  for (;;) {
    let next = deferredTerminalMounts.shift()
    while (next?.cancelled) next = deferredTerminalMounts.shift()
    if (!next) break
    next.mount()
    if (performance.now() >= deadline) break
  }
  if (deferredTerminalMounts.length > 0) deferredTerminalMountFrame = requestAnimationFrame(flushDeferredTerminalMount)
}

function scheduleTerminalMount(mount: () => void): () => void {
  const task: DeferredTerminalMount = { cancelled: false, mount }
  if (deferredTerminalMountFrame === undefined && deferredTerminalMounts.length === 0) {
    mount()
    deferredTerminalMountFrame = requestAnimationFrame(flushDeferredTerminalMount)
  } else {
    deferredTerminalMounts.push(task)
  }
  return () => { task.cancelled = true }
}

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
  const hermesCommand = useWorkspaceStore((state) => state.settings?.hermesCommand ?? '')
  const keybindings = useWorkspaceStore((state) => state.settings.keybindings)
  const sendAgentPrompt = useWorkspaceStore((state) => state.sendAgentPrompt)
  const paneTitle = useWorkspaceStore((state) => paneId ? state.panes[paneId]?.config.title : undefined)
  const remoteLease = useRemotePaneLeaseStore((state) => paneId ? state.leases[paneId] : undefined)
  const actions = useWorkspaceContentActions()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const agentSessionDropActive = useSyncExternalStore(subscribeAgentSessionDropPane, agentSessionDropPaneId, agentSessionDropPaneId) === paneId
  const [nativeImageDropActive, setNativeImageDropActive] = useState(false)
  const nativeImageDragValidRef = useRef(false)
  const [hermesDetected, setHermesDetected] = useState(false)
  const [reclaimingLease, setReclaimingLease] = useState(false)
  const [reclaimError, setReclaimError] = useState<string | null>(null)
  const [collapsedLeaseKey, setCollapsedLeaseKey] = useState<string | null>(null)
  const leaseKey = remoteLease ? `${remoteLease.paneId}:${remoteLease.deviceId}` : ''
  // A new lease key derives an expanded cover without an effect-driven render.
  const leaseCoverCollapsed = leaseKey !== '' && collapsedLeaseKey === leaseKey
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

  useEffect(() => {
    if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return
    let disposed = false
    let unlisten: (() => void) | undefined
    void getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === 'leave') {
        nativeImageDragValidRef.current = false
        setNativeImageDropActive(false)
        return
      }
      const logical = payload.position.toLogical(window.devicePixelRatio || 1)
      const targetPaneId = document
        .elementFromPoint(logical.x, logical.y)
        ?.closest<HTMLElement>('[data-terminal-pane-id]')
        ?.dataset.terminalPaneId
      if (payload.type === 'enter') nativeImageDragValidRef.current = terminalImageDropText(payload.paths) !== null
      const matches = targetPaneId === paneId && nativeImageDragValidRef.current && !remoteLease
      setNativeImageDropActive(matches)
      if (payload.type !== 'drop') return
      nativeImageDragValidRef.current = false
      setNativeImageDropActive(false)
      const text = terminalImageDropText(payload.paths)
      if (!matches || !paneId || !text) return
      panelApi.setActive()
      TerminalManager.paste(paneId, text)
      TerminalManager.focus(paneId)
    }).then((dispose) => {
      if (disposed) dispose()
      else unlisten = dispose
    }).catch((error) => console.warn('Could not register terminal image drop listener', error))
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [paneId, panelApi, remoteLease])

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!paneId) return
    event.preventDefault()
    event.stopPropagation()
    if (remoteLease) return
    const selection = TerminalManager.getSelection(paneId)
    const innerApi = findTerminalWindowForPane(paneId)?.getInnerApi()
    const panelIds = innerApi?.panels.map((panel) => panel.id) ?? []
    const directionalTargets: Record<PaneDirection, string | null> = {
      left: nearestPaneIdInDirection(props.api.id, panelIds, 'left', getContentRect),
      right: nearestPaneIdInDirection(props.api.id, panelIds, 'right', getContentRect),
      up: nearestPaneIdInDirection(props.api.id, panelIds, 'up', getContentRect),
      down: nearestPaneIdInDirection(props.api.id, panelIds, 'down', getContentRect),
    }
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT - 8)),
      hasSelection: selection.length > 0,
      selectedPath: pathFromTerminalSelection(selection),
      directionalTargets,
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
    void readClipboardText()
      .then((text) => {
        if (!text) return
        TerminalManager.paste(paneId, text)
        TerminalManager.focus(paneId)
      })
      .catch((error) => toast.error(`Could not paste from the clipboard: ${String(error)}`))
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
    void invoke(command, { path }).catch((error) => toast.error(`${errorMessage}: ${String(error)}`))
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

  // Arrange only the window that owns this pane; the always-visible pane-tab
  // button was removed, so this menu item is the on-demand entry point.
  const arrangeTerminals = () => {
    closeContextMenu()
    if (paneId) void actions.arrangeTerminals(null, findTerminalWindowForPane(paneId)?.windowId)
  }

  const focusTerminal = (direction: PaneDirection) => {
    const targetPanelId = contextMenu?.directionalTargets[direction]
    closeContextMenu()
    if (!paneId || !targetPanelId) return
    const targetPanel = findTerminalWindowForPane(paneId)?.getInnerApi()?.getPanel(targetPanelId)
    if (!targetPanel) return
    targetPanel.api.setActive()
    const targetContent = parseWorkspaceContentParams(targetPanel.params)
    if (targetContent?.kind === 'terminal') TerminalManager.focus(targetContent.paneId)
  }

  const moveTerminal = async (direction: PaneDirection) => {
    const targetPanelId = contextMenu?.directionalTargets[direction]
    closeContextMenu()
    if (!paneId || !targetPanelId) return
    const terminalWindow = findTerminalWindowForPane(paneId)
    if (!terminalWindow) return
    const innerApi = terminalWindow.getInnerApi()
    if (!innerApi || !swapPanelsInDockviewApi(innerApi, props.api.id, targetPanelId)) return
    innerApi.getPanel(props.api.id)?.api.setActive()
    TerminalManager.focus(paneId)
    await terminalWindow.settle()
    terminalWindow.persist()
  }

  const closeTerminal = () => {
    closeContextMenu()
    void actions.requestCloseContent(props.api.id)
  }

  const takeBackControl = async () => {
    if (!paneId || !remoteLease || reclaimingLease) return
    setReclaimingLease(true)
    setReclaimError(null)
    try {
      await reclaimRemotePaneLease(remoteLease.sessionId, paneId)
      TerminalManager.setRemotePaneLease(paneId, null)
      TerminalManager.focus(paneId)
    } catch (error) {
      setReclaimError(String(error))
    } finally {
      setReclaimingLease(false)
    }
  }

  const takeBackAllControl = async () => {
    if (reclaimingLease) return
    setReclaimingLease(true)
    setReclaimError(null)
    const leasedPaneIds = Object.keys(useRemotePaneLeaseStore.getState().leases)
    try {
      const result = await reclaimAllRemotePaneLeases()
      for (const leasedPaneId of leasedPaneIds) TerminalManager.setRemotePaneLease(leasedPaneId, null)
      if (paneId) TerminalManager.focus(paneId)
      if (result.failures.length > 0) setReclaimError(result.failures[0] ?? 'unknown error')
    } catch (error) {
      setReclaimError(String(error))
    } finally {
      setReclaimingLease(false)
    }
  }

  useEffect(() => {
    if (!contextMenu) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeContextMenu()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeContextMenu, contextMenu])

  useEffect(() => () => {
    if (paneId) terminalSearchForgetPane(paneId)
  }, [paneId])

  useEffect(() => {
    if (!paneId) return
    TerminalManager.setPaneVisible(paneId, panelApi.isVisible)
    const visibilityDisposable = panelApi.onDidVisibilityChange(({ isVisible }) => {
      TerminalManager.setPaneVisible(paneId, isVisible)
    })
    return () => {
      TerminalManager.setPaneVisible(paneId, false)
      visibilityDisposable.dispose()
    }
  }, [panelApi, paneId])


  useLayoutEffect(() => {
    if (!paneId || !hostRef.current || !activeSessionId) return
    const host = hostRef.current
    let mounted = false
    let firstFrame: number | undefined
    let secondFrame: number | undefined
    let timeout: number | undefined
    const cancelMount = scheduleTerminalMount(() => {
      mounted = true
      TerminalManager.attach(paneId, host, { sessionId: paneExists ? activeSessionId : undefined, onTitleChange })
      TerminalManager.setPaneVisible(paneId, panelApi.isVisible)
      firstFrame = requestAnimationFrame(() => {
        TerminalManager.reflow(paneId)
        secondFrame = requestAnimationFrame(() => {
          TerminalManager.reflow(paneId)
          if (paneExists) TerminalManager.syncPtySize(paneId)
        })
      })
      timeout = window.setTimeout(() => {
        TerminalManager.reflow(paneId)
        if (paneExists) TerminalManager.syncPtySize(paneId)
      }, 250)
    })
    return () => {
      cancelMount()
      if (firstFrame !== undefined) cancelAnimationFrame(firstFrame)
      if (secondFrame !== undefined) cancelAnimationFrame(secondFrame)
      if (timeout !== undefined) window.clearTimeout(timeout)
      if (mounted && host.parentElement) TerminalManager.reflow(paneId)
    }
  }, [activeSessionId, onTitleChange, paneExists, paneId, panelApi])

  if (!paneId) {
    return <div className="placeholder-panel">Terminal pane metadata is missing. Reset this layout page and open the terminal grid again.</div>
  }

  return (
    <div className="terminal-panel-shell" data-pane-id={paneId} data-terminal-pane-id={paneId} data-content-panel-id={props.api.id} data-active={activePaneId === paneId ? 'true' : undefined} data-pane-reviewed={reviewed ? 'true' : undefined} data-pane-response-complete={completionHighlight ? 'true' : undefined} data-agent-session-drop-target={agentSessionDropActive ? 'true' : undefined} onContextMenu={onContextMenu}>
      <div ref={hostRef} className="dock-terminal-host" />
      <TerminalSearchBar paneId={paneId} />
      {nativeImageDropActive ? <div className="agent-session-terminal-drop"><FolderOpen size={24} aria-hidden="true" /><strong>Paste image path</strong><span>Drop to insert this desktop image into the terminal.</span></div> : null}
      {agentSessionDropActive ? <div className="agent-session-terminal-drop"><SquareTerminal size={24} aria-hidden="true" /><strong>Resume in this terminal</strong><span>The current process in this pane will stop.</span></div> : null}
      {remoteLease ? (
        <div
          className="remote-pane-lease-cover"
          data-collapsed={leaseCoverCollapsed ? 'true' : undefined}
          aria-label="Remote terminal control"
          onContextMenu={(event) => { event.preventDefault(); event.stopPropagation() }}
        >
          {leaseCoverCollapsed ? (
            <button type="button" className="remote-pane-lease-badge" onClick={() => setCollapsedLeaseKey(null)}>
              <span aria-hidden="true" /> On phone · {remoteLease.cols} × {remoteLease.rows}
            </button>
          ) : (
            <div className="remote-pane-lease-card">
              <span className="remote-pane-lease-state"><span aria-hidden="true" /> On phone</span>
              <strong>Your phone is controlling this terminal</strong>
              <span className="remote-pane-lease-body">
                The desktop keyboard is paused. Take this terminal back to type here, or take back every
                terminal your phone is holding. Collapse to keep watching the output.
              </span>
              <span className="remote-pane-lease-geometry">
                {shortRemoteDeviceId(remoteLease.deviceId)} · phone size {remoteLease.cols} × {remoteLease.rows}
              </span>
              <div className="remote-pane-lease-actions">
                <button type="button" className="remote-pane-lease-secondary" onClick={() => setCollapsedLeaseKey(leaseKey)}>
                  Collapse
                </button>
                <button
                  type="button"
                  className="remote-pane-lease-secondary"
                  disabled={reclaimingLease}
                  onClick={() => void takeBackAllControl()}
                >
                  Take back all terminals
                </button>
                <button type="button" disabled={reclaimingLease} onClick={() => void takeBackControl()}>
                  {reclaimingLease ? 'Taking back…' : 'Take back this terminal'}
                </button>
              </div>
              {reclaimError ? <span className="remote-pane-lease-error" role="alert">Could not take back control: {reclaimError}</span> : null}
            </div>
          )}
        </div>
      ) : null}
      {!remoteLease && contextMenu ? (
        <>
          <div className="terminal-context-backdrop" onMouseDown={closeContextMenu} onContextMenu={(event) => { event.preventDefault(); closeContextMenu() }} />
          <div className="terminal-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y, maxHeight: 'calc(100vh - 16px)', overflowY: 'auto' }}>
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
            {contextMenu.selectedPath ? (
              <>
                <div className="terminal-context-separator" role="separator" />
                <button type="button" role="menuitem" onClick={() => runSelectedPathAction('reveal_path', 'Could not show the selected path')}>
                  <FolderOpen size={13} /> Show in File Explorer
                </button>
                <button type="button" role="menuitem" onClick={() => runSelectedPathAction('open_path', 'Could not open the selected path')}>
                  <Play size={13} /> Open / run selected path
                </button>
              </>
            ) : null}
            <div className="terminal-context-separator" role="separator" />
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
            <div className="terminal-context-separator" role="separator" />
            <button type="button" role="menuitem" disabled={!contextMenu.directionalTargets.left} onClick={() => focusTerminal('left')}>
              <ArrowLeft size={13} /> Focus Left <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.focusLeft)}</span>
            </button>
            <button type="button" role="menuitem" disabled={!contextMenu.directionalTargets.right} onClick={() => focusTerminal('right')}>
              <ArrowRight size={13} /> Focus Right <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.focusRight)}</span>
            </button>
            <button type="button" role="menuitem" disabled={!contextMenu.directionalTargets.up} onClick={() => focusTerminal('up')}>
              <ArrowUp size={13} /> Focus Up <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.focusUp)}</span>
            </button>
            <button type="button" role="menuitem" disabled={!contextMenu.directionalTargets.down} onClick={() => focusTerminal('down')}>
              <ArrowDown size={13} /> Focus Down <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.focusDown)}</span>
            </button>
            <button type="button" role="menuitem" disabled={!contextMenu.directionalTargets.left} onClick={() => void moveTerminal('left')}>
              <ArrowLeft size={13} /> Move Left <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.moveLeft)}</span>
            </button>
            <button type="button" role="menuitem" disabled={!contextMenu.directionalTargets.right} onClick={() => void moveTerminal('right')}>
              <ArrowRight size={13} /> Move Right <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.moveRight)}</span>
            </button>
            <button type="button" role="menuitem" disabled={!contextMenu.directionalTargets.up} onClick={() => void moveTerminal('up')}>
              <ArrowUp size={13} /> Move Up <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.moveUp)}</span>
            </button>
            <button type="button" role="menuitem" disabled={!contextMenu.directionalTargets.down} onClick={() => void moveTerminal('down')}>
              <ArrowDown size={13} /> Move Down <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.moveDown)}</span>
            </button>
            <button type="button" role="menuitem" onClick={arrangeTerminals}>
              <LayoutGrid size={13} /> Arrange panes <span style={CONTEXT_MENU_SHORTCUT_STYLE}>{formatKeyChord(keybindings.arrangePanes)}</span>
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

function shortRemoteDeviceId(deviceId: string): string {
  const safe = deviceId.trim().replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safe) return 'Remote device'
  if (safe.length <= 14) return safe
  return `${safe.slice(0, 8)}…${safe.slice(-4)}`
}

function limitUtf8Tail(value: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength <= maxBytes) return value
  return new TextDecoder().decode(bytes.slice(bytes.byteLength - maxBytes)).replace(/^\uFFFD/, '')
}

export function PlaceholderPanel() {
  return <div className="placeholder-panel">Select or create a workspace.</div>
}

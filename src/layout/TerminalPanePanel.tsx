import { invoke } from '@tauri-apps/api/core'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent as ReactDragEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { IDockviewPanelProps } from 'dockview-react'
import { ClipboardCopy, ClipboardPaste, Copy, FolderOpen, LayoutGrid, Play, Plus, Sparkles, SplitSquareHorizontal, SplitSquareVertical, SquareTerminal, TextSelect, X } from 'lucide-react'
import { useWorkspaceStore } from '../state/store'
import { TerminalManager } from '../terminal/TerminalManager'
import { TerminalSearchBar } from '../components/TerminalSearchBar'
import { terminalSearchForgetPane } from '../terminal/search'
import { pathFromTerminalSelection } from '../terminal/selectionPath'
import { useWorkspaceContentActions } from './contentActions'
import { getHermesRuntimeStatus } from '../ipc/hermes'
import type { WorkspaceContentParams } from './workspaceContentModel'
import { reclaimAllRemotePaneLeases, reclaimRemotePaneLease, useRemotePaneLeaseStore } from '../remote/paneLease'
import { findTerminalWindowForPane } from './terminalWindowRegistry'
import { toast } from '../components/toast/toastStore'
import { agentSessionDragEndEvent, clearAgentSessionDragPayload, hasAgentSessionDragPayload, readAgentSessionDragPayload } from '../components/agent/agentSessionsModel'

type TerminalPanelParams = Extract<WorkspaceContentParams, { kind: 'terminal' }>

type ContextMenuState = {
  x: number
  y: number
  hasSelection: boolean
  selectedPath: string | null
}

const CONTEXT_MENU_WIDTH = 232
const CONTEXT_MENU_HEIGHT = 416

type DeferredTerminalMount = { cancelled: boolean; mount: () => void }

const deferredTerminalMounts: DeferredTerminalMount[] = []
let deferredTerminalMountFrame: number | undefined

function flushDeferredTerminalMount(): void {
  deferredTerminalMountFrame = undefined
  let next = deferredTerminalMounts.shift()
  while (next?.cancelled) next = deferredTerminalMounts.shift()
  next?.mount()
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
  const sendAgentPrompt = useWorkspaceStore((state) => state.sendAgentPrompt)
  const paneTitle = useWorkspaceStore((state) => paneId ? state.panes[paneId]?.config.title : undefined)
  const remoteLease = useRemotePaneLeaseStore((state) => paneId ? state.leases[paneId] : undefined)
  const actions = useWorkspaceContentActions()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [agentSessionDropActive, setAgentSessionDropActive] = useState(false)
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

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!paneId) return
    event.preventDefault()
    event.stopPropagation()
    if (remoteLease) return
    const selection = TerminalManager.getSelection(paneId)
    setContextMenu({
      x: Math.min(event.clientX, window.innerWidth - CONTEXT_MENU_WIDTH),
      y: Math.min(event.clientY, window.innerHeight - CONTEXT_MENU_HEIGHT),
      hasSelection: selection.length > 0,
      selectedPath: pathFromTerminalSelection(selection),
    })
  }

  const closeContextMenu = useCallback(() => setContextMenu(null), [])

  const onAgentSessionDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasAgentSessionDragPayload(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'copy'
    setAgentSessionDropActive(true)
  }

  const onAgentSessionDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    const nextTarget = event.relatedTarget
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
    setAgentSessionDropActive(false)
  }

  const onAgentSessionDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasAgentSessionDragPayload(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const payload = readAgentSessionDragPayload(event.dataTransfer)
    setAgentSessionDropActive(false)
    clearAgentSessionDragPayload()
    window.dispatchEvent(new Event(agentSessionDragEndEvent))
    if (!payload) {
      toast.error('Could not read the agent session drag data.')
      return
    }
    void actions.openContent({
      kind: 'terminal',
      replacePaneId: paneId,
      cwd: payload.cwd,
      shell: payload.shell,
      args: payload.args,
      title: payload.title,
    }).then((panelId) => {
      if (panelId) actions.activateContent(panelId)
    }).catch((error) => toast.error(`Could not resume the agent session: ${String(error)}`))
  }

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
    const clearDropTarget = () => setAgentSessionDropActive(false)
    window.addEventListener(agentSessionDragEndEvent, clearDropTarget)
    return () => window.removeEventListener(agentSessionDragEndEvent, clearDropTarget)
  }, [])

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
    const dimensionsDisposable = panelApi.onDidDimensionsChange(() => {
      if (panelApi.isVisible) TerminalManager.reflow(paneId)
    })
    return () => {
      TerminalManager.setPaneVisible(paneId, false)
      visibilityDisposable.dispose()
      dimensionsDisposable.dispose()
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
    <div className="terminal-panel-shell" data-pane-id={paneId} data-content-panel-id={props.api.id} data-active={activePaneId === paneId ? 'true' : undefined} data-pane-reviewed={reviewed ? 'true' : undefined} data-pane-response-complete={completionHighlight ? 'true' : undefined} data-agent-session-drop-target={agentSessionDropActive ? 'true' : undefined} onContextMenu={onContextMenu} onDragEnter={onAgentSessionDragOver} onDragOver={onAgentSessionDragOver} onDragLeave={onAgentSessionDragLeave} onDrop={onAgentSessionDrop}>
      <div ref={hostRef} className="dock-terminal-host" />
      <TerminalSearchBar paneId={paneId} />
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
              <LayoutGrid size={13} /> Arrange panes in this window
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

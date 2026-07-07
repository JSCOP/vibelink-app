import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanel, type IDockviewPanelProps } from 'dockview-react'
import { WorkspaceWindowTab } from '../components/WorkspaceWindowTab'
import { TerminalTab } from '../components/TerminalTab'
import { TerminalManager } from '../terminal/TerminalManager'
import { useWorkspaceStore } from '../state/store'
import { profileById } from '../state/profiles'
import { handleCapturedKeybindingEvent, type KeybindingActionId } from '../state/keybindings'
import type { PaneMeta } from '../ipc/types'
import { PlaceholderPanel, TerminalPanePanel } from './TerminalPanePanel'
import { WorkspaceActionsContext, type WorkspaceActions, type SplitDirection } from './actions'
import { WorkspaceWindowActionsContext, type WorkspaceChromeState, type WorkspaceWindowActions } from './windowActions'
import { TEMPLATES, type GridTemplate } from './templates'
import { balancedGridForPaneCount, type GridSize } from './templatePlan'
import { withSuppressedPanelRemoval } from './suppression'
import { paneIdFromEventTarget } from './paneActivation'
import { swapPanelIdsInDockviewLayout } from './paneSwap'
import type { PaneDropPosition } from './paneDrag'
import { connectedResizeHandles, createConnectedResizeDragSession, createSingleResizeDragSession, resizeConnectedBoundaryForPane, singleResizeHandleAt, singleResizeHandles, type ConnectedResizeHandle, type ResizeDirection } from './connectedResize'
import { shouldShowResizeGuide } from './resizePreviewPolicy'
import { createResizePreviewStore, useResizePreview, type ResizePreviewState as ResizePreview, type ResizePreviewStore } from './resizePreviewStore'
import { createDockviewGridLayout, type GridPaneDescriptor } from './gridLayout'
import { shouldRestoreDockviewLayout } from './layoutRestore'
import { expandGridRowsForPaneCount, expandPaneIdsIntoGrid, occupiedGridForPaneCount } from './paneGridPlan'
import { activeWorkspaceLayoutPage, workspaceWindowDescriptors, workspaceWindowKindByPanelId, type WorkspaceWindowKind } from './workspaceLayoutModel'
import { WindowPanelShell } from './WindowPanelShell'
import { KanbanBoard } from '../components/KanbanBoard'
import { TaskDiffView } from '../components/TaskDiffView'
import { OrchestratorChat } from '../components/OrchestratorChat'
import { WorkspaceTodoPanel } from '../components/WorkspaceTodoPanel'
import { ErrorBoundary } from '../components/ErrorBoundary'

type PendingTemplateRequest = {
  sessionId: string
  templateId?: string
  cols: number
  rows: number
  occupiedGrid?: GridSize | null
  profileId?: string | null
  requestId: number
}

type WorkspaceViewProps = {
  onApiReady?: (api: DockviewApi) => void
  onActionsReady?: (actions: WorkspaceWindowActions) => void
  onChromeStateChange?: (state: WorkspaceChromeState) => void
  pendingTemplate?: PendingTemplateRequest | null
  arrangeRequestId?: number
  arrangeGrid?: GridSize | null
  resizeSnapTolerance?: number
  windowRequest?: { kind: WorkspaceWindowKind; requestId: number; profileId?: string | null } | null
  saveLayoutRequestId?: number
  onTemplateApplied?: (requestId: number) => void
}

type TerminalLaunchRequest = {
  cols: number
  rows: number
  occupiedGrid?: GridSize
  profileId?: string | null
}

type ResizePointer = {
  clientX: number
  clientY: number
  ctrlKey: boolean
}

type ResizeHandleSets = {
  connected: ConnectedResizeHandle[]
  single: ConnectedResizeHandle[]
}

const components = {
  terminalWindow: TerminalWindowPanel,
  agent: AgentWindowPanel,
  kanban: KanbanWindowPanel,
  diff: DiffWindowPanel,
  todo: TodoWindowPanel,
  placeholder: PlaceholderPanel,
}

const terminalComponents = {
  terminal: TerminalPaneBoundary,
  placeholder: PlaceholderPanel,
}

type TerminalWindowBridge = {
  onReady: (event: DockviewReadyEvent) => void
  setDockElement: (element: HTMLElement | null) => void
  resizeHandles: ResizeHandleSets
  previewStore: ResizePreviewStore
  previewResizeHandle: (event: ResizePointer, handle: ConnectedResizeHandle) => void
  clearResizePreview: () => void
  startResize: (event: ReactPointerEvent, handle: ConnectedResizeHandle) => void
}

const TerminalWindowContext = createContext<TerminalWindowBridge | null>(null)
const noopTerminalReady = () => {}

const KEYBOARD_RESIZE_STEP = 32
const RESIZE_HANDLE_HIT_SIZE = 36

function TerminalPaneBoundary(props: IDockviewPanelProps) {
  return (
    <ErrorBoundary label="Terminal pane">
      <TerminalPanePanel {...props} />
    </ErrorBoundary>
  )
}

function AgentWindowPanel(props: IDockviewPanelProps) {
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-agent">
      <ErrorBoundary label="AWT Agent panel">
        <OrchestratorChat />
      </ErrorBoundary>
    </WindowPanelShell>
  )
}

function TerminalWindowPanel(props: IDockviewPanelProps) {
  const bridge = useContext(TerminalWindowContext)
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-terminal">
      <ErrorBoundary label="Terminal window">
        <div ref={bridge?.setDockElement} className="terminal-window-dock dockview-theme-awt" data-terminal-window-dock="true" data-resize-mode="connected">
          <DockviewReact components={terminalComponents} onReady={bridge?.onReady ?? noopTerminalReady} defaultRenderer="always" defaultTabComponent={TerminalTab} disableDnd />
          {bridge ? (
            <ConnectedResizeLayer
              handles={bridge.resizeHandles}
              previewStore={bridge.previewStore}
              onPreview={bridge.previewResizeHandle}
              onClear={bridge.clearResizePreview}
              onStart={bridge.startResize}
            />
          ) : null}
        </div>
      </ErrorBoundary>
    </WindowPanelShell>
  )
}

function KanbanWindowPanel(props: IDockviewPanelProps) {
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-kanban">
      <ErrorBoundary label="Kanban panel">
        <KanbanBoard />
      </ErrorBoundary>
    </WindowPanelShell>
  )
}

function TodoWindowPanel(props: IDockviewPanelProps) {
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-todo">
      <ErrorBoundary label="Todo panel">
        <WorkspaceTodoPanel />
      </ErrorBoundary>
    </WindowPanelShell>
  )
}

function DiffWindowPanel(props: IDockviewPanelProps) {
  return (
    <WindowPanelShell panelId={props.api.id} className="workspace-window-diff">
      <ErrorBoundary label="Diff panel">
        <TaskDiffView />
      </ErrorBoundary>
    </WindowPanelShell>
  )
}

export function WorkspaceView({ onApiReady, onActionsReady, onChromeStateChange, pendingTemplate, arrangeRequestId = 0, arrangeGrid = null, resizeSnapTolerance = 32, windowRequest = null, saveLayoutRequestId = 0, onTemplateApplied }: WorkspaceViewProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const terminalApiRef = useRef<DockviewApi | null>(null)
  const loadedSessionRef = useRef<string | null>(null)
  const loadedPageRef = useRef<string | null>(null)
  const loadedPageLayoutJsonRef = useRef<string | null>(null)
  const loadedTerminalPageRef = useRef<string | null>(null)
  const suppressPanelRemovalRef = useRef(false)
  const saveTimerRef = useRef<number | undefined>()
  const dockRef = useRef<HTMLDivElement | null>(null)
  const terminalDockRef = useRef<HTMLElement | null>(null)
  const pendingTerminalLayoutRef = useRef<unknown | null>(null)
  const applyingTemplateRequestRef = useRef<number | null>(null)
  const applyingArrangeRequestRef = useRef<number | null>(null)
  const applyingWindowRequestRef = useRef<number | null>(null)
  const applyingSaveRequestRef = useRef<number | null>(null)
  const nullLayoutReloadRef = useRef<string | null>(null)
  const resizeDragRef = useRef<{ removeListeners: () => void } | null>(null)
  const resizeHoverRef = useRef<{ pointer: ResizePointer; handle: ConnectedResizeHandle } | null>(null)
  const terminalResizeDragRef = useRef<{ removeListeners: () => void } | null>(null)
  const terminalResizeHoverRef = useRef<{ pointer: ResizePointer; handle: ConnectedResizeHandle } | null>(null)
  const layoutReflowFrameRef = useRef<number | undefined>()
  const [resizeHandles, setResizeHandles] = useState<ResizeHandleSets>({ connected: [], single: [] })
  // Preview state lives outside React state: a drag writes it per frame and
  // routing that through useState would reconcile both dockview trees per
  // frame. Only ConnectedResizeLayer subscribes.
  const workspacePreviewStoreRef = useRef<ResizePreviewStore | null>(null)
  workspacePreviewStoreRef.current ??= createResizePreviewStore()
  const workspacePreviewStore = workspacePreviewStoreRef.current
  const terminalPreviewStoreRef = useRef<ResizePreviewStore | null>(null)
  terminalPreviewStoreRef.current ??= createResizePreviewStore()
  const terminalPreviewStore = terminalPreviewStoreRef.current
  const [terminalResizeHandles, setTerminalResizeHandles] = useState<ResizeHandleSets>({ connected: [], single: [] })
  const [terminalGridPreference, setTerminalGridPreference] = useState<GridSize | null>(null)
  const [chromeWindowCount, setChromeWindowCount] = useState(0)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const panes = useWorkspaceStore((state) => state.panes)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const closePaneInStore = useWorkspaceStore((state) => state.closePane)
  const clearSession = useWorkspaceStore((state) => state.clearSession)
  const saveWorkspaceLayoutPage = useWorkspaceStore((state) => state.saveWorkspaceLayoutPage)
  const deleteSession = useWorkspaceStore((state) => state.deleteSession)
  const settings = useWorkspaceStore((state) => state.settings)
  const renamePaneTitleInStore = useWorkspaceStore((state) => state.renamePaneTitle)
  const workspaceLayout = useWorkspaceStore((state) => activeSessionId ? state.workspaceLayouts[activeSessionId] : undefined)
  const activeLayoutPage = workspaceLayout ? activeWorkspaceLayoutPage(workspaceLayout) : null
  const activeLayoutPageId = activeLayoutPage?.id ?? null

  const paneList = useMemo(() => Object.values(panes), [panes])

  const serializeCurrentWorkspaceDockLayout = useCallback(() => {
    const windowApi = apiRef.current
    if (!windowApi) return null
    const layout = windowApi.toJSON() as unknown as Record<string, unknown>
    const terminalApi = terminalApiRef.current
    if (terminalApi && terminalApi.totalPanels > 0 && isDockElementMeasurable(terminalDockRef.current)) {
      layout.awtTerminalLayout = terminalApi.toJSON()
    } else if (pendingTerminalLayoutRef.current) {
      layout.awtTerminalLayout = pendingTerminalLayoutRef.current
    }
    return JSON.stringify(layout)
  }, [])

  const refreshResizeHandles = useCallback((api: DockviewApi) => {
    // See refreshTerminalResizeHandles: toJSON() is unsafe while maximized.
    const next = api.hasMaximizedGroup()
      ? { connected: [], single: [] }
      : (() => {
        const layout = api.toJSON()
        return {
          connected: connectedResizeHandles(layout),
          single: singleResizeHandles(layout, true),
        }
      })()
    setResizeHandles((current) => resizeHandleSetsEqual(current, next) ? current : next)
  }, [])

  const refreshTerminalResizeHandles = useCallback((api: DockviewApi) => {
    // toJSON() while a group is maximized makes dockview internally exit and
    // re-enter maximize (gridview.serialize), flipping every pane's visibility
    // twice per call. Never serialize while maximized.
    const next = api.hasMaximizedGroup()
      ? { connected: [], single: [] }
      : (() => {
        const layout = api.toJSON()
        return {
          connected: connectedResizeHandles(layout),
          single: singleResizeHandles(layout, true),
        }
      })()
    setTerminalResizeHandles((current) => resizeHandleSetsEqual(current, next) ? current : next)
  }, [])

  const clearResizeInteraction = useCallback((options?: { clearHandles?: boolean }) => {
    resizeDragRef.current?.removeListeners()
    resizeDragRef.current = null
    resizeHoverRef.current = null
    workspacePreviewStore.set(null)
    if (options?.clearHandles) setResizeHandles({ connected: [], single: [] })
  }, [workspacePreviewStore])

  const clearTerminalResizeInteraction = useCallback((options?: { clearHandles?: boolean }) => {
    terminalResizeDragRef.current?.removeListeners()
    terminalResizeDragRef.current = null
    terminalResizeHoverRef.current = null
    terminalPreviewStore.set(null)
    if (options?.clearHandles) setTerminalResizeHandles({ connected: [], single: [] })
  }, [terminalPreviewStore])

  const scheduleLayoutReflow = useCallback(() => {
    if (layoutReflowFrameRef.current !== undefined) cancelAnimationFrame(layoutReflowFrameRef.current)
    layoutReflowFrameRef.current = requestAnimationFrame(() => {
      layoutReflowFrameRef.current = undefined
      TerminalManager.reflowAll()
    })
  }, [])

  useEffect(() => () => {
    clearResizeInteraction()
    clearTerminalResizeInteraction()
    if (layoutReflowFrameRef.current !== undefined) {
      cancelAnimationFrame(layoutReflowFrameRef.current)
      layoutReflowFrameRef.current = undefined
    }
    if (terminalDockLayoutFrameRef.current !== undefined) {
      cancelAnimationFrame(terminalDockLayoutFrameRef.current)
      terminalDockLayoutFrameRef.current = undefined
    }
  }, [clearResizeInteraction, clearTerminalResizeInteraction])

  const persistLayoutSoon = useCallback(() => {
    const api = apiRef.current
    if (!api || !activeSessionId || suppressPanelRemovalRef.current || !isDockElementMeasurable(dockRef.current)) return
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      const currentApi = apiRef.current
      const currentSessionId = useWorkspaceStore.getState().activeSessionId
      const currentPageId = currentSessionId ? useWorkspaceStore.getState().workspaceLayouts[currentSessionId]?.activePageId : null
      if (!currentApi || !currentSessionId || !currentPageId || !isDockElementMeasurable(dockRef.current)) return
      // Serializing while maximized round-trips dockview through
      // exit/re-enter maximize and repaints every pane; retry after restore.
      if (currentApi.hasMaximizedGroup() || terminalApiRef.current?.hasMaximizedGroup()) return
      const layoutJson = serializeCurrentWorkspaceDockLayout()
      if (!layoutJson) return
      loadedPageLayoutJsonRef.current = layoutJson
      void saveWorkspaceLayoutPage(currentSessionId, currentPageId, layoutJson)
    }, 400)
  }, [activeSessionId, saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout])

  const layoutDockview = useCallback((api: DockviewApi) => {
    const rect = measurableDockRect(dockRef.current)
    if (!rect) return false
    api.layout(Math.floor(rect.width), Math.floor(rect.height), true)
    // api.layout() resizes groups but overlay containers (defaultRenderer
    // "always") only reposition on per-panel dimension events, which do not
    // fire for groups whose size survived the layout — e.g. the terminal
    // window after closing a sibling. Force a reposition pass.
    forceOverlayReposition(api)
    reflowTerminalsAfterLayout()
    refreshResizeHandles(api)
    return true
  }, [refreshResizeHandles])

  const layoutTerminalDockview = useCallback((api: DockviewApi) => {
    const rect = measurableDockRect(terminalDockRef.current)
    if (!rect) return false
    api.layout(Math.floor(rect.width), Math.floor(rect.height), true)
    forceOverlayReposition(api)
    reflowTerminalsAfterLayout({ syncPty: true })
    refreshTerminalResizeHandles(api)
    return true
  }, [refreshTerminalResizeHandles])

  const terminalDockLayoutFrameRef = useRef<number | undefined>()
  // The outer dockview repositions the terminal window's render overlay in a
  // rAF-deferred pass that only runs on per-panel dimension events — after a
  // sibling window closes, the terminal window's own dimensions "didn't
  // change" and the overlay silently keeps its stale rect (one-step-behind
  // geometry). Sequence explicitly: force the outer overlay reposition, then
  // measure the terminal dock ONE FRAME LATER so it reads the corrected host.
  const scheduleTerminalDockLayout = useCallback(() => {
    if (terminalDockLayoutFrameRef.current !== undefined) cancelAnimationFrame(terminalDockLayoutFrameRef.current)
    terminalDockLayoutFrameRef.current = requestAnimationFrame(() => {
      // Dockview's overlay resize registers its own rAF inside this call…
      if (apiRef.current) forceOverlayReposition(apiRef.current)
      // …which runs first in the next frame (registration order), so this
      // nested callback measures post-reposition geometry.
      terminalDockLayoutFrameRef.current = requestAnimationFrame(() => {
        terminalDockLayoutFrameRef.current = undefined
        if (terminalApiRef.current) layoutTerminalDockview(terminalApiRef.current)
      })
    })
  }, [layoutTerminalDockview])

  const addTerminalPanel = useCallback((api: DockviewApi, pane: PaneMeta, options?: { referencePanel?: string; direction?: SplitDirection | 'within'; inactive?: boolean }) => {
    api.addPanel({
      id: pane.id,
      component: 'terminal',
      title: pane.config.title ?? 'Shell',
      params: { kind: 'terminal', paneId: pane.id, title: pane.config.title ?? 'Shell', icon: pane.config.icon ?? undefined },
      renderer: 'always',
      inactive: options?.inactive,
      position: options?.referencePanel
        ? { referencePanel: options.referencePanel, direction: options.direction ?? 'right' }
        : undefined,
    })
  }, [])

  const addWorkspaceWindowPanel = useCallback((api: DockviewApi, kind: WorkspaceWindowKind, options?: { referencePanel?: string; direction?: SplitDirection | 'within'; inactive?: boolean }) => {
    const descriptor = workspaceWindowDescriptors[kind]
    api.addPanel({
      id: descriptor.panelId,
      component: descriptor.component,
      title: descriptor.title,
      params: { kind, title: descriptor.title, icon: descriptor.icon },
      renderer: 'always',
      inactive: options?.inactive,
      position: options?.referencePanel
        ? { referencePanel: options.referencePanel, direction: options.direction ?? 'right' }
        : undefined,
    })
  }, [])

  const buildFallbackLayout = useCallback((api: DockviewApi, panels: PaneMeta[]) => {
    if (panels.length === 0) {
      addWorkspaceWindowPanel(api, 'agent')
      return
    }
    addWorkspaceWindowPanel(api, 'terminal')
    if (!api.getPanel(workspaceWindowDescriptors.agent.panelId)) {
      addWorkspaceWindowPanel(api, 'agent', { referencePanel: workspaceWindowDescriptors.terminal.panelId, direction: 'right', inactive: true })
    }
  }, [addWorkspaceWindowPanel])

  const ensureTerminalWindowPanel = useCallback((options?: { inactive?: boolean }) => {
    const api = apiRef.current
    if (!api) return false
    const existing = api.getPanel(workspaceWindowDescriptors.terminal.panelId)
    if (existing) {
      existing.api.setActive()
      return true
    }
    addWorkspaceWindowPanel(api, 'terminal', api.activePanel
      ? { referencePanel: api.activePanel.id, direction: 'right', inactive: options?.inactive }
      : { inactive: options?.inactive })
    layoutDockview(api)
    return true
  }, [addWorkspaceWindowPanel, layoutDockview])

  const panelApiForId = useCallback((panelId: string): DockviewApi | null => {
    return useWorkspaceStore.getState().panes[panelId] ? terminalApiRef.current : apiRef.current
  }, [])

  const applyGridLayout = useCallback((api: DockviewApi, grid: GridSize, gridPanes: PaneMeta[], overflowPanes: PaneMeta[] = [], options?: { sparseMode?: 'columns' | 'rows' }) => {
    const activePanelId = api.activePanel?.id
    const nextLayout = createDockviewGridLayout(
      api.toJSON(),
      grid,
      gridPanes.map(paneToGridDescriptor),
      overflowPanes.map(paneToGridDescriptor),
      activePanelId,
      options,
    )
    if (!nextLayout) return false
    api.fromJSON(nextLayout as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
    if (activePanelId) api.getPanel(activePanelId)?.api.setActive()
    return true
  }, [])

  const loadTerminalPaneLayout = useCallback(() => {
    const api = terminalApiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    const pageId = sessionId ? useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId : null
    if (!api || !sessionId || !pageId || loadedTerminalPageRef.current === `${sessionId}:${pageId}` || !isDockElementMeasurable(terminalDockRef.current)) return
    const currentPanes = Object.values(useWorkspaceStore.getState().panes)
    const paneIds = currentPanes.map((pane) => pane.id)
    suppressPanelRemovalRef.current = true
    try {
      api.clear()
      const terminalLayout = pendingTerminalLayoutRef.current
      if (terminalLayout && shouldRestoreDockviewLayout(JSON.stringify(terminalLayout), paneIds, Object.values(workspaceWindowDescriptors).map((descriptor) => descriptor.panelId))) {
        try {
          api.fromJSON(terminalLayout as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
        } catch {
          api.clear()
          buildFallbackTerminalLayout(api, currentPanes)
        }
      } else {
        buildFallbackTerminalLayout(api, currentPanes)
      }
      if (layoutTerminalDockview(api)) {
        loadedTerminalPageRef.current = `${sessionId}:${pageId}`
      }
    } finally {
      suppressPanelRemovalRef.current = false
    }
  }, [layoutTerminalDockview])

  const loadActiveSessionLayout = useCallback(() => {
    const api = apiRef.current
    const pageId = useWorkspaceStore.getState().workspaceLayouts[activeSessionId ?? '']?.activePageId
    const layoutJson = activeSessionId && pageId
      ? useWorkspaceStore.getState().workspaceLayouts[activeSessionId]?.pages.find((page) => page.id === pageId)?.layoutJson ?? null
      : null
    if (
      !api
      || !activeSessionId
      || !pageId
      || (
        loadedSessionRef.current === activeSessionId
        && loadedPageRef.current === pageId
        && loadedPageLayoutJsonRef.current === layoutJson
      )
      || !isDockElementMeasurable(dockRef.current)
    ) return
    suppressPanelRemovalRef.current = true
    try {
      const switchingLoadedPage = loadedSessionRef.current !== activeSessionId || loadedPageRef.current !== pageId
      if (switchingLoadedPage && loadedSessionRef.current && loadedPageRef.current && isDockElementMeasurable(dockRef.current)) {
        const previousLayoutJson = serializeCurrentWorkspaceDockLayout()
        if (previousLayoutJson) {
          loadedPageLayoutJsonRef.current = previousLayoutJson
          void saveWorkspaceLayoutPage(loadedSessionRef.current, loadedPageRef.current, previousLayoutJson)
        }
      }
      api.clear()
      const currentPanes = Object.values(useWorkspaceStore.getState().panes)
      const paneIds = currentPanes.map((pane) => pane.id)
      const storedLayout = layoutJson ? splitStoredWorkspaceLayout(layoutJson) : null
      pendingTerminalLayoutRef.current = storedLayout?.terminalLayout ?? null
      if (storedLayout?.topLayout && shouldRestoreWorkspaceDockviewLayout(JSON.stringify(storedLayout.topLayout), paneIds)) {
        try {
          api.fromJSON(storedLayout.topLayout as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
          if (api.totalPanels === 0 && paneIds.length > 0) {
            api.clear()
            buildFallbackLayout(api, Object.values(useWorkspaceStore.getState().panes))
          }
        } catch {
          api.clear()
          buildFallbackLayout(api, Object.values(useWorkspaceStore.getState().panes))
        }
      } else {
        buildFallbackLayout(api, currentPanes)
      }
      if (layoutDockview(api)) {
        loadedSessionRef.current = activeSessionId
        loadedPageRef.current = pageId
        loadedPageLayoutJsonRef.current = layoutJson
        loadedTerminalPageRef.current = null
        requestAnimationFrame(() => loadTerminalPaneLayout())
      }
    } finally {
      suppressPanelRemovalRef.current = false
    }
  }, [activeSessionId, buildFallbackLayout, layoutDockview, loadTerminalPaneLayout, saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout])

  const activatePane = useCallback((paneId: string) => {
    if (useWorkspaceStore.getState().panes[paneId]) {
      apiRef.current?.getPanel(workspaceWindowDescriptors.terminal.panelId)?.api.setActive()
      const panel = terminalApiRef.current?.getPanel(paneId)
      panel?.api.setActive()
      useWorkspaceStore.getState().setActivePaneId(paneId)
      if (panel) TerminalManager.focus(paneId)
      return
    }
    apiRef.current?.getPanel(paneId)?.api.setActive()
  }, [])

  const activatePaneFromTarget = useCallback((event: { target: EventTarget | null }) => {
    const paneId = paneIdFromEventTarget(event.target) ?? windowPanelIdFromEventTarget(event.target)
    if (paneId) activatePane(paneId)
  }, [activatePane])

  const splitPane = useCallback(async (paneId: string, direction: SplitDirection) => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    ensureTerminalWindowPanel()
    const api = terminalApiRef.current ?? await waitForDockviewApi(terminalApiRef)
    if (!api || !sessionId) return
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      activatePane(paneId)
      const pane = await spawnPane(sessionId)
      addTerminalPanel(api, pane, { referencePanel: paneId, direction })
      layoutTerminalDockview(api)
      // Splitting halves the sibling pane; recover it alongside the new one.
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      persistLayoutSoon()
    })
  }, [activatePane, addTerminalPanel, ensureTerminalWindowPanel, layoutTerminalDockview, persistLayoutSoon, spawnPane])


  const closePane = useCallback(async (paneId: string) => {
    const api = terminalApiRef.current
    const panel = api?.getPanel(paneId)
    if (!api || !panel) return
    const nextPaneId = nextPaneAfterClose(api, paneId)
    activatePane(paneId)
    panel.api.close()
    if (nextPaneId) {
      requestAnimationFrame(() => {
        const nextPanel = api.getPanel(nextPaneId)
        if (!nextPanel) return
        nextPanel.api.setActive()
        TerminalManager.focus(nextPanel.id)
      })
    }
  }, [activatePane])

  const closeWindow = useCallback(async (panelId: string) => {
    if (useWorkspaceStore.getState().panes[panelId]) {
      await closePane(panelId)
      return
    }
    const panel = apiRef.current?.getPanel(panelId)
    if (!panel) return
    panel.api.close()
    persistLayoutSoon()
  }, [closePane, persistLayoutSoon])

  const toggleMaximize = useCallback((paneId: string) => {
    const api = panelApiForId(paneId)
    const panel = api?.getPanel(paneId)
    activatePane(paneId)
    if (!panel) return
    const syncActivePane = () => {
      if (useWorkspaceStore.getState().panes[paneId]) {
        TerminalManager.focus(paneId)
        TerminalManager.syncPtySize(paneId)
      }
    }
    if (panel.api.isMaximized()) {
      panel.api.exitMaximized()
      reflowTerminalsAfterLayout({ syncPty: true })
      requestAnimationFrame(() => requestAnimationFrame(syncActivePane))
    } else {
      panel.api.maximize()
      requestAnimationFrame(syncActivePane)
    }
  }, [activatePane, panelApiForId])

  const renamePaneTitle = useCallback(async (paneId: string, title: string) => {
    await renamePaneTitleInStore(paneId, title, 'manual')
    terminalApiRef.current?.getPanel(paneId)?.api.setTitle(title)
  }, [renamePaneTitleInStore])
  const swapPaneLocations = useCallback(async (sourcePaneId: string, targetPaneId: string) => {
    const api = panelApiForId(sourcePaneId)
    if (!api || api !== panelApiForId(targetPaneId)) return
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId || sourcePaneId === targetPaneId) return
    if (!api.getPanel(sourcePaneId) || !api.getPanel(targetPaneId)) return
    const isTerminalLayout = api === terminalApiRef.current

    const layout = api.toJSON()
    if (!swapPanelIdsInDockviewLayout(layout, sourcePaneId, targetPaneId)) return

    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      api.fromJSON(layout, { reuseExistingPanels: true })
      if (isTerminalLayout) layoutTerminalDockview(api)
      else layoutDockview(api)
      // Swapping panels re-hosts xterm DOM; force-fit + atlas reset once the
      // new geometry settles.
      if (isTerminalLayout) reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      loadedSessionRef.current = sessionId
      loadedPageRef.current = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId ?? loadedPageRef.current
      const sourcePanel = api.getPanel(sourcePaneId)
      if (sourcePanel) {
        sourcePanel.api.setActive()
        if (isTerminalLayout) TerminalManager.focus(sourcePaneId)
      }
      const pageId = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId
      const layoutJson = serializeCurrentWorkspaceDockLayout()
      if (pageId && layoutJson) {
        loadedPageLayoutJsonRef.current = layoutJson
        await saveWorkspaceLayoutPage(sessionId, pageId, layoutJson)
      }
    })
  }, [layoutDockview, layoutTerminalDockview, panelApiForId, saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout])

  const movePaneToPosition = useCallback(async (sourcePaneId: string, targetPaneId: string, position: Exclude<PaneDropPosition, 'center'>) => {
    const api = panelApiForId(sourcePaneId)
    if (!api || api !== panelApiForId(targetPaneId)) return
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId || sourcePaneId === targetPaneId) return
    const sourcePanel = api.getPanel(sourcePaneId)
    const targetPanel = api.getPanel(targetPaneId)
    if (!sourcePanel || !targetPanel) return
    const isTerminalLayout = api === terminalApiRef.current

    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      sourcePanel.api.moveTo({ group: targetPanel.group, position })
      if (isTerminalLayout) layoutTerminalDockview(api)
      else layoutDockview(api)
      if (isTerminalLayout) reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      loadedSessionRef.current = sessionId
      loadedPageRef.current = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId ?? loadedPageRef.current
      sourcePanel.api.setActive()
      if (isTerminalLayout) TerminalManager.focus(sourcePaneId)
      const pageId = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId
      const layoutJson = serializeCurrentWorkspaceDockLayout()
      if (pageId && layoutJson) {
        loadedPageLayoutJsonRef.current = layoutJson
        await saveWorkspaceLayoutPage(sessionId, pageId, layoutJson)
      }
    })
  }, [layoutDockview, layoutTerminalDockview, panelApiForId, saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout])

  const applyResizedLayout = useCallback(async (api: DockviewApi, nextLayout: unknown, isTerminalLayout: boolean) => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      api.fromJSON(nextLayout as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
      if (isTerminalLayout) layoutTerminalDockview(api)
      else {
        layoutDockview(api)
        // Outer divider commits resize the terminal window host too; re-layout
        // the inner dock once its DOM settles.
        scheduleTerminalDockLayout()
      }
      // Divider commits rebuild the grid from JSON; recover so pane content
      // (WebGL glyphs + scroll geometry) matches the new sizes without a click.
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      loadedSessionRef.current = sessionId
      loadedPageRef.current = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId ?? loadedPageRef.current
      const pageId = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId
      const layoutJson = serializeCurrentWorkspaceDockLayout()
      if (pageId && layoutJson) {
        loadedPageLayoutJsonRef.current = layoutJson
        await saveWorkspaceLayoutPage(sessionId, pageId, layoutJson)
      }
    })
  }, [layoutDockview, layoutTerminalDockview, saveWorkspaceLayoutPage, scheduleTerminalDockLayout, serializeCurrentWorkspaceDockLayout])

  const resizeActivePaneByKeyboard = useCallback((paneId: string, direction: ResizeDirection) => {
    const api = panelApiForId(paneId)
    if (!api) return
    const layout = api.toJSON()
    const nextLayout = resizeConnectedBoundaryForPane(layout, paneId, direction, KEYBOARD_RESIZE_STEP)
    if (!nextLayout) return
    void applyResizedLayout(api, nextLayout, api === terminalApiRef.current)
  }, [applyResizedLayout, panelApiForId])

  const resizeHandleForPointer = useCallback((event: ResizePointer, handle: ConnectedResizeHandle, layout: unknown, dockElement: HTMLElement | null = dockRef.current): ConnectedResizeHandle | null => {
    if (isSingleResizeHandle(handle)) return handle
    if (!event.ctrlKey) return handle
    const dockRect = dockElement?.getBoundingClientRect()
    const point = handle.axis === 'x'
      ? event.clientY - (dockRect?.top ?? 0)
      : event.clientX - (dockRect?.left ?? 0)
    return singleResizeHandleAt(layout, handle.axis, handle.coordinate, point, true)
  }, [])

  const showResizePreview = useCallback((pointer: ResizePointer, handle: ConnectedResizeHandle) => {
    if (resizeDragRef.current) return
    const api = apiRef.current
    if (!api) return
    if (!shouldShowResizeGuide('hover', pointer.ctrlKey)) {
      workspacePreviewStore.set(null)
      return
    }
    // api.toJSON() walks the whole layout tree — only pay for it when ctrl
    // (single-segment) hover actually needs geometry. Identical previews are
    // deduped inside the store.
    const previewHandle = !pointer.ctrlKey || isSingleResizeHandle(handle)
      ? handle
      : resizeHandleForPointer(pointer, handle, api.toJSON())
    if (!previewHandle) {
      workspacePreviewStore.set(null)
      return
    }
    workspacePreviewStore.set({ ...previewHandle, delta: 0, mode: isSingleResizeHandle(previewHandle) ? 'single' : 'connected' })
  }, [resizeHandleForPointer, workspacePreviewStore])

  const previewResizeHandle = useCallback((event: ResizePointer, handle: ConnectedResizeHandle) => {
    const pointer = { clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey }
    resizeHoverRef.current = { pointer, handle }
    showResizePreview(pointer, handle)
  }, [showResizePreview])

  const clearResizePreview = useCallback(() => {
    if (!resizeDragRef.current) {
      resizeHoverRef.current = null
      workspacePreviewStore.set(null)
    }
  }, [workspacePreviewStore])

  const startConnectedResize = useCallback((event: ReactPointerEvent, handle: ConnectedResizeHandle) => {
    const api = apiRef.current
    if (!api) return
    event.preventDefault()
    event.stopPropagation()

    resizeDragRef.current?.removeListeners()
    resizeHoverRef.current = null
    const dockRect = dockRef.current?.getBoundingClientRect()
    const startLayout = api.toJSON()
    const previewHandle = resizeHandleForPointer(event, handle, startLayout)
    if (!previewHandle) return
    const singleSegment = event.ctrlKey || isSingleResizeHandle(previewHandle)
    const startPoint = previewHandle.axis === 'x' ? event.clientX : event.clientY
    const segmentPoint = previewHandle.axis === 'x'
      ? event.clientY - (dockRect?.top ?? 0)
      : event.clientX - (dockRect?.left ?? 0)
    // One-time analysis per drag: the per-frame path (deltaFor) is pure
    // arithmetic over precomputed boundaries; the clone-and-apply
    // (layoutFor) runs once, on pointerup.
    const session = singleSegment
      ? createSingleResizeDragSession(startLayout, previewHandle.axis, previewHandle.coordinate, segmentPoint, undefined, resizeSnapTolerance, true)
      : createConnectedResizeDragSession(startLayout, previewHandle.axis, previewHandle.coordinate, previewHandle.start, previewHandle.end, undefined, resizeSnapTolerance)
    if (!session) return
    let latestPoint: number | null = null
    let moveFrame: number | undefined

    workspacePreviewStore.set({ ...previewHandle, delta: 0, mode: singleSegment ? 'single' : 'connected' })

    // pointermove can outpace the compositor (high-Hz mice / 240Hz panels);
    // coalesce preview updates to one per frame.
    const onPointerMove = (moveEvent: PointerEvent) => {
      latestPoint = previewHandle.axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      if (moveFrame !== undefined) return
      moveFrame = requestAnimationFrame(() => {
        moveFrame = undefined
        if (latestPoint === null) return
        const rawDelta = latestPoint - startPoint
        const delta = session.deltaFor(rawDelta)
        const snapped = Math.abs(delta - rawDelta) > 2
        workspacePreviewStore.set({ ...previewHandle, delta, rawDelta, mode: singleSegment ? 'single' : 'connected', snapped })
      })
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      // Commit from the release position so a fast drag-release never lands a
      // frame-stale size. pointercancel carries no meaningful coordinates —
      // keep the last move point there.
      if (upEvent.type === 'pointerup') latestPoint = previewHandle.axis === 'x' ? upEvent.clientX : upEvent.clientY
      const nextLayout = latestPoint === null ? null : session.layoutFor(session.deltaFor(latestPoint - startPoint))
      resizeDragRef.current?.removeListeners()
      resizeDragRef.current = null
      resizeHoverRef.current = null
      workspacePreviewStore.set(null)
      if (!nextLayout) return
      void applyResizedLayout(api, nextLayout, false)
    }

    const removeListeners = () => {
      if (moveFrame !== undefined) {
        cancelAnimationFrame(moveFrame)
        moveFrame = undefined
      }
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
    resizeDragRef.current = { removeListeners }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }, [applyResizedLayout, resizeHandleForPointer, resizeSnapTolerance, workspacePreviewStore])

  const showTerminalResizePreview = useCallback((pointer: ResizePointer, handle: ConnectedResizeHandle) => {
    if (terminalResizeDragRef.current) return
    const api = terminalApiRef.current
    if (!api) return
    if (!shouldShowResizeGuide('hover', pointer.ctrlKey)) {
      terminalPreviewStore.set(null)
      return
    }
    const previewHandle = !pointer.ctrlKey || isSingleResizeHandle(handle)
      ? handle
      : resizeHandleForPointer(pointer, handle, api.toJSON(), terminalDockRef.current)
    if (!previewHandle) {
      terminalPreviewStore.set(null)
      return
    }
    terminalPreviewStore.set({ ...previewHandle, delta: 0, mode: isSingleResizeHandle(previewHandle) ? 'single' : 'connected' })
  }, [resizeHandleForPointer, terminalPreviewStore])

  const previewTerminalResizeHandle = useCallback((event: ResizePointer, handle: ConnectedResizeHandle) => {
    const pointer = { clientX: event.clientX, clientY: event.clientY, ctrlKey: event.ctrlKey }
    terminalResizeHoverRef.current = { pointer, handle }
    showTerminalResizePreview(pointer, handle)
  }, [showTerminalResizePreview])

  const clearTerminalResizePreview = useCallback(() => {
    if (!terminalResizeDragRef.current) {
      terminalResizeHoverRef.current = null
      terminalPreviewStore.set(null)
    }
  }, [terminalPreviewStore])

  const startTerminalConnectedResize = useCallback((event: ReactPointerEvent, handle: ConnectedResizeHandle) => {
    const api = terminalApiRef.current
    if (!api) return
    event.preventDefault()
    event.stopPropagation()

    terminalResizeDragRef.current?.removeListeners()
    terminalResizeHoverRef.current = null
    const dockRect = terminalDockRef.current?.getBoundingClientRect()
    const startLayout = api.toJSON()
    const previewHandle = resizeHandleForPointer(event, handle, startLayout, terminalDockRef.current)
    if (!previewHandle) return
    const singleSegment = event.ctrlKey || isSingleResizeHandle(previewHandle)
    const startPoint = previewHandle.axis === 'x' ? event.clientX : event.clientY
    const segmentPoint = previewHandle.axis === 'x'
      ? event.clientY - (dockRect?.top ?? 0)
      : event.clientX - (dockRect?.left ?? 0)
    // See startConnectedResize: one-time analysis, per-frame arithmetic.
    const session = singleSegment
      ? createSingleResizeDragSession(startLayout, previewHandle.axis, previewHandle.coordinate, segmentPoint, undefined, resizeSnapTolerance, true)
      : createConnectedResizeDragSession(startLayout, previewHandle.axis, previewHandle.coordinate, previewHandle.start, previewHandle.end, undefined, resizeSnapTolerance)
    if (!session) return
    let latestPoint: number | null = null
    let moveFrame: number | undefined

    terminalPreviewStore.set({ ...previewHandle, delta: 0, mode: singleSegment ? 'single' : 'connected' })

    const onPointerMove = (moveEvent: PointerEvent) => {
      latestPoint = previewHandle.axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      if (moveFrame !== undefined) return
      moveFrame = requestAnimationFrame(() => {
        moveFrame = undefined
        if (latestPoint === null) return
        const rawDelta = latestPoint - startPoint
        const delta = session.deltaFor(rawDelta)
        const snapped = Math.abs(delta - rawDelta) > 2
        terminalPreviewStore.set({ ...previewHandle, delta, rawDelta, mode: singleSegment ? 'single' : 'connected', snapped })
      })
    }

    const onPointerUp = (upEvent: PointerEvent) => {
      if (upEvent.type === 'pointerup') latestPoint = previewHandle.axis === 'x' ? upEvent.clientX : upEvent.clientY
      const nextLayout = latestPoint === null ? null : session.layoutFor(session.deltaFor(latestPoint - startPoint))
      terminalResizeDragRef.current?.removeListeners()
      terminalResizeDragRef.current = null
      terminalResizeHoverRef.current = null
      terminalPreviewStore.set(null)
      if (!nextLayout) return
      void applyResizedLayout(api, nextLayout, true)
    }

    const removeListeners = () => {
      if (moveFrame !== undefined) {
        cancelAnimationFrame(moveFrame)
        moveFrame = undefined
      }
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
    terminalResizeDragRef.current = { removeListeners }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }, [applyResizedLayout, resizeHandleForPointer, resizeSnapTolerance, terminalPreviewStore])


  const closeWorkspace = useCallback(async () => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!sessionId) return
    const api = apiRef.current
    const pageId = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId
    if (api && pageId) {
      const layoutJson = serializeCurrentWorkspaceDockLayout()
      if (layoutJson) {
        loadedPageLayoutJsonRef.current = layoutJson
        await saveWorkspaceLayoutPage(sessionId, pageId, layoutJson)
      }
    }
    await deleteSession(sessionId)
  }, [deleteSession, saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout])

  const saveCurrentPageLayout = useCallback(async () => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    const pageId = sessionId ? useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId : null
    if (!api || !sessionId || !pageId || !isDockElementMeasurable(dockRef.current)) return
    const layoutJson = serializeCurrentWorkspaceDockLayout()
    if (layoutJson) {
      loadedPageLayoutJsonRef.current = layoutJson
      await saveWorkspaceLayoutPage(sessionId, pageId, layoutJson)
    }
  }, [saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout])

  const openWorkspaceWindow = useCallback(async (kind: WorkspaceWindowKind, profileId?: string | null) => {
    const windowApi = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!windowApi || !sessionId) return
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      if (kind === 'terminal') {
        ensureTerminalWindowPanel()
        const terminalApi = terminalApiRef.current ?? await waitForDockviewApi(terminalApiRef)
        if (!terminalApi) return
        const livePaneCount = Object.keys(useWorkspaceStore.getState().panes).length
        if (livePaneCount === 0) {
          const pane = await spawnPane(sessionId, { profileId })
          addTerminalPanel(terminalApi, pane)
          TerminalManager.focus(pane.id)
        } else if (terminalApi.totalPanels === 0) {
          loadedTerminalPageRef.current = null
          loadTerminalPaneLayout()
        }
        layoutTerminalDockview(terminalApi)
        loadedSessionRef.current = sessionId
        loadedPageRef.current = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId ?? loadedPageRef.current
        await saveCurrentPageLayout()
        return
      }

      const descriptor = workspaceWindowDescriptors[kind]
      const existing = windowApi.getPanel(descriptor.panelId)
      if (existing) {
        existing.api.setActive()
        return
      }
      addWorkspaceWindowPanel(windowApi, kind, windowApi.activePanel ? { referencePanel: windowApi.activePanel.id, direction: 'right' } : undefined)
      layoutDockview(windowApi)
      loadedSessionRef.current = sessionId
      loadedPageRef.current = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId ?? loadedPageRef.current
      await saveCurrentPageLayout()
    })
  }, [addTerminalPanel, addWorkspaceWindowPanel, ensureTerminalWindowPanel, layoutDockview, layoutTerminalDockview, loadTerminalPaneLayout, saveCurrentPageLayout, spawnPane])

  const focusPane = useCallback((direction: 'left' | 'right' | 'up' | 'down') => {
    const topActivePanelId = apiRef.current?.activePanel?.id
    const api = topActivePanelId === workspaceWindowDescriptors.terminal.panelId ? terminalApiRef.current : apiRef.current
    const activePanel = api?.activePanel
    if (!api || !activePanel) return

    const activeRect = getPaneRect(activePanel.id)
    if (!activeRect) {
      if (direction === 'left' || direction === 'up') api.moveToPrevious()
      else api.moveToNext()
      return
    }

    let best: { id: string; score: number } | null = null
    for (const panel of api.panels) {
      if (panel.id === activePanel.id) continue
      const rect = getPaneRect(panel.id)
      if (!rect || !isInDirection(activeRect, rect, direction)) continue
      const score = directionalDistance(activeRect, rect, direction)
      if (!best || score < best.score) best = { id: panel.id, score }
    }

    const target = best ? api.getPanel(best.id) : undefined
    if (target) {
      target.api.setActive()
      TerminalManager.focus(target.id)
    } else {
      if (direction === 'left' || direction === 'up') api.moveToPrevious()
      else api.moveToNext()
      const focusedPanelId = api.activePanel?.id
      if (focusedPanelId) TerminalManager.focus(focusedPanelId)
    }
  }, [])

  const arrangePanes = useCallback(async (requestedGridOverride?: GridSize | null) => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    ensureTerminalWindowPanel()
    const api = terminalApiRef.current ?? await waitForDockviewApi(terminalApiRef)
    if (!api || !sessionId) return
    const currentPanes = Object.values(useWorkspaceStore.getState().panes)
    if (currentPanes.length === 0) return
    const rect = terminalDockRef.current?.getBoundingClientRect()
    const aspectRatio = rect && rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1
    const requestedGrid = requestedGridOverride ?? terminalGridPreference ?? arrangeGrid
    const preferredGrid = requestedGrid ? expandGridRowsForPaneCount(requestedGrid, currentPanes.length) : null
    if (requestedGridOverride) setTerminalGridPreference({ cols: requestedGridOverride.cols, rows: requestedGridOverride.rows })
    const grid = preferredGrid ?? exactTemplateGridForPaneCount(currentPanes.length, aspectRatio) ?? balancedGridForPaneCount(currentPanes.length, aspectRatio)
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      applyGridLayout(api, grid, currentPanes, [], preferredGrid ? { sparseMode: 'rows' } : undefined)
      layoutTerminalDockview(api)
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      loadedSessionRef.current = sessionId
      loadedPageRef.current = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId ?? loadedPageRef.current
      const pageId = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId
      const layoutJson = serializeCurrentWorkspaceDockLayout()
      if (pageId && layoutJson) {
        loadedPageLayoutJsonRef.current = layoutJson
        await saveWorkspaceLayoutPage(sessionId, pageId, layoutJson)
      }
    })
  }, [applyGridLayout, arrangeGrid, ensureTerminalWindowPanel, layoutTerminalDockview, saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout, terminalGridPreference])

  const runKeybindingAction = useCallback((action: KeybindingActionId, activePanelId: string) => {
    const api = panelApiForId(activePanelId)
    if (!api) return
    switch (action) {
      case 'splitRight':
        void splitPane(activePanelId, 'right')
        break
      case 'splitDown':
        void splitPane(activePanelId, 'below')
        break
      case 'closePane':
        void closePane(activePanelId)
        break
      case 'closeWorkspace':
        void closeWorkspace()
        break
      case 'toggleMaximize':
        toggleMaximize(activePanelId)
        break
      case 'arrangePanes':
        void arrangePanes()
        break
      case 'nextTab': {
        api.moveToNext()
        const nextPanelId = api.activePanel?.id
        if (nextPanelId) TerminalManager.focus(nextPanelId)
        break
      }
      case 'previousTab': {
        api.moveToPrevious()
        const previousPanelId = api.activePanel?.id
        if (previousPanelId) TerminalManager.focus(previousPanelId)
        break
      }
      case 'focusLeft':
        focusPane('left')
        break
      case 'focusRight':
        focusPane('right')
        break
      case 'focusUp':
        focusPane('up')
        break
      case 'focusDown':
        focusPane('down')
        break
      case 'copyTerminalContents':
        if (useWorkspaceStore.getState().panes[activePanelId]) TerminalManager.copyContentsToClipboard(activePanelId)
        break
      case 'copyTerminalSelection':
        if (useWorkspaceStore.getState().panes[activePanelId]) TerminalManager.copySelectionToClipboard(activePanelId)
        break
    }
  }, [arrangePanes, closePane, closeWorkspace, focusPane, panelApiForId, splitPane, toggleMaximize])

  const applyTemplate = useCallback(async (template: GridTemplate, profileId?: string | null, occupiedGrid?: GridSize | null) => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    ensureTerminalWindowPanel()
    const api = terminalApiRef.current ?? await waitForDockviewApi(terminalApiRef)
    if (!api || !sessionId) return
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      const profile = profileById(useWorkspaceStore.getState().settings, profileId)
      const targetPaneCount = template.cols * template.rows
      const existingPanes = Object.values(useWorkspaceStore.getState().panes)
      const existingPaneIds = existingPanes.map((pane) => pane.id)
      const missingPaneCount = Math.max(0, targetPaneCount - existingPanes.length)
      const newPanes: PaneMeta[] = []

      for (let index = 0; index < missingPaneCount; index += 1) {
        const pane = await spawnPane(sessionId, { profileId, title: `${profile.name} ${existingPanes.length + newPanes.length + 1}` })
        newPanes.push(pane)
      }

      const paneById = new Map([...existingPanes, ...newPanes].map((pane) => [pane.id, pane]))
      const gridPaneIds = missingPaneCount > 0
        ? expandPaneIdsIntoGrid(existingPaneIds, newPanes.map((pane) => pane.id), occupiedGrid ?? occupiedGridForPaneCount(existingPanes.length), template)
        : existingPaneIds.slice(0, targetPaneCount)
      const gridPaneIdSet = new Set(gridPaneIds)
      const overflowPaneIds = existingPaneIds.filter((paneId) => !gridPaneIdSet.has(paneId))
      const gridPanes = gridPaneIds.map((paneId) => paneById.get(paneId)).filter((pane): pane is PaneMeta => pane !== undefined)
      const overflowPanes = overflowPaneIds.map((paneId) => paneById.get(paneId)).filter((pane): pane is PaneMeta => pane !== undefined)
      applyGridLayout(api, template, gridPanes, overflowPanes)

      layoutTerminalDockview(api)
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      loadedSessionRef.current = sessionId
      loadedPageRef.current = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId ?? loadedPageRef.current
      const pageId = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId
      const layoutJson = serializeCurrentWorkspaceDockLayout()
      if (pageId && layoutJson) {
        loadedPageLayoutJsonRef.current = layoutJson
        await saveWorkspaceLayoutPage(sessionId, pageId, layoutJson)
      }
    })
  }, [applyGridLayout, ensureTerminalWindowPanel, layoutTerminalDockview, saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout, spawnPane])


  const clearTerminalPanes = useCallback(() => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!sessionId) return
    setTerminalGridPreference(null)
    pendingTerminalLayoutRef.current = null
    loadedTerminalPageRef.current = null
    const api = terminalApiRef.current
    if (api) {
      void withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
        for (const panel of [...api.panels]) {
          TerminalManager.dispose(panel.id)
          panel.api.close()
        }
        layoutTerminalDockview(api)
      })
    }
    void clearSession(sessionId).then(() => {
      const layoutJson = serializeCurrentWorkspaceDockLayout()
      const pageId = useWorkspaceStore.getState().workspaceLayouts[sessionId]?.activePageId
      if (pageId && layoutJson) {
        loadedPageLayoutJsonRef.current = layoutJson
        void saveWorkspaceLayoutPage(sessionId, pageId, layoutJson)
      }
    })
  }, [clearSession, layoutTerminalDockview, saveWorkspaceLayoutPage, serializeCurrentWorkspaceDockLayout])

  const launchTerminalGrid = useCallback((request: TerminalLaunchRequest) => {
    setTerminalGridPreference({ cols: request.cols, rows: request.rows })
    void applyTemplate(
      { id: `${request.cols}x${request.rows}`, label: `${request.cols}x${request.rows}`, cols: request.cols, rows: request.rows },
      request.profileId,
      request.occupiedGrid,
    )
  }, [applyTemplate])

  const paneActions = useMemo<WorkspaceActions>(() => ({
    activatePane,
    splitPane,
    closePane,
    toggleMaximize,
    renamePaneTitle,
    swapPaneLocations,
    movePaneToPosition,
  }), [activatePane, closePane, movePaneToPosition, renamePaneTitle, splitPane, swapPaneLocations, toggleMaximize])

  const windowActions = useMemo<WorkspaceWindowActions>(() => ({
    activateWindow: activatePane,
    splitTerminal: splitPane,
    closeWindow,
    toggleMaximize,
    renameTerminalTitle: renamePaneTitle,
    swapWindowLocations: swapPaneLocations,
    moveWindowToPosition: movePaneToPosition,
    clearTerminals: clearTerminalPanes,
    arrangeTerminals: (grid) => { void arrangePanes(grid) },
    launchTerminalGrid,
    getTerminalLayoutSnapshot: () => terminalApiRef.current?.toJSON() ?? null,
  }), [activatePane, arrangePanes, clearTerminalPanes, closeWindow, launchTerminalGrid, movePaneToPosition, renamePaneTitle, splitPane, swapPaneLocations, toggleMaximize])

  useEffect(() => {
    onActionsReady?.(windowActions)
  }, [onActionsReady, windowActions])

  const onChromeStateChangeRef = useRef(onChromeStateChange)
  useEffect(() => {
    onChromeStateChangeRef.current = onChromeStateChange
  }, [onChromeStateChange])

  const syncChromeState = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    const windowCount = api.panels.length
    setChromeWindowCount(windowCount)
    onChromeStateChangeRef.current?.({
      windowCount,
      activeWindowKind: workspaceWindowKindByPanelId[api.activePanel?.id ?? ''] ?? null,
    })
  }, [])

  const isSingleWindow = chromeWindowCount === 1
  useEffect(() => {
    // data-single-window toggles outer group header visibility; re-fit terminals.
    reflowTerminalsAfterLayout({ syncPty: true })
  }, [isSingleWindow])

  const setActivePaneFromApis = useCallback(() => {
    const terminalWindowIsActive = apiRef.current?.activePanel?.id === workspaceWindowDescriptors.terminal.panelId
    const activeTerminalPanelId = terminalApiRef.current?.activePanel?.id
    const activePaneId = terminalWindowIsActive && activeTerminalPanelId && useWorkspaceStore.getState().panes[activeTerminalPanelId]
      ? activeTerminalPanelId
      : undefined
    useWorkspaceStore.getState().setActivePaneId(activePaneId)
  }, [])

  const setTerminalDockElement = useCallback((element: HTMLElement | null) => {
    terminalDockRef.current = element
    if (!element || !terminalApiRef.current) return
    requestAnimationFrame(() => {
      const api = terminalApiRef.current
      if (!api) return
      if (loadedTerminalPageRef.current === null) loadTerminalPaneLayout()
      else layoutTerminalDockview(api)
    })
  }, [layoutTerminalDockview, loadTerminalPaneLayout])

  const handleTerminalReady = useCallback((event: DockviewReadyEvent) => {
    terminalApiRef.current = event.api
    const updateActivePaneId = () => setActivePaneFromApis()
    const activePanelApi = event.api as DockviewApi & { onDidActivePanelChange?: (listener: () => void) => { dispose(): void } }
    const hasActivePanelChange = typeof activePanelApi.onDidActivePanelChange === 'function'

    if (hasActivePanelChange) activePanelApi.onDidActivePanelChange(updateActivePaneId)
    event.api.onDidMaximizedGroupChange(() => {
      const hasMaximizedGroup = event.api.hasMaximizedGroup()
      clearTerminalResizeInteraction({ clearHandles: hasMaximizedGroup })
      if (!hasMaximizedGroup && isDockElementMeasurable(terminalDockRef.current)) refreshTerminalResizeHandles(event.api)
      // Dockview's maximize transition leaves group geometry stale until the
      // next layout pass; force one first, then reflow + recover panes so
      // xterm refits against the real container size.
      scheduleTerminalDockLayout()
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      persistLayoutSoon()
    })
    event.api.onDidLayoutChange(() => {
      if (!isDockElementMeasurable(terminalDockRef.current)) return
      scheduleLayoutReflow()
      refreshTerminalResizeHandles(event.api)
      persistLayoutSoon()
      if (!hasActivePanelChange) updateActivePaneId()
    })
    event.api.onDidRemovePanel((panel: IDockviewPanel) => {
      if (suppressPanelRemovalRef.current) return
      if (!useWorkspaceStore.getState().panes[panel.id]) {
        persistLayoutSoon()
        return
      }
      TerminalManager.dispose(panel.id)
      void closePaneInStore(panel.id)
      // Closing a pane resizes every survivor; without a forced re-layout +
      // WebGL recovery the remaining panes keep stale geometry and glyph
      // atlases (visible as garbled rendering until a click).
      scheduleTerminalDockLayout()
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
    })
    loadedTerminalPageRef.current = null
    requestAnimationFrame(() => loadTerminalPaneLayout())
  }, [clearTerminalResizeInteraction, closePaneInStore, loadTerminalPaneLayout, persistLayoutSoon, refreshTerminalResizeHandles, scheduleLayoutReflow, scheduleTerminalDockLayout, setActivePaneFromApis])

  const terminalWindowBridge = useMemo<TerminalWindowBridge>(() => ({
    onReady: handleTerminalReady,
    setDockElement: setTerminalDockElement,
    resizeHandles: terminalResizeHandles,
    previewStore: terminalPreviewStore,
    previewResizeHandle: previewTerminalResizeHandle,
    clearResizePreview: clearTerminalResizePreview,
    startResize: startTerminalConnectedResize,
  }), [clearTerminalResizePreview, handleTerminalReady, previewTerminalResizeHandle, setTerminalDockElement, startTerminalConnectedResize, terminalPreviewStore, terminalResizeHandles])

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    const updateActivePaneId = () => {
      setActivePaneFromApis()
    }
    const activePanelApi = event.api as DockviewApi & { onDidActivePanelChange?: (listener: () => void) => { dispose(): void } }
    const hasActivePanelChange = typeof activePanelApi.onDidActivePanelChange === 'function'
    const syncMaximizedResizeState = () => {
      const hasMaximizedGroup = event.api.hasMaximizedGroup()
      clearResizeInteraction({ clearHandles: hasMaximizedGroup })
      if (!hasMaximizedGroup && isDockElementMeasurable(dockRef.current)) refreshResizeHandles(event.api)
      // See handleTerminalReady: force a layout pass before pane recovery.
      requestAnimationFrame(() => layoutDockview(event.api))
      scheduleTerminalDockLayout()
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
    }

    if (hasActivePanelChange) activePanelApi.onDidActivePanelChange(updateActivePaneId)
    event.api.onDidMaximizedGroupChange(syncMaximizedResizeState)
    updateActivePaneId()
    event.api.onDidAddPanel(syncChromeState)
    event.api.onDidRemovePanel(syncChromeState)
    if (hasActivePanelChange) activePanelApi.onDidActivePanelChange(syncChromeState)
    event.api.onDidLayoutFromJSON(syncChromeState)
    syncChromeState()
    onApiReady?.(event.api)
    event.api.onDidLayoutChange(() => {
      syncChromeState()
      if (!isDockElementMeasurable(dockRef.current)) return
      scheduleLayoutReflow()
      refreshResizeHandles(event.api)
      scheduleTerminalDockLayout()
      persistLayoutSoon()
      if (!hasActivePanelChange) updateActivePaneId()
    })
    event.api.onDidRemovePanel((panel: IDockviewPanel) => {
      if (suppressPanelRemovalRef.current) return
      if (!useWorkspaceStore.getState().panes[panel.id]) {
        // Closing a workspace window (Agent/Kanban/...) resizes and can
        // re-host the terminal window, and dockview's own overlay reposition
        // can read half-transition geometry. Force the OUTER layout first,
        // then — a frame later, once the overlay has followed — re-layout the
        // inner dock against the corrected host and recover pane content.
        // Sequencing matters: scheduling both in the same frame would measure
        // the terminal dock against the stale pre-close overlay size.
        requestAnimationFrame(() => {
          layoutDockview(event.api)
          // scheduleTerminalDockLayout defers one more frame internally, so
          // the inner dock measures the post-layout overlay, not this frame's.
          requestAnimationFrame(() => {
            scheduleTerminalDockLayout()
            reflowTerminalsAfterLayout({ syncPty: true, recover: true })
          })
        })
        persistLayoutSoon()
        return
      }
      TerminalManager.dispose(panel.id)
      void closePaneInStore(panel.id)
      scheduleLayoutReflow()
    })
    loadedSessionRef.current = null
    loadedPageRef.current = null
    loadActiveSessionLayout()
  }, [clearResizeInteraction, closePaneInStore, layoutDockview, loadActiveSessionLayout, onApiReady, persistLayoutSoon, refreshResizeHandles, scheduleLayoutReflow, scheduleTerminalDockLayout, setActivePaneFromApis, syncChromeState])

  useEffect(() => {
    loadActiveSessionLayout()
  }, [activeLayoutPage?.layoutJson, activeLayoutPageId, activeSessionId, loadActiveSessionLayout])

  useEffect(() => {
    if (!activeSessionId || !activeLayoutPage || activeLayoutPage.layoutJson !== null) return
    if (loadedSessionRef.current !== activeSessionId || loadedPageRef.current !== activeLayoutPage.id) return
    const reloadKey = `${activeSessionId}:${activeLayoutPage.id}:${activeLayoutPage.updatedAt}`
    if (nullLayoutReloadRef.current === reloadKey) return
    nullLayoutReloadRef.current = reloadKey
    loadedSessionRef.current = null
    loadedPageRef.current = null
    loadActiveSessionLayout()
  }, [activeLayoutPage, activeSessionId, loadActiveSessionLayout])

  useEffect(() => {
    if (suppressPanelRemovalRef.current) return
    if (apiRef.current && activeSessionId && apiRef.current.totalPanels === 0 && paneList.length > 0) {
      loadedSessionRef.current = null
      loadActiveSessionLayout()
    }
  }, [activeSessionId, loadActiveSessionLayout, paneList.length])

  useEffect(() => {
    if (!activeSessionId || loadedSessionRef.current !== activeSessionId || loadedPageRef.current !== activeLayoutPageId || suppressPanelRemovalRef.current) return
    if (paneList.length === 0) return
    if (!apiRef.current?.getPanel(workspaceWindowDescriptors.terminal.panelId)) return
    const api = terminalApiRef.current
    if (!api) {
      requestAnimationFrame(() => loadTerminalPaneLayout())
      return
    }
    const missingPanes = paneList.filter((pane) => !api.getPanel(pane.id))
    if (missingPanes.length === 0) return
    void withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      let referencePanel = api.activePanel?.id
      for (const pane of missingPanes) {
        addTerminalPanel(api, pane, referencePanel ? { referencePanel, direction: 'right', inactive: true } : undefined)
        referencePanel = pane.id
      }
      layoutTerminalDockview(api)
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      persistLayoutSoon()
    })
  }, [activeLayoutPageId, activeSessionId, addTerminalPanel, layoutTerminalDockview, loadTerminalPaneLayout, persistLayoutSoon, paneList])

  useEffect(() => {
    const api = terminalApiRef.current
    if (!api || suppressPanelRemovalRef.current) return
    const livePaneIds = new Set(paneList.map((pane) => pane.id))
    TerminalManager.pruneStale(livePaneIds)
    const orphanPanels = api.panels.filter((panel) => !livePaneIds.has(panel.id))
    if (orphanPanels.length === 0) return
    void withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      for (const panel of orphanPanels) {
        TerminalManager.dispose(panel.id)
        panel.api.close()
      }
      if (paneList.length === 0) {
        pendingTerminalLayoutRef.current = null
        loadedTerminalPageRef.current = null
      }
      layoutTerminalDockview(api)
      reflowTerminalsAfterLayout({ syncPty: true, recover: true })
      persistLayoutSoon()
    })
  }, [layoutTerminalDockview, persistLayoutSoon, paneList])

  useEffect(() => {
    const dock = dockRef.current
    if (!dock) return

    let frame: number | undefined
    const syncVisibleLayout = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        frame = undefined
        const api = apiRef.current
        if (!api || !isDockElementMeasurable(dock)) return
        if (activeSessionId && (loadedSessionRef.current !== activeSessionId || loadedPageRef.current !== activeLayoutPageId)) loadActiveSessionLayout()
        else {
          layoutDockview(api)
          scheduleTerminalDockLayout()
        }
      })
    }

    const observer = new ResizeObserver(syncVisibleLayout)
    observer.observe(dock)
    syncVisibleLayout()

    return () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [activeLayoutPageId, activeSessionId, layoutDockview, loadActiveSessionLayout, scheduleTerminalDockLayout])

  useEffect(() => {
    if (!arrangeRequestId || applyingArrangeRequestRef.current === arrangeRequestId) return
    applyingArrangeRequestRef.current = arrangeRequestId
    void arrangePanes().finally(() => {
      applyingArrangeRequestRef.current = null
    })
  }, [arrangePanes, arrangeRequestId])

  useEffect(() => {
    if (!windowRequest || applyingWindowRequestRef.current === windowRequest.requestId) return
    applyingWindowRequestRef.current = windowRequest.requestId
    void openWorkspaceWindow(windowRequest.kind, windowRequest.profileId).finally(() => {
      applyingWindowRequestRef.current = null
    })
  }, [openWorkspaceWindow, windowRequest])

  useEffect(() => {
    if (!saveLayoutRequestId || applyingSaveRequestRef.current === saveLayoutRequestId) return
    applyingSaveRequestRef.current = saveLayoutRequestId
    void saveCurrentPageLayout().finally(() => {
      applyingSaveRequestRef.current = null
    })
  }, [saveCurrentPageLayout, saveLayoutRequestId])

  useEffect(() => {
    const setResizeMode = (single: boolean) => {
      const mode = single ? 'single' : 'connected'
      const dock = dockRef.current
      if (dock && dock.dataset.resizeMode !== mode) dock.dataset.resizeMode = mode
      const terminalDock = terminalDockRef.current
      if (terminalDock && terminalDock.dataset.resizeMode !== mode) terminalDock.dataset.resizeMode = mode
    }
    const refreshHoveredPreview = (ctrlKey: boolean) => {
      const hovered = resizeHoverRef.current
      if (hovered && !resizeDragRef.current) {
        const pointer = { ...hovered.pointer, ctrlKey }
        resizeHoverRef.current = { ...hovered, pointer }
        showResizePreview(pointer, hovered.handle)
      }
      const terminalHovered = terminalResizeHoverRef.current
      if (terminalHovered && !terminalResizeDragRef.current) {
        const pointer = { ...terminalHovered.pointer, ctrlKey }
        terminalResizeHoverRef.current = { ...terminalHovered, pointer }
        showTerminalResizePreview(pointer, terminalHovered.handle)
      }
    }
    const syncCtrlMode = (event: KeyboardEvent) => {
      setResizeMode(event.ctrlKey)
      refreshHoveredPreview(event.ctrlKey)
    }
    const resetCtrlMode = () => {
      setResizeMode(false)
      refreshHoveredPreview(false)
    }
    window.addEventListener('keydown', syncCtrlMode, { capture: true })
    window.addEventListener('keyup', syncCtrlMode, { capture: true })
    window.addEventListener('blur', resetCtrlMode)
    return () => {
      window.removeEventListener('keydown', syncCtrlMode, { capture: true })
      window.removeEventListener('keyup', syncCtrlMode, { capture: true })
      window.removeEventListener('blur', resetCtrlMode)
    }
  }, [showResizePreview, showTerminalResizePreview])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const topActivePanelId = apiRef.current?.activePanel?.id
      const nestedActivePaneId = terminalApiRef.current?.activePanel?.id
      const activePanelId = topActivePanelId === workspaceWindowDescriptors.terminal.panelId && nestedActivePaneId
        ? nestedActivePaneId
        : topActivePanelId
      if (!activePanelId) return
      const resizeDirection = resizeDirectionFromKeyboardEvent(event)
      if (resizeDirection) {
        event.preventDefault()
        event.stopPropagation()
        resizeActivePaneByKeyboard(activePanelId, resizeDirection)
        return
      }
      handleCapturedKeybindingEvent(
        settings.keybindings,
        event,
        (action) => runKeybindingAction(action, activePanelId),
        (action) => isWorkspaceKeybindingAction(action) && (!isTerminalCopyAction(action) || TerminalManager.containsEventTarget(activePanelId, event.target)),
      )
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [resizeActivePaneByKeyboard, runKeybindingAction, settings.keybindings])

  useEffect(() => {
    const api = terminalApiRef.current
    if (!api) return
    for (const pane of Object.values(panes)) {
      const title = pane.config.title ?? 'Shell'
      const panel = api.getPanel(pane.id)
      if (panel && panel.api.title !== title) panel.api.setTitle(title)
    }
  }, [panes])

  useEffect(() => {
    if (!pendingTemplate || pendingTemplate.sessionId !== activeSessionId) return
    if (applyingTemplateRequestRef.current === pendingTemplate.requestId) return
    const template = pendingTemplate.templateId
      ? TEMPLATES.find((item) => item.id === pendingTemplate.templateId)
      : { id: `${pendingTemplate.cols}x${pendingTemplate.rows}`, label: `${pendingTemplate.cols}x${pendingTemplate.rows}`, cols: pendingTemplate.cols, rows: pendingTemplate.rows }
    if (!template || pendingTemplate.cols <= 0 || pendingTemplate.rows <= 0) {
      onTemplateApplied?.(pendingTemplate.requestId)
      return
    }
    applyingTemplateRequestRef.current = pendingTemplate.requestId
    void applyTemplate(template, pendingTemplate.profileId, pendingTemplate.occupiedGrid).finally(() => {
      applyingTemplateRequestRef.current = null
      onTemplateApplied?.(pendingTemplate.requestId)
    })
  }, [activeSessionId, applyTemplate, onTemplateApplied, pendingTemplate])

  return (
    <WorkspaceActionsContext.Provider value={paneActions}>
      <WorkspaceWindowActionsContext.Provider value={windowActions}>
        <TerminalWindowContext.Provider value={terminalWindowBridge}>
          <section className="workspace-view">
            <div ref={dockRef} className="dockview-theme-awt workspace-dock" data-resize-mode="connected" data-single-window={isSingleWindow ? 'true' : undefined} onPointerDownCapture={activatePaneFromTarget} onMouseDownCapture={activatePaneFromTarget}>
              <DockviewReact
                components={components}
                onReady={handleReady}
                defaultRenderer="always"
                defaultTabComponent={WorkspaceWindowTab}
                disableDnd
              />
              <ConnectedResizeLayer
                handles={resizeHandles}
                previewStore={workspacePreviewStore}
                onPreview={previewResizeHandle}
                onClear={clearResizePreview}
                onStart={startConnectedResize}
              />
            </div>
          </section>
        </TerminalWindowContext.Provider>
      </WorkspaceWindowActionsContext.Provider>
    </WorkspaceActionsContext.Provider>
  )
}

async function waitForDockviewApi(ref: { current: DockviewApi | null }, attempts = 8): Promise<DockviewApi | null> {
  for (let index = 0; index < attempts; index += 1) {
    if (ref.current) return ref.current
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }
  return ref.current
}

function ConnectedResizeLayer({
  handles,
  previewStore,
  onPreview,
  onClear,
  onStart,
}: {
  handles: ResizeHandleSets
  previewStore: ResizePreviewStore
  onPreview: (event: ResizePointer, handle: ConnectedResizeHandle) => void
  onClear: () => void
  onStart: (event: ReactPointerEvent, handle: ConnectedResizeHandle) => void
}) {
  const preview = useResizePreview(previewStore)
  return (
    <div className="connected-resize-layer" aria-hidden="true">
      {handles.connected.map((handle) => (
        <button
          key={handle.id}
          type="button"
          className={`connected-resize-handle connected-resize-handle-${handle.axis} connected-resize-handle-connected`}
          style={resizeHandleStyle(handle, RESIZE_HANDLE_HIT_SIZE)}
          tabIndex={-1}
          onPointerEnter={(event) => onPreview(event, handle)}
          onPointerMove={(event) => onPreview(event, handle)}
          onPointerLeave={onClear}
          onPointerDown={(event) => onStart(event, handle)}
        />
      ))}
      {handles.single.map((handle) => (
        <button
          key={handle.id}
          type="button"
          className={`connected-resize-handle connected-resize-handle-${handle.axis} connected-resize-handle-single`}
          style={resizeHandleStyle(handle, RESIZE_HANDLE_HIT_SIZE)}
          tabIndex={-1}
          onPointerEnter={(event) => onPreview(event, handle)}
          onPointerMove={(event) => onPreview(event, handle)}
          onPointerLeave={onClear}
          onPointerDown={(event) => onStart(event, handle)}
        />
      ))}
      {preview ? (
        <>
          <div
            className={`connected-resize-preview connected-resize-preview-${preview.axis} connected-resize-preview-${preview.mode} ${preview.snapped ? 'connected-resize-preview-raw' : ''}`}
            style={resizePreviewStyle(preview, 2, preview.snapped ? preview.rawDelta : preview.delta)}
          />
          {preview.snapped ? (
            <div
              className={`connected-resize-preview connected-resize-preview-${preview.axis} connected-resize-preview-${preview.mode} connected-resize-preview-snap-target`}
              style={resizePreviewStyle(preview, 6, preview.delta)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  )
}

function resizeDirectionFromKeyboardEvent(event: KeyboardEvent): ResizeDirection | null {
  if (!event.altKey || !event.ctrlKey || event.shiftKey || event.metaKey) return null
  if (event.key === 'ArrowLeft') return 'left'
  if (event.key === 'ArrowRight') return 'right'
  if (event.key === 'ArrowUp') return 'up'
  if (event.key === 'ArrowDown') return 'down'
  return null
}

function paneToGridDescriptor(pane: PaneMeta): GridPaneDescriptor {
  return {
    id: pane.id,
    title: pane.config.title ?? 'Shell',
    icon: pane.config.icon ?? undefined,
  }
}

function buildFallbackTerminalLayout(api: DockviewApi, panels: PaneMeta[]): void {
  if (panels.length === 0) return
  const grid = exactTemplateGridForPaneCount(panels.length, 1) ?? balancedGridForPaneCount(panels.length, 1)
  const layout = createDockviewGridLayout({}, grid, panels.map(paneToGridDescriptor), [], panels[0]?.id)
  if (layout) {
    api.fromJSON(layout as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
    return
  }
  let previous: string | undefined
  for (const pane of panels) {
    api.addPanel({
      id: pane.id,
      component: 'terminal',
      title: pane.config.title ?? 'Shell',
      params: { kind: 'terminal', paneId: pane.id, title: pane.config.title ?? 'Shell', icon: pane.config.icon ?? undefined },
      renderer: 'always',
      inactive: Boolean(previous),
      position: previous ? { referencePanel: previous, direction: 'right' } : undefined,
    })
    previous = pane.id
  }
}

function resizeHandleSetsEqual(a: ResizeHandleSets, b: ResizeHandleSets): boolean {
  return resizeHandlesEqual(a.connected, b.connected) && resizeHandlesEqual(a.single, b.single)
}

function resizeHandlesEqual(a: ConnectedResizeHandle[], b: ConnectedResizeHandle[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (
      left.id !== right.id
      || left.axis !== right.axis
      || left.coordinate !== right.coordinate
      || left.start !== right.start
      || left.end !== right.end
    ) {
      return false
    }
  }
  return true
}

function measurableDockRect(element: HTMLElement | null): DOMRect | null {
  if (!isDockElementMeasurable(element)) return null
  return element.getBoundingClientRect()
}

function isDockElementMeasurable(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.offsetParent === null) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

/** dockview overlay containers (defaultRenderer "always") only reposition on
 *  per-panel dimension events, which never fire for groups whose size
 *  survived an api.layout() pass — leaving their overlays stuck at stale
 *  rects. Force a full reposition through the component's private
 *  OverlayRenderContainer; narrowed step-by-step so a dockview internals
 *  change degrades to a no-op instead of a crash. */
function forceOverlayReposition(api: DockviewApi): void {
  const holder: unknown = api
  if (!holder || typeof holder !== 'object' || !('component' in holder)) return
  const component = holder.component
  if (!component || typeof component !== 'object' || !('overlayRenderContainer' in component)) return
  const container = component.overlayRenderContainer
  if (!container || typeof container !== 'object' || !('updateAllPositions' in container)) return
  if (typeof container.updateAllPositions !== 'function') return
  container.updateAllPositions()
}

let terminalLayoutReflowFrame: number | undefined
let terminalLayoutReflowSyncPty = false
let terminalLayoutReflowRecover = false

function reflowTerminalsAfterLayout(options: { syncPty?: boolean; recover?: boolean } = {}): void {
  terminalLayoutReflowSyncPty = terminalLayoutReflowSyncPty || options.syncPty === true
  terminalLayoutReflowRecover = terminalLayoutReflowRecover || options.recover === true
  if (terminalLayoutReflowFrame !== undefined) cancelAnimationFrame(terminalLayoutReflowFrame)
  terminalLayoutReflowFrame = requestAnimationFrame(() => {
    terminalLayoutReflowFrame = requestAnimationFrame(() => {
      terminalLayoutReflowFrame = undefined
      const syncPty = terminalLayoutReflowSyncPty
      const recover = terminalLayoutReflowRecover
      terminalLayoutReflowSyncPty = false
      terminalLayoutReflowRecover = false
      TerminalManager.reflowAll(true)
      if (syncPty) TerminalManager.syncAllPtySizes()
      // reflowAll never clears the WebGL glyph atlas; after dockview
      // maximize/restore that leaves stale textures until a pane is clicked.
      if (recover) TerminalManager.recoverAllVisiblePanes()
    })
  })
}

function resizeHandleStyle(handle: ConnectedResizeHandle, hitAreaSize: number): CSSProperties {
  const hitAreaOffset = hitAreaSize / 2
  return handle.axis === 'x'
    ? {
      left: `${handle.coordinate - hitAreaOffset}px`,
      top: `${handle.start}px`,
      height: `${Math.max(0, handle.end - handle.start)}px`,
      width: `${hitAreaSize}px`,
    }
    : {
      left: `${handle.start}px`,
      top: `${handle.coordinate - hitAreaOffset}px`,
      width: `${Math.max(0, handle.end - handle.start)}px`,
      height: `${hitAreaSize}px`,
    }
}

function isSingleResizeHandle(handle: ConnectedResizeHandle): boolean {
  return handle.id.startsWith('single:')
}

function resizePreviewStyle(preview: ResizePreview, thickness: number, delta = preview.delta): CSSProperties {
  const coordinate = preview.coordinate + delta
  const offset = thickness / 2
  return preview.axis === 'x'
    ? {
      left: `${coordinate - offset}px`,
      top: `${preview.start}px`,
      height: `${Math.max(0, preview.end - preview.start)}px`,
      width: `${thickness}px`,
    }
    : {
      left: `${preview.start}px`,
      top: `${coordinate - offset}px`,
      width: `${Math.max(0, preview.end - preview.start)}px`,
      height: `${thickness}px`,
    }
}

function nextPaneAfterClose(api: DockviewApi, paneId: string): string | undefined {
  const closingPanel = api.getPanel(paneId)
  const candidates = api.panels.filter((panel) => panel.id !== paneId)
  if (candidates.length === 0) return undefined

  if (closingPanel) {
    const groupPanels = closingPanel.group.panels
    const groupIndex = groupPanels.findIndex((panel) => panel.id === paneId)
    const sameGroupCandidates = groupPanels.filter((panel) => panel.id !== paneId)
    if (sameGroupCandidates.length > 0) {
      const targetIndex = groupIndex < 0 ? 0 : Math.min(groupIndex, sameGroupCandidates.length - 1)
      return sameGroupCandidates[targetIndex]?.id
    }
  }

  const closingRect = getPaneRect(paneId)
  if (!closingRect) return candidates[0]?.id

  let best: { id: string; score: number } | null = null
  for (const candidate of candidates) {
    const rect = getPaneRect(candidate.id)
    if (!rect) continue
    const score = closeFocusScore(closingRect, rect)
    if (!best || score < best.score) best = { id: candidate.id, score }
  }
  return best?.id ?? candidates[0]?.id
}

function closeFocusScore(closing: DOMRect, candidate: DOMRect): number {
  const horizontalGap = candidate.left > closing.right
    ? candidate.left - closing.right
    : closing.left > candidate.right
      ? closing.left - candidate.right
      : 0
  const verticalGap = candidate.top > closing.bottom
    ? candidate.top - closing.bottom
    : closing.top > candidate.bottom
      ? closing.top - candidate.bottom
      : 0
  const closingCenterX = closing.left + closing.width / 2
  const closingCenterY = closing.top + closing.height / 2
  const candidateCenterX = candidate.left + candidate.width / 2
  const candidateCenterY = candidate.top + candidate.height / 2
  const centerDistance = Math.abs(closingCenterX - candidateCenterX) + Math.abs(closingCenterY - candidateCenterY)
  return (horizontalGap + verticalGap) * 1_000_000 + centerDistance
}

function isWorkspaceKeybindingAction(action: KeybindingActionId): boolean {
  return action !== 'captureImage' && action !== 'captureVideo'
}

function isTerminalCopyAction(action: KeybindingActionId): boolean {
  return action === 'copyTerminalContents' || action === 'copyTerminalSelection'
}

function shouldRestoreWorkspaceDockviewLayout(layoutJson: string, livePaneIds: string[]): boolean {
  let layout: unknown
  try {
    layout = JSON.parse(layoutJson)
  } catch {
    return false
  }
  if (!isRecord(layout) || !isRecord(layout.grid) || !isRecord(layout.panels)) return false
  if (!isPositiveNumber(layout.grid.width) || !isPositiveNumber(layout.grid.height)) return false
  const viewIds = new Set<string>()
  if (!collectRestorableViewIds(layout.grid.root, viewIds)) return false
  if (viewIds.size === 0) return false

  const livePaneIdSet = new Set(livePaneIds)
  const singletonIds = new Set(Object.values(workspaceWindowDescriptors).filter((descriptor) => descriptor.singleton).map((descriptor) => descriptor.panelId))
  for (const viewId of viewIds) {
    const panel = layout.panels[viewId]
    if (!isRecord(panel)) return false
    const contentComponent = typeof panel.contentComponent === 'string' ? panel.contentComponent : ''
    if (contentComponent === 'terminal' || livePaneIdSet.has(viewId)) {
      if (!livePaneIdSet.has(viewId)) return false
    } else if (!singletonIds.has(viewId)) {
      return false
    }
  }
  return true
}

function splitStoredWorkspaceLayout(layoutJson: string): { topLayout: unknown; terminalLayout: unknown | null } | null {
  let layout: unknown
  try {
    layout = JSON.parse(layoutJson)
  } catch {
    return null
  }
  if (!isRecord(layout)) return null
  const terminalLayout = isRecord(layout.awtTerminalLayout) ? layout.awtTerminalLayout : extractTopLevelTerminalLayout(layout)
  const topLayout = terminalLayout === layout ? makeDefaultWindowLayout(true) : stripTopLevelTerminalPanels(layout)
  return { topLayout, terminalLayout }
}

function extractTopLevelTerminalLayout(layout: Record<string, unknown>): unknown | null {
  if (!isRecord(layout.panels)) return null
  for (const value of Object.values(layout.panels)) {
    if (!isRecord(value)) continue
    if (value.contentComponent === 'terminal') return layout
  }
  return null
}

function stripTopLevelTerminalPanels(layout: Record<string, unknown>): unknown {
  if (!isRecord(layout.panels)) return layout
  const cloned = structuredClone(layout) as Record<string, unknown>
  delete cloned.awtTerminalLayout
  if (!isRecord(cloned.panels)) return cloned
  const terminalPanelIds = new Set<string>()
  for (const [panelId, value] of Object.entries(cloned.panels)) {
    if (isRecord(value) && value.contentComponent === 'terminal') terminalPanelIds.add(panelId)
  }
  if (terminalPanelIds.size === 0) return cloned
  for (const panelId of terminalPanelIds) delete cloned.panels[panelId]
  removePanelIdsFromDockNode(cloned.grid, terminalPanelIds)
  return cloned
}

function removePanelIdsFromDockNode(value: unknown, panelIds: Set<string>): boolean {
  if (!isRecord(value)) return false
  if (value.type === 'leaf' && isRecord(value.data) && Array.isArray(value.data.views)) {
    const data = value.data as Record<string, unknown> & { views: unknown[] }
    data.views = data.views.filter((view) => typeof view !== 'string' || !panelIds.has(view))
    if (typeof data.activeView === 'string' && panelIds.has(data.activeView)) data.activeView = data.views[0]
    return data.views.length > 0
  }
  if (value.type === 'branch' && Array.isArray(value.data)) {
    const children = value.data.filter((child) => removePanelIdsFromDockNode(child, panelIds))
    value.data = children
    return children.length > 0
  }
  if (isRecord(value.root)) return removePanelIdsFromDockNode(value.root, panelIds)
  return true
}

function makeDefaultWindowLayout(includeTerminal: boolean): unknown {
  const panels: Record<string, unknown> = {}
  const leaves: unknown[] = []
  if (includeTerminal) {
    const terminal = workspaceWindowDescriptors.terminal
    panels[terminal.panelId] = makeWindowPanel(terminal)
    leaves.push(makeWindowNode(terminal.panelId, 700))
  }
  const agent = workspaceWindowDescriptors.agent
  panels[agent.panelId] = makeWindowPanel(agent)
  leaves.push(makeWindowNode(agent.panelId, includeTerminal ? 300 : 1000))
  return {
    grid: {
      root: { type: 'branch', data: leaves, size: 1000 },
      width: 1000,
      height: 600,
      orientation: 'HORIZONTAL',
    },
    panels,
    activeGroup: includeTerminal ? `window-${workspaceWindowDescriptors.terminal.panelId}` : `window-${agent.panelId}`,
  }
}

function makeWindowPanel(descriptor: typeof workspaceWindowDescriptors[keyof typeof workspaceWindowDescriptors]): unknown {
  return {
    id: descriptor.panelId,
    contentComponent: descriptor.component,
    tabComponent: 'props.defaultTabComponent',
    params: { kind: descriptor.kind, title: descriptor.title, icon: descriptor.icon },
    title: descriptor.title,
    renderer: 'always',
  }
}

function makeWindowNode(panelId: string, size: number): unknown {
  return {
    type: 'leaf',
    data: { views: [panelId], activeView: panelId, id: `window-${panelId}` },
    size,
  }
}

function collectRestorableViewIds(node: unknown, viewIds: Set<string>): boolean {
  if (!isRecord(node) || !isPositiveNumber(node.size)) return false
  if (node.type === 'leaf') {
    const data = node.data
    if (!isRecord(data) || !Array.isArray(data.views) || data.views.length === 0) return false
    for (const view of data.views) {
      if (typeof view === 'string') viewIds.add(view)
    }
    return true
  }
  if (node.type !== 'branch' || !Array.isArray(node.data) || node.data.length === 0) return false
  return node.data.every((child) => collectRestorableViewIds(child, viewIds))
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function windowPanelIdFromEventTarget(target: EventTarget | null): string | null {
  const closest = (target as { closest?: (selector: string) => Element | null } | null)?.closest
  const panel = typeof closest === 'function' ? closest.call(target, '[data-window-panel-id]') : null
  return panel instanceof HTMLElement ? panel.dataset.windowPanelId ?? null : null
}

function exactTemplateGridForPaneCount(paneCount: number, aspectRatio: number): GridSize | null {
  const candidates = TEMPLATES.filter((template) => template.cols * template.rows === paneCount)
  if (candidates.length === 0) return null
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1
  const best = candidates.reduce((current, candidate) => {
    const currentScore = Math.abs(current.cols / current.rows - safeAspectRatio)
    const candidateScore = Math.abs(candidate.cols / candidate.rows - safeAspectRatio)
    return candidateScore < currentScore ? candidate : current
  })
  return { cols: best.cols, rows: best.rows }
}

function getPaneRect(paneId: string): DOMRect | null {
  return document.querySelector<HTMLElement>(`[data-window-panel-id="${paneId}"], [data-pane-id="${paneId}"]`)?.getBoundingClientRect() ?? null
}

function isInDirection(active: DOMRect, candidate: DOMRect, direction: 'left' | 'right' | 'up' | 'down'): boolean {
  if (direction === 'left') return candidate.right <= active.left
  if (direction === 'right') return candidate.left >= active.right
  if (direction === 'up') return candidate.bottom <= active.top
  return candidate.top >= active.bottom
}

function directionalDistance(active: DOMRect, candidate: DOMRect, direction: 'left' | 'right' | 'up' | 'down'): number {
  const activeCenterX = active.left + active.width / 2
  const activeCenterY = active.top + active.height / 2
  const candidateCenterX = candidate.left + candidate.width / 2
  const candidateCenterY = candidate.top + candidate.height / 2
  const primary = direction === 'left'
    ? active.left - candidate.right
    : direction === 'right'
      ? candidate.left - active.right
      : direction === 'up'
        ? active.top - candidate.bottom
        : candidate.top - active.bottom
  const secondary = direction === 'left' || direction === 'right'
    ? Math.abs(activeCenterY - candidateCenterY)
    : Math.abs(activeCenterX - candidateCenterX)
  return primary * 10000 + secondary
}

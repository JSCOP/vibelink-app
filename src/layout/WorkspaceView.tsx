import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanel } from 'dockview-react'
import { TerminalTab } from '../components/TerminalTab'
import { TerminalManager } from '../terminal/TerminalManager'
import { useWorkspaceStore } from '../state/store'
import { profileById } from '../state/profiles'
import { handleCapturedKeybindingEvent, type KeybindingActionId } from '../state/keybindings'
import type { PaneMeta } from '../ipc/types'
import { PlaceholderPanel, TerminalPanePanel } from './TerminalPanePanel'
import { type SplitDirection, WorkspaceActionsContext } from './actions'
import { TEMPLATES, type GridTemplate } from './templates'
import { balancedGridForPaneCount, planTemplateReconcile, type GridSize } from './templatePlan'
import { withSuppressedPanelRemoval } from './suppression'
import { shouldRestoreDockviewLayout } from './layoutRestore'
import { paneIdFromEventTarget } from './paneActivation'
import { swapPanelIdsInDockviewLayout } from './paneSwap'
import type { PaneDropPosition } from './paneDrag'
import { connectedResizeDeltaAt, connectedResizeHandles, resizeConnectedBoundaryAt, resizeConnectedBoundaryForPane, resizeSingleBoundaryAt, singleResizeDeltaAt, singleResizeHandleAt, singleResizeHandles, type ConnectedResizeHandle, type ResizeDirection } from './connectedResize'
import { createDockviewGridLayout, type GridPaneDescriptor } from './gridLayout'

type PendingTemplateRequest = {
  sessionId: string
  templateId?: string
  cols: number
  rows: number
  profileId?: string | null
  requestId: number
}

type WorkspaceViewProps = {
  onApiReady?: (api: DockviewApi) => void
  pendingTemplate?: PendingTemplateRequest | null
  arrangeRequestId?: number
  resizeSnapTolerance?: number
  onTemplateApplied?: (requestId: number) => void
}

type ResizePreview = ConnectedResizeHandle & {
  delta: number
  mode: 'connected' | 'single'
  rawDelta?: number
  snapped?: boolean
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
  terminal: TerminalPanePanel,
  placeholder: PlaceholderPanel,
}

const KEYBOARD_RESIZE_STEP = 32
const RESIZE_HANDLE_HIT_SIZE = 36

export function WorkspaceView({ onApiReady, pendingTemplate, arrangeRequestId = 0, resizeSnapTolerance = 32, onTemplateApplied }: WorkspaceViewProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const loadedSessionRef = useRef<string | null>(null)
  const suppressPanelRemovalRef = useRef(false)
  const saveTimerRef = useRef<number | undefined>()
  const dockRef = useRef<HTMLDivElement | null>(null)
  const applyingTemplateRequestRef = useRef<number | null>(null)
  const applyingArrangeRequestRef = useRef<number | null>(null)
  const resizeDragRef = useRef<{ removeListeners: () => void } | null>(null)
  const [resizeHandles, setResizeHandles] = useState<ResizeHandleSets>({ connected: [], single: [] })
  const [resizePreview, setResizePreview] = useState<ResizePreview | null>(null)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const panes = useWorkspaceStore((state) => state.panes)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const closePaneInStore = useWorkspaceStore((state) => state.closePane)
  const saveLayout = useWorkspaceStore((state) => state.saveLayout)
  const deleteSession = useWorkspaceStore((state) => state.deleteSession)
  const settings = useWorkspaceStore((state) => state.settings)
  const renamePaneTitleInStore = useWorkspaceStore((state) => state.renamePaneTitle)

  const paneList = useMemo(() => Object.values(panes), [panes])

  const refreshResizeHandles = useCallback((api: DockviewApi) => {
    const layout = api.toJSON()
    const next = {
      connected: connectedResizeHandles(layout),
      single: singleResizeHandles(layout),
    }
    setResizeHandles((current) => resizeHandleSetsEqual(current, next) ? current : next)
  }, [])

  const persistLayoutSoon = useCallback(() => {
    const api = apiRef.current
    if (!api || !activeSessionId || suppressPanelRemovalRef.current) return
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      const currentApi = apiRef.current
      const currentSessionId = useWorkspaceStore.getState().activeSessionId
      if (!currentApi || !currentSessionId) return
      void saveLayout(currentSessionId, JSON.stringify(currentApi.toJSON()))
    }, 400)
  }, [activeSessionId, saveLayout])

  const layoutDockview = useCallback((api: DockviewApi) => {
    const rect = dockRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    api.layout(Math.floor(rect.width), Math.floor(rect.height), true)
    reflowTerminalsAfterLayout()
    refreshResizeHandles(api)
  }, [refreshResizeHandles])

  const addTerminalPanel = useCallback((api: DockviewApi, pane: PaneMeta, options?: { referencePanel?: string; direction?: SplitDirection | 'within'; inactive?: boolean }) => {
    api.addPanel({
      id: pane.id,
      component: 'terminal',
      title: pane.config.title ?? 'Shell',
      params: { paneId: pane.id, title: pane.config.title ?? 'Shell', icon: pane.config.icon ?? undefined },
      renderer: 'always',
      inactive: options?.inactive,
      position: options?.referencePanel
        ? { referencePanel: options.referencePanel, direction: options.direction ?? 'right' }
        : undefined,
    })
  }, [])

  const buildFallbackLayout = useCallback((api: DockviewApi, panels: PaneMeta[]) => {
    let previous: string | undefined
    for (const pane of panels) {
      addTerminalPanel(api, pane, previous ? { referencePanel: previous, direction: 'right', inactive: true } : undefined)
      previous = pane.id
    }
  }, [addTerminalPanel])

  const applyGridLayout = useCallback((api: DockviewApi, grid: GridSize, gridPanes: PaneMeta[], overflowPanes: PaneMeta[] = []) => {
    const nextLayout = createDockviewGridLayout(
      api.toJSON(),
      grid,
      gridPanes.map(paneToGridDescriptor),
      overflowPanes.map(paneToGridDescriptor),
      api.activePanel?.id,
    )
    if (!nextLayout) return false
    api.fromJSON(nextLayout as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
    return true
  }, [])

  const loadActiveSessionLayout = useCallback(() => {
    const api = apiRef.current
    if (!api || !activeSessionId || loadedSessionRef.current === activeSessionId) return
    suppressPanelRemovalRef.current = true
    try {
      api.clear()
      const currentPanes = Object.values(useWorkspaceStore.getState().panes)
      const paneIds = currentPanes.map((pane) => pane.id)
      const layoutJson = useWorkspaceStore.getState().layoutJson
      if (layoutJson && shouldRestoreDockviewLayout(layoutJson, paneIds)) {
        try {
          api.fromJSON(JSON.parse(layoutJson), { reuseExistingPanels: true })
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
      layoutDockview(api)
      loadedSessionRef.current = activeSessionId
    } finally {
      suppressPanelRemovalRef.current = false
    }
  }, [activeSessionId, buildFallbackLayout, layoutDockview])

  const activatePane = useCallback((paneId: string) => {
    apiRef.current?.getPanel(paneId)?.api.setActive()
  }, [])

  const activatePaneFromTarget = useCallback((event: { target: EventTarget | null }) => {
    const paneId = paneIdFromEventTarget(event.target)
    if (paneId) activatePane(paneId)
  }, [activatePane])

  const splitPane = useCallback(async (paneId: string, direction: SplitDirection) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    activatePane(paneId)
    const pane = await spawnPane(sessionId)
    addTerminalPanel(api, pane, { referencePanel: paneId, direction })
    layoutDockview(api)
    persistLayoutSoon()
  }, [activatePane, addTerminalPanel, layoutDockview, persistLayoutSoon, spawnPane])

  const newTab = useCallback(async (paneId: string) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    activatePane(paneId)
    const pane = await spawnPane(sessionId)
    addTerminalPanel(api, pane, { referencePanel: paneId, direction: 'within' })
    layoutDockview(api)
    persistLayoutSoon()
  }, [activatePane, addTerminalPanel, layoutDockview, persistLayoutSoon, spawnPane])

  const closePane = useCallback(async (paneId: string) => {
    const api = apiRef.current
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

  const toggleMaximize = useCallback((paneId: string) => {
    const panel = apiRef.current?.getPanel(paneId)
    activatePane(paneId)
    if (!panel) return
    if (panel.api.isMaximized()) panel.api.exitMaximized()
    else panel.api.maximize()
  }, [activatePane])

  const renamePaneTitle = useCallback(async (paneId: string, title: string) => {
    await renamePaneTitleInStore(paneId, title, 'manual')
    apiRef.current?.getPanel(paneId)?.api.setTitle(title)
  }, [renamePaneTitleInStore])
  const swapPaneLocations = useCallback(async (sourcePaneId: string, targetPaneId: string) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId || sourcePaneId === targetPaneId) return
    if (!api.getPanel(sourcePaneId) || !api.getPanel(targetPaneId)) return

    const layout = api.toJSON()
    if (!swapPanelIdsInDockviewLayout(layout, sourcePaneId, targetPaneId)) return

    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      api.fromJSON(layout, { reuseExistingPanels: true })
      layoutDockview(api)
      loadedSessionRef.current = sessionId
      const sourcePanel = api.getPanel(sourcePaneId)
      if (sourcePanel) {
        sourcePanel.api.setActive()
        TerminalManager.focus(sourcePaneId)
      }
      await saveLayout(sessionId, JSON.stringify(api.toJSON()))
    })
  }, [layoutDockview, saveLayout])

  const movePaneToPosition = useCallback(async (sourcePaneId: string, targetPaneId: string, position: Exclude<PaneDropPosition, 'center'>) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId || sourcePaneId === targetPaneId) return
    const sourcePanel = api.getPanel(sourcePaneId)
    const targetPanel = api.getPanel(targetPaneId)
    if (!sourcePanel || !targetPanel) return

    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      sourcePanel.api.moveTo({ group: targetPanel.group, position })
      layoutDockview(api)
      loadedSessionRef.current = sessionId
      sourcePanel.api.setActive()
      TerminalManager.focus(sourcePaneId)
      await saveLayout(sessionId, JSON.stringify(api.toJSON()))
    })
  }, [layoutDockview, saveLayout])

  const applyResizedLayout = useCallback(async (nextLayout: unknown) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      api.fromJSON(nextLayout as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
      layoutDockview(api)
      loadedSessionRef.current = sessionId
      await saveLayout(sessionId, JSON.stringify(api.toJSON()))
    })
  }, [layoutDockview, saveLayout])

  const resizeActivePaneByKeyboard = useCallback((paneId: string, direction: ResizeDirection) => {
    const api = apiRef.current
    if (!api) return
    const layout = api.toJSON()
    const nextLayout = resizeConnectedBoundaryForPane(layout, paneId, direction, KEYBOARD_RESIZE_STEP)
    if (!nextLayout) return
    void applyResizedLayout(nextLayout)
  }, [applyResizedLayout])

  const resizeHandleForPointer = useCallback((event: ResizePointer, handle: ConnectedResizeHandle, layout: unknown): ConnectedResizeHandle => {
    if (isSingleResizeHandle(handle)) return handle
    if (!event.ctrlKey) return handle
    const dockRect = dockRef.current?.getBoundingClientRect()
    const point = handle.axis === 'x'
      ? event.clientY - (dockRect?.top ?? 0)
      : event.clientX - (dockRect?.left ?? 0)
    return singleResizeHandleAt(layout, handle.axis, handle.coordinate, point) ?? handle
  }, [])

  const previewResizeHandle = useCallback((event: ResizePointer, handle: ConnectedResizeHandle) => {
    if (resizeDragRef.current) return
    const api = apiRef.current
    if (!api) return
    const previewHandle = resizeHandleForPointer(event, handle, api.toJSON())
    setResizePreview({ ...previewHandle, delta: 0, mode: isSingleResizeHandle(previewHandle) ? 'single' : 'connected' })
  }, [resizeHandleForPointer])

  const clearResizePreview = useCallback(() => {
    if (!resizeDragRef.current) setResizePreview(null)
  }, [])

  const startConnectedResize = useCallback((event: ReactPointerEvent, handle: ConnectedResizeHandle) => {
    const api = apiRef.current
    if (!api) return
    event.preventDefault()
    event.stopPropagation()

    resizeDragRef.current?.removeListeners()
    const dockRect = dockRef.current?.getBoundingClientRect()
    const startLayout = api.toJSON()
    const previewHandle = resizeHandleForPointer(event, handle, startLayout)
    const singleSegment = event.ctrlKey || isSingleResizeHandle(previewHandle)
    const startPoint = previewHandle.axis === 'x' ? event.clientX : event.clientY
    const segmentPoint = previewHandle.axis === 'x'
      ? event.clientY - (dockRect?.top ?? 0)
      : event.clientX - (dockRect?.left ?? 0)
    let latestLayout: unknown | null = null

    setResizePreview({ ...previewHandle, delta: 0, mode: singleSegment ? 'single' : 'connected' })

    const onPointerMove = (moveEvent: PointerEvent) => {
      const currentPoint = previewHandle.axis === 'x' ? moveEvent.clientX : moveEvent.clientY
      const rawDelta = currentPoint - startPoint
      const delta = singleSegment
        ? singleResizeDeltaAt(startLayout, previewHandle.axis, previewHandle.coordinate, segmentPoint, rawDelta, undefined, resizeSnapTolerance) ?? 0
        : connectedResizeDeltaAt(startLayout, previewHandle.axis, previewHandle.coordinate, previewHandle.start, previewHandle.end, rawDelta) ?? 0

      const snapped = singleSegment && Math.abs(delta - rawDelta) > 2
      setResizePreview({ ...previewHandle, delta, rawDelta, mode: singleSegment ? 'single' : 'connected', snapped })
      latestLayout = Math.abs(delta) >= 1
        ? singleSegment
          ? resizeSingleBoundaryAt(startLayout, previewHandle.axis, previewHandle.coordinate, segmentPoint, delta, undefined, resizeSnapTolerance)
          : resizeConnectedBoundaryAt(startLayout, previewHandle.axis, previewHandle.coordinate, previewHandle.start, previewHandle.end, delta)
        : null
    }

    const onPointerUp = () => {
      const nextLayout = latestLayout
      resizeDragRef.current?.removeListeners()
      resizeDragRef.current = null
      setResizePreview(null)
      if (!nextLayout) return
      const sessionId = useWorkspaceStore.getState().activeSessionId
      if (!sessionId) return
      void withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
        api.fromJSON(nextLayout as Parameters<DockviewApi['fromJSON']>[0], { reuseExistingPanels: true })
        layoutDockview(api)
        loadedSessionRef.current = sessionId
        await saveLayout(sessionId, JSON.stringify(api.toJSON()))
      })
    }

    const removeListeners = () => {
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      window.removeEventListener('pointercancel', onPointerUp)
    }
    resizeDragRef.current = { removeListeners }
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
    window.addEventListener('pointercancel', onPointerUp)
  }, [layoutDockview, resizeHandleForPointer, resizeSnapTolerance, saveLayout])


  const closeWorkspace = useCallback(async () => {
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!sessionId) return
    const api = apiRef.current
    if (api) {
      await saveLayout(sessionId, JSON.stringify(api.toJSON()))
    }
    await deleteSession(sessionId)
  }, [deleteSession, saveLayout])

  const focusPane = useCallback((direction: 'left' | 'right' | 'up' | 'down') => {
    const api = apiRef.current
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

  const arrangePanes = useCallback(async () => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    const currentPanes = Object.values(useWorkspaceStore.getState().panes)
    if (currentPanes.length === 0) return
    const rect = dockRef.current?.getBoundingClientRect()
    const aspectRatio = rect && rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1
    const grid = exactTemplateGridForPaneCount(currentPanes.length, aspectRatio) ?? balancedGridForPaneCount(currentPanes.length, aspectRatio)
    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      applyGridLayout(api, grid, currentPanes)
      layoutDockview(api)
      loadedSessionRef.current = sessionId
      await saveLayout(sessionId, JSON.stringify(api.toJSON()))
    })
  }, [applyGridLayout, layoutDockview, saveLayout])

  const runKeybindingAction = useCallback((action: KeybindingActionId, activePanelId: string) => {
    const api = apiRef.current
    if (!api) return
    switch (action) {
      case 'splitRight':
        void splitPane(activePanelId, 'right')
        break
      case 'splitDown':
        void splitPane(activePanelId, 'below')
        break
      case 'newTab':
        void newTab(activePanelId)
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
        TerminalManager.copyContentsToClipboard(activePanelId)
        break
      case 'copyTerminalSelection':
        TerminalManager.copySelectionToClipboard(activePanelId)
        break
    }
  }, [arrangePanes, closePane, closeWorkspace, focusPane, newTab, splitPane, toggleMaximize])

  const applyTemplate = useCallback(async (template: GridTemplate, profileId?: string | null) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    const profile = profileById(useWorkspaceStore.getState().settings, profileId)
    const targetPaneCount = template.cols * template.rows
    const existingPanes = Object.values(useWorkspaceStore.getState().panes)
    const initialPlan = planTemplateReconcile(existingPanes.map((pane) => pane.id), targetPaneCount)
    const plannedPanes = [...existingPanes]

    for (let index = 0; index < initialPlan.missingPaneCount; index += 1) {
      const pane = await spawnPane(sessionId, { profileId, title: `${profile.name} ${plannedPanes.length + 1}` })
      plannedPanes.push(pane)
    }

    const paneById = new Map(plannedPanes.map((pane) => [pane.id, pane]))
    const plan = planTemplateReconcile(plannedPanes.map((pane) => pane.id), targetPaneCount)

    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      const gridPanes = plan.gridPaneIds.map((paneId) => paneById.get(paneId)).filter((pane): pane is PaneMeta => pane !== undefined)
      const overflowPanes = plan.overflowPaneIds.map((paneId) => paneById.get(paneId)).filter((pane): pane is PaneMeta => pane !== undefined)
      applyGridLayout(api, template, gridPanes, overflowPanes)

      layoutDockview(api)
      loadedSessionRef.current = sessionId
      await saveLayout(sessionId, JSON.stringify(api.toJSON()))
    })
  }, [applyGridLayout, layoutDockview, saveLayout, spawnPane])


  const actions = useMemo(() => ({ activatePane, splitPane, newTab, closePane, toggleMaximize, renamePaneTitle, swapPaneLocations, movePaneToPosition }), [activatePane, closePane, movePaneToPosition, newTab, renamePaneTitle, splitPane, swapPaneLocations, toggleMaximize])

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    onApiReady?.(event.api)
    event.api.onDidLayoutChange(() => {
      TerminalManager.reflowAll()
      refreshResizeHandles(event.api)
      persistLayoutSoon()
    })
    event.api.onDidRemovePanel((panel: IDockviewPanel) => {
      if (suppressPanelRemovalRef.current) return
      TerminalManager.dispose(panel.id)
      void closePaneInStore(panel.id)
    })
    loadedSessionRef.current = null
    loadActiveSessionLayout()
  }, [closePaneInStore, loadActiveSessionLayout, onApiReady, persistLayoutSoon, refreshResizeHandles])

  useEffect(() => {
    loadedSessionRef.current = null
    loadActiveSessionLayout()
  }, [activeSessionId, loadActiveSessionLayout])

  useEffect(() => {
    if (suppressPanelRemovalRef.current) return
    if (apiRef.current && activeSessionId && apiRef.current.totalPanels === 0 && paneList.length > 0) {
      loadedSessionRef.current = null
      loadActiveSessionLayout()
    }
  }, [activeSessionId, loadActiveSessionLayout, paneList.length])

  useEffect(() => {
    if (!arrangeRequestId || applyingArrangeRequestRef.current === arrangeRequestId) return
    applyingArrangeRequestRef.current = arrangeRequestId
    void arrangePanes().finally(() => {
      applyingArrangeRequestRef.current = null
    })
  }, [arrangePanes, arrangeRequestId])

  useEffect(() => {
    const setResizeMode = (single: boolean) => {
      const mode = single ? 'single' : 'connected'
      const dock = dockRef.current
      if (dock && dock.dataset.resizeMode !== mode) dock.dataset.resizeMode = mode
    }
    const syncCtrlMode = (event: KeyboardEvent) => {
      setResizeMode(event.ctrlKey)
    }
    const resetCtrlMode = () => setResizeMode(false)
    window.addEventListener('keydown', syncCtrlMode, { capture: true })
    window.addEventListener('keyup', syncCtrlMode, { capture: true })
    window.addEventListener('blur', resetCtrlMode)
    return () => {
      window.removeEventListener('keydown', syncCtrlMode, { capture: true })
      window.removeEventListener('keyup', syncCtrlMode, { capture: true })
      window.removeEventListener('blur', resetCtrlMode)
    }
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const api = apiRef.current
      const activePanelId = api?.activePanel?.id
      if (!api || !activePanelId) return
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
        (action) => !isTerminalCopyAction(action) || TerminalManager.containsEventTarget(activePanelId, event.target),
      )
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [resizeActivePaneByKeyboard, runKeybindingAction, settings.keybindings])

  useEffect(() => {
    const api = apiRef.current
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
    void applyTemplate(template, pendingTemplate.profileId).finally(() => {
      applyingTemplateRequestRef.current = null
      onTemplateApplied?.(pendingTemplate.requestId)
    })
  }, [activeSessionId, applyTemplate, onTemplateApplied, pendingTemplate])

  return (
    <WorkspaceActionsContext.Provider value={actions}>
      <section className="workspace-view">
        <div ref={dockRef} className="dockview-theme-abyss workspace-dock" data-resize-mode="connected" onPointerDownCapture={activatePaneFromTarget} onMouseDownCapture={activatePaneFromTarget}>
          <DockviewReact components={components} onReady={handleReady} defaultRenderer="always" defaultTabComponent={TerminalTab} disableDnd />
          <div className="connected-resize-layer" aria-hidden="true">
            {resizeHandles.connected.map((handle) => (
              <button
                key={handle.id}
                type="button"
                className={`connected-resize-handle connected-resize-handle-${handle.axis} connected-resize-handle-connected`}
                style={resizeHandleStyle(handle, RESIZE_HANDLE_HIT_SIZE)}
                tabIndex={-1}
                onPointerEnter={(event) => previewResizeHandle(event, handle)}
                onPointerMove={(event) => previewResizeHandle(event, handle)}
                onPointerLeave={clearResizePreview}
                onPointerDown={(event) => startConnectedResize(event, handle)}
              />
            ))}
            {resizeHandles.single.map((handle) => (
              <button
                key={handle.id}
                type="button"
                className={`connected-resize-handle connected-resize-handle-${handle.axis} connected-resize-handle-single`}
                style={resizeHandleStyle(handle, RESIZE_HANDLE_HIT_SIZE)}
                tabIndex={-1}
                onPointerEnter={(event) => previewResizeHandle(event, handle)}
                onPointerMove={(event) => previewResizeHandle(event, handle)}
                onPointerLeave={clearResizePreview}
                onPointerDown={(event) => startConnectedResize(event, handle)}
              />
            ))}
            {resizePreview ? (
              <>
                <div
                  className={`connected-resize-preview connected-resize-preview-${resizePreview.axis} connected-resize-preview-${resizePreview.mode} ${resizePreview.snapped ? 'connected-resize-preview-raw' : ''}`}
                  style={resizePreviewStyle(resizePreview, 2, resizePreview.snapped ? resizePreview.rawDelta : resizePreview.delta)}
                />
                {resizePreview.snapped ? (
                  <div
                    className={`connected-resize-preview connected-resize-preview-${resizePreview.axis} connected-resize-preview-snap-target`}
                    style={resizePreviewStyle(resizePreview, 6, resizePreview.delta)}
                  />
                ) : null}
              </>
            ) : null}
          </div>
        </div>
      </section>
    </WorkspaceActionsContext.Provider>
  )
}

function resizeDirectionFromKeyboardEvent(event: KeyboardEvent): ResizeDirection | null {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return null
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

function reflowTerminalsAfterLayout(): void {
  TerminalManager.reflowAll(true)
  requestAnimationFrame(() => {
    TerminalManager.reflowAll(true)
    requestAnimationFrame(() => TerminalManager.reflowAll(true))
  })
  window.setTimeout(() => TerminalManager.reflowAll(true), 50)
  window.setTimeout(() => TerminalManager.reflowAll(true), 150)
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

function isTerminalCopyAction(action: KeybindingActionId): boolean {
  return action === 'copyTerminalContents' || action === 'copyTerminalSelection'
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
  return document.querySelector<HTMLElement>(`[data-pane-id="${paneId}"]`)?.getBoundingClientRect() ?? null
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

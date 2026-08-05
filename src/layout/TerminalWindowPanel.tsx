import { useCallback, useEffect, useMemo, useRef } from 'react'
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type IDockviewPanel,
  type IDockviewPanelProps,
} from 'dockview-react'
import { getGridLocation, type AddPanelOptions } from 'dockview-core'
import { TerminalPanePanel } from './TerminalPanePanel'
import { TerminalPaneTitleBar } from '../components/TerminalPaneTitleBar'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { vibelinkDockviewTheme } from './dockviewTheme'
import { TerminalManager } from '../terminal/TerminalManager'
import { useWorkspaceStore } from '../state/store'
import { settleDockviewOverlayLayout, waitForDockviewOverlayLayout } from './splitOverlayLayout'
import { dockviewOverlaysSettled, forceOverlayReposition } from './dockviewOverlay'
import { isInteractiveResizeActive, onInteractiveResizeEnd } from './interactiveResize'
import { finalizeLocalSplitLayout, finalizeLocalSplitSize, localSplitInitialSize } from './localSplitSizing'
import { removePanelPreservingLayout } from './paneCloseLayout'
import { applySerializedGridSizes, serializedActiveViewId } from './liveGridSizes'
import { withLayoutParamsPersist } from './suppression'
import {
  activateOrphanedPaneGroups,
  clearTerminalPaneDropGuide,
  defaultTerminalPaneSplitDirection,
  preventTerminalPaneStackDrop,
  unstackSerializedDockview,
  updateTerminalPaneDropGuide,
} from './innerPaneLayout'
import { paneIdsInReadingOrder, swapPanelsInDockviewApi } from './paneSwap'
import { activeTerminalPaneId } from './paneActivation'
import {
  parseWorkspaceContentParams,
  workspaceContentPanelId,
  type SerializedDockview,
  type WorkspaceContentParams,
} from './workspaceContentModel'
import {
  registerTerminalWindow,
  type TerminalPaneParams,
  type TerminalWindowAddOptions,
} from './terminalWindowRegistry'

type TerminalWindowParams = Extract<WorkspaceContentParams, { kind: 'terminalWindow' }>
type TerminalWindowPanelProps = IDockviewPanelProps<TerminalWindowParams>

function TerminalPaneBoundary(props: IDockviewPanelProps<TerminalPaneParams>) {
  return <ErrorBoundary label="Terminal pane"><TerminalPanePanel {...props} /></ErrorBoundary>
}

const innerComponents = { terminal: TerminalPaneBoundary }
const innerTabComponents = { paneTitleBar: TerminalPaneTitleBar }

/** One terminal WINDOW: a nested Dockview whose panels are terminal panes. The
 * window owns pane layout + fit; WorkspaceView still owns PTY spawn/close and
 * pushes panes in through the registry handle. */
export function TerminalWindowPanel(props: TerminalWindowPanelProps) {
  const outerApi = props.api
  const windowId = props.params.instanceId
  const innerApiRef = useRef<DockviewApi | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const persistTimerRef = useRef<number | undefined>(undefined)
  const innerDisposablesRef = useRef<Array<{ dispose: () => void }>>([])
  const repairingInnerLayoutRef = useRef(false)
  const invariantCheckPendingRef = useRef(false)
  // Reading order is measured from live group rects, and the open-content
  // registry rebuilds it on every Dockview event — including edge-tab
  // activations that cannot move a pane. Measuring N groups per event was the
  // largest forced-layout cost left after the settle loops were bounded.
  const readingOrderRef = useRef<{ key: string; order: string[] } | null>(null)
  // Set when a persist was requested while a drag was still running.
  const persistDeferredRef = useRef(false)
  const titlesHidden = Boolean(props.params.titlesHidden)

  const paneIdsFromParams = useMemo(() => collectInnerPaneIds(props.params.inner), [props.params.inner])

  const layoutInner = useCallback(() => {
    const api = innerApiRef.current
    const host = hostRef.current
    if (!api || !host) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    // Round before handing the size to Dockview. The settle loop lays the inner
    // grid out several times while the outer overlays converge, and a host rect
    // that differs by a fraction of a pixel makes the splitview redistribute
    // pane widths by 1-3 px each round. Every redistribution re-fits the
    // terminals, which is visible as the grid re-aligning itself after it
    // already landed.
    api.layout(Math.round(rect.width), Math.round(rect.height), true)
  }, [])

  const settleInner = useCallback(async () => {
    const api = innerApiRef.current
    if (!api) return
    // A divider drag re-enters here through the outer panel's dimension events.
    // Skip it: `layoutInner` would re-apply the proportions saved at the
    // previous sash end and snap every pane back to its pre-drag size, and the
    // loop runs up to 12 forced-layout + overlay-reposition rounds per call.
    // The drag-end hook runs one settle on the final geometry instead.
    if (isInteractiveResizeActive()) return
    // A group with no active panel is invisible to BOTH the overlay reposition
    // and the settled check below, so the loop would report success while that
    // pane stayed unrendered. Repair it before sampling. Restored layouts reach
    // this through `fromJSON`, which preserves a missing `activeView`.
    activateOrphanedPaneGroups(api)
    // Dockview applies a maximize/restore to its grid over the following
    // frames and never repositions `renderer: 'always'` overlays for it (it
    // only does so on move / fromJSON). Sampling immediately would compare the
    // overlay against its still-stale content container, report "settled" on
    // attempt 0, and leave the pane fitted one toggle behind.
    await waitForDockviewOverlayLayout()
    await settleDockviewOverlayLayout({
      layout: () => layoutInner(),
      refresh: () => forceOverlayReposition(api),
      isSettled: () => dockviewOverlaysSettled(api),
      complete: () => {
        // Scope the forced pass to THIS window's panes. The default pane set is
        // every entry the manager holds — other windows, other workspaces, and
        // the background cache — and `force` bypasses the unchanged-rect skip,
        // so an unscoped pass re-measured and PTY-resized panes no settle here
        // could have moved. Each window settles its own panes.
        TerminalManager.scheduleLayoutPass({
          paneIds: api.panels.flatMap((panel) => {
            const content = parseWorkspaceContentParams(panel.params)
            return content?.kind === 'terminal' ? [content.paneId] : []
          }),
          force: true,
          syncPty: true,
        })
      },
    })
  }, [layoutInner])

  const captureInnerLayout = useCallback((): SerializedDockview | null => {
    const api = innerApiRef.current
    if (!api) return null
    try {
      return api.toJSON()
    } catch {
      return null
    }
  }, [])

  const persistInner = useCallback(() => {
    if (persistTimerRef.current !== undefined) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = undefined
      // updateParameters re-renders this panel and rewrites the OUTER layout.
      // Doing that mid-drag reconciles the whole terminal window while the
      // pointer is still moving, so hold the write until the drag ends; the
      // interaction-end handler re-runs it on the final geometry.
      if (isInteractiveResizeActive()) {
        persistDeferredRef.current = true
        return
      }
      const inner = captureInnerLayout()
      const current = outerApi.getParameters<TerminalWindowParams>()
      // Writing an unchanged inner layout feeds the save/restore cycle for
      // free, so only write a real change.
      if (JSON.stringify(current.inner) === JSON.stringify(inner)) return
      withLayoutParamsPersist(() => outerApi.updateParameters({ ...current, inner }))
      window.dispatchEvent(new CustomEvent('vibelink:terminal-window-persist'))
    }, 120)
  }, [captureInnerLayout, outerApi])

  const repairStackedInnerLayout = useCallback((api: DockviewApi): boolean => {
    if (repairingInnerLayoutRef.current) return false
    let current: SerializedDockview
    try {
      current = api.toJSON()
    } catch {
      return false
    }
    const repaired = unstackSerializedDockview(current)
    if (repaired === current) return false
    repairingInnerLayoutRef.current = true
    try {
      api.fromJSON(repaired, { reuseExistingPanels: true })
      return true
    } catch {
      return false
    } finally {
      repairingInnerLayoutRef.current = false
    }
  }, [])

  const addPane = useCallback((paneParams: TerminalPaneParams, options: TerminalWindowAddOptions = {}): IDockviewPanel | null => {
    const api = innerApiRef.current
    if (!api) return null
    const panelId = workspaceContentPanelId(paneParams)
    const existing = api.getPanel(panelId)
    if (existing) {
      if (!options.inactive) existing.api.setActive()
      return existing
    }
    const requestedReference = options.referencePaneId
      ? api.getPanel(workspaceContentPanelId({ kind: 'terminal', instanceId: options.referencePaneId }))
      : undefined
    const referencePanel = requestedReference ?? api.activePanel ?? api.panels.at(-1)
    let direction = options.direction
    if (referencePanel && !direction) {
      // A batch add is followed by a whole-grid arrangement, so the compact
      // growth heuristic (and its `toJSON`) buys nothing.
      if (options.batch) direction = 'right'
      else {
        try {
          direction = defaultTerminalPaneSplitDirection(api.toJSON())
        } catch {
          direction = 'right'
        }
      }
    }
    const localSplit = referencePanel && direction && !options.batch
      ? {
          beforeLayout: api.toJSON(),
          initialSize: localSplitInitialSize(getGridLocation(referencePanel.group.element), direction),
          referenceSize: direction === 'right' ? referencePanel.group.api.width : referencePanel.group.api.height,
        }
      : null
    const panelOptions = {
      id: panelId,
      component: 'terminal',
      tabComponent: 'paneTitleBar',
      title: paneParams.title,
      params: paneParams,
      renderer: 'always',
      inactive: options.inactive,
      position: referencePanel && direction ? { referencePanel, direction } : undefined,
      ...(localSplit?.initialSize ?? {}),
    }
    const panel = api.addPanel(panelOptions as AddPanelOptions<TerminalPaneParams>)
    if (referencePanel && direction && localSplit) {
      if (!finalizeLocalSplitLayout(api, localSplit.beforeLayout, referencePanel.id, panel.id, direction)) {
        finalizeLocalSplitSize(referencePanel.group, panel.group, direction, localSplit.referenceSize)
      }
    }
    if (!options.inactive) panel.api.setActive()
    return panel
  }, [])

  const removePane = useCallback((paneId: string) => {
    const api = innerApiRef.current
    if (!api) return
    const panelId = workspaceContentPanelId({ kind: 'terminal', instanceId: paneId })
    const panel = api.getPanel(panelId)
    if (!panel) return
    let nextLayout: SerializedDockview | null
    try {
      nextLayout = removePanelPreservingLayout(api.toJSON(), panelId)
    } catch {
      // Fall back to Dockview's native close if the live layout cannot be
      // serialized. A single/invalid layout has no unrelated pane to preserve.
      nextLayout = null
    }
    if (!nextLayout) {
      panel.api.close()
      repairStackedInnerLayout(api)
      return
    }
    // Native close is one splitview removal but redistributes the freed extent
    // across every sibling; restore the transform's exact sizes in place. The
    // fromJSON rebuild (~100 ms per surviving pane) stays as the fallback for
    // layouts the size applier refuses (maximized/hidden/topology mismatch).
    panel.api.close()
    if (applySerializedGridSizes(api, nextLayout)) {
      const activeViewId = serializedActiveViewId(nextLayout)
      const activePanel = activeViewId ? api.getPanel(activeViewId) : undefined
      if (activePanel && api.activePanel !== activePanel) activePanel.api.setActive()
      return
    }
    api.fromJSON(unstackSerializedDockview(nextLayout), { reuseExistingPanels: true })
  }, [repairStackedInnerLayout])

  const paneIds = useCallback((): string[] => {
    const api = innerApiRef.current
    if (!api) return paneIdsFromParams
    const panels = api.panels.filter((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal')
    const key = panels.map((panel) => panel.id).join('\u0000')
    const cached = readingOrderRef.current
    if (cached?.key === key) return cached.order
    const panelById = new Map(panels.map((panel) => [panel.id, panel] as const))
    const order = paneIdsInReadingOrder(panels.map((panel) => panel.id), (panelId) => {
      const rect = panelById.get(panelId)?.group.element.getBoundingClientRect()
      return rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height } : null
    }).flatMap((panelId) => {
      const content = parseWorkspaceContentParams(panelById.get(panelId)?.params)
      return content?.kind === 'terminal' ? [content.paneId] : []
    })
    readingOrderRef.current = { key, order }
    return order
  }, [paneIdsFromParams])

  const focusActivePane = useCallback(() => {
    const api = innerApiRef.current
    const paneId = activeTerminalPaneId(api, paneIds())
    if (!paneId) return
    const panel = api?.getPanel(workspaceContentPanelId({ kind: 'terminal', instanceId: paneId }))
    if (panel && api?.activePanel !== panel) panel.api.setActive()
    const state = useWorkspaceStore.getState()
    state.setActivePaneId(paneId)
    state.clearPaneCompletionHighlight(paneId)
    requestAnimationFrame(() => TerminalManager.focus(paneId))
  }, [paneIds])

  const scheduleInnerInvariantCheck = useCallback(() => {
    if (invariantCheckPendingRef.current) return
    invariantCheckPendingRef.current = true
    queueMicrotask(() => {
      invariantCheckPendingRef.current = false
      const api = innerApiRef.current
      if (!api) return
      repairStackedInnerLayout(api)
      void settleInner()
      persistInner()
    })
  }, [persistInner, repairStackedInnerLayout, settleInner])

  const handleInnerReady = useCallback((event: DockviewReadyEvent) => {
    innerApiRef.current = event.api
    const inner = props.params.inner
    let restored = false
    let repairedRestore = false
    if (inner) {
      try {
        const repaired = unstackSerializedDockview(inner)
        repairedRestore = repaired !== inner
        event.api.fromJSON(repaired)
        restored = event.api.panels.length > 0
      } catch {
        restored = false
      }
    }
    if (!restored) event.api.clear()
    innerDisposablesRef.current = [
      event.api.onWillDrop((dropEvent) => {
        const data = dropEvent.getData()
        const sourcePanelId = data?.viewId === dropEvent.api.id && typeof data.panelId === 'string' ? data.panelId : null
        if (!sourcePanelId) return
        const targetGroup = dropEvent.group
        const target = targetGroup
          ? updateTerminalPaneDropGuide(targetGroup, sourcePanelId, dropEvent.nativeEvent.clientX, dropEvent.nativeEvent.clientY)
          : null
        if (target && targetGroup) {
          dropEvent.preventDefault()
          clearTerminalPaneDropGuide()
          if (target === 'center') {
            const targetPanelId = targetGroup.activePanel?.id ?? targetGroup.panels[0]?.id
            if (targetPanelId && swapPanelsInDockviewApi(dropEvent.api, sourcePanelId, targetPanelId)) {
              readingOrderRef.current = null
              dropEvent.api.getPanel(sourcePanelId)?.api.setActive()
              void settleInner()
              persistInner()
            }
          } else {
            dropEvent.api.getPanel(sourcePanelId)?.api.moveTo({ group: targetGroup, position: target })
          }
          return
        }
        clearTerminalPaneDropGuide()
        if (preventTerminalPaneStackDrop(dropEvent.kind, dropEvent.position)) dropEvent.preventDefault()
      }),
      event.api.onWillShowOverlay((overlayEvent) => {
        const data = overlayEvent.getData()
        const sourcePanelId = data?.viewId === overlayEvent.api.id && typeof data.panelId === 'string' ? data.panelId : null
        if (sourcePanelId && overlayEvent.group && data?.groupId !== overlayEvent.group.id) {
          updateTerminalPaneDropGuide(overlayEvent.group, sourcePanelId, overlayEvent.nativeEvent.clientX, overlayEvent.nativeEvent.clientY)
          return
        }
        clearTerminalPaneDropGuide()
        if (preventTerminalPaneStackDrop(overlayEvent.kind, overlayEvent.position)) overlayEvent.preventDefault()
      }),
      event.api.onDidLayoutChange(() => { readingOrderRef.current = null; persistInner() }),
      event.api.onDidMovePanel(() => { readingOrderRef.current = null; scheduleInnerInvariantCheck() }),
      event.api.onDidDrop(() => { readingOrderRef.current = null; scheduleInnerInvariantCheck() }),
      event.api.onDidRemovePanel(() => persistInner()),
      event.api.onDidActivePanelChange((panel) => {
        const content = parseWorkspaceContentParams(panel?.params)
        if (content?.kind === 'terminal') useWorkspaceStore.getState().setActivePaneId(content.paneId)
      }),
    ]
    void settleInner()
    if (repairedRestore) persistInner()
  // props.params.inner is captured once at mount; later inner changes are driven
  // through the registry handle, not by re-running ready.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistInner, scheduleInnerInvariantCheck, settleInner])

  // Register the window handle so WorkspaceView actions can target this window.
  useEffect(() => {
    const unregister = registerTerminalWindow({
      windowId,
      getInnerApi: () => innerApiRef.current,
      addPane,
      removePane,
      settle: settleInner,
      persist: persistInner,
      paneIds,
      focusFirst: focusActivePane,
    })
    return unregister
  }, [addPane, focusActivePane, paneIds, persistInner, removePane, settleInner, windowId])

  // Fit cascade: the OUTER panel resize / visibility drives the inner Dockview.
  useEffect(() => {
    const dims = outerApi.onDidDimensionsChange(() => { if (outerApi.isVisible) void settleInner() })
    const vis = outerApi.onDidVisibilityChange(({ isVisible }) => { if (isVisible) void settleInner() })
    return () => { dims.dispose(); vis.dispose() }
  }, [outerApi, settleInner])

  // A drag end is the only point the geometry is final: re-settle so the inner
  // overlays/terminals fit the size the drag landed on, and flush the persist
  // that was withheld to keep updateParameters out of the gesture.
  useEffect(() => onInteractiveResizeEnd(() => {
    if (!innerApiRef.current) return
    void settleInner()
    if (!persistDeferredRef.current) return
    persistDeferredRef.current = false
    persistInner()
  }), [persistInner, settleInner])

  useEffect(() => {
    const clearAfterPointer = () => queueMicrotask(clearTerminalPaneDropGuide)
    document.addEventListener('pointerup', clearAfterPointer)
    document.addEventListener('pointercancel', clearAfterPointer)
    return () => {
      document.removeEventListener('pointerup', clearAfterPointer)
      document.removeEventListener('pointercancel', clearAfterPointer)
      clearTerminalPaneDropGuide()
    }
  }, [])

  // Hiding/showing pane title bars collapses the inner tab strip via CSS, which
  // does NOT emit a Dockview layout event, so the pane's absolutely-positioned
  // render overlay stays one toggle behind and the terminal fits to the stale
  // (shorter) height. Re-settle explicitly on the toggle.
  useEffect(() => {
    void settleInner()
  }, [settleInner, titlesHidden])

  useEffect(() => () => {
    innerApiRef.current = null
    invariantCheckPendingRef.current = false
    for (const disposable of innerDisposablesRef.current) disposable.dispose()
    clearTerminalPaneDropGuide()
    innerDisposablesRef.current = []
    if (persistTimerRef.current !== undefined) window.clearTimeout(persistTimerRef.current)
  }, [])

  return (
    <div
      ref={hostRef}
      className={`terminal-window-panel${titlesHidden ? ' terminal-window-titles-hidden' : ''}`}
      data-content-panel-id={props.api.id}
      data-terminal-window-id={windowId}
    >
      <DockviewReact
        components={innerComponents}
        tabComponents={innerTabComponents}
        defaultTabComponent={TerminalPaneTitleBar}
        onReady={handleInnerReady}
        defaultRenderer="always"
        disableFloatingGroups
        dndStrategy="pointer"
        hideBorders
        theme={vibelinkDockviewTheme}
      />
    </div>
  )
}

function collectInnerPaneIds(inner: SerializedDockview | null): string[] {
  if (!inner || typeof inner !== 'object' || !('panels' in inner)) return []
  const panels = inner.panels
  if (!panels || typeof panels !== 'object') return []
  const ids: string[] = []
  for (const value of Object.values(panels)) {
    if (!value || typeof value !== 'object' || !('params' in value)) continue
    const params = parseWorkspaceContentParams(value.params)
    if (params?.kind === 'terminal') ids.push(params.paneId)
  }
  return ids
}

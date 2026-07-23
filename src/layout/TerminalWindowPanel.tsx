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
import { settleDockviewOverlayLayout } from './splitOverlayLayout'
import { dockviewOverlaysSettled, forceOverlayReposition } from './dockviewOverlay'
import { finalizeLocalSplitSize, localSplitInitialSize } from './localSplitSizing'
import { removePanelPreservingLayout } from './paneCloseLayout'
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
  const titlesHidden = Boolean(props.params.titlesHidden)

  const paneIdsFromParams = useMemo(() => collectInnerPaneIds(props.params.inner), [props.params.inner])

  const layoutInner = useCallback(() => {
    const api = innerApiRef.current
    const host = hostRef.current
    if (!api || !host) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    api.layout(rect.width, rect.height, true)
  }, [])

  const settleInner = useCallback(async () => {
    const api = innerApiRef.current
    if (!api) return
    await settleDockviewOverlayLayout({
      layout: () => layoutInner(),
      refresh: () => forceOverlayReposition(api),
      isSettled: () => dockviewOverlaysSettled(api),
      complete: () => {
        for (const panel of api.panels) {
          const content = parseWorkspaceContentParams(panel.params)
          if (content?.kind === 'terminal') TerminalManager.reflow(content.paneId)
        }
        TerminalManager.scheduleLayoutPass({ force: true, syncPty: true })
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
      const inner = captureInnerLayout()
      const current = outerApi.getParameters<TerminalWindowParams>()
      outerApi.updateParameters({ ...current, inner })
      window.dispatchEvent(new CustomEvent('vibelink:terminal-window-persist'))
    }, 120)
  }, [captureInnerLayout, outerApi])

  const addPane = useCallback((paneParams: TerminalPaneParams, options: TerminalWindowAddOptions = {}): IDockviewPanel | null => {
    const api = innerApiRef.current
    if (!api) return null
    const panelId = workspaceContentPanelId(paneParams)
    const existing = api.getPanel(panelId)
    if (existing) {
      if (!options.inactive) existing.api.setActive()
      return existing
    }
    const referencePanel = options.referencePaneId
      ? api.getPanel(workspaceContentPanelId({ kind: 'terminal', instanceId: options.referencePaneId }))
      : undefined
    const localSplit = referencePanel && options.direction
      ? {
          initialSize: localSplitInitialSize(getGridLocation(referencePanel.group.element), options.direction),
          referenceSize: options.direction === 'right' ? referencePanel.group.api.width : referencePanel.group.api.height,
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
      position: referencePanel ? { referencePanel, direction: options.direction ?? 'right' } : undefined,
      ...(localSplit?.initialSize ?? {}),
    }
    const panel = api.addPanel(panelOptions as AddPanelOptions<TerminalPaneParams>)
    if (referencePanel && options.direction && localSplit) {
      finalizeLocalSplitSize(referencePanel.group, panel.group, options.direction, localSplit.referenceSize)
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
    try {
      const nextLayout = removePanelPreservingLayout(api.toJSON(), panelId)
      if (nextLayout) {
        api.fromJSON(nextLayout, { reuseExistingPanels: true })
        return
      }
    } catch {
      // Fall back to Dockview's native close if the live layout cannot be
      // serialized. A single/invalid layout has no unrelated pane to preserve.
    }
    panel.api.close()
  }, [])

  const paneIds = useCallback((): string[] => {
    const api = innerApiRef.current
    if (!api) return paneIdsFromParams
    return api.panels.flatMap((panel) => {
      const content = parseWorkspaceContentParams(panel.params)
      return content?.kind === 'terminal' ? [content.paneId] : []
    })
  }, [paneIdsFromParams])

  const focusFirst = useCallback(() => {
    const first = paneIds()[0]
    if (first) TerminalManager.focus(first)
  }, [paneIds])

  const handleInnerReady = useCallback((event: DockviewReadyEvent) => {
    innerApiRef.current = event.api
    const inner = props.params.inner
    let restored = false
    if (inner) {
      try {
        event.api.fromJSON(inner as Parameters<DockviewApi['fromJSON']>[0])
        restored = event.api.panels.length > 0
      } catch {
        restored = false
      }
    }
    if (!restored) event.api.clear()
    innerDisposablesRef.current = [
      event.api.onDidLayoutChange(() => persistInner()),
      event.api.onDidMovePanel(() => { void settleInner(); persistInner() }),
      event.api.onDidRemovePanel(() => persistInner()),
      event.api.onDidActivePanelChange((panel) => {
        const content = parseWorkspaceContentParams(panel?.params)
        if (content?.kind === 'terminal') useWorkspaceStore.getState().setActivePaneId(content.paneId)
      }),
    ]
    void settleInner()
  // props.params.inner is captured once at mount; later inner changes are driven
  // through the registry handle, not by re-running ready.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [persistInner, settleInner])

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
      focusFirst,
    })
    return unregister
  }, [addPane, focusFirst, paneIds, persistInner, removePane, settleInner, windowId])

  // Fit cascade: the OUTER panel resize / visibility drives the inner Dockview.
  useEffect(() => {
    const dims = outerApi.onDidDimensionsChange(() => { if (outerApi.isVisible) void settleInner() })
    const vis = outerApi.onDidVisibilityChange(({ isVisible }) => { if (isVisible) void settleInner() })
    return () => { dims.dispose(); vis.dispose() }
  }, [outerApi, settleInner])

  // Hiding/showing pane title bars collapses the inner tab strip via CSS, which
  // does NOT emit a Dockview layout event, so the pane's absolutely-positioned
  // render overlay stays one toggle behind and the terminal fits to the stale
  // (shorter) height. Re-settle explicitly on the toggle.
  useEffect(() => {
    void settleInner()
  }, [settleInner, titlesHidden])

  useEffect(() => () => {
    for (const disposable of innerDisposablesRef.current) disposable.dispose()
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

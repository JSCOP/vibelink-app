import { useCallback, useEffect, useRef, useState, type FunctionComponent } from 'react'
import {
  DockviewReact,
  type DockviewApi,
  type DockviewReadyEvent,
  type GetTabContextMenuItemsParams,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
} from 'dockview-react'
import { WorkspaceContentTab } from '../components/WorkspaceContentTab'
import { useWorkspaceContentActions } from './contentActions'
import { vibelinkDockviewTheme } from './dockviewTheme'
import { dockviewOverlaysSettled, forceOverlayReposition } from './dockviewOverlay'
import { isInteractiveResizeActive, onInteractiveResizeEnd } from './interactiveResize'
import { settleDockviewOverlayLayout, waitForDockviewOverlayLayout } from './splitOverlayLayout'
import { getTerminalWindow } from './terminalWindowRegistry'
import {
  parseWorkspaceContentParams,
  type SerializedDockview,
  type WorkspaceContentParams,
} from './workspaceContentModel'
import { workspaceWindowTitle } from './workspaceLayoutModel'
import { buildWorkspaceContentTabContextMenu } from './workspaceContentTabMenu'
import { WorkspaceEmptyState } from './WorkspaceEmptyState'
import { registerWorkspaceWindow } from './workspaceWindowRegistry'

type WorkspaceWindowParams = Extract<WorkspaceContentParams, { kind: 'workspaceWindow' }>
type WorkspaceContentPanel = FunctionComponent<IDockviewPanelProps<WorkspaceContentParams>>

type WorkspaceWindowPanelProps = IDockviewPanelProps<WorkspaceWindowParams> & {
  components: Record<string, WorkspaceContentPanel>
  leftHeaderActionsComponent: FunctionComponent<IDockviewHeaderActionsProps>
  onActiveGroupChange: (groupId: string | null) => void
}

const innerTabComponents = { workspaceContentTab: WorkspaceContentTab }

/** One workspace tab containing the complete editor/browser/terminal-window
 * Dockview. Splits and tab groups stay inside this panel, so the outer workspace
 * tab remains one movable unit instead of turning every split into a top tab. */
export function WorkspaceWindowPanel({
  api: outerApi,
  params,
  components,
  leftHeaderActionsComponent,
  onActiveGroupChange,
}: WorkspaceWindowPanelProps) {
  const actions = useWorkspaceContentActions()
  const innerApiRef = useRef<DockviewApi | null>(null)
  const [innerApi, setInnerApi] = useState<DockviewApi | null>(null)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const persistTimerRef = useRef<number | undefined>(undefined)
  const persistDeferredRef = useRef(false)
  const disposablesRef = useRef<Array<{ dispose: () => void }>>([])

  const layoutInner = useCallback(() => {
    const api = innerApiRef.current
    const host = hostRef.current
    if (!api || !host) return
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return
    api.layout(Math.round(rect.width), Math.round(rect.height), true)
  }, [])

  const settleInner = useCallback(async () => {
    const api = innerApiRef.current
    if (!api || isInteractiveResizeActive()) return
    await waitForDockviewOverlayLayout()
    await settleDockviewOverlayLayout({
      layout: layoutInner,
      refresh: () => forceOverlayReposition(api),
      isSettled: () => dockviewOverlaysSettled(api),
    })
    for (const panel of api.panels) {
      const content = parseWorkspaceContentParams(panel.params)
      if (content?.kind === 'terminalWindow') await getTerminalWindow(content.instanceId)?.settle()
    }
  }, [layoutInner])

  const captureInnerLayout = useCallback((): SerializedDockview | null => {
    try {
      return innerApiRef.current?.toJSON() ?? null
    } catch {
      return null
    }
  }, [])

  const notifyChanged = useCallback(() => {
    window.dispatchEvent(new CustomEvent('vibelink:workspace-window-change'))
  }, [])

  const persistInner = useCallback(() => {
    if (persistTimerRef.current !== undefined) window.clearTimeout(persistTimerRef.current)
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = undefined
      if (isInteractiveResizeActive()) {
        persistDeferredRef.current = true
        return
      }
      const inner = captureInnerLayout()
      const current = outerApi.getParameters<WorkspaceWindowParams>()
      const title = workspaceWindowTitle(inner)
      if (JSON.stringify(current.inner) === JSON.stringify(inner) && current.title === title) return
      outerApi.updateParameters({ ...current, title, inner })
      outerApi.setTitle(title)
      notifyChanged()
    }, 120)
  }, [captureInnerLayout, notifyChanged, outerApi])

  const clearDragState = useCallback(() => {
    hostRef.current?.removeAttribute('data-vl-window-drag')
  }, [])

  const focusActive = useCallback(() => {
    const panel = innerApiRef.current?.activePanel
    if (!panel) return
    panel.api.setActive()
    const content = parseWorkspaceContentParams(panel.params)
    if (content?.kind === 'terminalWindow') getTerminalWindow(content.instanceId)?.focusFirst()
  }, [])

  const getTabContextMenuItems = useCallback((request: GetTabContextMenuItemsParams) => (
    buildWorkspaceContentTabContextMenu(request, actions)
  ), [actions])

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    innerApiRef.current = event.api
    setInnerApi(event.api)
    let restored = false
    if (params.inner) {
      try {
        event.api.fromJSON(params.inner)
        restored = true
      } catch {
        restored = false
      }
    }
    if (!restored) event.api.clear()
    disposablesRef.current = [
      event.api.onDidLayoutChange(persistInner),
      event.api.onDidMovePanel(() => { clearDragState(); persistInner(); void settleInner() }),
      event.api.onDidDrop(() => { clearDragState(); persistInner(); void settleInner() }),
      event.api.onDidRemovePanel(() => { persistInner(); notifyChanged() }),
      event.api.onDidAddPanel(() => { persistInner(); notifyChanged() }),
      event.api.onWillDragPanel(() => hostRef.current?.setAttribute('data-vl-window-drag', 'true')),
      event.api.onDidActiveGroupChange((group) => {
        onActiveGroupChange(group?.id ?? null)
        notifyChanged()
      }),
      event.api.onDidActivePanelChange(() => notifyChanged()),
    ]
    onActiveGroupChange(event.api.activeGroup?.id ?? null)
    void settleInner()
  // Initial params are restored once. Later writes originate from this inner API.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDragState, notifyChanged, onActiveGroupChange, persistInner, settleInner])

  useEffect(() => registerWorkspaceWindow({
    windowId: params.instanceId,
    outerPanelId: outerApi.id,
    getInnerApi: () => innerApiRef.current,
    settle: settleInner,
    persist: persistInner,
    panelIds: () => innerApiRef.current?.panels.map((panel) => panel.id) ?? [],
    activePanelId: () => innerApiRef.current?.activePanel?.id ?? null,
    focusActive,
  }), [focusActive, outerApi.id, params.instanceId, persistInner, settleInner])

  useEffect(() => {
    const dimensions = outerApi.onDidDimensionsChange(() => { if (outerApi.isVisible) void settleInner() })
    const visibility = outerApi.onDidVisibilityChange(({ isVisible }) => { if (isVisible) void settleInner() })
    return () => { dimensions.dispose(); visibility.dispose() }
  }, [outerApi, settleInner])

  useEffect(() => {
    const persistTerminalLayout = () => persistInner()
    const clear = () => clearDragState()
    window.addEventListener('vibelink:terminal-window-persist', persistTerminalLayout)
    window.addEventListener('pointerup', clear)
    window.addEventListener('pointercancel', clear)
    return () => {
      window.removeEventListener('vibelink:terminal-window-persist', persistTerminalLayout)
      window.removeEventListener('pointerup', clear)
      window.removeEventListener('pointercancel', clear)
    }
  }, [clearDragState, persistInner])

  useEffect(() => onInteractiveResizeEnd(() => {
    if (!innerApiRef.current) return
    void settleInner()
    if (!persistDeferredRef.current) return
    persistDeferredRef.current = false
    persistInner()
  }), [persistInner, settleInner])

  useEffect(() => () => {
    innerApiRef.current = null
    for (const disposable of disposablesRef.current) disposable.dispose()
    disposablesRef.current = []
    if (persistTimerRef.current !== undefined) window.clearTimeout(persistTimerRef.current)
  }, [])

  return (
    <div ref={hostRef} className="workspace-window-container" data-content-panel-id={outerApi.id} data-workspace-window-id={params.instanceId}>
      <DockviewReact
        components={components}
        tabComponents={innerTabComponents}
        defaultTabComponent={WorkspaceContentTab}
        leftHeaderActionsComponent={leftHeaderActionsComponent}
        getTabContextMenuItems={getTabContextMenuItems}
        onReady={handleReady}
        defaultRenderer="always"
        disableFloatingGroups
        dndStrategy="pointer"
        theme={vibelinkDockviewTheme}
      />
      <WorkspaceEmptyState api={innerApi} actions={actions} />
    </div>
  )
}

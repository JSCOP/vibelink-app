import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent, type FunctionComponent } from 'react'
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
import { withLayoutParamsPersist } from './suppression'
import { getTerminalWindow } from './terminalWindowRegistry'
import {
  parseWorkspaceContentParams,
  type SerializedDockview,
  type WorkspaceContentParams,
} from './workspaceContentModel'
import { workspaceWindowTitle } from './workspaceLayoutModel'
import { buildWorkspaceContentTabContextMenu } from './workspaceContentTabMenu'
import { WorkspaceEmptyState } from './WorkspaceEmptyState'
import { endWorkspaceWindowDrag, moveWorkspaceWindowPanelFromContentDrop, registerWorkspaceWindow, workspaceWindowContentDropTarget, workspaceWindowDragPanelId, workspaceWindowDragType } from './workspaceWindowRegistry'

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
      withLayoutParamsPersist(() => {
        outerApi.updateParameters({ ...current, title, inner })
        outerApi.setTitle(title)
      })
      notifyChanged()
    }, 120)
  }, [captureInnerLayout, notifyChanged, outerApi])

  const clearContentDropTarget = useCallback(() => {
    for (const group of innerApiRef.current?.groups ?? []) group.element.removeAttribute('data-vl-window-drop-position')
  }, [])

  const clearPointerDragState = useCallback(() => {
    hostRef.current?.removeAttribute('data-vl-window-drag')
    clearContentDropTarget()
  }, [clearContentDropTarget])

  const clearDragState = useCallback(() => {
    clearPointerDragState()
    endWorkspaceWindowDrag()
  }, [clearPointerDragState])

  const handleContentDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const api = innerApiRef.current
    const sourcePanelId = workspaceWindowDragPanelId() || event.dataTransfer.getData(workspaceWindowDragType)
    if (!api || !sourcePanelId) return
    const target = workspaceWindowContentDropTarget(api, sourcePanelId, event.clientX, event.clientY)
    clearContentDropTarget()
    if (!target) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    target.group.element.dataset.vlWindowDropPosition = target.position
  }, [clearContentDropTarget])

  const handleContentDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const api = innerApiRef.current
    const sourcePanelId = workspaceWindowDragPanelId() || event.dataTransfer.getData(workspaceWindowDragType)
    if (!api || !sourcePanelId || !workspaceWindowContentDropTarget(api, sourcePanelId, event.clientX, event.clientY)) return
    event.preventDefault()
    event.stopPropagation()
    const moved = moveWorkspaceWindowPanelFromContentDrop(api, sourcePanelId, event.clientX, event.clientY)
    clearDragState()
    if (!moved) return
    persistInner()
    void settleInner()
  }, [clearDragState, persistInner, settleInner])

  const handleContentDragLeave = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
    clearContentDropTarget()
  }, [clearContentDropTarget])

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
    persistInner()
    void settleInner()
  // Initial params are restored once. Later writes originate from this inner API.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clearDragState, notifyChanged, onActiveGroupChange, persistInner, settleInner])

  useEffect(() => {
    const unregister = registerWorkspaceWindow({
      windowId: params.instanceId,
      outerPanelId: outerApi.id,
      getInnerApi: () => innerApiRef.current,
      settle: settleInner,
      persist: persistInner,
      panelIds: () => innerApiRef.current?.panels.map((panel) => panel.id) ?? [],
      activePanelId: () => innerApiRef.current?.activePanel?.id ?? null,
      focusActive,
    })
    notifyChanged()
    return () => {
      unregister()
      notifyChanged()
    }
  }, [focusActive, notifyChanged, outerApi.id, params.instanceId, persistInner, settleInner])

  useEffect(() => {
    const dimensions = outerApi.onDidDimensionsChange(() => { if (outerApi.isVisible) void settleInner() })
    const visibility = outerApi.onDidVisibilityChange(({ isVisible }) => { if (isVisible) void settleInner() })
    return () => { dimensions.dispose(); visibility.dispose() }
  }, [outerApi, settleInner])

  useEffect(() => {
    const persistTerminalLayout = () => persistInner()
    const clearPointer = () => clearPointerDragState()
    const clearDrag = () => clearDragState()
    window.addEventListener('vibelink:terminal-window-persist', persistTerminalLayout)
    window.addEventListener('pointerup', clearPointer)
    window.addEventListener('dragend', clearDrag)
    window.addEventListener('pointercancel', clearPointer)
    return () => {
      window.removeEventListener('vibelink:terminal-window-persist', persistTerminalLayout)
      window.removeEventListener('pointerup', clearPointer)
      window.removeEventListener('pointercancel', clearPointer)
      window.removeEventListener('dragend', clearDrag)
    }
  }, [clearDragState, clearPointerDragState, persistInner])

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
    <div
      ref={hostRef}
      className="workspace-window-container"
      data-content-panel-id={outerApi.id}
      data-workspace-window-id={params.instanceId}
      onDragOverCapture={handleContentDragOver}
      onDropCapture={handleContentDrop}
      onDragLeaveCapture={handleContentDragLeave}
    >
      <div className="workspace-window-inner-dock">
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
      </div>
      <WorkspaceEmptyState api={innerApi} actions={actions} variant="empty-window" />
    </div>
  )
}

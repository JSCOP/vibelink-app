import { useCallback, useEffect, useMemo, useRef } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanel } from 'dockview-react'
import { TerminalTab } from '../components/TerminalTab'
import { TerminalManager } from '../terminal/TerminalManager'
import { createTerminalRefreshScheduler } from '../terminal/refreshScheduler'
import { useWorkspaceStore } from '../state/store'
import { selectedProfile } from '../state/profiles'
import { handleCapturedKeybindingEvent, type KeybindingActionId } from '../state/keybindings'
import type { PaneMeta } from '../ipc/types'
import { PlaceholderPanel, TerminalPanePanel } from './TerminalPanePanel'
import { type SplitDirection, WorkspaceActionsContext } from './actions'
import { TEMPLATES, type GridTemplate } from './templates'
import { planTemplateReconcile } from './templatePlan'
import { withSuppressedPanelRemoval } from './suppression'
import { shouldRestoreDockviewLayout } from './layoutRestore'
import { paneIdFromEventTarget } from './paneActivation'

type PendingTemplateRequest = {
  sessionId: string
  templateId: string
  requestId: number
}

type WorkspaceViewProps = {
  onApiReady?: (api: DockviewApi) => void
  pendingTemplate?: PendingTemplateRequest | null
  onTemplateApplied?: (requestId: number) => void
}

const components = {
  terminal: TerminalPanePanel,
  placeholder: PlaceholderPanel,
}

export function WorkspaceView({ onApiReady, pendingTemplate, onTemplateApplied }: WorkspaceViewProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const loadedSessionRef = useRef<string | null>(null)
  const suppressPanelRemovalRef = useRef(false)
  const saveTimerRef = useRef<number | undefined>()
  const dockRef = useRef<HTMLDivElement | null>(null)
  const applyingTemplateRequestRef = useRef<number | null>(null)
  const refreshAfterLayoutRef = useRef(createTerminalRefreshScheduler(() => TerminalManager.refreshAll()))
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const panes = useWorkspaceStore((state) => state.panes)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const closePaneInStore = useWorkspaceStore((state) => state.closePane)
  const saveLayout = useWorkspaceStore((state) => state.saveLayout)
  const deleteSession = useWorkspaceStore((state) => state.deleteSession)
  const settings = useWorkspaceStore((state) => state.settings)
  const renamePaneTitleInStore = useWorkspaceStore((state) => state.renamePaneTitle)

  const paneList = useMemo(() => Object.values(panes), [panes])

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
    refreshAfterLayoutRef.current()
  }, [])

  const addTerminalPanel = useCallback((api: DockviewApi, pane: PaneMeta, options?: { referencePanel?: string; direction?: SplitDirection | 'within'; inactive?: boolean }) => {
    api.addPanel({
      id: pane.id,
      component: 'terminal',
      title: pane.config.title ?? 'Shell',
      params: { paneId: pane.id, title: pane.config.title ?? 'Shell' },
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
    activatePane(paneId)
    panel?.api.close()
  }, [activatePane])

  const toggleMaximize = useCallback((paneId: string) => {
    const panel = apiRef.current?.getPanel(paneId)
    activatePane(paneId)
    if (!panel) return
    if (panel.api.isMaximized()) panel.api.exitMaximized()
    else panel.api.maximize()
    refreshAfterLayoutRef.current()
  }, [activatePane])

  const renamePaneTitle = useCallback(async (paneId: string, title: string) => {
    await renamePaneTitleInStore(paneId, title, 'manual')
    apiRef.current?.getPanel(paneId)?.api.setTitle(title)
  }, [renamePaneTitleInStore])

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
  }, [closePane, closeWorkspace, focusPane, newTab, splitPane, toggleMaximize])

  const applyTemplate = useCallback(async (template: GridTemplate) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    const profile = selectedProfile(useWorkspaceStore.getState().settings)
    const targetPaneCount = template.cols * template.rows
    const existingPanes = Object.values(useWorkspaceStore.getState().panes)
    const initialPlan = planTemplateReconcile(existingPanes.map((pane) => pane.id), targetPaneCount)
    const plannedPanes = [...existingPanes]

    for (let index = 0; index < initialPlan.missingPaneCount; index += 1) {
      const pane = await spawnPane(sessionId, { title: `${profile.name} ${plannedPanes.length + 1}` })
      plannedPanes.push(pane)
    }

    const paneById = new Map(plannedPanes.map((pane) => [pane.id, pane]))
    const plan = planTemplateReconcile(plannedPanes.map((pane) => pane.id), targetPaneCount)

    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      api.clear()

      const topRow: string[] = []
      for (let col = 0; col < template.cols; col += 1) {
        const pane = paneById.get(plan.gridPaneIds[col])
        if (!pane) continue
        addTerminalPanel(api, pane, col === 0 ? undefined : { referencePanel: topRow[col - 1], direction: 'right' })
        topRow.push(pane.id)
      }

      for (let col = 0; col < template.cols; col += 1) {
        let bottom = topRow[col]
        for (let row = 1; row < template.rows; row += 1) {
          const pane = paneById.get(plan.gridPaneIds[template.cols + col * (template.rows - 1) + (row - 1)])
          if (!pane || !bottom) continue
          addTerminalPanel(api, pane, { referencePanel: bottom, direction: 'below' })
          bottom = pane.id
        }
      }

      const overflowReference = plan.gridPaneIds.at(-1)
      for (const paneId of plan.overflowPaneIds) {
        const pane = paneById.get(paneId)
        if (!pane || !overflowReference) continue
        addTerminalPanel(api, pane, { referencePanel: overflowReference, direction: 'within', inactive: true })
      }

      layoutDockview(api)
      loadedSessionRef.current = sessionId
      await saveLayout(sessionId, JSON.stringify(api.toJSON()))
    })
  }, [addTerminalPanel, layoutDockview, saveLayout, spawnPane])

  const actions = useMemo(() => ({ activatePane, splitPane, newTab, closePane, toggleMaximize, renamePaneTitle }), [activatePane, closePane, newTab, renamePaneTitle, splitPane, toggleMaximize])

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    onApiReady?.(event.api)
    event.api.onDidLayoutChange(() => {
      persistLayoutSoon()
      refreshAfterLayoutRef.current()
    })
    event.api.onDidRemovePanel((panel: IDockviewPanel) => {
      if (suppressPanelRemovalRef.current) return
      TerminalManager.dispose(panel.id)
      void closePaneInStore(panel.id)
    })
    loadedSessionRef.current = null
    loadActiveSessionLayout()
  }, [closePaneInStore, loadActiveSessionLayout, onApiReady, persistLayoutSoon])

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
    const onKeyDown = (event: KeyboardEvent) => {
      const api = apiRef.current
      const activePanelId = api?.activePanel?.id
      if (!api || !activePanelId) return
      handleCapturedKeybindingEvent(
        settings.keybindings,
        event,
        (action) => runKeybindingAction(action, activePanelId),
        (action) => !isTerminalCopyAction(action) || TerminalManager.containsEventTarget(activePanelId, event.target),
      )
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [runKeybindingAction, settings.keybindings])

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
    const template = TEMPLATES.find((item) => item.id === pendingTemplate.templateId)
    if (!template) {
      onTemplateApplied?.(pendingTemplate.requestId)
      return
    }
    applyingTemplateRequestRef.current = pendingTemplate.requestId
    void applyTemplate(template).finally(() => {
      applyingTemplateRequestRef.current = null
      onTemplateApplied?.(pendingTemplate.requestId)
    })
  }, [activeSessionId, applyTemplate, onTemplateApplied, pendingTemplate])

  return (
    <WorkspaceActionsContext.Provider value={actions}>
      <section className="workspace-view">
        <div ref={dockRef} className="dockview-theme-abyss workspace-dock" onPointerDownCapture={activatePaneFromTarget} onMouseDownCapture={activatePaneFromTarget}>
          <DockviewReact components={components} onReady={handleReady} defaultRenderer="always" defaultTabComponent={TerminalTab} />
        </div>
      </section>
    </WorkspaceActionsContext.Provider>
  )
}

function isTerminalCopyAction(action: KeybindingActionId): boolean {
  return action === 'copyTerminalContents' || action === 'copyTerminalSelection'
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

import { useCallback, useEffect, useMemo, useRef } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent, type IDockviewPanel } from 'dockview-react'
import { Grid3X3 } from 'lucide-react'
import { TerminalTab } from '../components/TerminalTab'
import { TerminalManager } from '../terminal/TerminalManager'
import { useWorkspaceStore } from '../state/store'
import { selectedProfile } from '../state/profiles'
import type { PaneMeta } from '../ipc/types'
import { PlaceholderPanel, TerminalPanePanel } from './TerminalPanePanel'
import { type SplitDirection, WorkspaceActionsContext } from './actions'
import { TEMPLATES, type GridTemplate } from './templates'
import { withSuppressedPanelRemoval } from './suppression'
import { shouldRestoreDockviewLayout } from './layoutRestore'

type WorkspaceViewProps = {
  onApiReady?: (api: DockviewApi) => void
}

const components = {
  terminal: TerminalPanePanel,
  placeholder: PlaceholderPanel,
}

export function WorkspaceView({ onApiReady }: WorkspaceViewProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const loadedSessionRef = useRef<string | null>(null)
  const suppressPanelRemovalRef = useRef(false)
  const saveTimerRef = useRef<number | undefined>()
  const dockRef = useRef<HTMLDivElement | null>(null)
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const panes = useWorkspaceStore((state) => state.panes)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const closePaneInStore = useWorkspaceStore((state) => state.closePane)
  const saveLayout = useWorkspaceStore((state) => state.saveLayout)

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

  const splitPane = useCallback(async (paneId: string, direction: SplitDirection) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    const pane = await spawnPane(sessionId)
    addTerminalPanel(api, pane, { referencePanel: paneId, direction })
    layoutDockview(api)
    persistLayoutSoon()
  }, [addTerminalPanel, layoutDockview, persistLayoutSoon, spawnPane])

  const newTab = useCallback(async (paneId: string) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    const pane = await spawnPane(sessionId)
    addTerminalPanel(api, pane, { referencePanel: paneId, direction: 'within' })
    layoutDockview(api)
    persistLayoutSoon()
  }, [addTerminalPanel, layoutDockview, persistLayoutSoon, spawnPane])

  const closePane = useCallback(async (paneId: string) => {
    const api = apiRef.current
    const panel = api?.getPanel(paneId)
    panel?.api.close()
  }, [])

  const toggleMaximize = useCallback((paneId: string) => {
    const panel = apiRef.current?.getPanel(paneId)
    if (!panel) return
    if (panel.api.isMaximized()) panel.api.exitMaximized()
    else panel.api.maximize()
  }, [])

  const applyTemplate = useCallback(async (template: GridTemplate) => {
    const api = apiRef.current
    const sessionId = useWorkspaceStore.getState().activeSessionId
    if (!api || !sessionId) return
    const profile = selectedProfile(useWorkspaceStore.getState().settings)

    await withSuppressedPanelRemoval(suppressPanelRemovalRef, async () => {
      const paneIds = Object.keys(useWorkspaceStore.getState().panes)
      for (const paneId of paneIds) {
        TerminalManager.dispose(paneId)
        await closePaneInStore(paneId)
      }
      api.clear()

      const topRow: string[] = []
      for (let col = 0; col < template.cols; col += 1) {
        const pane = await spawnPane(sessionId, { title: `${profile.name} ${col + 1}` })
        addTerminalPanel(api, pane, col === 0 ? undefined : { referencePanel: topRow[col - 1], direction: 'right' })
        topRow.push(pane.id)
      }

      for (let col = 0; col < template.cols; col += 1) {
        let bottom = topRow[col]
        for (let row = 1; row < template.rows; row += 1) {
          const pane = await spawnPane(sessionId, { title: `${profile.name} ${col + 1}.${row + 1}` })
          addTerminalPanel(api, pane, { referencePanel: bottom, direction: 'below' })
          bottom = pane.id
        }
      }
      layoutDockview(api)

      loadedSessionRef.current = sessionId
      await saveLayout(sessionId, JSON.stringify(api.toJSON()))
    })
  }, [addTerminalPanel, closePaneInStore, layoutDockview, saveLayout, spawnPane])

  const actions = useMemo(() => ({ splitPane, newTab, closePane, toggleMaximize }), [closePane, newTab, splitPane, toggleMaximize])

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    onApiReady?.(event.api)
    event.api.onDidLayoutChange(persistLayoutSoon)
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
      if (event.altKey && event.shiftKey && event.key === '=') {
        event.preventDefault()
        void splitPane(activePanelId, 'right')
      } else if (event.altKey && event.shiftKey && event.key === '-') {
        event.preventDefault()
        void splitPane(activePanelId, 'below')
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'w') {
        event.preventDefault()
        void closePane(activePanelId)
      } else if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 't') {
        event.preventDefault()
        void newTab(activePanelId)
      } else if (event.ctrlKey && event.shiftKey && event.key === 'Enter') {
        event.preventDefault()
        toggleMaximize(activePanelId)
      } else if (event.ctrlKey && event.key === 'Tab') {
        event.preventDefault()
        if (event.shiftKey) api.moveToPrevious()
        else api.moveToNext()
      } else if (event.altKey && event.key.startsWith('Arrow')) {
        event.preventDefault()
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') api.moveToPrevious()
        else api.moveToNext()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closePane, newTab, splitPane, toggleMaximize])

  return (
    <WorkspaceActionsContext.Provider value={actions}>
      <section className="workspace-view">
        <div className="workspace-toolbar">
          <div className="toolbar-label"><Grid3X3 size={15} /> Templates</div>
          <div className="template-buttons">
            {TEMPLATES.map((template) => (
              <button key={template.id} type="button" onClick={() => void applyTemplate(template)}>
                {template.label}
              </button>
            ))}
          </div>
        </div>
        <div ref={dockRef} className="dockview-theme-abyss workspace-dock">
          <DockviewReact components={components} onReady={handleReady} defaultRenderer="always" defaultTabComponent={TerminalTab} />
        </div>
      </section>
    </WorkspaceActionsContext.Provider>
  )
}

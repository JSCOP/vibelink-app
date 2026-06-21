import { useCallback, useEffect, useRef, useState } from 'react'
import { DockviewReact, type DockviewApi, type DockviewReadyEvent } from 'dockview-react'
import { KanbanBoard } from '../components/KanbanBoard'
import { OrchestratorChat } from '../components/OrchestratorChat'
import { TaskDiffView } from '../components/TaskDiffView'
import { useWorkspaceStore } from '../state/store'
import '../styles/kanban.css'

const components = {
  orchestrator: OrchestratorChat,
  board: KanbanBoard,
  diff: TaskDiffView,
}

const PANEL_TITLES = {
  orchestrator: 'Orchestrator',
  board: 'Board',
  diff: 'Diff',
} as const

type KanbanPanelId = keyof typeof PANEL_TITLES

const DEFAULT_PANEL_IDS = Object.keys(PANEL_TITLES) as KanbanPanelId[]

type KanbanViewProps = {
  sessionId: string
}

export function KanbanView({ sessionId }: KanbanViewProps) {
  const apiRef = useRef<DockviewApi | null>(null)
  const dockRef = useRef<HTMLDivElement | null>(null)
  const saveTimerRef = useRef<number | undefined>()
  const loadedSessionRef = useRef<string | null>(null)
  const layoutJson = useWorkspaceStore((state) => state.kanbanLayouts[sessionId])
  const setKanbanLayout = useWorkspaceStore((state) => state.setKanbanLayout)
  const [missing, setMissing] = useState<KanbanPanelId[]>([])

  const layoutDockview = useCallback((api: DockviewApi) => {
    const rect = dockRef.current?.getBoundingClientRect()
    if (!rect || rect.width <= 0 || rect.height <= 0) return
    api.layout(Math.floor(rect.width), Math.floor(rect.height), true)
  }, [])

  const persistLayoutSoon = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(() => {
      const currentApi = apiRef.current
      if (!currentApi) return
      setKanbanLayout(sessionId, JSON.stringify(currentApi.toJSON()))
    }, 400)
  }, [sessionId, setKanbanLayout])

  const refreshMissing = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    setMissing(DEFAULT_PANEL_IDS.filter((id) => !api.getPanel(id)))
  }, [])

  const buildDefaultLayout = useCallback((api: DockviewApi) => {
    api.clear()
    api.addPanel({ id: 'orchestrator', component: 'orchestrator', title: 'Orchestrator' })
    api.addPanel({ id: 'board', component: 'board', title: 'Board', position: { referencePanel: 'orchestrator', direction: 'right' } })
    api.addPanel({ id: 'diff', component: 'diff', title: 'Diff', position: { referencePanel: 'board', direction: 'right' } })
  }, [])

  const loadLayout = useCallback(() => {
    const api = apiRef.current
    if (!api || loadedSessionRef.current === sessionId) return
    try {
      if (layoutJson) api.fromJSON(JSON.parse(layoutJson), { reuseExistingPanels: true })
      else buildDefaultLayout(api)
      if (api.totalPanels === 0) buildDefaultLayout(api)
    } catch {
      buildDefaultLayout(api)
    }
    layoutDockview(api)
    refreshMissing()
    loadedSessionRef.current = sessionId
  }, [buildDefaultLayout, layoutDockview, layoutJson, refreshMissing, sessionId])

  const handleReady = useCallback((event: DockviewReadyEvent) => {
    apiRef.current = event.api
    event.api.onDidLayoutChange(() => {
      persistLayoutSoon()
      refreshMissing()
    })
    loadedSessionRef.current = null
    loadLayout()
  }, [loadLayout, persistLayoutSoon, refreshMissing])

  useEffect(() => {
    loadedSessionRef.current = null
    loadLayout()
  }, [loadLayout, sessionId])

  useEffect(() => {
    const onResize = () => {
      if (apiRef.current) layoutDockview(apiRef.current)
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [layoutDockview])

  const resetLayout = () => {
    setKanbanLayout(sessionId, null)
    if (apiRef.current) {
      buildDefaultLayout(apiRef.current)
      layoutDockview(apiRef.current)
      refreshMissing()
    }
  }

  const restorePanel = (id: KanbanPanelId) => {
    const api = apiRef.current
    if (!api || api.getPanel(id)) return
    api.addPanel({ id, component: id, title: PANEL_TITLES[id] })
    layoutDockview(api)
    persistLayoutSoon()
    refreshMissing()
  }

  return (
    <section className="kanban-view">
      <div className="kanban-toolbar">
        <span>Kanban</span>
        {missing.map((id) => <button key={id} type="button" onClick={() => restorePanel(id)}>+ {PANEL_TITLES[id]}</button>)}
        <button type="button" onClick={resetLayout}>Reset layout</button>
      </div>
      <div ref={dockRef} className="dockview-theme-awt kanban-dock">
        <DockviewReact components={components} onReady={handleReady} defaultRenderer="always" />
      </div>
    </section>
  )
}

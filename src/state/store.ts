import { invoke } from '@tauri-apps/api/core'
import { sendToPane, submitAgentPrompt } from '../ipc/panes'
import { create } from 'zustand'
import type { AttachedSession, HermesGatewayConfig, HermesModelInfo, PaneConfig, PaneMeta, SessionMeta, Task, TaskStatus, WorktreeInfo } from '../ipc/types'
import { defaultSettings, isAgentPane, normalizeSettings, paneOverridesFromProfile, profileById, selectedProfileForWorkspace } from './profiles'
import { normalizePaneTitle, shouldApplyAutoTitle, type ManualPaneTitleMap } from './paneTitles'
import type { Settings } from './profiles'
import type { KanbanData } from './kanban'
import { composeTaskPrompt } from './kanban'
import { loadKanban, persistKanban, type ViewMode } from './kanbanPersistence'
import type { WorkspaceTodoItem, WorkspaceTodoLists, WorkspaceTodoNotes } from './workspaceTodos'
import { defaultHermesGateway, type HermesModelsState, type HermesPlanEntry, type HermesSessionInfo, type HermesStatus, type HermesTextPartKind, type HermesToolCallView, type HermesTranscriptPart, type HermesTurn, type PendingPermission } from './hermes'
import {
  createWorkspaceLayoutPage,
  deleteWorkspaceLayoutPage,
  duplicateWorkspaceLayoutPage,
  normalizeWorkspaceLayoutState,
  renameWorkspaceLayoutPage,
  replaceWorkspaceLayoutPage,
  resetWorkspaceLayoutPage,
  serializeWorkspaceLayoutState,
  setActiveWorkspaceLayoutPage,
  type WorkspaceLayoutState,
} from '../layout/workspaceLayoutModel'

const initialKanban = loadKanban()

const boardMirrorDelayMs = 300
const boardMirrorTimers = new Map<string, number>()

type SpawnPaneOptions = Partial<PaneConfig> & { profileId?: string | null }

type Status = 'booting' | 'ready' | 'error'
export type PaneCompletionSource = 'agent-response' | 'task-done'
export type PaneCompletionHighlight = { completedAt: number; source: PaneCompletionSource }


type WorkspaceState = {
  sessions: SessionMeta[]
  activeSessionId?: string
  panes: Record<string, PaneMeta>
  layoutJson?: string | null
  manualPaneTitles: ManualPaneTitleMap
  status: Status
  error?: string
  settings: Settings
  kanban: KanbanData
  viewModes: Record<string, ViewMode>
  kanbanLayouts: Record<string, string>
  workspaceLayouts: Record<string, WorkspaceLayoutState>
  orchestratorPaneIds: Record<string, string>
  hermesGateways: Record<string, HermesGatewayConfig>
  workspaceTodos: WorkspaceTodoLists
  workspaceTodoNotes: WorkspaceTodoNotes
  hermesStatus: Record<string, HermesStatus>
  hermesTranscript: Record<string, HermesTurn[]>
  hermesPermissions: Record<string, PendingPermission[]>
  hermesUsage: Record<string, { size: number; used: number }>
  hermesModels: Record<string, HermesModelsState>
  hermesPendingPrompts: Record<string, string[]>
  hermesCurrentSession: Record<string, string>
  hermesSessions: Record<string, HermesSessionInfo[]>
  selectedTaskId: Record<string, string | null>
  activePaneId?: string
  paneCompletionHighlights: Record<string, PaneCompletionHighlight>
  capturesByPane: Record<string, string[]>
  recentCaptures: string[]
  setActivePaneId: (paneId?: string) => void
  markPaneResponseComplete: (paneId: string, source?: PaneCompletionSource) => void
  clearPaneCompletionHighlight: (paneId: string) => void
  recordCapture: (paneId: string | undefined, path: string) => void
  resolveCaptureMarker: (paneId: string, n: number) => string | undefined
  bootstrap: () => Promise<void>
  refreshSessions: () => Promise<void>
  openSession: (sessionId: string) => Promise<AttachedSession>
  attachSession: (sessionId: string) => Promise<AttachedSession>
  createSession: (name?: string, workspaceFolder?: string | null, profileId?: string | null) => Promise<SessionMeta>
  renameSession: (sessionId: string, name: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  spawnPane: (sessionId: string, overrides?: SpawnPaneOptions) => Promise<PaneMeta>
  closePane: (paneId: string) => Promise<void>
  saveLayout: (sessionId: string, layoutJson: string) => Promise<void>
  saveWorkspaceLayoutPage: (sessionId: string, pageId: string, layoutJson: string | null) => Promise<void>
  setActiveLayoutPage: (sessionId: string, pageId: string) => void
  createLayoutPage: (sessionId: string, name?: string) => void
  renameLayoutPage: (sessionId: string, pageId: string, name: string) => void
  deleteLayoutPage: (sessionId: string, pageId: string) => void
  duplicateLayoutPage: (sessionId: string, pageId: string) => void
  resetLayoutPage: (sessionId: string, pageId: string) => void
  clearSession: (sessionId: string) => Promise<void>
  renamePaneTitle: (paneId: string, title: string, source: 'manual' | 'auto') => Promise<void>
  applyTerminalTitle: (paneId: string, title: string) => Promise<void>
  setError: (error: string) => void
  clearError: () => void
  dismissError: () => void
  updateSettings: (settings: Partial<Settings>) => void
  setDefaultProfile: (profileId: string) => void
  setViewMode: (sessionId: string, mode: ViewMode) => void
  createTask: (sessionId: string, input: { title: string; description: string }) => Task
  addWorkspaceTodo: (sessionId: string, text: string) => WorkspaceTodoItem | null
  deleteWorkspaceTodo: (sessionId: string, todoId: string) => void
  deleteWorkspaceTodos: (sessionId: string, todoIds: string[]) => void
  updateWorkspaceTodoText: (sessionId: string, todoId: string, text: string) => void
  setWorkspaceTodoNote: (sessionId: string, note: string) => void
  injectWorkspaceTodosToKanban: (sessionId: string, todoIds: string[]) => Task[]
  updateTask: (id: string, patch: Partial<Task>) => void
  deleteTask: (id: string) => void
  moveTask: (id: string, status: TaskStatus) => void
  assignTask: (taskId: string, paneId: string, options?: { isolated?: boolean }) => Promise<void>
  markTaskDone: (taskId: string, result?: { commitMessage?: string; resultSummary?: string }) => void
  noteTask: (taskId: string, message: string) => void
  selectTask: (sessionId: string, taskId: string | null) => void
  setKanbanLayout: (sessionId: string, json: string | null) => void
  setOrchestratorPane: (sessionId: string, paneId: string) => void
  setPaneRole: (paneId: string, role: string) => void
  applyPaneConfiguration: (paneId: string, patch: { title?: string | null; role?: string | null }) => void
  setHermesGateway: (sessionId: string, patch: Partial<HermesGatewayConfig>) => void
  addHermesUserMessage: (sessionId: string, text: string) => void
  appendHermesText: (sessionId: string, kind: HermesTextPartKind, text: string) => void
  addHermesToolCall: (sessionId: string, call: Omit<HermesToolCallView, 'content'> & { content?: string }) => void
  updateHermesToolCall: (sessionId: string, toolCallId: string, patch: { status: string; content: string }) => void
  setHermesPlan: (sessionId: string, entries: HermesPlanEntry[]) => void
  setHermesUsage: (sessionId: string, usage: { size: number; used: number }) => void
  addHermesPermission: (sessionId: string, permission: PendingPermission) => void
  resolveHermesPermission: (sessionId: string, requestId: number) => void
  endHermesTurn: (sessionId: string) => void
  setHermesModels: (sessionId: string, models: { available: HermesModelInfo[]; current: string }) => void
  setHermesStatus: (sessionId: string, status: HermesStatus) => void
  enqueueHermesPrompt: (sessionId: string, text: string) => void
  takeHermesPrompt: (sessionId: string) => string | undefined
  resetHermesTranscript: (sessionId: string) => void
  setHermesCurrentSession: (sessionId: string, acpSessionId: string) => void
  setHermesSessions: (sessionId: string, sessions: HermesSessionInfo[]) => void
  setHermesTranscript: (sessionId: string, turns: HermesTurn[]) => void
  applyBoardSnapshot: (sessionId: string, json: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  sessions: [],
  panes: {},
  manualPaneTitles: {},
  status: 'booting',
  settings: loadSettings(),
  kanban: initialKanban.data,
  viewModes: initialKanban.viewModes,
  kanbanLayouts: initialKanban.kanbanLayouts,
  workspaceLayouts: {},
  orchestratorPaneIds: initialKanban.orchestratorPaneIds,
  hermesGateways: initialKanban.hermesGateways,
  workspaceTodos: initialKanban.workspaceTodos,
  workspaceTodoNotes: initialKanban.workspaceTodoNotes,
  hermesStatus: {},
  hermesTranscript: {},
  hermesPermissions: {},
  hermesUsage: {},
  hermesModels: {},
  hermesPendingPrompts: {},
  hermesCurrentSession: {},
  hermesSessions: {},
  selectedTaskId: {},
  activePaneId: undefined,
  paneCompletionHighlights: {},
  capturesByPane: {},
  recentCaptures: [],

  bootstrap: async () => {
    set({ status: 'booting', error: undefined })
    try {
      let sessions = await invoke<SessionMeta[]>('list_sessions')
      if (sessions.length === 0) {
        const created = await invoke<SessionMeta>('create_session', { name: 'Workspace 1' })
        sessions = [created]
      }

      set({ sessions, activeSessionId: undefined, panes: {}, layoutJson: null, status: 'ready' })
    } catch (error) {
      set({ status: 'error', error: String(error) })
    }
  },

  refreshSessions: async () => {
    const sessions = await invoke<SessionMeta[]>('list_sessions')
    set({ sessions })
  },

  openSession: async (sessionId: string) => {
    if (!get().sessions.some((session) => session.id === sessionId)) {
      await get().refreshSessions()
    }
    const attached = await get().attachSession(sessionId)
    if (attached.panes.length === 0) {
      await get().spawnPane(sessionId)
    }
    await get().refreshSessions()
    return attached
  },

  attachSession: async (sessionId: string) => {
    const attached = await invoke<AttachedSession>('attach_session', { sessionId })
    const panes = Object.fromEntries(attached.panes.map((pane) => [pane.id, pane]))
    const workspaceLayout = normalizeWorkspaceLayoutState(attached.layoutJson, {
      terminalPaneIds: attached.panes.map((pane) => pane.id),
      legacyKanbanLayoutJson: get().kanbanLayouts[sessionId],
    })
    window.localStorage.setItem('awt:lastActiveSessionId', sessionId)
    set((state) => ({
      activeSessionId: sessionId,
      activePaneId: undefined,
      panes,
      paneCompletionHighlights: prunePaneCompletionHighlights(state.paneCompletionHighlights, panes),
      layoutJson: attached.layoutJson ?? null,
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: workspaceLayout },
    }))
    return attached
  },

  createSession: async (name?: string, workspaceFolder?: string | null, profileId?: string | null) => {
    const fallbackName = `Workspace ${get().sessions.length + 1}`
    const normalizedFolder = normalizeWorkspaceFolder(workspaceFolder)
    const requestedProfile = profileId ? profileById(get().settings, profileId) : null
    const created = await invoke<SessionMeta>('create_session', { name: name ?? fallbackName, workspaceFolder: normalizedFolder })
    await get().refreshSessions()
    if (requestedProfile) {
      get().updateSettings({
        workspaceProfileIds: {
          ...get().settings.workspaceProfileIds,
          [created.id]: requestedProfile.id,
        },
      })
    }
    await get().attachSession(created.id)
    await get().spawnPane(created.id, { profileId })
    set((state) => ({ hermesGateways: { ...state.hermesGateways, [created.id]: defaultHermesGateway('telegram') } }))
    persistCurrentKanban(get(), created.id)
    void invoke('hermes_ensure_workspace', { sessionId: created.id, workspaceFolder: normalizedFolder })
    return created
  },

  renameSession: async (sessionId: string, name: string) => {
    await invoke('rename_session', { sessionId, name })
    await get().refreshSessions()
  },

  deleteSession: async (sessionId: string) => {
    await invoke('delete_session', { sessionId })
    let sessions = await invoke<SessionMeta[]>('list_sessions')
    if (sessions.length === 0) {
      const created = await invoke<SessionMeta>('create_session', { name: 'Workspace 1' })
      sessions = [created]
    }
    set((state) => {
      const deletedPaneIds = state.activeSessionId === sessionId ? Object.keys(state.panes) : []
      const taskIds = new Set(state.kanban.taskOrder[sessionId] ?? [])
      const tasks = { ...state.kanban.tasks }
      for (const taskId of taskIds) delete tasks[taskId]
      const taskOrder = { ...state.kanban.taskOrder }
      delete taskOrder[sessionId]
      const viewModes = { ...state.viewModes }
      const kanbanLayouts = { ...state.kanbanLayouts }
      const workspaceLayouts = { ...state.workspaceLayouts }
      const orchestratorPaneIds = { ...state.orchestratorPaneIds }
      const selectedTaskId = { ...state.selectedTaskId }
      const hermesGateways = { ...state.hermesGateways }
      const workspaceTodos = { ...state.workspaceTodos }
      const workspaceTodoNotes = { ...state.workspaceTodoNotes }
      const hermesStatus = { ...state.hermesStatus }
      const hermesTranscript = { ...state.hermesTranscript }
      const hermesPermissions = { ...state.hermesPermissions }
      const hermesUsage = { ...state.hermesUsage }
      const hermesModels = { ...state.hermesModels }
      const hermesPendingPrompts = { ...state.hermesPendingPrompts }
      const hermesCurrentSession = { ...state.hermesCurrentSession }
      const hermesSessions = { ...state.hermesSessions }
      const manualPaneTitles = withoutPaneKeys(state.manualPaneTitles, deletedPaneIds)
      const capturesByPane = withoutPaneKeys(state.capturesByPane, deletedPaneIds)
      const paneRoles = withoutPaneKeys(state.settings.paneRoles, deletedPaneIds)
      const settings = paneRoles === state.settings.paneRoles ? state.settings : { ...state.settings, paneRoles }
      delete viewModes[sessionId]
      delete kanbanLayouts[sessionId]
      delete workspaceLayouts[sessionId]
      delete orchestratorPaneIds[sessionId]
      delete selectedTaskId[sessionId]
      delete hermesGateways[sessionId]
      delete workspaceTodos[sessionId]
      delete workspaceTodoNotes[sessionId]
      delete hermesStatus[sessionId]
      delete hermesTranscript[sessionId]
      delete hermesPermissions[sessionId]
      delete hermesUsage[sessionId]
      delete hermesModels[sessionId]
      delete hermesPendingPrompts[sessionId]
      delete hermesCurrentSession[sessionId]
      delete hermesSessions[sessionId]
      return { sessions, kanban: { tasks, taskOrder }, viewModes, kanbanLayouts, workspaceLayouts, orchestratorPaneIds, selectedTaskId, hermesGateways, workspaceTodos, workspaceTodoNotes, hermesStatus, hermesTranscript, hermesPermissions, hermesUsage, hermesModels, hermesPendingPrompts, hermesCurrentSession, hermesSessions, manualPaneTitles, capturesByPane, settings }
    })
    persistSettings(get().settings)
    persistCurrentKanban(get())
    const next = sessions[0]
    await get().attachSession(next.id)
    if (Object.keys(get().panes).length === 0) {
      await get().spawnPane(next.id)
    }
  },

  spawnPane: async (sessionId: string, overrides?: SpawnPaneOptions) => {
    const paneId = overrides?.paneId ?? crypto.randomUUID()
    const profile = overrides && 'profileId' in overrides
      ? profileById(get().settings, overrides.profileId)
      : selectedProfileForWorkspace(get().settings, sessionId)
    const sessionsWorkspaceFolder = get().sessions.find((session) => session.id === sessionId)?.workspaceFolder ?? null
    const profileDefaults = paneOverridesFromProfile(profile, undefined, { remoteCwd: profile.type === 'ssh' ? sessionsWorkspaceFolder : null })
    const hasShellOverride = Boolean(overrides && 'shell' in overrides)
    const hasCwdOverride = Boolean(overrides && 'cwd' in overrides)
    const hasTitleOverride = Boolean(overrides && 'title' in overrides)
    const sessionWorkspaceFolder = profile.type === 'ssh' ? null : sessionsWorkspaceFolder
    const cfg: PaneConfig = {
      paneId,
      shell: hasShellOverride ? overrides?.shell ?? null : profileDefaults.shell,
      args: overrides?.args ? [...overrides.args] : profileDefaults.args,
      cwd: hasCwdOverride ? overrides?.cwd ?? null : sessionWorkspaceFolder ?? profileDefaults.cwd,
      env: terminalAgentEnv(overrides?.env ? overrides.env.map(([key, value]) => [key, value]) : profileDefaults.env, sessionId, paneId),
      title: hasTitleOverride ? overrides?.title ?? null : profileDefaults.title,
      icon: overrides?.icon ?? profile.icon,
      profileId: profile.id,
      cols: overrides?.cols ?? 120,
      rows: overrides?.rows ?? 32,
    }
    const pane = await invoke<PaneMeta>('spawn_pane', { sessionId, cfg })
    set((state) => ({ panes: { ...state.panes, [pane.id]: pane } }))
    await get().refreshSessions()
    return pane
  },

  closePane: async (paneId: string) => {
    const sessionId = get().activeSessionId
    if (!sessionId) return
    await invoke('close_pane', { sessionId, paneId })
    set((state) => {
      const panes = { ...state.panes }
      delete panes[paneId]
      return {
        panes,
        activePaneId: state.activePaneId === paneId ? undefined : state.activePaneId,
        paneCompletionHighlights: withoutPaneKey(state.paneCompletionHighlights, paneId),
      }
    })
    await get().refreshSessions()
  },

  clearSession: async (sessionId: string) => {
    await invoke('clear_session', { sessionId })
    if (get().activeSessionId === sessionId) set({ panes: {}, activePaneId: undefined, paneCompletionHighlights: {} })
  },

  renamePaneTitle: async (paneId: string, title: string, source: 'manual' | 'auto') => {
    const normalized = normalizePaneTitle(title)
    if (!normalized) return
    if (get().panes[paneId]?.config.title === normalized) return
    const sessionId = get().activeSessionId
    if (!sessionId) return
    await invoke('set_pane_title', { sessionId, paneId, title: normalized })
    set((state) => {
      const pane = state.panes[paneId]
      if (!pane) return {}
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            config: { ...pane.config, title: normalized },
          },
        },
        manualPaneTitles: source === 'manual'
          ? { ...state.manualPaneTitles, [paneId]: true }
          : state.manualPaneTitles,
      }
    })
  },

  applyTerminalTitle: async (paneId: string, title: string) => {
    if (!shouldApplyAutoTitle(paneId, get().manualPaneTitles)) return
    await get().renamePaneTitle(paneId, title, 'auto')
  },

  saveLayout: async (sessionId: string, layoutJson: string) => {
    await invoke('save_layout', { sessionId, layoutJson })
    if (get().activeSessionId === sessionId) {
      set({ layoutJson })
    }
  },
  saveWorkspaceLayoutPage: async (sessionId: string, pageId: string, layoutJson: string | null) => {
    const current = workspaceLayoutForSession(get(), sessionId)
    const next = replaceWorkspaceLayoutPage(current, pageId, layoutJson)
    set((state) => ({
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: next },
      layoutJson: state.activeSessionId === sessionId ? serializeWorkspaceLayoutState(next) : state.layoutJson,
    }))
    await persistWorkspaceLayout(sessionId, next)
  },
  setActiveLayoutPage: (sessionId: string, pageId: string) => {
    const next = setActiveWorkspaceLayoutPage(workspaceLayoutForSession(get(), sessionId), pageId)
    set((state) => ({
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: next },
      layoutJson: state.activeSessionId === sessionId ? serializeWorkspaceLayoutState(next) : state.layoutJson,
    }))
    void persistWorkspaceLayout(sessionId, next).catch((error) => get().setError(String(error)))
  },
  createLayoutPage: (sessionId: string, name?: string) => {
    const next = createWorkspaceLayoutPage(workspaceLayoutForSession(get(), sessionId), name)
    set((state) => ({
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: next },
      layoutJson: state.activeSessionId === sessionId ? serializeWorkspaceLayoutState(next) : state.layoutJson,
    }))
    void persistWorkspaceLayout(sessionId, next).catch((error) => get().setError(String(error)))
  },
  renameLayoutPage: (sessionId: string, pageId: string, name: string) => {
    const next = renameWorkspaceLayoutPage(workspaceLayoutForSession(get(), sessionId), pageId, name)
    set((state) => ({
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: next },
      layoutJson: state.activeSessionId === sessionId ? serializeWorkspaceLayoutState(next) : state.layoutJson,
    }))
    void persistWorkspaceLayout(sessionId, next).catch((error) => get().setError(String(error)))
  },
  deleteLayoutPage: (sessionId: string, pageId: string) => {
    const next = deleteWorkspaceLayoutPage(workspaceLayoutForSession(get(), sessionId), pageId)
    set((state) => ({
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: next },
      layoutJson: state.activeSessionId === sessionId ? serializeWorkspaceLayoutState(next) : state.layoutJson,
    }))
    void persistWorkspaceLayout(sessionId, next).catch((error) => get().setError(String(error)))
  },
  duplicateLayoutPage: (sessionId: string, pageId: string) => {
    const next = duplicateWorkspaceLayoutPage(workspaceLayoutForSession(get(), sessionId), pageId)
    set((state) => ({
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: next },
      layoutJson: state.activeSessionId === sessionId ? serializeWorkspaceLayoutState(next) : state.layoutJson,
    }))
    void persistWorkspaceLayout(sessionId, next).catch((error) => get().setError(String(error)))
  },
  resetLayoutPage: (sessionId: string, pageId: string) => {
    const next = resetWorkspaceLayoutPage(workspaceLayoutForSession(get(), sessionId), pageId)
    set((state) => ({
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: next },
      layoutJson: state.activeSessionId === sessionId ? serializeWorkspaceLayoutState(next) : state.layoutJson,
    }))
    void persistWorkspaceLayout(sessionId, next).catch((error) => get().setError(String(error)))
  },

  setError: (error: string) => set({ error, status: 'error' }),
  clearError: () => set({ error: undefined, status: 'ready' }),
  dismissError: () => set({ error: undefined }),
  setActivePaneId: (paneId) => set((state) => {
    if (!paneId || !state.paneCompletionHighlights[paneId]) return { activePaneId: paneId }
    return { activePaneId: paneId, paneCompletionHighlights: withoutPaneKey(state.paneCompletionHighlights, paneId) }
  }),
  markPaneResponseComplete: (paneId, source = 'agent-response') => set((state) => {
    const pane = state.panes[paneId]
    if (!pane?.alive || !isAgentPane(pane, state.settings)) return {}
    return {
      paneCompletionHighlights: {
        ...state.paneCompletionHighlights,
        [paneId]: { completedAt: Date.now(), source },
      },
    }
  }),
  clearPaneCompletionHighlight: (paneId) => set((state) => {
    if (!state.paneCompletionHighlights[paneId]) return {}
    return { paneCompletionHighlights: withoutPaneKey(state.paneCompletionHighlights, paneId) }
  }),
  recordCapture: (paneId, path) => set((state) => {
    const recentCaptures = [...state.recentCaptures, path].slice(-50)
    if (!paneId) return { recentCaptures }
    const paneCaptures = [...(state.capturesByPane[paneId] ?? []), path]
    return {
      recentCaptures,
      capturesByPane: { ...state.capturesByPane, [paneId]: paneCaptures },
    }
  }),
  resolveCaptureMarker: (paneId, n) => {
    const state = get()
    return state.capturesByPane[paneId]?.[n - 1] ?? state.recentCaptures.at(-1)
  },
  updateSettings: (patch: Partial<Settings>) => {
    const settings = normalizeSettings({ ...get().settings, ...patch })
    persistSettings(settings)
    set({ settings })
  },
  setDefaultProfile: (profileId: string) => {
    const sessionId = get().activeSessionId
    if (!sessionId) {
      get().updateSettings({ defaultProfileId: profileId })
      return
    }
    get().updateSettings({
      workspaceProfileIds: {
        ...get().settings.workspaceProfileIds,
        [sessionId]: profileId,
      },
    })
  },
  setViewMode: (sessionId: string, mode: ViewMode) => {
    set((state) => ({ viewModes: { ...state.viewModes, [sessionId]: mode } }))
    persistCurrentKanban(get(), sessionId)
  },
  createTask: (sessionId: string, input: { title: string; description: string }) => {
    const now = Date.now()
    const task: Task = {
      id: crypto.randomUUID(),
      sessionId,
      title: input.title.trim(),
      description: input.description,
      status: 'pending',
      statusTimestamps: { pending: now },
      createdAt: now,
      updatedAt: now,
    }
    set((state) => ({
      kanban: {
        tasks: { ...state.kanban.tasks, [task.id]: task },
        taskOrder: {
          ...state.kanban.taskOrder,
          [sessionId]: [...(state.kanban.taskOrder[sessionId] ?? []), task.id],
        },
      },
      selectedTaskId: { ...state.selectedTaskId, [sessionId]: task.id },
    }))
    persistCurrentKanban(get(), sessionId)
    return task
  },
  addWorkspaceTodo: (sessionId, text) => {
    const trimmed = text.trim()
    if (!trimmed) return null
    const now = Date.now()
    const todo: WorkspaceTodoItem = { id: crypto.randomUUID(), text: trimmed, createdAt: now, updatedAt: now }
    set((state) => {
      const workspaceTodos = state.workspaceTodos ?? {}
      return {
        workspaceTodos: {
          ...workspaceTodos,
          [sessionId]: [...(workspaceTodos[sessionId] ?? []), todo],
        },
      }
    })
    persistCurrentKanban(get(), sessionId)
    return todo
  },
  deleteWorkspaceTodo: (sessionId, todoId) => {
    get().deleteWorkspaceTodos(sessionId, [todoId])
  },
  deleteWorkspaceTodos: (sessionId, todoIds) => {
    const ids = new Set(todoIds)
    if (ids.size === 0) return
    set((state) => {
      const workspaceTodos = state.workspaceTodos ?? {}
      return {
        workspaceTodos: {
          ...workspaceTodos,
          [sessionId]: (workspaceTodos[sessionId] ?? []).filter((todo) => !ids.has(todo.id)),
        },
      }
    })
    persistCurrentKanban(get(), sessionId)
  },
  updateWorkspaceTodoText: (sessionId, todoId, text) => {
    const trimmed = text.trim()
    if (!trimmed) return
    set((state) => {
      const workspaceTodos = state.workspaceTodos ?? {}
      return {
        workspaceTodos: {
          ...workspaceTodos,
          [sessionId]: (workspaceTodos[sessionId] ?? []).map((todo) => todo.id === todoId ? { ...todo, text: trimmed, updatedAt: Date.now() } : todo),
        },
      }
    })
    persistCurrentKanban(get(), sessionId)
  },
  setWorkspaceTodoNote: (sessionId, note) => {
    set((state) => {
      const workspaceTodoNotes = { ...(state.workspaceTodoNotes ?? {}) }
      if (note.trim()) workspaceTodoNotes[sessionId] = note
      else delete workspaceTodoNotes[sessionId]
      return { workspaceTodoNotes }
    })
    persistCurrentKanban(get(), sessionId)
  },
  injectWorkspaceTodosToKanban: (sessionId, todoIds) => {
    const state = get()
    const ids = new Set(todoIds)
    const todos = ((state.workspaceTodos ?? {})[sessionId] ?? []).filter((todo) => ids.has(todo.id) && !todo.kanbanTaskId)
    if (todos.length === 0) return []
    const now = Date.now()
    const note = (state.workspaceTodoNotes ?? {})[sessionId]?.trim() ?? ''
    const tasks: Task[] = todos.map((todo) => ({
      id: crypto.randomUUID(),
      sessionId,
      title: todo.text,
      description: note,
      status: 'pending',
      statusTimestamps: { pending: now },
      createdAt: now,
      updatedAt: now,
    }))
    const taskByTodoId = Object.fromEntries(todos.map((todo, index) => [todo.id, tasks[index].id]))
    set((current) => ({
      kanban: {
        tasks: { ...current.kanban.tasks, ...Object.fromEntries(tasks.map((task) => [task.id, task])) },
        taskOrder: {
          ...current.kanban.taskOrder,
          [sessionId]: [...(current.kanban.taskOrder[sessionId] ?? []), ...tasks.map((task) => task.id)],
        },
      },
      selectedTaskId: { ...current.selectedTaskId, [sessionId]: tasks[tasks.length - 1]?.id ?? current.selectedTaskId[sessionId] ?? null },
      workspaceTodos: {
        ...(current.workspaceTodos ?? {}),
        [sessionId]: ((current.workspaceTodos ?? {})[sessionId] ?? []).map((todo) => taskByTodoId[todo.id] ? { ...todo, kanbanTaskId: taskByTodoId[todo.id], updatedAt: now } : todo),
      },
    }))
    persistCurrentKanban(get(), sessionId)
    return tasks
  },
  updateTask: (id: string, patch: Partial<Task>) => {
    const sessionId = get().kanban.tasks[id]?.sessionId
    if (!sessionId) return
    set((state) => {
      const task = state.kanban.tasks[id]
      if (!task) return {}
      const nextStatus = patch.status
      const statusTimestamps = nextStatus && nextStatus !== task.status
        ? { ...task.statusTimestamps, [nextStatus]: Date.now() }
        : task.statusTimestamps
      return {
        kanban: {
          ...state.kanban,
          tasks: {
            ...state.kanban.tasks,
            [id]: { ...task, ...patch, statusTimestamps, id: task.id, sessionId: task.sessionId, updatedAt: Date.now() },
          },
        },
      }
    })
    persistCurrentKanban(get(), sessionId)
  },
  deleteTask: (id: string) => {
    const task = get().kanban.tasks[id]
    if (!task) return
    set((state) => {
      const tasks = { ...state.kanban.tasks }
      delete tasks[id]
      const order = state.kanban.taskOrder[task.sessionId] ?? []
      return {
        kanban: {
          tasks,
          taskOrder: { ...state.kanban.taskOrder, [task.sessionId]: order.filter((taskId) => taskId !== id) },
        },
        selectedTaskId: state.selectedTaskId[task.sessionId] === id
          ? { ...state.selectedTaskId, [task.sessionId]: null }
          : state.selectedTaskId,
      }
    })
    persistCurrentKanban(get(), task.sessionId)
  },
  moveTask: (id: string, status: TaskStatus) => {
    get().updateTask(id, { status })
  },
  assignTask: async (taskId: string, paneId: string, options?: { isolated?: boolean }) => {
    const task = get().kanban.tasks[taskId]
    const pane = get().panes[paneId]
    if (!task || !pane?.alive) {
      set({ error: 'Cannot assign task to a missing or closed pane' })
      return
    }
    if (!isAgentPane(pane, get().settings)) {
      set({ error: 'Tasks can only be assigned to AI agent terminal profiles such as Codex, Claude, or OMP.' })
      return
    }
    const role = get().settings.paneRoles[paneId]
    get().updateTask(taskId, {
      assignedPaneId: paneId,
      assignedRole: role,
      status: 'assigned',
    })
    const session = get().sessions.find((item) => item.id === task.sessionId)
    if (session?.workspaceFolder) {
      try {
        if (options?.isolated) {
          const worktree = await invoke<WorktreeInfo>('git_worktree_create', { workspaceFolder: session.workspaceFolder, taskId })
          get().updateTask(taskId, { worktreePath: worktree.worktreePath, baselineRef: 'HEAD' })
        } else {
          const baselineRef = await invoke<string>('git_snapshot_baseline', { workspaceFolder: session.workspaceFolder })
          get().updateTask(taskId, { baselineRef })
        }
      } catch (error) {
        const currentTask = get().kanban.tasks[taskId] ?? task
        const note = `Diff baseline unavailable: ${String(error)}`
        get().updateTask(taskId, {
          resultSummary: [currentTask.resultSummary, note].filter(Boolean).join('\n'),
        })
      }
    }
    const latestTask = get().kanban.tasks[taskId] ?? task
    await sendToPane(task.sessionId, paneId, composeTaskPrompt(latestTask, { role, sessionId: task.sessionId }), false)
    await delay(120)
    await submitAgentPrompt(task.sessionId, paneId)
    get().updateTask(taskId, { status: 'in-progress' })
  },
  markTaskDone: (taskId: string, result?: { commitMessage?: string; resultSummary?: string }) => {
    const task = get().kanban.tasks[taskId]
    if (!task) return
    get().updateTask(taskId, {
      status: 'done',
      commitMessage: result?.commitMessage ?? task.commitMessage,
      resultSummary: result?.resultSummary ?? task.resultSummary,
    })
  },
  noteTask: (taskId: string, message: string) => {
    const task = get().kanban.tasks[taskId]
    if (!task) return
    const note = message.trim()
    if (!note) return
    get().updateTask(taskId, {
      resultSummary: [task.resultSummary, note].filter(Boolean).join('\n'),
      status: task.status === 'done' ? task.status : 'in-progress',
    })
  },
  selectTask: (sessionId: string, taskId: string | null) => {
    set((state) => ({ selectedTaskId: { ...state.selectedTaskId, [sessionId]: taskId } }))
  },
  setKanbanLayout: (sessionId: string, json: string | null) => {
    set((state) => {
      const kanbanLayouts = { ...state.kanbanLayouts }
      if (json) kanbanLayouts[sessionId] = json
      else delete kanbanLayouts[sessionId]
      return { kanbanLayouts }
    })
    persistCurrentKanban(get(), sessionId)
  },
  setOrchestratorPane: (sessionId: string, paneId: string) => {
    set((state) => ({ orchestratorPaneIds: { ...state.orchestratorPaneIds, [sessionId]: paneId } }))
    persistCurrentKanban(get(), sessionId)
  },
  setHermesGateway: (sessionId: string, patch: Partial<HermesGatewayConfig>) => {
    set((state) => {
      const current = state.hermesGateways[sessionId] ?? defaultHermesGateway(patch.platform)
      return { hermesGateways: { ...state.hermesGateways, [sessionId]: { ...current, ...patch } } }
    })
    persistCurrentKanban(get(), sessionId)
  },
  addHermesUserMessage: (sessionId: string, text: string) => {
    set((state) => ({
      hermesTranscript: {
        ...state.hermesTranscript,
        [sessionId]: [...(state.hermesTranscript[sessionId] ?? []), { role: 'user', text, thoughts: '', toolCalls: [] }],
      },
    }))
  },
  appendHermesText: (sessionId: string, kind: HermesTextPartKind, text: string) => {
    set((state) => ({
      hermesTranscript: {
        ...state.hermesTranscript,
        [sessionId]: updateLastAssistantTurn(state.hermesTranscript[sessionId] ?? [], (turn) => appendHermesTextPart(turn, kind, text)),
      },
    }))
  },
  addHermesToolCall: (sessionId: string, call: Omit<HermesToolCallView, 'content'> & { content?: string }) => {
    set((state) => ({
      hermesTranscript: {
        ...state.hermesTranscript,
        [sessionId]: updateLastAssistantTurn(state.hermesTranscript[sessionId] ?? [], (turn) => appendHermesToolCallPart(turn, call)),
      },
    }))
  },
  updateHermesToolCall: (sessionId: string, toolCallId: string, patch: { status: string; content: string }) => {
    set((state) => ({
      hermesTranscript: {
        ...state.hermesTranscript,
        [sessionId]: updateLastAssistantTurn(state.hermesTranscript[sessionId] ?? [], (turn) => ({
          ...turn,
          toolCalls: turn.toolCalls.map((call) => call.id === toolCallId ? { ...call, ...patch } : call),
        })),
      },
    }))
  },
  setHermesPlan: (sessionId: string, entries: HermesPlanEntry[]) => {
    set((state) => ({
      hermesTranscript: {
        ...state.hermesTranscript,
        [sessionId]: updateLastAssistantTurn(state.hermesTranscript[sessionId] ?? [], (turn) => updateHermesPlanPart(turn, entries)),
      },
    }))
  },
  setHermesUsage: (sessionId: string, usage: { size: number; used: number }) => {
    set((state) => ({ hermesUsage: { ...state.hermesUsage, [sessionId]: usage } }))
  },
  addHermesPermission: (sessionId: string, permission: PendingPermission) => {
    set((state) => ({
      hermesPermissions: {
        ...state.hermesPermissions,
        [sessionId]: [...(state.hermesPermissions[sessionId] ?? []), permission],
      },
    }))
  },
  resolveHermesPermission: (sessionId: string, requestId: number) => {
    set((state) => ({
      hermesPermissions: {
        ...state.hermesPermissions,
        [sessionId]: (state.hermesPermissions[sessionId] ?? []).filter((permission) => permission.requestId !== requestId),
      },
    }))
  },
  endHermesTurn: (sessionId: string) => {
    set((state) => ({ hermesStatus: { ...state.hermesStatus, [sessionId]: 'running' } }))
  },
  setHermesModels: (sessionId: string, models: { available: HermesModelInfo[]; current: string }) => {
    set((state) => ({ hermesModels: { ...state.hermesModels, [sessionId]: models } }))
  },
  setHermesStatus: (sessionId: string, status: HermesStatus) => {
    set((state) => ({ hermesStatus: { ...state.hermesStatus, [sessionId]: status } }))
  },
  setHermesCurrentSession: (sessionId: string, acpSessionId: string) => {
    set((state) => ({ hermesCurrentSession: { ...state.hermesCurrentSession, [sessionId]: acpSessionId } }))
  },
  setHermesSessions: (sessionId: string, sessions: HermesSessionInfo[]) => {
    set((state) => ({ hermesSessions: { ...state.hermesSessions, [sessionId]: sessions } }))
  },
  setHermesTranscript: (sessionId: string, turns: HermesTurn[]) => {
    set((state) => ({ hermesTranscript: { ...state.hermesTranscript, [sessionId]: turns } }))
  },
  enqueueHermesPrompt: (sessionId, text) => {
    set((state) => ({
      hermesPendingPrompts: {
        ...state.hermesPendingPrompts,
        [sessionId]: [...(state.hermesPendingPrompts[sessionId] ?? []), text],
      },
    }))
  },
  takeHermesPrompt: (sessionId) => {
    const queue = get().hermesPendingPrompts[sessionId] ?? []
    if (queue.length === 0) return undefined
    const [next, ...rest] = queue
    set((state) => ({ hermesPendingPrompts: { ...state.hermesPendingPrompts, [sessionId]: rest } }))
    return next
  },
  resetHermesTranscript: (sessionId: string) => {
    set((state) => {
      const hermesTranscript = { ...state.hermesTranscript }
      const hermesPermissions = { ...state.hermesPermissions }
      const hermesUsage = { ...state.hermesUsage }
      delete hermesTranscript[sessionId]
      delete hermesPermissions[sessionId]
      delete hermesUsage[sessionId]
      return { hermesTranscript, hermesPermissions, hermesUsage }
    })
  },
  applyBoardSnapshot: (sessionId: string, json: string) => {
    const snapshot = parseBoardSnapshot(sessionId, json)
    if (!snapshot) return
    const snapshotJson = JSON.stringify(snapshot)
    if (JSON.stringify(boardSnapshotForSession(get().kanban, sessionId)) === snapshotJson) return
    set((state) => {
      const previousIds = new Set(state.kanban.taskOrder[sessionId] ?? [])
      const tasks = { ...state.kanban.tasks }
      for (const taskId of previousIds) delete tasks[taskId]
      for (const [taskId, task] of Object.entries(snapshot.tasks)) tasks[taskId] = task
      return {
        kanban: {
          tasks,
          taskOrder: { ...state.kanban.taskOrder, [sessionId]: snapshot.taskOrder },
        },
      }
    })
    persistCurrentKanban(get())
  },
  setPaneRole: (paneId: string, role: string) => {
    const settings = get().settings
    const paneRoles = { ...settings.paneRoles }
    const trimmed = role.trim()
    if (trimmed) paneRoles[paneId] = trimmed
    else delete paneRoles[paneId]
    if (settings.paneRoles[paneId] === paneRoles[paneId]) return
    const nextSettings = { ...settings, paneRoles }
    persistSettings(nextSettings)
    set({ settings: nextSettings })
  },
  applyPaneConfiguration: (paneId, patch) => {
    if (patch.role !== undefined) get().setPaneRole(paneId, patch.role ?? '')
    if (patch.title === undefined) return
    const normalized = normalizePaneTitle(patch.title ?? '')
    if (!normalized) return
    if (get().panes[paneId]?.config.title === normalized) return
    set((state) => {
      const pane = state.panes[paneId]
      if (!pane) return {}
      return {
        panes: {
          ...state.panes,
          [paneId]: {
            ...pane,
            config: { ...pane.config, title: normalized },
          },
        },
        manualPaneTitles: { ...state.manualPaneTitles, [paneId]: true },
      }
    })
  },
}))

function withoutPaneKey<T>(record: Record<string, T>, paneId: string): Record<string, T> {
  if (!(paneId in record)) return record
  const next = { ...record }
  delete next[paneId]
  return next
}

function withoutPaneKeys<T>(record: Record<string, T>, paneIds: readonly string[]): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const paneId of paneIds) {
    if (!(paneId in record)) continue
    next ??= { ...record }
    delete next[paneId]
  }
  return next ?? record
}

function prunePaneCompletionHighlights(highlights: Record<string, PaneCompletionHighlight>, panes: Record<string, PaneMeta>): Record<string, PaneCompletionHighlight> {
  const nextEntries = Object.entries(highlights).filter(([paneId]) => panes[paneId]?.alive)
  if (nextEntries.length === Object.keys(highlights).length) return highlights
  return Object.fromEntries(nextEntries)
}

const terminalCapabilityEnv: [string, string][] = [
  ['TERM', 'xterm-256color'],
  ['COLORTERM', 'truecolor'],
  ['FORCE_COLOR', '1'],
  ['CLICOLOR_FORCE', '1'],
  ['TERM_PROGRAM', 'AgenticWorkspaceTerminal'],
]

type TauriWindow = Window & { __TAURI_INTERNALS__?: { metadata?: { currentExe?: string } } }

function terminalAgentEnv(env: [string, string][], sessionId: string, paneId: string): [string, string][] {
  const filtered = env.filter(([key]) => !['AWT_SESSION_ID', 'AWT_PANE_ID', 'AWT_APP_EXE'].some((reserved) => key.toLowerCase() === reserved.toLowerCase()))
  return keepLastEnvValue([
    ...terminalCapabilityEnv,
    ...filtered,
    ['AWT_SESSION_ID', sessionId],
    ['AWT_PANE_ID', paneId],
    ['AWT_APP_EXE', (window as TauriWindow).__TAURI_INTERNALS__?.metadata?.currentExe ?? 'app.exe'],
  ])
}

function keepLastEnvValue(env: [string, string][]): [string, string][] {
  const seen = new Set<string>()
  const next: [string, string][] = []
  for (let index = env.length - 1; index >= 0; index -= 1) {
    const [key, value] = env[index]
    const normalized = key.toLowerCase()
    if (seen.has(normalized)) continue
    seen.add(normalized)
    next.push([key, value])
  }
  return next.reverse()
}

function normalizeWorkspaceFolder(folder: string | null | undefined): string | null {
  const trimmed = folder?.trim()
  return trimmed ? trimmed : null
}

function loadSettings(): Settings {
  try {
    const raw = window.localStorage.getItem('awt:settings')
    if (!raw) return defaultSettings
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return defaultSettings
  }
}

function persistSettings(settings: Settings): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('awt:settings', JSON.stringify(settings))
  }
}

function persistCurrentKanban(state: WorkspaceState, sessionIds?: string | readonly string[]): void {
  persistKanban({
    data: state.kanban,
    viewModes: state.viewModes,
    kanbanLayouts: state.kanbanLayouts,
    orchestratorPaneIds: state.orchestratorPaneIds,
    hermesGateways: state.hermesGateways,
    workspaceTodos: state.workspaceTodos,
    workspaceTodoNotes: state.workspaceTodoNotes,
  })
  if (sessionIds !== undefined) mirrorBoardsToDisk(state, sessionIds)
}

function workspaceLayoutForSession(state: WorkspaceState, sessionId: string): WorkspaceLayoutState {
  return state.workspaceLayouts[sessionId] ?? normalizeWorkspaceLayoutState(state.layoutJson, {
    terminalPaneIds: Object.keys(state.panes),
    legacyKanbanLayoutJson: state.kanbanLayouts[sessionId],
  })
}

async function persistWorkspaceLayout(sessionId: string, layout: WorkspaceLayoutState): Promise<void> {
  await invoke('save_layout', { sessionId, layoutJson: serializeWorkspaceLayoutState(layout) })
}

function mirrorBoardsToDisk(state: WorkspaceState, sessionIds: string | readonly string[]): void {
  const ids = Array.isArray(sessionIds) ? sessionIds : [sessionIds]
  for (const sessionId of ids) {
    if (!(sessionId in state.kanban.taskOrder)) continue
    const timer = boardMirrorTimers.get(sessionId)
    if (timer !== undefined) globalThis.clearTimeout(timer)
    const nextTimer = globalThis.setTimeout(() => {
      boardMirrorTimers.delete(sessionId)
      const latest = useWorkspaceStore.getState()
      if (!(sessionId in latest.kanban.taskOrder)) return
      const json = JSON.stringify(boardSnapshotForSession(latest.kanban, sessionId))
      void invoke('board_write', { sessionId, json })
    }, boardMirrorDelayMs)
    boardMirrorTimers.set(sessionId, nextTimer)
  }
}

function boardSnapshotForSession(kanban: KanbanData, sessionId: string): { tasks: Record<string, Task>; taskOrder: string[] } {
  const taskOrder = kanban.taskOrder[sessionId] ?? []
  return {
    tasks: Object.fromEntries(taskOrder.flatMap((taskId) => {
      const task = kanban.tasks[taskId]
      return task ? [[taskId, task]] : []
    })),
    taskOrder,
  }
}

function parseBoardSnapshot(sessionId: string, json: string): { tasks: Record<string, Task>; taskOrder: string[] } | null {
  try {
    const parsed = JSON.parse(json) as { tasks?: unknown; taskOrder?: unknown }
    if (typeof parsed.tasks !== 'object' || parsed.tasks === null || Array.isArray(parsed.tasks) || !Array.isArray(parsed.taskOrder)) return null
    const tasks: Record<string, Task> = {}
    for (const [taskId, value] of Object.entries(parsed.tasks)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
      const record = value as Partial<Task>
      if (typeof record.title !== 'string' || typeof record.description !== 'string') continue
      const status = isTaskStatus(record.status) ? record.status : 'pending'
      const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Date.now()
      const updatedAt = typeof record.updatedAt === 'number' ? record.updatedAt : Date.now()
      tasks[taskId] = {
        id: taskId,
        sessionId,
        title: record.title,
        description: record.description,
        status,
        assignedPaneId: typeof record.assignedPaneId === 'string' ? record.assignedPaneId : undefined,
        assignedRole: typeof record.assignedRole === 'string' ? record.assignedRole : undefined,
        baselineRef: typeof record.baselineRef === 'string' ? record.baselineRef : undefined,
        worktreePath: typeof record.worktreePath === 'string' ? record.worktreePath : undefined,
        commitMessage: typeof record.commitMessage === 'string' ? record.commitMessage : undefined,
        resultSummary: typeof record.resultSummary === 'string' ? record.resultSummary : undefined,
        statusTimestamps: normalizeTaskStatusTimestamps(record.statusTimestamps, { createdAt, status, updatedAt }),
        createdAt,
        updatedAt,
      }
    }
    return { tasks, taskOrder: parsed.taskOrder.filter((taskId): taskId is string => typeof taskId === 'string' && taskId in tasks) }
  } catch {
    return null
  }
}

function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'pending' || value === 'assigned' || value === 'in-progress' || value === 'done'
}

function normalizeTaskStatusTimestamps(value: unknown, ctx: { createdAt: number; status: TaskStatus; updatedAt: number }): Partial<Record<TaskStatus, number>> {
  const out: Partial<Record<TaskStatus, number>> = {}
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    for (const status of ['pending', 'assigned', 'in-progress', 'done'] as TaskStatus[]) {
      const ts = record[status]
      if (typeof ts === 'number' && Number.isFinite(ts)) out[status] = ts
    }
  }
  if (Object.keys(out).length === 0) {
    out.pending = ctx.createdAt
    out[ctx.status] = ctx.updatedAt
  }
  return out
}
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms))
}

function updateLastAssistantTurn(turns: HermesTurn[], update: (turn: HermesTurn) => HermesTurn): HermesTurn[] {
  const last = turns[turns.length - 1]
  if (!last || last.role !== 'assistant') {
    return [...turns, update(createAssistantTurn())]
  }
  return [...turns.slice(0, -1), update(last)]
}

function createAssistantTurn(): HermesTurn {
  return { role: 'assistant', text: '', thoughts: '', toolCalls: [], parts: [] }
}

function appendHermesTextPart(turn: HermesTurn, kind: HermesTextPartKind, text: string): HermesTurn {
  const parts = transcriptPartsForUpdate(turn)
  const last = parts[parts.length - 1]
  const nextParts: HermesTranscriptPart[] = last?.kind === kind
    ? [...parts.slice(0, -1), { kind, text: last.text + text }]
    : [...parts, { kind, text }]
  return kind === 'message'
    ? { ...turn, text: turn.text + text, parts: nextParts }
    : { ...turn, thoughts: turn.thoughts + text, parts: nextParts }
}

function appendHermesToolCallPart(turn: HermesTurn, call: Omit<HermesToolCallView, 'content'> & { content?: string }): HermesTurn {
  const nextCall: HermesToolCallView = { ...call, content: call.content ?? '' }
  return {
    ...turn,
    toolCalls: [...turn.toolCalls, nextCall],
    parts: [...transcriptPartsForUpdate(turn), { kind: 'toolCall', toolCallId: nextCall.id }],
  }
}

function updateHermesPlanPart(turn: HermesTurn, entries: HermesPlanEntry[]): HermesTurn {
  const parts = transcriptPartsForUpdate(turn)
  const planPart: HermesTranscriptPart = { kind: 'plan', entries }
  const index = parts.findIndex((part) => part.kind === 'plan')
  const nextParts = index >= 0
    ? parts.map((part, current) => current === index ? planPart : part)
    : [...parts, planPart]
  return { ...turn, plan: entries, parts: nextParts }
}

function transcriptPartsForUpdate(turn: HermesTurn): HermesTranscriptPart[] {
  if (turn.parts) return [...turn.parts]
  const parts: HermesTranscriptPart[] = []
  if (turn.text) parts.push({ kind: 'message', text: turn.text })
  if (turn.thoughts) parts.push({ kind: 'thought', text: turn.thoughts })
  if (turn.plan?.length) parts.push({ kind: 'plan', entries: turn.plan })
  for (const call of turn.toolCalls) parts.push({ kind: 'toolCall', toolCallId: call.id })
  return parts
}

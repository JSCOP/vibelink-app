import { invoke } from '@tauri-apps/api/core'
import { sendToPane, submitAgentPrompt } from '../ipc/panes'
import { deactivateLicenseDevice, getLicenseStatus, revalidateLicense, signOutAccount as signOutAccountIpc } from '../ipc/license'
import { getAgentCliStatus, type AgentCliStatus } from '../ipc/agents'
import { create } from 'zustand'
import type { AttachedSession, HermesModelInfo, HermesRuntimeStatus, LicenseStatus, PaneConfig, PaneMeta, SessionMeta, Task, TaskStatus, WorkspaceBrief, WorktreeInfo } from '../ipc/types'
import { defaultSettings, isAgentPane, normalizeSettings, paneOverridesFromProfile, profileById, selectedProfileForWorkspace } from './profiles'
import { normalizePaneTitle, shouldApplyAutoTitle, type ManualPaneTitleMap } from './paneTitles'
import type { Settings } from './profiles'
import type { KanbanData } from './kanban'
import { composeAgentTaskPrompt, composeTaskPrompt } from './kanban'
import { loadKanban, mergeLegacyTasksIntoBoard, persistKanban, type ViewMode } from './kanbanPersistence'
import type { WorkspaceTodoItem, WorkspaceTodoLists, WorkspaceTodoNotes } from './workspaceTodos'
import type { HermesModelsState, HermesPlanEntry, HermesSessionInfo, HermesStatus, HermesTextPartKind, HermesToolCallView, HermesTranscriptPart, HermesTurn, PendingPermission } from './hermes'
import {
  normalizeWorkspaceLayoutState,
  replaceWorkspaceLayoutPage,
  resetWorkspaceLayoutPage,
  serializeWorkspaceLayoutState,
  setActiveWorkspaceLayoutPage,
  type WorkspaceLayoutState,
} from '../layout/workspaceLayoutModel'

const initialKanban = loadKanban()
const migratedLegacySessions = new Set<string>()
const paneReviewMarkersStorageKey = 'vibelink:paneReviewMarkers'


type SpawnPaneOptions = Partial<PaneConfig> & { profileId?: string | null }

type Status = 'booting' | 'ready' | 'error'
export type PaneCompletionSource = 'agent-response' | 'task-done'
export type PaneCompletionHighlight = { completedAt: number; source: PaneCompletionSource; sessionId: string }
export type PaneReviewMarker = { reviewedAt: number; sessionId: string }


type WorkspaceState = {
  sessions: SessionMeta[]
  activeSessionId?: string
  panes: Record<string, PaneMeta>
  layoutJson?: string | null
  manualPaneTitles: ManualPaneTitleMap
  status: Status
  error?: string
  license: { ready: boolean; status: LicenseStatus | null }
  agentClis: AgentCliStatus[]
  settings: Settings
  kanban: KanbanData
  viewModes: Record<string, ViewMode>
  kanbanLayouts: Record<string, string>
  workspaceLayouts: Record<string, WorkspaceLayoutState>
  orchestratorPaneIds: Record<string, string>
  workspaceTodos: WorkspaceTodoLists
  workspaceTodoNotes: WorkspaceTodoNotes
  workspaceBriefs: Record<string, WorkspaceBrief | null>
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
  paneReviewMarkers: Record<string, PaneReviewMarker>
  capturesByPane: Record<string, string[]>
  recentCaptures: string[]
  setActivePaneId: (paneId?: string) => void
  markPaneResponseComplete: (paneId: string, source?: PaneCompletionSource) => void
  clearPaneCompletionHighlight: (paneId: string) => void
  togglePaneReviewed: (paneId: string) => void
  recordCapture: (paneId: string | undefined, path: string) => void
  resolveCaptureMarker: (paneId: string, n: number) => string | undefined
  refreshLicense: () => Promise<LicenseStatus>
  revalidateLicense: () => Promise<LicenseStatus>
  deactivateLicenseDevice: (activationId: string) => Promise<LicenseStatus>
  signOutAccount: () => Promise<LicenseStatus>
  bootstrap: () => Promise<void>
  refreshAgentClis: () => Promise<AgentCliStatus[]>
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
  resetLayoutPage: (sessionId: string, pageId: string) => void
  clearSession: (sessionId: string) => Promise<void>
  renamePaneTitle: (paneId: string, title: string, source: 'manual' | 'auto') => Promise<void>
  applyTerminalTitle: (paneId: string, title: string) => Promise<void>
  setError: (error: string) => void
  clearError: () => void
  dismissError: () => void
  prepareSetupWizardRun: () => void
  updateSettings: (settings: Partial<Settings>) => void
  toggleTerminalTabsVisible: () => void
  reorderWorkspaces: (orderedIds: string[]) => void
  setDefaultProfile: (profileId: string) => void
  setViewMode: (sessionId: string, mode: ViewMode) => void
  createTask: (sessionId: string, input: { title: string; description: string }) => Promise<Task>
  addWorkspaceTodo: (sessionId: string, text: string) => WorkspaceTodoItem | null
  deleteWorkspaceTodo: (sessionId: string, todoId: string) => void
  deleteWorkspaceTodos: (sessionId: string, todoIds: string[]) => void
  updateWorkspaceTodoText: (sessionId: string, todoId: string, text: string) => void
  setWorkspaceTodoNote: (sessionId: string, note: string) => void
  injectWorkspaceTodosToKanban: (sessionId: string, todoIds: string[]) => Promise<Task[]>
  updateTask: (id: string, patch: Partial<Task>) => Promise<Task | undefined>
  deleteTask: (id: string) => Promise<void>
  moveTask: (id: string, status: TaskStatus) => Promise<void>
  assignTask: (taskId: string, paneId: string, options?: { isolated?: boolean }) => Promise<void>
  markTaskDone: (taskId: string, result?: { commitMessage?: string; resultSummary?: string }) => Promise<void>
  noteTask: (taskId: string, message: string) => Promise<void>
  selectTask: (sessionId: string, taskId: string | null) => void
  setKanbanLayout: (sessionId: string, json: string | null) => void
  setOrchestratorPane: (sessionId: string, paneId: string) => void
  setPaneRole: (paneId: string, role: string) => void
  applyPaneConfiguration: (paneId: string, patch: { title?: string | null; role?: string | null }) => void
  setWorkspaceBrief: (sessionId: string, purpose: string, notes: string) => Promise<WorkspaceBrief>
  addHermesUserMessage: (sessionId: string, text: string) => void
  appendHermesText: (sessionId: string, kind: HermesTextPartKind, text: string) => void
  sendAgentPrompt: (sessionId: string, text: string) => Promise<void>
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
  license: { ready: false, status: null },
  agentClis: [],
  kanban: initialKanban.data,
  viewModes: initialKanban.viewModes,
  kanbanLayouts: initialKanban.kanbanLayouts,
  workspaceLayouts: {},
  orchestratorPaneIds: initialKanban.orchestratorPaneIds,
  workspaceTodos: initialKanban.workspaceTodos,
  workspaceTodoNotes: initialKanban.workspaceTodoNotes,
  hermesStatus: {},
  workspaceBriefs: {},
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
  paneReviewMarkers: loadPaneReviewMarkers(),
  capturesByPane: {},
  recentCaptures: [],

  bootstrap: async () => {
    set({ status: 'booting', error: undefined, license: { ready: false, status: null } })
    try {
      const [licenseStatus, agentClis] = await Promise.all([
        getLicenseStatus(),
        getAgentCliStatus().catch(() => []),
      ])
      set({ license: { ready: true, status: licenseStatus }, agentClis })
      let sessions = await invoke<SessionMeta[]>('list_sessions')
      if (sessions.length === 0) {
        const created = await invoke<SessionMeta>('create_session', { name: 'Workspace 1' })
        sessions = [created]
      }

      set({ sessions, activeSessionId: undefined, panes: {}, layoutJson: null, status: 'ready' })
      if (licenseStatus.email) void get().revalidateLicense()
    } catch (error) {
      set({ status: 'error', error: String(error) })
    }
  },

  refreshAgentClis: async () => {
    const agentClis = await getAgentCliStatus()
    set({ agentClis })
    return agentClis
  },

  refreshLicense: async () => {
    const status = await getLicenseStatus()
    set({ license: { ready: true, status } })
    return status
  },


  revalidateLicense: async () => {
    const status = await revalidateLicense()
    set({ license: { ready: true, status } })
    return status
  },

  deactivateLicenseDevice: async (activationId: string) => {
    const status = await deactivateLicenseDevice(activationId)
    set({ license: { ready: true, status } })
    return status
  },

  signOutAccount: async () => {
    const status = await signOutAccountIpc()
    set({ license: { ready: true, status } })
    return status
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
    const previousSessionId = get().activeSessionId
    const attached = await invoke<AttachedSession>('attach_session', { sessionId })
    const panes = Object.fromEntries(attached.panes.map((pane) => [pane.id, pane]))
    const workspaceLayout = normalizeWorkspaceLayoutState(attached.layoutJson, {
      terminalPaneIds: attached.panes.map((pane) => pane.id),
      legacyKanbanLayoutJson: get().kanbanLayouts[sessionId],
    })
    window.localStorage.setItem('vibelink:lastActiveSessionId', sessionId)
    set((state) => ({
      activeSessionId: sessionId,
      activePaneId: undefined,
      panes,
      paneCompletionHighlights: reconcilePaneCompletionHighlights(state.paneCompletionHighlights, sessionId, panes),
      paneReviewMarkers: reconcilePaneReviewMarkers(state.paneReviewMarkers, sessionId, panes),
      layoutJson: serializeWorkspaceLayoutState(workspaceLayout),
      workspaceLayouts: { ...state.workspaceLayouts, [sessionId]: workspaceLayout },
    }))
    if (get().license.ready && get().license.status?.entitled) {
      const boardJson = await invoke<string>('board_read', { sessionId })
      const migratedJson = await migrateLegacyTasks(sessionId, boardJson)
      get().applyBoardSnapshot(sessionId, migratedJson)
    }
    if (previousSessionId && previousSessionId !== sessionId) {
      void invoke('detach_session', { sessionId: previousSessionId }).catch(() => {})
    }
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
    persistCurrentKanban(get())
    return created
  },

  renameSession: async (sessionId: string, name: string) => {
    await invoke('rename_session', { sessionId, name })
    await get().refreshSessions()
  },

  deleteSession: async (sessionId: string) => {
    await invoke('delete_session', { sessionId })
    await invoke('agent_workspace_cleanup', { sessionId })
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
      const workspaceTodos = { ...state.workspaceTodos }
      const workspaceTodoNotes = { ...state.workspaceTodoNotes }
      const workspaceBriefs = { ...state.workspaceBriefs }
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
      const paneCompletionHighlights = withoutSessionCompletionHighlights(state.paneCompletionHighlights, sessionId)
      const paneReviewMarkers = withoutSessionReviewMarkers(state.paneReviewMarkers, sessionId)
      const paneRoles = withoutPaneKeys(state.settings.paneRoles, deletedPaneIds)
      const settings = paneRoles === state.settings.paneRoles ? state.settings : { ...state.settings, paneRoles }
      delete viewModes[sessionId]
      delete kanbanLayouts[sessionId]
      delete workspaceLayouts[sessionId]
      delete orchestratorPaneIds[sessionId]
      delete selectedTaskId[sessionId]
      delete workspaceTodos[sessionId]
      delete workspaceTodoNotes[sessionId]
      delete workspaceBriefs[sessionId]
      delete hermesStatus[sessionId]
      delete hermesTranscript[sessionId]
      delete hermesPermissions[sessionId]
      delete hermesUsage[sessionId]
      delete hermesModels[sessionId]
      delete hermesPendingPrompts[sessionId]
      delete hermesCurrentSession[sessionId]
      delete hermesSessions[sessionId]
      return { sessions, kanban: { tasks, taskOrder }, viewModes, kanbanLayouts, workspaceLayouts, orchestratorPaneIds, selectedTaskId, workspaceTodos, workspaceTodoNotes, workspaceBriefs, hermesStatus, hermesTranscript, hermesPermissions, hermesUsage, hermesModels, hermesPendingPrompts, hermesCurrentSession, hermesSessions, manualPaneTitles, capturesByPane, paneCompletionHighlights, paneReviewMarkers, settings }
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
        paneReviewMarkers: withoutPaneKey(state.paneReviewMarkers, paneId),
      }
    })
    await get().refreshSessions()
  },

  clearSession: async (sessionId: string) => {
    await invoke('clear_session', { sessionId })
    set((state) => ({
      panes: state.activeSessionId === sessionId ? {} : state.panes,
      activePaneId: state.activeSessionId === sessionId ? undefined : state.activePaneId,
      paneCompletionHighlights: withoutSessionCompletionHighlights(state.paneCompletionHighlights, sessionId),
      paneReviewMarkers: withoutSessionReviewMarkers(state.paneReviewMarkers, sessionId),
    }))
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
  setActivePaneId: (paneId) => set({ activePaneId: paneId }),
  markPaneResponseComplete: (paneId, source = 'agent-response') => set((state) => {
    const pane = state.panes[paneId]
    const sessionId = state.activeSessionId
    if (!sessionId || !pane?.alive || !isAgentPane(pane, state.settings)) return {}
    return {
      paneCompletionHighlights: {
        ...state.paneCompletionHighlights,
        [paneId]: { completedAt: Date.now(), source, sessionId },
      },
    }
  }),
  clearPaneCompletionHighlight: (paneId) => set((state) => {
    if (!state.paneCompletionHighlights[paneId]) return {}
    return { paneCompletionHighlights: withoutPaneKey(state.paneCompletionHighlights, paneId) }
  }),
  togglePaneReviewed: (paneId) => set((state) => {
    if (state.paneReviewMarkers[paneId]) {
      return { paneReviewMarkers: withoutPaneKey(state.paneReviewMarkers, paneId) }
    }
    const pane = state.panes[paneId]
    const sessionId = state.activeSessionId
    if (!sessionId || !pane?.alive) return {}
    return {
      paneReviewMarkers: {
        ...state.paneReviewMarkers,
        [paneId]: { reviewedAt: Date.now(), sessionId },
      },
      paneCompletionHighlights: withoutPaneKey(state.paneCompletionHighlights, paneId),
    }
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
  prepareSetupWizardRun: () => {
    set((state) => ({
      settings: {
        ...state.settings,
        setupWizard: { ...state.settings.setupWizard, completedAt: null },
      },
    }))
  },
  toggleTerminalTabsVisible: () => {
    get().updateSettings({ terminalTabsVisible: !get().settings.terminalTabsVisible })
  },
  reorderWorkspaces: (orderedIds: string[]) => {
    get().updateSettings({ workspaceOrder: orderedIds })
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
    persistCurrentKanban(get())
  },
  createTask: async (sessionId: string, input: { title: string; description: string }) => {
    requireProForTaskMutation(get())
    const task = await invoke<Task>('board_task_create', {
      sessionId,
      title: input.title.trim(),
      description: input.description,
    })
    set((state) => ({
      kanban: upsertTask(state.kanban, task),
      selectedTaskId: { ...state.selectedTaskId, [sessionId]: task.id },
    }))
    return task
  },
  addWorkspaceTodo: (sessionId, text) => {
    if (get().license.ready && !get().license.status?.entitled) { set({ error: 'VibeLink Pro license required.' }); return null }
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
    persistCurrentKanban(get())
    return todo
  },
  deleteWorkspaceTodo: (sessionId, todoId) => {
    get().deleteWorkspaceTodos(sessionId, [todoId])
  },
  deleteWorkspaceTodos: (sessionId, todoIds) => {
    if (get().license.ready && !get().license.status?.entitled) { set({ error: 'VibeLink Pro license required.' }); return }
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
    persistCurrentKanban(get())
  },
  updateWorkspaceTodoText: (sessionId, todoId, text) => {
    if (get().license.ready && !get().license.status?.entitled) { set({ error: 'VibeLink Pro license required.' }); return }
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
    persistCurrentKanban(get())
  },
  setWorkspaceTodoNote: (sessionId, note) => {
    if (get().license.ready && !get().license.status?.entitled) { set({ error: 'VibeLink Pro license required.' }); return }
    set((state) => {
      const workspaceTodoNotes = { ...(state.workspaceTodoNotes ?? {}) }
      if (note.trim()) workspaceTodoNotes[sessionId] = note
      else delete workspaceTodoNotes[sessionId]
      return { workspaceTodoNotes }
    })
    persistCurrentKanban(get())
  },
  injectWorkspaceTodosToKanban: async (sessionId, todoIds) => {
    requireProForTaskMutation(get())
    const state = get()
    const ids = new Set(todoIds)
    const todos = ((state.workspaceTodos ?? {})[sessionId] ?? []).filter((todo) => ids.has(todo.id) && !todo.kanbanTaskId)
    if (todos.length === 0) return []
    const note = (state.workspaceTodoNotes ?? {})[sessionId]?.trim() ?? ''
    const tasks: Task[] = []
    for (const todo of todos) {
      tasks.push(await get().createTask(sessionId, { title: todo.text, description: note }))
    }
    const now = Date.now()
    const taskByTodoId = Object.fromEntries(todos.map((todo, index) => [todo.id, tasks[index].id]))
    set((current) => ({
      workspaceTodos: {
        ...(current.workspaceTodos ?? {}),
        [sessionId]: ((current.workspaceTodos ?? {})[sessionId] ?? []).map((todo) => taskByTodoId[todo.id] ? { ...todo, kanbanTaskId: taskByTodoId[todo.id], updatedAt: now } : todo),
      },
    }))
    persistCurrentKanban(get())
    return tasks
  },
  updateTask: async (id: string, patch: Partial<Task>) => {
    requireProForTaskMutation(get())
    const sessionId = get().kanban.tasks[id]?.sessionId
    if (!sessionId) return undefined
    const task = await invoke<Task>('board_task_update', {
      sessionId,
      taskId: id,
      patch: taskPatchForNative(patch),
    })
    set((state) => ({ kanban: upsertTask(state.kanban, task) }))
    return task
  },
  deleteTask: async (id: string) => {
    requireProForTaskMutation(get())
    const task = get().kanban.tasks[id]
    if (!task) return
    await invoke('board_task_delete', { sessionId: task.sessionId, taskId: id })
    set((state) => ({
      kanban: removeTask(state.kanban, task),
      selectedTaskId: state.selectedTaskId[task.sessionId] === id
        ? { ...state.selectedTaskId, [task.sessionId]: null }
        : state.selectedTaskId,
    }))
  },
  moveTask: async (id: string, status: TaskStatus) => {
    await get().updateTask(id, { status })
  },
  assignTask: async (taskId: string, paneId: string, options?: { isolated?: boolean }) => {
    if (get().license.ready && !get().license.status?.entitled) { set({ error: 'VibeLink Pro license required.' }); return }
    const task = get().kanban.tasks[taskId]
    if (!task) { set({ error: 'Cannot assign a missing task' }); return }
    const session = get().sessions.find((item) => item.id === task.sessionId)

    if (paneId === 'vibelink-agent') {
      const runtime = await invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: get().settings.hermesCommand || null })
      if (!runtime.detected) {
        set({ error: 'Hermes Agent is not installed. Install it from https://hermes-agent.nousresearch.com/ and re-check.' })
        return
      }
      if (session?.workspaceFolder) {
        try {
          if (options?.isolated) {
            const worktree = await invoke<WorktreeInfo>('git_worktree_create', { workspaceFolder: session.workspaceFolder, taskId })
            await get().updateTask(taskId, { worktreePath: worktree.worktreePath, baselineRef: 'HEAD' })
          } else {
            const baselineRef = await invoke<string>('git_snapshot_baseline', { workspaceFolder: session.workspaceFolder })
            await get().updateTask(taskId, { baselineRef })
          }
        } catch (baselineError) {
          const currentTask = get().kanban.tasks[taskId] ?? task
          const note = `Diff baseline unavailable: ${String(baselineError)}`
          await get().updateTask(taskId, { resultSummary: [currentTask.resultSummary, note].filter(Boolean).join('\n') })
        }
      }
      const assigned = await get().updateTask(taskId, { assignedPaneId: undefined, assignedRole: 'VibeLink Agent', status: 'assigned' })
      if (!assigned) return
      const latestTask = get().kanban.tasks[taskId] ?? assigned
      await get().sendAgentPrompt(task.sessionId, composeAgentTaskPrompt(latestTask, {
        brief: get().workspaceBriefs[task.sessionId],
        worktreePath: latestTask.worktreePath,
      }))
      await get().updateTask(taskId, { status: 'in-progress' })
      return
    }

    const pane = get().panes[paneId]
    if (!pane?.alive) { set({ error: 'Cannot assign task to a missing or closed pane' }); return }
    if (!isAgentPane(pane, get().settings)) {
      set({ error: 'Tasks can only be assigned to AI agent terminal profiles such as Codex, Claude, or OMP.' })
      return
    }
    const role = get().settings.paneRoles[paneId]
    const assigned = await get().updateTask(taskId, { assignedPaneId: paneId, assignedRole: role, status: 'assigned' })
    if (!assigned) return
    if (session?.workspaceFolder) {
      try {
        if (options?.isolated) {
          const worktree = await invoke<WorktreeInfo>('git_worktree_create', { workspaceFolder: session.workspaceFolder, taskId })
          await get().updateTask(taskId, { worktreePath: worktree.worktreePath, baselineRef: 'HEAD' })
        } else {
          const baselineRef = await invoke<string>('git_snapshot_baseline', { workspaceFolder: session.workspaceFolder })
          await get().updateTask(taskId, { baselineRef })
        }
      } catch (baselineError) {
        const currentTask = get().kanban.tasks[taskId] ?? task
        const note = `Diff baseline unavailable: ${String(baselineError)}`
        await get().updateTask(taskId, { resultSummary: [currentTask.resultSummary, note].filter(Boolean).join('\n') })
      }
    }
    const latestTask = get().kanban.tasks[taskId] ?? task
    await sendToPane(task.sessionId, paneId, composeTaskPrompt(latestTask, { role, sessionId: task.sessionId, brief: get().workspaceBriefs[task.sessionId] }), false)
    await delay(120)
    await submitAgentPrompt(task.sessionId, paneId)
    await get().updateTask(taskId, { status: 'in-progress' })
  },
  markTaskDone: async (taskId: string, result?: { commitMessage?: string; resultSummary?: string }) => {
    requireProForTaskMutation(get())
    const task = get().kanban.tasks[taskId]
    if (!task) return
    const updated = await invoke<Task>('board_task_done', {
      sessionId: task.sessionId,
      taskId,
      commitMsg: result?.commitMessage,
      resultSummary: result?.resultSummary,
    })
    set((state) => ({ kanban: upsertTask(state.kanban, updated) }))
  },
  noteTask: async (taskId: string, message: string) => {
    requireProForTaskMutation(get())
    const task = get().kanban.tasks[taskId]
    const note = message.trim()
    if (!task || !note) return
    const updated = await invoke<Task>('board_task_note', { sessionId: task.sessionId, taskId, message: note })
    set((state) => ({ kanban: upsertTask(state.kanban, updated) }))
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
    persistCurrentKanban(get())
  },
  setOrchestratorPane: (sessionId: string, paneId: string) => {
    if (get().license.ready && !get().license.status?.entitled) { set({ error: 'VibeLink Pro license required.' }); return }
    set((state) => ({ orchestratorPaneIds: { ...state.orchestratorPaneIds, [sessionId]: paneId } }))
    persistCurrentKanban(get())
  },
  sendAgentPrompt: async (sessionId: string, text: string) => {
    const prompt = text.trim()
    if (!prompt) return
    const runtime = await invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: get().settings.hermesCommand || null })
    if (!runtime.detected) {
      set({ error: 'Hermes Agent is not installed. Install it from https://hermes-agent.nousresearch.com/ and re-check.' })
      return
    }
    get().addHermesUserMessage(sessionId, prompt)
    get().enqueueHermesPrompt(sessionId, prompt)
    const status = get().hermesStatus[sessionId]
    if (status !== 'running' && status !== 'busy' && status !== 'starting') {
      const session = get().sessions.find((item) => item.id === sessionId)
      get().setHermesStatus(sessionId, 'starting')
      try {
        await invoke('hermes_start', {
          sessionId,
          commandOverride: get().settings.hermesCommand || null,
          workspaceFolder: session?.workspaceFolder ?? null,
        })
      } catch (startError) {
        get().setHermesStatus(sessionId, 'error')
        set({ error: String(startError) })
      }
    }
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
  setWorkspaceBrief: async (sessionId: string, purpose: string, notes: string) => {
    const brief = await invoke<WorkspaceBrief>('board_brief_set', { sessionId, purpose, notes })
    set((state) => ({ workspaceBriefs: { ...state.workspaceBriefs, [sessionId]: brief } }))
    return brief
  },
  applyBoardSnapshot: (sessionId: string, json: string) => {
    const snapshot = parseBoardSnapshot(sessionId, json)
    if (!snapshot) return
    const snapshotJson = JSON.stringify(snapshot)
    const currentJson = JSON.stringify({
      ...boardSnapshotForSession(get().kanban, sessionId),
      brief: get().workspaceBriefs[sessionId] ?? null,
    })
    if (currentJson === snapshotJson) return
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
        workspaceBriefs: { ...state.workspaceBriefs, [sessionId]: snapshot.brief },
      }
    })
    persistCurrentKanban(get())
  },
  setPaneRole: (paneId: string, role: string) => {
    const state = get()
    if (state.license.ready && !state.license.status?.entitled) return
    const paneRoles = { ...state.settings.paneRoles }
    const trimmed = role.trim()
    if (trimmed) paneRoles[paneId] = trimmed
    else delete paneRoles[paneId]
    if (state.settings.paneRoles[paneId] === paneRoles[paneId]) return
    const nextSettings = { ...state.settings, paneRoles }
    persistSettings(nextSettings)
    set((current) => ({
      settings: nextSettings,
      panes: current.panes[paneId] ? {
        ...current.panes,
        [paneId]: { ...current.panes[paneId], config: { ...current.panes[paneId].config, role: trimmed || null } },
      } : current.panes,
    }))
    if (state.activeSessionId) void invoke('set_pane_role', { sessionId: state.activeSessionId, paneId, role: trimmed || null }).catch((error) => get().setError(String(error)))
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

useWorkspaceStore.subscribe((state, previousState) => {
  if (state.paneReviewMarkers !== previousState.paneReviewMarkers) persistPaneReviewMarkers(state.paneReviewMarkers)
})

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

function reconcilePaneCompletionHighlights(
  highlights: Record<string, PaneCompletionHighlight>,
  sessionId: string,
  panes: Record<string, PaneMeta>,
): Record<string, PaneCompletionHighlight> {
  const nextEntries = Object.entries(highlights).filter(([paneId, highlight]) => highlight.sessionId !== sessionId || panes[paneId]?.alive)
  if (nextEntries.length === Object.keys(highlights).length) return highlights
  return Object.fromEntries(nextEntries)
}

function withoutSessionCompletionHighlights(
  highlights: Record<string, PaneCompletionHighlight>,
  sessionId: string,
): Record<string, PaneCompletionHighlight> {
  const nextEntries = Object.entries(highlights).filter(([, highlight]) => highlight.sessionId !== sessionId)
  if (nextEntries.length === Object.keys(highlights).length) return highlights
  return Object.fromEntries(nextEntries)
}

function reconcilePaneReviewMarkers(
  markers: Record<string, PaneReviewMarker>,
  sessionId: string,
  panes: Record<string, PaneMeta>,
): Record<string, PaneReviewMarker> {
  const nextEntries = Object.entries(markers).filter(([paneId, marker]) => marker.sessionId !== sessionId || panes[paneId]?.alive)
  if (nextEntries.length === Object.keys(markers).length) return markers
  return Object.fromEntries(nextEntries)
}

function withoutSessionReviewMarkers(
  markers: Record<string, PaneReviewMarker>,
  sessionId: string,
): Record<string, PaneReviewMarker> {
  const nextEntries = Object.entries(markers).filter(([, marker]) => marker.sessionId !== sessionId)
  if (nextEntries.length === Object.keys(markers).length) return markers
  return Object.fromEntries(nextEntries)
}

export function loadPaneReviewMarkers(storage?: Pick<Storage, 'getItem'> | null): Record<string, PaneReviewMarker> {
  const target = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
  if (!target) return {}
  try {
    const parsed = JSON.parse(target.getItem(paneReviewMarkersStorageKey) ?? '{}') as unknown
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, PaneReviewMarker] => {
      const [paneId, marker] = entry
      return paneId.length > 0 && isRecord(marker) && typeof marker.reviewedAt === 'number' && Number.isFinite(marker.reviewedAt) && typeof marker.sessionId === 'string' && marker.sessionId.length > 0
    }))
  } catch {
    return {}
  }
}

export function persistPaneReviewMarkers(markers: Record<string, PaneReviewMarker>, storage?: Pick<Storage, 'setItem' | 'removeItem'> | null): void {
  const target = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
  if (!target) return
  try {
    if (Object.keys(markers).length === 0) target.removeItem(paneReviewMarkersStorageKey)
    else target.setItem(paneReviewMarkersStorageKey, JSON.stringify(markers))
  } catch {
    // Review markers are convenience state; storage failures must not block terminal interaction.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function paneCompletionCountsBySession(highlights: Record<string, PaneCompletionHighlight>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const highlight of Object.values(highlights)) counts[highlight.sessionId] = (counts[highlight.sessionId] ?? 0) + 1
  return counts
}

const terminalCapabilityEnv: [string, string][] = [
  ['TERM', 'xterm-256color'],
  ['COLORTERM', 'truecolor'],
  ['FORCE_COLOR', '1'],
  ['CLICOLOR_FORCE', '1'],
  ['TERM_PROGRAM', 'VibeLink'],
]

type TauriWindow = Window & { __TAURI_INTERNALS__?: { metadata?: { currentExe?: string } } }

function terminalAgentEnv(env: [string, string][], sessionId: string, paneId: string): [string, string][] {
  const filtered = env.filter(([key]) => !['VIBELINK_SESSION_ID', 'VIBELINK_PANE_ID', 'VIBELINK_CLI_EXE'].some((reserved) => key.toLowerCase() === reserved.toLowerCase()))
  const appExecutable = (window as TauriWindow).__TAURI_INTERNALS__?.metadata?.currentExe
  const cliExecutable = appExecutable?.replace(/[^\\/]+$/, 'vibelink.exe') ?? 'vibelink.exe'
  return keepLastEnvValue([
    ...terminalCapabilityEnv,
    ...filtered,
    ['VIBELINK_SESSION_ID', sessionId],
    ['VIBELINK_PANE_ID', paneId],
    ['VIBELINK_CLI_EXE', cliExecutable],
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
    const raw = window.localStorage.getItem('vibelink:settings')
    if (!raw) return defaultSettings
    return normalizeSettings(JSON.parse(raw))
  } catch {
    return defaultSettings
  }
}

function persistSettings(settings: Settings): void {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem('vibelink:settings', JSON.stringify(settings))
  }
}

function persistCurrentKanban(state: WorkspaceState): void {
  persistKanban({
    data: state.kanban,
    viewModes: state.viewModes,
    kanbanLayouts: state.kanbanLayouts,
    orchestratorPaneIds: state.orchestratorPaneIds,
    workspaceTodos: state.workspaceTodos,
    workspaceTodoNotes: state.workspaceTodoNotes,
  })
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


function requireProForTaskMutation(state: WorkspaceState): void {
  if (state.license.ready && !state.license.status?.entitled) {
    useWorkspaceStore.setState({ error: 'VibeLink Pro license required.' })
    throw new Error('VibeLink Pro license required.')
  }
}

function upsertTask(kanban: KanbanData, task: Task): KanbanData {
  const order = kanban.taskOrder[task.sessionId] ?? []
  return {
    tasks: { ...kanban.tasks, [task.id]: task },
    taskOrder: {
      ...kanban.taskOrder,
      [task.sessionId]: order.includes(task.id) ? order : [...order, task.id],
    },
  }
}

function removeTask(kanban: KanbanData, task: Task): KanbanData {
  const tasks = { ...kanban.tasks }
  delete tasks[task.id]
  return {
    tasks,
    taskOrder: {
      ...kanban.taskOrder,
      [task.sessionId]: (kanban.taskOrder[task.sessionId] ?? []).filter((id) => id !== task.id),
    },
  }
}

function taskPatchForNative(patch: Partial<Task>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const key of [
    'title',
    'description',
    'status',
    'assignedPaneId',
    'assignedRole',
    'baselineRef',
    'worktreePath',
    'commitMessage',
    'resultSummary',
  ] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue
    output[key] = patch[key] ?? null
  }
  return output
}

async function migrateLegacyTasks(sessionId: string, boardJson: string): Promise<string> {
  if (migratedLegacySessions.has(sessionId)) return boardJson
  const mergedJson = mergeLegacyTasksIntoBoard(sessionId, boardJson, initialKanban)
  if (!mergedJson) {
    migratedLegacySessions.add(sessionId)
    return boardJson
  }
  try {
    await invoke('board_write', { sessionId, json: mergedJson })
    const imported = await invoke<string>('board_read', { sessionId })
    migratedLegacySessions.add(sessionId)
    return imported
  } catch {
    return boardJson
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

function parseBoardSnapshot(sessionId: string, json: string): { tasks: Record<string, Task>; taskOrder: string[]; brief: WorkspaceBrief | null } | null {
  try {
    const parsed = JSON.parse(json) as { tasks?: unknown; taskOrder?: unknown; brief?: unknown }
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
    return {
      tasks,
      taskOrder: parsed.taskOrder.filter((taskId): taskId is string => typeof taskId === 'string' && taskId in tasks),
      brief: normalizeWorkspaceBrief(parsed.brief),
    }
  } catch {
    return null
  }
}

function normalizeWorkspaceBrief(value: unknown): WorkspaceBrief | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Partial<WorkspaceBrief>
  if (typeof record.purpose !== 'string' || typeof record.notes !== 'string' || typeof record.updatedAt !== 'string') return null
  return { purpose: record.purpose, notes: record.notes, updatedAt: record.updatedAt }
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

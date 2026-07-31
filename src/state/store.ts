import { invoke } from '@tauri-apps/api/core'
import { sendToPane, submitAgentPrompt } from '../ipc/panes'
import { deactivateLicenseDevice, getLicenseStatus, revalidateLicense, signOutAccount as signOutAccountIpc } from '../ipc/license'
import { getAgentCliStatus, type AgentCliStatus } from '../ipc/agents'
import { create } from 'zustand'
import type { AttachedSession, HermesModelInfo, HermesRuntimeStatus, LicenseStatus, PaneConfig, PaneMeta, SessionMeta, Task, TaskStatus, WorkspaceBrief } from '../ipc/types'
import { defaultSettings, isAgentPane, normalizeLegacyWorkspaceWorktrees, normalizeSettings, orderSessions, paneOverridesFromProfile, profileById, selectedProfileForWorkspace } from './profiles'
import { normalizePaneTitle, shouldApplyAutoTitle, type ManualPaneTitleMap } from './paneTitles'
import { authorizationErrorMessage } from './licenseGate'
import type { Settings } from './profiles'
import type { AttentionSnapshot } from './worktreeAttention'
import type { AgentPaneActivity } from './agentPaneStatus'
import type { WorktreeBlockerKind, WorktreeCheckpoint, WorktreeCheckpointKind, WorktreeCreateRequest, WorktreeCreateResult, WorktreeProjection, WorktreeRecord, WorktreeRemovalPreflight, WorktreeRemovalResult, WorktreeReviewComment, WorktreeReviewCommentRequest, WorktreeSetupPolicy } from '../ipc/worktrees'
import { cancelWorktreeOperation, createWorktree, createWorktreeCheckpoint, importWorktree, listWorktrees, moveWorktree, preflightWorktreeRemoval as preflightWorktreeRemovalIpc, putWorktreeReviewComment as putWorktreeReviewCommentIpc, reconcileWorktrees, removeWorktree, setWorktreeMetadata as setWorktreeMetadataIpc } from '../ipc/worktrees'
import type { LegacyWorkspaceWorktree, PendingWorktreeCreation } from './worktrees'
import { indexWorktrees, legacyRowsByRepository, worktreeBySession } from './worktrees'
import { useGitStore } from './git'
import { recoverWorkspaceGroups, type WorkspaceGroup } from './workspaceGroups'
import type { KanbanData } from './kanban'
import { composeAgentTaskPrompt, composeTaskPrompt } from './kanban'
import { loadKanban, mergeLegacyTasksIntoBoard, persistKanban, type ViewMode } from './kanbanPersistence'
import type { WorkspaceTodoItem, WorkspaceTodoLists, WorkspaceTodoNotes } from './workspaceTodos'
import { disposeEditorDocumentStore } from '../editor/documentStore'
import type { HermesModelsState, HermesPendingPrompt, HermesPlanEntry, HermesSessionInfo, HermesStatus, HermesTextPartKind, HermesToolCallView, HermesTranscriptPart, HermesTurn, PendingPermission } from './hermes'
import {
  normalizeWorkspaceLayoutState,
  serializeWorkspaceLayoutState,
} from '../layout/workspaceLayoutModel'

const initialKanban = loadKanban()
const migratedLegacySessions = new Set<string>()
const paneCompletionHighlightsStorageKey = 'vibelink:paneCompletionHighlights'
const paneReviewMarkersStorageKey = 'vibelink:paneReviewMarkers'
const workspaceGroupRecoveryStorageKey = 'vibelink:workspaceGroupRecovery:v1'
let workspaceSessionEpoch = 0
let workspaceSessionReadyEpoch = 0
let workspaceSessionTargetId: string | null = null
let workspaceInitialPanePending: { sessionId: string; epoch: number } | null = null
/** A batch of concurrent spawns would otherwise issue one `list_sessions` per
 *  pane AND let two passes reconcile a removed workspace at the same time.
 *  Callers arriving while a pass runs share ONE follow-up pass, so any burst
 *  costs two round trips and every caller still observes post-burst state. */
let sessionsRefreshActive: Promise<void> | null = null
let sessionsRefreshFollowUp: Promise<void> | null = null

function coalesceSessionsRefresh(run: () => Promise<void>): Promise<void> {
  if (!sessionsRefreshActive) {
    const active = run().finally(() => { if (sessionsRefreshActive === active) sessionsRefreshActive = null })
    sessionsRefreshActive = active
    return active
  }
  sessionsRefreshFollowUp ??= sessionsRefreshActive
    .catch(() => undefined)
    .then(() => {
      sessionsRefreshFollowUp = null
      return coalesceSessionsRefresh(run)
    })
  return sessionsRefreshFollowUp
}

export function isWorkspaceInitialPanePending(sessionId: string, epoch: number): boolean {
  return workspaceInitialPanePending?.sessionId === sessionId && workspaceInitialPanePending.epoch === epoch
}

export function getWorkspaceSessionEpoch(): number {
  return workspaceSessionEpoch
}

export function getWorkspaceSessionReadyEpoch(): number {
  return workspaceSessionReadyEpoch
}

export function getWorkspaceSessionTargetId(): string | null {
  return workspaceSessionTargetId
}

export function resetWorkspaceSessionOwnershipForTests(): void {
  if (import.meta.env.MODE !== 'test') throw new Error('Workspace session ownership can only be reset in tests.')
  workspaceSessionEpoch = 0
  workspaceSessionReadyEpoch = 0
  workspaceSessionTargetId = null
  workspaceInitialPanePending = null
}


type SpawnPaneOptions = Partial<PaneConfig> & { profileId?: string | null }

type Status = 'booting' | 'ready' | 'error'
export type PaneCompletionSource = 'agent-response' | 'task-done' | 'agent-hook'
export type PaneCompletionHighlight = { completedAt: number; source: PaneCompletionSource; sessionId: string }
export type PaneReviewMarker = { reviewedAt: number; sessionId: string }
export type CreateWorkspaceWorktreeInput = {
  parentSessionId: string
  name: string
  startRef: string
  branch: string
  profileId: string
  fetch?: boolean
  setupPolicy?: WorktreeSetupPolicy
  sparsePreset?: string | null
  linkedFiles?: string[]
  initialAgent?: string | null
  initialPrompt?: string | null
}
export type PaneLifecycleState = 'spawning' | 'live' | 'closing' | 'closed'


type WorkspaceState = {
  sessions: SessionMeta[]
  worktreeProjections: WorktreeProjection[]
  worktreesById: Record<string, WorktreeProjection>
  worktreeIdsBySessionId: Record<string, string>
  pendingWorktreeCreations: Record<string, PendingWorktreeCreation>
  attentionSnapshot: AttentionSnapshot | null
  workspaceEpoch: number
  workspaceReadyEpoch: number
  activeSessionId?: string
  panes: Record<string, PaneMeta>
  paneLifecycle: Record<string, PaneLifecycleState>
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
  orchestratorPaneIds: Record<string, string>
  workspaceTodos: WorkspaceTodoLists
  workspaceTodoNotes: WorkspaceTodoNotes
  workspaceBriefs: Record<string, WorkspaceBrief | null>
  hermesStatus: Record<string, HermesStatus>
  hermesTranscript: Record<string, HermesTurn[]>
  hermesPermissions: Record<string, PendingPermission[]>
  hermesUsage: Record<string, { size: number; used: number }>
  hermesModels: Record<string, HermesModelsState>
  hermesPendingPrompts: Record<string, HermesPendingPrompt[]>
  hermesGenerations: Record<string, number>
  hermesCurrentSession: Record<string, string>
  hermesSessions: Record<string, HermesSessionInfo[]>
  selectedTaskId: Record<string, string | null>
  activePaneId?: string
  paneCompletionHighlights: Record<string, PaneCompletionHighlight>
  paneReviewMarkers: Record<string, PaneReviewMarker>
  /** Panes whose agent turn VibeLink observed starting locally. Cleared when
   *  the turn completes; see `agentPaneStatus.resolveAgentPaneStatus`. */
  paneAgentActivity: Record<string, AgentPaneActivity>
  capturesByPane: Record<string, string[]>
  recentCaptures: string[]
  setActivePaneId: (paneId?: string) => void
  notePaneAgentTurnStart: (paneId: string) => void
  markPaneResponseComplete: (paneId: string, source?: PaneCompletionSource, sessionId?: string) => void
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
  refreshWorktrees: () => Promise<WorktreeProjection[]>
  reconcileRepositoryWorktrees: (repositoryPath: string) => Promise<WorktreeProjection[]>
  importExternalWorktree: (input: { repositoryPath: string; worktreePath: string; parentSessionId: string | null }) => Promise<WorktreeProjection>
  setWorktreeMetadata: (worktreeId: string, patch: { comment?: string | null; reviewTarget?: string | null; parentWorktreeId?: string | null; clearParent?: boolean }) => Promise<WorktreeRecord>
  recordWorktreeCheckpoint: (worktreeId: string, kind: WorktreeCheckpointKind, label: string, comment?: string | null) => Promise<WorktreeCheckpoint>
  putWorktreeReviewComment: (request: WorktreeReviewCommentRequest) => Promise<WorktreeReviewComment>
  preflightWorktreeRemoval: (worktreeId: string, deleteBranch: boolean) => Promise<WorktreeRemovalPreflight>
  removeWorktreeById: (worktreeId: string, options: { deleteBranch: boolean; acknowledgedBlockers: WorktreeBlockerKind[]; providerMergedHead?: string | null }) => Promise<WorktreeRemovalResult>
  refreshAttentionSnapshot: () => Promise<AttentionSnapshot>
  openSession: (sessionId: string) => Promise<AttachedSession>
  attachSession: (sessionId: string, requestEpoch?: number) => Promise<AttachedSession>
  refreshAttachedSession: (sessionId: string) => Promise<AttachedSession | null>
  createSession: (name?: string, workspaceFolder?: string | null, profileId?: string | null) => Promise<SessionMeta>
  createWorktreeSession: (input: CreateWorkspaceWorktreeInput) => Promise<SessionMeta>
  cancelPendingWorktreeCreation: (operationId: string) => Promise<void>
  retryPendingWorktreeCreation: (operationId: string) => Promise<SessionMeta>
  dismissPendingWorktreeCreation: (operationId: string) => void
  removeWorktreeSession: (sessionId: string, options: { deleteBranch: boolean; acknowledgedBlockers: WorktreeBlockerKind[]; providerMergedHead?: string | null }) => Promise<WorktreeRemovalResult>
  moveWorktreeSession: (sessionId: string, destinationPath: string) => Promise<void>
  renameSession: (sessionId: string, name: string) => Promise<void>
  setSessionWorkspaceFolder: (sessionId: string, workspaceFolder: string) => Promise<void>
  deleteSession: (sessionId: string) => Promise<void>
  spawnPane: (sessionId: string, overrides?: SpawnPaneOptions) => Promise<PaneMeta>
  closePane: (paneId: string, sessionId?: string) => Promise<void>
  saveLayout: (sessionId: string, layoutJson: string) => Promise<void>
  renamePaneTitle: (paneId: string, title: string, source: 'manual' | 'auto') => Promise<void>
  applyTerminalTitle: (paneId: string, title: string) => Promise<void>
  setError: (error: string) => void
  clearError: () => void
  dismissError: () => void
  prepareSetupWizardRun: () => void
  updateSettings: (settings: Partial<Settings>) => void
  reorderWorkspaces: (orderedIds: string[]) => void
  createWorkspaceGroup: (name: string, rootFolder?: string | null) => WorkspaceGroup
  renameWorkspaceGroup: (groupId: string, name: string) => void
  setWorkspaceGroupRootFolder: (groupId: string, rootFolder: string | null) => void
  deleteWorkspaceGroup: (groupId: string) => void
  setWorkspaceGroup: (sessionId: string, groupId: string | null) => void
  toggleWorkspaceGroupCollapsed: (groupId: string) => void
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
  setHermesGeneration: (sessionId: string, generation: number) => void
  enqueueHermesPrompt: (sessionId: string, text: string) => void
  claimHermesPrompt: (sessionId: string) => HermesPendingPrompt | undefined
  ackHermesPrompt: (sessionId: string, promptId: string) => void
  releaseHermesPrompt: (sessionId: string, promptId: string) => void
  resetHermesTranscript: (sessionId: string) => void
  setHermesCurrentSession: (sessionId: string, acpSessionId: string) => void
  setHermesSessions: (sessionId: string, sessions: HermesSessionInfo[]) => void
  setHermesTranscript: (sessionId: string, turns: HermesTurn[]) => void
  applyBoardSnapshot: (sessionId: string, json: string) => void
}

export const useWorkspaceStore = create<WorkspaceState>((set, get) => ({
  sessions: [],
  worktreeProjections: [],
  worktreesById: {},
  worktreeIdsBySessionId: {},
  pendingWorktreeCreations: {},
  attentionSnapshot: null,
  workspaceEpoch: 0,
  workspaceReadyEpoch: 0,
  panes: {},
  paneLifecycle: {},
  manualPaneTitles: {},
  status: 'booting',
  settings: loadSettings(),
  license: { ready: false, status: null },
  agentClis: [],
  kanban: initialKanban.data,
  viewModes: initialKanban.viewModes,
  kanbanLayouts: initialKanban.kanbanLayouts,
  orchestratorPaneIds: initialKanban.orchestratorPaneIds,
  workspaceTodos: initialKanban.workspaceTodos,
  workspaceTodoNotes: initialKanban.workspaceTodoNotes,
  hermesStatus: {},
  workspaceBriefs: {},
  hermesTranscript: {},
  hermesPermissions: {},
  hermesUsage: {},
  hermesGenerations: {},
  hermesModels: {},
  hermesPendingPrompts: {},
  hermesCurrentSession: {},
  hermesSessions: {},
  selectedTaskId: {},
  activePaneId: undefined,
  paneCompletionHighlights: loadPaneCompletionHighlights(),
  paneReviewMarkers: loadPaneReviewMarkers(),
  paneAgentActivity: {},
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

      const [migration, attentionSnapshot] = await Promise.all([
        reconcileWorkspaceWorktrees(sessions, get().settings.worktreeRegistryMigrationVersion),
        invoke<AttentionSnapshot>('attention_snapshot'),
      ])
      // The migration marker is only durable proof once the daemon accepted
      // every legacy payload. A partial failure leaves the marker at 0 so the
      // next launch replays the same rows under the same operation hash.
      const migratedSettings = migration.migrated
        ? { ...get().settings, worktreeRegistryMigrationVersion: 1 }
        : get().settings
      const groupRecovery = recoverWorkspaceGroupsOnce(migratedSettings, sessions)
      const settings = groupRecovery.settings
      if (migration.migrated || groupRecovery.recovered) persistSettings(settings)
      if (migration.migrated) forgetLegacyWorkspaceWorktrees()
      set({
        sessions,
        ...projectionState(migration.projections),
        attentionSnapshot,
        settings,
        activeSessionId: undefined,
        panes: {},
        paneLifecycle: {},
        layoutJson: null,
        status: 'ready',
      })
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

  refreshSessions: async () => coalesceSessionsRefresh(async () => {
    const previousSessions = get().sessions
    const sessions = await invoke<SessionMeta[]>('list_sessions')
    const remainingIds = new Set(sessions.map((session) => session.id))
    const removed = previousSessions.filter((session) => !remainingIds.has(session.id))
    // Sessions can vanish because CLI, MCP, or another window removed their
    // worktree. Their GUI-owned resources are torn down with the same helpers
    // deleteSession uses, so no orphan browser/editor/Hermes/layout state is
    // left behind for a workspace the daemon no longer knows about.
    const failures: string[] = []
    for (const session of removed) {
      try {
        await releaseSessionResources(session.id, session.workspaceFolder)
      } catch (caught) {
        failures.push(String(caught))
      }
      set((state) => stateWithoutSession(state, session.id, sessions))
    }
    if (removed.length === 0) set({ sessions })
    if (removed.length > 0) {
      persistSettings(get().settings)
      persistCurrentKanban(get())
    }
    if (failures.length > 0) throw new Error(`Workspace resource cleanup failed: ${failures.join('; ')}`)
  }),

  refreshWorktrees: async () => {
    const projections = await listWorktrees({ repositoryPath: null, includeExternal: true, includeHidden: true })
    set(projectionState(projections))
    return projections
  },

  reconcileRepositoryWorktrees: async (repositoryPath: string) => {
    const normalized = normalizeWorkspaceFolder(repositoryPath)
    if (!normalized) throw new Error('A repository workspace folder is required to reconcile worktrees.')
    const projections = await reconcileWorktrees({ repositoryPath: normalized, legacyRows: [] })
    // Reconcile is repository-scoped: merge its rows over the global projection
    // instead of replacing rows that belong to other repositories.
    set((state) => {
      const byId = new Map(state.worktreeProjections.map((projection) => [projection.id, projection]))
      const stale = new Set(
        state.worktreeProjections
          .filter((projection) => sameRepository(projection, normalized))
          .map((projection) => projection.id),
      )
      for (const projection of projections) {
        byId.set(projection.id, projection)
        stale.delete(projection.id)
      }
      for (const id of stale) byId.delete(id)
      return projectionState([...byId.values()])
    })
    return projections
  },

  importExternalWorktree: async ({ repositoryPath, worktreePath, parentSessionId }) => {
    const imported = await importWorktree({ repositoryPath, worktreePath, parentSessionId, sessionId: null })
    if (!imported.record) throw new Error(`The checkout at "${worktreePath}" could not be imported into the registry.`)
    await Promise.all([get().refreshSessions(), get().refreshWorktrees()])
    return imported
  },

  setWorktreeMetadata: async (worktreeId, patch) => {
    const record = requireRecord(get(), worktreeId)
    const updated = await setWorktreeMetadataIpc({
      worktreeId: record.id,
      expectedInstanceId: record.instanceId,
      comment: patch.comment ?? null,
      reviewTarget: patch.reviewTarget ?? null,
      parentWorktreeId: patch.parentWorktreeId ?? null,
      clearParent: patch.clearParent ?? false,
    })
    await get().refreshWorktrees()
    return updated
  },

  recordWorktreeCheckpoint: (worktreeId, kind, label, comment = null) =>
    createWorktreeCheckpoint({ worktreeId, kind, label, comment }),

  putWorktreeReviewComment: (request) => putWorktreeReviewCommentIpc(request),

  preflightWorktreeRemoval: (worktreeId, deleteBranch) =>
    preflightWorktreeRemovalIpc({ worktreeId, deleteBranch }),

  removeWorktreeById: async (worktreeId, options) => {
    const record = requireRecord(get(), worktreeId)
    if (record.sessionId) return get().removeWorktreeSession(record.sessionId, options)
    assertRemovalAcknowledged(
      await preflightWorktreeRemovalIpc({ worktreeId: record.id, deleteBranch: options.deleteBranch }),
      options.acknowledgedBlockers,
    )
    const result = await removeWorktree({
      operationId: crypto.randomUUID(),
      worktreeId: record.id,
      expectedInstanceId: record.instanceId,
      force: options.acknowledgedBlockers.length > 0,
      deleteBranch: options.deleteBranch,
      providerMergedHead: options.providerMergedHead ?? null,
      acknowledgedBlockers: options.acknowledgedBlockers,
    })
    await get().refreshWorktrees()
    return result
  },

  refreshAttentionSnapshot: async () => {
    const attentionSnapshot = await invoke<AttentionSnapshot>('attention_snapshot')
    set({ attentionSnapshot })
    return attentionSnapshot
  },

  openSession: async (sessionId: string) => {
    const requestEpoch = ++workspaceSessionEpoch
    workspaceSessionTargetId = sessionId
    set({ workspaceEpoch: requestEpoch })
    if (!get().sessions.some((session) => session.id === sessionId)) {
      await get().refreshSessions()
    }
    if (workspaceSessionEpoch !== requestEpoch || workspaceSessionTargetId !== sessionId) return { layoutJson: null, panes: [] }
    const attached = await get().attachSession(sessionId, requestEpoch)
    if (workspaceSessionEpoch !== requestEpoch || get().activeSessionId !== sessionId) return attached
    await get().refreshSessions()
    return attached
  },

  attachSession: async (sessionId: string, requestEpoch?: number) => {
    const epoch = requestEpoch ?? ++workspaceSessionEpoch
    if (requestEpoch === undefined) {
      workspaceSessionTargetId = sessionId
      set({ workspaceEpoch: epoch })
    }
    if (workspaceSessionEpoch !== epoch || workspaceSessionTargetId !== sessionId) return { layoutJson: null, panes: [] }
    const previousSessionId = get().activeSessionId
    const attached = await invoke<AttachedSession>('attach_session', { sessionId })
    if (workspaceSessionEpoch !== epoch || workspaceSessionTargetId !== sessionId) {
      if (workspaceSessionTargetId !== sessionId && get().activeSessionId !== sessionId) void invoke('detach_session', { sessionId }).catch(() => {})
      return attached
    }
    const panes = Object.fromEntries(attached.panes.map((pane) => [pane.id, pane]))
    workspaceInitialPanePending = attached.panes.length === 0 ? { sessionId, epoch } : null
    const workspaceLayout = normalizeWorkspaceLayoutState(attached.layoutJson)
    window.localStorage.setItem('vibelink:lastActiveSessionId', sessionId)
    workspaceSessionReadyEpoch = epoch
    set((state) => ({
      activeSessionId: sessionId,
      workspaceReadyEpoch: epoch,
      activePaneId: undefined,
      panes,
      paneLifecycle: Object.fromEntries(attached.panes.map((pane) => [pane.id, 'live' as const])),
      paneCompletionHighlights: reconcilePaneCompletionHighlights(state.paneCompletionHighlights, sessionId, panes),
      paneReviewMarkers: reconcilePaneReviewMarkers(state.paneReviewMarkers, sessionId, panes),
      layoutJson: serializeWorkspaceLayoutState(workspaceLayout),
    }))
    if (previousSessionId && previousSessionId !== sessionId) {
      void invoke('detach_session', { sessionId: previousSessionId }).catch(() => {})
    }
    if (attached.panes.length === 0
      && workspaceSessionEpoch === epoch
      && workspaceSessionTargetId === sessionId
      && get().activeSessionId === sessionId) {
      try {
        await get().spawnPane(sessionId)
      } finally {
        if (isWorkspaceInitialPanePending(sessionId, epoch)) workspaceInitialPanePending = null
      }
    }
    if (get().license.ready && get().license.status?.entitled) {
      const boardJson = await invoke<string>('board_read', { sessionId })
      if (workspaceSessionEpoch !== epoch || workspaceSessionTargetId !== sessionId || get().activeSessionId !== sessionId) return attached
      const migratedJson = await migrateLegacyTasks(sessionId, boardJson)
      if (workspaceSessionEpoch !== epoch || workspaceSessionTargetId !== sessionId || get().activeSessionId !== sessionId) return attached
      get().applyBoardSnapshot(sessionId, migratedJson)
    }
    return attached
  },

  refreshAttachedSession: async (sessionId: string) => {
    const epoch = workspaceSessionEpoch
    if (workspaceSessionReadyEpoch !== epoch || workspaceSessionTargetId !== sessionId || get().activeSessionId !== sessionId) return null
    const attached = await invoke<AttachedSession>('attach_session', { sessionId })
    if (workspaceSessionEpoch !== epoch || workspaceSessionReadyEpoch !== epoch || workspaceSessionTargetId !== sessionId || get().activeSessionId !== sessionId) return null
    const refreshedPanes = Object.fromEntries(attached.panes.map((pane) => [pane.id, pane]))
    set((state) => {
      if (workspaceSessionEpoch !== epoch || workspaceSessionReadyEpoch !== epoch || workspaceSessionTargetId !== sessionId || state.activeSessionId !== sessionId) return state
      const panesUnchanged = paneRecordsEqual(state.panes, refreshedPanes)
      const panes = panesUnchanged ? state.panes : refreshedPanes
      const activePaneId = state.activePaneId && panes[state.activePaneId]?.alive ? state.activePaneId : undefined
      if (panesUnchanged && activePaneId === state.activePaneId) return state
      // NEVER adopt the daemon's layout copy here. This runs from the daemon's
      // SessionChanged snapshot, and `save_layout` itself emits SessionChanged:
      // adopting the snapshot replays a layout the frontend just wrote (often a
      // racing/older copy), which makes WorkspaceView clear + fromJSON the whole
      // dock, re-serialize, save again, and flicker in a loop. The attached
      // frontend is the only author of the layout, so its own copy is current.
      return {
        panes,
        activePaneId,
        paneCompletionHighlights: panesUnchanged
          ? state.paneCompletionHighlights
          : reconcilePaneCompletionHighlights(state.paneCompletionHighlights, sessionId, panes),
        paneReviewMarkers: panesUnchanged
          ? state.paneReviewMarkers
          : reconcilePaneReviewMarkers(state.paneReviewMarkers, sessionId, panes),
      }
    })
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
    persistCurrentKanban(get())
    return created
  },

  createWorktreeSession: async (input: CreateWorkspaceWorktreeInput) => {
    const request = buildWorktreeCreateRequest(get(), input)
    return runWorktreeCreation(set, get, request, input.profileId)
  },

  cancelPendingWorktreeCreation: async (operationId: string) => {
    const pending = get().pendingWorktreeCreations[operationId]
    if (!pending || isSettledStage(pending.stage)) return
    set(patchPendingCreation(operationId, { cancelRequested: true }))
    // The daemon owns the rollback. The pending row stays until the create
    // promise settles, so a cancel that lost the race still reports the truth.
    await cancelWorktreeOperation(operationId).catch((caught) => {
      set(patchPendingCreation(operationId, { cancelRequested: false }))
      throw caught
    })
  },

  retryPendingWorktreeCreation: async (operationId: string) => {
    const pending = get().pendingWorktreeCreations[operationId]
    if (!pending) throw new Error('That worktree creation is no longer pending.')
    if (!isSettledStage(pending.stage)) throw new Error('That worktree creation is still running.')
    set(withoutPendingCreation(operationId))
    // A fresh operation id: the failed one stored a durable result, and
    // replaying it would return that stored failure instead of retrying.
    return runWorktreeCreation(set, get, { ...pending.request, operationId: crypto.randomUUID() }, pending.request.profileId)
  },

  dismissPendingWorktreeCreation: (operationId: string) => {
    const pending = get().pendingWorktreeCreations[operationId]
    if (!pending || !isSettledStage(pending.stage)) return
    set(withoutPendingCreation(operationId))
  },

  removeWorktreeSession: async (sessionId, options) => {
    const worktree = worktreeBySession(get().worktreeProjections, sessionId)?.record
    if (!worktree) throw new Error(`Workspace session "${sessionId}" is not a registered worktree.`)
    // Nothing is torn down until the live blocker set is proven to match the
    // set the caller acknowledged. A hard blocker always refuses, and a blocker
    // that appeared after the user confirmed is never silently acknowledged.
    assertRemovalAcknowledged(
      await preflightWorktreeRemovalIpc({ worktreeId: worktree.id, deleteBranch: options.deleteBranch }),
      options.acknowledgedBlockers,
    )
    // GUI-owned resources are torn down before the Git mutation is requested,
    // and a teardown failure aborts here: the session, its panes, and the
    // registry row all survive so the removal can be retried.
    await releaseSessionResources(sessionId, worktree.worktreePath)
    const result = await removeWorktree({
      operationId: crypto.randomUUID(),
      worktreeId: worktree.id,
      expectedInstanceId: worktree.instanceId,
      force: options.acknowledgedBlockers.length > 0,
      deleteBranch: options.deleteBranch,
      providerMergedHead: options.providerMergedHead ?? null,
      acknowledgedBlockers: options.acknowledgedBlockers,
    })
    if (!result.metadataRemoved) throw new Error('Worktree metadata cleanup did not complete.')
    await Promise.all([get().refreshSessions(), get().refreshWorktrees()])
    const sessions = get().sessions
    set((state) => stateWithoutSession(state, sessionId, sessions))
    persistSettings(get().settings)
    persistCurrentKanban(get())
    if (!get().activeSessionId || get().activeSessionId === sessionId) {
      const next = sessions.find((session) => session.id === worktree.parentSessionId) ?? sessions[0]
      if (next) await get().attachSession(next.id)
    }
    return result
  },

  moveWorktreeSession: async (sessionId, destinationPath) => {
    const worktree = worktreeBySession(get().worktreeProjections, sessionId)?.record
    if (!worktree) throw new Error(`Workspace session "${sessionId}" is not a registered worktree.`)
    const destinationPathNormalized = normalizeWorkspaceFolder(destinationPath)
    if (!destinationPathNormalized) throw new Error('Worktree destination path is required.')
    await moveWorktree({
      operationId: crypto.randomUUID(),
      worktreeId: worktree.id,
      expectedInstanceId: worktree.instanceId,
      destinationPath: destinationPathNormalized,
    })
    await Promise.all([get().refreshSessions(), get().refreshWorktrees()])
  },

  renameSession: async (sessionId: string, name: string) => {
    await invoke('rename_session', { sessionId, name })
    await get().refreshSessions()
  },

  setSessionWorkspaceFolder: async (sessionId: string, workspaceFolder: string) => {
    const normalizedFolder = normalizeWorkspaceFolder(workspaceFolder)
    if (!normalizedFolder) throw new Error('Workspace folder is required.')
    await invoke('set_session_workspace_folder', { sessionId, workspaceFolder: normalizedFolder })
    await get().refreshSessions()
  },

  deleteSession: async (sessionId: string) => {
    const deletedWorkspaceFolder = get().sessions.find((session) => session.id === sessionId)?.workspaceFolder ?? null
    const deletingActiveSession = get().activeSessionId === sessionId
    if (deletingActiveSession) {
      workspaceSessionEpoch += 1
      if (workspaceSessionTargetId === sessionId) workspaceSessionTargetId = null
      set({ workspaceEpoch: workspaceSessionEpoch })
    }
    try {
      await releaseSessionResources(sessionId, deletedWorkspaceFolder)
      await invoke('delete_session', { sessionId })
    } catch (error) {
      if (deletingActiveSession && get().activeSessionId === sessionId) {
        await get().attachSession(sessionId).catch(() => undefined)
      }
      throw error
    }
    let sessions = await invoke<SessionMeta[]>('list_sessions')
    if (sessions.length === 0) {
      const created = await invoke<SessionMeta>('create_session', { name: 'Workspace 1' })
      sessions = [created]
    }
    set((state) => stateWithoutSession(state, sessionId, sessions))
    persistSettings(get().settings)
    persistCurrentKanban(get())
    const currentSessionId = get().activeSessionId
    if (!currentSessionId || currentSessionId === sessionId || !sessions.some((session) => session.id === currentSessionId)) {
      const next = sessions[0]
      await get().attachSession(next.id)
    }
  },

  spawnPane: async (sessionId: string, overrides?: SpawnPaneOptions) => {
    const sessionEpoch = workspaceSessionEpoch
    if (workspaceSessionReadyEpoch !== sessionEpoch || workspaceSessionTargetId !== sessionId || get().activeSessionId !== sessionId) {
      throw new Error('Workspace changed while the terminal was opening.')
    }
    const paneId = overrides?.paneId ?? crypto.randomUUID()
    set((state) => ({ paneLifecycle: { ...state.paneLifecycle, [paneId]: 'spawning' } }))
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
      restoreOnStart: true,
      cols: overrides?.cols ?? 120,
      rows: overrides?.rows ?? 32,
    }
    try {
      const pane = await invoke<PaneMeta>('spawn_pane', { sessionId, cfg })
      if (get().paneLifecycle[paneId] !== 'spawning') {
        await invoke('cancel_pane_spawn', { sessionId, paneId }).catch(() => {})
        throw new Error('PANE_SPAWN_CANCELLED')
      }
      if (workspaceSessionEpoch !== sessionEpoch || workspaceSessionReadyEpoch !== sessionEpoch || workspaceSessionTargetId !== sessionId || get().activeSessionId !== sessionId) {
        await invoke('close_pane', { sessionId, paneId: pane.id }).catch(() => {})
        throw new Error('Workspace changed while the terminal was opening.')
      }
      if (isWorkspaceInitialPanePending(sessionId, sessionEpoch)) workspaceInitialPanePending = null
      set((state) => state.activeSessionId === sessionId
        ? {
            panes: { ...state.panes, [pane.id]: pane },
            paneLifecycle: { ...state.paneLifecycle, [paneId]: 'live' },
          }
        : {})
      await get().refreshSessions()
      if (workspaceSessionEpoch !== sessionEpoch || workspaceSessionReadyEpoch !== sessionEpoch || workspaceSessionTargetId !== sessionId || get().activeSessionId !== sessionId) {
        await invoke('close_pane', { sessionId, paneId: pane.id }).catch(() => {})
        throw new Error('Workspace changed while the terminal was opening.')
      }
      return pane
    } catch (error) {
      set((state) => {
        const panes = { ...state.panes }
        delete panes[paneId]
        return {
          panes,
          paneLifecycle: { ...state.paneLifecycle, [paneId]: 'closed' },
          activePaneId: state.activePaneId === paneId ? undefined : state.activePaneId,
        }
      })
      throw error
    }
  },

  closePane: async (paneId: string, requestedSessionId?: string) => {
    const sessionId = requestedSessionId ?? get().activeSessionId
    if (!sessionId) return
    const previous = get().paneLifecycle[paneId] ?? (get().panes[paneId] ? 'live' : 'closed')
    if (previous === 'closing' || previous === 'closed') return
    set((state) => ({ paneLifecycle: { ...state.paneLifecycle, [paneId]: 'closing' } }))
    try {
      await invoke(previous === 'spawning' ? 'cancel_pane_spawn' : 'close_pane', { sessionId, paneId })
    } catch (error) {
      set((state) => ({ paneLifecycle: { ...state.paneLifecycle, [paneId]: previous } }))
      throw error
    }
    set((state) => {
      if (state.activeSessionId !== sessionId) return {}
      const panes = { ...state.panes }
      delete panes[paneId]
      return {
        panes,
        paneLifecycle: { ...state.paneLifecycle, [paneId]: 'closed' },
        activePaneId: state.activePaneId === paneId ? undefined : state.activePaneId,
        paneCompletionHighlights: withoutPaneKey(state.paneCompletionHighlights, paneId),
        paneReviewMarkers: withoutPaneKey(state.paneReviewMarkers, paneId),
        paneAgentActivity: withoutPaneKey(state.paneAgentActivity, paneId),
      }
    })
    await get().refreshSessions()
  },

  clearSession: async (sessionId: string) => {
    await invoke('clear_session', { sessionId })
    set((state) => ({
      panes: state.activeSessionId === sessionId ? {} : state.panes,
      paneLifecycle: state.activeSessionId === sessionId ? {} : state.paneLifecycle,
      activePaneId: state.activeSessionId === sessionId ? undefined : state.activePaneId,
      paneAgentActivity: state.activeSessionId === sessionId ? {} : state.paneAgentActivity,
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
      if (state.activeSessionId !== sessionId) return {}
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
    const sessionEpoch = workspaceSessionEpoch
    const serialized = serializeWorkspaceLayoutState(normalizeWorkspaceLayoutState(layoutJson))
    await invoke('save_layout', { sessionId, layoutJson: serialized })
    if (workspaceSessionEpoch === sessionEpoch && workspaceSessionReadyEpoch === sessionEpoch && workspaceSessionTargetId === sessionId && get().activeSessionId === sessionId) {
      set({ layoutJson: serialized })
    }
  },

  setError: (error: string) => set({ error: authorizationErrorMessage(error), status: 'error' }),
  clearError: () => set({ error: undefined, status: 'ready' }),
  dismissError: () => set({ error: undefined }),
  setActivePaneId: (paneId) => set({ activePaneId: paneId }),
  // A turn only "starts" for a live agent pane in the attached workspace; the
  // tracker never observes anything else, and a stray entry would keep an
  // unrelated pane spinning.
  notePaneAgentTurnStart: (paneId) => set((state) => {
    const pane = state.panes[paneId]
    if (!pane?.alive || !isAgentPane(pane, state.settings)) return {}
    return { paneAgentActivity: { ...state.paneAgentActivity, [paneId]: { startedAt: Date.now() } } }
  }),
  markPaneResponseComplete: (paneId, source = 'agent-response', reportedSessionId) => set((state) => {
    const sessionId = reportedSessionId ?? state.activeSessionId
    if (!sessionId) return {}
    const pane = state.panes[paneId]
    // The terminal-output heuristic only observes the attached workspace, so
    // it still requires a live recognized agent pane. Hook/task signals carry
    // their daemon-validated workspace id and remain authoritative even after
    // the user switched elsewhere and the pane left the frontend snapshot.
    if (source === 'agent-response') {
      if (sessionId !== state.activeSessionId || !pane?.alive || !isAgentPane(pane, state.settings)) return {}
    } else if (!reportedSessionId && (!pane?.alive || sessionId !== state.activeSessionId)) {
      return {}
    }
    return {
      paneAgentActivity: withoutPaneKey(state.paneAgentActivity, paneId),
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
  reorderWorkspaces: (orderedIds: string[]) => {
    if (get().settings.workspaceSortMode !== 'manual') return
    get().updateSettings({ workspaceOrder: orderedIds })
  },
  createWorkspaceGroup: (name: string, rootFolder?: string | null) => {
    const group: WorkspaceGroup = {
      id: crypto.randomUUID(),
      name: name.trim() || 'Workspace group',
      collapsed: false,
      rootFolder: normalizeWorkspaceFolder(rootFolder),
    }
    get().updateSettings({ workspaceGroups: [...get().settings.workspaceGroups, group] })
    return group
  },
  renameWorkspaceGroup: (groupId: string, name: string) => {
    const normalizedName = name.trim()
    if (!normalizedName) return
    get().updateSettings({
      workspaceGroups: get().settings.workspaceGroups.map((group) =>
        group.id === groupId ? { ...group, name: normalizedName } : group,
      ),
    })
  },
  setWorkspaceGroupRootFolder: (groupId: string, rootFolder: string | null) => {
    const normalizedRootFolder = normalizeWorkspaceFolder(rootFolder)
    get().updateSettings({
      workspaceGroups: get().settings.workspaceGroups.map((group) =>
        group.id === groupId ? { ...group, rootFolder: normalizedRootFolder } : group,
      ),
    })
  },
  deleteWorkspaceGroup: (groupId: string) => {
    get().updateSettings({
      workspaceGroups: get().settings.workspaceGroups.filter((group) => group.id !== groupId),
      workspaceGroupIds: Object.fromEntries(
        Object.entries(get().settings.workspaceGroupIds).filter(([, assignedGroupId]) => assignedGroupId !== groupId),
      ),
    })
  },
  setWorkspaceGroup: (sessionId: string, groupId: string | null) => {
    const workspaceGroupIds = { ...get().settings.workspaceGroupIds }
    if (groupId === null) delete workspaceGroupIds[sessionId]
    else workspaceGroupIds[sessionId] = groupId
    get().updateSettings({ workspaceGroupIds })
  },
  toggleWorkspaceGroupCollapsed: (groupId: string) => {
    get().updateSettings({
      workspaceGroups: get().settings.workspaceGroups.map((group) =>
        group.id === groupId ? { ...group, collapsed: !group.collapsed } : group,
      ),
    })
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
            const worktreePath = await createTaskWorktree(get, session, taskId)
            await get().updateTask(taskId, { worktreePath, baselineRef: 'HEAD' })
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
          const worktreePath = await createTaskWorktree(get, session, taskId)
          await get().updateTask(taskId, { worktreePath, baselineRef: 'HEAD' })
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
        const started = await invoke<{ generation: number }>('hermes_start', {
          sessionId,
          commandOverride: get().settings.hermesCommand || null,
          workspaceFolder: session?.workspaceFolder ?? null,
        })
        get().setHermesGeneration(sessionId, started.generation)
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
  setHermesGeneration: (sessionId: string, generation: number) => {
    set((state) => ({
      hermesGenerations: { ...state.hermesGenerations, [sessionId]: generation },
      hermesPermissions: {
        ...state.hermesPermissions,
        [sessionId]: (state.hermesPermissions[sessionId] ?? []).filter((permission) => permission.generation === generation),
      },
    }))
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
    const prompt: HermesPendingPrompt = { id: crypto.randomUUID(), text, status: 'queued' }
    set((state) => ({
      hermesPendingPrompts: {
        ...state.hermesPendingPrompts,
        [sessionId]: [...(state.hermesPendingPrompts[sessionId] ?? []), prompt],
      },
    }))
  },
  claimHermesPrompt: (sessionId) => {
    const queue = get().hermesPendingPrompts[sessionId] ?? []
    if (queue.some((prompt) => prompt.status === 'sending')) return undefined
    const index = queue.findIndex((prompt) => prompt.status === 'queued')
    if (index < 0) return undefined
    const claimed = { ...queue[index], status: 'sending' as const }
    const next = [...queue]
    next[index] = claimed
    set((state) => ({ hermesPendingPrompts: { ...state.hermesPendingPrompts, [sessionId]: next } }))
    return claimed
  },
  ackHermesPrompt: (sessionId, promptId) => {
    set((state) => ({
      hermesPendingPrompts: {
        ...state.hermesPendingPrompts,
        [sessionId]: (state.hermesPendingPrompts[sessionId] ?? []).filter((prompt) => prompt.id !== promptId),
      },
    }))
  },
  releaseHermesPrompt: (sessionId, promptId) => {
    set((state) => ({
      hermesPendingPrompts: {
        ...state.hermesPendingPrompts,
        [sessionId]: (state.hermesPendingPrompts[sessionId] ?? []).map((prompt) => (
          prompt.id === promptId && prompt.status === 'sending' ? { ...prompt, status: 'queued' as const } : prompt
        )),
      },
    }))
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
  if (state.paneCompletionHighlights !== previousState.paneCompletionHighlights) persistPaneCompletionHighlights(state.paneCompletionHighlights)
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

function paneRecordsEqual(left: Record<string, PaneMeta>, right: Record<string, PaneMeta>): boolean {
  const paneIds = Object.keys(left)
  if (paneIds.length !== Object.keys(right).length) return false
  for (const paneId of paneIds) {
    const leftPane = left[paneId]
    const rightPane = right[paneId]
    if (!rightPane || leftPane.id !== rightPane.id || leftPane.alive !== rightPane.alive) return false
    const leftConfig = leftPane.config
    const rightConfig = rightPane.config
    if (leftConfig.paneId !== rightConfig.paneId
      || leftConfig.shell !== rightConfig.shell
      || leftConfig.cwd !== rightConfig.cwd
      || leftConfig.title !== rightConfig.title
      || leftConfig.icon !== rightConfig.icon
      || leftConfig.profileId !== rightConfig.profileId
      || leftConfig.role !== rightConfig.role
      || leftConfig.cols !== rightConfig.cols
      || leftConfig.rows !== rightConfig.rows
      || leftConfig.args.length !== rightConfig.args.length
      || leftConfig.env.length !== rightConfig.env.length) return false
    for (let index = 0; index < leftConfig.args.length; index += 1) {
      if (leftConfig.args[index] !== rightConfig.args[index]) return false
    }
    for (let index = 0; index < leftConfig.env.length; index += 1) {
      if (leftConfig.env[index][0] !== rightConfig.env[index]?.[0] || leftConfig.env[index][1] !== rightConfig.env[index]?.[1]) return false
    }
  }
  return true
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

function stateWithoutSession(state: WorkspaceState, sessionId: string, sessions: SessionMeta[]): Partial<WorkspaceState> {
  const deletedPaneIds = state.activeSessionId === sessionId ? Object.keys(state.panes) : []
  const taskIds = new Set(state.kanban.taskOrder[sessionId] ?? [])
  const tasks = { ...state.kanban.tasks }
  for (const taskId of taskIds) delete tasks[taskId]
  const taskOrder = { ...state.kanban.taskOrder }
  delete taskOrder[sessionId]
  const viewModes = { ...state.viewModes }
  const kanbanLayouts = { ...state.kanbanLayouts }
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
  const hermesGenerations = { ...state.hermesGenerations }
  const hermesCurrentSession = { ...state.hermesCurrentSession }
  const hermesSessions = { ...state.hermesSessions }
  const workspaceProfileIds = { ...state.settings.workspaceProfileIds }
  const workspaceDetails = { ...state.settings.workspaceDetails }
  const workspaceGroupIds = { ...state.settings.workspaceGroupIds }
  delete workspaceProfileIds[sessionId]
  delete workspaceDetails[sessionId]
  delete workspaceGroupIds[sessionId]
  for (const collection of [viewModes, kanbanLayouts, orchestratorPaneIds, selectedTaskId, workspaceTodos, workspaceTodoNotes, workspaceBriefs, hermesStatus, hermesTranscript, hermesPermissions, hermesUsage, hermesModels, hermesPendingPrompts, hermesGenerations, hermesCurrentSession, hermesSessions]) {
    delete collection[sessionId]
  }
  return {
    sessions,
    activeSessionId: state.activeSessionId === sessionId ? undefined : state.activeSessionId,
    panes: state.activeSessionId === sessionId ? {} : state.panes,
    paneLifecycle: state.activeSessionId === sessionId ? {} : state.paneLifecycle,
    activePaneId: state.activeSessionId === sessionId ? undefined : state.activePaneId,
    kanban: { tasks, taskOrder },
    viewModes,
    kanbanLayouts,
    orchestratorPaneIds,
    selectedTaskId,
    workspaceTodos,
    workspaceTodoNotes,
    workspaceBriefs,
    hermesStatus,
    hermesTranscript,
    hermesPermissions,
    hermesUsage,
    hermesModels,
    hermesPendingPrompts,
    hermesGenerations,
    hermesCurrentSession,
    hermesSessions,
    manualPaneTitles: withoutPaneKeys(state.manualPaneTitles, deletedPaneIds),
    capturesByPane: withoutPaneKeys(state.capturesByPane, deletedPaneIds),
    paneCompletionHighlights: withoutSessionCompletionHighlights(state.paneCompletionHighlights, sessionId),
    paneReviewMarkers: withoutSessionReviewMarkers(state.paneReviewMarkers, sessionId),
    settings: {
      ...state.settings,
      paneRoles: withoutPaneKeys(state.settings.paneRoles, deletedPaneIds),
      workspaceProfileIds,
      workspaceDetails,
      workspaceGroupIds,
      workspaceOrder: state.settings.workspaceOrder.filter((id) => id !== sessionId),
    },
  }
}

function withoutSessionReviewMarkers(
  markers: Record<string, PaneReviewMarker>,
  sessionId: string,
): Record<string, PaneReviewMarker> {
  const nextEntries = Object.entries(markers).filter(([, marker]) => marker.sessionId !== sessionId)
  if (nextEntries.length === Object.keys(markers).length) return markers
  return Object.fromEntries(nextEntries)
}

export function loadPaneCompletionHighlights(storage?: Pick<Storage, 'getItem'> | null): Record<string, PaneCompletionHighlight> {
  const target = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
  if (!target) return {}
  try {
    const parsed = JSON.parse(target.getItem(paneCompletionHighlightsStorageKey) ?? '{}') as unknown
    if (!isRecord(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, PaneCompletionHighlight] => {
      const [paneId, highlight] = entry
      return paneId.length > 0
        && isRecord(highlight)
        && typeof highlight.completedAt === 'number'
        && Number.isFinite(highlight.completedAt)
        && highlight.completedAt > 0
        && (highlight.source === 'agent-response' || highlight.source === 'task-done' || highlight.source === 'agent-hook')
        && typeof highlight.sessionId === 'string'
        && highlight.sessionId.length > 0
    }))
  } catch {
    return {}
  }
}

export function persistPaneCompletionHighlights(highlights: Record<string, PaneCompletionHighlight>, storage?: Pick<Storage, 'setItem' | 'removeItem'> | null): void {
  const target = storage === undefined ? (typeof window === 'undefined' ? null : window.localStorage) : storage
  if (!target) return
  try {
    if (Object.keys(highlights).length === 0) target.removeItem(paneCompletionHighlightsStorageKey)
    else target.setItem(paneCompletionHighlightsStorageKey, JSON.stringify(highlights))
  } catch {
    // Completion acknowledgements are durable convenience state; storage failures must not block terminal interaction.
  }
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

export type WorktreeMigrationResult = { projections: WorktreeProjection[]; migrated: boolean }

// Sends the raw pre-registry `workspaceWorktrees` map to the daemon exactly
// once. `migrated` is true only when every repository reconciled, including
// those carrying legacy rows; otherwise the caller keeps the marker at 0 and
// the next launch replays the identical payload.
async function reconcileWorkspaceWorktrees(
  sessions: SessionMeta[],
  migrationVersion: number,
): Promise<WorktreeMigrationResult> {
  const legacy = migrationVersion >= 1 ? {} : readLegacyWorkspaceWorktrees()
  const legacyByRepository = legacyRowsByRepository(legacy)
  const repositories = new Set<string>(legacyByRepository.keys())
  for (const session of sessions) {
    const folder = normalizeWorkspaceFolder(session.workspaceFolder)
    if (folder) repositories.add(folder)
  }
  const byId = new Map<string, WorktreeProjection>()
  let migrated = true
  for (const repositoryPath of repositories) {
    const legacyRows = legacyByRepository.get(repositoryPath) ?? []
    try {
      const projections = await reconcileWorktrees({ repositoryPath, legacyRows })
      for (const projection of projections) byId.set(projection.id, projection)
    } catch (error) {
      migrated = false
      // A repository that cannot be reconciled at all (deleted folder, not a
      // repository any more) must not block startup, but it also must not let
      // the migration marker claim success.
      if (legacyRows.length > 0) {
        throw new Error(`Legacy worktree migration failed for ${repositoryPath}: ${String(error)}`, { cause: error })
      }
    }
  }
  return { projections: [...byId.values()], migrated }
}

function readLegacyWorkspaceWorktrees(): Record<string, LegacyWorkspaceWorktree> {
  try {
    const raw = window.localStorage.getItem('vibelink:settings')
    const parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {}
    return normalizeLegacyWorkspaceWorktrees(parsed.workspaceWorktrees)
  } catch {
    return {}
  }
}

// Drops the legacy key from persisted settings once the registry owns the
// relations. Runs only after a fully successful reconcile.
function forgetLegacyWorkspaceWorktrees(): void {
  if (typeof window === 'undefined') return
  try {
    const raw = window.localStorage.getItem('vibelink:settings')
    if (!raw) return
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (!('workspaceWorktrees' in parsed)) return
    delete parsed.workspaceWorktrees
    window.localStorage.setItem('vibelink:settings', JSON.stringify(parsed))
  } catch {
    // Losing the cleanup is harmless: the marker already suppresses re-migration.
  }
}

function projectionState(projections: WorktreeProjection[]): Pick<WorkspaceState, 'worktreeProjections' | 'worktreesById' | 'worktreeIdsBySessionId'> {
  return { worktreeProjections: projections, ...indexWorktrees(projections) }
}

function sameRepository(projection: WorktreeProjection, repositoryPath: string): boolean {
  const candidate = projection.record?.repositoryPath
  if (!candidate) return false
  const normalize = (path: string) => path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return normalize(candidate) === normalize(repositoryPath)
}

function requireRecord(state: WorkspaceState, worktreeId: string): WorktreeRecord {
  const record = state.worktreesById[worktreeId]?.record
  if (!record) throw new Error(`Worktree "${worktreeId}" has no managed registry record.`)
  return record
}

// Removal consent is exact. Hard blockers can never be acknowledged, and a
// forceable blocker the caller did not acknowledge — because it appeared after
// the confirmation dialog closed — refuses the removal instead of inheriting
// consent that was given for a different state.
function assertRemovalAcknowledged(
  preflight: WorktreeRemovalPreflight,
  acknowledgedBlockers: WorktreeBlockerKind[],
): void {
  const hard = preflight.blockers.find((blocker) => blocker.hard)
  if (hard) throw new Error(hard.message)
  const acknowledged = new Set(acknowledgedBlockers)
  const unacknowledged = preflight.blockers.filter((blocker) => !acknowledged.has(blocker.kind))
  if (unacknowledged.length === 0) return
  throw new Error(`Worktree removal was refused because these blockers were not acknowledged: ${unacknowledged.map((blocker) => blocker.message).join(' ')}`)
}

// Every GUI-owned resource keyed by a workspace session. deleteSession and the
// externally-removed-session path both funnel through here so no caller can
// forget one of the maps.
async function releaseSessionResources(sessionId: string, workspaceFolder: string | null | undefined): Promise<void> {
  if (workspaceFolder) disposeEditorDocumentStore(sessionId, workspaceFolder)
  useGitStore.getState().clearSession(sessionId)
  await invoke('browser_cleanup_workspace', { workspaceId: sessionId })
  await invoke('agent_workspace_cleanup', { sessionId })
}

// Isolated task assignment creates a real registry-owned worktree rather than a
// path-only checkout, so the task's worktree participates in the same identity,
// preflight, and removal lifecycle as every other worktree.
async function createTaskWorktree(get: StoreGet, session: SessionMeta, taskId: string): Promise<string> {
  const repositoryPath = normalizeWorkspaceFolder(session.workspaceFolder)
  if (!repositoryPath) throw new Error('An isolated task needs a repository workspace folder.')
  const result = await createWorktree({
    operationId: crypto.randomUUID(),
    repositoryPath,
    parentSessionId: session.id,
    parentWorktreeId: worktreeBySession(get().worktreeProjections, session.id)?.record?.id ?? null,
    name: `task-${taskId}`,
    startRef: 'HEAD',
    branch: null,
    storage: get().settings.worktreeStorage,
    fetch: false,
    setupPolicy: 'inherit',
    sparsePreset: null,
    linkedFiles: [],
    profileId: null,
    initialAgent: null,
    initialPrompt: null,
    origin: 'automation',
  })
  await Promise.all([get().refreshSessions(), get().refreshWorktrees()])
  return result.worktree.worktreePath
}

const settledCreationStages = new Set<PendingWorktreeCreation['stage']>(['complete', 'failed', 'cancelled'])

function isSettledStage(stage: PendingWorktreeCreation['stage']): boolean {
  return settledCreationStages.has(stage)
}

function buildWorktreeCreateRequest(state: WorkspaceState, input: CreateWorkspaceWorktreeInput): WorktreeCreateRequest {
  const parent = state.sessions.find((session) => session.id === input.parentSessionId)
  const repositoryPath = normalizeWorkspaceFolder(parent?.workspaceFolder)
  if (!parent || !repositoryPath) throw new Error('A repository workspace folder is required to create a worktree.')
  const name = input.name.trim()
  const startRef = input.startRef.trim()
  const branch = input.branch.trim()
  if (!name || !startRef) throw new Error('Worktree name and start ref are required.')
  const parentWorktree = worktreeBySession(state.worktreeProjections, parent.id)?.record ?? null
  return {
    operationId: crypto.randomUUID(),
    repositoryPath,
    parentSessionId: parent.id,
    parentWorktreeId: parentWorktree?.id ?? null,
    name,
    startRef,
    branch: branch || null,
    storage: state.settings.worktreeStorage,
    fetch: input.fetch ?? false,
    setupPolicy: input.setupPolicy ?? 'inherit',
    sparsePreset: input.sparsePreset ?? null,
    linkedFiles: input.linkedFiles ?? [],
    profileId: input.profileId || null,
    initialAgent: input.initialAgent ?? null,
    initialPrompt: input.initialPrompt ?? null,
    origin: 'manual',
  }
}

function patchPendingCreation(
  operationId: string,
  patch: Partial<PendingWorktreeCreation>,
): (state: WorkspaceState) => Partial<WorkspaceState> {
  return (state) => {
    const pending = state.pendingWorktreeCreations[operationId]
    if (!pending) return {}
    return {
      pendingWorktreeCreations: {
        ...state.pendingWorktreeCreations,
        [operationId]: { ...pending, ...patch, updatedAt: Date.now() },
      },
    }
  }
}

function withoutPendingCreation(operationId: string): (state: WorkspaceState) => Partial<WorkspaceState> {
  return (state) => {
    if (!(operationId in state.pendingWorktreeCreations)) return {}
    const pendingWorktreeCreations = { ...state.pendingWorktreeCreations }
    delete pendingWorktreeCreations[operationId]
    return { pendingWorktreeCreations }
  }
}

type StoreSet = (partial: Partial<WorkspaceState> | ((state: WorkspaceState) => Partial<WorkspaceState>)) => void
type StoreGet = () => WorkspaceState

// Runs a create operation behind a pending row. The row is what the sidebar and
// content panel render, so it exists before the first daemon round-trip and
// survives failure/cancellation until the user retries or dismisses it.
async function runWorktreeCreation(
  set: StoreSet,
  get: StoreGet,
  request: WorktreeCreateRequest,
  profileId?: string | null,
): Promise<SessionMeta> {
  const now = Date.now()
  const pending: PendingWorktreeCreation = {
    operationId: request.operationId,
    parentSessionId: request.parentSessionId,
    repositoryPath: request.repositoryPath,
    name: request.name,
    branch: request.branch ?? '',
    startRef: request.startRef,
    stage: 'validating',
    startedAt: now,
    updatedAt: now,
    cancelRequested: false,
    error: null,
    sessionId: null,
    request,
  }
  set((state) => ({ pendingWorktreeCreations: { ...state.pendingWorktreeCreations, [request.operationId]: pending } }))
  // Where the user was when provisioning began. Completion only steals focus if
  // they are still on the pending surface or its parent repository.
  const focusOrigin = get().activeSessionId
  let result: WorktreeCreateResult
  try {
    set(patchPendingCreation(request.operationId, { stage: 'creating' }))
    result = await createWorktree(request)
  } catch (caught) {
    const cancelled = get().pendingWorktreeCreations[request.operationId]?.cancelRequested ?? false
    set(patchPendingCreation(request.operationId, {
      stage: cancelled ? 'cancelled' : 'failed',
      error: String(caught),
    }))
    throw caught
  }
  set(patchPendingCreation(request.operationId, { stage: 'binding', sessionId: result.sessionId }))
  await Promise.all([get().refreshSessions(), get().refreshWorktrees()])
  const initialAgentProfile = request.initialAgent
    ? get().settings.profiles.find((profile) => profile.id === request.initialAgent)?.id
    : null
  const launchProfileId = initialAgentProfile ?? profileId
  if (launchProfileId) {
    get().updateSettings({
      workspaceProfileIds: { ...get().settings.workspaceProfileIds, [result.sessionId]: launchProfileId },
    })
  }
  const settings = get().settings
  if (settings.workspaceSortMode === 'manual') {
    const workspaceOrder = orderSessions(get().sessions, settings.workspaceOrder)
      .map((session) => session.id)
      .filter((sessionId) => sessionId !== result.sessionId)
    const siblingIds = new Set(get().worktreeProjections.flatMap((projection) => projection.record?.parentSessionId === request.parentSessionId && projection.record.sessionId ? [projection.record.sessionId] : []))
    let insertAt = workspaceOrder.indexOf(request.parentSessionId)
    if (insertAt < 0) insertAt = workspaceOrder.length - 1
    while (insertAt + 1 < workspaceOrder.length && siblingIds.has(workspaceOrder[insertAt + 1])) insertAt += 1
    workspaceOrder.splice(insertAt + 1, 0, result.sessionId)
    get().updateSettings({ workspaceOrder })
  }
  const created = get().sessions.find((session) => session.id === result.sessionId)
  if (!created) throw new Error('Created worktree session was not returned by the daemon.')
  set(patchPendingCreation(request.operationId, { stage: 'complete' }))
  // Background completion: the user moved to another workspace while the
  // checkout was provisioning, so the finished worktree stays available in the
  // sidebar instead of yanking them out of what they are doing.
  const stillWatching = get().activeSessionId === focusOrigin
    && (focusOrigin === undefined || focusOrigin === request.parentSessionId)
  if (stillWatching) {
    set(withoutPendingCreation(request.operationId))
    const attached = await get().attachSession(result.sessionId)
    const prompt = request.initialPrompt?.trim()
    if (prompt) {
      const paneId = get().activeSessionId === result.sessionId
        ? get().activePaneId ?? Object.values(get().panes)[0]?.id
        : attached.panes[0]?.id
      if (!paneId) throw new Error('The initial agent pane was not created.')
      await sendToPane(result.sessionId, paneId, prompt, false)
      await delay(120)
      await submitAgentPrompt(result.sessionId, paneId)
    }
  }
  return created
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

function recoverWorkspaceGroupsOnce(settings: Settings, sessions: readonly SessionMeta[]): { settings: Settings; recovered: boolean } {
  if (typeof window === 'undefined') return { settings, recovered: false }
  try {
    if (window.localStorage.getItem(workspaceGroupRecoveryStorageKey) === '1') return { settings, recovered: false }
    window.localStorage.setItem(workspaceGroupRecoveryStorageKey, '1')
    if (settings.workspaceGroups.length > 0) return { settings, recovered: false }
    const recovered = recoverWorkspaceGroups(sessions)
    if (!recovered) return { settings, recovered: false }
    return {
      settings: normalizeSettings({
        ...settings,
        workspaceGroups: recovered.groups,
        workspaceGroupIds: recovered.groupIds,
      }),
      recovered: true,
    }
  } catch {
    return { settings, recovered: false }
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

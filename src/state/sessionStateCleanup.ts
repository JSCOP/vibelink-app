import type { PaneMeta, SessionMeta, WorkspaceBrief } from '../ipc/types'
import type { HermesModelsState, HermesPendingPrompt, HermesSessionInfo, HermesStatus, HermesTurn, PendingPermission } from './hermes'
import type { KanbanData } from './kanban'
import type { ViewMode } from './kanbanPersistence'
import type { ManualPaneTitleMap } from './paneTitles'
import type { Settings } from './profiles'
import type { WorkspaceTodoLists, WorkspaceTodoNotes } from './workspaceTodos'

/**
 * Single cleanup point for every session-scoped map, so adding one has exactly one place to update.
 * Cleans panes, paneLifecycle, kanban.tasks/taskOrder, viewModes, kanbanLayouts, orchestratorPaneIds,
 * selectedTaskId, workspaceTodos, workspaceTodoNotes, workspaceBriefs, hermesStatus, hermesTranscript,
 * hermesPermissions, hermesUsage, hermesModels, hermesPendingPrompts, hermesGenerations,
 * hermesCurrentSession, hermesSessions, manualPaneTitles, capturesByPane, captureSessionByPane,
 * paneCompletionHighlights, paneReviewMarkers, settings.paneRoles, settings.workspaceProfileIds,
 * settings.workspaceDetails, settings.workspaceGroupIds, and settings.workspaceOrder.
 */
type SessionMarker = { sessionId: string }

type SessionCleanupState<
  TPaneLifecycle,
  TCompletionHighlight extends SessionMarker,
  TReviewMarker extends SessionMarker,
> = {
  activeSessionId?: string
  panes: Record<string, PaneMeta>
  paneLifecycle: Record<string, TPaneLifecycle>
  activePaneId?: string
  kanban: KanbanData
  viewModes: Record<string, ViewMode>
  kanbanLayouts: Record<string, string>
  orchestratorPaneIds: Record<string, string>
  selectedTaskId: Record<string, string | null>
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
  manualPaneTitles: ManualPaneTitleMap
  capturesByPane: Record<string, string[]>
  captureSessionByPane: Record<string, string>
  paneCompletionHighlights: Record<string, TCompletionHighlight>
  paneReviewMarkers: Record<string, TReviewMarker>
  settings: Settings
}

export function withoutPaneKeys<T>(record: Record<string, T>, paneIds: readonly string[]): Record<string, T> {
  let next: Record<string, T> | null = null
  for (const paneId of paneIds) {
    if (!(paneId in record)) continue
    next ??= { ...record }
    delete next[paneId]
  }
  return next ?? record
}

function withoutSessionCompletionHighlights<T extends SessionMarker>(
  highlights: Record<string, T>,
  sessionId: string,
): Record<string, T> {
  const nextEntries = Object.entries(highlights).filter(([, highlight]) => highlight.sessionId !== sessionId)
  if (nextEntries.length === Object.keys(highlights).length) return highlights
  return Object.fromEntries(nextEntries)
}

function withoutSessionReviewMarkers<T extends SessionMarker>(
  markers: Record<string, T>,
  sessionId: string,
): Record<string, T> {
  const nextEntries = Object.entries(markers).filter(([, marker]) => marker.sessionId !== sessionId)
  if (nextEntries.length === Object.keys(markers).length) return markers
  return Object.fromEntries(nextEntries)
}

export function stateWithoutSession<
  TPaneLifecycle,
  TCompletionHighlight extends SessionMarker,
  TReviewMarker extends SessionMarker,
>(
  state: SessionCleanupState<TPaneLifecycle, TCompletionHighlight, TReviewMarker>,
  sessionId: string,
  sessions: SessionMeta[],
) {
  const deletedPaneIds = state.activeSessionId === sessionId ? Object.keys(state.panes) : []
  const capturedPaneIds = Object.keys(state.captureSessionByPane).filter((paneId) => state.captureSessionByPane[paneId] === sessionId)
  const deletedCapturePaneIds = [...deletedPaneIds, ...capturedPaneIds]
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
    capturesByPane: withoutPaneKeys(state.capturesByPane, deletedCapturePaneIds),
    captureSessionByPane: withoutPaneKeys(state.captureSessionByPane, deletedCapturePaneIds),
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

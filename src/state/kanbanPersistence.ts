import { emptyKanban, normalizeKanban, type KanbanData } from './kanban'
import { normalizeWorkspaceTodoLists, normalizeWorkspaceTodoNotes, type WorkspaceTodoLists, type WorkspaceTodoNotes } from './workspaceTodos'

export type ViewMode = 'terminal' | 'kanban'

export type PersistedKanbanState = {
  data: KanbanData
  viewModes: Record<string, ViewMode>
  kanbanLayouts: Record<string, string>
  orchestratorPaneIds: Record<string, string>
  workspaceTodos: WorkspaceTodoLists
  workspaceTodoNotes: WorkspaceTodoNotes
}

type KanbanBlobV1 = PersistedKanbanState & { version: 1; layoutVersion?: number }
type KanbanBlobV2 = Omit<PersistedKanbanState, 'data'> & { version: 2; layoutVersion?: number }

const storageKey = 'vibelink:kanban'
const layoutVersion = 2

export function loadKanban(): PersistedKanbanState {
  if (typeof window === 'undefined') return emptyPersistedKanban()
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return emptyPersistedKanban()
    const parsed = JSON.parse(raw) as Partial<KanbanBlobV1> | Partial<KanbanBlobV2>
    const legacyData = 'data' in parsed ? parsed.data : undefined
    return {
      data: parsed.version === 1 ? normalizeKanban(legacyData) : emptyKanban(),
      viewModes: normalizeStringRecord(parsed.viewModes, isViewMode),
      kanbanLayouts: parsed.layoutVersion === layoutVersion ? normalizeStringRecord(parsed.kanbanLayouts) : {},
      orchestratorPaneIds: normalizeStringRecord(parsed.orchestratorPaneIds),
      workspaceTodos: normalizeWorkspaceTodoLists(parsed.workspaceTodos),
      workspaceTodoNotes: normalizeWorkspaceTodoNotes(parsed.workspaceTodoNotes),
    }
  } catch {
    return emptyPersistedKanban()
  }
}

export function persistKanban(state: PersistedKanbanState): void {
  if (typeof window === 'undefined') return
  const blob: KanbanBlobV2 = {
    version: 2,
    layoutVersion,
    viewModes: normalizeStringRecord(state.viewModes, isViewMode),
    kanbanLayouts: normalizeStringRecord(state.kanbanLayouts),
    orchestratorPaneIds: normalizeStringRecord(state.orchestratorPaneIds),
    workspaceTodos: normalizeWorkspaceTodoLists(state.workspaceTodos),
    workspaceTodoNotes: normalizeWorkspaceTodoNotes(state.workspaceTodoNotes),
  }
  window.localStorage.setItem(storageKey, JSON.stringify(blob))
}

export function legacyTasksForSession(state: PersistedKanbanState, sessionId: string): KanbanData {
  const taskOrder = state.data.taskOrder[sessionId] ?? []
  return {
    tasks: Object.fromEntries(taskOrder.flatMap((taskId) => {
      const task = state.data.tasks[taskId]
      return task?.sessionId === sessionId ? [[taskId, task]] : []
    })),
    taskOrder: { [sessionId]: taskOrder.filter((taskId) => state.data.tasks[taskId]?.sessionId === sessionId) },
  }
}
export function mergeLegacyTasksIntoBoard(
  sessionId: string,
  boardJson: string,
  legacyState: PersistedKanbanState,
): string | null {
  const legacy = legacyTasksForSession(legacyState, sessionId)
  const legacyOrder = legacy.taskOrder[sessionId] ?? []
  if (legacyOrder.length === 0) return null
  try {
    const board = JSON.parse(boardJson) as { revision?: number; tasks?: Record<string, unknown>; taskOrder?: unknown; brief?: unknown }
    const boardTasks = board.tasks && typeof board.tasks === 'object' && !Array.isArray(board.tasks) ? board.tasks : {}
    const boardOrder = Array.isArray(board.taskOrder) ? board.taskOrder.filter((id): id is string => typeof id === 'string') : []
    const missingIds = legacyOrder.filter((id) => !(id in boardTasks) && Boolean(legacy.tasks[id]))
    if (missingIds.length === 0) return null
    return JSON.stringify({
      ...board,
      tasks: { ...legacy.tasks, ...boardTasks },
      taskOrder: [...boardOrder, ...missingIds],
    })
  } catch {
    return null
  }
}


function emptyPersistedKanban(): PersistedKanbanState {
  return {
    data: emptyKanban(),
    viewModes: {},
    kanbanLayouts: {},
    orchestratorPaneIds: {},
    workspaceTodos: {},
    workspaceTodoNotes: {},
  }
}

function normalizeStringRecord<T extends string = string>(
  value: unknown,
  predicate?: (item: string) => item is T,
): Record<string, T> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, T] =>
        entry[0].trim().length > 0 &&
        typeof entry[1] === 'string' &&
        (!predicate || predicate(entry[1])),
    ),
  )
}

function isViewMode(value: string): value is ViewMode {
  return value === 'terminal' || value === 'kanban'
}

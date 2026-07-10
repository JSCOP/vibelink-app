import type { HermesGatewayConfig } from '../ipc/types'
import { emptyKanban, normalizeKanban, type KanbanData } from './kanban'
import { normalizeWorkspaceTodoLists, normalizeWorkspaceTodoNotes, type WorkspaceTodoLists, type WorkspaceTodoNotes } from './workspaceTodos'

export type ViewMode = 'terminal' | 'kanban'

export type PersistedKanbanState = {
  data: KanbanData
  viewModes: Record<string, ViewMode>
  kanbanLayouts: Record<string, string>
  orchestratorPaneIds: Record<string, string>
  hermesGateways: Record<string, HermesGatewayConfig>
  workspaceTodos: WorkspaceTodoLists
  workspaceTodoNotes: WorkspaceTodoNotes
}

type KanbanBlob = PersistedKanbanState & { version: 1; layoutVersion?: number }

const storageKey = 'vibelink:kanban'
const layoutVersion = 2


export function loadKanban(): PersistedKanbanState {
  if (typeof window === 'undefined') return emptyPersistedKanban()
  try {
    const raw = window.localStorage.getItem(storageKey)
    if (!raw) return emptyPersistedKanban()
    const parsed = JSON.parse(raw) as Partial<KanbanBlob>
    return {
      data: normalizeKanban(parsed.data),
      viewModes: normalizeStringRecord(parsed.viewModes, isViewMode),
      kanbanLayouts: parsed.layoutVersion === layoutVersion ? normalizeStringRecord(parsed.kanbanLayouts) : {},
      orchestratorPaneIds: normalizeStringRecord(parsed.orchestratorPaneIds),
      hermesGateways: normalizeHermesGatewayRecord(parsed.hermesGateways),
      workspaceTodos: normalizeWorkspaceTodoLists(parsed.workspaceTodos),
      workspaceTodoNotes: normalizeWorkspaceTodoNotes(parsed.workspaceTodoNotes),
    }
  } catch {
    return emptyPersistedKanban()
  }
}

export function persistKanban(state: PersistedKanbanState): void {
  if (typeof window === 'undefined') return
  const blob: KanbanBlob = {
    version: 1,
    layoutVersion,
    data: normalizeKanban(state.data),
    viewModes: normalizeStringRecord(state.viewModes, isViewMode),
    kanbanLayouts: normalizeStringRecord(state.kanbanLayouts),
    orchestratorPaneIds: normalizeStringRecord(state.orchestratorPaneIds),
    hermesGateways: normalizeHermesGatewayRecord(state.hermesGateways),
    workspaceTodos: normalizeWorkspaceTodoLists(state.workspaceTodos),
    workspaceTodoNotes: normalizeWorkspaceTodoNotes(state.workspaceTodoNotes),
  }
  window.localStorage.setItem(storageKey, JSON.stringify(blob))
}

function emptyPersistedKanban(): PersistedKanbanState {
  return {
    data: emptyKanban(),
    viewModes: {},
    kanbanLayouts: {},
    orchestratorPaneIds: {},
    hermesGateways: {},
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


function normalizeHermesGatewayRecord(value: unknown): Record<string, HermesGatewayConfig> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([sessionId, entry]) => {
      const gateway = normalizeHermesGateway(entry)
      return sessionId.trim().length > 0 && gateway ? [[sessionId, gateway]] : []
    }),
  )
}

function normalizeHermesGateway(value: unknown): HermesGatewayConfig | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const platform = readGatewayPlatform(record.platform)
  const tokenEnv = readString(record.tokenEnv)
  const allowedUsers = readString(record.allowedUsers, '')
  if (!platform || !tokenEnv) return null
  return {
    platform,
    tokenEnv,
    tokenSet: record.tokenSet === true,
    allowedUsers,
  }
}

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}


function readGatewayPlatform(value: unknown): HermesGatewayConfig['platform'] | null {
  return value === 'telegram' || value === 'discord' || value === 'slack' ? value : null
}

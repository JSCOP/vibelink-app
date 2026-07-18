import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Task } from '../ipc/types'
import { loadKanban, mergeLegacyTasksIntoBoard, persistKanban, type PersistedKanbanState } from './kanbanPersistence'

const storage = new Map<string, string>()
const localStorageStub = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storage.set(key, value) }),
}

const task: Task = {
  id: 'legacy-task',
  sessionId: 'session-1',
  title: 'Legacy task',
  description: 'Imported once',
  status: 'pending',
  statusTimestamps: { pending: 1 },
  createdAt: 1,
  updatedAt: 1,
}

function legacyState(): PersistedKanbanState {
  return {
    data: { tasks: { [task.id]: task }, taskOrder: { [task.sessionId]: [task.id] } },
    viewModes: { [task.sessionId]: 'kanban' },
    kanbanLayouts: {},
    orchestratorPaneIds: {},
    workspaceTodos: {},
    workspaceTodoNotes: {},
  }
}

describe('kanban persistence migration', () => {
  beforeEach(() => {
    storage.clear()
    localStorageStub.getItem.mockClear()
    localStorageStub.setItem.mockClear()
    vi.stubGlobal('window', { localStorage: localStorageStub })
  })

  test('loads v1 tasks, then persists v2 view state without task data', () => {
    storage.set('vibelink:kanban', JSON.stringify({ version: 1, layoutVersion: 2, ...legacyState() }))

    const loaded = loadKanban()
    expect(loaded.data.tasks[task.id]).toEqual(task)

    persistKanban(loaded)
    const persisted = JSON.parse(storage.get('vibelink:kanban') ?? '{}')
    expect(persisted.version).toBe(2)
    expect(persisted.data).toBeUndefined()
    expect(persisted.tasks).toBeUndefined()
  })

  test('merges only missing legacy tasks and lets the native board win conflicts', () => {
    const boardTask = { ...task, title: 'Native task' }
    const boardJson = JSON.stringify({ revision: 7, tasks: { [task.id]: boardTask }, taskOrder: [task.id] })

    expect(mergeLegacyTasksIntoBoard(task.sessionId, boardJson, legacyState())).toBeNull()

    const emptyBoard = JSON.stringify({ revision: 2, tasks: {}, taskOrder: [] })
    const merged = JSON.parse(mergeLegacyTasksIntoBoard(task.sessionId, emptyBoard, legacyState()) ?? '{}')
    expect(merged.revision).toBe(2)
    expect(merged.tasks[task.id]).toEqual(task)
    expect(merged.taskOrder).toEqual([task.id])
  })
})

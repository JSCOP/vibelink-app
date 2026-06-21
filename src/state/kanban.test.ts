import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PaneMeta, SessionMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings } from './profiles'
import { normalizeKanban, tasksByStatus, tasksForSession } from './kanban'
import { loadKanban, persistKanban } from './kanbanPersistence'
import { useWorkspaceStore } from './store'

const session: SessionMeta = {
  id: 'session-1',
  name: 'Repo',
  paneCount: 1,
  createdAt: 1,
  workspaceFolder: 'E:/repo',
}

const nextSession: SessionMeta = {
  id: 'session-2',
  name: 'Next',
  paneCount: 0,
  createdAt: 2,
  workspaceFolder: null,
}

const pane: PaneMeta = {
  id: 'pane-1',
  alive: true,
  config: {
    paneId: 'pane-1',
    shell: 'pwsh.exe',
    args: [],
    cwd: 'E:/repo',
    env: [],
    title: 'Agent',
    cols: 120,
    rows: 32,
  },
}

const storage = new Map<string, string>()
const localStorageStub = {
  getItem: vi.fn((key: string) => storage.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { storage.set(key, value) }),
  removeItem: vi.fn((key: string) => { storage.delete(key) }),
  clear: vi.fn(() => storage.clear()),
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string) => {
    if (command === 'delete_session') return null
    if (command === 'list_sessions') return [nextSession]
    if (command === 'attach_session') return { layoutJson: null, panes: [] }
    if (command === 'spawn_pane') return pane
    return null
  }),
}))

describe('kanban store', () => {
  beforeEach(() => {
    storage.clear()
    vi.stubGlobal('window', { localStorage: localStorageStub })
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'task-1') })
    vi.mocked(invoke).mockClear()
    localStorageStub.getItem.mockClear()
    localStorageStub.setItem.mockClear()
    useWorkspaceStore.setState({
      sessions: [session],
      activeSessionId: session.id,
      panes: { [pane.id]: pane },
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      settings: normalizeSettings({ ...defaultSettings, paneRoles: { [pane.id]: 'Reviewer' } }),
      kanban: { tasks: {}, taskOrder: {} },
      viewModes: {},
      kanbanLayouts: {},
      orchestratorPaneIds: {},
      selectedTaskId: {},
    })
  })

  test('createTask adds a pending ordered task', () => {
    const task = useWorkspaceStore.getState().createTask(session.id, { title: 'Fix bug', description: 'Details' })

    expect(task.status).toBe('pending')
    expect(tasksForSession(useWorkspaceStore.getState().kanban, session.id).map((item) => item.id)).toEqual(['task-1'])
    expect(useWorkspaceStore.getState().selectedTaskId[session.id]).toBe('task-1')
  })

  test('assignTask stores pane, role, and assigned status', async () => {
    const task = useWorkspaceStore.getState().createTask(session.id, { title: 'Fix bug', description: '' })

    await useWorkspaceStore.getState().assignTask(task.id, pane.id)

    expect(useWorkspaceStore.getState().kanban.tasks[task.id]).toMatchObject({
      assignedPaneId: pane.id,
      assignedRole: 'Reviewer',
      status: 'in-progress',
    })
    const assignedTask = useWorkspaceStore.getState().kanban.tasks[task.id]
    expect(assignedTask.statusTimestamps.assigned).toEqual(expect.any(Number))
    expect(assignedTask.statusTimestamps['in-progress']).toEqual(expect.any(Number))
    const writes = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'write_pane')
    expect(writes).toHaveLength(2)
    expect(writes[0]?.[1]).toMatchObject({ sessionId: session.id, paneId: pane.id })
    expect((writes[0]?.[1] as { data: string }).data).toContain('[Task #task-1] Fix bug')
    expect((writes[0]?.[1] as { data: string }).data.endsWith('\r')).toBe(false)
    expect(writes[1]?.[1]).toMatchObject({ sessionId: session.id, paneId: pane.id, data: '\r' })


    useWorkspaceStore.getState().markTaskDone(task.id)
    expect(useWorkspaceStore.getState().kanban.tasks[task.id].statusTimestamps.done).toEqual(expect.any(Number))
  })

  test('moveTask transitions columns', () => {
    const task = useWorkspaceStore.getState().createTask(session.id, { title: 'Fix bug', description: '' })

    useWorkspaceStore.getState().moveTask(task.id, 'in-progress')

    expect(tasksByStatus(useWorkspaceStore.getState().kanban, session.id)['in-progress'].map((item) => item.id)).toEqual([task.id])
  })

  test('markTaskDone only updates the matching task and is idempotent', () => {
    const first = useWorkspaceStore.getState().createTask(session.id, { title: 'One', description: '' })
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'task-2') })
    const second = useWorkspaceStore.getState().createTask(session.id, { title: 'Two', description: '' })

    useWorkspaceStore.getState().markTaskDone(first.id, { commitMessage: 'done' })
    useWorkspaceStore.getState().markTaskDone(first.id, { commitMessage: 'done' })

    expect(useWorkspaceStore.getState().kanban.tasks[first.id]).toMatchObject({ status: 'done', commitMessage: 'done' })
    expect(useWorkspaceStore.getState().kanban.tasks[second.id].status).toBe('pending')
  })

  test('normalizeKanban round-trips through persistence', () => {
    const task = useWorkspaceStore.getState().createTask(session.id, { title: 'Persist', description: '' })
    persistKanban({
      data: useWorkspaceStore.getState().kanban,
      viewModes: { [session.id]: 'kanban' },
      kanbanLayouts: { [session.id]: '{"grid":true}' },
      orchestratorPaneIds: { [session.id]: pane.id },
      hermesGateways: {
        [session.id]: {
          platform: 'telegram',
          tokenEnv: 'TELEGRAM_BOT_TOKEN',
          tokenSet: true,
          allowedUsers: '123',
        },
      },
    })

    const loaded = loadKanban()

    expect(normalizeKanban(loaded.data).tasks[task.id].title).toBe('Persist')
    expect(loaded.viewModes[session.id]).toBe('kanban')
    expect(loaded.kanbanLayouts[session.id]).toBe('{"grid":true}')
    expect(loaded.orchestratorPaneIds[session.id]).toBe(pane.id)
    expect(loaded.hermesGateways[session.id]).toMatchObject({ platform: 'telegram', tokenSet: true })
  })

  test('old persisted kanban layouts are discarded after layout schema bump', () => {
    storage.set('awt:kanban', JSON.stringify({
      version: 1,
      data: { tasks: {}, taskOrder: {} },
      viewModes: { [session.id]: 'kanban' },
      kanbanLayouts: { [session.id]: '{"bad":true}' },
      orchestratorPaneIds: {},
    }))

    const loaded = loadKanban()

    expect(loaded.viewModes[session.id]).toBe('kanban')
    expect(loaded.kanbanLayouts[session.id]).toBeUndefined()
  })

  test('deleteSession prunes kanban state for that session', async () => {
    const task = useWorkspaceStore.getState().createTask(session.id, { title: 'Delete me', description: '' })
    useWorkspaceStore.getState().setViewMode(session.id, 'kanban')
    useWorkspaceStore.getState().setKanbanLayout(session.id, '{"grid":true}')
    useWorkspaceStore.getState().setOrchestratorPane(session.id, pane.id)
    useWorkspaceStore.getState().setHermesGateway(session.id, { tokenSet: true, allowedUsers: '123' })

    await useWorkspaceStore.getState().deleteSession(session.id)

    expect(useWorkspaceStore.getState().kanban.tasks[task.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().kanban.taskOrder[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().viewModes[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().kanbanLayouts[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().orchestratorPaneIds[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().hermesGateways[session.id]).toBeUndefined()
  })
})

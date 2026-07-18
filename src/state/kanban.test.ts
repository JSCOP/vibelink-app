import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { PaneMeta, SessionMeta, Task } from '../ipc/types'
import { defaultSettings, normalizeSettings } from './profiles'
import { composeAgentTaskPrompt, composeTaskPrompt, composeWorkspaceDigestPrompt, tasksByStatus, tasksForSession } from './kanban'
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
    icon: 'bot',
    profileId: 'codex',
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
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'delete_session' || command === 'board_task_delete') return null
    if (command === 'list_sessions') return [nextSession]
    if (command === 'attach_session') return { layoutJson: null, panes: [] }
    if (command === 'spawn_pane') return pane
    if (command === 'board_task_create') {
      return taskFixture(
        crypto.randomUUID(),
        String(args?.sessionId),
        String(args?.title),
        { description: String(args?.description ?? '') },
      )
    }
    if (command === 'board_task_update') {
      const current = useWorkspaceStore.getState().kanban.tasks[String(args?.taskId)]
      const patch = (args?.patch ?? {}) as Partial<Task>
      const now = Date.now()
      const status = patch.status ?? current.status
      return {
        ...current,
        ...patch,
        status,
        statusTimestamps: status !== current.status ? { ...current.statusTimestamps, [status]: now } : current.statusTimestamps,
        updatedAt: now,
      }
    }
    if (command === 'board_task_done') {
      const current = useWorkspaceStore.getState().kanban.tasks[String(args?.taskId)]
      const now = Date.now()
      return {
        ...current,
        status: 'done',
        statusTimestamps: { ...current.statusTimestamps, done: now },
        commitMessage: args?.commitMsg ?? current.commitMessage,
        resultSummary: args?.resultSummary ?? current.resultSummary,
        updatedAt: now,
      }
    }
    if (command === 'board_task_note') {
      const current = useWorkspaceStore.getState().kanban.tasks[String(args?.taskId)]
      const now = Date.now()
      const status = current.status === 'done' ? 'done' : 'in-progress'
      return {
        ...current,
        status,
        statusTimestamps: status !== current.status ? { ...current.statusTimestamps, [status]: now } : current.statusTimestamps,
        resultSummary: [current.resultSummary, String(args?.message)].filter(Boolean).join('\n'),
        updatedAt: now,
      }
    }
    if (command === 'board_brief_set') {
      return {
        purpose: String(args?.purpose ?? ''),
        notes: String(args?.notes ?? ''),
        updatedAt: '2026-07-13T00:00:00.000Z',
      }
    }
    if (command === 'hermes_runtime_status') return { detected: true, command: 'hermes-acp.exe', cliCommand: 'hermes.exe', version: '0.18.2', home: 'C:/hermes', source: 'path', configuredModel: { provider: 'openai-codex', model: 'gpt-5.5' } }
    if (command === 'git_snapshot_baseline') return 'HEAD'
    if (command === 'hermes_start') return { generation: 1 }
    return null
  }),
}))

function taskFixture(id: string, sessionId: string, title: string, patch: Partial<Task> = {}): Task {
  const status = patch.status ?? 'pending'
  const createdAt = patch.createdAt ?? 1
  const updatedAt = patch.updatedAt ?? createdAt
  return {
    id,
    sessionId,
    title,
    description: '',
    status,
    statusTimestamps: { [status]: updatedAt },
    createdAt,
    updatedAt,
    ...patch,
  }
}

test('composeTaskPrompt includes workspace purpose', () => {
  const task = taskFixture('task-brief', session.id, 'Ship feature')
  const prompt = composeTaskPrompt(task, {
    sessionId: session.id,
    role: 'Reviewer',
    brief: { purpose: 'Complete onboarding', notes: 'Keep native ownership', updatedAt: 'now' },
  })
  expect(prompt).toContain('Workspace purpose: Complete onboarding')
  expect(prompt).toContain('Role: Reviewer')
})

test('composeAgentTaskPrompt uses MCP task callbacks', () => {
  const task = taskFixture('task-agent', session.id, 'Ship feature')
  const prompt = composeAgentTaskPrompt(task, {
    brief: { purpose: 'Complete onboarding', notes: '', updatedAt: 'now' },
    worktreePath: 'E:/repo/.worktrees/task-agent',
  })
  expect(prompt).toContain('Workspace purpose: Complete onboarding')
  expect(prompt).toContain('Work in isolated git worktree: E:/repo/.worktrees/task-agent')
  expect(prompt).toContain('vibelink_task_note tool (taskId task-agent)')
  expect(prompt).toContain('vibelink_task_done (taskId task-agent)')
})

test('composeWorkspaceDigestPrompt summarizes brief, board, and terminals', () => {
  const prompt = composeWorkspaceDigestPrompt({
    workspaceName: 'Repo',
    brief: { purpose: 'Ship safely', notes: 'Review migrations', updatedAt: 'now' },
    tasks: [
      taskFixture('task-pending', session.id, 'Write docs'),
      taskFixture('task-active', session.id, 'Implement feature', { status: 'in-progress' }),
    ],
    terminalOutputs: [{ title: 'Build', output: 'error: compile failed' }],
  })
  expect(prompt).toContain('Purpose: Ship safely')
  expect(prompt).toContain('Pending (1): Write docs')
  expect(prompt).toContain('In Progress (1): Implement feature')
  expect(prompt).toContain('### Build\n<terminal_output>\nerror: compile failed')
  expect(prompt).toContain('three highest-priority next actions')
})




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
      activePaneId: undefined,
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
      paneCompletionHighlights: {},
      selectedTaskId: {},
      workspaceTodos: {},
      workspaceTodoNotes: {},
    })
  })

  test('createTask adds a pending ordered task', async () => { const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Fix bug', description: 'Details' })

  expect(task.status).toBe('pending')
  expect(tasksForSession(useWorkspaceStore.getState().kanban, session.id).map((item) => item.id)).toEqual(['task-1'])
  expect(useWorkspaceStore.getState().selectedTaskId[session.id]).toBe('task-1') })

  test('assignTask stores pane, role, and assigned status', async () => {
    const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Fix bug', description: 'Line one\nLine two' })

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
    expect((writes[0]?.[1] as { data: string }).data).not.toContain('\n')
    expect((writes[0]?.[1] as { data: string }).data).toContain('Line one Line two')
    expect((writes[0]?.[1] as { data: string }).data).toContain('--result-summary "<short result summary>"')
    expect(writes[1]?.[1]).toMatchObject({ sessionId: session.id, paneId: pane.id, data: '\r' })


    await useWorkspaceStore.getState().markTaskDone(task.id)
    expect(useWorkspaceStore.getState().kanban.tasks[task.id].statusTimestamps.done).toEqual(expect.any(Number))
  })

  test('assignTask queues work for VibeLink Agent', async () => {
    const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Agent task', description: 'Use MCP callbacks' })

    await useWorkspaceStore.getState().assignTask(task.id, 'vibelink-agent')

    expect(useWorkspaceStore.getState().kanban.tasks[task.id]).toMatchObject({
      assignedRole: 'VibeLink Agent',
      status: 'in-progress',
    })
    expect(useWorkspaceStore.getState().hermesPendingPrompts[session.id]?.[0]?.text).toContain('vibelink_task_note tool')
    expect(useWorkspaceStore.getState().hermesTranscript[session.id]?.[0]).toMatchObject({ role: 'user' })
    expect(invoke).toHaveBeenCalledWith('hermes_start', expect.objectContaining({ sessionId: session.id, workspaceFolder: session.workspaceFolder }))
  })

  test('assignTask rejects non-agent terminal panes', async () => {
    const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Fix bug', description: '' })
    useWorkspaceStore.setState({
      panes: {
        shell: {
          id: 'shell',
          alive: true,
          config: { ...pane.config, paneId: 'shell', title: 'PowerShell', icon: 'terminal-square', profileId: 'powershell' },
        },
      },
    })

    await useWorkspaceStore.getState().assignTask(task.id, 'shell')

    expect(useWorkspaceStore.getState().kanban.tasks[task.id].status).toBe('pending')
    expect(useWorkspaceStore.getState().error).toContain('AI agent terminal profiles')
  })

  test('moveTask transitions columns', async () => { const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Fix bug', description: '' })

  await useWorkspaceStore.getState().moveTask(task.id, 'in-progress')

  expect(tasksByStatus(useWorkspaceStore.getState().kanban, session.id)['in-progress'].map((item) => item.id)).toEqual([task.id]) })

  test('noteTask moves active tasks to in-progress and appends notes', async () => { const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Note me', description: '' })
  await useWorkspaceStore.getState().updateTask(task.id, { status: 'assigned' })

  await useWorkspaceStore.getState().noteTask(task.id, 'started work')

  expect(useWorkspaceStore.getState().kanban.tasks[task.id]).toMatchObject({
    status: 'in-progress',
    resultSummary: 'started work',
  })
  expect(useWorkspaceStore.getState().kanban.tasks[task.id].statusTimestamps['in-progress']).toEqual(expect.any(Number)) })

  test('noteTask keeps done tasks done while appending notes', async () => { const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Done note', description: '' })
  await useWorkspaceStore.getState().markTaskDone(task.id)

  await useWorkspaceStore.getState().noteTask(task.id, 'post-completion detail')

  expect(useWorkspaceStore.getState().kanban.tasks[task.id]).toMatchObject({
    status: 'done',
    resultSummary: 'post-completion detail',
  }) })

  test('markTaskDone only updates the matching task and is idempotent', async () => { const first = await useWorkspaceStore.getState().createTask(session.id, { title: 'One', description: '' })
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'task-2') })
  const second = await useWorkspaceStore.getState().createTask(session.id, { title: 'Two', description: '' })

  await useWorkspaceStore.getState().markTaskDone(first.id, { commitMessage: 'done', resultSummary: 'completed result' })
  await useWorkspaceStore.getState().markTaskDone(first.id, { commitMessage: 'done' })

  expect(useWorkspaceStore.getState().kanban.tasks[first.id]).toMatchObject({ status: 'done', commitMessage: 'done', resultSummary: 'completed result' })
  expect(useWorkspaceStore.getState().kanban.tasks[second.id].status).toBe('pending') })

  test('deleteTask removes task order and clears selection', async () => { const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Remove me', description: '' })

  await useWorkspaceStore.getState().deleteTask(task.id)

  expect(useWorkspaceStore.getState().kanban.tasks[task.id]).toBeUndefined()
  expect(useWorkspaceStore.getState().kanban.taskOrder[session.id]).toEqual([])
  expect(useWorkspaceStore.getState().selectedTaskId[session.id]).toBeNull() })

  test('workspace todo actions trim additions and delete only selected todo ids for one session', async () => { const ids = ['todo-1', 'todo-2', 'todo-other']
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => ids.shift() ?? 'unexpected-id') })

  const first = useWorkspaceStore.getState().addWorkspaceTodo(session.id, '  Draft API contract  ')
  const blank = useWorkspaceStore.getState().addWorkspaceTodo(session.id, '   ')
  const second = useWorkspaceStore.getState().addWorkspaceTodo(session.id, 'Write regression tests')
  const other = useWorkspaceStore.getState().addWorkspaceTodo(nextSession.id, 'Other workspace item')

  expect(blank).toBeNull()
  expect(useWorkspaceStore.getState().workspaceTodos[session.id].map((todo) => ({ id: todo.id, text: todo.text }))).toEqual([
    { id: first?.id, text: 'Draft API contract' },
    { id: second?.id, text: 'Write regression tests' },
  ])

  useWorkspaceStore.getState().deleteWorkspaceTodos(session.id, [first?.id ?? '', 'missing-todo'])

  expect(useWorkspaceStore.getState().workspaceTodos[session.id].map((todo) => todo.id)).toEqual([second?.id])
  expect(useWorkspaceStore.getState().workspaceTodos[nextSession.id].map((todo) => todo.id)).toEqual([other?.id]) })

  test('setWorkspaceTodoNote stores memo text and removes blank notes without touching other workspaces', async () => { useWorkspaceStore.getState().setWorkspaceTodoNote(session.id, ' Implementation memo ')
  useWorkspaceStore.getState().setWorkspaceTodoNote(nextSession.id, 'Other memo')

  expect(useWorkspaceStore.getState().workspaceTodoNotes[session.id]).toBe(' Implementation memo ')

  useWorkspaceStore.getState().setWorkspaceTodoNote(session.id, '   ')

  expect(useWorkspaceStore.getState().workspaceTodoNotes[session.id]).toBeUndefined()
  expect(useWorkspaceStore.getState().workspaceTodoNotes[nextSession.id]).toBe('Other memo') })

  test('workspace todo actions tolerate live stores created before todo fields existed', async () => { vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'todo-live') })
  useWorkspaceStore.setState({ workspaceTodos: undefined as never, workspaceTodoNotes: undefined as never })

  const todo = useWorkspaceStore.getState().addWorkspaceTodo(session.id, 'Recovered todo')
  useWorkspaceStore.getState().setWorkspaceTodoNote(session.id, 'Recovered memo')

  expect(todo?.id).toBe('todo-live')
  expect(useWorkspaceStore.getState().workspaceTodos[session.id]).toHaveLength(1)
  expect(useWorkspaceStore.getState().workspaceTodoNotes[session.id]).toBe('Recovered memo') })

  test('injectWorkspaceTodosToKanban creates pending tasks from uninjected todos and does not duplicate them', async () => { const ids = ['todo-1', 'todo-2', 'task-1', 'task-2']
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => ids.shift() ?? 'unexpected-id') })
  const first = useWorkspaceStore.getState().addWorkspaceTodo(session.id, 'Draft task')
  const second = useWorkspaceStore.getState().addWorkspaceTodo(session.id, 'Verify task')
  useWorkspaceStore.getState().setWorkspaceTodoNote(session.id, ' Shared implementation memo ')

  const created = await useWorkspaceStore.getState().injectWorkspaceTodosToKanban(session.id, [first?.id ?? '', second?.id ?? ''])

  expect(created.map((task) => ({ id: task.id, title: task.title, description: task.description, status: task.status }))).toEqual([
    { id: 'task-1', title: 'Draft task', description: 'Shared implementation memo', status: 'pending' },
    { id: 'task-2', title: 'Verify task', description: 'Shared implementation memo', status: 'pending' },
  ])
  expect(useWorkspaceStore.getState().kanban.taskOrder[session.id]).toEqual(['task-1', 'task-2'])
  expect(useWorkspaceStore.getState().selectedTaskId[session.id]).toBe('task-2')
  expect(useWorkspaceStore.getState().workspaceTodos[session.id].map((todo) => ({ id: todo.id, kanbanTaskId: todo.kanbanTaskId }))).toEqual([
    { id: first?.id, kanbanTaskId: 'task-1' },
    { id: second?.id, kanbanTaskId: 'task-2' },
  ])

  const duplicateAttempt = await useWorkspaceStore.getState().injectWorkspaceTodosToKanban(session.id, [first?.id ?? '', second?.id ?? ''])

  expect(duplicateAttempt).toEqual([])
  expect(useWorkspaceStore.getState().kanban.taskOrder[session.id]).toEqual(['task-1', 'task-2']) })

  test('persists view state as v2 without tasks', async () => {
    const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Persist', description: '' })
    persistKanban({
      data: useWorkspaceStore.getState().kanban,
      viewModes: { [session.id]: 'kanban' },
      kanbanLayouts: { [session.id]: '{"grid":true}' },
      orchestratorPaneIds: { [session.id]: pane.id },
      workspaceTodos: {
        [session.id]: [{ id: 'todo-1', text: 'Plan persistence', kanbanTaskId: task.id, createdAt: 11, updatedAt: 12 }],
      },
      workspaceTodoNotes: { [session.id]: 'Persisted memo' },
    })

    const raw = JSON.parse(storage.get('vibelink:kanban') ?? '{}')
    const loaded = loadKanban()

    expect(raw.version).toBe(2)
    expect(raw.data).toBeUndefined()
    expect(raw.tasks).toBeUndefined()
    expect(loaded.data).toEqual({ tasks: {}, taskOrder: {} })
    expect(loaded.viewModes[session.id]).toBe('kanban')
    expect(loaded.kanbanLayouts[session.id]).toBe('{"grid":true}')
    expect(loaded.orchestratorPaneIds[session.id]).toBe(pane.id)
    expect(loaded.workspaceTodos[session.id]).toEqual([
      { id: 'todo-1', text: 'Plan persistence', kanbanTaskId: task.id, createdAt: 11, updatedAt: 12 },
    ])
    expect(loaded.workspaceTodoNotes[session.id]).toBe('Persisted memo')
  })

  test('old persisted kanban layouts are discarded after layout schema bump', async () => { storage.set('vibelink:kanban', JSON.stringify({
    version: 1,
    data: { tasks: {}, taskOrder: {} },
    viewModes: { [session.id]: 'kanban' },
    kanbanLayouts: { [session.id]: '{"bad":true}' },
    orchestratorPaneIds: {},
  }))

  const loaded = loadKanban()

  expect(loaded.viewModes[session.id]).toBe('kanban')
  expect(loaded.kanbanLayouts[session.id]).toBeUndefined() })

  test('uses native task commands without board mirror writes', async () => {
    const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Native owner', description: '' })
    await useWorkspaceStore.getState().moveTask(task.id, 'in-progress')

    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command)
    expect(commands).toContain('board_task_create')
    expect(commands).toContain('board_task_update')
    expect(commands).not.toContain('board_write')
  })

  test('applyBoardSnapshot updates only the in-memory cache', async () => {
    const localTask = taskFixture('local-task', session.id, 'Local draft')
    const otherTask = taskFixture('other-task', nextSession.id, 'Other board')
    const diskTask = taskFixture('disk-task', session.id, 'Loaded from disk', { status: 'done', createdAt: 10, updatedAt: 11 })
    useWorkspaceStore.setState({
      sessions: [session, nextSession],
      kanban: {
        tasks: { [localTask.id]: localTask, [otherTask.id]: otherTask },
        taskOrder: { [session.id]: [localTask.id], [nextSession.id]: [otherTask.id] },
      },
    })
    const snapshot = JSON.stringify({ tasks: { [diskTask.id]: diskTask }, taskOrder: [diskTask.id] })
    vi.mocked(invoke).mockClear()

    useWorkspaceStore.getState().applyBoardSnapshot(session.id, snapshot)

    expect(useWorkspaceStore.getState().kanban.tasks[localTask.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().kanban.tasks[diskTask.id]).toMatchObject({ title: 'Loaded from disk', sessionId: session.id })
    expect(useWorkspaceStore.getState().kanban.tasks[otherTask.id]).toBe(otherTask)
    expect(loadKanban().data).toEqual({ tasks: {}, taskOrder: {} })
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'board_write')).toHaveLength(0)
  })

  test('deleteSession prunes kanban state for that session', async () => {
    const task = await useWorkspaceStore.getState().createTask(session.id, { title: 'Delete me', description: '' })
    useWorkspaceStore.getState().setViewMode(session.id, 'kanban')
    useWorkspaceStore.getState().setKanbanLayout(session.id, '{"grid":true}')
    useWorkspaceStore.getState().setOrchestratorPane(session.id, pane.id)
    useWorkspaceStore.getState().addWorkspaceTodo(session.id, 'Session todo')
    useWorkspaceStore.getState().setWorkspaceTodoNote(session.id, 'Session memo')

    await useWorkspaceStore.getState().deleteSession(session.id)

    expect(useWorkspaceStore.getState().kanban.tasks[task.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().kanban.taskOrder[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().viewModes[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().kanbanLayouts[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().orchestratorPaneIds[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().workspaceTodos[session.id]).toBeUndefined()
    expect(useWorkspaceStore.getState().workspaceTodoNotes[session.id]).toBeUndefined()
  })
})

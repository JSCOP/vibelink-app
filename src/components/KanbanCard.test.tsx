import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Task } from '../ipc/types'
import { defaultSettings, normalizeSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { KanbanCard } from './KanbanCard'

const localStorageStub = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}

describe('KanbanCard', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { localStorage: localStorageStub })
    useWorkspaceStore.setState({
      sessions: [],
      activeSessionId: 'session-1',
      panes: {},
      manualPaneTitles: {},
      layoutJson: null,
      status: 'ready',
      error: undefined,
      settings: normalizeSettings(defaultSettings),
      kanban: { tasks: {}, taskOrder: {} },
      selectedTaskId: {},
    })
  })

  test('keeps board cards compact and leaves details for the edit dialog', () => {
    const task: Task = {
      id: 'task-1',
      sessionId: 'session-1',
      title: 'abc',
      description: 'Long task description',
      status: 'done',
      statusTimestamps: { pending: 1, assigned: 2, 'in-progress': 3, done: 4 },
      assignedRole: 'test',
      resultSummary: 'Diff baseline unavailable: fatal: not a git repository',
      createdAt: 1,
      updatedAt: 4,
    }

    const html = renderToString(<KanbanCard task={task} onAssign={() => undefined} onEdit={() => undefined} />)

    expect(html).not.toContain('kanban-card-details')
    expect(html).not.toContain('Long task description')
    expect(html).not.toContain('Diff baseline unavailable')
    expect(html).toContain('title="View task diff"')
    expect(html).toContain('>Diff</span>')
    expect(html).toContain('title="Delete task"')
    expect(html).toContain('>Delete</span>')
    expect(html).toContain('title="Reopen task"')
    expect(html).not.toContain('title="Advance task to next status"')
    expect(html).not.toContain('title="Move task to previous status"')
  })
})

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

  test('keeps dense card fields behind clickable summaries and short action labels', () => {
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

    expect(html).toContain('kanban-card-details')
    expect(html).toContain('내용')
    expect(html).toContain('시간')
    expect(html).toContain('결과')
    expect(html).toContain('title="View task diff"')
    expect(html).toContain('>Diff</span>')
    expect(html).toContain('title="Advance task to next status"')
    expect(html).toContain('>Next</span>')
    expect(html).not.toContain('>View diff</button>')
    expect(html).not.toContain('>Advance')
  })
})

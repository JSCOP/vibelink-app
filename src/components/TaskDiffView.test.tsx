// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('react-diff-viewer-continued', () => ({ default: ({ oldValue, newValue }: { oldValue: string; newValue: string }) => <div data-testid="diff">{oldValue}|{newValue}</div> }))

import { useWorkspaceStore } from '../state/store'
import { TaskDiffView } from './TaskDiffView'

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (command: string) => command === 'git_changed_files'
    ? [{ path: 'file.txt', oldPath: null, changeType: 'modified', additions: 1, deletions: 0, binary: false }]
    : { old: 'old', new: 'new', binary: false })
  useWorkspaceStore.setState({
    activeSessionId: 'session-1',
    sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }],
    selectedTaskId: { 'session-1': 'task-1' },
    kanban: {
      tasks: {
        'task-1': {
          id: 'task-1',
          sessionId: 'session-1',
          title: 'Task title',
          description: '',
          status: 'done',
          statusTimestamps: { done: 1 },
          baselineRef: 'HEAD',
          createdAt: 1,
          updatedAt: 1,
        },
      },
      taskOrder: { 'session-1': ['task-1'] },
    },
  })
})

test('keeps task diff file and content loading behavior', async () => {
  render(<TaskDiffView />)
  expect(await screen.findByText('file.txt')).toBeTruthy()
  expect((await screen.findByTestId('diff')).textContent).toBe('old|new')
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_file_contents', {
    workspaceFolder: 'C:/repo',
    baseRef: 'HEAD',
    path: 'file.txt',
  }))
})

// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RepoInfo, WorkingStatus } from '../../ipc/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class MockChannel<T> {
    onmessage: ((event: T) => void) | null = null
    constructor(callback?: (event: T) => void) { this.onmessage = callback ?? null }
  },
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))
vi.mock('react-diff-viewer-continued', () => ({ default: () => <div data-testid="diff-viewer" /> }))

import { emptyGitSessionState, useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { GitWindow } from './GitWindow'

const withResolvers = <T,>() => (Promise as PromiseConstructor & {
  withResolvers: <Value>() => { promise: Promise<Value>; resolve: (value: Value | PromiseLike<Value>) => void; reject: (reason?: unknown) => void }
}).withResolvers<T>()
const repoInfo: RepoInfo = {
  isRepo: true,
  root: 'C:/repo',
  branch: 'main',
  detachedSha: null,
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  state: 'merging',
  remotes: [{ name: 'origin', url: 'https://github.com/JSCOP/vibelink-app.git' }],
}

const status: WorkingStatus = {
  staged: [],
  unstaged: [{ path: 'file.txt', oldPath: null, changeType: 'modified' }],
  untracked: [],
  conflicted: [{ path: 'conflict.txt', oldPath: null, changeType: 'modified' }],
  truncated: false,
}

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'git_working_file_contents') return { old: 'old', new: 'new', binary: false }
    return null
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  useGitStore.setState({ sessions: {} })
  useWorkspaceStore.setState({
    activeSessionId: 'session-1',
    sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }],
  })
})

describe('GitWindow Changes tab', () => {
  test('keeps repository actions and delegates file navigation to Explorer', async () => {
    render(<GitWindow />)
    expect(await screen.findByText('Repository is merging.')).toBeTruthy()
    expect(screen.getByText('Select a changed file in Explorer to view its diff.')).toBeTruthy()
    expect(screen.queryByTitle('file.txt')).toBeNull()
    expect(screen.getByText('Merge Conflicts')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Commit/ }) as HTMLButtonElement).disabled).toBe(true)
  })
})


test('clears diff loading when refresh removes the selected file', async () => {
  const deferred = withResolvers<unknown>()
  let currentStatus = status
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return currentStatus
    if (command === 'git_working_file_contents') return deferred.promise
    return null
  })

  render(<GitWindow />)
  expect(await screen.findByText('Loading diff…')).toBeTruthy()
  currentStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }
  fireEvent.click(screen.getByTitle('Refresh'))
  expect(await screen.findByText('Select a file to view its diff.')).toBeTruthy()
  expect(screen.queryByText('Loading diff…')).toBeNull()
  deferred.resolve({ old: 'old', new: 'new', binary: false })
})

test('reroots diffs selected from a nested repository in Explorer', async () => {
  useGitStore.setState({
    sessions: {
      'session-1': {
        ...emptyGitSessionState,
        repoInfo,
        status,
        selectedPath: 'vendor/tool/src/changed.ts',
        selectedRepoRoot: 'vendor/tool',
        selectedArea: 'unstaged',
      },
    },
  })

  render(<GitWindow />)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_working_file_contents', {
    workspaceFolder: 'C:/repo/vendor/tool',
    path: 'src/changed.ts',
    area: 'unstaged',
  }))
})


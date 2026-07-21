// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RepoInfo, WorkingStatus } from '../../ipc/types'

const { invoke, openContent } = vi.hoisted(() => ({ invoke: vi.fn(), openContent: vi.fn(async () => 'content:explorer:explorer') }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class MockChannel<T> {
    onmessage: ((event: T) => void) | null = null
    constructor(callback?: (event: T) => void) { this.onmessage = callback ?? null }
  },
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))
vi.mock('react-diff-viewer-continued', () => ({ default: () => <div data-testid="diff-viewer" /> }))

import { emptyGitRepositoryState, emptyGitSessionState, useGitStore } from '../../state/git'
import { useExplorerStore } from '../../state/explorer'
import { useWorkspaceStore } from '../../state/store'
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { WorkbenchContentPanel } from './GitWindow'

const workspaceContentActions: WorkspaceContentActions = {
  openContent,
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  renameTerminal: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

function renderWorkbench() {
  return render(<WorkspaceContentActionsContext.Provider value={workspaceContentActions}><WorkbenchContentPanel /></WorkspaceContentActionsContext.Provider>)
}

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
  openContent.mockClear()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'git_working_file_contents') return { old: 'old', new: 'new', binary: false }
    if (command === 'fs_list_dir') return [
      { name: 'conflict.txt', isDir: false, isSymlink: false, size: 8, modifiedAt: null },
      { name: 'file.txt', isDir: false, isSymlink: false, size: 8, modifiedAt: null },
    ]
    if (command === 'git_dir_entries') return []
    return null
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  useGitStore.setState({ sessions: {} })
  useExplorerStore.setState({ sessions: {} })
  useWorkspaceStore.setState({
    activeSessionId: 'session-1',
    sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }],
  })
})

describe('Workbench Changes tab', () => {
  test('lists changed files and reveals the selected path in Explorer', async () => {
    renderWorkbench()
    expect(await screen.findByText('Repository is merging.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Changes: file.txt' })).toBeTruthy()
    expect(screen.getByText('Merge Conflicts')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Commit/ }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByRole('button', { name: 'Changes: file.txt' }))
    await waitFor(() => expect(openContent).toHaveBeenCalledWith({ kind: 'explorer' }))
    await waitFor(() => expect(useExplorerStore.getState().sessions['session-1']?.selectedPath).toBe('file.txt'))
  })
})

test('fetches and compares the exact upstream tree with local HEAD', async () => {
  const remoteFile = { path: 'remote.txt', oldPath: undefined, changeType: 'modified' as const, additions: 1, deletions: 1, binary: false }
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return { ...repoInfo, state: 'clean', ahead: 0, behind: 1 }
    if (command === 'git_working_status') return { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }
    if (command === 'git_compare_refs') return [remoteFile]
    if (command === 'git_compare_refs_file') return { old: 'local\n', new: 'remote\n', binary: false }
    if (command === 'fs_list_dir') return [{ name: 'remote.txt', isDir: false, isSymlink: false, size: 7, modifiedAt: null }]
    if (command === 'git_dir_entries') return []
    return null
  })

  renderWorkbench()
  fireEvent.click(await screen.findByRole('button', { name: 'Fetch and compare remote origin/main' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_fetch', { workspaceFolder: 'C:/repo', remote: null, prune: false, refspec: null }))
  expect(await screen.findByRole('button', { name: 'Remote changes: remote.txt' })).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: 'Remote changes: remote.txt' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_compare_refs_file', {
    workspaceFolder: 'C:/repo',
    baseRef: 'HEAD',
    headRef: 'origin/main',
    path: 'remote.txt',
  }))
  expect(useExplorerStore.getState().sessions['session-1']?.selectedPath).toBe('remote.txt')
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

  renderWorkbench()
  expect(await screen.findByText('Loading diff…')).toBeTruthy()
  currentStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }
  fireEvent.click(screen.getByTitle('Refresh'))
  expect(await screen.findByText('Select a file to view its diff.')).toBeTruthy()
  expect(screen.queryByText('Loading diff…')).toBeNull()
  deferred.resolve({ old: 'old', new: 'new', binary: false })
})

test('reroots diffs selected from a nested repository in Explorer', async () => {
  const nestedStatus: WorkingStatus = {
    staged: [],
    unstaged: [{ path: 'src/changed.ts', oldPath: null, changeType: 'modified' }],
    untracked: [],
    conflicted: [],
    truncated: false,
  }
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return { ...repoInfo, root: 'C:/repo/vendor/tool', state: 'clean' }
    if (command === 'git_working_status') return nestedStatus
    if (command === 'git_working_file_contents') return { old: 'old', new: 'new', binary: false }
    return null
  })
  useGitStore.setState({
    sessions: {
      'session-1': {
        ...emptyGitSessionState,
        repositories: {
          'vendor/tool': { ...emptyGitRepositoryState, repoInfo: { ...repoInfo, root: 'C:/repo/vendor/tool', state: 'clean' }, status: nestedStatus },
        },
        activeRepoRoot: 'vendor/tool',
        selectedPath: 'vendor/tool/src/changed.ts',
        selectedRepoRoot: 'vendor/tool',
        selectedArea: 'unstaged',
      },
    },
  })

  renderWorkbench()
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_working_file_contents', {
    workspaceFolder: 'C:/repo/vendor/tool',
    path: 'src/changed.ts',
    area: 'unstaged',
  }))
})

test('shows the active nested repository breadcrumb and returns to the workspace repository', async () => {
  const nestedRepoInfo = { ...repoInfo, root: 'C:/repo/vendor/tool', branch: null, detachedSha: 'b'.repeat(40), state: 'clean' as const }
  const cleanStatus: WorkingStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'git_repo_info') return args?.workspaceFolder === 'C:/repo/vendor/tool' ? nestedRepoInfo : repoInfo
    if (command === 'git_working_status') return args?.workspaceFolder === 'C:/repo/vendor/tool' ? cleanStatus : status
    return null
  })
  useGitStore.setState({
    sessions: {
      'session-1': {
        ...emptyGitSessionState,
        repositories: {
          '': { ...emptyGitRepositoryState, repoInfo, status },
          'vendor/tool': { ...emptyGitRepositoryState, repoInfo: nestedRepoInfo, status: cleanStatus },
        },
        activeRepoRoot: 'vendor/tool',
      },
    },
  })

  renderWorkbench()
  expect(await screen.findByText('vendor/tool')).toBeTruthy()
  expect(screen.getByText('bbbbbbbb')).toBeTruthy()
  expect(screen.getByText('Git target')).toBeTruthy()
  expect(screen.getByText('Workspace repo')).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Commit · tool' })).toBeTruthy()
  expect(screen.getByRole('button', { name: 'Push nested repository vendor/tool' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Open workspace repository' }))
  await waitFor(() => expect(useGitStore.getState().sessions['session-1'].activeRepoRoot).toBe(''))
})

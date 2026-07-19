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

import { useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { GitWindow } from './GitWindow'

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
  test('renders grouped changes and repository state', async () => {
    render(<GitWindow />)
    expect(await screen.findByText('Merge Conflicts')).toBeTruthy()
    expect(screen.getAllByText('Changes').length).toBeGreaterThan(0)
    expect(screen.getByText('Repository is merging.')).toBeTruthy()
    expect((screen.getByRole('button', { name: /Commit/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('stages a file through the native command', async () => {
    render(<GitWindow />)
    const stage = await screen.findByTitle('Stage file.txt')
    fireEvent.click(stage)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_stage', {
      workspaceFolder: 'C:/repo',
      paths: ['file.txt'],
    }))
  })
  test('expands a nested repository and diffs a selected child file', async () => {
    const nestedStatus: WorkingStatus = {
      staged: [],
      unstaged: [],
      conflicted: [],
      untracked: [{ path: 'vendor/tool/', oldPath: null, changeType: 'untracked', repoKind: 'nestedRepo' }],
      truncated: false,
    }
    invoke.mockImplementation(async (command: string) => {
      if (command === 'git_repo_info') return repoInfo
      if (command === 'git_working_status') return nestedStatus
      if (command === 'git_dir_entries') return [{ name: 'README.md', isDir: false, repoKind: null, ignored: false }]
      if (command === 'git_working_file_contents') return { old: '', new: '# Nested repo', binary: false }
      return null
    })

    render(<GitWindow />)
    fireEvent.click(await screen.findByTitle('vendor/tool'))
    expect(await screen.findByText('README.md')).toBeTruthy()
    expect(screen.getByText('git repo')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /README\.md/ }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_working_file_contents', {
      workspaceFolder: 'C:/repo/vendor/tool',
      path: 'README.md',
      area: 'unstaged',
    }))
  })
})

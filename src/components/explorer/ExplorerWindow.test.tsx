// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RepoInfo, WorkingStatus } from '../../ipc/types'

const { invoke, openWindow } = vi.hoisted(() => ({ invoke: vi.fn(), openWindow: vi.fn(async () => {}) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../layout/windowActions', () => ({ useWorkspaceWindowActions: () => ({ openWindow }) }))

import { useExplorerStore } from '../../state/explorer'
import { useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { ExplorerWindow } from './ExplorerWindow'

const repoInfo: RepoInfo = {
  isRepo: true,
  root: 'C:/repo',
  branch: 'main',
  detachedSha: null,
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  state: 'clean',
  remotes: [],
}

const status: WorkingStatus = {
  staged: [],
  unstaged: [{ path: 'src/changed.ts', oldPath: null, changeType: 'modified' }],
  untracked: [],
  conflicted: [],
  truncated: false,
}

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'fs_list_dir') {
      return args?.relPath === 'src'
        ? [{ name: 'changed.ts', isDir: false, isSymlink: false, size: 7, modifiedAt: null }]
        : [{ name: 'src', isDir: true, isSymlink: false, size: 0, modifiedAt: null }]
    }
    if (command === 'git_check_ignored') return []
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'fs_read_text') return { content: 'changed', truncated: false, binary: false }
    return null
  })
  useExplorerStore.setState({ sessions: {} })
  useGitStore.setState({ sessions: {} })
  useWorkspaceStore.setState({
    activeSessionId: 'session-1',
    sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }],
  })
})

describe('ExplorerWindow Git integration', () => {
  test('uses the filesystem tree for Git navigation and folder actions', async () => {
    render(<ExplorerWindow sessionId="session-1" workspaceFolder="C:/repo" />)

    expect((await screen.findAllByLabelText(/1 changed path.*1 modified/)).length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByLabelText('Expand src'))
    const changed = await screen.findByText('changed.ts')
    expect(screen.getByTitle('Working tree: Modified')).toBeTruthy()

    fireEvent.click(changed)
    await waitFor(() => expect(useGitStore.getState().sessions['session-1']).toMatchObject({
      selectedPath: 'src/changed.ts',
      activeTab: 'changes',
    }))

    fireEvent.contextMenu(screen.getByText('src').closest('.explorer-tree-row') as HTMLElement, { clientX: 80, clientY: 90 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stage Folder Changes' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_stage', { workspaceFolder: 'C:/repo', paths: ['src'] }))
  })
})

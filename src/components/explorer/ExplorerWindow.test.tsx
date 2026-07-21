// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RepoInfo, WorkingStatus } from '../../ipc/types'

const { invoke, openWorkspaceContent } = vi.hoisted(() => ({ invoke: vi.fn(), openWorkspaceContent: vi.fn(async () => 'content:workbench:workbench') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { useExplorerStore } from '../../state/explorer'
import { useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { ExplorerWindow } from './ExplorerWindow'

function workspaceContentActions(openContent: WorkspaceContentActions['openContent'] = openWorkspaceContent): WorkspaceContentActions {
  return {
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
}

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
  window.localStorage.clear()
  invoke.mockReset()
  openWorkspaceContent.mockClear()
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
  test('keeps single-click as preview and opens files through content actions on double-click', async () => {
    const openContent = vi.fn(async () => 'content:editor:src/changed.ts')
    const actions = workspaceContentActions(openContent)
    render(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <ExplorerWindow sessionId="session-1" workspaceFolder="C:/repo" />
      </WorkspaceContentActionsContext.Provider>,
    )
    fireEvent.click(await screen.findByLabelText('Expand src'))
    const file = await screen.findByText('changed.ts')

    fireEvent.click(file)
    expect(openContent).not.toHaveBeenCalled()
    fireEvent.doubleClick(file)

    await waitFor(() => expect(openContent).toHaveBeenCalledWith({ kind: 'editor', relPath: 'src/changed.ts' }))
  })

  test('uses the filesystem tree for Git navigation and folder actions', async () => {
    render(<ExplorerWindow sessionId="session-1" workspaceFolder="C:/repo" />)

    expect((await screen.findAllByLabelText(/1 changed path.*1 modified/)).length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByLabelText('Expand src'))
    const changed = await screen.findByText('changed.ts')
    expect(screen.getByTitle('Modified — tracked file content changed; not staged for the next commit.')).toBeTruthy()

    fireEvent.click(changed)
    await waitFor(() => expect(useGitStore.getState().sessions['session-1']).toMatchObject({
      selectedPath: 'src/changed.ts',
      activeTab: 'changes',
    }))

    fireEvent.contextMenu(screen.getByText('src').closest('.explorer-tree-row') as HTMLElement, { clientX: 80, clientY: 90 })
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Stage Folder Changes' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_stage', { workspaceFolder: 'C:/repo', paths: ['src'] }))
  })

  test('persists the Explorer preview visibility toggle', async () => {
    render(<ExplorerWindow sessionId="session-1" workspaceFolder="C:/repo" />)
    fireEvent.click(await screen.findByRole('button', { name: 'Hide file preview' }))

    expect(document.querySelector('.explorer-window')?.getAttribute('data-preview-visible')).toBe('false')
    expect(document.querySelector('.explorer-viewer')).toBeNull()
    expect(window.localStorage.getItem('vibelink:explorerPreviewVisible')).toBe('false')

    cleanup()
    render(<ExplorerWindow sessionId="session-1" workspaceFolder="C:/repo" />)
    expect(await screen.findByRole('button', { name: 'Show file preview' })).toBeTruthy()
    expect(document.querySelector('.explorer-viewer')).toBeNull()
  })
})

test('discovers an uninitialized submodule and separates repository from pointer history actions', async () => {
  invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'fs_list_dir') {
      if (args?.relPath === 'modules') return [{ name: 'child', isDir: true, isSymlink: false, size: 0, modifiedAt: null }]
      if (args?.relPath === 'modules/child') return []
      return [{ name: 'modules', isDir: true, isSymlink: false, size: 0, modifiedAt: null }]
    }
    if (command === 'git_dir_entries') {
      if (args?.relPath === 'modules') return [{ name: 'child', isDir: true, repoKind: 'submodule', repositoryInitialized: false, ignored: false }]
      return [{ name: 'modules', isDir: true, repoKind: null, repositoryInitialized: null, ignored: false }]
    }
    if (command === 'git_check_ignored') return []
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }
    return null
  })

  render(<WorkspaceContentActionsContext.Provider value={workspaceContentActions()}><ExplorerWindow sessionId="session-1" workspaceFolder="C:/repo" /></WorkspaceContentActionsContext.Provider>)
  fireEvent.click(await screen.findByLabelText('Expand modules'))
  expect(await screen.findByText('Submodule')).toBeTruthy()
  expect(screen.getByText('Not initialized')).toBeTruthy()

  const childRow = screen.getByText('child').closest('.explorer-tree-row') as HTMLElement
  fireEvent.contextMenu(childRow, { clientX: 80, clientY: 90 })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Pointer History in Parent' }))
  await waitFor(() => expect(useGitStore.getState().sessions['session-1']).toMatchObject({ activeRepoRoot: '', activeTab: 'history', pathFilter: 'modules/child' }))
  expect(openWorkspaceContent).toHaveBeenCalledWith({ kind: 'workbench' })

  fireEvent.contextMenu(childRow, { clientX: 80, clientY: 90 })
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Initialize Submodule' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_submodule_update', { workspaceFolder: 'C:/repo', path: 'modules/child' }))
})

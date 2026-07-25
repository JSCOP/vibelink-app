// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BranchInfo, ChangedFile, RepoInfo, WorkingStatus } from '../../ipc/types'

const { invoke, openContent } = vi.hoisted(() => ({ invoke: vi.fn(), openContent: vi.fn(async () => 'content:workbench:workbench') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class MockChannel<T> { onmessage: ((event: T) => void) | null; constructor(callback?: (event: T) => void) { this.onmessage = callback ?? null } } }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))
vi.mock('react-diff-viewer-continued', () => ({ default: () => <div data-testid="branch-diff" /> }))

import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { useGitStore } from '../../state/git'
import { useExplorerStore } from '../../state/explorer'
import { useWorkspaceStore } from '../../state/store'
import { BranchesTab } from './BranchesTab'
import { GitBranchesSidebar } from './GitBranchesSidebar'
import { GitWorkspaceProvider } from './GitWorkspaceProvider'

const actions: WorkspaceContentActions = { openContent, activateContent: vi.fn(), requestCloseContent: vi.fn(async () => 'closed' as const), splitTerminal: vi.fn(async () => undefined), arrangeTerminals: vi.fn(async () => undefined), clearTerminals: vi.fn(async () => undefined), toggleMaximizeContent: vi.fn(), toggleZoomContent: vi.fn(), toggleTerminalWindowTitles: vi.fn(), renameTerminal: vi.fn(async () => undefined), resetLayout: vi.fn(async () => undefined), getContentParams: vi.fn(() => null) }
const branch: BranchInfo = { name: 'feature', isHead: false, isRemote: false, upstream: null, ahead: 0, behind: 0, lastCommitSubject: 'Feature', lastCommitDate: '2026-07-18T00:00:00Z' }
const repoInfo: RepoInfo = { isRepo: true, root: 'C:/repo', branch: 'main', detachedSha: null, upstream: 'origin/main', ahead: 0, behind: 0, state: 'clean', remotes: [] }
const status: WorkingStatus = { staged: [], unstaged: [{ path: 'src/local.ts', oldPath: null, changeType: 'modified' }], untracked: [], conflicted: [], truncated: false }
const remoteFile: ChangedFile = { path: 'src/remote.ts', changeType: 'modified', additions: 1, deletions: 1, binary: false }

function renderBranches() {
  return render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider pollIntervalMs={60_000}><GitBranchesSidebar active /><BranchesTab /></GitWorkspaceProvider></WorkspaceContentActionsContext.Provider>)
}

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  openContent.mockClear()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'git_branches') return [branch]
    if (command === 'git_stash_list') return [{ index: 0, message: 'WIP' }]
    if (command === 'git_tag_list') return [{ name: 'v1', sha: 'a'.repeat(40), message: null }]
    if (command === 'git_diff_refs') return [remoteFile]
    if (command === 'git_diff_refs_file') return { old: 'before', new: 'after', binary: false }
    if (command === 'fs_list_dir' || command === 'git_dir_entries') return []
    return null
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  useGitStore.setState({ sessions: {} })
  useExplorerStore.setState({ sessions: {} })
  useWorkspaceStore.setState({ activeSessionId: 'session-1', sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }], license: { ready: true, status: { state: 'development', entitled: true } as never } })
})

test('routes branch and stash mutations to the active repository', async () => {
  renderBranches()
  fireEvent.click(await screen.findByTitle('Merge feature'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_merge', { workspaceFolder: 'C:/repo', refName: 'feature' }))
  fireEvent.click(await screen.findByTitle('Apply stash 0'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_stash_apply', { workspaceFolder: 'C:/repo', index: 0 }))
  fireEvent.click(screen.getByTitle('Drop stash 0'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_stash_drop', { workspaceFolder: 'C:/repo', index: 0 }))
})

test('opens central ref comparison and reveals a selected compare file', async () => {
  renderBranches()
  fireEvent.click(await screen.findByRole('button', { name: 'Compare origin/main…main' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_diff_refs', { workspaceFolder: 'C:/repo', baseRef: 'origin/main', headRef: 'main' }))
  expect(openContent).toHaveBeenCalledWith({ kind: 'workbench' })
  fireEvent.click(await screen.findByText('src/remote.ts'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_diff_refs_file', { workspaceFolder: 'C:/repo', baseRef: 'origin/main', headRef: 'main', path: 'src/remote.ts' }))
  await waitFor(() => expect(useExplorerStore.getState().sessions['session-1']?.selectedPath).toBe('src/remote.ts'))
  expect(screen.getByRole('region', { name: 'Branches' })).toBeTruthy()
})

test('preserves branch create, rename, delete, copy, and new-from actions', async () => {
  vi.spyOn(window, 'prompt').mockReturnValueOnce('new-branch').mockReturnValueOnce('renamed').mockReturnValueOnce('from-feature')
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
  renderBranches()
  fireEvent.click(await screen.findByTitle('Create a new branch'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_branch_create', { workspaceFolder: 'C:/repo', name: 'new-branch', fromRef: null, checkout: false }))
  fireEvent.click(screen.getByTitle('Rename feature'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_branch_rename', { workspaceFolder: 'C:/repo', oldName: 'feature', newName: 'renamed' }))
  fireEvent.click(screen.getByTitle('Copy name feature'))
  expect(writeText).toHaveBeenCalledWith('feature')
  fireEvent.click(screen.getByTitle('New branch from feature'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_branch_create', { workspaceFolder: 'C:/repo', name: 'from-feature', fromRef: 'feature', checkout: false }))
  fireEvent.click(screen.getByTitle('Delete feature'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_branch_delete', { workspaceFolder: 'C:/repo', name: 'feature', force: false }))
})

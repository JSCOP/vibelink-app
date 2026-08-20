// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { CommitInfo, RepoInfo, WorkingStatus } from '../../ipc/types'

const { invoke, openContent } = vi.hoisted(() => ({ invoke: vi.fn(), openContent: vi.fn(async () => 'content:workbench:workbench') }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class MockChannel<T> { onmessage: ((event: T) => void) | null; constructor(callback?: (event: T) => void) { this.onmessage = callback ?? null } } }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))
vi.mock('@tanstack/react-virtual', () => ({ useVirtualizer: ({ count }: { count: number }) => ({ getVirtualItems: () => [], getTotalSize: () => count * 42 }) }))
vi.mock('react-diff-viewer-continued', () => ({ DiffMethod: { WORDS_WITH_SPACE: 'diffWordsWithSpace' }, default: () => <div data-testid="history-diff" /> }))

import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { useGitStore } from '../../state/git'
import { useExplorerStore } from '../../state/explorer'
import { useWorkspaceStore } from '../../state/store'
import { GitHistorySidebar } from './GitHistorySidebar'
import { GitWorkspaceProvider } from './GitWorkspaceProvider'
import { HistoryTab } from './HistoryTab'
import { AppDialogHost } from '../AppDialog'

const actions: WorkspaceContentActions = { openContent, activateContent: vi.fn(), requestCloseContent: vi.fn(async () => 'closed' as const), splitTerminal: vi.fn(async () => undefined), arrangeTerminals: vi.fn(async () => undefined), clearTerminals: vi.fn(async () => undefined), toggleMaximizeContent: vi.fn(), toggleZoomContent: vi.fn(), toggleTerminalWindowTitles: vi.fn(), renameContent: vi.fn(async () => undefined), resetLayout: vi.fn(async () => undefined), getContentParams: vi.fn(() => null) }
const repoInfo: RepoInfo = { isRepo: true, root: 'C:/repo', branch: 'main', detachedSha: null, headSha: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, state: 'clean', remotes: [] }
const status: WorkingStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }
const commit: CommitInfo = { sha: 'a'.repeat(40), parents: [], refs: ['HEAD -> main'], authorName: 'VibeLink', authorEmail: 'test@example.com', authorDate: '2026-07-18T00:00:00Z', subject: 'Initial commit' }
const changedFile = { path: 'src/committed.ts', changeType: 'modified' as const, additions: 2, deletions: 1, binary: false }

function renderHistory(pollIntervalMs = 60_000) {
  return render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider pollIntervalMs={pollIntervalMs}><GitHistorySidebar active /><HistoryTab /></GitWorkspaceProvider><AppDialogHost /></WorkspaceContentActionsContext.Provider>)
}

/** Fill the in-app prompt (`AppDialogHost`) and submit it. Queries are scoped
 *  to the modal so history rows cannot shadow its controls. */
async function answerPrompt(label: string, value: string, submitLabel: string) {
  const modal = within(await screen.findByRole('dialog'))
  fireEvent.change(modal.getByLabelText(label), { target: { value } })
  fireEvent.click(modal.getByRole('button', { name: submitLabel }))
}

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  openContent.mockClear()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'git_log') return { commits: [commit], hasMore: true }
    if (command === 'git_commit_detail') return { sha: commit.sha, parents: [], authorName: commit.authorName, authorEmail: commit.authorEmail, authorDate: commit.authorDate, committerName: commit.authorName, committerDate: commit.authorDate, body: 'Body', files: [changedFile] }
    if (command === 'git_commit_file_contents') return { old: 'before', new: 'after', binary: false }
    if (command === 'git_diff_refs') return [changedFile]
    if (command === 'fs_list_dir' || command === 'git_dir_entries') return []
    return null
  })
  useGitStore.setState({ sessions: {} })
  useExplorerStore.setState({ sessions: {} })
  useWorkspaceStore.setState({ activeSessionId: 'session-1', sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }] })
})

test('loads history lazily on sidebar activation and paginates with the current skip', async () => {
  let page = 0
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'git_log') return page++ === 0 ? { commits: [commit], hasMore: true } : { commits: [], hasMore: false }
    return null
  })
  renderHistory()
  expect(await screen.findByText('Initial commit')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  // Not toHaveBeenLastCalledWith: the panel also polls git_repo_info/git_working_status, and on a
  // loaded machine a poll can land after the pagination request. No other call carries these
  // arguments, so asserting the call happened is the same check without the ordering race.
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_log', { workspaceFolder: 'C:/repo', options: { refName: null, path: null, skip: 1, limit: 200, search: null, author: null } }))
})

test('refreshes active history when polling observes a new HEAD commit', async () => {
  const nextCommit: CommitInfo = { ...commit, sha: 'b'.repeat(40), subject: 'External commit' }
  let currentRepoInfo = { ...repoInfo, headSha: commit.sha }
  let currentCommits = [commit]
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return currentRepoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'git_log') return { commits: currentCommits, hasMore: false }
    return null
  })

  renderHistory(20)
  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'git_log')).toHaveLength(1))

  currentRepoInfo = { ...currentRepoInfo, headSha: nextCommit.sha }
  currentCommits = [nextCommit, commit]

  await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'git_log')).toHaveLength(2))
  expect(screen.getByText('External commit')).toBeTruthy()
})

test('shares commit selection and detail with central Workbench and loads detail only once', async () => {
  renderHistory()
  fireEvent.click(await screen.findByText('Initial commit'))
  await waitFor(() => expect(openContent).toHaveBeenCalledWith({ kind: 'workbench' }))
  expect(await screen.findByText('Body')).toBeTruthy()
  expect(invoke.mock.calls.filter(([command]) => command === 'git_commit_detail')).toHaveLength(1)
  fireEvent.click(screen.getByText('Initial commit'))
  expect(invoke.mock.calls.filter(([command]) => command === 'git_commit_detail')).toHaveLength(1)
  fireEvent.click(await screen.findByRole('button', { name: 'Modified: src/committed.ts' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_commit_file_contents', { workspaceFolder: 'C:/repo', sha: commit.sha, path: 'src/committed.ts' }))
  await waitFor(() => expect(useExplorerStore.getState().sessions['session-1']?.selectedPath).toBe('src/committed.ts'))
})

test('keeps compare, branch, and tag actions on the active repository', async () => {
  renderHistory()
  fireEvent.click(await screen.findByText('Initial commit'))
  fireEvent.click(await screen.findByRole('button', { name: 'Compare with HEAD' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_diff_refs', { workspaceFolder: 'C:/repo', baseRef: commit.sha, headRef: 'HEAD' }))
  fireEvent.click(screen.getByRole('button', { name: 'Create branch here' }))
  await answerPrompt('Branch name', 'from-history', 'Create')
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_branch_create', { workspaceFolder: 'C:/repo', name: 'from-history', fromRef: commit.sha, checkout: false }))
  fireEvent.click(screen.getByRole('button', { name: 'Create tag here' }))
  await answerPrompt('Tag name', 'v1', 'Next')
  await answerPrompt('Annotation message', 'release', 'Create')
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_tag_create', { workspaceFolder: 'C:/repo', name: 'v1', refName: commit.sha, message: 'release' }))
})

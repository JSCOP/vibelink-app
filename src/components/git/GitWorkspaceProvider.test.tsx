// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RepoInfo, WorkingStatus } from '../../ipc/types'
import type { WorktreeReviewComment } from '../../ipc/worktrees'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, Channel: class MockChannel<T> { onmessage: ((event: T) => void) | null; constructor(callback?: (event: T) => void) { this.onmessage = callback ?? null } } }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))

import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { GitWorkspaceProvider, useGitWorkspace } from './GitWorkspaceProvider'
import { sourceControlPrimaryAction } from './gitWorkspaceModel'

const actions: WorkspaceContentActions = {
  openContent: vi.fn(async () => 'content:workbench:workbench'), activateContent: vi.fn(), requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined), arrangeTerminals: vi.fn(async () => undefined), clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(), toggleZoomContent: vi.fn(), toggleTerminalWindowTitles: vi.fn(), renameTerminal: vi.fn(async () => undefined), resetLayout: vi.fn(async () => undefined), getContentParams: vi.fn(() => null),
}
const repoInfo: RepoInfo = { isRepo: true, root: 'C:/repo', branch: 'main', detachedSha: null, headSha: 'a'.repeat(40), upstream: 'origin/main', ahead: 0, behind: 0, state: 'clean', remotes: [] }
const status: WorkingStatus = { staged: [], unstaged: [{ path: 'file.ts', oldPath: null, changeType: 'modified' }], untracked: [], conflicted: [], truncated: false }

function Probe() {
  useGitWorkspace()
  return null
}
function HunkProbe() {
  const git = useGitWorkspace()
  return <button type="button" disabled={!git.selectedHunkId} onClick={() => git.applyHunk('stage')}>{git.selectedHunkId ?? 'waiting'}</button>
}
function ReviewSendProbe() {
  const git = useGitWorkspace()
  return <button type="button" disabled={git.reviewComments.length === 0} onClick={() => { void git.sendReviewCommentsToAgent(['comment-1']) }}>Send review</button>
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}


beforeEach(() => {
  vi.restoreAllMocks()
  cleanup()
  vi.useRealTimers()
  invoke.mockReset()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'git_working_file_contents') return { old: 'before', new: 'after', binary: false }
    return null
  })
  useGitStore.setState({ sessions: {} })
  useWorkspaceStore.setState({ activeSessionId: 'session-1', sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }], worktreeProjections: [], license: { ready: true, status: { state: 'development', entitled: true } as never } })
})

test('mounts one interval and one focus listener regardless of consumer count', async () => {
  const interval = vi.spyOn(window, 'setInterval')
  const addListener = vi.spyOn(window, 'addEventListener')
  render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider><Probe /><Probe /><Probe /></GitWorkspaceProvider></WorkspaceContentActionsContext.Provider>)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_working_status', { workspaceFolder: 'C:/repo' }))
  expect(interval.mock.calls.filter(([, delay]) => delay === 30_000)).toHaveLength(1)
  expect(addListener.mock.calls.filter(([name]) => name === 'focus')).toHaveLength(1)
})

test('polling refresh does not restart the selected-file contents request', async () => {
  vi.useFakeTimers()
  const { promise: pendingContents, resolve: resolveContents } = deferred<unknown>()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'git_working_file_contents') return pendingContents
    return null
  })
  render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider pollIntervalMs={3_000}><Probe /></GitWorkspaceProvider></WorkspaceContentActionsContext.Provider>)
  await vi.advanceTimersByTimeAsync(1)
  expect(invoke.mock.calls.filter(([command]) => command === 'git_working_file_contents')).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(3_000)
  expect(invoke.mock.calls.filter(([command]) => command === 'git_working_file_contents')).toHaveLength(1)
  resolveContents({ old: 'before', new: 'after', binary: false })
  await vi.advanceTimersByTimeAsync(0)
})

test('does not schedule or invoke Git while entitlement is locked', () => {
  useWorkspaceStore.setState({ license: { ready: true, status: { state: 'trialExpired', entitled: false } as never } })
  const interval = vi.spyOn(window, 'setInterval')
  render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider><Probe /></GitWorkspaceProvider></WorkspaceContentActionsContext.Provider>)
  expect(interval.mock.calls.filter(([, delay]) => delay === 3_000)).toHaveLength(0)
  expect(invoke).not.toHaveBeenCalled()
})

test('falls back to the imported head when a legacy worktree base ref is empty', async () => {
  useWorkspaceStore.setState({
    worktreeProjections: [{
      id: 'worktree-1',
      instanceId: 'instance-1',
      state: 'managed',
      record: {
        id: 'worktree-1', instanceId: 'instance-1', repositoryId: 'repository-1', repositoryPath: 'C:/repo', worktreePath: 'C:/repo',
        branch: 'feature/imported', head: 'b'.repeat(40), baseRef: '', sessionId: 'session-1', parentSessionId: null, parentWorktreeId: null,
        parentInstanceId: null, origin: 'external_import', lifecycle: 'active', locked: false, lockReason: null, prunable: false,
        prunableReason: null, dirty: false, untracked: false, hasConflicts: false, ahead: 0, behind: 0, exists: true,
        setupPolicy: 'inherit', sparsePreset: null, linkedFiles: [], initialAgent: null, initialPrompt: null, comment: null, reviewTarget: null,
        createdAt: 1, updatedAt: 1, lastActivityAt: 1,
      },
      native: null,
      parentWorktreeId: null,
      childWorktreeIds: [],
    }],
  })
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'worktree_checkpoints_list' || command === 'worktree_review_comments_list') return []
    if (command === 'git_log') return { commits: [{ sha: 'b'.repeat(40) }], hasMore: false }
    if (command === 'git_working_file_contents') return { old: 'before', new: 'after', binary: false }
    return null
  })

  render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider><Probe /></GitWorkspaceProvider></WorkspaceContentActionsContext.Provider>)

  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_log', {
    workspaceFolder: 'C:/repo',
    options: { refName: 'b'.repeat(40), path: null, skip: 0, limit: 1, search: null, author: null },
  }))
})

test('sends current review comments to the live agent pane and marks them sent', async () => {
  const comment: WorktreeReviewComment = {
    id: 'comment-1', worktreeId: 'worktree-1', instanceId: 'instance-1', baseHead: 'b'.repeat(40), head: 'a'.repeat(40), path: 'file.ts', side: 'new', line: 1, range: null, hunkId: 'hunk-1', body: 'Keep this guard.', createdAt: 1, updatedAt: 1, state: 'open',
  }
  useWorkspaceStore.setState({
    panes: { 'agent-pane': { id: 'agent-pane', alive: true, config: { title: 'Claude' } } as never },
    worktreeProjections: [{
      id: 'worktree-1', instanceId: 'instance-1', state: 'managed',
      record: { id: 'worktree-1', instanceId: 'instance-1', repositoryId: 'repository-1', repositoryPath: 'C:/repo', worktreePath: 'C:/repo', branch: 'feature/review', head: 'b'.repeat(40), baseRef: 'main', sessionId: 'session-1', parentSessionId: null, parentWorktreeId: null, parentInstanceId: null, origin: 'external_import', lifecycle: 'active', locked: false, lockReason: null, prunable: false, prunableReason: null, dirty: false, untracked: false, hasConflicts: false, ahead: 0, behind: 0, exists: true, setupPolicy: 'inherit', sparsePreset: null, linkedFiles: [], initialAgent: null, initialPrompt: null, comment: null, reviewTarget: null, createdAt: 1, updatedAt: 1, lastActivityAt: 1 },
      native: null, parentWorktreeId: null, childWorktreeIds: [],
    }],
  })
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'worktree_checkpoints_list') return []
    if (command === 'worktree_review_comments_list') return [comment]
    if (command === 'git_log') return { commits: [{ sha: 'b'.repeat(40) }], hasMore: false }
    if (command === 'git_diff_hunks') return { path: 'file.ts', area: 'unstaged', binary: false, hunks: [{ id: 'hunk-1', header: '@@', oldStart: 1, oldCount: 0, newStart: 1, newCount: 1, lines: [{ kind: 'addition', text: 'line', oldLine: null, newLine: 1 }] }] }
    if (command === 'worktree_review_comment_set_state') return [{ ...comment, state: 'sent' }]
    return null
  })

  render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider><ReviewSendProbe /></GitWorkspaceProvider></WorkspaceContentActionsContext.Provider>)
  const button = await screen.findByRole('button', { name: 'Send review' })
  await waitFor(() => expect(button).toHaveProperty('disabled', false))
  fireEvent.click(button)

  await waitFor(() => expect(invoke).toHaveBeenCalledWith('worktree_review_comment_set_state', { request: { worktreeId: 'worktree-1', expectedInstanceId: 'instance-1', commentIds: ['comment-1'], state: 'sent' } }))
  const writes = invoke.mock.calls.filter(([command]) => command === 'write_pane')
  expect(writes).toHaveLength(2)
  expect(writes[0][1]).toMatchObject({ sessionId: 'session-1', paneId: 'agent-pane' })
  expect(writes[0][1].data).toContain('1. file.ts (new line 1, hunk hunk-1)')
  expect(writes[1][1]).toEqual({ sessionId: 'session-1', paneId: 'agent-pane', data: '\r' })
})

test('computes bottom primary action precedence without implicit sync or force', () => {
  expect(sourceControlPrimaryAction({ ...repoInfo, state: 'merging' }, { ...status, conflicted: [{ path: 'conflict.ts', oldPath: null, changeType: 'modified' }] }, '', false).id).toBe('review-conflicts')
  expect(sourceControlPrimaryAction(repoInfo, status, '', false).id).toBe('stage-all')
  expect(sourceControlPrimaryAction(repoInfo, { ...status, unstaged: [], staged: [{ path: 'file.ts', oldPath: null, changeType: 'modified' }] }, '', false).id).toBe('enter-message')
  expect(sourceControlPrimaryAction(repoInfo, { ...status, unstaged: [], staged: [{ path: 'file.ts', oldPath: null, changeType: 'modified' }] }, 'commit', false).id).toBe('commit')
  expect(sourceControlPrimaryAction({ ...repoInfo, ahead: 2, behind: 1 }, { ...status, unstaged: [] }, '', false).id).toBe('pull')
  expect(sourceControlPrimaryAction({ ...repoInfo, ahead: 2 }, { ...status, unstaged: [] }, '', false).id).toBe('push')
})

test('sends only native hunk identity and action, never a frontend patch body', async () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'git_working_file_contents') return { old: 'before', new: 'after', binary: false }
    if (command === 'git_diff_hunks') return { path: 'file.ts', area: 'unstaged', binary: false, hunks: [{ id: 'native-hunk-id', header: '@@ -1 +1 @@', oldStart: 1, oldCount: 1, newStart: 1, newCount: 1, lines: [] }] }
    return null
  })
  render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider><HunkProbe /></GitWorkspaceProvider></WorkspaceContentActionsContext.Provider>)
  await waitFor(() => expect((screen.getByRole('button', { name: 'native-hunk-id' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'native-hunk-id' }))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_apply_hunk', { workspaceFolder: 'C:/repo', path: 'file.ts', area: 'unstaged', hunkId: 'native-hunk-id', action: 'stage' }))
  const request = invoke.mock.calls.find(([command]) => command === 'git_apply_hunk')?.[1]
  expect(request).not.toHaveProperty('patch')
})

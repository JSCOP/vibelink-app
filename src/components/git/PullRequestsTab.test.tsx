// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostingInfo, RepoInfo } from '../../ipc/types'

const { invoke, choiceDialog, promptDialog } = vi.hoisted(() => ({ invoke: vi.fn(), choiceDialog: vi.fn(), promptDialog: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../appDialogStore', () => ({ choiceDialog, promptDialog }))
vi.mock('./PullRequestsTabView', () => ({
  PullRequestsTabView: ({ onSelectFile, onSelectPr, onMergeAndCleanup, detail, error }: { onSelectFile: (path: string) => void; onSelectPr: (number: number) => void; onMergeAndCleanup: () => void; detail: unknown; error: string | null }) => (
    <><button type="button" onClick={() => onSelectFile('src/pull-request.ts')}>Pull request file</button><button type="button" onClick={() => onSelectPr(42)}>Select pull request</button>{detail ? <button type="button" onClick={onMergeAndCleanup}>Merge and clean up</button> : null}{error ? <div role="alert">{error}</div> : null}</>
  ),
}))

import { PullRequestsTab } from './PullRequestsTab'
import { useWorkspaceStore } from '../../state/store'
import { useGitStore } from '../../state/git'

const repoInfo: RepoInfo = {
  isRepo: true,
  root: 'C:/repo',
  branch: 'main',
  detachedSha: null,
  headSha: 'a'.repeat(40),
  upstream: 'origin/main',
  ahead: 0,
  behind: 0,
  state: 'clean',
  remotes: [],
}

const hostingInfo: HostingInfo = {
  provider: 'github',
  host: 'github.com',
  owner: 'JSCOP',
  repo: 'vibelink-app',
  webUrl: 'https://github.com/JSCOP/vibelink-app',
  tokenPresent: true,
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  choiceDialog.mockReset()
  promptDialog.mockReset()
})

test('reveals a selected pull request file in Explorer', () => {
  invoke.mockImplementation(async (command: string) => {
    if (command === 'hosting_prs_list' || command === 'git_branches') return []
    if (command === 'git_log') return { commits: [], hasMore: false }
    return null
  })
  const onRevealFile = vi.fn()

  render(
    <PullRequestsTab
      sessionId="session-1"
      workspaceFolder="C:/repo"
      repoInfo={repoInfo}
      hostingInfo={hostingInfo}
      hostingError={null}
      onHostingChanged={async () => {}}
      onRepositoryChanged={async () => {}}
      onRevealFile={onRevealFile}
    />,
  )

  fireEvent.click(screen.getByRole('button', { name: 'Pull request file' }))
  expect(onRevealFile).toHaveBeenCalledWith('src/pull-request.ts')
})

test('confirms exact review identity, uses native expected-SHA merge, and delegates cleanup to shared preflight flow', async () => {
  const preflightWorktreeRemoval = vi.fn(async () => ({ worktreeId: 'worktree-1', instanceId: 'instance-1', repositoryPath: 'C:/repo', worktreePath: 'C:/repo', branch: 'feature/review', blockers: [{ kind: 'live_session', hard: false, message: 'workspace session is live' }, { kind: 'live_panes', hard: false, message: 'workspace panes are live' }], warnings: [] }))
  const removeWorktreeSession = vi.fn(async () => ({ checkoutRemoved: true, branchDeleted: false, branchPreservedReason: 'branch is checked out by another worktree', sessionRemoved: true, metadataRemoved: true }))
  useWorkspaceStore.setState({ worktreeProjections: [{ record: { id: 'worktree-1', sessionId: 'session-1' } }], preflightWorktreeRemoval, removeWorktreeSession } as never)
  choiceDialog.mockResolvedValueOnce('merge-cleanup').mockResolvedValueOnce('cleanup').mockResolvedValueOnce('acknowledge')
  invoke.mockImplementation(async (command: string) => {
    if (command === 'hosting_prs_list') return [{ number: 42, title: 'Ship', author: 'octocat', sourceBranch: 'feature/review', targetBranch: 'main', draft: false, url: 'https://example.test/42', state: 'open' }]
    if (command === 'hosting_ci_status') return { state: 'success', checks: [] }
    if (command === 'git_branches') return []
    if (command === 'git_log') return { commits: [], hasMore: false }
    if (command === 'hosting_pr_detail') return { number: 42, title: 'Ship', body: '', author: 'octocat', sourceBranch: 'feature/review', targetBranch: 'main', draft: false, url: 'https://example.test/42', state: 'open', headSha: 'provider-head-sha', checks: [] }
    if (command === 'git_diff_refs') return []
    if (command === 'hosting_pr_merge') return { number: 42, sourceBranch: 'feature/review', targetBranch: 'main', headSha: 'provider-head-sha', mergeSha: 'merge-sha', message: 'merged' }
    return null
  })
  render(<PullRequestsTab sessionId="session-1" workspaceFolder="C:/repo" repoInfo={{ ...repoInfo, branch: 'feature/review' }} hostingInfo={hostingInfo} hostingError={null} onHostingChanged={async () => {}} onRepositoryChanged={async () => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Select pull request' }))
  await screen.findByRole('button', { name: 'Merge and clean up' })
  fireEvent.click(screen.getByRole('button', { name: 'Merge and clean up' }))

  await waitFor(() => expect(invoke).toHaveBeenCalledWith('hosting_pr_merge', { workspaceFolder: 'C:/repo', request: { number: 42, expectedHeadSha: 'provider-head-sha' } }))
  expect(choiceDialog.mock.calls[0]?.[0].message).toContain('Merge #42: feature/review → main at provider-head-sha')
  await waitFor(() => expect(choiceDialog).toHaveBeenCalledTimes(3))
  expect(preflightWorktreeRemoval).toHaveBeenCalledWith('worktree-1', true)
  expect(choiceDialog.mock.calls[1]?.[0].message).toContain('workspace session is live; workspace panes are live')
  await waitFor(() => expect(removeWorktreeSession).toHaveBeenCalledWith('session-1', { deleteBranch: true, acknowledgedBlockers: ['live_session', 'live_panes'], providerMergedHead: 'provider-head-sha' }))
  expect(choiceDialog.mock.calls[2]?.[0].message).toBe('branch is checked out by another worktree')
})


test('rejects hard cleanup blockers before shared GUI teardown is entered', async () => {
  const preflightWorktreeRemoval = vi.fn(async () => ({ worktreeId: 'worktree-1', instanceId: 'instance-1', repositoryPath: 'C:/repo', worktreePath: 'C:/repo', branch: 'feature/review', blockers: [{ kind: 'identity_mismatch', hard: true, message: 'worktree identity changed' }], warnings: [] }))
  const removeWorktreeSession = vi.fn()
  useWorkspaceStore.setState({ worktreeProjections: [{ record: { id: 'worktree-1', sessionId: 'session-1' } }], preflightWorktreeRemoval, removeWorktreeSession } as never)
  choiceDialog.mockResolvedValueOnce('merge-cleanup')
  invoke.mockImplementation(async (command: string) => {
    if (command === 'hosting_prs_list') return []
    if (command === 'git_branches') return []
    if (command === 'git_log') return { commits: [], hasMore: false }
    if (command === 'hosting_pr_detail') return { number: 42, title: 'Ship', body: '', author: 'octocat', sourceBranch: 'feature/review', targetBranch: 'main', draft: false, url: 'https://example.test/42', state: 'open', headSha: 'provider-head-sha', checks: [] }
    if (command === 'git_diff_refs') return []
    if (command === 'hosting_pr_merge') return { number: 42, sourceBranch: 'feature/review', targetBranch: 'main', headSha: 'provider-head-sha', mergeSha: 'merge-sha', message: 'merged' }
    return null
  })
  render(<PullRequestsTab sessionId="session-1" workspaceFolder="C:/repo" repoInfo={{ ...repoInfo, branch: 'feature/review' }} hostingInfo={hostingInfo} hostingError={null} onHostingChanged={async () => {}} onRepositoryChanged={async () => {}} />)
  fireEvent.click(screen.getByRole('button', { name: 'Select pull request' }))
  await screen.findByRole('button', { name: 'Merge and clean up' })
  fireEvent.click(screen.getByRole('button', { name: 'Merge and clean up' }))

  expect((await screen.findByRole('alert')).textContent).toContain('Merge succeeded, but cleanup is blocked: worktree identity changed')
  expect(removeWorktreeSession).not.toHaveBeenCalled()
})
test('routes native conflict refusals to Workbench Changes without auto-resolving', async () => {
  const setActiveTab = vi.fn()
  useGitStore.setState({ setActiveTab } as never)
  choiceDialog.mockResolvedValueOnce('merge-cleanup')
  invoke.mockImplementation(async (command: string) => {
    if (command === 'hosting_prs_list') return []
    if (command === 'git_branches') return []
    if (command === 'git_log') return { commits: [], hasMore: false }
    if (command === 'hosting_pr_detail') return { number: 42, title: 'Conflict', body: '', author: 'octocat', sourceBranch: 'feature/review', targetBranch: 'main', draft: false, url: 'https://example.test/42', state: 'open', headSha: 'provider-head-sha', checks: [] }
    if (command === 'git_diff_refs') return []
    if (command === 'hosting_pr_merge') throw new Error('merge blocked: conflicts remain; open Workbench Changes')
    return null
  })
  const onRepositoryChanged = vi.fn(async () => {})
  render(<PullRequestsTab sessionId="session-1" workspaceFolder="C:/repo" repoInfo={{ ...repoInfo, branch: 'feature/review' }} hostingInfo={hostingInfo} hostingError={null} onHostingChanged={async () => {}} onRepositoryChanged={onRepositoryChanged} />)
  fireEvent.click(screen.getByRole('button', { name: 'Select pull request' }))
  await screen.findByRole('button', { name: 'Merge and clean up' })
  fireEvent.click(screen.getByRole('button', { name: 'Merge and clean up' }))

  await waitFor(() => expect(setActiveTab).toHaveBeenCalledWith('session-1', 'changes'))
  expect(onRepositoryChanged).toHaveBeenCalledOnce()
  expect(invoke.mock.calls.some(([command]) => command === 'git_conflict_take')).toBe(false)
})

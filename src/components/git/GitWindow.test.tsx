// @vitest-environment jsdom
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { RepoInfo, WorkingStatus } from '../../ipc/types'

const { invoke, openContent } = vi.hoisted(() => ({ invoke: vi.fn(), openContent: vi.fn(async () => 'content:workbench:workbench') }))
vi.mock('@tauri-apps/api/core', () => ({
  invoke,
  Channel: class MockChannel<T> {
    onmessage: ((event: T) => void) | null = null
    constructor(callback?: (event: T) => void) { this.onmessage = callback ?? null }
  },
}))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => null) }))
// jsdom gives every scroll container zero height, so the real virtualizer would
// render no rows. Render the whole list here so these projection assertions keep
// exercising the actual change rows.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: (index: number) => number }) => ({
    getTotalSize: () => Array.from({ length: count }, (_, index) => estimateSize(index)).reduce((total, size) => total + size, 0),
    getVirtualItems: () => {
      let start = 0
      return Array.from({ length: count }, (_, index) => {
        const size = estimateSize(index)
        const item = { index, key: index, start, size }
        start += size
        return item
      })
    },
  }),
}))
vi.mock('react-diff-viewer-continued', () => ({ DiffMethod: { WORDS_WITH_SPACE: 'diffWordsWithSpace' }, default: () => <div data-testid="diff-viewer" /> }))

vi.mock('./AssignedTab', () => ({ AssignedTab: () => <div>Assigned projection</div> }))
vi.mock('./PullRequestsTab', () => ({ PullRequestsTab: () => <div>Pull requests projection</div> }))
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { emptyGitRepositoryState, emptyGitSessionState, useGitStore } from '../../state/git'
import { useExplorerStore } from '../../state/explorer'
import { useWorkspaceStore } from '../../state/store'
import { GitWorkspaceProvider } from './GitWorkspaceProvider'
import { SourceControlSidebar } from './SourceControlSidebar'
import { WorkbenchContentPanel } from './GitWindow'

const actions: WorkspaceContentActions = {
  openContent,
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleZoomContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameTerminal: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

const repoInfo: RepoInfo = {
  isRepo: true,
  root: 'C:/repo',
  branch: 'main',
  detachedSha: null,
  upstream: 'origin/main',
  ahead: 1,
  behind: 0,
  state: 'clean',
  remotes: [{ name: 'origin', url: 'https://github.com/JSCOP/vibelink-app.git' }],
}
const status: WorkingStatus = {
  staged: [{ path: 'staged.ts', oldPath: null, changeType: 'modified' }],
  unstaged: [{ path: 'src/file.ts', oldPath: null, changeType: 'modified' }],
  untracked: [],
  conflicted: [],
  truncated: false,
}

function renderGit() {
  return render(
    <WorkspaceContentActionsContext.Provider value={actions}>
      <GitWorkspaceProvider pollIntervalMs={60_000}>
        <SourceControlSidebar />
        <WorkbenchContentPanel />
      </GitWorkspaceProvider>
    </WorkspaceContentActionsContext.Provider>,
  )
}

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  openContent.mockClear()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
    if (command === 'git_working_file_contents') return { old: 'before', new: 'after', binary: false }
    if (command === 'fs_list_dir') return [{ name: 'src', isDir: true, isSymlink: false, size: 0, modifiedAt: null }, { name: 'staged.ts', isDir: false, isSymlink: false, size: 1, modifiedAt: null }]
    if (command === 'git_dir_entries') return []
    if (command === 'provider_accounts' || command === 'provider_assigned_items') return []
    if (command === 'provider_credential_status') return { configured: false }
    return null
  })
  useGitStore.setState({ sessions: {} })
  useExplorerStore.setState({ sessions: {} })
  useWorkspaceStore.setState({
    activeSessionId: 'session-1',
    sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }],
    license: { ready: true, status: { state: 'development', entitled: true } as never },
  })
})

describe('Git sidebar and Workbench projection', () => {
  test('selects the file in Explorer without pulling the side panel away from Source Control', async () => {
    renderGit()
    const row = await screen.findByRole('button', { name: 'unstaged: src/file.ts' })
    fireEvent.click(row)
    await waitFor(() => expect(openContent).toHaveBeenCalledWith({ kind: 'workbench' }))
    // The path is selected in the Explorer store so it is already highlighted
    // whenever the user opens Explorer themselves...
    await waitFor(() => expect(useExplorerStore.getState().sessions['session-1']?.selectedPath).toBe('src/file.ts'))
    // ...but reviewing a diff must never steal the left rail from the change list.
    expect(openContent).not.toHaveBeenCalledWith({ kind: 'explorer' })
    expect(screen.getByRole('region', { name: 'Source Control' })).toBeTruthy()
    expect(await screen.findByTestId('diff-viewer')).toBeTruthy()
  })

  test('requests staged and unstaged contents with the selected area', async () => {
    renderGit()
    fireEvent.click(await screen.findByRole('button', { name: 'staged: staged.ts' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_working_file_contents', { workspaceFolder: 'C:/repo', path: 'staged.ts', area: 'staged' }))
    fireEvent.click(screen.getByRole('button', { name: 'unstaged: src/file.ts' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_working_file_contents', { workspaceFolder: 'C:/repo', path: 'src/file.ts', area: 'unstaged' }))
  })

  test('passes the displayed repository path to mutations and keeps Push non-force', async () => {
    renderGit()
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for src/file.ts' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Stage' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_stage', { workspaceFolder: 'C:/repo', paths: ['src/file.ts'] }))
    fireEvent.click(screen.getByRole('button', { name: 'Push workspace repository' }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_push', { workspaceFolder: 'C:/repo', remote: null, branch: 'main', setUpstream: false, forceWithLease: false }))
  })

  test('reroots nested repository diffs and actions without changing workspace scope', async () => {
    const nestedInfo = { ...repoInfo, root: 'C:/repo/vendor/tool', branch: 'feature' }
    const nestedStatus: WorkingStatus = { staged: [], unstaged: [{ path: 'src/nested.ts', oldPath: null, changeType: 'modified' }], untracked: [], conflicted: [], truncated: false }
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'git_repo_info') return args?.workspaceFolder === 'C:/repo/vendor/tool' ? nestedInfo : repoInfo
      if (command === 'git_working_status') return args?.workspaceFolder === 'C:/repo/vendor/tool' ? nestedStatus : status
      if (command === 'hosting_detect') return { provider: null, host: null, owner: null, repo: null, webUrl: null, tokenPresent: false }
      if (command === 'git_working_file_contents') return { old: 'old', new: 'new', binary: false }
      if (command === 'fs_list_dir' || command === 'git_dir_entries') return []
      return null
    })
    useGitStore.setState({ sessions: { 'session-1': { ...emptyGitSessionState, repositories: { 'vendor/tool': { ...emptyGitRepositoryState, repoInfo: nestedInfo, status: nestedStatus } }, activeRepoRoot: 'vendor/tool', selectedPath: 'vendor/tool/src/nested.ts', selectedRepoRoot: 'vendor/tool', selectedArea: 'unstaged' } } })
    renderGit()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_working_file_contents', { workspaceFolder: 'C:/repo/vendor/tool', path: 'src/nested.ts', area: 'unstaged' }))
    expect((await screen.findAllByText('vendor/tool')).length).toBeGreaterThan(0)
    expect(useWorkspaceStore.getState().activeSessionId).toBe('session-1')
  })

  test('keeps Assigned and Pull Requests reachable from Source Control', async () => {
    renderGit()
    fireEvent.click(await screen.findByRole('button', { name: 'More Source Control actions' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Assigned / Pull Requests' }))
    await waitFor(() => expect(useGitStore.getState().sessions['session-1'].activeTab).toBe('assigned'))
    expect(openContent).toHaveBeenCalledWith({ kind: 'workbench' })
    expect((await screen.findByRole('tab', { name: 'Assigned / Pull Requests' })).getAttribute('aria-selected')).toBe('true')
  })
})

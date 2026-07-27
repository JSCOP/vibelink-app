// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import type { RepoInfo, WorkingStatus } from '../../ipc/types'

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
  useWorkspaceStore.setState({ activeSessionId: 'session-1', sessions: [{ id: 'session-1', name: 'Repo', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }], license: { ready: true, status: { state: 'development', entitled: true } as never } })
})

test('mounts one interval and one focus listener regardless of consumer count', async () => {
  const interval = vi.spyOn(window, 'setInterval')
  const addListener = vi.spyOn(window, 'addEventListener')
  render(<WorkspaceContentActionsContext.Provider value={actions}><GitWorkspaceProvider><Probe /><Probe /><Probe /></GitWorkspaceProvider></WorkspaceContentActionsContext.Provider>)
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_working_status', { workspaceFolder: 'C:/repo' }))
  expect(interval.mock.calls.filter(([, delay]) => delay === 3_000)).toHaveLength(1)
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

test('computes bottom primary action precedence without implicit sync or force', () => {
  expect(sourceControlPrimaryAction({ ...repoInfo, state: 'merging' }, { ...status, conflicted: [{ path: 'conflict.ts', oldPath: null, changeType: 'modified' }] }, '', false).id).toBe('review-conflicts')
  expect(sourceControlPrimaryAction(repoInfo, status, '', false).id).toBe('stage-all')
  expect(sourceControlPrimaryAction(repoInfo, { ...status, unstaged: [], staged: [{ path: 'file.ts', oldPath: null, changeType: 'modified' }] }, '', false).id).toBe('enter-message')
  expect(sourceControlPrimaryAction(repoInfo, { ...status, unstaged: [], staged: [{ path: 'file.ts', oldPath: null, changeType: 'modified' }] }, 'commit', false).id).toBe('commit')
  expect(sourceControlPrimaryAction({ ...repoInfo, ahead: 2, behind: 1 }, { ...status, unstaged: [] }, '', false).id).toBe('pull')
  expect(sourceControlPrimaryAction({ ...repoInfo, ahead: 2 }, { ...status, unstaged: [] }, '', false).id).toBe('push')
})

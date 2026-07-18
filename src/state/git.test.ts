import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { RepoInfo, WorkingStatus } from '../ipc/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { emptyGitSessionState, useGitStore } from './git'

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
const status: WorkingStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }

beforeEach(() => {
  invoke.mockReset()
  useGitStore.setState({ sessions: {} })
})

describe('git store', () => {
  test('refreshes repository info and working status together', async () => {
    invoke.mockImplementation(async (command: string) => command === 'git_repo_info' ? repoInfo : status)
    await useGitStore.getState().refreshGit('session-1', 'C:/repo')
    expect(invoke).toHaveBeenCalledWith('git_repo_info', { workspaceFolder: 'C:/repo' })
    expect(invoke).toHaveBeenCalledWith('git_working_status', { workspaceFolder: 'C:/repo' })
    expect(useGitStore.getState().sessions['session-1']).toMatchObject({ repoInfo, status, refreshing: false, error: null })
  })

  test('refreshes after a successful mutation', async () => {
    invoke.mockImplementation(async (command: string) => command === 'git_repo_info' ? repoInfo : status)
    const mutation = vi.fn(async () => undefined)
    await useGitStore.getState().runGitMutation('session-1', 'C:/repo', mutation)
    expect(mutation).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  test('treats a missing workspace folder as an empty state', async () => {
    await useGitStore.getState().refreshGit('session-1', null)
    expect(invoke).not.toHaveBeenCalled()
    expect(useGitStore.getState().sessions['session-1']).toEqual(emptyGitSessionState)
  })
})

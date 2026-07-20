import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { HostingInfo, RepoInfo, WorkingStatus } from '../ipc/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { emptyGitRepositoryState, emptyGitSessionState, repositoryStateFor, useGitStore } from './git'

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
const hostingInfo: HostingInfo = { provider: 'github', host: 'github.com', owner: 'JSCOP', repo: 'vibelink-app', webUrl: 'https://github.com/JSCOP/vibelink-app', tokenPresent: true }

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
    expect(repositoryStateFor(useGitStore.getState().sessions['session-1'], '')).toMatchObject({ repoInfo, status, refreshing: false, error: null })
  })

  test('stores nested repository state independently from the workspace repository', async () => {
    invoke.mockImplementation(async (command: string) => command === 'git_repo_info' ? { ...repoInfo, root: 'C:/repo/vendor/tool', branch: null, detachedSha: 'a'.repeat(40) } : status)
    await useGitStore.getState().refreshRepository('session-1', 'C:/repo', 'vendor/tool')
    expect(invoke).toHaveBeenCalledWith('git_repo_info', { workspaceFolder: 'C:/repo/vendor/tool' })
    expect(repositoryStateFor(useGitStore.getState().sessions['session-1'], 'vendor/tool')).toMatchObject({
      repoInfo: { root: 'C:/repo/vendor/tool', branch: null, detachedSha: 'a'.repeat(40) },
      status,
    })
    expect(repositoryStateFor(useGitStore.getState().sessions['session-1'], '').repoInfo).toBeNull()
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

  test('refreshes hosting detection and CI without coupling local Git state', async () => {
    invoke.mockImplementation(async (command: string) => command === 'hosting_detect' ? hostingInfo : { state: 'success', checks: [] })
    await useGitStore.getState().refreshHosting('session-1', 'C:/repo', 'HEAD', true)
    expect(invoke).toHaveBeenCalledWith('hosting_detect', { workspaceFolder: 'C:/repo' })
    expect(invoke).toHaveBeenCalledWith('hosting_ci_status', { workspaceFolder: 'C:/repo', refName: 'HEAD' })
    expect(repositoryStateFor(useGitStore.getState().sessions['session-1'], '')).toMatchObject({ hostingInfo, ciStatus: { state: 'success', checks: [] }, hostingError: null })
  })

  test('authentication failures keep the detected provider visible without changing local Git state', async () => {
    useGitStore.setState({ sessions: { 'session-1': { ...emptyGitSessionState, repositories: { '': { ...emptyGitRepositoryState, repoInfo, status } } } } })
    invoke.mockImplementation(async (command: string) => {
      if (command === 'hosting_detect') return hostingInfo
      throw 'AUTH: token rejected'
    })
    await useGitStore.getState().refreshHosting('session-1', 'C:/repo', 'HEAD', true)
    expect(repositoryStateFor(useGitStore.getState().sessions['session-1'], '')).toMatchObject({ repoInfo, status, hostingInfo: { provider: 'github', tokenPresent: false }, ciStatus: null, hostingError: 'AUTH: token rejected' })
  })
})

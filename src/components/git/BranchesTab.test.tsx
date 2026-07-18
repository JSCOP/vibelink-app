// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { BranchInfo, RepoInfo, WorkingStatus } from '../../ipc/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('react-diff-viewer-continued', () => ({ default: () => <div /> }))

import { useGitStore } from '../../state/git'
import { BranchesTab } from './BranchesTab'

const branch: BranchInfo = { name: 'feature', isHead: false, isRemote: false, upstream: null, ahead: 0, behind: 0, lastCommitSubject: 'Feature', lastCommitDate: '2026-07-18T00:00:00Z' }
const repoInfo: RepoInfo = { isRepo: true, root: 'C:/repo', branch: 'main', detachedSha: null, upstream: 'origin/main', ahead: 0, behind: 0, state: 'clean', remotes: [] }
const status: WorkingStatus = { staged: [], unstaged: [], untracked: [], conflicted: [], truncated: false }

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_branches') return [branch]
    if (command === 'git_stash_list' || command === 'git_tag_list') return []
    if (command === 'git_repo_info') return repoInfo
    if (command === 'git_working_status') return status
    return null
  })
  useGitStore.setState({ sessions: {} })
})

test('wires branch merge action to the native command', async () => {
  render(<BranchesTab sessionId="session-1" workspaceFolder="C:/repo" repoInfo={repoInfo} status={status} />)
  fireEvent.click(await screen.findByTitle('Merge feature'))
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_merge', { workspaceFolder: 'C:/repo', refName: 'feature' }))
})

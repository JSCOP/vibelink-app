// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { HostingInfo, RepoInfo } from '../../ipc/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('./PullRequestsTabView', () => ({
  PullRequestsTabView: ({ onSelectFile }: { onSelectFile: (path: string) => void }) => (
    <button type="button" onClick={() => onSelectFile('src/pull-request.ts')}>Pull request file</button>
  ),
}))

import { PullRequestsTab } from './PullRequestsTab'

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

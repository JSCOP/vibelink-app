// @vitest-environment jsdom
import { beforeEach, expect, test, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { CommitInfo } from '../../ipc/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => [],
    getTotalSize: () => count * 42,
  }),
}))
vi.mock('react-diff-viewer-continued', () => ({ default: () => <div /> }))

import { useGitStore } from '../../state/git'
import { HistoryTab } from './HistoryTab'

const commit: CommitInfo = {
  sha: 'a'.repeat(40),
  parents: [],
  refs: ['HEAD -> main'],
  authorName: 'VibeLink',
  authorEmail: 'test@example.com',
  authorDate: '2026-07-18T00:00:00Z',
  subject: 'Initial commit',
}

beforeEach(() => {
  cleanup()
  invoke.mockReset()
  invoke.mockResolvedValueOnce({ commits: [commit], hasMore: true }).mockResolvedValueOnce({ commits: [], hasMore: false })
  useGitStore.setState({ sessions: {} })
})

test('renders commits and loads the next page with the current skip', async () => {
  render(<HistoryTab sessionId="session-1" workspaceFolder="C:/repo" pathFilter={null} onRunMutation={async (operation) => { await operation() }} />)
  expect(await screen.findByText('Initial commit')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Load more' }))
  await waitFor(() => expect(invoke).toHaveBeenLastCalledWith('git_log', {
    workspaceFolder: 'C:/repo',
    options: { refName: null, path: null, skip: 1, limit: 200, search: null, author: null },
  }))
})

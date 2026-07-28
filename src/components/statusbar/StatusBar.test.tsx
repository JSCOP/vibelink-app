// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import type { RepoInfo } from '../../ipc/types'
import { emptyGitRepositoryState, emptyGitSessionState, useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { StatusBar } from './StatusBar'

const repoInfo: RepoInfo = { isRepo: true, root: 'C:/repo', branch: 'main', detachedSha: null, headSha: 'a'.repeat(40), upstream: 'origin/main', ahead: 2, behind: 1, state: 'clean', remotes: [] }

const resourceSnapshot = {
  daemon: { pid: 2, memBytes: 40 * 1024 * 1024, processCount: 1 },
  app: { pid: 1, memBytes: 60 * 1024 * 1024, processCount: 3 },
  panes: [{ sessionId: 's1', paneId: 'p1', rootPid: 9, memBytes: 12 * 1024 * 1024, processCount: 2 }],
  totalMemBytes: 112 * 1024 * 1024,
}

describe('StatusBar', () => {
  beforeEach(() => {
    cleanup()
    invoke.mockReset()
    invoke.mockResolvedValue(resourceSnapshot)
    useGitStore.setState({ sessions: { s1: { ...emptyGitSessionState, repositories: { '': { ...emptyGitRepositoryState, repoInfo } } } } })
    useWorkspaceStore.setState({
      sessions: [{ id: 's1', name: 'vibelink', paneCount: 2, createdAt: 0, workspaceFolder: 'C:/repo' }],
      activeSessionId: 's1',
      panes: { p1: { alive: true }, p2: { alive: false }, p3: { alive: true } } as never,
    })
  })

  afterEach(cleanup)

  it('shows the workspace, branch, sync badge, live panes, and resource totals', async () => {
    render(<StatusBar onOpenResourceMonitor={() => undefined} />)
    expect(screen.getByText('vibelink')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('↑2↓1')).toBeTruthy()
    expect(screen.getByText('2 panes')).toBeTruthy()
    await waitFor(() => expect(screen.getByText('112 MB · 6 processes')).toBeTruthy())
  })

  it('opens the resource monitor from the resources segment', async () => {
    const onOpen = vi.fn()
    render(<StatusBar onOpenResourceMonitor={onOpen} />)
    await waitFor(() => expect(screen.getByTitle('Open resource monitor')).toBeTruthy())
    fireEvent.click(screen.getByTitle('Open resource monitor'))
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('renders without a repo or resources', async () => {
    useGitStore.setState({ sessions: {} })
    invoke.mockRejectedValue(new Error('offline'))
    render(<StatusBar onOpenResourceMonitor={() => undefined} />)
    expect(screen.getByText('vibelink')).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
    await waitFor(() => expect(screen.getByText('Resources…')).toBeTruthy())
  })
})

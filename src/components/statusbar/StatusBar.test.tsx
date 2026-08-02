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
  daemon: { pid: 2, cpuPercentX10: 3, memBytes: 40 * 1024 * 1024, processCount: 1, processes: [{ pid: 2, name: 'app.exe', cpuPercentX10: 3, memBytes: 40 * 1024 * 1024 }] },
  app: { pid: 1, cpuPercentX10: 7, memBytes: 60 * 1024 * 1024, processCount: 3, processes: [{ pid: 1, name: 'app.exe', cpuPercentX10: 7, memBytes: 60 * 1024 * 1024 }] },
  panes: [
    { sessionId: 's1', paneId: 'p1', rootPid: 9, title: 'Terminal 1', role: null, cpuPercentX10: 2, memBytes: 12 * 1024 * 1024, processCount: 2, processes: [] },
    { sessionId: 's2', paneId: 'p4', rootPid: 10, title: 'Terminal 2', role: null, cpuPercentX10: 1, memBytes: 4 * 1024 * 1024, processCount: 1, processes: [] },
  ],
  totalCpuPercentX10: 13,
  totalMemBytes: 116 * 1024 * 1024,
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
      completionHistory: [],
    })
  })

  afterEach(cleanup)

  it('shows the workspace, branch, sync badge, memory, and all daemon terminals', async () => {
    render(<StatusBar onOpenCompletionHistory={() => undefined} onOpenResourceMonitor={() => undefined} />)
    expect(screen.getByText('vibelink')).toBeTruthy()
    expect(screen.getByText('main')).toBeTruthy()
    expect(screen.getByText('↑2↓1')).toBeTruthy()
    await waitFor(() => expect(screen.getByTitle('Open resource manager · 116 MB · 2 terminals · 7 processes')).toBeTruthy())
    expect(invoke).toHaveBeenCalledWith('resource_snapshot', { includeDetails: false })
  })

  it('opens the resource manager from the combined memory and terminal segment', async () => {
    const onOpen = vi.fn()
    render(<StatusBar onOpenCompletionHistory={() => undefined} onOpenResourceMonitor={onOpen} />)
    const trigger = await screen.findByTitle('Open resource manager · 116 MB · 2 terminals · 7 processes')
    fireEvent.click(trigger)
    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('keeps the active terminal count when resource collection is unavailable', async () => {
    useGitStore.setState({ sessions: {} })
    invoke.mockRejectedValue(new Error('offline'))
    render(<StatusBar onOpenCompletionHistory={() => undefined} onOpenResourceMonitor={() => undefined} />)
    expect(screen.getByText('vibelink')).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
    await waitFor(() => expect(screen.getByTitle('Open resource manager · 2 terminals')).toBeTruthy())
    expect(screen.getByText('—')).toBeTruthy()
  })

  it('shows unread hook completions and opens their history', () => {
    const onOpen = vi.fn()
    useWorkspaceStore.setState({ completionHistory: [{ id: 'p1:1', paneId: 'p1', sessionId: 's1', paneTitle: 'Codex', agent: 'codex', completedAt: 1, read: false }] })
    render(<StatusBar onOpenCompletionHistory={onOpen} onOpenResourceMonitor={() => undefined} />)
    fireEvent.click(screen.getByTitle('Open completion history'))
    expect(screen.getByText('1')).toBeTruthy()
    expect(onOpen).toHaveBeenCalledOnce()
  })
})

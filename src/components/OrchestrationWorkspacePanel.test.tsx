// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { orchestrationRequest } = vi.hoisted(() => ({ orchestrationRequest: vi.fn() }))
vi.mock('../ipc/orchestration', () => ({ orchestrationRequest }))
vi.mock('./OrchestratorChat', () => ({ OrchestratorChat: () => <div>Agent chat</div> }))
vi.mock('./AutomationPanel', () => ({ AutomationPanel: () => <div>Automation panel</div> }))

import { useWorkspaceStore } from '../state/store'
import { OrchestrationWorkspacePanel } from './OrchestrationWorkspacePanel'

const run = { id: 'run-1', sessionId: 'session-1', goal: 'Durable mission', status: 'running', revision: 7, policy: { maxConcurrent: 4 }, createdAt: 1, updatedAt: 2 }
const task = { id: 'task-1', runId: 'run-1', title: 'Failed task', description: '', status: 'failed', position: 0, revision: 3, dependencies: [], result: { reason: 'agent_lost' } }

beforeEach(() => {
  useWorkspaceStore.setState({ activeSessionId: 'session-1', sessions: [{ id: 'session-1', name: 'Workspace', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }] })
  orchestrationRequest.mockReset()
  orchestrationRequest.mockImplementation(async (method: string) => {
    if (method === 'runs.list') return [run]
    if (method === 'run.get') return run
    if (method === 'tasks.list') return [task]
    if (method === 'dispatches.list') return [{ id: 'dispatch-1', taskId: 'task-1', attempt: 2, agentInstanceId: 'agent-1', status: 'failed', worktree: { baseRevision: 'abcdef123456', branch: 'vibelink/run-1/task-1', worktreePath: 'C:/worktrees/task-1' }, failureCode: 'agent_lost' }]
    if (method === 'agents.list') return [{ id: 'agent-1', provider: 'pty_cli', profile: 'codex', status: 'lost', generation: 2, runtimeIdentity: 'process:1' }]
    if (method === 'messages.list') return [{ id: 'message-1', runId: 'run-1', dispatchId: 'dispatch-1', senderKind: 'worker', messageType: 'worker_done', payload: { filesModified: ['src/lib.rs'] }, createdAt: 3 }]
    if (method === 'gates.list') return []
    if (method === 'events.catchup') return { events: [{ sequence: 12, eventType: 'agents.reconciled', payload: {} }], acknowledgedSequence: 0, latestSequence: 12, hasMore: false }
    if (method === 'events.acknowledge') return { acknowledgedSequence: 12 }
    if (method === 'task.retry') return { ...task, status: 'ready', revision: 4 }
    return null
  })
})

afterEach(() => cleanup())

describe('OrchestrationWorkspacePanel', () => {
  it('shows durable runs, agent/worktree comparison, and acknowledges replayed events', async () => {
    render(<OrchestrationWorkspacePanel />)
    expect(await screen.findByText('Durable mission')).toBeInTheDocument()
    expect(await screen.findByText(/pty_cli codex/)).toBeInTheDocument()
    expect(screen.getByText('vibelink/run-1/task-1')).toBeInTheDocument()
    expect(screen.getByText('src/lib.rs')).toBeInTheDocument()
    await waitFor(() => expect(orchestrationRequest).toHaveBeenCalledWith('events.acknowledge', { consumerId: 'desktop:session-1', runId: 'run-1', sequence: 12 }))
  })

  it('acknowledges only the delivered page tail when more events remain', async () => {
    orchestrationRequest.mockImplementation(async (method: string) => {
      if (method === 'runs.list') return [run]
      if (method === 'run.get') return run
      if (method === 'tasks.list') return [task]
      if (method === 'dispatches.list') return []
      if (method === 'agents.list') return []
      if (method === 'messages.list') return []
      if (method === 'gates.list') return []
      if (method === 'events.catchup') return {
        events: [{ sequence: 11, eventType: 'agents.reconciled', payload: {} }, { sequence: 12, eventType: 'agents.reconciled', payload: {} }],
        acknowledgedSequence: 0,
        latestSequence: 940,
        hasMore: true,
      }
      if (method === 'events.acknowledge') return { acknowledgedSequence: 12 }
      return null
    })
    render(<OrchestrationWorkspacePanel />)
    await waitFor(() => expect(orchestrationRequest).toHaveBeenCalledWith('events.acknowledge', { consumerId: 'desktop:session-1', runId: 'run-1', sequence: 12 }))
    expect(orchestrationRequest).not.toHaveBeenCalledWith('events.acknowledge', expect.objectContaining({ sequence: 940 }))
  })

  it('retries a failed orchestration task with both revisions', async () => {
    render(<OrchestrationWorkspacePanel />)
    const retry = await screen.findByRole('button', { name: /Retry/ })
    fireEvent.click(retry)
    await waitFor(() => expect(orchestrationRequest).toHaveBeenCalledWith('task.retry', {
      runId: 'run-1', taskId: 'task-1', expectedRunRevision: 7, expectedTaskRevision: 3,
    }))
  })
})

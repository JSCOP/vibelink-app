// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { useWorkspaceStore } from '../state/store'
import { AutomationPanel } from './AutomationPanel'

const automation = {
  id: 'automation-1', name: 'Daily mission', scheduleKind: 'daily', scheduleValue: '09:00', timezone: 'UTC', enabled: true,
  workspaceMode: 'worktree', precheck: {}, policy: { goal: 'Review workspace', maxConcurrent: 4 },
}

beforeEach(() => {
  useWorkspaceStore.setState({ activeSessionId: 'session-1', sessions: [{ id: 'session-1', name: 'Workspace', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }] })
  invoke.mockReset()
  invoke.mockImplementation(async (_command: string, payload?: { args?: string[] }) => {
    const args = payload?.args ?? []
    if (args[0] === 'automation' && args[1] === 'list') return [automation]
    if (args[0] === 'automation' && args[1] === 'runs') return [{ id: 'automation-run-1', automationId: automation.id, orchestrationRunId: 'run-1', status: 'running', outputSummary: 'Mission launched', outputTruncated: false, worktreePath: 'C:/worktrees/run-1', branch: 'vibelink/run-1', createdAt: 1 }]
    return null
  })
})

afterEach(() => cleanup())

describe('AutomationPanel', () => {
  it('shows coordinator run and isolated worktree history', async () => {
    render(<AutomationPanel />)
    expect(await screen.findByText('Daily mission')).toBeInTheDocument()
    expect(screen.getByText('Review workspace')).toBeInTheDocument()
    expect(screen.getByText('vibelink/run-1')).toBeInTheDocument()
    expect(screen.getByText('C:/worktrees/run-1')).toBeInTheDocument()
  })

  it('creates a mission automation with goal and worktree policy', async () => {
    render(<AutomationPanel />)
    fireEvent.change(screen.getByLabelText('Automation name'), { target: { value: 'Weekly review' } })
    fireEvent.change(screen.getByLabelText('Automation mission goal'), { target: { value: 'Review dependencies' } })
    fireEvent.click(screen.getByRole('button', { name: /Create mission/ }))
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('cli_request', {
      args: expect.arrayContaining(['automation', 'create', '--workspace', 'session-1', '--goal', 'Review dependencies', '--workspace-mode', 'worktree']),
    }))
  })
})

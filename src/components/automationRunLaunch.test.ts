import { afterEach, describe, expect, it, vi } from 'vitest'

const historyMock = vi.hoisted(() => ({ listAgentConversations: vi.fn() }))
vi.mock('../ipc/agentHistory', () => ({ listAgentConversations: historyMock.listAgentConversations }))

import { resolveAutomationRunLaunch } from './automationRunLaunch'

afterEach(() => vi.clearAllMocks())

describe('resolveAutomationRunLaunch', () => {
  it('resumes a resumable claude conversation found in the worktree', async () => {
    historyMock.listAgentConversations.mockResolvedValue([
      { id: 'abc', title: 'Fix bug', agent: 'claude', updatedAt: null, cwd: 'W', path: 'W/.jsonl' },
    ])
    const launch = await resolveAutomationRunLaunch('W', 'run 3')
    expect(launch.cwd).toBe('W')
    expect(launch.shell).toBe('pwsh.exe')
    expect(launch.args?.join(' ')).toContain('claude')
    expect(launch.args?.join(' ')).toContain('abc')
  })

  it('falls back to a plain shell in the worktree when nothing is resumable', async () => {
    historyMock.listAgentConversations.mockResolvedValue([
      { id: 'x', title: 't', agent: 'hermes', updatedAt: null, cwd: 'W', path: 'p' },
    ])
    const launch = await resolveAutomationRunLaunch('W', 'run 3')
    expect(launch).toEqual({ cwd: 'W', title: 'run 3' })
  })

  it('falls back to a shell when history lookup throws', async () => {
    historyMock.listAgentConversations.mockRejectedValue(new Error('no backend'))
    const launch = await resolveAutomationRunLaunch('W', 'run 3')
    expect(launch).toEqual({ cwd: 'W', title: 'run 3' })
  })
})

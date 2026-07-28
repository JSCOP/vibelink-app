// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationRecord, AutomationRunRecord } from '../ipc/automations'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { useWorkspaceStore } from '../state/store'
import { AutomationPanel } from './AutomationPanel'

const automation: AutomationRecord = {
  id: 'automation-1',
  sessionId: 'session-1',
  name: 'Daily mission',
  prompt: 'Review workspace',
  agent: 'hermes',
  provider: null,
  model: null,
  useAgentDefaultModel: true,
  toolsets: ['hermes-acp'],
  skills: [],
  maxTurns: 50,
  timeoutSeconds: 1_800,
  scheduleKind: 'daily',
  scheduleValue: '09:00',
  timezone: 'UTC',
  dtstart: 1,
  nextRunAt: 2_000_000_000_000,
  lastRunAt: 1_900_000_000_000,
  enabled: true,
  requiresReview: false,
  missedRunGraceMinutes: 720,
  missedRunPolicy: 'run_once_within_grace',
  workspaceMode: 'new_per_run',
  worktreeStorage: { mode: 'appData', drive: '', folderName: 'VibeLinkWorktrees', customRoot: '', groupByRepository: true },
  baseRef: null,
  precheck: { command: 'pnpm test', timeoutSeconds: 60, requireWorkspace: true, requireGit: true },
  source: null,
  createdAt: 1,
  updatedAt: 1,
}

const completedRun: AutomationRunRecord = {
  id: 'automation-run-1',
  automationId: automation.id,
  runNumber: 1,
  trigger: 'scheduled',
  scheduledFor: 1,
  status: 'completed',
  runtimeIdentity: null,
  worktree: { path: 'C:/worktrees/run-1', branch: 'vibelink/run-1', baseRevision: 'abc123', disposition: 'retained' },
  precheckResult: { ok: true, command: 'pnpm test', stdout: 'ok', stderr: '', exitCode: 0, timedOut: false, durationMs: 25, truncated: false, error: null },
  outputSnapshot: { finalResponse: 'Hermes completed review.', stdout: '', stderr: '', truncated: false },
  usage: { inputTokens: 120, outputTokens: 40 },
  error: null,
  startedAt: 2,
  finishedAt: 3,
  createdAt: 1,
}

beforeEach(() => {
  useWorkspaceStore.setState({
    activeSessionId: 'session-1',
    sessions: [{ id: 'session-1', name: 'Workspace', paneCount: 0, createdAt: 1, workspaceFolder: 'C:/repo' }],
    agentClis: [
      { id: 'hermes', displayName: 'Hermes', installed: true, auth: 'unknown', loginHint: 'hermes' },
      { id: 'codex', displayName: 'Codex', installed: false, auth: 'unknown', loginHint: 'codex login' },
    ],
  })
  invoke.mockReset()
  invoke.mockImplementation(async (_command: string, payload?: { args?: string[] }) => {
    const args = payload?.args ?? []
    if (args[0] !== 'automation') return null
    if (args[1] === 'list') return [automation]
    if (args[1] === 'runs') return [completedRun]
    if (args[1] === 'schedule-preview') return [2_000_000_000_000, 2_000_086_400_000]
    if (args[1] === 'create') {
      const jsonIndex = args.indexOf('--json')
      const input = JSON.parse(args[jsonIndex + 1])
      return { ...automation, ...input, id: 'automation-created' }
    }
    return null
  })
})

afterEach(() => cleanup())

describe('AutomationPanel', () => {
  it('shows the prompt and retained run output in list/detail navigation', async () => {
    render(<AutomationPanel />)
    fireEvent.click(await screen.findByRole('button', { name: /Daily mission/ }))
    expect(await screen.findByText('Review workspace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Runs/ }))
    expect(await screen.findByText('Hermes completed review.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open retained worktree' })).toHaveAttribute('title', 'C:/worktrees/run-1')
  })

  it('creates an automation on the default agent with isolated worktree defaults', async () => {
    render(<AutomationPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'New' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Weekly review' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Review dependencies' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }))

    await waitFor(() => {
      const createCall = invoke.mock.calls.find(([, payload]) => payload?.args?.[1] === 'create')
      expect(createCall).toBeDefined()
      const args = createCall?.[1]?.args
      if (!args) throw new Error('missing automation create argv')
      const input = JSON.parse(args[args.indexOf('--json') + 1])
      expect(input).toMatchObject({
        name: 'Weekly review',
        prompt: 'Review dependencies',
        agent: 'hermes',
        scheduleKind: 'daily',
        scheduleValue: '09:00',
        workspaceMode: 'new_per_run',
        useAgentDefaultModel: true,
        requiresReview: false,
      })
    })
  })

  it('creates the automation on the agent chosen from the icon dropdown', async () => {
    render(<AutomationPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'New' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Codex audit' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Audit the repo' } })

    fireEvent.click(screen.getByRole('button', { name: /Hermes/ }))
    // An uninstalled CLI is still selectable; the option explains why.
    fireEvent.click(await screen.findByRole('option', { name: /codex not found on PATH/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }))

    await waitFor(() => {
      const createCall = invoke.mock.calls.find(([, payload]) => payload?.args?.[1] === 'create')
      expect(createCall).toBeDefined()
      const args = createCall?.[1]?.args
      if (!args) throw new Error('missing automation create argv')
      expect(JSON.parse(args[args.indexOf('--json') + 1])).toMatchObject({ agent: 'codex' })
    })
  })

  it('rewrites the schedule value when the cadence changes', async () => {
    render(<AutomationPanel />)
    fireEvent.click(await screen.findByRole('button', { name: 'New' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Weekly audit' } })
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Audit weekly' } })

    fireEvent.click(screen.getByRole('button', { name: /Every day at 09:00/ }))
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'weekly' } })
    fireEvent.change(screen.getByLabelText('Day'), { target: { value: 'WED' } })
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '18' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create automation' }))

    await waitFor(() => {
      const createCall = invoke.mock.calls.find(([, payload]) => payload?.args?.[1] === 'create')
      expect(createCall).toBeDefined()
      const args = createCall?.[1]?.args
      if (!args) throw new Error('missing automation create argv')
      expect(JSON.parse(args[args.indexOf('--json') + 1])).toMatchObject({
        scheduleKind: 'weekly',
        scheduleValue: 'WED@18:00',
      })
    })
  })
})

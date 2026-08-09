import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  aggregateAgentPaneStatus,
  agentActivityStaleMs,
  agentStateFromTitle,
  resolveAgentPaneStatus,
  type AgentPaneStatus,
  type AgentPaneStatusInput,
} from './agentPaneStatus'
import type { PaneMeta } from '../ipc/types'
import { defaultSettings } from './profiles'
import {
  createAgentPaneStatusesSelector,
  type AgentPaneStatusesSelectorState,
} from './useAgentPaneStatuses'
import { EXPLICIT_ATTENTION_TTL_MS, type NativeAttentionPane } from './worktreeAttention'

const now = 1_000_000_000

function attentionPane(overrides: Partial<NativeAttentionPane>): NativeAttentionPane {
  return {
    workspaceId: 'workspace-1',
    paneId: 'pane-1',
    state: 'idle',
    stateUpdatedAt: now,
    lastOutputAt: now,
    unreadCount: 0,
    interrupted: false,
    source: 'orchestration',
    alive: true,
    title: 'Shell',
    ...overrides,
  }
}

function resolve(overrides: Partial<AgentPaneStatusInput>) {
  return resolveAgentPaneStatus({ isAgentPane: true, alive: true, now, ...overrides })
}

function pane(): PaneMeta {
  return {
    id: 'pane-1',
    alive: true,
    config: {
      paneId: 'pane-1',
      shell: 'pwsh.exe',
      args: [],
      env: [],
      title: 'pwsh',
      profileId: 'powershell',
      cols: 80,
      rows: 24,
    },
  }
}

function selectorState(overrides: Partial<AgentPaneStatusesSelectorState> = {}): AgentPaneStatusesSelectorState {
  return {
    panes: { 'pane-1': pane() },
    settings: defaultSettings,
    paneAgentActivity: {},
    attentionSnapshot: null,
    paneCompletionHighlights: {},
    ...overrides,
  }
}

describe('agentStateFromTitle', () => {
  test('reads the running and idle states agents publish in their titles', () => {
    expect(agentStateFromTitle('OMP - Running')).toBe('working')
    expect(agentStateFromTitle('OMP - Idle')).toBe('idle')
    expect(agentStateFromTitle('\u280b Codex thinking')).toBe('working')
    expect(agentStateFromTitle('Claude needs permission')).toBe('waiting')
    expect(agentStateFromTitle('\u270b gemini')).toBe('waiting')
  })

  test('says nothing about an ordinary shell title', () => {
    expect(agentStateFromTitle('pwsh')).toBeNull()
    expect(agentStateFromTitle('')).toBeNull()
    expect(agentStateFromTitle(undefined)).toBeNull()
  })

  test('permission wins over a spinner still animating behind the prompt', () => {
    expect(agentStateFromTitle('\u280b waiting for input')).toBe('waiting')
  })
})

describe('resolveAgentPaneStatus', () => {
  test('never infers a state for a plain shell', () => {
    expect(resolve({ isAgentPane: false, title: 'OMP - Running' }).state).toBe('idle')
    expect(resolve({ isAgentPane: false, activity: { startedAt: now } }).state).toBe('idle')
  })

  test('still trusts hook and daemon evidence on an unrecognized pane', () => {
    // Users open the plain Shell profile and type `omp`; a hook or dispatch
    // reporting that pane is proof, so it must not be gated on recognition.
    expect(resolve({ isAgentPane: false, completed: true }).state).toBe('done')
    expect(resolve({ isAgentPane: false, attention: attentionPane({ state: 'working' }) }).state).toBe('working')
  })

  test('prefers fresh daemon evidence over the title', () => {
    const status = resolve({
      title: 'OMP - Idle',
      attention: attentionPane({ state: 'working', stateUpdatedAt: now - 1_000 }),
    })
    expect(status).toMatchObject({ state: 'working', source: 'orchestration', pulsing: true })
  })

  test('collapses blocked into waiting for the user', () => {
    expect(resolve({ attention: attentionPane({ state: 'blocked' }) }).state).toBe('waiting')
  })

  test('ignores daemon evidence that aged past its TTL', () => {
    const status = resolve({
      title: 'OMP - Running',
      attention: attentionPane({ state: 'idle', stateUpdatedAt: now - EXPLICIT_ATTENTION_TTL_MS - 1 }),
    })
    expect(status).toMatchObject({ state: 'working', source: 'terminal-title' })
  })

  test('an explicit idle title retires a local turn guess the quiet window has not', () => {
    expect(resolve({ title: 'OMP - Idle', activity: { startedAt: now - 1_000 } }).state).toBe('idle')
    expect(resolve({ title: 'pwsh', activity: { startedAt: now - 1_000 } })).toMatchObject({
      state: 'working',
      source: 'terminal-activity',
    })
  })

  test('drops a local turn guess that no signal ever finished', () => {
    expect(resolve({ activity: { startedAt: now - agentActivityStaleMs - 1 } }).state).toBe('idle')
  })

  test('a new turn outranks an unacknowledged completion alert', () => {
    expect(resolve({ completed: true }).state).toBe('done')
    expect(resolve({ completed: true, title: 'OMP - Running' }).state).toBe('working')
    expect(resolve({ completed: true, activity: { startedAt: now } }).state).toBe('working')
  })

  test('a dead pane keeps its completion alert but never spins', () => {
    expect(resolve({ alive: false, title: 'OMP - Running', completed: true }).state).toBe('done')
    expect(resolve({ alive: false, title: 'OMP - Running' }).state).toBe('idle')
  })
})

describe('aggregateAgentPaneStatus', () => {
  const status = (state: AgentPaneStatus['state']): AgentPaneStatus =>
    ({ state, source: 'terminal-title', label: state, pulsing: false })

  test('surfaces the member that needs the user most', () => {
    expect(aggregateAgentPaneStatus([status('done'), status('working'), status('waiting')])?.state).toBe('waiting')
    expect(aggregateAgentPaneStatus([status('done'), status('working')])?.state).toBe('working')
    expect(aggregateAgentPaneStatus([])).toBeNull()
  })
})

describe('createAgentPaneStatusesSelector', () => {
  afterEach(() => vi.useRealTimers())

  test('reuses the map when only the attention capture time changes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const selector = createAgentPaneStatusesSelector()
    const attentionSnapshot = {
      capturedAt: now,
      panes: [attentionPane({ state: 'working' })],
    }
    const state = selectorState({ attentionSnapshot })

    const first = selector(state)
    const next = selector({
      ...state,
      attentionSnapshot: { ...attentionSnapshot, capturedAt: now + 15_000 },
    })

    expect(next).toBe(first)
  })

  test('returns a new map when an attention state crosses its TTL', () => {
    vi.useFakeTimers()
    const selector = createAgentPaneStatusesSelector()
    const attentionSnapshot = {
      capturedAt: now,
      panes: [attentionPane({ state: 'working' })],
    }
    const state = selectorState({
      attentionSnapshot,
      paneCompletionHighlights: {
        'pane-1': { completedAt: now, source: 'agent-hook', sessionId: 'workspace-1' },
      },
    })
    vi.setSystemTime(now + EXPLICIT_ATTENTION_TTL_MS)
    const fresh = selector(state)

    vi.setSystemTime(now + EXPLICIT_ATTENTION_TTL_MS + 1)
    const stale = selector({
      ...state,
      attentionSnapshot: { ...attentionSnapshot, capturedAt: now + EXPLICIT_ATTENTION_TTL_MS + 1 },
    })

    expect(fresh['pane-1']).toMatchObject({ state: 'working', source: 'orchestration' })
    expect(stale).not.toBe(fresh)
    expect(stale['pane-1']).toMatchObject({ state: 'done', source: 'agent-hook' })
  })

  test('ignores unrelated settings changes', () => {
    const selector = createAgentPaneStatusesSelector()
    const state = selectorState({
      paneCompletionHighlights: {
        'pane-1': { completedAt: now, source: 'agent-hook', sessionId: 'workspace-1' },
      },
    })

    const first = selector(state)
    const next = selector({
      ...state,
      settings: { ...state.settings, fontSize: state.settings.fontSize + 1 },
    })

    expect(next).toBe(first)
  })

  test('returns a new map when profiles change agent recognition', () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    const selector = createAgentPaneStatusesSelector()
    const state = selectorState({ paneAgentActivity: { 'pane-1': { startedAt: now } } })

    const plain = selector(state)
    const recognized = selector({
      ...state,
      settings: {
        ...state.settings,
        profiles: state.settings.profiles.map((profile) =>
          profile.id === 'powershell' ? { ...profile, name: 'Codex' } : profile),
      },
    })

    expect(plain).toEqual({})
    expect(recognized).not.toBe(plain)
    expect(recognized['pane-1']).toMatchObject({ state: 'working', source: 'terminal-activity' })
  })
})

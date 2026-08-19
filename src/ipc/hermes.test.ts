import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { useWorkspaceStore } from '../state/store'
import type { HermesEvent } from './hermes'

let emitHermesEvent: ((event: HermesEvent) => void) | undefined

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel<T> {
    constructor(callback: (event: T) => void) {
      emitHermesEvent = callback as (event: HermesEvent) => void
    }
  },
  invoke: vi.fn(async () => null),
}))

describe('Hermes ACP startup', () => {
  beforeEach(() => {
    vi.useRealTimers()
    emitHermesEvent = undefined
    vi.mocked(invoke).mockReset()
    useWorkspaceStore.setState({
      hermesStatus: {},
      hermesTranscript: {},
      hermesPermissions: {},
      hermesUsage: {},
      hermesModels: {},
      hermesGenerations: {},
      hermesPendingPrompts: {},
      hermesCurrentSession: {},
      hermesSessions: {},
      error: undefined,
    })
  })

  test('marks ACP starting and waits for the backend started event before resolving', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'agent_chat_start') {
        queueMicrotask(() => emitHermesEvent?.({ generation: 1, kind: 'started', sessionId: 'session-a', acpSessionId: 'acp-a' }))
        return { generation: 1 }
      }
      return null
    })
    const { startHermesAgent } = await import('./hermes')

    await startHermesAgent({ sessionId: 'session-a', workspaceFolder: 'E:/repo', commandOverride: 'hermes-acp', timeoutMs: 100 })

    expect(invoke).toHaveBeenCalledWith('init_agent_chat_output', expect.any(Object))
    expect(invoke).toHaveBeenCalledWith('agent_chat_start', { sessionId: 'session-a', commandOverride: 'hermes-acp', workspaceFolder: 'E:/repo' })
    expect(useWorkspaceStore.getState().hermesStatus['session-a']).toBe('running')
  })

  test('ACP replay restores transcript and session list from backend', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'agent_chat_start') {
        queueMicrotask(() => {
          emitHermesEvent?.({ generation: 1, kind: 'sessionReplay', sessionId: 'session-a', acpSessionId: 'acp-a' })
          emitHermesEvent?.({ generation: 1, kind: 'userMessage', sessionId: 'session-a', text: 'hello' })
          emitHermesEvent?.({ generation: 1, kind: 'started', sessionId: 'session-a', acpSessionId: 'acp-a' })
        })
        return { generation: 1 }
      }
      if (command === 'agent_chat_list_sessions') return [{ id: 'acp-a', title: null, updatedAt: '2026-07-18T00:00:00.000Z', cwd: 'E:/repo' }]
      return null
    })
    const { startHermesAgent } = await import('./hermes')

    await startHermesAgent({ sessionId: 'session-a', timeoutMs: 100 })
    await waitUntil(() => (useWorkspaceStore.getState().hermesTranscript['session-a'] ?? []).length === 1)

    expect(useWorkspaceStore.getState().hermesCurrentSession['session-a']).toBe('acp-a')
    expect(useWorkspaceStore.getState().hermesTranscript['session-a']).toEqual([{ role: 'user', text: 'hello', thoughts: '', toolCalls: [] }])
    expect(useWorkspaceStore.getState().hermesSessions['session-a']).toHaveLength(1)
  })

  test('explicit resume replaces transcript from replay events', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'agent_chat_resume_session') {
        emitHermesEvent?.({ generation: 1, kind: 'sessionReplay', sessionId: 'session-a', acpSessionId: 'acp-b' })
        emitHermesEvent?.({ generation: 1, kind: 'userMessage', sessionId: 'session-a', text: 'restored prompt' })
        emitHermesEvent?.({ generation: 1, kind: 'message', sessionId: 'session-a', text: 'restored answer' })
      }
      return null
    })
    useWorkspaceStore.setState({
      hermesStatus: { 'session-a': 'running' },
      hermesTranscript: { 'session-a': [{ role: 'user', text: 'old', thoughts: '', toolCalls: [] }] },
      hermesGenerations: { 'session-a': 1 },
    })
    const { hermesResumeSession, startHermesOutputStream } = await import('./hermes')
    await startHermesOutputStream({ force: true })

    await hermesResumeSession({ sessionId: 'session-a', timeoutMs: 100 }, 'acp-b')

    expect(invoke).toHaveBeenCalledWith('agent_chat_resume_session', { sessionId: 'session-a', generation: 1, acpSessionId: 'acp-b' })
    expect(useWorkspaceStore.getState().hermesCurrentSession['session-a']).toBe('acp-b')
    expect(useWorkspaceStore.getState().hermesTranscript['session-a']).toEqual([
      { role: 'user', text: 'restored prompt', thoughts: '', toolCalls: [] },
      { role: 'assistant', text: 'restored answer', thoughts: '', toolCalls: [], parts: [{ kind: 'message', text: 'restored answer' }] },
    ])
  })

  test('successful new session clears prior transcript, permissions, and usage', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'agent_chat_new_session') return 'acp-new'
      if (command === 'agent_chat_list_sessions') return [{ id: 'acp-new', title: 'New', updatedAt: null, cwd: 'E:/repo' }]
      return null
    })
    useWorkspaceStore.setState({
      hermesStatus: { 'session-a': 'running' },
      hermesTranscript: { 'session-a': [{ role: 'user', text: 'old', thoughts: '', toolCalls: [] }] },
      hermesPermissions: { 'session-a': [{ requestId: 7, generation: 1, title: 'Old permission', toolKind: 'edit', options: [] }] },
      hermesUsage: { 'session-a': { size: 100, used: 90 } },
      hermesGenerations: { 'session-a': 1 },
    })
    const { hermesNewSession } = await import('./hermes')

    await expect(hermesNewSession({ sessionId: 'session-a' })).resolves.toBe('acp-new')

    const state = useWorkspaceStore.getState()
    expect(state.hermesCurrentSession['session-a']).toBe('acp-new')
    expect(state.hermesTranscript['session-a']).toBeUndefined()
    expect(state.hermesPermissions['session-a']).toBeUndefined()
    expect(state.hermesUsage['session-a']).toBeUndefined()
  })

  test('dedupes concurrent session-list refreshes for one workspace', async () => {
    let releaseList: (() => void) | undefined
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'agent_chat_list_sessions') await new Promise<void>((resolve) => { releaseList = resolve })
      return []
    })
    useWorkspaceStore.setState({ hermesGenerations: { 'session-a': 1 } })
    const { hermesRefreshSessions } = await import('./hermes')

    const first = hermesRefreshSessions('session-a')
    const second = hermesRefreshSessions('session-a')
    await waitUntil(() => Boolean(releaseList))
    releaseList?.()
    await Promise.all([first, second])

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'agent_chat_list_sessions')).toHaveLength(1)
  })

  test('dedupes concurrent startup requests for one workspace', async () => {
    let releaseStart: (() => void) | undefined
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'agent_chat_start') {
        await new Promise<void>((resolve) => { releaseStart = resolve })
        queueMicrotask(() => emitHermesEvent?.({ generation: 1, kind: 'started', sessionId: 'session-a', acpSessionId: 'acp-a' }))
        return { generation: 1 }
      }
    })
    const { startHermesAgent } = await import('./hermes')

    const first = startHermesAgent({ sessionId: 'session-a', timeoutMs: 100 })
    const second = startHermesAgent({ sessionId: 'session-a', timeoutMs: 100 })
    await waitUntil(() => Boolean(releaseStart))
    releaseStart?.()
    await Promise.all([first, second])

    const startCalls = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'agent_chat_start')
    expect(startCalls).toHaveLength(1)
  })

  test('setup-required errors stay in the agent panel instead of the global banner', async () => {
    const { startHermesOutputStream } = await import('./hermes')
    await startHermesOutputStream({ force: true })

    emitHermesEvent?.({
      generation: 1,
      kind: 'error',
      sessionId: 'session-a',
      message: 'Hermes request session/new failed: {"code":-32603,"data":{"details":"No LLM provider configured. Run `hermes model` to select a provider, or run `hermes setup` for first-time configuration."},"message":"Internal error"}',
    })

    expect(useWorkspaceStore.getState().hermesStatus['session-a']).toBe('error')
    expect(useWorkspaceStore.getState().hermesTranscript['session-a']?.at(-1)?.text).toContain('No LLM provider configured')
    expect(useWorkspaceStore.getState().error).toBeUndefined()
  })

  test('unexpected errors still raise the global banner', async () => {
    const { startHermesOutputStream } = await import('./hermes')
    await startHermesOutputStream({ force: true })

    emitHermesEvent?.({ generation: 1, kind: 'error', sessionId: 'session-a', message: 'Hermes stdout stopped: broken pipe' })

    expect(useWorkspaceStore.getState().hermesStatus['session-a']).toBe('error')
    expect(useWorkspaceStore.getState().error).toBe('Hermes: Hermes stdout stopped: broken pipe')
  })

  test('stops and retries a stuck ACP startup once', async () => {
    let startAttempts = 0
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'agent_chat_start') {
        startAttempts += 1
        const generation = startAttempts
        if (startAttempts === 2) {
          queueMicrotask(() => emitHermesEvent?.({ generation, kind: 'started', sessionId: 'session-a', acpSessionId: 'acp-b' }))
        }
        return { generation }
      }
    })
    const { startHermesAgent } = await import('./hermes')

    await startHermesAgent({ sessionId: 'session-a', timeoutMs: 1 })

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'agent_chat_start')).toHaveLength(2)
    expect(invoke).toHaveBeenCalledWith('agent_chat_stop', { sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().hermesStatus['session-a']).toBe('running')
  })

  test('releases a failed prompt and acknowledges exactly one retry', async () => {
    let sendAttempts = 0
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'agent_chat_send') {
        sendAttempts += 1
        if (sendAttempts === 1) throw new Error('write failed')
      }
      return null
    })
    useWorkspaceStore.setState({ hermesGenerations: { 'session-a': 3 } })
    useWorkspaceStore.getState().enqueueHermesPrompt('session-a', 'retry me')
    const first = useWorkspaceStore.getState().claimHermesPrompt('session-a')!
    const { dispatchHermesPrompt } = await import('./hermes')

    await expect(dispatchHermesPrompt('session-a', first)).rejects.toThrow('write failed')
    expect(useWorkspaceStore.getState().hermesPendingPrompts['session-a']).toEqual([
      { ...first, status: 'queued' },
    ])

    const retry = useWorkspaceStore.getState().claimHermesPrompt('session-a')!
    expect(retry.id).toBe(first.id)
    await dispatchHermesPrompt('session-a', retry)

    expect(useWorkspaceStore.getState().hermesPendingPrompts['session-a']).toEqual([])
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'agent_chat_send')).toEqual([
      ['agent_chat_send', { sessionId: 'session-a', generation: 3, text: 'retry me' }],
      ['agent_chat_send', { sessionId: 'session-a', generation: 3, text: 'retry me' }],
    ])
  })

  test('ignores delayed events from a replaced Hermes generation', async () => {
    const { startHermesOutputStream } = await import('./hermes')
    await startHermesOutputStream({ force: true })
    useWorkspaceStore.setState({
      hermesGenerations: { 'session-a': 2 },
      hermesStatus: { 'session-a': 'running' },
    })

    emitHermesEvent?.({ generation: 1, kind: 'error', sessionId: 'session-a', message: 'old failure' })
    emitHermesEvent?.({ generation: 1, kind: 'exited', sessionId: 'session-a' })

    expect(useWorkspaceStore.getState().hermesStatus['session-a']).toBe('running')
    expect(useWorkspaceStore.getState().error).toBeUndefined()
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  }
}

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
      hermesCurrentSession: {},
      hermesSessions: {},
      error: undefined,
    })
  })

  test('marks ACP starting and waits for the backend started event before resolving', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'hermes_start') {
        queueMicrotask(() => emitHermesEvent?.({ kind: 'started', sessionId: 'session-a', acpSessionId: 'acp-a' }))
      }
      return null
    })
    const { startHermesAgent } = await import('./hermes')

    await startHermesAgent({ sessionId: 'session-a', workspaceFolder: 'E:/repo', commandOverride: 'hermes-acp', timeoutMs: 100 })

    expect(invoke).toHaveBeenCalledWith('init_hermes_output', expect.any(Object))
    expect(invoke).toHaveBeenCalledWith('hermes_start', { sessionId: 'session-a', commandOverride: 'hermes-acp', workspaceFolder: 'E:/repo' })
    expect(useWorkspaceStore.getState().hermesStatus['session-a']).toBe('running')
  })

  test('started event restores transcript and session list from backend', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'hermes_start') {
        queueMicrotask(() => emitHermesEvent?.({ kind: 'started', sessionId: 'session-a', acpSessionId: 'acp-a' }))
      }
      if (command === 'hermes_session_transcript') return [{ role: 'user', text: 'hello', thoughts: '' }]
      if (command === 'hermes_list_sessions') return [{ id: 'acp-a', title: null, source: 'discord', model: null, startedAt: 1, endedAt: null, messageCount: 1, archived: false }]
      return null
    })
    const { startHermesAgent } = await import('./hermes')

    await startHermesAgent({ sessionId: 'session-a', timeoutMs: 100 })
    await waitUntil(() => (useWorkspaceStore.getState().hermesTranscript['session-a'] ?? []).length === 1)

    expect(useWorkspaceStore.getState().hermesCurrentSession['session-a']).toBe('acp-a')
    expect(useWorkspaceStore.getState().hermesTranscript['session-a']).toEqual([{ role: 'user', text: 'hello', thoughts: '', toolCalls: [] }])
    expect(useWorkspaceStore.getState().hermesSessions['session-a']).toHaveLength(1)
  })

  test('explicit resume replaces transcript for the selected ACP session', async () => {
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'hermes_resume_session') return null
      if (command === 'hermes_session_transcript') return [{ role: 'assistant', text: 'restored', thoughts: 'reasoning' }]
      return null
    })
    useWorkspaceStore.setState({
      hermesStatus: { 'session-a': 'running' },
      hermesTranscript: { 'session-a': [{ role: 'user', text: 'old', thoughts: '', toolCalls: [] }] },
    })
    const { hermesResumeSession } = await import('./hermes')

    await hermesResumeSession({ sessionId: 'session-a', timeoutMs: 100 }, 'acp-b')

    expect(invoke).toHaveBeenCalledWith('hermes_resume_session', { sessionId: 'session-a', acpSessionId: 'acp-b' })
    expect(useWorkspaceStore.getState().hermesCurrentSession['session-a']).toBe('acp-b')
    expect(useWorkspaceStore.getState().hermesTranscript['session-a']).toEqual([{ role: 'assistant', text: 'restored', thoughts: 'reasoning', toolCalls: [] }])
  })

  test('dedupes concurrent startup requests for one workspace', async () => {
    let releaseStart: (() => void) | undefined
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'hermes_start') {
        await new Promise<void>((resolve) => { releaseStart = resolve })
        queueMicrotask(() => emitHermesEvent?.({ kind: 'started', sessionId: 'session-a', acpSessionId: 'acp-a' }))
      }
      return null
    })
    const { startHermesAgent } = await import('./hermes')

    const first = startHermesAgent({ sessionId: 'session-a', timeoutMs: 100 })
    const second = startHermesAgent({ sessionId: 'session-a', timeoutMs: 100 })
    await waitUntil(() => Boolean(releaseStart))
    releaseStart?.()
    await Promise.all([first, second])

    const startCalls = vi.mocked(invoke).mock.calls.filter(([command]) => command === 'hermes_start')
    expect(startCalls).toHaveLength(1)
  })

  test('stops and retries a stuck ACP startup once', async () => {
    let startAttempts = 0
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'hermes_start') {
        startAttempts += 1
        if (startAttempts === 2) {
          queueMicrotask(() => emitHermesEvent?.({ kind: 'started', sessionId: 'session-a', acpSessionId: 'acp-b' }))
        }
      }
      return null
    })
    const { startHermesAgent } = await import('./hermes')

    await startHermesAgent({ sessionId: 'session-a', timeoutMs: 1 })

    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === 'hermes_start')).toHaveLength(2)
    expect(invoke).toHaveBeenCalledWith('hermes_stop', { sessionId: 'session-a' })
    expect(useWorkspaceStore.getState().hermesStatus['session-a']).toBe('running')
  })
})

async function waitUntil(predicate: () => boolean): Promise<void> {
  while (!predicate()) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0))
  }
}

import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { sendAgentPromptToPane } from './panes'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('../terminal/agentActivity', () => ({ noteAgentPromptSubmitted: vi.fn() }))

describe('sendAgentPromptToPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('submits Enter only after the prompt write resolves', async () => {
    const promptWrite = Promise.withResolvers<unknown>()
    vi.mocked(invoke)
      .mockImplementationOnce(() => promptWrite.promise)
      .mockResolvedValueOnce(null)

    const sending = sendAgentPromptToPane('session-a', 'pane-a', 'prompt')

    expect(invoke).toHaveBeenCalledTimes(1)
    expect(invoke).toHaveBeenNthCalledWith(1, 'write_pane', {
      sessionId: 'session-a',
      paneId: 'pane-a',
      data: 'prompt',
    })

    promptWrite.resolve(null)
    await vi.advanceTimersByTimeAsync(0)

    expect(invoke).toHaveBeenNthCalledWith(2, 'write_pane', {
      sessionId: 'session-a',
      paneId: 'pane-a',
      data: '\r',
    })
    await sending
  })
})

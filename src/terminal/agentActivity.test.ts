import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AgentActivityTracker } from './agentActivity'

const encoder = new TextEncoder()

describe('AgentActivityTracker', () => {
  let tracker: AgentActivityTracker
  let completed: string[]
  let started: string[]
  let userActivity: string[]

  beforeEach(() => {
    vi.useFakeTimers()
    completed = []
    started = []
    userActivity = []
    tracker = new AgentActivityTracker()
    tracker.setActions({
      isAgentPane: (paneId) => paneId === 'agent-pane',
      onResponseStart: (paneId) => { started.push(paneId) },
      onResponseComplete: (paneId) => { completed.push(paneId) },
      onUserActivity: (paneId) => { userActivity.push(paneId) },
      quietMs: 20,
    })
  })

  afterEach(() => {
    tracker.clearAll()
    vi.useRealTimers()
  })

  test('fires onResponseStart when a prompt is submitted', () => {
    tracker.notePromptSubmitted('agent-pane')
    expect(started).toEqual(['agent-pane'])

    tracker.noteUserInput('agent-pane', 'follow-up\r')
    expect(started).toEqual(['agent-pane', 'agent-pane'])
  })

  test('fires onUserActivity when an agent pane receives user input', () => {
    tracker.noteUserInput('agent-pane', 'hello')
    tracker.noteUserInput('shell-pane', 'hello')

    expect(userActivity).toEqual(['agent-pane'])
  })

  test('does not complete just because the TUI status line repaints after submit', () => {
    tracker.notePromptSubmitted('agent-pane')
    tracker.noteOutput('agent-pane', encoder.encode('hi there\r\nGPT-5.5 CPA · high · 9.5%/272K ❯ '))

    expect(completed).toEqual([])

    vi.advanceTimersByTime(19)
    expect(completed).toEqual([])
  })

  test('completes after output goes quiet following a submitted prompt', () => {
    tracker.notePromptSubmitted('agent-pane')
    tracker.noteOutput('agent-pane', encoder.encode('Final answer from the agent.'))

    vi.advanceTimersByTime(19)
    expect(completed).toEqual([])

    vi.advanceTimersByTime(1)
    expect(completed).toEqual(['agent-pane'])
  })

  test('spinner repaints keep deferring completion until the agent stops', () => {
    tracker.notePromptSubmitted('agent-pane')
    tracker.noteOutput('agent-pane', encoder.encode('Working on the task…'))

    for (let tick = 0; tick < 5; tick += 1) {
      vi.advanceTimersByTime(15)
      tracker.noteOutput('agent-pane', encoder.encode('\u001b[2K⠋ Working… (esc)'))
    }
    expect(completed).toEqual([])

    vi.advanceTimersByTime(20)
    expect(completed).toEqual(['agent-pane'])
  })

  test('completes immediately when the agent rings the terminal bell after content', () => {
    tracker.notePromptSubmitted('agent-pane')
    tracker.noteOutput('agent-pane', encoder.encode('Final answer from the agent.'))
    tracker.noteOutput('agent-pane', encoder.encode('\u0007'))

    expect(completed).toEqual(['agent-pane'])

    vi.advanceTimersByTime(40)
    expect(completed).toEqual(['agent-pane'])
  })

  test('an OSC terminator bell does not count as a completion bell', () => {
    tracker.notePromptSubmitted('agent-pane')
    tracker.noteOutput('agent-pane', encoder.encode('Answer.\u001b]0;title\u0007'))

    expect(completed).toEqual([])
    vi.advanceTimersByTime(20)
    expect(completed).toEqual(['agent-pane'])
  })

  test('an OSC terminator bell split across chunks does not count as a completion bell', () => {
    tracker.notePromptSubmitted('agent-pane')
    tracker.noteOutput('agent-pane', encoder.encode('Answer.\u001b]0;tit'))
    tracker.noteOutput('agent-pane', encoder.encode('le\u0007more output'))

    expect(completed).toEqual([])
    vi.advanceTimersByTime(20)
    expect(completed).toEqual(['agent-pane'])
  })

  test('no-BEL chunks defer quiet completion and preserve split OSC state', () => {
    tracker.notePromptSubmitted('agent-pane')
    tracker.noteOutput('agent-pane', encoder.encode('Answer.'))

    vi.advanceTimersByTime(19)
    expect(completed).toEqual([])

    tracker.noteOutput('agent-pane', encoder.encode('\u001b]0;title update'))
    vi.advanceTimersByTime(19)
    expect(completed).toEqual([])

    tracker.noteOutput('agent-pane', encoder.encode(' done\u0007'))
    expect(completed).toEqual([])

    vi.advanceTimersByTime(20)
    expect(completed).toEqual(['agent-pane'])
  })

  test('a bell without response content does not complete', () => {
    tracker.notePromptSubmitted('agent-pane')
    tracker.noteOutput('agent-pane', encoder.encode('\u0007'))

    expect(completed).toEqual([])
  })

  test('does not complete startup welcome and tip output without a submitted prompt', () => {
    tracker.noteOutput('agent-pane', encoder.encode([
      '\u001b[36mWelcome to OMP\u001b[0m',
      'Tip: ask OMP to run bash, edit files, or apply a patch when you are ready.',
      '\u001b[33m✻ Thinking about workspace context…\u001b[0m',
      'OMP > ',
    ].join('\r\n')))

    vi.advanceTimersByTime(40)
    expect(completed).toEqual([])
  })

  test('typed Enter with a non-empty draft starts a pending response', () => {
    tracker.noteUserInput('agent-pane', 'hello\r')
    tracker.noteOutput('agent-pane', encoder.encode('Final answer'))

    vi.advanceTimersByTime(19)
    expect(completed).toEqual([])

    vi.advanceTimersByTime(1)
    expect(completed).toEqual(['agent-pane'])
  })

  test('newlines inside a bracketed paste do not count as a submit', () => {
    tracker.noteUserInput('agent-pane', '\u001b[200~line one\rline two\rline three\u001b[201~')
    tracker.noteOutput('agent-pane', encoder.encode('composer repaint'))

    vi.advanceTimersByTime(40)
    expect(completed).toEqual([])

    tracker.noteUserInput('agent-pane', '\r')
    tracker.noteOutput('agent-pane', encoder.encode('Final answer'))
    vi.advanceTimersByTime(20)
    expect(completed).toEqual(['agent-pane'])
  })

  test('ignores non-agent panes', () => {
    tracker.noteUserInput('shell-pane', 'hello\r')
    tracker.noteOutput('shell-pane', encoder.encode('Final answer'))
    vi.advanceTimersByTime(20)

    expect(completed).toEqual([])
  })
})

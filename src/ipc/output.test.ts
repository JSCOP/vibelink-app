import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PaneMeta, SessionMeta } from './types'
import { resetWorkspaceSessionOwnershipForTests, useWorkspaceStore } from '../state/store'
import { agentActivityTracker } from '../terminal/agentActivity'
import { onTerminalExited, startTerminalOutputStream } from './output'
import { TerminalManager } from '../terminal/TerminalManager'

type TestTerminalEvent =
  | { kind: 'exited'; paneId: string; exitCode?: number | null }
  | { kind: 'sessionChanged'; sessionId: string }
  | {
      kind: 'task'
      sessionId: string
      signal:
        | { kind: 'paneCompleted'; paneId: string; agent?: string | null }
        | { kind: 'done'; taskId: string; paneId?: string | null }
    }
let emitTerminalEvent: ((event: TestTerminalEvent) => void) | undefined

vi.mock('@tauri-apps/api/core', () => ({
  Channel: class MockChannel<T> {
    constructor(callback: (event: T) => void) {
      emitTerminalEvent = callback as typeof emitTerminalEvent
    }
  },
  invoke: vi.fn(async () => null),
}))

vi.mock('../terminal/TerminalManager', () => ({
  TerminalManager: {
    adoptRemoteResize: vi.fn(),
    markExited: vi.fn(),
    reattachToDaemon: vi.fn(),
    write: vi.fn(),
    writeSequenced: vi.fn(),
  },
}))

const session: SessionMeta = {
  id: 'session-a',
  name: 'Workspace A',
  paneCount: 1,
  createdAt: 1,
  workspaceFolder: 'E:/repo',
}

const pane: PaneMeta = {
  id: 'pane-a',
  alive: true,
  config: {
    paneId: 'pane-a',
    shell: 'pwsh.exe',
    args: ['-NoLogo'],
    cwd: 'E:/repo',
    env: [['TERM_PROGRAM', 'VibeLink']],
    title: 'PowerShell',
    cols: 120,
    rows: 32,
  },
}

class MockWebSocket {
  static instances: MockWebSocket[] = []

  binaryType: BinaryType = 'blob'
  onclose: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  close(): void {
    this.onclose?.()
  }
}

const localStorageStub = {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
}

function terminalFrame(paneId: string, paneGeneration: bigint, outputSequence: bigint, text: string): ArrayBuffer {
  const paneBytes = new TextEncoder().encode(paneId)
  const body = new TextEncoder().encode(text)
  const frame = new Uint8Array(2 + paneBytes.byteLength + 16 + body.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint16(0, paneBytes.byteLength, false)
  frame.set(paneBytes, 2)
  view.setBigUint64(2 + paneBytes.byteLength, paneGeneration, false)
  view.setBigUint64(10 + paneBytes.byteLength, outputSequence, false)
  frame.set(body, 18 + paneBytes.byteLength)
  return frame.buffer
}

describe('terminal session change reloads', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetWorkspaceSessionOwnershipForTests()
    emitTerminalEvent = undefined
    MockWebSocket.instances = []
    vi.stubGlobal('window', {
      localStorage: localStorageStub,
      setTimeout: globalThis.setTimeout.bind(globalThis),
      clearTimeout: globalThis.clearTimeout.bind(globalThis),
    })
    vi.stubGlobal('WebSocket', MockWebSocket)
    vi.mocked(invoke).mockReset()
    vi.mocked(invoke).mockImplementation(async (command: string) => {
      if (command === 'attach_session') return { layoutJson: null, panes: [pane] }
      if (command === 'list_sessions') return [session]
      if (command === 'worktree_registry_list') return []
      if (command === 'attention_snapshot') return { capturedAt: 0, panes: [] }
      if (command === 'terminal_ws_port') return 42800
      return null
    })
    useWorkspaceStore.setState({
      workspaceEpoch: 0,
      workspaceReadyEpoch: 0,
      sessions: [session],
      activeSessionId: undefined,
      activePaneId: undefined,
      panes: {},
      layoutJson: null,
      license: { ready: false, status: null },
      paneCompletionHighlights: {},
      completionHistory: [],
      paneReviewMarkers: {},
      error: undefined,
      status: 'ready',
    })
  })

  afterEach(() => {
    agentActivityTracker.clearAll()
    agentActivityTracker.setActions({
      isAgentPane: () => false,
      onResponseStart: () => {},
      onResponseComplete: () => {},
    })
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })
  test('refreshes the active snapshot without resetting workspace ownership', async () => {
    await useWorkspaceStore.getState().attachSession(session.id)
    useWorkspaceStore.setState({ activePaneId: pane.id })
    const before = useWorkspaceStore.getState()
    vi.mocked(invoke).mockClear()

    await startTerminalOutputStream({ force: true })
    emitTerminalEvent?.({ kind: 'sessionChanged', sessionId: session.id })

    await vi.advanceTimersByTimeAsync(100)
    await Promise.resolve()
    expect(invoke).toHaveBeenCalledWith('attach_session', { sessionId: session.id })

    const after = useWorkspaceStore.getState()
    expect(after.workspaceEpoch).toBe(before.workspaceEpoch)
    expect(after.workspaceReadyEpoch).toBe(before.workspaceReadyEpoch)
    expect(after.panes).toBe(before.panes)
    expect(after.activePaneId).toBe(pane.id)
  })
  test('records eight agent-hook completions for an inactive workspace', async () => {
    const activeSession: SessionMeta = {
      ...session,
      id: 'session-b',
      name: 'Workspace B',
      workspaceFolder: 'E:/other-repo',
    }
    useWorkspaceStore.setState({
      sessions: [session, activeSession],
      activeSessionId: activeSession.id,
      panes: {},
      paneCompletionHighlights: {},
      completionHistory: [],
    })

    await startTerminalOutputStream({ force: true })
    for (let index = 1; index <= 8; index += 1) {
      emitTerminalEvent?.({
        kind: 'task',
        sessionId: session.id,
        signal: { kind: 'paneCompleted', paneId: `pane-a-${index}`, agent: 'omp' },
      })
    }

    const highlights = Object.values(useWorkspaceStore.getState().paneCompletionHighlights)
    expect(highlights).toHaveLength(8)
    expect(highlights).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'agent-hook', sessionId: session.id }),
    ]))
    expect(useWorkspaceStore.getState().completionHistory).toHaveLength(8)
    expect(useWorkspaceStore.getState().completionHistory[0]).toMatchObject({ agent: 'omp', sessionId: session.id, read: false })
  })
  test('does not create a completion alert for task done', async () => {
    await startTerminalOutputStream({ force: true })

    emitTerminalEvent?.({
      kind: 'task',
      sessionId: session.id,
      signal: { kind: 'done', taskId: 'task-1', paneId: pane.id },
    })

    expect(useWorkspaceStore.getState().paneCompletionHighlights).toEqual({})
    expect(useWorkspaceStore.getState().completionHistory).toEqual([])
  })
  test('cancels the pending terminal fallback after an authoritative agent hook', async () => {
    const fallbackCompletions: string[] = []
    agentActivityTracker.setActions({
      isAgentPane: () => true,
      onResponseStart: () => {},
      onResponseComplete: (paneId) => { fallbackCompletions.push(paneId) },
      quietMs: 20,
    })
    agentActivityTracker.notePromptSubmitted(pane.id)
    agentActivityTracker.noteOutput(pane.id, new TextEncoder().encode('Final answer'))

    await startTerminalOutputStream({ force: true })
    emitTerminalEvent?.({
      kind: 'task',
      sessionId: session.id,
      signal: { kind: 'paneCompleted', paneId: pane.id, agent: 'omp' },
    })
    await vi.advanceTimersByTimeAsync(20)

    expect(fallbackCompletions).toEqual([])
  })
  test('passes pane generation and output sequence from websocket frames', async () => {
    await startTerminalOutputStream({ force: true })
    const socket = MockWebSocket.instances.at(-1)
    if (!socket?.onmessage) throw new Error('terminal websocket was not initialized')

    socket.onmessage({ data: terminalFrame(pane.id, 7n, 42n, 'live output') } as MessageEvent)

    expect(TerminalManager.writeSequenced).toHaveBeenCalledWith(
      pane.id,
      7n,
      42n,
      expect.any(Uint8Array),
    )
    const bytes = vi.mocked(TerminalManager.writeSequenced).mock.calls.at(-1)?.[3]
    expect(bytes ? new TextDecoder().decode(bytes) : '').toBe('live output')
  })
  test('notifies scoped listeners when a pane exits', async () => {
    const listener = vi.fn()
    const unsubscribe = onTerminalExited(listener)
    await startTerminalOutputStream({ force: true })

    emitTerminalEvent?.({ kind: 'exited', paneId: 'login-pane', exitCode: 0 })
    expect(listener).toHaveBeenCalledWith('login-pane')

    unsubscribe()
    emitTerminalEvent?.({ kind: 'exited', paneId: 'other-pane', exitCode: 0 })
    expect(listener).toHaveBeenCalledTimes(1)
  })

})

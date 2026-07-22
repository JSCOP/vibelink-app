import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { PaneMeta, SessionMeta } from './types'
import { resetWorkspaceSessionOwnershipForTests, useWorkspaceStore } from '../state/store'
import { startTerminalOutputStream } from './output'

let emitTerminalEvent: ((event: { kind: 'sessionChanged'; sessionId: string }) => void) | undefined

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
  binaryType: BinaryType = 'blob'
  onclose: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null

  readonly url: string

  constructor(url: string) {
    this.url = url
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

describe('terminal session change reloads', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetWorkspaceSessionOwnershipForTests()
    emitTerminalEvent = undefined
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
      paneReviewMarkers: {},
      error: undefined,
      status: 'ready',
    })
  })

  afterEach(() => {
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
})

// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// Async factories must load the cycle-free mock module lazily because vi.mock is hoisted per test file.
vi.mock('@tauri-apps/api/event', async () => (await import('./terminalTestMocks')).tauriEventModule())
vi.mock('@tauri-apps/api/core', async () => (await import('./terminalTestMocks')).tauriCoreModule())
vi.mock('@xterm/xterm', async () => (await import('./terminalTestMocks')).xtermModule())
vi.mock('./scrollbar', async () => (await import('./terminalTestMocks')).scrollbarModule())
vi.mock('@xterm/addon-webgl', async () => (await import('./terminalTestMocks')).webglAddonModule())
vi.mock('@xterm/addon-clipboard', async () => (await import('./terminalTestMocks')).clipboardAddonModule())
vi.mock('@xterm/addon-search', async () => (await import('./terminalTestMocks')).searchAddonModule())
vi.mock('@xterm/addon-unicode11', async () => (await import('./terminalTestMocks')).unicode11AddonModule())
vi.mock('@xterm/addon-serialize', async () => (await import('./terminalTestMocks')).serializeAddonModule())
import {
  TerminalManager,
  emitTerminalData,
  emitTerminalTitle,
  invokeMock,
  makeContainer,
  paneWriteData,
} from './terminalTestHarness'

describe('TerminalManager clipboard keyboard routing', () => {
  it('lets WebView handle Ctrl+V instead of forwarding ^V to the PTY', () => {
    const paneId = 'pane-clipboard-paste'
    const entry = TerminalManager.getOrCreate(paneId) as unknown as {
      term: { customKeyEventHandler?: (event: KeyboardEvent) => boolean }
    }

    expect(entry.term.customKeyEventHandler?.(new KeyboardEvent('keydown', { key: 'v', ctrlKey: true }))).toBe(false)
    expect(entry.term.customKeyEventHandler?.(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true }))).toBe(true)
  })
})

describe('TerminalManager pre-session input buffering', () => {
  it('holds emulator input while the pane has no session and flushes it on the session-bound attach', async () => {
    const paneId = 'pane-presession-flush'
    const container = makeContainer()

    // Panel-first spawn: the panel mounts and attaches before spawn_pane resolves.
    TerminalManager.attach(paneId, container, {})

    // ConPTY's startup DSR triggers xterm's CPR auto-reply before any session exists.
    emitTerminalData(paneId, '\x1b[O')
    emitTerminalData(paneId, '\x1b[1;1R')
    expect(invokeMock).not.toHaveBeenCalledWith('write_pane', expect.anything())

    // spawn_pane resolved; the store update re-renders the panel with a session.
    TerminalManager.attach(paneId, container, { sessionId: 'session-1' })
    await TerminalManager.waitForReplay('session-1', [paneId])
    // Chunks queued before attach flush as one coalesced write.
    await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === 'write_pane')).toEqual([
      ['write_pane', { sessionId: 'session-1', paneId, data: '\x1b[O\x1b[1;1R' }],
    ]))
    expect(invokeMock).toHaveBeenCalledWith('subscribe_pane', { sessionId: 'session-1', paneId })

    // The buffer must not replay on later input.
    emitTerminalData(paneId, 'x')
    const writesAfter = invokeMock.mock.calls.filter(([command]) => command === 'write_pane')
    expect(writesAfter).toHaveLength(2)
    expect(writesAfter[1]).toEqual(['write_pane', { sessionId: 'session-1', paneId, data: 'x' }])

    TerminalManager.dispose(paneId)
  })

  it('sends input after the pane attach is acknowledged', async () => {
    const paneId = 'pane-live-input'
    const container = makeContainer()

    TerminalManager.attach(paneId, container, { sessionId: 'session-2' })
    emitTerminalData(paneId, 'ls\r')
    await TerminalManager.waitForReplay('session-2', [paneId])

    expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-2', paneId, data: 'ls\r' })

    TerminalManager.dispose(paneId)
  })

  it('flushes held input when the daemon reattaches the pane', async () => {
    const paneId = 'pane-reattach-flush'
    const container = makeContainer()

    TerminalManager.attach(paneId, container, {})
    emitTerminalData(paneId, '\x1b[1;1R')
    expect(invokeMock).not.toHaveBeenCalledWith('write_pane', expect.anything())

    TerminalManager.reattachToDaemon('session-3', [paneId])
    await TerminalManager.waitForReplay('session-3', [paneId])

    expect(invokeMock).toHaveBeenCalledWith('subscribe_pane', { sessionId: 'session-3', paneId })
    expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-3', paneId, data: '\x1b[1;1R' })

    TerminalManager.dispose(paneId)
  })

  it('keeps queued input after attach failure and flushes it once after retry', async () => {
    const paneId = 'pane-attach-retry'
    const container = makeContainer()
    let attachAttempts = 0
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'attach_pane' && attachAttempts++ === 0) throw new Error('attach failed')
      return undefined
    })

    TerminalManager.attach(paneId, container, {})
    emitTerminalData(paneId, 'queued')
    TerminalManager.attach(paneId, container, { sessionId: 'session-retry' })
    await vi.waitFor(() => expect(attachAttempts).toBe(1))
    expect(invokeMock.mock.calls.filter(([command]) => command === 'write_pane')).toHaveLength(0)

    TerminalManager.reattachToDaemon('session-retry', [paneId])
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-retry', paneId, data: 'queued' }))
    expect(invokeMock.mock.calls.filter(([command]) => command === 'write_pane')).toHaveLength(1)
    TerminalManager.dispose(paneId)
  })

  it('retains a failed write chunk and preserves order across reattach', async () => {
    const paneId = 'pane-write-retry'
    const container = makeContainer()
    let writeAttempts = 0
    invokeMock.mockImplementation(async (command: string) => {
      if (command === 'write_pane' && writeAttempts++ === 0) throw new Error('write failed')
      return undefined
    })

    TerminalManager.attach(paneId, container, {})
    emitTerminalData(paneId, 'first')
    emitTerminalData(paneId, 'second')
    TerminalManager.attach(paneId, container, { sessionId: 'session-write-retry' })
    await vi.waitFor(() => expect(writeAttempts).toBe(1))

    TerminalManager.reattachToDaemon('session-write-retry', [paneId])
    await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === 'write_pane')).toHaveLength(2))
    const payloads = invokeMock.mock.calls
      .filter(([command]) => command === 'write_pane')
      .map(paneWriteData)
    // The failed coalesced batch is retained whole and re-sent in order.
    expect(payloads).toEqual(['firstsecond', 'firstsecond'])
    TerminalManager.dispose(paneId)
  })

  it('ignores stale attach completion and flushes only through the current generation', async () => {
    const paneId = 'pane-stale-attach'
    const container = makeContainer()
    const resolvers: Array<() => void> = []
    invokeMock.mockImplementation((command: string) => {
      if (command !== 'attach_pane') return Promise.resolve(undefined)
      return new Promise<void>((resolve) => resolvers.push(resolve))
    })

    TerminalManager.attach(paneId, container, {})
    emitTerminalData(paneId, 'retained')
    TerminalManager.attach(paneId, container, { sessionId: 'session-old' })
    TerminalManager.reattachToDaemon('session-new', [paneId])
    expect(resolvers).toHaveLength(2)

    resolvers[0]()
    await Promise.resolve()
    expect(invokeMock.mock.calls.filter(([command]) => command === 'write_pane')).toHaveLength(0)
    resolvers[1]()
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-new', paneId, data: 'retained' }))
    TerminalManager.dispose(paneId)
  })

  it('bounds pre-session input by chunks and writes one merged overflow notice', () => {
    const paneId = 'pane-input-bound'
    const container = makeContainer()
    TerminalManager.attach(paneId, container, {})
    for (let index = 0; index < 300; index += 1) emitTerminalData(paneId, 'x')
    const manager = TerminalManager as unknown as {
      entries: Map<string, { pendingInput?: unknown[]; pendingInputBytes?: number; inputTrimNoticeWritten?: boolean }>
    }
    const entry = manager.entries.get(paneId)
    expect(entry?.pendingInput).toHaveLength(256)
    expect(entry?.pendingInputBytes).toBe(256)
    expect(entry?.inputTrimNoticeWritten).toBe(true)
    TerminalManager.dispose(paneId)
  })
})

describe('TerminalManager animated title coalescing', () => {
  it('collapses an agent spinner storm into a single title update', () => {
    vi.useFakeTimers()
    const paneId = 'pane-spinner-title'
    const container = makeContainer()
    const titles: string[] = []
    try {
      TerminalManager.attach(paneId, container, { sessionId: 'session-title', onTitleChange: (title) => titles.push(title) })

      // An animated agent title over ~8s of spinner frames. Before coalescing
      // each frame became one blocking set_pane_title on the socket that also
      // carries every keystroke.
      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
      for (let i = 0; i < 100; i += 1) {
        emitTerminalTitle(paneId, `π ${frames[i % frames.length]} Orca Logic Analysis`)
        vi.advanceTimersByTime(80)
      }

      expect(titles).toEqual(['π ⠋ Orca Logic Analysis'])
    } finally {
      TerminalManager.dispose(paneId)
      vi.useRealTimers()
    }
  })

  it('still delivers a genuinely new title, settling on the final one', () => {
    vi.useFakeTimers()
    const paneId = 'pane-real-title'
    const container = makeContainer()
    const titles: string[] = []
    try {
      TerminalManager.attach(paneId, container, { sessionId: 'session-title', onTitleChange: (title) => titles.push(title) })

      emitTerminalTitle(paneId, 'π ⠋ Build')
      expect(titles).toEqual(['π ⠋ Build'])

      emitTerminalTitle(paneId, 'π ⠙ Deploy')
      vi.advanceTimersByTime(500)

      expect(titles[titles.length - 1]).toBe('π ⠙ Deploy')
    } finally {
      TerminalManager.dispose(paneId)
      vi.useRealTimers()
    }
  })
})

describe('TerminalManager recent output capture', () => {
  it('returns only the requested tail lines', () => {
    const paneId = 'pane-recent-output'
    const manager = TerminalManager as unknown as { entries: Map<string, unknown> }
    const lines = ['one', 'two', 'three', 'four']
    manager.entries.set(paneId, {
      term: {
        buffer: {
          active: {
            length: lines.length,
            getLine: (index: number) => ({ translateToString: () => lines[index] }),
          },
        },
      },
    })

    expect(TerminalManager.getRecentOutput(paneId, 3)).toBe('two\nthree\nfour')
    manager.entries.delete(paneId)
  })
})


// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => {
  const invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve()
  return vi.fn(invoke)
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    element: HTMLElement | undefined
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    modes = { mouseTrackingMode: 'none' }
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0 } }
    dataHandler: ((data: string) => void) | undefined
    resizeHandler: ((size: { cols: number; rows: number }) => void) | undefined
    loadAddon(addon: { activate?: (terminal: MockTerminal) => void }): void { addon.activate?.(this) }
    attachCustomKeyEventHandler(): void {}
    attachCustomWheelEventHandler(): void {}
    registerLinkProvider(): { dispose(): void } {
      return { dispose() {} }
    }
    onData(handler: (data: string) => void): { dispose(): void } {
      this.dataHandler = handler
      return { dispose() {} }
    }
    onResize(handler: (size: { cols: number; rows: number }) => void): { dispose(): void } {
      this.resizeHandler = handler
      return { dispose() {} }
    }
    onTitleChange(): { dispose(): void } {
      return { dispose() {} }
    }
    open(container: HTMLElement): void {
      this.element = document.createElement('div')
      container.appendChild(this.element)
    }
    focus(): void {}
    refresh(): void {}
    scrollToBottom(): void {}
    write(): void {}
    hasSelection(): boolean { return false }

    resize(cols: number, rows: number): void {
      this.cols = cols
      this.rows = rows
      this.resizeHandler?.({ cols, rows })
    }
    dispose(): void {}
  }
  return { Terminal: MockTerminal }
})

vi.mock('@xterm/addon-fit', () => {
  class MockFitAddon {
    private terminal: { resize(cols: number, rows: number): void } | undefined
    activate(terminal: { resize(cols: number, rows: number): void }): void { this.terminal = terminal }
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
    fit(): void { this.terminal?.resize(80, 24) }
  }
  return { FitAddon: MockFitAddon }
})

vi.mock('@xterm/addon-webgl', () => {
  class MockWebglAddon {
    constructor() {
      throw new Error('webgl unavailable in tests')
    }
  }
  return { WebglAddon: MockWebglAddon }
})

vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))

import { TerminalManager } from './TerminalManager'

type TerminalWithDataHandler = {
  dataHandler: ((data: string) => void) | undefined
}

function emitTerminalData(paneId: string, data: string): void {
  const manager = TerminalManager as unknown as { entries: Map<string, { term: TerminalWithDataHandler }> }
  const entry = manager.entries.get(paneId)
  if (!entry?.term.dataHandler) throw new Error(`no data handler wired for pane ${paneId}`)
  entry.term.dataHandler(data)
}

function paneWriteData(call: unknown[]): string | undefined {
  const args = call[1]
  if (!args || typeof args !== 'object' || !('data' in args) || typeof args.data !== 'string') return undefined
  return args.data
}

function makeContainer(): HTMLElement {
  const el = document.createElement('div')
  document.body.appendChild(el)
  return el
}

beforeEach(() => {
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
})

class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', StubResizeObserver)

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
    await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === 'write_pane')).toHaveLength(2))

    const writes = invokeMock.mock.calls.filter(([command]) => command === 'write_pane')
    expect(writes).toEqual([
      ['write_pane', { sessionId: 'session-1', paneId, data: '\x1b[O' }],
      ['write_pane', { sessionId: 'session-1', paneId, data: '\x1b[1;1R' }],
    ])
    expect(invokeMock).toHaveBeenCalledWith('attach_pane', { sessionId: 'session-1', paneId })

    // The buffer must not replay on later input.
    emitTerminalData(paneId, 'x')
    const writesAfter = invokeMock.mock.calls.filter(([command]) => command === 'write_pane')
    expect(writesAfter).toHaveLength(3)
    expect(writesAfter[2]).toEqual(['write_pane', { sessionId: 'session-1', paneId, data: 'x' }])

    TerminalManager.dispose(paneId)
  })

  it('sends input after the pane attach is acknowledged', async () => {
    const paneId = 'pane-live-input'
    const container = makeContainer()

    TerminalManager.attach(paneId, container, { sessionId: 'session-2' })
    emitTerminalData(paneId, 'ls\r')
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-2', paneId, data: 'ls\r' }))

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
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-3', paneId, data: '\x1b[1;1R' }))

    expect(invokeMock).toHaveBeenCalledWith('attach_pane', { sessionId: 'session-3', paneId })
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
    await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === 'write_pane')).toHaveLength(3))
    const payloads = invokeMock.mock.calls
      .filter(([command]) => command === 'write_pane')
      .map(paneWriteData)
    expect(payloads).toEqual(['first', 'first', 'second'])
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

describe('TerminalManager remote pane leases', () => {
  it('restores an unleased daemon resize to desktop fit geometry and syncs the PTY back', async () => {
    const paneId = 'pane-unleased-resize'
    const container = makeContainer()
    TerminalManager.attach(paneId, container, { sessionId: 'session-wide' })
    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { cols: number; rows: number; resize(cols: number, rows: number): void } }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing remote resize entry')
    entry.term.resize(160, 48)
    invokeMock.mockClear()

    TerminalManager.adoptRemoteResize(paneId, 160, 48)
    await vi.waitFor(() => expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 80, rows: 24 }))
    expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([
      ['resize_pane', { sessionId: 'session-wide', paneId, cols: 80, rows: 24 }],
    ])
    TerminalManager.dispose(paneId)
  })

  it('keeps leased remote geometry without fitting or syncing it back', async () => {
    const paneId = 'pane-leased-resize'
    invokeMock.mockImplementation(async (command) => command === 'remote_get_pane_lease'
      ? { sessionId: 'session-mobile', paneId, cols: 48, rows: 27 }
      : undefined)
    const container = makeContainer()
    TerminalManager.attach(paneId, container, { sessionId: 'session-mobile' })
    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { cols: number; rows: number } }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing leased resize entry')
    invokeMock.mockClear()

    TerminalManager.adoptRemoteResize(paneId, 48, 27)
    await vi.waitFor(() => expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 48, rows: 27 }))
    expect(invokeMock.mock.calls.some(([command]) => command === 'resize_pane')).toBe(false)
    TerminalManager.dispose(paneId)
  })
})

describe('TerminalManager pointer repair', () => {
  it('nudges and restores an alternate-buffer PTY once per click gesture', () => {
    vi.useFakeTimers()
    const paneId = 'pane-pointer-repair'
    const container = makeContainer()
    TerminalManager.attach(paneId, container, { sessionId: 'session-repair' })
    const manager = TerminalManager as unknown as { entries: Map<string, { term: { buffer: { active: { type: string } } } }> }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing pointer repair entry')
    entry.term.buffer.active.type = 'alternate'
    invokeMock.mockClear()

    TerminalManager.repairAfterPointerActivation(paneId)
    TerminalManager.repairAfterPointerActivation(paneId)

    expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([
      ['resize_pane', { sessionId: 'session-repair', paneId, cols: 80, rows: 23 }],
    ])

    vi.advanceTimersByTime(64)
    expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([
      ['resize_pane', { sessionId: 'session-repair', paneId, cols: 80, rows: 23 }],
      ['resize_pane', { sessionId: 'session-repair', paneId, cols: 80, rows: 24 }],
    ])

    TerminalManager.dispose(paneId)
    vi.useRealTimers()
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

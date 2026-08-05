// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const invokeMock = vi.hoisted(() => {
  const invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve()
  return vi.fn(invoke)
})

const eventMock = vi.hoisted(() => {
  const state: { systemResumed?: () => void } = {}
  return {
    state,
    listen: vi.fn(async (event: string, handler: () => void) => {
      if (event === 'system-resumed') state.systemResumed = handler
      return () => { if (state.systemResumed === handler) state.systemResumed = undefined }
    }),
  }
})

const webglMock = vi.hoisted(() => {
  type Instance = {
    clearAtlasCalls: number
    disposeCalls: number
    lostContextCalls: number
    canvas: { width: number; height: number }
    triggerContextLoss(): void
  }
  return { fail: true, instances: [] as Instance[] }
})

vi.mock('@tauri-apps/api/event', () => ({ listen: eventMock.listen }))

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

vi.mock('@xterm/xterm', () => {
  class MockTerminal {
    options: Record<string, unknown> = {}
    element: HTMLElement | undefined
    cols = 80
    rows = 24
    unicode = { activeVersion: '' }
    modes = { mouseTrackingMode: 'none' }
    buffer = { active: { type: 'normal', viewportY: 0, baseY: 0, length: 0, cursorX: 0, cursorY: 0 } }
    dataHandler: ((data: string) => void) | undefined
    customKeyEventHandler: ((event: KeyboardEvent) => boolean) | undefined
    resizeHandler: ((size: { cols: number; rows: number }) => void) | undefined
    focusCalls = 0
    writes: unknown[] = []
    resetCalls = 0
    refreshCalls: Array<[number, number]> = []
    renderRowsCalls: Array<[number, number, boolean | undefined]> = []
    _core = {
      _renderService: {
        _isPaused: false,
        _needsFullRefresh: false,
        refreshRows: (start: number, end: number, sync?: boolean) => { this.renderRowsCalls.push([start, end, sync]) },
      },
    }
    loadAddon(addon: { activate?: (terminal: MockTerminal) => void }): void { addon.activate?.(this) }
    attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean): void { this.customKeyEventHandler = handler }
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
    titleHandler: ((title: string) => void) | undefined
    onTitleChange(handler: (title: string) => void): { dispose(): void } {
      this.titleHandler = handler
      return { dispose: () => { this.titleHandler = undefined } }
    }
    open(container: HTMLElement): void {
      this.element = document.createElement('div')
      this.element.className = 'xterm'
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      this.element.appendChild(screen)
      container.appendChild(this.element)
    }
    focus(): void { this.focusCalls += 1 }
    refresh(start: number, end: number): void { this.refreshCalls.push([start, end]) }
    scrollToBottom(): void {}
    write(data: unknown, callback?: () => void): void { this.writes.push(data); callback?.() }
    reset(): void { this.resetCalls += 1; this.writes = [] }
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

vi.mock('./scrollbar', () => {
  class PaneFitAddon {
    private terminal: { resize(cols: number, rows: number): void } | undefined
    activate(terminal: { resize(cols: number, rows: number): void }): void { this.terminal = terminal }
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
    fit(): void { this.terminal?.resize(80, 24) }
  }
  return { PaneFitAddon, showPaneScrollbar: () => true }
})

vi.mock('@xterm/addon-webgl', () => {
  class MockWebglAddon {
    clearAtlasCalls = 0
    disposeCalls = 0
    lostContextCalls = 0
    canvas = { width: 640, height: 480 }
    private contextLossHandler: (() => void) | undefined
    _renderer = {
      _canvas: this.canvas,
      _gl: {
        getExtension: (name: string) => name === 'WEBGL_lose_context'
          ? { loseContext: () => { this.lostContextCalls += 1 } }
          : null,
      },
    }

    constructor() {
      if (webglMock.fail) throw new Error('webgl unavailable in tests')
      webglMock.instances.push(this)
    }

    onContextLoss(handler: () => void): { dispose(): void } {
      this.contextLossHandler = handler
      return { dispose: () => { this.contextLossHandler = undefined } }
    }

    clearTextureAtlas(): void { this.clearAtlasCalls += 1 }
    dispose(): void { this.disposeCalls += 1 }
    triggerContextLoss(): void { this.contextLossHandler?.() }
  }
  return { WebglAddon: MockWebglAddon }
})

vi.mock('@xterm/addon-clipboard', () => ({ ClipboardAddon: class {} }))
vi.mock('@xterm/addon-search', () => ({ SearchAddon: class {} }))
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: class {} }))

import { TerminalManager } from './TerminalManager'
import { useRemotePaneLeaseStore } from '../remote/paneLease'

type TerminalWithDataHandler = {
  dataHandler: ((data: string) => void) | undefined
}

function emitTerminalData(paneId: string, data: string): void {
  const manager = TerminalManager as unknown as { entries: Map<string, { term: TerminalWithDataHandler }> }
  const entry = manager.entries.get(paneId)
  if (!entry?.term.dataHandler) throw new Error(`no data handler wired for pane ${paneId}`)
  entry.term.dataHandler(data)
}

function emitTerminalTitle(paneId: string, title: string): void {
  const manager = TerminalManager as unknown as { entries: Map<string, { term: { titleHandler?: (title: string) => void } }> }
  const entry = manager.entries.get(paneId)
  if (!entry?.term.titleHandler) throw new Error(`no title handler wired for pane ${paneId}`)
  entry.term.titleHandler(title)
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

const resizeObservers = new Set<StubResizeObserver>()

class StubResizeObserver {
  private target: Element | undefined
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    resizeObservers.add(this)
  }

  observe(target: Element): void { this.target = target }
  unobserve(target: Element): void { if (this.target === target) this.target = undefined }
  disconnect(): void { this.target = undefined }

  emit(target: Element, width: number, height: number): void {
    if (this.target !== target) return
    this.callback([{ target, contentRect: { width, height } } as ResizeObserverEntry], this as unknown as ResizeObserver)
  }
}

function emitResize(target: Element, width: number, height: number): void {
  for (const observer of resizeObservers) observer.emit(target, width, height)
}

beforeEach(() => {
  resizeObservers.clear()
  webglMock.fail = true
  webglMock.instances.length = 0
  Reflect.set(TerminalManager, 'webviewRenderMode', '')
  invokeMock.mockReset()
  invokeMock.mockImplementation((command, args) => {
    if (command === 'subscribe_pane') {
      return Promise.resolve(terminalSnapshot(
        String(args?.paneId),
        0n,
        '',
        String(args?.sessionId),
        1n,
      ))
    }
    return Promise.resolve()
  })
  useRemotePaneLeaseStore.setState({ leases: {} })
})

vi.stubGlobal('ResizeObserver', StubResizeObserver)

function terminalSnapshot(
  paneId: string,
  outputSequence: bigint,
  text: string,
  sessionId = 'session-replay',
  paneGeneration = 9n,
) {
  return {
    sessionId,
    paneId,
    paneGeneration: paneGeneration.toString(),
    outputSequence: outputSequence.toString(),
    cols: 80,
    rows: 24,
    alive: true,
    dataBase64: btoa(text),
  }
}


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
    await vi.waitFor(() => expect(invokeMock.mock.calls.filter(([command]) => command === 'write_pane')).toEqual([
      ['write_pane', { sessionId: 'session-1', paneId, data: '\x1b[O' }],
      ['write_pane', { sessionId: 'session-1', paneId, data: '\x1b[1;1R' }],
    ]))
    expect(invokeMock).toHaveBeenCalledWith('subscribe_pane', { sessionId: 'session-1', paneId })

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

describe('TerminalManager atomic snapshot replay', () => {
  it('hydrates the atomic snapshot before live frames that arrive while subscribing', async () => {
    const paneId = 'pane-atomic-replay'
    const container = makeContainer()
    const snapshotResult = Promise.withResolvers<unknown>()
    invokeMock.mockImplementation((command) => {
      if (command === 'subscribe_pane') return snapshotResult.promise
      return Promise.resolve()
    })

    TerminalManager.attach(paneId, container, { sessionId: 'session-replay' })
    TerminalManager.writeSequenced(paneId, 9n, 3n, new TextEncoder().encode('live'))
    snapshotResult.resolve(terminalSnapshot(paneId, 2n, 'snapshot'))
    await TerminalManager.waitForReplay('session-replay', [paneId])

    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { writes: Uint8Array[]; resetCalls: number } }>
    }
    const entry = manager.entries.get(paneId)
    expect(invokeMock).toHaveBeenCalledWith('subscribe_pane', { sessionId: 'session-replay', paneId })
    expect(entry?.term.resetCalls).toBe(1)
    expect(entry?.term.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['snapshot', 'live'])
    TerminalManager.dispose(paneId)
  })

  it('answers a cold-snapshot cursor query when the emulator emits no CPR', async () => {
    const paneId = 'pane-cold-dsr'
    invokeMock.mockImplementation((command) => command === 'subscribe_pane'
      ? Promise.resolve(terminalSnapshot(paneId, 1n, '\x1b[?9001h\x1b[?1004h\x1b[6n', 'session-cold-dsr'))
      : Promise.resolve())

    TerminalManager.attach(paneId, makeContainer(), { sessionId: 'session-cold-dsr' })
    await TerminalManager.waitForReplay('session-cold-dsr', [paneId])

    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('write_pane', {
      sessionId: 'session-cold-dsr',
      paneId,
      data: '\x1b[1;1R',
    }))
    TerminalManager.dispose(paneId)
  })

  it('resubscribes and replaces the pane when a live output sequence has a gap', async () => {
    const paneId = 'pane-gap-replay'
    const container = makeContainer()
    const snapshots = [terminalSnapshot(paneId, 1n, 'initial'), terminalSnapshot(paneId, 3n, 'healed')]
    invokeMock.mockImplementation((command) => {
      if (command === 'subscribe_pane') return Promise.resolve(snapshots.shift())
      return Promise.resolve()
    })

    TerminalManager.attach(paneId, container, { sessionId: 'session-replay' })
    await TerminalManager.waitForReplay('session-replay', [paneId])
    TerminalManager.writeSequenced(paneId, 9n, 3n, new TextEncoder().encode('gap frame'))
    await TerminalManager.waitForReplay('session-replay', [paneId])

    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { writes: Uint8Array[]; resetCalls: number } }>
    }
    const entry = manager.entries.get(paneId)
    expect(invokeMock.mock.calls.filter(([command]) => command === 'subscribe_pane')).toHaveLength(2)
    expect(entry?.term.resetCalls).toBe(2)
    expect(entry?.term.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['healed'])
    TerminalManager.dispose(paneId)
  })

  it('keeps a retained terminal buffer when a workspace reattach snapshot is unchanged', async () => {
    const paneId = 'pane-retained-replay'
    const sessionId = 'session-retained-replay'
    const firstContainer = makeContainer()
    const secondContainer = makeContainer()
    const snapshots = [
      terminalSnapshot(paneId, 7n, 'retained transcript', sessionId),
      terminalSnapshot(paneId, 7n, 'must not replay', sessionId),
    ]
    invokeMock.mockImplementation((command) => {
      if (command === 'subscribe_pane') return Promise.resolve(snapshots.shift())
      return Promise.resolve()
    })

    TerminalManager.attach(paneId, firstContainer, { sessionId })
    await TerminalManager.waitForReplay(sessionId, [paneId])
    TerminalManager.attach(paneId, secondContainer, { sessionId })
    TerminalManager.reattachToDaemon(sessionId, [paneId], { force: false })
    await TerminalManager.waitForReplay(sessionId, [paneId])

    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { element?: HTMLElement; writes: Uint8Array[]; resetCalls: number } }>
    }
    const entry = manager.entries.get(paneId)
    expect(invokeMock.mock.calls.filter(([command]) => command === 'subscribe_pane')).toHaveLength(2)
    expect(entry?.term.resetCalls).toBe(1)
    expect(entry?.term.writes.map((bytes) => new TextDecoder().decode(bytes))).toEqual(['retained transcript'])
    expect(entry?.term.element?.parentElement).toBe(secondContainer)
    TerminalManager.dispose(paneId)
  })

  it('chunks a large cold snapshot so replay yields between bounded writes', async () => {
    const paneId = 'pane-chunked-replay'
    const sessionId = 'session-chunked-replay'
    const transcript = 'x'.repeat(200 * 1024)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      queueMicrotask(() => callback(performance.now()))
      return 1
    })
    invokeMock.mockImplementation((command) => command === 'subscribe_pane'
      ? Promise.resolve(terminalSnapshot(paneId, 1n, transcript, sessionId))
      : Promise.resolve())

    try {
      TerminalManager.attach(paneId, makeContainer(), { sessionId })
      await TerminalManager.waitForReplay(sessionId, [paneId])

      const manager = TerminalManager as unknown as {
        entries: Map<string, { term: { writes: Uint8Array[] } }>
      }
      const writes = manager.entries.get(paneId)?.term.writes ?? []
      expect(writes.length).toBeGreaterThan(1)
      expect(writes.map((bytes) => new TextDecoder().decode(bytes)).join('')).toBe(transcript)
    } finally {
      TerminalManager.dispose(paneId)
      requestFrame.mockRestore()
    }
  })
})

describe('TerminalManager workspace cache', () => {
  it('prunes stale panes only from the active workspace and retains background terminals', () => {
    TerminalManager.getOrCreate('pane-active-live').sessionId = 'session-active'
    TerminalManager.getOrCreate('pane-active-stale').sessionId = 'session-active'
    TerminalManager.getOrCreate('pane-background').sessionId = 'session-background'

    TerminalManager.pruneWorkspaceCache('session-active', new Set(['pane-active-live']))

    const manager = TerminalManager as unknown as { entries: Map<string, unknown> }
    expect([...manager.entries.keys()]).toEqual(expect.arrayContaining(['pane-active-live', 'pane-background']))
    expect(manager.entries.has('pane-active-stale')).toBe(false)
    TerminalManager.dispose('pane-active-live')
    TerminalManager.dispose('pane-background')
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

describe('TerminalManager remote pane leases', () => {
  it('restores an unleased daemon resize to desktop fit geometry and syncs the PTY back', async () => {
    const paneId = 'pane-unleased-resize'
    const container = makeContainer()
    TerminalManager.attach(paneId, container, { sessionId: 'session-wide' })
    const manager = TerminalManager as unknown as {
      entries: Map<string, {
        term: { cols: number; rows: number; resize(cols: number, rows: number): void }
        lastSentPtyCols?: number
        lastSentPtyRows?: number
      }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing remote resize entry')
    entry.term.resize(160, 48)
    // A remote client authored this geometry, not us: the desktop's own last
    // send stays at its fit size. Driving the mock terminal also runs xterm's
    // onResize, so restore that invariant explicitly — otherwise the pane looks
    // like it asked for 160x48 itself and the echo guard would (correctly) drop
    // the event as its own.
    entry.lastSentPtyCols = 80
    entry.lastSentPtyRows = 24
    invokeMock.mockClear()

    TerminalManager.adoptRemoteResize(paneId, 160, 48)
    await vi.waitFor(() => expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 80, rows: 24 }))
    expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([
      ['resize_pane', { sessionId: 'session-wide', paneId, cols: 80, rows: 24 }],
    ])
    TerminalManager.dispose(paneId)
  })

  it('ignores a daemon resize that only echoes the size this pane just sent', async () => {
    // The daemon broadcasts PaneResized to every attached client including the
    // originator, so a local divider drag is echoed back. Adopting the echo
    // costs a remote_get_pane_lease round trip plus a forced fit and repaint
    // per pane per resize, and it can never carry new information.
    const paneId = 'pane-resize-echo'
    const container = makeContainer()
    TerminalManager.attach(paneId, container, { sessionId: 'session-echo' })
    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { cols: number; rows: number; resize(cols: number, rows: number): void } }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing resize echo entry')
    entry.term.resize(120, 40)
    TerminalManager.syncPtySize(paneId)
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('resize_pane', { sessionId: 'session-echo', paneId, cols: 120, rows: 40 }))
    invokeMock.mockClear()

    TerminalManager.adoptRemoteResize(paneId, 120, 40)

    expect(invokeMock).not.toHaveBeenCalledWith('remote_get_pane_lease', expect.anything())
    expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 120, rows: 40 })
    TerminalManager.dispose(paneId)
  })

  it('suppresses desktop input, focus, fit, and resize while leased, preserves output, then restores desktop control', async () => {
    const paneId = 'pane-leased-control'
    const container = makeContainer()
    TerminalManager.attach(paneId, container, { sessionId: 'session-mobile' })
    await TerminalManager.waitForReplay('session-mobile', [paneId])
    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: {
        cols: number
        rows: number
        focusCalls: number
        writes: unknown[]
        resize(cols: number, rows: number): void
      } }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing leased control entry')
    invokeMock.mockClear()

    TerminalManager.setRemotePaneLease(paneId, {
      sessionId: 'session-mobile',
      paneId,
      deviceId: 'device-mobile',
      cols: 48,
      rows: 27,
      expiresAt: 1_800_000_000_000,
    })
    emitTerminalData(paneId, 'blocked input')
    entry.term.resize(52, 30)
    TerminalManager.focus(paneId)
    TerminalManager.reflow(paneId)
    TerminalManager.syncPtySize(paneId)
    TerminalManager.write(paneId, new TextEncoder().encode('remote output'), { foreground: true })

    expect(invokeMock.mock.calls.some(([command]) => command === 'write_pane' || command === 'resize_pane')).toBe(false)
    expect(entry.term.focusCalls).toBe(0)
    expect(entry.term.writes).toHaveLength(1)

    TerminalManager.setRemotePaneLease(paneId, null)
    TerminalManager.focus(paneId)
    emitTerminalData(paneId, 'restored input')

    expect({ cols: entry.term.cols, rows: entry.term.rows }).toEqual({ cols: 80, rows: 24 })
    expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([
      ['resize_pane', { sessionId: 'session-mobile', paneId, cols: 80, rows: 24 }],
    ])
    await vi.waitFor(() => expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-mobile', paneId, data: 'restored input' }))
    expect(entry.term.focusCalls).toBe(1)
    TerminalManager.dispose(paneId)
  })
})

describe('TerminalManager repaint recovery', () => {
  it('forces a paused render service instead of losing the repaint to xterm refresh', () => {
    const paneId = 'pane-paused-renderer'
    const manager = TerminalManager as unknown as {
      redraw(entry: unknown): void
    }
    const entry = TerminalManager.getOrCreate(paneId) as unknown as {
      opened: boolean
      term: {
        rows: number
        refreshCalls: Array<[number, number]>
        renderRowsCalls: Array<[number, number, boolean | undefined]>
        _core: { _renderService: { _isPaused: boolean; _needsFullRefresh: boolean } }
      }
    }
    entry.opened = true
    entry.term._core._renderService._isPaused = true
    entry.term._core._renderService._needsFullRefresh = true

    manager.redraw(entry)

    expect(entry.term.renderRowsCalls).toEqual([[0, entry.term.rows - 1, true]])
    expect(entry.term.refreshCalls).toEqual([])
    expect(entry.term._core._renderService._isPaused).toBe(false)
    expect(entry.term._core._renderService._needsFullRefresh).toBe(false)
    TerminalManager.dispose(paneId)
  })
})

describe('TerminalManager window-wake recovery', () => {
  it('defers hidden resume events and waits two settled frames before repainting', async () => {
    const paneId = 'pane-system-resume'
    const entry = TerminalManager.getOrCreate(paneId) as unknown as { opened: boolean; visible?: boolean }
    entry.opened = true
    entry.visible = true
    const manager = TerminalManager as unknown as {
      redraw(entry: unknown, options?: { clearWebglTextureAtlas?: boolean }): void
      scheduleLayoutPass(options?: Record<string, unknown>): void
    }
    const redraw = vi.spyOn(manager, 'redraw')
    const layout = vi.spyOn(manager, 'scheduleLayoutPass').mockImplementation(() => {})
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return 500 + frames.length
    })
    const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    const runNextFrame = () => {
      const callback = frames.shift()
      if (!callback) throw new Error('missing settled wake frame')
      callback(performance.now())
    }

    try {
      await vi.waitFor(() => expect(eventMock.state.systemResumed).toBeTypeOf('function'))
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
      eventMock.state.systemResumed?.()
      expect(redraw).not.toHaveBeenCalled()
      expect(layout).not.toHaveBeenCalled()
      expect(frames).toHaveLength(0)

      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
      eventMock.state.systemResumed?.()
      expect(redraw).not.toHaveBeenCalled()
      expect(layout).toHaveBeenCalledWith(expect.objectContaining({
        force: true,
        repaint: true,
        syncPty: true,
        clearWebglTextureAtlas: undefined,
      }))

      runNextFrame()
      expect(redraw).not.toHaveBeenCalled()
      runNextFrame()
      expect(redraw).toHaveBeenCalledOnce()
      expect(redraw).toHaveBeenCalledWith(entry, { clearWebglTextureAtlas: true })
    } finally {
      requestFrame.mockRestore()
      redraw.mockRestore()
      layout.mockRestore()
      if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility)
      TerminalManager.dispose(paneId)
    }
  })

  it('keeps the settled refocus repaint before the later atlas repair', () => {
    const paneId = 'pane-focus-then-resume'
    const entry = TerminalManager.getOrCreate(paneId) as unknown as { opened: boolean; visible?: boolean }
    entry.opened = true
    entry.visible = true
    const manager = TerminalManager as unknown as {
      recoverVisibleWake(clearWebglTextureAtlas: boolean): void
      redraw(entry: unknown, options?: { clearWebglTextureAtlas?: boolean }): void
    }
    const redraw = vi.spyOn(manager, 'redraw')
    const frames: FrameRequestCallback[] = []
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return 600 + frames.length
    })
    const runNextFrame = () => {
      const callback = frames.shift()
      if (!callback) throw new Error('missing wake frame')
      callback(performance.now())
    }

    try {
      manager.recoverVisibleWake(false)
      manager.recoverVisibleWake(true)
      expect(redraw).toHaveBeenCalledOnce()
      expect(redraw).toHaveBeenLastCalledWith(entry, { clearWebglTextureAtlas: false })

      runNextFrame()
      expect(redraw).toHaveBeenCalledTimes(2)
      expect(redraw).toHaveBeenLastCalledWith(entry, { clearWebglTextureAtlas: false })
      runNextFrame()
      expect(redraw).toHaveBeenCalledTimes(2)
      runNextFrame()
      expect(redraw).toHaveBeenCalledTimes(3)
      expect(redraw).toHaveBeenLastCalledWith(entry, { clearWebglTextureAtlas: true })
    } finally {
      requestFrame.mockRestore()
      redraw.mockRestore()
      TerminalManager.dispose(paneId)
    }
  })

  it('requests settled atlas recovery when a minimized viewport becomes viable again', () => {
    vi.useFakeTimers()
    const manager = TerminalManager as unknown as {
      viewportViable: boolean
      windowRestorePending: boolean
      handleWindowResize(): void
      settleLayout(options?: Record<string, unknown>): void
      recoverVisibleWake(clearWebglTextureAtlas: boolean): void
    }
    const originalViewportViable = manager.viewportViable
    const originalWindowRestorePending = manager.windowRestorePending
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
    const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
    const settleLayout = vi.spyOn(manager, 'settleLayout').mockImplementation(() => {})
    const recoverVisibleWake = vi.spyOn(manager, 'recoverVisibleWake').mockImplementation(() => {})

    try {
      manager.viewportViable = false
      manager.windowRestorePending = false
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: 2560 })
      Object.defineProperty(window, 'innerHeight', { configurable: true, value: 1392 })

      manager.handleWindowResize()

      expect(manager.windowRestorePending).toBe(true)
      expect(settleLayout).toHaveBeenCalledWith({ repaint: true })
      expect(recoverVisibleWake).toHaveBeenCalledWith(true)
      vi.advanceTimersByTime(160)
      expect(manager.windowRestorePending).toBe(false)
    } finally {
      vi.runOnlyPendingTimers()
      manager.viewportViable = originalViewportViable
      manager.windowRestorePending = originalWindowRestorePending
      settleLayout.mockRestore()
      recoverVisibleWake.mockRestore()
      if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth)
      if (originalHeight) Object.defineProperty(window, 'innerHeight', originalHeight)
      vi.useRealTimers()
    }
  })
  it('holds queued restore fits until Dockview pane geometry settles', () => {
    type PendingPass = {
      fit: boolean
      syncPty: boolean
      force: boolean
      repaint: boolean
      clearWebglTextureAtlas: boolean
    }
    const manager = TerminalManager as unknown as {
      interactionDepth: number
      lastPassAt?: number
      lastPassDurationMs?: number
      passFrame?: number
      passTimer?: number
      pendingPass: Map<string, PendingPass>
      topologyDepth: number
      viewportViable: boolean
      windowRestorePending: boolean
      requestPassFlush(): void
    }
    const original = {
      interactionDepth: manager.interactionDepth,
      lastPassAt: manager.lastPassAt,
      lastPassDurationMs: manager.lastPassDurationMs,
      passFrame: manager.passFrame,
      passTimer: manager.passTimer,
      pendingPass: manager.pendingPass,
      topologyDepth: manager.topologyDepth,
      viewportViable: manager.viewportViable,
      windowRestorePending: manager.windowRestorePending,
    }
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 701)

    try {
      manager.interactionDepth = 0
      manager.lastPassAt = undefined
      manager.lastPassDurationMs = undefined
      manager.passFrame = undefined
      manager.passTimer = undefined
      manager.pendingPass = new Map([['pane-restore-hold', {
        fit: true,
        syncPty: true,
        force: true,
        repaint: true,
        clearWebglTextureAtlas: false,
      }]])
      manager.topologyDepth = 0
      manager.viewportViable = true
      manager.windowRestorePending = true

      manager.requestPassFlush()
      expect(requestFrame).not.toHaveBeenCalled()

      manager.windowRestorePending = false
      manager.requestPassFlush()
      expect(requestFrame).toHaveBeenCalledOnce()
    } finally {
      manager.interactionDepth = original.interactionDepth
      manager.lastPassAt = original.lastPassAt
      manager.lastPassDurationMs = original.lastPassDurationMs
      manager.passFrame = original.passFrame
      manager.passTimer = original.passTimer
      manager.pendingPass = original.pendingPass
      manager.topologyDepth = original.topologyDepth
      manager.viewportViable = original.viewportViable
      manager.windowRestorePending = original.windowRestorePending
      requestFrame.mockRestore()
    }
  })

})

describe('TerminalManager output scheduling', () => {
  it('keeps focused active-pane echo on the immediate path', () => {
    const paneId = 'pane-foreground-output'
    const shell = document.createElement('div')
    shell.dataset.active = 'true'
    const container = document.createElement('div')
    shell.appendChild(container)
    document.body.appendChild(shell)
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    TerminalManager.attach(paneId, container, { sessionId: 'session-output' })
    TerminalManager.setPaneVisible(paneId, true)
    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { writes: unknown[] } }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing foreground output entry')

    try {
      TerminalManager.write(paneId, new TextEncoder().encode('typed echo'))
      expect(entry.term.writes).toHaveLength(1)
    } finally {
      TerminalManager.dispose(paneId)
      hasFocus.mockRestore()
      shell.remove()
    }
  })

  it('keeps focused terminal echo immediate while the active marker is restoring', () => {
    const paneId = 'pane-focused-output'
    const container = document.createElement('div')
    const textarea = document.createElement('textarea')
    container.appendChild(textarea)
    document.body.appendChild(container)
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    TerminalManager.attach(paneId, container, { sessionId: 'session-output' })
    TerminalManager.setPaneVisible(paneId, true)
    textarea.focus()
    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { writes: unknown[] } }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing focused output entry')

    try {
      TerminalManager.write(paneId, new TextEncoder().encode('typed echo'))
      expect(entry.term.writes).toHaveLength(1)
    } finally {
      TerminalManager.dispose(paneId)
      hasFocus.mockRestore()
      container.remove()
    }
  })

  it('flushes a small coalesced frame immediately when focused echo arrives', () => {
    const paneId = 'pane-coalesced-foreground-output'
    const shell = document.createElement('div')
    shell.dataset.active = 'true'
    const container = document.createElement('div')
    shell.appendChild(container)
    document.body.appendChild(shell)
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    TerminalManager.attach(paneId, container, { sessionId: 'session-output' })
    TerminalManager.setPaneVisible(paneId, true)
    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { writes: unknown[] } }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing coalesced foreground entry')

    try {
      TerminalManager.write(paneId, new TextEncoder().encode('background'), { foreground: false })
      expect(entry.term.writes).toHaveLength(0)

      TerminalManager.write(paneId, new TextEncoder().encode(' echo'), { foreground: true })
      expect(entry.term.writes).toHaveLength(1)
      expect(new TextDecoder().decode(entry.term.writes[0] as Uint8Array)).toBe('background echo')
    } finally {
      TerminalManager.dispose(paneId)
      hasFocus.mockRestore()
      shell.remove()
    }
  })

  it('queues foreground frames while xterm is still parsing the previous write', () => {
    const paneId = 'pane-parser-backpressure'
    const shell = document.createElement('div')
    shell.dataset.active = 'true'
    const container = document.createElement('div')
    shell.appendChild(container)
    document.body.appendChild(shell)
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    TerminalManager.attach(paneId, container, { sessionId: 'session-output' })
    TerminalManager.setPaneVisible(paneId, true)
    const manager = TerminalManager as unknown as {
      entries: Map<string, { term: { writes: unknown[]; write(data: unknown, callback?: () => void): void } }>
      drainOutputQueue(): void
      cancelOutputDrainSchedule(): void
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing parser backpressure entry')
    const callbacks: Array<() => void> = []
    entry.term.write = (data, callback) => {
      entry.term.writes.push(data)
      if (callback) callbacks.push(callback)
    }

    try {
      TerminalManager.write(paneId, new TextEncoder().encode('first frame'))
      TerminalManager.write(paneId, new TextEncoder().encode('second frame'))
      expect(entry.term.writes).toHaveLength(1)

      callbacks.shift()?.()
      manager.drainOutputQueue()
      expect(entry.term.writes).toHaveLength(2)
    } finally {
      TerminalManager.dispose(paneId)
      manager.cancelOutputDrainSchedule()
      hasFocus.mockRestore()
      shell.remove()
    }
  })

  it('drops software WebGL when parser backpressure builds behind a live write', () => {
    const paneId = 'pane-software-parser-backpressure'
    const shell = document.createElement('div')
    shell.dataset.active = 'true'
    const container = document.createElement('div')
    shell.appendChild(container)
    document.body.appendChild(shell)
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    Reflect.set(TerminalManager, 'webviewRenderMode', 'software')
    TerminalManager.attach(paneId, container, { sessionId: 'session-output' })
    TerminalManager.setPaneVisible(paneId, true)
    const manager = TerminalManager as unknown as {
      entries: Map<string, { webgl?: { dispose(): void }; term: { writes: unknown[]; write(data: unknown, callback?: () => void): void } }>
      cancelOutputDrainSchedule(): void
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing software backpressure entry')
    const disposeWebgl = vi.fn()
    const callbacks: Array<() => void> = []
    entry.webgl = { dispose: disposeWebgl }
    entry.term.write = (data, callback) => {
      entry.term.writes.push(data)
      if (callback) callbacks.push(callback)
    }

    try {
      TerminalManager.write(paneId, new Uint8Array(128))
      TerminalManager.write(paneId, new Uint8Array(3 * 1024))
      callbacks.shift()?.()

      expect(disposeWebgl).toHaveBeenCalledOnce()
      expect(entry.webgl).toBeUndefined()
    } finally {
      TerminalManager.dispose(paneId)
      manager.cancelOutputDrainSchedule()
      hasFocus.mockRestore()
      shell.remove()
    }
  })


  it('coalesces inactive TUI redraws before parsing them', () => {
    vi.useFakeTimers()
    const paneId = 'pane-background-output'
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const manager = TerminalManager as unknown as {
      entries: Map<string, { opened: boolean; term: { writes: unknown[] } }>
    }
    const entry = TerminalManager.getOrCreate(paneId) as unknown as { opened: boolean; term: { writes: unknown[] } }
    entry.opened = true

    try {
      TerminalManager.write(paneId, new TextEncoder().encode('obsolete frame'), { foreground: false })
      TerminalManager.write(paneId, new TextEncoder().encode('\x1b[2Jlatest frame'), { foreground: false })
      expect(entry.term.writes).toHaveLength(0)

      vi.advanceTimersByTime(50)
      expect(frames.size).toBe(1)
      const callback = frames.values().next().value
      if (!callback) throw new Error('missing scheduled output frame')
      frames.clear()
      callback(performance.now())

      expect(entry.term.writes).toHaveLength(1)
      expect(new TextDecoder().decode(entry.term.writes[0] as Uint8Array)).toBe('\x1b[2Jlatest frame')
      expect(manager.entries.get(paneId)).toBeDefined()
    } finally {
      TerminalManager.dispose(paneId)
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      vi.useRealTimers()
    }
  })

  it('uses the configured inactive pane update rate', () => {
    vi.useFakeTimers()
    const paneId = 'pane-resume-output'
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const entry = TerminalManager.getOrCreate(paneId) as unknown as {
      opened: boolean
      visible?: boolean
      term: { writes: unknown[] }
    }
    entry.opened = true
    entry.visible = true
    const runNextFrame = () => {
      const callback = frames.values().next().value
      if (!callback) throw new Error('missing scheduled output frame')
      frames.clear()
      callback(performance.now())
    }

    try {
      TerminalManager.write(paneId, new Uint8Array(64 * 1024), { foreground: false })
      vi.advanceTimersByTime(50)
      runNextFrame()

      expect(entry.term.writes).toHaveLength(1)
      expect((entry.term.writes[0] as Uint8Array).byteLength).toBe(16 * 1024)

      vi.advanceTimersByTime(332)
      expect(frames.size).toBe(0)
      vi.advanceTimersByTime(1)
      runNextFrame()
      expect(entry.term.writes).toHaveLength(2)
      expect((entry.term.writes[1] as Uint8Array).byteLength).toBe(16 * 1024)

      TerminalManager.setInactiveTerminalUpdatesPerSecond(10)
      vi.advanceTimersByTime(99)
      expect(frames.size).toBe(0)
      vi.advanceTimersByTime(1)
      runNextFrame()
      expect(entry.term.writes).toHaveLength(3)
    } finally {
      TerminalManager.dispose(paneId)
      TerminalManager.setInactiveTerminalUpdatesPerSecond(3)
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      vi.useRealTimers()
    }
  })

  it('parks hidden snapshot-backed output and restores the latest frame on reveal', async () => {
    vi.useFakeTimers()
    const paneId = 'pane-hidden-output'
    const container = makeContainer()
    let snapshotSequence = 0n
    let snapshotText = 'initial frame'
    invokeMock.mockImplementation((command, args) => command === 'subscribe_pane'
      ? Promise.resolve(terminalSnapshot(
        String(args?.paneId),
        snapshotSequence,
        snapshotText,
        String(args?.sessionId),
      ))
      : Promise.resolve())
    TerminalManager.attach(paneId, container, { sessionId: 'session-hidden-output' })
    await TerminalManager.waitForReplay('session-hidden-output', [paneId])
    TerminalManager.setPaneVisible(paneId, false)
    const manager = TerminalManager as unknown as {
      entries: Map<string, {
        outputParked?: boolean
        outputSnapshotStale?: boolean
        term: { writes: unknown[]; resetCalls: number }
      }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing hidden output entry')
    entry.term.writes = []

    try {
      vi.advanceTimersByTime(30_000)
      expect(entry.outputParked).toBe(true)

      TerminalManager.writeSequenced(paneId, 9n, 1n, new TextEncoder().encode('discarded frame'))
      TerminalManager.writeSequenced(paneId, 9n, 2n, new TextEncoder().encode('newest frame'))
      expect(entry.term.writes).toHaveLength(0)
      expect(entry.outputSnapshotStale).toBe(true)

      snapshotSequence = 2n
      snapshotText = 'latest snapshot'
      TerminalManager.setPaneVisible(paneId, true)
      await TerminalManager.waitForReplay('session-hidden-output', [paneId])

      expect(entry.outputParked).toBe(false)
      expect(entry.outputSnapshotStale).toBe(false)
      expect(entry.term.resetCalls).toBeGreaterThan(1)
      const lastWrite = entry.term.writes.at(-1) as Uint8Array
      expect(new TextDecoder().decode(lastWrite)).toBe('latest snapshot')
      expect(invokeMock.mock.calls.filter(([command]) => command === 'subscribe_pane')).toHaveLength(2)
    } finally {
      TerminalManager.dispose(paneId)
      container.remove()
      vi.useRealTimers()
    }
  })

  it('drops software WebGL before parsing a high-volume resume burst', () => {
    vi.useFakeTimers()
    const paneId = 'pane-resume-webgl'
    Reflect.set(TerminalManager, 'webviewRenderMode', 'software')
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const disposeWebgl = vi.fn()
    const entry = TerminalManager.getOrCreate(paneId) as unknown as {
      opened: boolean
      webgl?: { dispose(): void }
    }
    entry.opened = true
    entry.webgl = { dispose: disposeWebgl }

    try {
      TerminalManager.write(paneId, new Uint8Array(64 * 1024), { foreground: false })
      vi.advanceTimersByTime(50)
      const callback = frames.values().next().value
      if (!callback) throw new Error('missing scheduled output frame')
      frames.clear()
      callback(performance.now())

      expect(disposeWebgl).toHaveBeenCalledOnce()
      expect(entry.webgl).toBeUndefined()
    } finally {
      TerminalManager.dispose(paneId)
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      vi.useRealTimers()
    }
  })

  it('keeps WebGL attached for the same burst on a hardware-rendered WebView', () => {
    vi.useFakeTimers()
    const paneId = 'pane-resume-hardware-webgl'
    const frames = new Map<number, FrameRequestCallback>()
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.set(1, callback)
      return 1
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frames.clear() })
    const disposeWebgl = vi.fn()
    const entry = TerminalManager.getOrCreate(paneId) as unknown as { opened: boolean; webgl?: { dispose(): void } }
    entry.opened = true
    entry.webgl = { dispose: disposeWebgl }
    Reflect.set(TerminalManager, 'webviewRenderMode', 'hardware')

    try {
      TerminalManager.write(paneId, new Uint8Array(64 * 1024), { foreground: false })
      vi.advanceTimersByTime(50)
      frames.get(1)?.(performance.now())
      expect(disposeWebgl).not.toHaveBeenCalled()
      expect(entry.webgl).toBeDefined()
    } finally {
      TerminalManager.dispose(paneId)
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      vi.useRealTimers()
    }
  })

  it('re-promotes a software-burst pane after the backlog drains and stays quiet', () => {
    vi.useFakeTimers()
    const paneId = 'pane-resume-repromote'
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    const container = makeContainer()
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600 } as DOMRect)
    const entry = TerminalManager.getOrCreate(paneId) as unknown as {
      opened: boolean
      visible?: boolean
      container?: HTMLElement
      webgl?: { dispose(): void }
      term: { refreshCalls: Array<[number, number]> }
    }
    entry.opened = true
    entry.container = container
    entry.visible = true
    entry.webgl = { dispose: vi.fn() }
    Reflect.set(TerminalManager, 'webviewRenderMode', 'software')

    const runNextFrame = () => {
      const callback = frames.values().next().value
      if (!callback) throw new Error('missing scheduled output frame')
      frames.delete(frames.keys().next().value as number)
      callback(performance.now())
    }

    try {
      TerminalManager.write(paneId, new Uint8Array(64 * 1024), { foreground: false })
      vi.advanceTimersByTime(50)
      runNextFrame()
      for (let index = 0; index < 3; index += 1) {
        vi.advanceTimersByTime(333)
        runNextFrame()
      }
      webglMock.fail = false
      expect(entry.webgl).toBeUndefined()

      vi.advanceTimersByTime(1_999)
      expect(entry.webgl).toBeUndefined()
      vi.advanceTimersByTime(1)
      expect(webglMock.instances).toHaveLength(1)
      expect(entry.webgl).toBe(webglMock.instances[0])
      expect(entry.term.refreshCalls.at(-1)).toEqual([0, 23])
    } finally {
      TerminalManager.dispose(paneId)
      container.remove()
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      vi.useRealTimers()
    }
  })

  it('stops re-attaching WebGL once a pane keeps flapping between renderers', () => {
    vi.useFakeTimers()
    const paneId = 'pane-webgl-flap'
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame++
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id) })
    const container = makeContainer()
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600 } as DOMRect)
    const entry = TerminalManager.getOrCreate(paneId) as unknown as {
      opened: boolean
      visible?: boolean
      container?: HTMLElement
      webgl?: { dispose(): void }
      webglSwapsLatched?: boolean
    }
    entry.opened = true
    entry.container = container
    entry.visible = true
    entry.webgl = { dispose: vi.fn() }
    Reflect.set(TerminalManager, 'webviewRenderMode', 'software')

    const runNextFrame = () => {
      const callback = frames.values().next().value
      if (!callback) throw new Error('missing scheduled output frame')
      frames.delete(frames.keys().next().value as number)
      callback(performance.now())
    }
    const burst = () => {
      TerminalManager.write(paneId, new Uint8Array(64 * 1024), { foreground: false })
      vi.advanceTimersByTime(50)
      runNextFrame()
      for (let index = 0; index < 3; index += 1) {
        vi.advanceTimersByTime(333)
        runNextFrame()
      }
    }

    try {
      webglMock.fail = false
      burst()
      expect(entry.webgl).toBeUndefined()
      vi.advanceTimersByTime(2_000)
      expect(entry.webgl).toBe(webglMock.instances[0])

      burst()
      expect(entry.webgl).toBeUndefined()
      expect(entry.webglSwapsLatched).toBe(true)

      vi.advanceTimersByTime(10_000)
      expect(webglMock.instances).toHaveLength(1)
      expect(entry.webgl).toBeUndefined()
    } finally {
      TerminalManager.dispose(paneId)
      container.remove()
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      vi.useRealTimers()
    }
  })

  it('holds a lost WebGL context on the DOM renderer instead of re-attaching on a timer', () => {
    vi.useFakeTimers()
    const paneId = 'pane-webgl-context-latched'
    const container = makeContainer()
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600 } as DOMRect)
    webglMock.fail = false
    TerminalManager.attach(paneId, container)
    TerminalManager.setPaneVisible(paneId, true)
    const manager = TerminalManager as unknown as {
      entries: Map<string, { webgl?: unknown; webglAttachFailed?: boolean; webglContextLost?: boolean; demotedForOutputBurst?: boolean }>
    }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing WebGL recovery entry')
    const firstRenderer = webglMock.instances[0]
    if (!firstRenderer) throw new Error('missing initial WebGL renderer')

    try {
      firstRenderer.triggerContextLoss()
      expect(entry.webgl).toBeUndefined()
      expect(entry.webglAttachFailed).toBe(true)
      expect(entry.webglContextLost).toBe(true)
      // A lost context must never look like an output-burst demotion: that is
      // the path whose quiet timer re-attaches and evicts a sibling pane.
      expect(entry.demotedForOutputBurst).toBe(false)

      vi.advanceTimersByTime(10_000)
      expect(webglMock.instances).toHaveLength(1)
      expect(entry.webgl).toBeUndefined()
    } finally {
      TerminalManager.dispose(paneId)
      container.remove()
      vi.useRealTimers()
    }
  })

  it('re-attaches a lost WebGL context at a wake boundary once the pane is stable', () => {
    vi.useFakeTimers()
    const paneId = 'pane-webgl-wake-retry'
    const container = makeContainer()
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600 } as DOMRect)
    webglMock.fail = false
    TerminalManager.attach(paneId, container)
    TerminalManager.setPaneVisible(paneId, true)
    const manager = TerminalManager as unknown as { entries: Map<string, { webgl?: unknown }> }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing wake-retry entry')
    const firstRenderer = webglMock.instances[0]
    if (!firstRenderer) throw new Error('missing initial WebGL renderer')

    try {
      firstRenderer.triggerContextLoss()
      vi.advanceTimersByTime(29_000)
      window.dispatchEvent(new Event('focus'))
      expect(entry.webgl).toBeUndefined()

      vi.advanceTimersByTime(2_000)
      window.dispatchEvent(new Event('focus'))
      expect(webglMock.instances).toHaveLength(2)
      expect(entry.webgl).toBe(webglMock.instances[1])
    } finally {
      TerminalManager.dispose(paneId)
      container.remove()
      vi.useRealTimers()
    }
  })

  it('keeps a hidden pane on WebGL and reclaims the least recently used context under the cap', () => {
    webglMock.fail = false
    const containers: HTMLElement[] = []
    const paneIds = Array.from({ length: 12 }, (_, index) => `pane-webgl-lru-${index}`)
    const arriving = 'pane-webgl-lru-arriving'
    const open = (paneId: string) => {
      const container = makeContainer()
      vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600 } as DOMRect)
      containers.push(container)
      TerminalManager.attach(paneId, container)
      TerminalManager.setPaneVisible(paneId, true)
    }

    try {
      for (const paneId of paneIds) open(paneId)
      const manager = TerminalManager as unknown as {
        entries: Map<string, { webgl?: unknown; webglReleasedWhileHidden?: boolean }>
      }
      const zoomedOut = manager.entries.get(paneIds[0])
      if (!zoomedOut) throw new Error('missing hidden-release entry')
      const renderer = zoomedOut.webgl

      // An Alt+Z zoom hides every sibling for a moment. Rebuilding their
      // contexts on the way back is what made the toggle expensive.
      TerminalManager.setPaneVisible(paneIds[0], false)
      expect(zoomedOut.webgl).toBe(renderer)
      expect(webglMock.instances).toHaveLength(12)

      // A pane the user can actually see wins the last slot instead.
      open(arriving)
      expect(zoomedOut.webgl).toBeUndefined()
      expect(zoomedOut.webglReleasedWhileHidden).toBe(true)
      expect(manager.entries.get(arriving)?.webgl).toBe(webglMock.instances[12])

      // Coming back into view re-acquires a context once a slot is free.
      TerminalManager.dispose(arriving)
      TerminalManager.setPaneVisible(paneIds[0], true)
      expect(zoomedOut.webgl).toBe(webglMock.instances[13])
      expect(zoomedOut.webglReleasedWhileHidden).toBe(false)
    } finally {
      for (const paneId of [...paneIds, arriving]) TerminalManager.dispose(paneId)
      for (const container of containers) container.remove()
    }
  })

  it('refuses WebGL beyond the process context budget', () => {
    webglMock.fail = false
    const containers: HTMLElement[] = []
    const paneIds = Array.from({ length: 13 }, (_, index) => `pane-webgl-budget-${index}`)

    try {
      for (const paneId of paneIds) {
        const container = makeContainer()
        vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600 } as DOMRect)
        containers.push(container)
        TerminalManager.attach(paneId, container)
        TerminalManager.setPaneVisible(paneId, true)
      }

      const manager = TerminalManager as unknown as { entries: Map<string, { webgl?: unknown }> }
      expect(webglMock.instances).toHaveLength(12)
      expect(manager.entries.get(paneIds[12])?.webgl).toBeUndefined()
    } finally {
      for (const paneId of paneIds) TerminalManager.dispose(paneId)
      for (const container of containers) container.remove()
    }
  })

  it('fits panes in the same task when a structural toggle lands', () => {
    const paneId = 'pane-fit-now'
    const container = makeContainer()
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600 } as DOMRect)
    TerminalManager.attach(paneId, container, { sessionId: 'session-fit-now' })
    TerminalManager.setPaneVisible(paneId, true)
    const manager = TerminalManager as unknown as { entries: Map<string, { term: { cols: number; rows: number } }> }
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing fitNow entry')
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)

    try {
      entry.term.cols = 20
      invokeMock.mockClear()
      TerminalManager.fitNow({ syncPty: true })

      expect(entry.term.cols).toBe(80)
      expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toHaveLength(1)
    } finally {
      requestFrame.mockRestore()
      TerminalManager.dispose(paneId)
      container.remove()
    }
  })

  it('repairs stale glyphs without disposing an attached WebGL renderer', () => {
    const paneId = 'pane-webgl-glyph-repair'
    const clearTextureAtlas = vi.fn()
    const dispose = vi.fn()
    const container = makeContainer()
    const manager = TerminalManager as unknown as {
      resetRenderer(entry: unknown, options: { immediate: boolean }): void
      performRendererReload(entry: unknown): void
    }
    const entry = TerminalManager.getOrCreate(paneId) as unknown as {
      opened: boolean
      container?: HTMLElement
      rendererReloadPending?: boolean
      webgl?: { clearTextureAtlas(): void; dispose(): void }
    }
    entry.opened = true
    entry.container = container
    entry.webgl = { clearTextureAtlas, dispose }

    manager.resetRenderer(entry, { immediate: true })
    entry.rendererReloadPending = true
    manager.performRendererReload(entry)

    expect(clearTextureAtlas).toHaveBeenCalledTimes(2)
    expect(dispose).not.toHaveBeenCalled()
    expect(entry.webgl).toBeDefined()
    TerminalManager.dispose(paneId)
    container.remove()
  })

  it('releases the driver context when a WebGL pane is disposed', () => {
    webglMock.fail = false
    const paneId = 'pane-webgl-release'
    const container = makeContainer()
    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({ width: 800, height: 600 } as DOMRect)
    TerminalManager.attach(paneId, container)
    const instance = webglMock.instances[0]
    expect(instance).toBeDefined()

    TerminalManager.dispose(paneId)

    expect(instance.lostContextCalls).toBe(1)
    expect(instance.canvas).toEqual({ width: 0, height: 0 })
    container.remove()
  })

  it('keeps process-exit backlog split into cooperative parser chunks', () => {
    vi.useFakeTimers()
    const paneId = 'pane-exit-backlog'
    const entry = TerminalManager.getOrCreate(paneId) as unknown as {
      opened: boolean
      term: { writes: unknown[] }
    }
    entry.opened = true

    try {
      TerminalManager.write(paneId, new Uint8Array(64 * 1024), { foreground: false })
      TerminalManager.markExited(paneId, 0)

      expect(entry.term.writes).toHaveLength(5)
      expect(entry.term.writes.slice(0, 4).map((write) => (write as Uint8Array).byteLength))
        .toEqual([16 * 1024, 16 * 1024, 16 * 1024, 16 * 1024])
      expect(entry.term.writes[4]).toContain('[process exited (0)]')
    } finally {
      TerminalManager.dispose(paneId)
      vi.useRealTimers()
    }
  })

  it('shares each frame budget fairly across busy panes', () => {
    vi.useFakeTimers()
    const paneIds = ['pane-output-a', 'pane-output-b', 'pane-output-c']
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const entries = paneIds.map((paneId) => {
      const entry = TerminalManager.getOrCreate(paneId) as unknown as { opened: boolean; term: { writes: unknown[] } }
      entry.opened = true
      return entry
    })
    const runNextFrame = () => {
      const callback = frames.values().next().value
      if (!callback) throw new Error('missing scheduled output frame')
      frames.clear()
      callback(performance.now())
    }

    try {
      paneIds.forEach((paneId) => TerminalManager.write(paneId, new TextEncoder().encode(paneId), { foreground: false }))
      vi.advanceTimersByTime(50)
      runNextFrame()
      expect(entries.map((entry) => entry.term.writes.length)).toEqual([1, 1, 0])

      runNextFrame()
      expect(entries.map((entry) => entry.term.writes.length)).toEqual([1, 1, 1])
    } finally {
      paneIds.forEach((paneId) => TerminalManager.dispose(paneId))
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('TerminalManager divider resize scheduling', () => {
  it('holds pane reflows until divider release and flushes the landed PTY size', () => {
    const manager = TerminalManager as unknown as {
      entries: Map<string, {
        fit: { fit(): void; proposeDimensions(): { cols: number; rows: number } }
        term: { cols: number; rows: number; resize(cols: number, rows: number): void }
        observedSize?: { width: number; height: number }
        lastFitRect?: { width: number; height: number }
      }>
      pendingPass: Map<string, unknown>
      passFrame?: number
      passTimer?: number
      lastPassAt?: number
    }
    if (manager.passFrame !== undefined) window.cancelAnimationFrame(manager.passFrame)
    if (manager.passTimer !== undefined) window.clearTimeout(manager.passTimer)
    manager.passFrame = undefined
    manager.passTimer = undefined
    manager.pendingPass.clear()

    let nextFrame = 1
    const frames = new Map<number, FrameRequestCallback>()
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const flushFrames = () => {
      for (let pass = 0; pass < 20 && frames.size > 0; pass += 1) {
        const callbacks = [...frames.values()]
        frames.clear()
        callbacks.forEach((callback) => callback(performance.now()))
      }
      expect(frames.size).toBe(0)
    }
    const paneId = 'pane-divider-stable-fit'
    const container = makeContainer()
    let hostWidth = 500
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0,
      y: 0,
      width: hostWidth,
      height: 300,
      top: 0,
      right: hostWidth,
      bottom: 300,
      left: 0,
      toJSON: () => ({}),
    }))
    TerminalManager.attach(paneId, container, { sessionId: 'session-divider' })
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing divider resize entry')
    flushFrames()
    expect(entry.lastFitRect).toEqual({ width: 500, height: 300 })
    invokeMock.mockClear()
    manager.lastPassAt = undefined
    vi.spyOn(entry.fit, 'proposeDimensions').mockReturnValue({ cols: 100, rows: 24 })
    const fitSpy = vi.spyOn(entry.fit, 'fit').mockImplementation(() => entry.term.resize(100, 24))
    const sash = document.createElement('div')
    sash.className = 'dv-sash'
    document.body.appendChild(sash)
    const release = () => document.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))

    try {
      sash.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      hostWidth = 650
      emitResize(container, hostWidth, 300)

      expect(fitSpy).not.toHaveBeenCalled()
      flushFrames()

      expect(document.documentElement.classList.contains('vibelink-interacting')).toBe(true)
      expect(fitSpy).not.toHaveBeenCalled()
      expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([])

      release()
      flushFrames()

      expect(fitSpy).toHaveBeenCalledTimes(1)
      expect(entry.term.cols).toBe(100)
      expect(container.classList.contains('terminal-resize-preview')).toBe(false)
      expect(container.style.getPropertyValue('--vibelink-terminal-resize-scale-x')).toBe('')

      expect(document.documentElement.classList.contains('vibelink-interacting')).toBe(false)
      expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([
        ['resize_pane', { sessionId: 'session-divider', paneId, cols: 100, rows: 24 }],
      ])
    } finally {
      if (document.documentElement.classList.contains('vibelink-interacting')) release()
      sash.remove()
      TerminalManager.dispose(paneId)
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
    }
  })

  it('spreads a multi-pane settle across animation frames', () => {
    const manager = TerminalManager as unknown as {
      entries: Map<string, {
        fit: { fit(proposed?: { cols: number; rows: number }): void; proposeDimensions(): { cols: number; rows: number } }
        term: { resize(cols: number, rows: number): void }
        observedSize?: { width: number; height: number }
        lastFitRect?: { width: number; height: number }
      }>
      pendingPass: Map<string, unknown>
      passFrame?: number
      passTimer?: number
      lastPassAt?: number
    }
    if (manager.passFrame !== undefined) window.cancelAnimationFrame(manager.passFrame)
    if (manager.passTimer !== undefined) window.clearTimeout(manager.passTimer)
    manager.passFrame = undefined
    manager.passTimer = undefined
    manager.pendingPass.clear()

    let nextFrame = 1
    const frames = new Map<number, FrameRequestCallback>()
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = nextFrame
      nextFrame += 1
      frames.set(id, callback)
      return id
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })
    const runNextFrame = () => {
      const next = frames.entries().next().value as [number, FrameRequestCallback] | undefined
      if (!next) throw new Error('missing scheduled layout frame')
      frames.delete(next[0])
      next[1](performance.now())
    }
    let restoreNow: () => void = () => undefined
    const flushFrames = () => {
      for (let pass = 0; pass < 20 && frames.size > 0; pass += 1) runNextFrame()
      expect(frames.size).toBe(0)
    }
    const paneIds = ['pane-fit-budget-a', 'pane-fit-budget-b']

    try {
      for (const paneId of paneIds) {
        const container = makeContainer()
        vi.spyOn(container, 'getBoundingClientRect').mockReturnValue({
          x: 0,
          y: 0,
          width: 500,
          height: 300,
          top: 0,
          right: 500,
          bottom: 300,
          left: 0,
          toJSON: () => ({}),
        })
        TerminalManager.attach(paneId, container)
      }
      flushFrames()
      manager.pendingPass.clear()
      manager.lastPassAt = undefined

      let now = 0
      const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)
      restoreNow = () => nowSpy.mockRestore()
      const fits = paneIds.map((paneId, index) => {
        const entry = manager.entries.get(paneId)
        if (!entry) throw new Error(`missing fit entry ${paneId}`)
        entry.observedSize = { width: 650, height: 300 }
        entry.lastFitRect = { width: 500, height: 300 }
        vi.spyOn(entry.fit, 'proposeDimensions').mockReturnValue({ cols: 100, rows: 24 })
        return vi.spyOn(entry.fit, 'fit').mockImplementation(() => {
          entry.term.resize(100, 24)
          if (index === 0) now = 9
        })
      })

      TerminalManager.scheduleLayoutPass({ paneIds, force: true })
      runNextFrame()
      expect(fits[0]).toHaveBeenCalledOnce()
      expect(fits[1]).not.toHaveBeenCalled()
      expect(frames.size).toBe(1)

      now = 20
      runNextFrame()
      expect(fits[1]).toHaveBeenCalledOnce()
      expect(frames.size).toBe(0)
    } finally {
      restoreNow()
      paneIds.forEach((paneId) => TerminalManager.dispose(paneId))
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
    }
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

describe('TerminalManager whole-grid layout transactions', () => {
  it('never fits a pane to the intermediate geometry a topology command passes through', async () => {
    // Arrange/grid-creation move panes group by group, so a pane briefly owns a
    // fraction of its row (20 cols observed live on a 4x2 grid). Fitting that is
    // destructive, not just wasteful: the narrow reflow pushes wrapped lines
    // into scrollback and xterm never pulls them back when the pane widens
    // again, which is the "the pre-arrange screen is still up there" report.
    const manager = TerminalManager as unknown as {
      entries: Map<string, {
        fit: { fit(): void; proposeDimensions(): { cols: number; rows: number } }
        term: { cols: number; rows: number }
      }>
    }
    const paneId = 'pane-layout-transaction'
    const container = makeContainer()
    let hostWidth = 800
    vi.spyOn(container, 'getBoundingClientRect').mockImplementation(() => ({
      x: 0, y: 0, width: hostWidth, height: 300, top: 0, right: hostWidth, bottom: 300, left: 0, toJSON: () => ({}),
    }))
    TerminalManager.attach(paneId, container, { sessionId: 'session-transaction' })
    const entry = manager.entries.get(paneId)
    if (!entry) throw new Error('missing layout transaction entry')
    await vi.waitFor(() => expect(entry.term.cols).toBe(80))

    let proposed = { cols: 80, rows: 24 }
    vi.spyOn(entry.fit, 'proposeDimensions').mockImplementation(() => proposed)
    const fitSpy = vi.spyOn(entry.fit, 'fit').mockImplementation(() => {
      entry.term.cols = proposed.cols
      entry.term.rows = proposed.rows
    })
    invokeMock.mockClear()

    await TerminalManager.runLayoutTransaction(async () => {
      // Two intermediate geometries, exactly as a moveTo + equalize pass emits.
      proposed = { cols: 20, rows: 24 }
      hostWidth = 200
      emitResize(container, hostWidth, 300)
      await Promise.resolve()
      proposed = { cols: 57, rows: 24 }
      hostWidth = 570
      emitResize(container, hostWidth, 300)
      await Promise.resolve()
      expect(fitSpy).not.toHaveBeenCalled()
      expect(entry.term.cols).toBe(80)
      expect(invokeMock).not.toHaveBeenCalledWith('resize_pane', expect.anything())
      // Final geometry, which is the only one the pane should ever see.
      proposed = { cols: 87, rows: 24 }
      hostWidth = 870
    })

    await vi.waitFor(() => expect(entry.term.cols).toBe(87))
    expect(fitSpy).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([
      ['resize_pane', { sessionId: 'session-transaction', paneId, cols: 87, rows: 24 }],
    ])
    TerminalManager.dispose(paneId)
  })
})

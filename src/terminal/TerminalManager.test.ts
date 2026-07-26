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
    focusCalls = 0
    writes: unknown[] = []
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
      this.element.className = 'xterm'
      const screen = document.createElement('div')
      screen.className = 'xterm-screen'
      this.element.appendChild(screen)
      container.appendChild(this.element)
    }
    focus(): void { this.focusCalls += 1 }
    refresh(): void {}
    scrollToBottom(): void {}
    write(data: unknown, callback?: () => void): void { this.writes.push(data); callback?.() }
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
  invokeMock.mockReset()
  invokeMock.mockResolvedValue(undefined)
  useRemotePaneLeaseStore.setState({ leases: {} })
})

vi.stubGlobal('ResizeObserver', StubResizeObserver)

describe('TerminalManager pre-session input buffering', () => {
  it('holds emulator input while the pane has no session and flushes it on the session-bound attach', () => {
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

  it('sends input immediately when the pane already has a session', () => {
    const paneId = 'pane-live-input'
    const container = makeContainer()

    TerminalManager.attach(paneId, container, { sessionId: 'session-2' })
    emitTerminalData(paneId, 'ls\r')

    expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-2', paneId, data: 'ls\r' })

    TerminalManager.dispose(paneId)
  })

  it('flushes held input when the daemon reattaches the pane', () => {
    const paneId = 'pane-reattach-flush'
    const container = makeContainer()

    TerminalManager.attach(paneId, container, {})
    emitTerminalData(paneId, '\x1b[1;1R')
    expect(invokeMock).not.toHaveBeenCalledWith('write_pane', expect.anything())

    TerminalManager.reattachToDaemon('session-3', [paneId])

    expect(invokeMock).toHaveBeenCalledWith('attach_pane', { sessionId: 'session-3', paneId })
    expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-3', paneId, data: '\x1b[1;1R' })

    TerminalManager.dispose(paneId)
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

  it('suppresses desktop input, focus, fit, and resize while leased, preserves output, then restores desktop control', () => {
    const paneId = 'pane-leased-control'
    const container = makeContainer()
    TerminalManager.attach(paneId, container, { sessionId: 'session-mobile' })
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
    TerminalManager.write(paneId, new TextEncoder().encode('remote output'))

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
    expect(invokeMock).toHaveBeenCalledWith('write_pane', { sessionId: 'session-mobile', paneId, data: 'restored input' })
    expect(entry.term.focusCalls).toBe(1)
    TerminalManager.dispose(paneId)
  })
})

describe('TerminalManager divider resize scheduling', () => {
  it('fits stable pane grids during the drag and flushes the PTY size on release', () => {
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
      expect(fitSpy).toHaveBeenCalledTimes(1)
      expect(entry.term.cols).toBe(100)
      expect(container.classList.contains('terminal-resize-preview')).toBe(false)
      expect(container.style.getPropertyValue('--vibelink-terminal-resize-scale-x')).toBe('')
      expect(invokeMock.mock.calls.filter(([command]) => command === 'resize_pane')).toEqual([])

      release()
      flushFrames()

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

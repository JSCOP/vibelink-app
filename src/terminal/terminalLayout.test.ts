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
import { TerminalManager, emitResize, emitTerminalData, eventMock, invokeMock, makeContainer } from './terminalTestHarness'

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

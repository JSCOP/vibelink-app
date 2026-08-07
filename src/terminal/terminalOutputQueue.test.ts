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
import { TerminalManager, invokeMock, makeContainer, terminalSnapshot, webglMock } from './terminalTestHarness'

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

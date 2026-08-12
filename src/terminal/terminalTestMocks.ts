import { vi } from 'vitest'

export const invokeMock = (() => {
  const invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown> = () => Promise.resolve()
  return vi.fn(invoke)
})()

export const eventMock = (() => {
  const state: { systemResumed?: () => void } = {}
  return {
    state,
    listen: vi.fn(async (event: string, handler: () => void) => {
      if (event === 'system-resumed') state.systemResumed = handler
      return () => { if (state.systemResumed === handler) state.systemResumed = undefined }
    }),
  }
})()

export const webglMock = (() => {
  type Instance = {
    clearAtlasCalls: number
    disposeCalls: number
    lostContextCalls: number
    canvas: { width: number; height: number }
    triggerContextLoss(): void
  }
  return { fail: true, instances: [] as Instance[] }
})()

export function tauriEventModule() { return { listen: eventMock.listen } }

export function tauriCoreModule() { return { invoke: invokeMock } }

export function xtermModule() {
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
}

export function scrollbarModule() {
  class PaneFitAddon {
    private terminal: { resize(cols: number, rows: number): void } | undefined
    activate(terminal: { resize(cols: number, rows: number): void }): void { this.terminal = terminal }
    proposeDimensions(): { cols: number; rows: number } {
      return { cols: 80, rows: 24 }
    }
    fit(): void { this.terminal?.resize(80, 24) }
  }
  return { PaneFitAddon, showPaneScrollbar: () => true }
}

export function webglAddonModule() {
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
}

export function clipboardAddonModule() { return { ClipboardAddon: class {} } }
export function searchAddonModule() { return { SearchAddon: class {} } }
export function unicode11AddonModule() { return { Unicode11Addon: class {} } }
/** Stands in for the real serializer: tests care about WHEN a snapshot is sent
 *  and what wraps it, not about xterm's cell-to-ANSI rendering. */
export function serializeAddonModule() {
  class MockSerializeAddon {
    private terminal: { cols: number; rows: number } | undefined
    activate(terminal: { cols: number; rows: number }): void { this.terminal = terminal }
    serialize(options?: { scrollback?: number; excludeAltBuffer?: boolean }): string {
      return `rendered ${this.terminal?.cols ?? 0}x${this.terminal?.rows ?? 0} scrollback=${options?.scrollback ?? 'all'} altExcluded=${options?.excludeAltBuffer === true}`
    }
    dispose(): void {}
  }
  return { SerializeAddon: MockSerializeAddon }
}

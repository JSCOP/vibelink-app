import { invoke } from '@tauri-apps/api/core'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { terminalThemeById } from '../state/terminalThemes'
import { createTerminalOptions, defaultTerminalSettings, terminalLetterSpacing, terminalLineHeight, type TerminalVisualSettings } from './options'
import { terminalHostBecameMeasurable, terminalHostMeasureState, type TerminalHostMeasureState } from './geometry'
import { copyAllTerminalContents, copyTerminalSelection } from './copy'
import { createPathLinkProvider, createImageMarkerLinkProvider, type CaptureLinkActions } from './links'
import { terminalOutputAfterLastHardClear } from './clearSequences'
import { agentActivityTracker, type AgentActivityActions } from './agentActivity'

const MAX_FIT_ATTEMPTS = 120
const MAX_OUTPUT_BYTES_PER_FRAME = 256 * 1024
const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024
const OUTPUT_FLUSH_FALLBACK_MS = 250
const INSTANT_OUTPUT_BYTES = 4 * 1024



type Entry = {
  paneId: string
  term: Terminal
  fit: FitAddon
  opened: boolean
  daemonAttached: boolean
  dataWired: boolean
  sessionId?: string
  observer?: ResizeObserver
  fitFrame?: number
  visibleRecoveryFrame?: number
  visibleRecoveryRefreshFrame?: number
  outputFrame?: number
  outputTimer?: number
  pendingOutput?: Uint8Array[]
  pendingOutputBytes?: number
  fitForcePending?: boolean
  measureState?: TerminalHostMeasureState
  forceFitOnNextMeasure?: boolean
  rendererResetPending?: boolean
  container?: HTMLElement
  titleDisposable?: { dispose: () => void }
  linkDisposables?: { dispose(): void }[]
  outputTrimNoticeWritten?: boolean
  webgl?: WebglAddon
  webglAttempted?: boolean
  webglContextLossDisposable?: { dispose(): void }
  titleHandler?: (title: string) => void
}

class TerminalManagerImpl {
  private entries = new Map<string, Entry>()
  private settings: TerminalVisualSettings = defaultTerminalSettings
  private linkActions: CaptureLinkActions = { onOpenPath: () => {}, resolveMarker: () => undefined }

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.resumeRendering()
      })
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', () => this.resumeRendering())
    }
  }

  setLinkActions(actions: CaptureLinkActions): void {
    this.linkActions = actions
  }

  setAgentActivityActions(actions: AgentActivityActions): void {
    agentActivityTracker.setActions(actions)
  }

  applySettings(settings: TerminalVisualSettings): void {
    const fontChanged = this.settings.fontFamily !== settings.fontFamily || this.settings.fontSize !== settings.fontSize || this.settings.terminalFontWeight !== settings.terminalFontWeight
    const themeChanged = this.settings.terminalThemeId !== settings.terminalThemeId
    const cursorChanged = this.settings.cursorStyle !== settings.cursorStyle || this.settings.cursorWidth !== settings.cursorWidth
    this.settings = settings
    for (const entry of this.entries.values()) {
      const options = createTerminalOptions(settings)
      entry.term.options.customGlyphs = options.customGlyphs
      entry.term.options.fontFamily = options.fontFamily
      entry.term.options.fontSize = options.fontSize
      entry.term.options.fontWeight = options.fontWeight
      entry.term.options.fontWeightBold = options.fontWeightBold
      entry.term.options.letterSpacing = terminalLetterSpacing
      entry.term.options.lineHeight = terminalLineHeight
      entry.term.options.scrollback = options.scrollback
      entry.term.options.cursorStyle = options.cursorStyle
      if (options.cursorWidth !== undefined) entry.term.options.cursorWidth = options.cursorWidth
      entry.term.options.theme = terminalThemeById(settings.terminalThemeId)
      this.applyScrollbarVisibility(entry)
      if (fontChanged) this.fitAfterFontsLoad(entry)
      if (fontChanged || themeChanged || cursorChanged) this.redrawAfterNextFrame(entry)
      this.fit(entry, 0, true)
    }
  }
  getOrCreate(paneId: string): Entry {
    const existing = this.entries.get(paneId)
    if (existing) return existing

    const term = new Terminal(createTerminalOptions(this.settings))
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new SearchAddon())
    term.loadAddon(new Unicode11Addon())
    term.loadAddon(new ClipboardAddon())
    term.unicode.activeVersion = '11'
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown' || !event.altKey || event.ctrlKey || event.metaKey) return true
      if (event.key === 'ArrowLeft') {
        term.input(event.shiftKey ? '\x1b[1;6D' : '\x1b[1;5D', true)
        return false
      }
      if (event.key === 'ArrowRight') {
        term.input(event.shiftKey ? '\x1b[1;6C' : '\x1b[1;5C', true)
        return false
      }
      return true
    })

    const entry: Entry = { paneId, term, fit, opened: false, daemonAttached: false, dataWired: false }
    this.entries.set(paneId, entry)
    entry.linkDisposables = [
      term.registerLinkProvider(createPathLinkProvider(term, () => this.linkActions)),
      term.registerLinkProvider(createImageMarkerLinkProvider(term, paneId, () => this.linkActions)),
    ]
    return entry
  }


  attach(paneId: string, container: HTMLElement, options: { sessionId?: string; onTitleChange?: (title: string) => void } = {}): void {
    const entry = this.getOrCreate(paneId)
    const previousSessionId = entry.sessionId
    entry.sessionId = options.sessionId
    entry.container = container
    entry.term.options.theme = terminalThemeById(this.settings.terminalThemeId)
    this.applyScrollbarVisibility(entry)

    if (!entry.opened) {
      entry.term.open(container)
      entry.opened = true
    } else if (entry.term.element && entry.term.element.parentElement !== container) {
      container.appendChild(entry.term.element)
      this.redraw(entry)
    }

    if (entry.opened) this.loadWebglRenderer(entry)

    if (!entry.dataWired) {
      entry.term.onData((data) => {
        agentActivityTracker.noteUserInput(paneId, data)
        const sessionId = entry.sessionId
        if (sessionId) void invoke('write_pane', { sessionId, paneId, data })
      })
      entry.term.onResize(({ cols, rows }) => {
        const sessionId = entry.sessionId
        if (sessionId) void invoke('resize_pane', { sessionId, paneId, cols, rows })
      })
      entry.dataWired = true
    }

    if (entry.titleHandler !== options?.onTitleChange) {
      entry.titleDisposable?.dispose()
      entry.titleHandler = options?.onTitleChange
      entry.titleDisposable = options?.onTitleChange
        ? entry.term.onTitleChange((title) => options.onTitleChange?.(title))
        : undefined
    }

    if (options.sessionId && (!entry.daemonAttached || previousSessionId !== options.sessionId)) {
      entry.daemonAttached = true
      void invoke('attach_pane', { sessionId: options.sessionId, paneId })
    }

    entry.observer?.disconnect()
    entry.observer = new ResizeObserver(() => this.fit(entry, 0))
    entry.observer.observe(container)
    this.reflowEntry(entry, true)
    this.fitAfterFontsLoad(entry)
  }

  reattachToDaemon(sessionId: string | undefined, paneIds: string[]): void {
    if (!sessionId) return
    for (const paneId of paneIds) {
      const entry = this.entries.get(paneId)
      if (!entry) continue
      entry.sessionId = sessionId
      entry.daemonAttached = true
      void invoke('attach_pane', { sessionId, paneId })
    }
  }

  write(paneId: string, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    agentActivityTracker.noteOutput(paneId, bytes)
    const entry = this.getOrCreate(paneId)
    if (bytes.byteLength < INSTANT_OUTPUT_BYTES
      && entry.outputFrame === undefined
      && entry.outputTimer === undefined
      && (entry.pendingOutputBytes ?? 0) === 0
      && !entry.pendingOutput?.length) {
      this.writeTerminalOutput(entry, bytes)
      entry.outputTrimNoticeWritten = false
      return
    }
    entry.pendingOutput ??= []
    entry.pendingOutput.push(bytes)
    entry.pendingOutputBytes = (entry.pendingOutputBytes ?? 0) + bytes.byteLength
    if (entry.pendingOutputBytes > MAX_PENDING_OUTPUT_BYTES) this.trimPendingOutput(entry)
    this.scheduleOutputFlush(entry)
  }

  copyContentsToClipboard(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    void copyAllTerminalContents(entry.term)
  }

  copySelectionToClipboard(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    void copyTerminalSelection(entry.term)
  }

  focus(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.term.focus()
    this.reflowEntry(entry, true)
  }

  reflow(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    this.reflowEntry(entry)
  }

  notifyPaneVisible(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    this.scheduleVisibleRecovery(entry, 0)
  }

  reflowAll(forceFit = false): void {
    for (const entry of this.entries.values()) {
      this.reflowEntry(entry, forceFit)
    }
  }

  syncPtySize(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    this.syncEntryPtySize(entry)
  }

  syncAllPtySizes(): void {
    for (const entry of this.entries.values()) {
      this.syncEntryPtySize(entry)
    }
  }

  resumeRendering(): void {
    this.reflowAll(true)
    requestAnimationFrame(() => this.syncAllPtySizes())
  }

  containsEventTarget(paneId: string, target: EventTarget | null): boolean {
    const entry = this.entries.get(paneId)
    return entry?.container !== undefined && target instanceof Node && entry.container.contains(target)
  }

  markExited(paneId: string, exitCode?: number | null): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    this.flushAllOutput(entry)
    const suffix = exitCode == null ? '' : ` (${exitCode})`
    entry.term.write(`\r\n\x1b[31m[process exited${suffix}]\x1b[0m\r\n`)
  }

  dispose(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    agentActivityTracker.clear(paneId)
    entry.observer?.disconnect()
    if (entry.fitFrame !== undefined) cancelAnimationFrame(entry.fitFrame)
    if (entry.visibleRecoveryFrame !== undefined) cancelAnimationFrame(entry.visibleRecoveryFrame)
    if (entry.visibleRecoveryRefreshFrame !== undefined) cancelAnimationFrame(entry.visibleRecoveryRefreshFrame)
    this.cancelScheduledOutputFlush(entry)
    entry.titleDisposable?.dispose()
    entry.linkDisposables?.forEach((d) => d.dispose())
    entry.webglContextLossDisposable?.dispose()
    entry.webgl?.dispose()
    entry.term.dispose()
    this.entries.delete(paneId)
  }

  pruneStale(livePaneIds: Set<string>): void {
    for (const paneId of [...this.entries.keys()]) {
      if (!livePaneIds.has(paneId)) this.dispose(paneId)
    }
  }

  private loadWebglRenderer(entry: Entry): void {
    if (entry.webglAttempted) return
    entry.webglAttempted = true

    let webgl: WebglAddon | undefined
    let contextLossDisposable: { dispose(): void } | undefined
    try {
      const addon = new WebglAddon()
      webgl = addon
      contextLossDisposable = addon.onContextLoss(() => {
        contextLossDisposable?.dispose()
        if (entry.webglContextLossDisposable === contextLossDisposable) entry.webglContextLossDisposable = undefined
        if (entry.webgl === addon) entry.webgl = undefined
        addon.dispose()
      })
      entry.term.loadAddon(addon)
      entry.webgl = addon
      entry.webglContextLossDisposable = contextLossDisposable
    } catch {
      contextLossDisposable?.dispose()
      webgl?.dispose()
      if (entry.webgl === webgl) entry.webgl = undefined
    }
  }

  private applyScrollbarVisibility(entry: Entry): void {
    entry.container?.classList.toggle('terminal-scrollbar-hidden', !this.settings.terminalScrollbarVisible)
  }

  private clearWebglTextureAtlas(entry: Entry): void {
    try {
      entry.webgl?.clearTextureAtlas()
    } catch {
      // Keep the resize recovery path alive if WebGL was already lost.
    }
  }

  private redraw(entry: Entry, options: { clearWebglTextureAtlas?: boolean } = {}): void {
    if (!entry.opened) return
    if (options.clearWebglTextureAtlas) this.clearWebglTextureAtlas(entry)
    entry.term.refresh(0, Math.max(0, entry.term.rows - 1))
  }

  private redrawAfterNextFrame(entry: Entry, options: { clearWebglTextureAtlas?: boolean } = {}): void {
    this.redraw(entry, options)
    requestAnimationFrame(() => this.redraw(entry))
  }

  private reflowEntry(entry: Entry, forceFit = false): void {
    this.redraw(entry)
    this.fit(entry, 0, forceFit)
    requestAnimationFrame(() => this.redraw(entry))
  }

  private scheduleVisibleRecovery(entry: Entry, attempt: number): void {
    if (entry.visibleRecoveryFrame !== undefined) return
    entry.visibleRecoveryFrame = requestAnimationFrame(() => {
      entry.visibleRecoveryFrame = undefined
      if (this.entries.get(entry.paneId) !== entry) return
      const measurement = this.observeMeasureState(entry, entry.container?.getBoundingClientRect())
      if (!measurement.measurable) {
        if (attempt < MAX_FIT_ATTEMPTS) this.scheduleVisibleRecovery(entry, attempt + 1)
        else {
          entry.forceFitOnNextMeasure = true
          entry.rendererResetPending = true
        }
        return
      }
      try {
        this.recoverVisiblePane(entry)
      } catch {
        if (attempt < MAX_FIT_ATTEMPTS) this.scheduleVisibleRecovery(entry, attempt + 1)
      }
    })
  }

  private recoverVisiblePane(entry: Entry): void {
    if (!entry.opened) return
    this.forceFitAndRepaint(entry)
    // dockview's always-renderer overlay repositions its container on its own
    // rAF; if ours ran first the fit above used stale geometry. Verify one
    // frame later and refit when the container size changed.
    if (entry.visibleRecoveryRefreshFrame !== undefined) cancelAnimationFrame(entry.visibleRecoveryRefreshFrame)
    entry.visibleRecoveryRefreshFrame = requestAnimationFrame(() => {
      entry.visibleRecoveryRefreshFrame = undefined
      if (this.entries.get(entry.paneId) !== entry) return
      const proposed = entry.fit.proposeDimensions()
      if (proposed && (proposed.cols !== entry.term.cols || proposed.rows !== entry.term.rows)) {
        this.forceFitAndRepaint(entry)
      } else {
        this.redraw(entry)
      }
    })
  }

  private forceFitAndRepaint(entry: Entry): void {
    const wasAtBottom = entry.term.buffer.active.viewportY >= entry.term.buffer.active.baseY
    entry.fit.fit()
    if (wasAtBottom) entry.term.scrollToBottom()
    this.redraw(entry, { clearWebglTextureAtlas: entry.webgl !== undefined })
    entry.forceFitOnNextMeasure = false
    entry.rendererResetPending = false
    const sessionId = entry.sessionId
    if (sessionId) void invoke('resize_pane', { sessionId, paneId: entry.paneId, cols: entry.term.cols, rows: entry.term.rows })
  }

  private fitAfterFontsLoad(entry: Entry): void {
    const fonts = document.fonts
    if (!fonts) return
    void fonts.ready.then(() => this.fit(entry, 0, true))
  }

  private scheduleOutputFlush(entry: Entry): void {
    if (entry.outputFrame !== undefined || entry.outputTimer !== undefined) return
    const flush = () => {
      this.cancelScheduledOutputFlush(entry)
      this.flushOutput(entry)
    }
    if (typeof requestAnimationFrame !== 'undefined') entry.outputFrame = requestAnimationFrame(flush)
    if (typeof window !== 'undefined') entry.outputTimer = window.setTimeout(flush, OUTPUT_FLUSH_FALLBACK_MS)
    if (entry.outputFrame === undefined && entry.outputTimer === undefined) this.flushAllOutput(entry)
  }

  private cancelScheduledOutputFlush(entry: Entry): void {
    if (entry.outputFrame !== undefined) {
      cancelAnimationFrame(entry.outputFrame)
      entry.outputFrame = undefined
    }
    if (entry.outputTimer !== undefined && typeof window !== 'undefined') {
      window.clearTimeout(entry.outputTimer)
      entry.outputTimer = undefined
    }
  }

  private trimPendingOutput(entry: Entry): void {
    const pending = entry.pendingOutput
    if (!pending?.length) return
    let pendingBytes = entry.pendingOutputBytes ?? 0
    if (pendingBytes <= MAX_PENDING_OUTPUT_BYTES) return

    let trimmed = false
    while (pending.length > 0 && pendingBytes > MAX_PENDING_OUTPUT_BYTES) {
      const dropped = pending.shift()
      if (!dropped) break
      pendingBytes -= dropped.byteLength
      trimmed = true
    }
    entry.pendingOutputBytes = Math.max(0, pendingBytes)
    if (pending.length === 0) entry.pendingOutput = undefined
    if (trimmed && !entry.outputTrimNoticeWritten) {
      entry.term.write('\r\n\x1b[33m[output trimmed]\x1b[0m\r\n')
      entry.outputTrimNoticeWritten = true
    }
  }

  private flushAllOutput(entry: Entry): void {
    this.cancelScheduledOutputFlush(entry)
    while (entry.pendingOutput?.length) {
      this.flushOutput(entry, Number.MAX_SAFE_INTEGER)
    }
    if (!entry.pendingOutput?.length) entry.outputTrimNoticeWritten = false
  }

  private flushOutput(entry: Entry, maxBytes = MAX_OUTPUT_BYTES_PER_FRAME): void {
    const pending = entry.pendingOutput
    if (!pending?.length) {
      entry.outputTrimNoticeWritten = false
      return
    }

    let bytesToWrite = 0
    let chunkCount = 0
    while (chunkCount < pending.length) {
      const nextSize = pending[chunkCount].byteLength
      if (chunkCount > 0 && bytesToWrite + nextSize > maxBytes) break
      bytesToWrite += nextSize
      chunkCount += 1
      if (bytesToWrite >= maxBytes) break
    }

    const chunks = pending.splice(0, chunkCount)
    entry.pendingOutputBytes = Math.max(0, (entry.pendingOutputBytes ?? bytesToWrite) - bytesToWrite)
    this.writeTerminalOutput(entry, concatUint8Arrays(chunks, bytesToWrite))
    if (pending.length > 0) this.scheduleOutputFlush(entry)
    else entry.outputTrimNoticeWritten = false
  }

  private writeTerminalOutput(entry: Entry, bytes: Uint8Array): void {
    const output = terminalOutputAfterLastHardClear(bytes)
    if (output.clear) entry.term.clear()
    entry.term.write(output.bytes)
  }

  private syncEntryPtySize(entry: Entry): void {
    const sessionId = entry.sessionId
    if (!sessionId || !entry.opened) return
    this.flushOutput(entry)
    const measurement = this.observeMeasureState(entry, entry.container?.getBoundingClientRect())
    let fitSucceeded = false
    if (measurement.measurable) {
      try {
        entry.fit.fit()
        fitSucceeded = true
      } catch {
        // The scheduled fit retry path handles transient layout races.
      }
    }
    const resetRenderer = fitSucceeded && Boolean(entry.rendererResetPending)
    this.redraw(entry, { clearWebglTextureAtlas: resetRenderer })
    if (fitSucceeded) {
      entry.forceFitOnNextMeasure = false
      if (resetRenderer) entry.rendererResetPending = false
    }
    void invoke('resize_pane', { sessionId, paneId: entry.paneId, cols: entry.term.cols, rows: entry.term.rows })
    requestAnimationFrame(() => this.redraw(entry))
  }

  private observeMeasureState(entry: Entry, rect: { width: number; height: number } | null | undefined): { measurable: boolean; forceFitForMeasure: boolean } {
    const nextMeasureState = terminalHostMeasureState(rect)
    const becameMeasurable = terminalHostBecameMeasurable(entry.measureState, nextMeasureState)
    entry.measureState = nextMeasureState
    if (nextMeasureState !== 'measurable') return { measurable: false, forceFitForMeasure: false }
    if (becameMeasurable) entry.forceFitOnNextMeasure = true
    const forceFitForMeasure = entry.forceFitOnNextMeasure === true
    if (forceFitForMeasure) entry.rendererResetPending = true
    return { measurable: true, forceFitForMeasure }
  }

  private fit(entry: Entry, attempt: number, force = false): void {
    entry.fitForcePending = Boolean(entry.fitForcePending || force)
    if (entry.fitFrame !== undefined) cancelAnimationFrame(entry.fitFrame)
    entry.fitFrame = requestAnimationFrame(() => {
      entry.fitFrame = undefined
      const pendingForceFit = Boolean(entry.fitForcePending)
      entry.fitForcePending = false
      const measurement = this.observeMeasureState(entry, entry.container?.getBoundingClientRect())
      const forceFit = pendingForceFit || measurement.forceFitForMeasure
      if (!measurement.measurable) {
        if (attempt < MAX_FIT_ATTEMPTS) this.fit(entry, attempt + 1, forceFit)
        else entry.forceFitOnNextMeasure = true
        return
      }
      try {
        const wasAtBottom = entry.term.buffer.active.viewportY >= entry.term.buffer.active.baseY
        const proposed = entry.fit.proposeDimensions()
        const cols = proposed?.cols ?? entry.term.cols
        const rows = proposed?.rows ?? entry.term.rows
        if (forceFit || entry.term.cols !== cols || entry.term.rows !== rows) {
          entry.fit.fit()
        }
        if (forceFit || wasAtBottom) entry.term.scrollToBottom()
        const resetRenderer = Boolean(entry.rendererResetPending)
        this.redrawAfterNextFrame(entry, { clearWebglTextureAtlas: resetRenderer })
        entry.forceFitOnNextMeasure = false
        if (resetRenderer) entry.rendererResetPending = false
      } catch {
        if (attempt < MAX_FIT_ATTEMPTS) this.fit(entry, attempt + 1, forceFit)
      }
    })
  }


}

function concatUint8Arrays(chunks: Uint8Array[], byteLength: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(byteLength)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}


export const TerminalManager = new TerminalManagerImpl()

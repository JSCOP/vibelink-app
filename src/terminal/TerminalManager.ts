import { invoke } from '@tauri-apps/api/core'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { terminalThemeById } from '../state/terminalThemes'
import { terminalFontStack } from '../state/fonts'
import { createTerminalOptions, defaultTerminalSettings, terminalLetterSpacing, terminalLineHeight, type TerminalVisualSettings } from './options'
import { terminalHostBecameMeasurable, terminalHostMeasureState, type TerminalHostMeasureState } from './geometry'
import { copyAllTerminalContents, copyTerminalSelection } from './copy'
import { createPathLinkProvider, createImageMarkerLinkProvider, type CaptureLinkActions } from './links'
import { terminalOutputAfterLastHardClear, terminalStateSequences } from './clearSequences'
import { agentActivityTracker, shouldTrackAgentInput, type AgentActivityActions } from './agentActivity'
import { useWorkspaceStore } from '../state/store'

const MAX_FIT_ATTEMPTS = 120
const MAX_OUTPUT_BYTES_PER_FRAME = 256 * 1024
const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024
const OUTPUT_FLUSH_FALLBACK_MS = 250
const INSTANT_OUTPUT_BYTES = 4 * 1024
// A real terminal is never this small. If FitAddon proposes fewer than these,
// the container is mid-layout (transiently ~1px during a dockview maximize/
// restore) and fitting would reflow-corrupt the buffer — skip and retry.
const MIN_FIT_COLS = 10
const MIN_FIT_ROWS = 3
// Delay before retrying a fit that proposed degenerate dimensions (container
// still mid-layout). Bounded by MAX_FIT_ATTEMPTS so a stuck pane cannot spin.
const DEGENERATE_FIT_RETRY_MS = 32
// Last-resort fallback: rebuild the renderer even if the TUI never emits output
// after the restore. The normal path fires from writeTerminalOutput's write()
// callback the moment the TUI's resize redraw lands; this timeout only covers a
// pane that produces no output at all. Keep it long enough that the resize_pane
// IPC round-trip and the TUI's redraw comfortably win the race first, otherwise
// the rebuild captures a stale cursor position and leaves a ghost. A slightly
// delayed rebuild on a truly silent pane is harmless (it is a recovery path).
const RENDERER_RESET_SETTLE_MS = 1000
// Input emitted by the emulator or user before the pane has a session (panel
// mounts before spawn_pane resolves) is held and flushed on the session-bound
// attach. ConPTY handshakes make this load-bearing: the PTY host sends DSR
// (ESC[6n) immediately after spawn and BLOCKS the child shell until the CPR
// reply arrives — dropping xterm's auto-reply leaves that shell hung forever
// with a black pane. Cap the buffer so an orphaned panel cannot grow it.
const MAX_PENDING_INPUT_CHUNKS = 256



type Entry = {
  paneId: string
  term: Terminal
  fit: FitAddon
  opened: boolean
  daemonAttached: boolean
  dataWired: boolean
  sessionId?: string
  pendingInput?: string[]
  observer?: ResizeObserver
  fitFrame?: number
  rendererReloadPending?: boolean
  rendererReloadTimer?: number
  outputFrame?: number
  outputTimer?: number
  pendingOutput?: Uint8Array[]
  pendingOutputBytes?: number
  fitForcePending?: boolean
  measureState?: TerminalHostMeasureState
  forceFitOnNextMeasure?: boolean
  rendererResetPending?: boolean
  lastFitRect?: { width: number; height: number }
  lastSentPtyCols?: number
  lastSentPtyRows?: number
  remoteWide?: boolean
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
  private pendingPass = new Map<string, { fit: boolean; syncPty: boolean; force: boolean }>()
  private passFrame: number | undefined

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
    term.attachCustomWheelEventHandler((event) => {
      // In the alternate buffer without wheel-capable mouse reporting, xterm
      // converts wheel events into arrow-key sequences (CSI A/B). Full-screen
      // TUIs such as OMP treat ArrowUp as prompt-history recall, so wheeling
      // corrupts the prompt instead of scrolling — and the alternate buffer
      // has no scrollback to scroll either. Swallow the event. TUIs that
      // enable wheel reporting (vt200/drag/any: vim, htop, ...) still receive
      // real wheel reports via the return-true path; x10 tracks button-down
      // only, so it gets the same suppression.
      const wheelReported = term.modes.mouseTrackingMode !== 'none' && term.modes.mouseTrackingMode !== 'x10'
      if (term.buffer.active.type === 'alternate' && !wheelReported) {
        event.preventDefault()
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
        if (shouldTrackAgentInput(entry.term.buffer.active.type)) agentActivityTracker.noteUserInput(paneId, data)
        else agentActivityTracker.clear(paneId)
        const sessionId = entry.sessionId
        if (sessionId) {
          void invoke('write_pane', { sessionId, paneId, data })
          return
        }
        // No session yet (panel-first spawn): hold the input. Dropping it can
        // hang the shell forever — ConPTY blocks the child on its startup DSR
        // (ESC[6n) until xterm's CPR auto-reply is delivered.
        entry.pendingInput ??= []
        if (entry.pendingInput.length < MAX_PENDING_INPUT_CHUNKS) entry.pendingInput.push(data)
      })
      entry.term.onResize(({ cols, rows }) => {
        const sessionId = entry.sessionId
        if (!sessionId || (entry.lastSentPtyCols === cols && entry.lastSentPtyRows === rows)) return
        entry.lastSentPtyCols = cols
        entry.lastSentPtyRows = rows
        void invoke('resize_pane', { sessionId, paneId, cols, rows })
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
      // Fit synchronously before the daemon attach so a scrollback replay
      // parses at the pane's real geometry instead of the constructor default.
      this.safeFit(entry)
      entry.daemonAttached = true
      void invoke('attach_pane', { sessionId: options.sessionId, paneId })
    }
    if (options.sessionId) this.flushPendingInput(entry)

    entry.observer?.disconnect()
    entry.observer = new ResizeObserver(() => this.scheduleLayoutPass({ paneIds: [paneId] }))
    entry.observer.observe(container)
    // Output held while the terminal was unopened parses now, after the
    // synchronous fit above sized the grid to the real host.
    if (entry.pendingOutput?.length) {
      this.safeFit(entry)
      this.flushAllOutput(entry)
    }
    this.scheduleLayoutPass({ paneIds: [paneId], force: true })
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
      this.flushPendingInput(entry)
    }
  }

  adoptRemoteResize(paneId: string, cols: number, rows: number): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    const proposal = entry.fit.proposeDimensions()
    if (!proposal || cols > proposal.cols) {
      entry.remoteWide = true
      entry.term.resize(cols, rows)
      useWorkspaceStore.getState().setRemoteWide(paneId, cols)
      this.redrawAfterNextFrame(entry)
      return
    }

    entry.remoteWide = false
    useWorkspaceStore.getState().setRemoteWide(paneId, null)
    if (this.safeFit(entry, true)) this.redrawAfterNextFrame(entry)
  }

  exitRemoteWide(paneId: string): void {
    const entry = this.entries.get(paneId)
    useWorkspaceStore.getState().setRemoteWide(paneId, null)
    if (!entry) return
    entry.remoteWide = false
    if (!this.safeFit(entry, true)) return
    this.redrawAfterNextFrame(entry)
    this.syncEntryPtySize(entry)
  }

  /** Deliver input held while the pane had no session (panel-first spawn).
   *  Chunks stay in emission order; the CPR reply to ConPTY's startup DSR
   *  must reach the PTY or the child shell never starts. */
  private flushPendingInput(entry: Entry): void {
    const sessionId = entry.sessionId
    const pending = entry.pendingInput
    if (!sessionId || !pending?.length) return
    entry.pendingInput = undefined
    for (const data of pending) {
      void invoke('write_pane', { sessionId, paneId: entry.paneId, data })
    }
  }

  write(paneId: string, bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return
    agentActivityTracker.noteOutput(paneId, bytes)
    const entry = this.getOrCreate(paneId)
    // Output can start streaming before the pane's panel mounts (panes are
    // attached daemon-side at spawn). Parsing it into an unopened terminal
    // would use the constructor's default grid, not the pane's real one —
    // hold the bytes until attach() has opened and fitted the terminal.
    if (!entry.opened) {
      entry.pendingOutput ??= []
      entry.pendingOutput.push(bytes)
      entry.pendingOutputBytes = (entry.pendingOutputBytes ?? 0) + bytes.byteLength
      if (entry.pendingOutputBytes > MAX_PENDING_OUTPUT_BYTES) this.trimPendingOutput(entry)
      return
    }
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

  /** Live-preview a theme on every terminal without touching the committed
   *  settings; pass null to revert to the committed theme. */
  previewTheme(themeId: string | null): void {
    const theme = terminalThemeById(themeId ?? this.settings.terminalThemeId)
    for (const entry of this.entries.values()) {
      entry.term.options.theme = theme
    }
  }

  /** Live-preview a font family on every terminal without touching the
   *  committed settings; pass null to revert to the committed font. */
  previewFont(fontFamily: string | null): void {
    const stack = terminalFontStack(fontFamily ?? this.settings.fontFamily)
    for (const entry of this.entries.values()) {
      if (entry.term.options.fontFamily === stack) continue
      entry.term.options.fontFamily = stack
      this.fitAfterFontsLoad(entry)
      this.redrawAfterNextFrame(entry)
      this.fit(entry, 0, true)
    }
  }

  hasSelection(paneId: string): boolean {
    return this.entries.get(paneId)?.term.hasSelection() ?? false
  }

  getSelection(paneId: string): string {
    return this.entries.get(paneId)?.term.getSelection() ?? ''
  }

  selectAll(paneId: string): void {
    this.entries.get(paneId)?.term.selectAll()
  }

  paste(paneId: string, text: string): void {
    if (text.length === 0) return
    this.entries.get(paneId)?.term.paste(text)
  }

  /** Synchronously fit an opened pane and report its cell grid, so a PTY can
   *  be spawned at the exact size the terminal already has — the program then
   *  never draws its first frames across a resize. Returns null while the
   *  host container is not yet measurable. */
  measureForSpawn(paneId: string): { cols: number; rows: number } | null {
    const entry = this.entries.get(paneId)
    if (!entry?.opened) return null
    try {
      if (!this.safeFit(entry)) return null
    } catch {
      return null
    }
    return { cols: entry.term.cols, rows: entry.term.rows }
  }

  focus(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.term.focus()
    this.scheduleLayoutPass({ paneIds: [paneId] })
  }

  reflow(paneId: string): void {
    this.scheduleLayoutPass({ paneIds: [paneId] })
  }

  notifyPaneVisible(paneId: string): void {
    this.scheduleLayoutPass({ paneIds: [paneId], force: true, syncPty: true })
  }

  recoverAllVisiblePanes(): void {
    this.scheduleLayoutPass({ force: true, syncPty: true })
  }

  reflowAll(forceFit = false): void {
    this.scheduleLayoutPass({ force: forceFit })
  }

  syncPtySize(paneId: string): void {
    this.scheduleLayoutPass({ paneIds: [paneId], syncPty: true })
  }

  syncAllPtySizes(): void {
    this.scheduleLayoutPass({ syncPty: true })
  }

  resumeRendering(): void {
    this.scheduleLayoutPass({ force: true, syncPty: true })
  }

  scheduleLayoutPass(options: { paneIds?: string[]; syncPty?: boolean; force?: boolean } = {}): void {
    const paneIds = options.paneIds ?? [...this.entries.keys()]
    for (const paneId of paneIds) {
      if (!this.entries.has(paneId)) continue
      const pending = this.pendingPass.get(paneId)
      this.pendingPass.set(paneId, {
        fit: true,
        syncPty: Boolean(pending?.syncPty || options.syncPty),
        force: Boolean(pending?.force || options.force),
      })
    }
    if (this.passFrame !== undefined || this.pendingPass.size === 0) return
    this.passFrame = requestAnimationFrame(() => {
      this.passFrame = undefined
      const pending = this.pendingPass
      this.pendingPass = new Map()
      for (const [paneId, pass] of pending) {
        const entry = this.entries.get(paneId)
        if (!entry?.opened || !pass.fit) continue
        const rect = entry.container?.getBoundingClientRect()
        const measurement = this.observeMeasureState(entry, rect)
        if (!rect || !measurement.measurable) continue
        const lastRect = entry.lastFitRect
        const rectUnchanged = lastRect !== undefined
          && Math.abs(lastRect.width - rect.width) <= 1
          && Math.abs(lastRect.height - rect.height) <= 1
        if (!pass.force && !entry.rendererResetPending && rectUnchanged) continue

        if (entry.rendererResetPending) {
          if (!this.forceFitAndRepaint(entry)) continue
        } else {
          const wasAtBottom = entry.term.buffer.active.viewportY >= entry.term.buffer.active.baseY
          if (!this.safeFit(entry, pass.force || measurement.forceFitForMeasure)) {
            entry.forceFitOnNextMeasure = true
            continue
          }
          if (wasAtBottom) entry.term.scrollToBottom()
          entry.forceFitOnNextMeasure = false
          this.redraw(entry)
        }
        entry.lastFitRect = { width: rect.width, height: rect.height }
        if (pass.syncPty) this.syncEntryPtySize(entry)
      }
    })
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
    useWorkspaceStore.getState().setRemoteWide(paneId, null)
    entry.observer?.disconnect()
    if (entry.fitFrame !== undefined) cancelAnimationFrame(entry.fitFrame)
    this.pendingPass.delete(paneId)
    clearTimeout(entry.rendererReloadTimer)
    entry.rendererReloadPending = false
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
        // addon.dispose() swaps xterm back to the DOM renderer but only calls
        // renderService.handleResize — a no-op for a hidden pane (0×0 while a
        // sibling is maximized). Nothing repaints the buffer, so the pane shows
        // blank until a click. Mark it dirty and schedule recovery so the DOM
        // renderer repaints once the pane is measurable again.
        entry.forceFitOnNextMeasure = true
        entry.rendererResetPending = true
        this.scheduleLayoutPass({ paneIds: [entry.paneId], force: true, syncPty: true })
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


  // Fit only when FitAddon proposes sane dimensions. During dockview's maximize/
  // restore the container can be transiently ~1px (measurable by width/height > 0,
  // but not yet laid out), and FitAddon then proposes something like 2x1. Resizing
  // xterm to that reflows the buffer into thousands of 2-column rows and destroys
  // the content — so every fit path must go through this guard, not entry.fit.fit()
  // directly. Returns true when a fit was applied (or none was needed).
  private safeFit(entry: Entry, force = false): boolean {
    if (entry.remoteWide) return true
    const proposed = entry.fit.proposeDimensions()
    if (!proposed || proposed.cols < MIN_FIT_COLS || proposed.rows < MIN_FIT_ROWS) return false
    if (force || entry.term.cols !== proposed.cols || entry.term.rows !== proposed.rows) entry.fit.fit()
    return true
  }

  private forceFitAndRepaint(entry: Entry, attempt = 0): boolean {
    const wasAtBottom = entry.term.buffer.active.viewportY >= entry.term.buffer.active.baseY
    // safeFit skips a degenerate proposal (container mid-layout). If it could not
    // fit, retry on a bounded delay once the real geometry settles rather than
    // fitting to 2x1 and corrupting the buffer.
    if (!this.safeFit(entry, true)) {
      entry.forceFitOnNextMeasure = true
      if (attempt < MAX_FIT_ATTEMPTS) {
        window.setTimeout(() => {
          if (this.entries.get(entry.paneId) === entry && entry.opened) this.forceFitAndRepaint(entry, attempt + 1)
        }, DEGENERATE_FIT_RETRY_MS)
      }
      return false
    }
    if (wasAtBottom) entry.term.scrollToBottom()
    this.redraw(entry, { clearWebglTextureAtlas: entry.webgl !== undefined })
    if (entry.rendererResetPending) this.forceGlyphRepaint(entry)
    else if (entry.webgl) this.clearWebglTextureAtlas(entry)
    entry.forceFitOnNextMeasure = false
    entry.rendererResetPending = false
    this.syncEntryPtySize(entry)
    return true
  }

  // After dockview re-parents a pane's container (maximize/restore, pane swap),
  // xterm's renderer holds stale per-cell glyphs against a desynced draw surface:
  // refresh(), clearTextureAtlas(), theme re-apply, and handleResize all fail to
  // repaint the text (only the cursor layer redraws) — the pane looks blank
  // though its buffer is intact. The repair depends on WHO repaints after resize:
  //
  //  - NORMAL buffer (a plain shell like PowerShell): the program does not redraw
  //    on resize — the text lives only in xterm's buffer — so rebuild the renderer
  //    immediately and re-upload every glyph from the buffer we already hold. (A
  //    scroll nudge is cheaper but only re-marks visible rows dirty and proved to
  //    intermittently leave the pane blank after a maximize/restore, so we always
  //    rebuild here — see forceGlyphRepaint.)
  //  - ALTERNATE buffer (a full-screen TUI/agent like omp/claude/codex): the app
  //    owns the screen and redraws itself on SIGWINCH after the resize. Rebuilding
  //    immediately races that redraw and captures the stale cursor, leaving a
  //    ghost. Defer the rebuild until the app's resize redraw lands
  //    (writeTerminalOutput's write() callback) with a timeout fallback.
  private forceGlyphRepaint(entry: Entry): void {
    if (!entry.opened) return
    // Alternate-buffer TUIs (omp/claude/codex) redraw themselves on SIGWINCH, so
    // defer the renderer swap until that redraw lands (writeTerminalOutput's
    // callback) — swapping mid-redraw can leave stale prompt-box glyphs.
    if (entry.term.buffer.active.type === 'alternate') {
      this.resetRenderer(entry, { immediate: false })
      return
    }
    // Normal-buffer shells (PowerShell etc.) do not redraw on resize; their text
    // lives only in xterm's buffer. Swap now.
    this.resetRenderer(entry, { immediate: true })
  }

  // Repaint a pane whose WebGL glyphs went stale after a maximize/restore by
  // dropping to xterm's DOM renderer. Disposing the WebGL addon calls
  // RenderService.setRenderer(), which sets _needsSelectionRefresh and forces a
  // full refresh — the DOM renderer then paints every visible cell from the
  // buffer we still hold. This is the reliable repaint.
  //
  // We do NOT re-upgrade to WebGL afterwards: a freshly created GL context paints
  // a blank surface for an idle pane (it never re-emits the existing buffer even
  // after a full refresh), which is the blank-pane bug. The DOM renderer stays;
  // it is more than adequate for a terminal pane. WebGL is only re-acquired if
  // the pane is disposed and recreated.
  //
  //  - immediate (normal shell): swap now.
  //  - deferred (alternate TUI): swap after the app's resize redraw arrives, so
  //    the DOM renderer captures the settled frame, not a transitional one.
  private resetRenderer(entry: Entry, options: { immediate: boolean }): void {
    if (!entry.opened || !entry.container) return
    if (options.immediate) {
      this.dropToDomRenderer(entry)
      this.redraw(entry)
      return
    }
    if (entry.rendererReloadPending) return
    entry.rendererReloadPending = true
    clearTimeout(entry.rendererReloadTimer)
    entry.rendererReloadTimer = window.setTimeout(() => this.performRendererReload(entry), RENDERER_RESET_SETTLE_MS)
  }

  // Force the pane onto a fresh DOM renderer and full-refresh it. Two cases:
  //  - WebGL still attached: disposing the addon calls RenderService.setRenderer()
  //    with a fresh DOM renderer (sets _needsSelectionRefresh + full refresh).
  //  - WebGL already gone (its context was lost while the pane was hidden at 0x0,
  //    so onContextLoss already disposed it): there is nothing to dispose, and the
  //    DOM renderer xterm swapped in was created against the 0x0 host and is stale.
  //    Re-install a fresh DOM renderer directly through xterm core so it lays out
  //    at the real size and full-refreshes — otherwise the pane stays blank.
  private dropToDomRenderer(entry: Entry): void {
    if (entry.webgl) {
      entry.webglContextLossDisposable?.dispose()
      entry.webglContextLossDisposable = undefined
      entry.webgl.dispose()
      entry.webgl = undefined
      return
    }
    const core = (entry.term as unknown as {
      _core?: {
        _renderService?: { setRenderer?: (r: unknown) => void }
        _createRenderer?: () => unknown
      }
    })._core
    const renderService = core?._renderService
    const createRenderer = core?._createRenderer
    if (renderService?.setRenderer && createRenderer) {
      renderService.setRenderer(createRenderer.call(core))
    }
  }

  // Deferred swap for alternate-buffer TUIs. Fires from writeTerminalOutput after
  // the app's resize redraw has landed (or a settle timeout), so the DOM renderer
  // full-refreshes the settled frame rather than a transitional one.
  private performRendererReload(entry: Entry): void {
    if (!entry.rendererReloadPending) return
    entry.rendererReloadPending = false
    clearTimeout(entry.rendererReloadTimer)
    entry.rendererReloadTimer = undefined
    if (this.entries.get(entry.paneId) !== entry || !entry.opened || !entry.container) return
    this.dropToDomRenderer(entry)
    this.redraw(entry)
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
    const preservedState: Uint8Array[] = []
    while (pending.length > 0 && pendingBytes > MAX_PENDING_OUTPUT_BYTES) {
      const dropped = pending.shift()
      if (!dropped) break
      pendingBytes -= dropped.byteLength
      // Dropped backlog may contain terminal-STATE changes (alt-screen enter/
      // leave, mouse modes, ...); losing those corrupts the emulator forever,
      // so replay them ahead of the retained output.
      preservedState.push(...terminalStateSequences(dropped))
      trimmed = true
    }
    if (preservedState.length > 0) {
      const merged = concatUint8Arrays(preservedState, preservedState.reduce((total, part) => total + part.byteLength, 0))
      pending.unshift(merged)
      pendingBytes += merged.byteLength
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
    // Drop output that a hard clear later in the same chunk would erase anyway,
    // but do NOT call entry.term.clear(): the retained bytes still start with the
    // clear sequence, and xterm interprets it natively and correctly — ESC[2J /
    // ESC[H ESC[J erase only the viewport (scrollback preserved), ESC[3J / RIS
    // clear scrollback too. term.clear() instead wiped scrollback unconditionally,
    // which destroyed a shell's history whenever it merely repainted on a resize
    // (e.g. a hidden pane getting SIGWINCH during a sibling's maximize).
    const output = terminalOutputAfterLastHardClear(bytes)
    // write() parses asynchronously; run any pending (deferred, alternate-buffer)
    // renderer reload only after xterm has applied this output — the app's resize
    // redraw — so the rebuilt renderer captures the settled cursor, not a ghost.
    entry.term.write(output.bytes, entry.rendererReloadPending ? () => this.performRendererReload(entry) : undefined)
  }

  private syncEntryPtySize(entry: Entry): void {
    if (entry.remoteWide) return
    const sessionId = entry.sessionId
    if (!sessionId || !entry.opened) return
    this.flushOutput(entry)
    const cols = entry.term.cols
    const rows = entry.term.rows
    if (entry.lastSentPtyCols === cols && entry.lastSentPtyRows === rows) return
    entry.lastSentPtyCols = cols
    entry.lastSentPtyRows = rows
    void invoke('resize_pane', { sessionId, paneId: entry.paneId, cols, rows })
  }

  private observeMeasureState(entry: Entry, rect: { width: number; height: number } | null | undefined): { measurable: boolean; forceFitForMeasure: boolean } {
    const nextMeasureState = terminalHostMeasureState(rect)
    const becameMeasurable = terminalHostBecameMeasurable(entry.measureState, nextMeasureState)
    entry.measureState = nextMeasureState
    if (nextMeasureState !== 'measurable') return { measurable: false, forceFitForMeasure: false }
    if (becameMeasurable) entry.forceFitOnNextMeasure = true
    const forceFitForMeasure = entry.forceFitOnNextMeasure === true
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
        // safeFit no-ops on a degenerate proposal; retry once geometry settles so
        // we never resize to 2x1 and corrupt the buffer.
        if (!this.safeFit(entry, forceFit)) {
          if (attempt < MAX_FIT_ATTEMPTS) this.fit(entry, attempt + 1, forceFit)
          else entry.forceFitOnNextMeasure = true
          return
        }
        // Pin to bottom ONLY when the viewport already sat at bottom. A forced
        // fit re-measures geometry; it must never yank the viewport away from a
        // user who scrolled up (click-to-select, split, tab toggle, resize).
        if (wasAtBottom) entry.term.scrollToBottom()
        this.redrawAfterNextFrame(entry, { clearWebglTextureAtlas: entry.webgl !== undefined })
        entry.forceFitOnNextMeasure = false
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

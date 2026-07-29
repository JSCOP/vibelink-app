import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { PaneFitAddon, showPaneScrollbar } from './scrollbar'
import { SearchAddon } from '@xterm/addon-search'
import type { ISearchOptions } from '@xterm/addon-search'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { terminalThemeById } from '../state/terminalThemes'
import { terminalFontStack } from '../state/fonts'
import { createTerminalOptions, defaultTerminalSettings, terminalLetterSpacing, terminalLineHeight, type TerminalVisualSettings } from './options'
import { terminalHostBecameMeasurable, terminalHostMeasureState, type TerminalHostMeasureState } from './geometry'
import { INTERACTIVE_FIT_FRAME_BUDGET_MS, interactivePassDelay, isViewportViable, shouldSyncPtyNow } from './layoutPassPolicy'
import { copyAllTerminalContents, copyTerminalSelection } from './copy'
import { createPathLinkProvider, createImageMarkerLinkProvider, type CaptureLinkActions } from './links'
import { terminalOutputAfterLastHardClear, terminalQuerySequences, terminalStateSequences } from './clearSequences'
import { agentActivityTracker, type AgentActivityActions } from './agentActivity'
import { refreshRemotePaneLease, type RemotePaneLeaseStatus, useRemotePaneLeaseStore } from '../remote/paneLease'
import { beginInteractiveResize, endInteractiveResize, isDividerResizeActive, type InteractiveResizeKind } from '../layout/interactiveResize'
import { PaneTitleCoalescer } from './titleCoalescing'
import { forceRepaintThroughRenderPause } from './renderPauseRelease'

const MAX_FIT_ATTEMPTS = 120
const MAX_OUTPUT_BYTES_PER_WRITE = 16 * 1024
const MAX_OUTPUT_WRITES_PER_DRAIN = 2
const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024
const HIGH_VOLUME_OUTPUT_DOM_THRESHOLD_BYTES = 64 * 1024
const WEBGL_REPROMOTION_QUIET_MS = 2_000
const BACKGROUND_OUTPUT_COALESCE_MS = 50
const OUTPUT_DRAIN_TIME_BUDGET_MS = 8
const OUTPUT_FLUSH_FALLBACK_MS = 250
const INSTANT_OUTPUT_BYTES = 4 * 1024
const MAX_REPLAY_BYTES_PER_FRAME = 64 * 1024
const MAX_CACHED_BACKGROUND_TERMINALS = 16
// A real terminal is never this small. If PaneFitAddon proposes fewer than these,
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
const MAX_PENDING_INPUT_BYTES = 256 * 1024
const inputEncoder = new TextEncoder()
// Pointer activation performs one lightweight renderer repair and, for full-
// screen TUIs, one temporary PTY row nudge. This reproduces the repaint effect
// of an Alt+Z maximize/restore cycle without moving Dockview geometry.
const CLICK_REPAIR_COOLDOWN_MS = 250
const CLICK_REPAIR_PTY_SETTLE_MS = 64
// A native window drag-resize emits a stream of `resize` events with no end
// event. Treat the interaction as finished once the stream goes quiet for this
// long, then run the settle pass. Divider drags end on pointerup instead.
const WINDOW_RESIZE_SETTLE_MS = 160
// Dockview's splitview builds its dividers as `.dv-sash` and drives them from a
// document-level pointermove, so a capture-phase pointerdown is the only place
// the drag can be observed before the layout storm starts.
const SASH_SELECTOR = '.dv-sash'
const MAX_DIVIDER_STABILITY_FRAMES = 8





export type TerminalSearchOptions = {
  caseSensitive?: boolean
  wholeWord?: boolean
  regex?: boolean
  incremental?: boolean
}

const SEARCH_DECORATION_COLORS = {
  matchBackground: '#39434f',
  matchOverviewRuler: '#8b949e',
  activeMatchBackground: '#ff9f1a',
  activeMatchColorOverviewRuler: '#ff9f1a',
}

const withSearchDecorations = (options?: TerminalSearchOptions): ISearchOptions => ({
  ...options,
  decorations: SEARCH_DECORATION_COLORS,
})

type WebglAddonInternals = {
  _renderer?: {
    _gl?: { getExtension(name: string): unknown }
    _canvas?: { width: number; height: number }
  }
}

function releaseXtermWebglContext(addon: WebglAddon): void {
  try {
    const renderer = (addon as unknown as WebglAddonInternals)._renderer
    const extension = renderer?._gl?.getExtension('WEBGL_lose_context')
    if (extension && typeof extension === 'object' && 'loseContext' in extension && typeof extension.loseContext === 'function') {
      extension.loseContext()
    }
    if (renderer?._canvas) {
      renderer._canvas.width = 0
      renderer._canvas.height = 0
    }
  } catch {
    // WebGL teardown must never block fallback to xterm's DOM renderer.
  }
}

type PendingInputChunk = { data: string; bytes: number }
type SnapshotCursorQuery = 'standard' | 'private'

function snapshotCursorQueries(bytes: Uint8Array): SnapshotCursorQuery[] {
  const queries: SnapshotCursorQuery[] = []
  for (let index = 0; index + 3 < bytes.byteLength; index += 1) {
    if (bytes[index] !== 0x1b || bytes[index + 1] !== 0x5b) continue
    const privateQuery = bytes[index + 2] === 0x3f
    const parameterOffset = privateQuery ? index + 3 : index + 2
    if (bytes[parameterOffset] !== 0x36 || bytes[parameterOffset + 1] !== 0x6e) continue
    queries.push(privateQuery ? 'private' : 'standard')
    index = parameterOffset + 1
  }
  return queries
}

function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39
}

function hasCursorResponse(input: readonly string[], query: SnapshotCursorQuery): boolean {
  return input.some((value) => {
    for (let start = 0; start < value.length - 5; start += 1) {
      if (value.charCodeAt(start) !== 0x1b || value.charCodeAt(start + 1) !== 0x5b) continue
      let cursor = start + 2
      if (query === 'private') {
        if (value.charCodeAt(cursor) !== 0x3f) continue
        cursor += 1
      } else if (value.charCodeAt(cursor) === 0x3f) {
        continue
      }

      const rowStart = cursor
      while (isAsciiDigit(value.charCodeAt(cursor))) cursor += 1
      if (cursor === rowStart || value.charCodeAt(cursor) !== 0x3b) continue
      cursor += 1

      const columnStart = cursor
      while (isAsciiDigit(value.charCodeAt(cursor))) cursor += 1
      if (cursor > columnStart && value.charCodeAt(cursor) === 0x52) return true
    }
    return false
  })
}


type SequencedOutputFrame = {
  paneGeneration: bigint
  outputSequence: bigint
  bytes: Uint8Array
}

type TerminalSnapshotResult = {
  sessionId: string
  paneId: string
  paneGeneration: string
  outputSequence: string
  cols: number
  rows: number
  alive: boolean
  dataBase64: string
}

type Entry = {
  paneId: string
  term: Terminal
  fit: PaneFitAddon
  search: SearchAddon
  opened: boolean
  daemonAttached: boolean
  dataWired: boolean
  sessionId?: string
  pendingInput?: PendingInputChunk[]
  pendingInputBytes?: number
  inputTrimNoticeWritten?: boolean
  attachFailureNoticeWritten?: boolean
  daemonGeneration: number
  attachingSessionId?: string
  attachPromise?: Promise<void>
  inputFlush?: Promise<void>
  replayInputCapture?: string[]
  observer?: ResizeObserver
  fitFrame?: number
  rendererReloadPending?: boolean
  rendererReloadTimer?: number
  clickRepairTimer?: number
  lastClickRepairAt?: number

  pendingOutput?: Uint8Array[]
  pendingOutputBytes?: number
  outputHighPriority?: boolean
  pendingSequencedOutput?: SequencedOutputFrame[]
  pendingSequencedOutputBytes?: number
  paneGeneration?: bigint
  outputSequence?: bigint
  replayPending?: boolean
  replayPromise?: Promise<void>
  replayRevision?: number
  replayAgain?: boolean
  replayedContainer?: HTMLElement
  visible?: boolean
  lastUsedAt: number
  fitForcePending?: boolean
  measureState?: TerminalHostMeasureState
  forceFitOnNextMeasure?: boolean
  rendererResetPending?: boolean
  lastFitRect?: { width: number; height: number }
  /** Last size reported by this pane's ResizeObserver, so the layout pass does
   *  not have to force a synchronous layout to re-measure it. */
  observedSize?: { width: number; height: number }
  /** One pending Orca-style stability probe before fitting this pane's real
   *  xterm grid during a divider drag. */
  dividerFitFrame?: number
  lastSentPtyCols?: number
  lastSentPtyRows?: number
  /** When this pane last sent `resize_pane`; rate-limits PTY resizes during a drag. */
  lastPtySyncAt?: number
  remoteLease?: boolean
  remoteResizeGeneration?: number
  container?: HTMLElement
  titleDisposable?: { dispose: () => void }
  linkDisposables?: { dispose(): void }[]
  outputTrimNoticeWritten?: boolean
  /** Whether this pane's xterm scrollbar was switched to always-visible. */
  scrollbarPersistent?: boolean
  webgl?: WebglAddon
  webglAttachFailed?: boolean
  webglPromotionPending?: boolean
  webglPromotionTimer?: number
  demotedForOutputBurst?: boolean
  webglContextLossDisposable?: { dispose(): void }
  titleHandler?: (title: string) => void
}

class TerminalManagerImpl {
  private entries = new Map<string, Entry>()
  private settings: TerminalVisualSettings = defaultTerminalSettings
  private linkActions: CaptureLinkActions = { onOpenPath: () => {}, resolveMarker: () => undefined }
  private pendingPass = new Map<string, { fit: boolean; syncPty: boolean; force: boolean; repaint: boolean; clearWebglTextureAtlas: boolean }>()
  private passFrame: number | undefined
  private passTimer: number | undefined
  private lastPassAt: number | undefined
  /** Wall-clock cost of the last interactive fit pass. Drives the adaptive
   *  throttle: the pass is cheap for idle panes and expensive for panes holding
   *  scrollback, because a column change reflows the whole buffer. */
  private lastPassDurationMs: number | undefined
  // Non-zero while a divider drag or a native window drag-resize is in flight.
  private interactionDepth = 0
  private dividerResizePaneIds = new Set<string>()
  private windowResizeTimer: number | undefined
  private viewportViable = true
  private outputQueue: Entry[] = []
  private queuedOutputPaneIds = new Set<string>()
  private outputFrame: number | undefined
  private outputDelayTimer: number | undefined
  private outputDelayDueAt: number | undefined
  private outputFallbackTimer: number | undefined
  private titleCoalescer = new PaneTitleCoalescer()
  private replayTail: Promise<void> = Promise.resolve()
  private wakeRecoveryFrame: number | undefined
  private settledWakeClearsAtlas = false
  private webviewRenderMode: 'software' | 'hardware' | '' = ''

  constructor() {
    if (typeof document !== 'undefined') document.addEventListener('pointerdown', this.handlePointerDown, true)
    if (typeof window !== 'undefined') window.addEventListener('resize', this.handleWindowResize)
    this.installWakeRecoveryListeners()
    this.loadWebviewRenderMode()
  }

  private loadWebviewRenderMode(): void {
    void invoke<unknown>('webview_render_mode')
      .then((mode) => {
        this.webviewRenderMode = mode === 'software' || mode === 'hardware' ? mode : ''
      })
      .catch(() => {})
  }

  private installWakeRecoveryListeners(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    const wakeGlobal = globalThis as typeof globalThis & { __vibelinkTerminalWakeCleanup?: () => void }
    wakeGlobal.__vibelinkTerminalWakeCleanup?.()
    let disposed = false
    let systemUnlisten: (() => void) | undefined
    const onFocus = () => {
      // Plain refocus keeps the glyph atlas warm and lets ordinary rect guards
      // decide whether geometry changed; only the pane pixels are re-presented.
      this.reflowAll()
      this.recoverVisibleWake(false)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState !== 'visible') return
      this.settleLayout({ repaint: true, clearWebglTextureAtlas: true })
      this.recoverVisibleWake(true)
    }
    const onSystemResumed = () => {
      if (document.visibilityState !== 'visible') return
      this.settleLayout({ repaint: true, clearWebglTextureAtlas: true })
      this.recoverVisibleWake(true)
    }
    const cleanup = () => {
      if (disposed) return
      disposed = true
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      systemUnlisten?.()
      if (this.wakeRecoveryFrame !== undefined) cancelAnimationFrame(this.wakeRecoveryFrame)
      this.wakeRecoveryFrame = undefined
      this.settledWakeClearsAtlas = false
    }

    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibilityChange)
    wakeGlobal.__vibelinkTerminalWakeCleanup = cleanup
    void listen('system-resumed', onSystemResumed)
      .then((unlisten) => {
        if (disposed) unlisten()
        else systemUnlisten = unlisten
      })
      .catch(() => {})
  }

  private recoverVisibleWake(clearWebglTextureAtlas: boolean): void {
    if (this.wakeRecoveryFrame !== undefined) {
      this.settledWakeClearsAtlas ||= clearWebglTextureAtlas
      return
    }
    this.redrawVisibleWake(clearWebglTextureAtlas)
    this.settledWakeClearsAtlas = clearWebglTextureAtlas
    this.wakeRecoveryFrame = requestAnimationFrame(() => {
      this.wakeRecoveryFrame = undefined
      const settledClear = this.settledWakeClearsAtlas
      this.settledWakeClearsAtlas = false
      if (document.visibilityState !== 'visible') return
      this.redrawVisibleWake(settledClear)
    })
  }

  private redrawVisibleWake(clearWebglTextureAtlas: boolean): void {
    for (const entry of this.entries.values()) {
      if (!entry.opened || entry.visible !== true || entry.remoteLease) continue
      const retryAfterContextLoss = entry.webgl === undefined && entry.webglAttachFailed === true
      if (retryAfterContextLoss) entry.webglAttachFailed = false
      const promoted = (retryAfterContextLoss || this.shouldPromoteQuietWebgl(entry))
        && this.promoteToWebglRenderer(entry)
      if (!promoted) this.redraw(entry, { clearWebglTextureAtlas })
    }
  }

  /** Dockview drives its sash from a document-level pointermove, so the drag is
   *  observed here rather than through a Dockview API. */
  private handlePointerDown = (event: PointerEvent): void => {
    const target = event.target
    if (!(target instanceof Element)) return
    const sash = target.closest<HTMLElement>(SASH_SELECTOR)
    if (!sash) return
    this.beginInteraction('divider')
    // Mirror the exact set of end triggers Dockview's own sash uses, so this
    // interaction can never outlive the drag it is throttling.
    const end = () => {
      document.removeEventListener('pointerup', end, true)
      document.removeEventListener('pointercancel', end, true)
      document.removeEventListener('contextmenu', end, true)
      this.endInteraction('divider')
    }
    document.addEventListener('pointerup', end, true)
    document.addEventListener('pointercancel', end, true)
    document.addEventListener('contextmenu', end, true)
  }

  private handleWindowResize = (): void => {
    const viable = isViewportViable({ width: window.innerWidth, height: window.innerHeight })
    const becameViable = viable && !this.viewportViable
    this.viewportViable = viable
    // Minimizing collapses the webview to a degenerate viewport; refitting every
    // pane to that and back on restore is the blank-then-rebuild flash.
    if (!viable) return
    if (this.windowResizeTimer === undefined) this.beginInteraction('window')
    else window.clearTimeout(this.windowResizeTimer)
    this.windowResizeTimer = window.setTimeout(() => {
      this.windowResizeTimer = undefined
      this.endInteraction('window')
    }, WINDOW_RESIZE_SETTLE_MS)
    // Restore from minimize: the panes were held back at a degenerate viewport
    // and may hold nothing paintable, so this resume does repaint.
    if (becameViable) this.settleLayout({ repaint: true })
  }

  private beginInteraction(kind: InteractiveResizeKind): void {
    beginInteractiveResize(kind)
    if (kind === 'divider') this.dividerResizePaneIds.clear()
    this.interactionDepth += 1
    if (this.interactionDepth > 1) return
    // A cost sampled from a previous gesture describes a layout that no longer
    // exists (different pane count, different buffers). Start each gesture at
    // the floor and let the first real pass re-measure.
    this.lastPassDurationMs = undefined
    this.markInteracting(true)
  }

  private endInteraction(kind: InteractiveResizeKind): void {
    if (this.interactionDepth === 0) return
    this.interactionDepth -= 1
    // Publish the end BEFORE the settle pass: layout owners re-run the
    // reposition/persist work they withheld during the drag, and the pass
    // scheduled below then fits terminals to that final geometry.
    endInteractiveResize(kind)
    if (this.interactionDepth > 0) return
    const dividerPaneIds = kind === 'divider' ? [...this.dividerResizePaneIds] : undefined
    if (kind === 'divider') {
      for (const paneId of dividerPaneIds ?? []) {
        const entry = this.entries.get(paneId)
        if (entry?.dividerFitFrame === undefined) continue
        cancelAnimationFrame(entry.dividerFitFrame)
        entry.dividerFitFrame = undefined
      }
      this.dividerResizePaneIds.clear()
    }
    this.markInteracting(false)
    this.settleLayout({ paneIds: dividerPaneIds?.length ? dividerPaneIds : undefined })
  }

  /** Terminals stop taking pointer events for the duration of the interaction.
   *  xterm's own mousemove handler measures the screen element to map the
   *  pointer to a cell, and a divider drag sweeps the pointer straight across
   *  the panes — that measurement was a top-three cost in the drag profile and
   *  buys nothing while the pointer belongs to the sash. */
  private markInteracting(active: boolean): void {
    if (typeof document === 'undefined') return
    document.documentElement.classList.toggle('vibelink-interacting', active)
  }

  /** Match Orca's resize contract: Dockview owns live geometry while each pane
   *  waits for a stable grid proposal before doing a real local xterm fit.
   *  Continuous motion is bounded, so a pane cannot remain visually stale for
   *  more than a handful of frames. PTY synchronization stays held separately. */
  private requestStableDividerFit(entry: Entry): void {
    if (!isDividerResizeActive() || !entry.opened || entry.remoteLease) return
    this.dividerResizePaneIds.add(entry.paneId)
    if (entry.dividerFitFrame !== undefined) return
    let previous = entry.fit.proposeDimensions()
    let frames = 0
    const waitForStableGrid = () => {
      entry.dividerFitFrame = requestAnimationFrame(() => {
        entry.dividerFitFrame = undefined
        if (!isDividerResizeActive() || this.entries.get(entry.paneId) !== entry || !entry.opened) return
        const next = entry.fit.proposeDimensions()
        frames += 1
        const stable =
          !next ||
          (entry.term.cols === next.cols && entry.term.rows === next.rows) ||
          (previous?.cols === next.cols && previous.rows === next.rows) ||
          frames >= MAX_DIVIDER_STABILITY_FRAMES
        if (!stable) {
          previous = next
          waitForStableGrid()
          return
        }
        this.scheduleLayoutPass({ paneIds: [entry.paneId] })
      })
    }
    waitForStableGrid()
  }

  private get interactive(): boolean {
    return this.interactionDepth > 0
  }

  /** One authoritative pass after an interaction ends: force the fit and send
   *  the PTY size that was held back while the pointer was down. Divider drags
   *  settle only panes whose ResizeObserver marked them dirty; native window
   *  resizes and visibility recovery still settle every pane. `repaint` is
   *  reserved for panes that may have missed draws entirely. */
  private settleLayout(options: { paneIds?: string[]; repaint?: boolean; clearWebglTextureAtlas?: boolean } = {}): void {
    this.scheduleLayoutPass({
      paneIds: options.paneIds,
      force: true,
      repaint: options.repaint,
      syncPty: true,
      clearWebglTextureAtlas: options.clearWebglTextureAtlas,
    })
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
      if (fontChanged) this.fitAfterFontsLoad(entry)
      if (fontChanged || themeChanged || cursorChanged) this.redrawAfterNextFrame(entry)
      this.fit(entry, 0, true)
    }
  }
  getOrCreate(paneId: string): Entry {
    const existing = this.entries.get(paneId)
    if (existing) return existing

    const term = new Terminal(createTerminalOptions(this.settings))
    const fit = new PaneFitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
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

    const entry: Entry = { paneId, term, fit, search, opened: false, daemonAttached: false, dataWired: false, daemonGeneration: 0, remoteLease: Boolean(useRemotePaneLeaseStore.getState().leases[paneId]), visible: false, lastUsedAt: Date.now() }
    this.entries.set(paneId, entry)
    entry.linkDisposables = [
      term.registerLinkProvider(createPathLinkProvider(term, () => this.linkActions)),
      term.registerLinkProvider(createImageMarkerLinkProvider(term, paneId, () => this.linkActions)),
    ]
    return entry
  }


  attach(paneId: string, container: HTMLElement, options: { sessionId?: string; onTitleChange?: (title: string) => void } = {}): void {
    const entry = this.getOrCreate(paneId)
    entry.lastUsedAt = Date.now()
    const previousSessionId = entry.sessionId
    entry.sessionId = options.sessionId
    const sessionChanged = previousSessionId !== options.sessionId
    if (sessionChanged) {
      entry.daemonAttached = false
      entry.paneGeneration = undefined
      entry.outputSequence = undefined
      entry.replayRevision = (entry.replayRevision ?? 0) + 1
    }
    // Dockview re-parents panes on maximize/restore and pane swaps; a size
    // observed against the old container must not survive into the new one.
    if (entry.container !== container) {
      if (entry.dividerFitFrame !== undefined) cancelAnimationFrame(entry.dividerFitFrame)
      entry.dividerFitFrame = undefined
      entry.observedSize = undefined
    }
    if (previousSessionId && previousSessionId !== options.sessionId) {
      entry.daemonGeneration += 1
      entry.daemonAttached = false
      entry.attachingSessionId = undefined
    }
    entry.container = container
    entry.term.options.theme = terminalThemeById(this.settings.terminalThemeId)
    if (!entry.opened) {
      entry.term.open(container)
      entry.opened = true
    } else if (entry.term.element && entry.term.element.parentElement !== container) {
      container.appendChild(entry.term.element)
      this.redraw(entry)
    }

    if (entry.opened) this.loadWebglRenderer(entry)
    this.ensurePersistentScrollbar(entry)

    if (!entry.dataWired) {
      entry.term.onData((data) => {
        const replayGenerated = entry.replayInputCapture !== undefined
        entry.replayInputCapture?.push(data)
        if (entry.remoteLease) return
        // OMP 17.1+ renders its interactive TUI in xterm's normal buffer.
        // AgentActivityTracker already capability-gates the pane, so buffer
        // type must not suppress prompt tracking for inline agent renderers.
        if (!replayGenerated) agentActivityTracker.noteUserInput(paneId, data)
        this.enqueueInput(entry, data)
      })
      entry.term.onResize(({ cols, rows }) => {
        if (entry.remoteLease || isDividerResizeActive()) return
        const sessionId = entry.sessionId
        if (!sessionId || (entry.lastSentPtyCols === cols && entry.lastSentPtyRows === rows)) return
        // Native window resizing can walk the grid through intermediate sizes.
        // Divider drags hold every SIGWINCH until pointerup; other interactive
        // paths retain the adaptive PTY rate limit.
        if (!shouldSyncPtyNow({ interactive: this.interactive, syncPtyRequested: true, now: Date.now(), lastPtySyncAt: entry.lastPtySyncAt })) return
        entry.lastSentPtyCols = cols
        entry.lastSentPtyRows = rows
        entry.lastPtySyncAt = Date.now()
        void invoke('resize_pane', { sessionId, paneId, cols, rows })
      })
      entry.dataWired = true
    }

    if (entry.titleHandler !== options?.onTitleChange) {
      entry.titleDisposable?.dispose()
      entry.titleHandler = options?.onTitleChange
      // Agent spinners rewrite the OSC title every animation frame. Route them
      // through the coalescer so an animated title cannot generate blocking
      // `set_pane_title` IPC per frame on the socket that also carries typing.
      entry.titleDisposable = options?.onTitleChange
        ? entry.term.onTitleChange((title) => {
          this.titleCoalescer.submit(paneId, title, (coalesced) => entry.titleHandler?.(coalesced))
        })
        : undefined
    }

    if (options.sessionId && previousSessionId !== options.sessionId) {
      // Fit synchronously before the acknowledged daemon attach so replay
      // parses at the pane's real geometry instead of the constructor default.
      this.safeFit(entry)
      this.beginDaemonAttach(entry, options.sessionId)
    } else if (options.sessionId && !entry.daemonAttached && entry.attachingSessionId !== options.sessionId) {
      this.beginDaemonAttach(entry, options.sessionId)
    }

    entry.observer?.disconnect()
    entry.observer = new ResizeObserver((observed) => {
      const box = observed[observed.length - 1]?.contentRect
      if (box) entry.observedSize = { width: box.width, height: box.height }
      if (isDividerResizeActive()) {
        this.requestStableDividerFit(entry)
        return
      }
      this.scheduleLayoutPass({ paneIds: [paneId] })
    })
    entry.observer.observe(container)
    // Output held while the terminal was unopened parses now, after the
    // synchronous fit above sized the grid to the real host. Route every pane
    // through the shared drain so restoring a busy workspace cannot make all
    // xterm instances parse and paint their replay in the same frame.
    if (entry.pendingOutput?.length && !entry.replayPending) {
      this.safeFit(entry)
      this.enqueueOutput(entry, this.isForegroundOutput(entry))
    }
    this.scheduleLayoutPass({ paneIds: [paneId], force: true })
    this.fitAfterFontsLoad(entry)
  }

  reattachToDaemon(
    sessionId: string | undefined,
    paneIds: string[],
    options: { force?: boolean } = {},
  ): void {
    if (!sessionId) return
    const force = options.force ?? true
    const entries = paneIds
      .map((paneId) => this.entries.get(paneId))
      .filter((entry): entry is Entry => entry !== undefined)
      .sort((left, right) => Number(this.isForegroundOutput(right)) - Number(this.isForegroundOutput(left)))
    for (const entry of entries) {
      const sameSession = entry.sessionId === sessionId
      const replayAlreadyPending = !force && sameSession && entry.replayPending
      entry.sessionId = sessionId
      entry.lastUsedAt = Date.now()
      if (force || !sameSession) {
        entry.paneGeneration = undefined
        entry.outputSequence = undefined
        entry.replayRevision = (entry.replayRevision ?? 0) + 1
      }
      this.beginDaemonAttach(entry, sessionId, !replayAlreadyPending)
    }
  }

  async waitForReplay(sessionId: string | undefined, paneIds: string[]): Promise<void> {
    if (!sessionId) return
    for (;;) {
      const pending = paneIds
        .map((paneId) => this.entries.get(paneId))
        .filter((entry): entry is Entry => entry?.sessionId === sessionId)
        .flatMap((entry) => [entry.attachPromise, entry.replayPromise])
        .filter((promise): promise is Promise<void> => promise !== undefined)
      if (pending.length === 0) return
      await Promise.allSettled(pending)
      await Promise.resolve()
    }
  }

  adoptRemoteResize(paneId: string, cols: number, rows: number): void {
    const entry = this.entries.get(paneId)
    // The daemon broadcasts `PaneResized` to EVERY attached client, including
    // the one that asked for it, so a purely local divider drag is echoed
    // straight back at us. Adopting that echo is not free: it runs a
    // `remote_get_pane_lease` IPC round trip per pane per resize and then
    // `restoreDesktopFit`, which force-fits and repaints. Measured on an
    // 8-pane drag: 70 adoptions, 70 of them echoes of a size this pane had
    // just sent, zero of them holding a lease. A size we already sent tells
    // us nothing new, so drop it before the round trip.
    if (entry && entry.lastSentPtyCols === cols && entry.lastSentPtyRows === rows) return
    const generation = (entry?.remoteResizeGeneration ?? 0) + 1
    if (entry) entry.remoteResizeGeneration = generation
    void refreshRemotePaneLease(paneId).then((lease) => {
      const current = this.entries.get(paneId)
      if (!current || current.remoteResizeGeneration !== generation) return
      if (lease) {
        current.remoteLease = true
        current.lastSentPtyCols = cols
        current.lastSentPtyRows = rows
        if (current.term.cols !== cols || current.term.rows !== rows) current.term.resize(cols, rows)
        this.redrawAfterNextFrame(current)
        return
      }
      current.remoteLease = false
      current.lastSentPtyCols = undefined
      current.lastSentPtyRows = undefined
      this.restoreDesktopFit(current)
    }).catch(() => {
      const current = this.entries.get(paneId)
      if (!current || current.remoteResizeGeneration !== generation || current.remoteLease) return
      current.lastSentPtyCols = undefined
      current.lastSentPtyRows = undefined
      this.restoreDesktopFit(current)
    })
  }

  setRemotePaneLease(paneId: string, lease: RemotePaneLeaseStatus | null): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.remoteLease = lease !== null
    entry.lastSentPtyCols = undefined
    entry.lastSentPtyRows = undefined
    if (lease) {
      clearTimeout(entry.clickRepairTimer)
      entry.clickRepairTimer = undefined
      if (entry.term.cols !== lease.cols || entry.term.rows !== lease.rows) entry.term.resize(lease.cols, lease.rows)
      this.redrawAfterNextFrame(entry)
      return
    }
    this.flushPendingInput(entry)
    this.restoreDesktopFit(entry)
  }


  /** Queue every input chunk until attach and each daemon write are acknowledged.
   *  The first chunk is removed only after its matching write succeeds. */
  private enqueueInput(entry: Entry, data: string): void {
    const bytes = inputEncoder.encode(data).byteLength
    entry.pendingInput ??= []
    const pendingBytes = entry.pendingInputBytes ?? 0
    if (entry.pendingInput.length >= MAX_PENDING_INPUT_CHUNKS || pendingBytes + bytes > MAX_PENDING_INPUT_BYTES) {
      if (!entry.inputTrimNoticeWritten) {
        entry.term.write('\r\n\x1b[33m[input buffer full; additional input dropped]\x1b[0m\r\n')
        entry.inputTrimNoticeWritten = true
      }
      return
    }
    entry.pendingInput.push({ data, bytes })
    entry.pendingInputBytes = pendingBytes + bytes
    this.flushPendingInput(entry)
  }

  private beginDaemonAttach(entry: Entry, sessionId: string, replay = true): void {
    entry.daemonGeneration += 1
    const generation = entry.daemonGeneration
    entry.daemonAttached = false
    entry.attachingSessionId = sessionId
    const attach = invoke('attach_pane', { sessionId, paneId: entry.paneId }).then(() => {
      const current = this.entries.get(entry.paneId)
      if (current !== entry || entry.daemonGeneration !== generation || entry.sessionId !== sessionId) return
      entry.attachingSessionId = undefined
      entry.daemonAttached = true
      entry.attachFailureNoticeWritten = false
      if (replay) this.requestSnapshotReplay(entry)
      this.flushPendingInput(entry)
    }).catch(() => {
      const current = this.entries.get(entry.paneId)
      if (current !== entry || entry.daemonGeneration !== generation || entry.sessionId !== sessionId) return
      entry.attachingSessionId = undefined
      entry.daemonAttached = false
      if (!entry.attachFailureNoticeWritten) {
        entry.term.write('\r\n\x1b[33m[terminal attach failed; input retained for retry]\x1b[0m\r\n')
        entry.attachFailureNoticeWritten = true
      }
    })
    entry.attachPromise = attach
    void attach.finally(() => {
      if (this.entries.get(entry.paneId) === entry && entry.attachPromise === attach) entry.attachPromise = undefined
    })

  }

  private flushPendingInput(entry: Entry): void {
    if (entry.remoteLease || !entry.sessionId || !entry.daemonAttached || !entry.pendingInput?.length || entry.inputFlush) return
    const generation = entry.daemonGeneration
    const sessionId = entry.sessionId
    const flush = this.flushInputLoop(entry, sessionId, generation)
    entry.inputFlush = flush
    void flush.finally(() => {
      const current = this.entries.get(entry.paneId)
      if (current !== entry || entry.inputFlush !== flush) return
      entry.inputFlush = undefined
      if (!entry.pendingInput?.length) entry.inputTrimNoticeWritten = false
      else if (entry.daemonAttached) this.flushPendingInput(entry)
    })
  }

  private async flushInputLoop(entry: Entry, sessionId: string, generation: number): Promise<void> {
    while (entry.pendingInput?.length) {
      if (this.entries.get(entry.paneId) !== entry || entry.daemonGeneration !== generation || entry.sessionId !== sessionId || !entry.daemonAttached) return
      const chunk = entry.pendingInput[0]
      try {
        await invoke('write_pane', { sessionId, paneId: entry.paneId, data: chunk.data })
      } catch {
        if (this.entries.get(entry.paneId) === entry && entry.daemonGeneration === generation && entry.sessionId === sessionId) {
          entry.daemonAttached = false
          entry.attachingSessionId = undefined
          if (!entry.attachFailureNoticeWritten) {
            entry.term.write('\r\n\x1b[33m[terminal write failed; input retained for retry]\x1b[0m\r\n')
            entry.attachFailureNoticeWritten = true
          }
        }
        return
      }
      if (this.entries.get(entry.paneId) !== entry || entry.daemonGeneration !== generation || entry.sessionId !== sessionId || entry.pendingInput[0] !== chunk) return
      entry.pendingInput.shift()
      entry.pendingInputBytes = Math.max(0, (entry.pendingInputBytes ?? 0) - chunk.bytes)
      if (entry.pendingInput.length === 0) entry.pendingInput = undefined
    }
  }

  private requestSnapshotReplay(entry: Entry): void {
    const sessionId = entry.sessionId
    if (!sessionId || !entry.opened) return
    if (entry.replayPromise) {
      entry.replayAgain = true
      return
    }

    entry.replayPending = true
    entry.replayAgain = false
    const revision = entry.replayRevision ?? 0
    const run = this.replayTail
      .catch(() => undefined)
      .then(() => this.replayPane(entry, sessionId, revision))
    const tracked = run.finally(() => {
      if (entry.replayPromise !== tracked) return
      entry.replayPromise = undefined
      entry.replayPending = false
      if (!entry.replayAgain) return
      entry.replayAgain = false
      queueMicrotask(() => {
        if (this.entries.get(entry.paneId) === entry) this.requestSnapshotReplay(entry)
      })
    })
    entry.replayPromise = tracked
    this.replayTail = tracked.catch(() => undefined)
  }

  private async replayPane(entry: Entry, sessionId: string, revision: number): Promise<void> {
    try {
      const snapshot = await invoke<TerminalSnapshotResult>('subscribe_pane', {
        sessionId,
        paneId: entry.paneId,
      })
      if (this.entries.get(entry.paneId) !== entry
        || entry.sessionId !== sessionId
        || (entry.replayRevision ?? 0) !== revision) return
      if (snapshot.sessionId !== sessionId || snapshot.paneId !== entry.paneId) {
        throw new Error('terminal snapshot identity mismatch')
      }

      const paneGeneration = BigInt(snapshot.paneGeneration)
      const outputSequence = BigInt(snapshot.outputSequence)
      const retainedSnapshotCurrent = entry.opened
        && entry.paneGeneration === paneGeneration
        && entry.outputSequence === outputSequence
      this.removeQueuedOutput(entry)
      entry.pendingOutput = undefined
      entry.pendingOutputBytes = 0
      entry.outputTrimNoticeWritten = false
      entry.lastSentPtyCols = snapshot.cols
      entry.lastSentPtyRows = snapshot.rows
      if (entry.term.cols !== snapshot.cols || entry.term.rows !== snapshot.rows) {
        entry.term.resize(snapshot.cols, snapshot.rows)
      }
      entry.paneGeneration = paneGeneration
      entry.outputSequence = outputSequence
      entry.daemonAttached = true
      if (!retainedSnapshotCurrent) {
        entry.term.reset()
        await this.writeReplayBytes(entry, decodeBase64Bytes(snapshot.dataBase64))
      }

      for (;;) {
        const frames = entry.pendingSequencedOutput ?? []
        entry.pendingSequencedOutput = undefined
        entry.pendingSequencedOutputBytes = 0
        if (frames.length === 0) break

        const coveredChunks: Uint8Array[] = []
        let coveredBytes = 0
        const liveChunks: Uint8Array[] = []
        let liveBytes = 0
        for (let index = 0; index < frames.length; index += 1) {
          const frame = frames[index]
          if (frame.paneGeneration === entry.paneGeneration
            && frame.outputSequence <= outputSequence) {
            coveredChunks.push(frame.bytes)
            coveredBytes += frame.bytes.byteLength
            continue
          }
          if (frame.paneGeneration === entry.paneGeneration
            && frame.outputSequence <= (entry.outputSequence ?? 0n)) continue
          if (frame.paneGeneration !== entry.paneGeneration
            || frame.outputSequence !== (entry.outputSequence ?? 0n) + 1n) {
            for (const pending of frames.slice(index)) this.queueSequencedOutput(entry, pending)
            entry.replayAgain = true
            break
          }
          entry.outputSequence = frame.outputSequence
          liveChunks.push(frame.bytes)
          liveBytes += frame.bytes.byteLength
        }

        const queryChunks = coveredBytes > 0
          ? terminalQuerySequences(concatUint8Arrays(coveredChunks, coveredBytes))
          : []
        const queryBytes = queryChunks.reduce((total, chunk) => total + chunk.byteLength, 0)
        if (queryBytes + liveBytes > 0) {
          await this.writeReplayBytes(
            entry,
            concatUint8Arrays([...queryChunks, ...liveChunks], queryBytes + liveBytes),
          )
        }
        if (entry.replayAgain) break
      }

      entry.replayedContainer = entry.container
      entry.forceFitOnNextMeasure = true
      if (!retainedSnapshotCurrent) entry.rendererResetPending = true
      this.scheduleLayoutPass({
        paneIds: [entry.paneId],
        force: true,
        repaint: true,
        syncPty: true,
        clearWebglTextureAtlas: !retainedSnapshotCurrent,
      })
      if (!retainedSnapshotCurrent) this.nudgeAlternateBuffer(entry)
      if (!snapshot.alive) this.markExited(entry.paneId)
    } catch {
      if (this.entries.get(entry.paneId) === entry && entry.sessionId === sessionId) {
        entry.daemonAttached = false
      }
    }
  }

  private async writeReplayBytes(entry: Entry, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return
    const replayBytes = terminalOutputAfterLastHardClear(bytes).bytes
    const generatedInput: string[] = []
    entry.replayInputCapture = generatedInput
    try {
      for (let offset = 0; offset < replayBytes.byteLength; offset += MAX_REPLAY_BYTES_PER_FRAME) {
        if (this.entries.get(entry.paneId) !== entry) return
        const chunk = replayBytes.subarray(offset, Math.min(offset + MAX_REPLAY_BYTES_PER_FRAME, replayBytes.byteLength))
        const { promise, resolve } = Promise.withResolvers<void>()
        entry.term.write(chunk, () => {
          if (entry.rendererReloadPending) this.performRendererReload(entry)
          resolve()
        })
        await promise
        if (offset + chunk.byteLength < replayBytes.byteLength) await this.yieldReplayFrame()
      }
    } finally {
      entry.replayInputCapture = undefined
    }

    if (entry.remoteLease) return
    const queries = new Set(snapshotCursorQueries(replayBytes))
    const row = entry.term.buffer.active.cursorY + 1
    const column = entry.term.buffer.active.cursorX + 1
    for (const query of queries) {
      if (hasCursorResponse(generatedInput, query)) continue
      const prefix = query === 'private' ? '?' : ''
      this.enqueueInput(entry, `\x1b[${prefix}${row};${column}R`)
    }
  }

  private yieldReplayFrame(): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>()
    if (typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') {
      setTimeout(resolve, 0)
      return promise
    }
    let settled = false
    let frame = 0
    const finish = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      if (frame) cancelAnimationFrame(frame)
      resolve()
    }
    const timeout = window.setTimeout(finish, 32)
    frame = requestAnimationFrame(finish)
    return promise
  }

  private queueSequencedOutput(entry: Entry, frame: SequencedOutputFrame): void {
    entry.pendingSequencedOutput ??= []
    entry.pendingSequencedOutput.push(frame)
    entry.pendingSequencedOutputBytes = (entry.pendingSequencedOutputBytes ?? 0) + frame.bytes.byteLength
    while ((entry.pendingSequencedOutputBytes ?? 0) > MAX_PENDING_OUTPUT_BYTES
      && entry.pendingSequencedOutput.length > 1) {
      const dropped = entry.pendingSequencedOutput.shift()
      if (!dropped) break
      entry.pendingSequencedOutputBytes = Math.max(
        0,
        (entry.pendingSequencedOutputBytes ?? 0) - dropped.bytes.byteLength,
      )
    }
  }

  writeSequenced(
    paneId: string,
    paneGeneration: bigint,
    outputSequence: bigint,
    bytes: Uint8Array,
  ): void {
    if (bytes.byteLength === 0) return
    agentActivityTracker.noteOutput(paneId, bytes)
    const entry = this.getOrCreate(paneId)
    const frame = { paneGeneration, outputSequence, bytes }
    if (!entry.opened
      || !entry.sessionId
      || !entry.daemonAttached
      || entry.replayPending
      || entry.paneGeneration === undefined
      || entry.outputSequence === undefined) {
      this.queueSequencedOutput(entry, frame)
      if (entry.opened && entry.sessionId && entry.daemonAttached && !entry.replayPending) {
        this.requestSnapshotReplay(entry)
      }
      return
    }
    if (paneGeneration === entry.paneGeneration && outputSequence <= entry.outputSequence) return
    if (paneGeneration !== entry.paneGeneration || outputSequence !== entry.outputSequence + 1n) {
      this.queueSequencedOutput(entry, frame)
      this.requestSnapshotReplay(entry)
      return
    }
    entry.outputSequence = outputSequence
    this.writeEntry(entry, bytes)
  }

  write(paneId: string, bytes: Uint8Array, options: { foreground?: boolean } = {}): void {
    if (bytes.byteLength === 0) return
    agentActivityTracker.noteOutput(paneId, bytes)
    this.writeEntry(this.getOrCreate(paneId), bytes, options.foreground)
  }

  private writeEntry(entry: Entry, bytes: Uint8Array, foregroundOverride?: boolean): void {
    if (entry.webglPromotionTimer !== undefined) {
      clearTimeout(entry.webglPromotionTimer)
      entry.webglPromotionTimer = undefined
    }
    // Output can start streaming before the pane's panel mounts (panes are
    // attached daemon-side at spawn). Parsing it into an unopened terminal
    // would use the constructor's default grid, not the pane's real one.
    if (!entry.opened) {
      entry.pendingOutput ??= []
      entry.pendingOutput.push(bytes)
      entry.pendingOutputBytes = (entry.pendingOutputBytes ?? 0) + bytes.byteLength
      if (entry.pendingOutputBytes > MAX_PENDING_OUTPUT_BYTES) this.handlePendingOutputOverflow(entry)
      return
    }
    const foreground = foregroundOverride ?? this.isForegroundOutput(entry)
    if (foreground
      && bytes.byteLength < INSTANT_OUTPUT_BYTES
      && (entry.pendingOutputBytes ?? 0) === 0
      && !entry.pendingOutput?.length) {
      this.writeTerminalOutput(entry, bytes)
      entry.outputTrimNoticeWritten = false
      return
    }
    entry.pendingOutput ??= []
    entry.pendingOutput.push(bytes)
    entry.pendingOutputBytes = (entry.pendingOutputBytes ?? 0) + bytes.byteLength
    if (entry.pendingOutputBytes > MAX_PENDING_OUTPUT_BYTES) this.handlePendingOutputOverflow(entry)
    if (entry.pendingOutput?.length) this.enqueueOutput(entry, foreground)
  }

  private handlePendingOutputOverflow(entry: Entry): void {
    if (entry.sessionId && entry.paneGeneration !== undefined) {
      this.removeQueuedOutput(entry)
      entry.pendingOutput = undefined
      entry.pendingOutputBytes = 0
      this.requestSnapshotReplay(entry)
      return
    }
    this.trimPendingOutput(entry)
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

  /** Find the next match in the pane buffer, highlighting every match with
   *  decorations. Returns false when the pane or the term is missing. */
  searchFindNext(paneId: string, query: string, options?: TerminalSearchOptions): boolean {
    const entry = this.entries.get(paneId)
    if (!entry || !query) return false
    return entry.search.findNext(query, withSearchDecorations(options))
  }

  searchFindPrevious(paneId: string, query: string, options?: TerminalSearchOptions): boolean {
    const entry = this.entries.get(paneId)
    if (!entry || !query) return false
    return entry.search.findPrevious(query, withSearchDecorations(options))
  }

  /** Remove every match decoration and the active-match selection. */
  searchClear(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.search.clearDecorations()
    entry.term.clearSelection()
  }

  /** Subscribe to match-count/index changes for a pane. Returns an
   *  unsubscribe; when the pane is gone the subscription resolves to a no-op. */
  onSearchResultsChanged(paneId: string, listener: (resultIndex: number, resultCount: number) => void): () => void {
    const entry = this.entries.get(paneId)
    if (!entry) return () => undefined
    const disposable = entry.search.onDidChangeResults?.((event) => listener(event.resultIndex, event.resultCount))
    return () => disposable?.dispose()
  }

  getSelection(paneId: string): string {
    return this.entries.get(paneId)?.term.getSelection() ?? ''
  }

  getRecentOutput(paneId: string, maxLines: number): string {
    const entry = this.entries.get(paneId)
    if (!entry || maxLines <= 0) return ''
    const buffer = entry.term.buffer.active
    const firstLine = Math.max(0, buffer.length - Math.floor(maxLines))
    const lines: string[] = []
    for (let index = firstLine; index < buffer.length; index += 1) {
      lines.push(buffer.getLine(index)?.translateToString(true) ?? '')
    }
    return lines.join('\n').replace(/^\s+/, '')
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
    if (!entry?.opened || entry.remoteLease || isDividerResizeActive()) return null
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
    if (entry.remoteLease) return
    entry.term.focus()
    this.scheduleLayoutPass({ paneIds: [paneId] })
  }

  reflow(paneId: string): void {
    this.scheduleLayoutPass({ paneIds: [paneId] })
  }

  setPaneVisible(paneId: string, visible: boolean): void {
    const entry = this.entries.get(paneId)
    if (!entry) return
    entry.visible = visible
    if (visible) entry.lastUsedAt = Date.now()
    if (!visible) return
    // A pane that was hidden may have missed output-driven draws entirely, so
    // becoming visible is one of the few genuine repaint triggers.
    this.scheduleLayoutPass({ paneIds: [paneId], force: true, repaint: true, syncPty: true })
    if (entry.pendingOutput?.length) this.enqueueOutput(entry, this.isForegroundOutput(entry))
  }

  notifyPaneVisible(paneId: string): void {
    this.setPaneVisible(paneId, true)
  }

  recoverAllVisiblePanes(paneIds?: string[]): void {
    const targets = (paneIds ?? [...this.entries.keys()])
      .map((paneId) => this.entries.get(paneId))
      .filter((entry): entry is Entry => Boolean(entry?.opened && !entry.remoteLease))
    for (const entry of targets) {
      entry.forceFitOnNextMeasure = true
      entry.rendererResetPending = true
      this.nudgeAlternateBuffer(entry)
    }
    this.scheduleLayoutPass({
      paneIds: targets.map((entry) => entry.paneId),
      force: true,
      repaint: true,
      syncPty: true,
      clearWebglTextureAtlas: true,
    })
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

  repairAfterPointerActivation(paneId: string): void {
    const entry = this.entries.get(paneId)
    if (!entry?.opened || !entry.container) return
    if (entry.remoteLease) return
    if (entry.term.hasSelection()) return

    const now = Date.now()
    if (entry.lastClickRepairAt !== undefined && now - entry.lastClickRepairAt < CLICK_REPAIR_COOLDOWN_MS) return
    entry.lastClickRepairAt = now
    this.scheduleLayoutPass({ paneIds: [paneId], force: true, clearWebglTextureAtlas: true })

    this.nudgeAlternateBuffer(entry)
  }

  private nudgeAlternateBuffer(entry: Entry): void {
    if (entry.remoteLease || entry.term.buffer.active.type !== 'alternate') return
    const sessionId = entry.sessionId
    const paneId = entry.paneId
    const cols = entry.term.cols
    const rows = entry.term.rows
    if (!sessionId || rows <= MIN_FIT_ROWS) return

    const nudgedRows = rows - 1
    entry.lastSentPtyCols = cols
    entry.lastSentPtyRows = nudgedRows
    void invoke('resize_pane', { sessionId, paneId, cols, rows: nudgedRows })
    clearTimeout(entry.clickRepairTimer)
    entry.clickRepairTimer = window.setTimeout(() => {
      if (this.entries.get(paneId) !== entry || !entry.opened || entry.sessionId !== sessionId) return
      entry.clickRepairTimer = undefined
      entry.lastSentPtyCols = cols
      entry.lastSentPtyRows = rows
      void invoke('resize_pane', { sessionId, paneId, cols, rows })
    }, CLICK_REPAIR_PTY_SETTLE_MS)
  }


  /** `force` re-fits a pane whose observed rect looks unchanged; `repaint` is the
   *  separate, much more expensive request to redraw the whole buffer. Layout
   *  settle passes want the former only — see `shouldRedrawAfterFit`. */
  scheduleLayoutPass(options: { paneIds?: string[]; syncPty?: boolean; force?: boolean; repaint?: boolean; clearWebglTextureAtlas?: boolean } = {}): void {
    const paneIds = options.paneIds ?? [...this.entries.keys()]
    for (const paneId of paneIds) {
      const entry = this.entries.get(paneId)
      if (!entry || entry.remoteLease) continue
      const pending = this.pendingPass.get(paneId)
      this.pendingPass.set(paneId, {
        fit: true,
        syncPty: Boolean(pending?.syncPty || options.syncPty),
        force: Boolean(pending?.force || options.force),
        repaint: Boolean(pending?.repaint || options.repaint),
        clearWebglTextureAtlas: Boolean(pending?.clearWebglTextureAtlas || options.clearWebglTextureAtlas),
      })
    }
    this.requestPassFlush()
  }

  /** Queue one animation-frame flush. Divider panes arrive here only after an
   *  Orca-style stable-grid probe; native window resizing uses the same
   *  adaptive frame budget without the stability gate. */
  private requestPassFlush(): void {
    if (this.passFrame !== undefined || this.passTimer !== undefined || this.pendingPass.size === 0) return
    // While the window is minimized the webview reports a degenerate viewport.
    // Hold the requests: handleWindowResize settles once the window is back.
    if (!this.viewportViable) return
    const delay = interactivePassDelay({
      interactive: this.interactive,
      now: Date.now(),
      lastPassAt: this.lastPassAt,
      lastPassDurationMs: this.lastPassDurationMs,
    })
    if (delay > 0) {
      this.passTimer = window.setTimeout(() => {
        this.passTimer = undefined
        this.requestPassFlush()
      }, delay)
      return
    }
    this.passFrame = requestAnimationFrame(() => {
      this.passFrame = undefined
      // Only an interactive pass needs the cost sample, and `performance.now()`
      // is the clock that can resolve a sub-millisecond pass. Outside a gesture
      // the throttle is inactive, so skip the measurement entirely.
      if (!this.interactive) {
        this.lastPassAt = Date.now()
        this.flushLayoutPass()
        return
      }
      const started = performance.now()
      this.flushLayoutPass()
      this.lastPassDurationMs = performance.now() - started
      // Measure the cooldown from the END of the pass: an expensive pass that
      // overran its own interval must not re-arm the instant it returns.
      this.lastPassAt = Date.now()
      // Panes the frame budget deferred are still queued, and the callers that
      // normally re-arm the flush are pointermove events that may already have
      // stopped. Re-arm here — AFTER the bookkeeping above, so the deferred
      // work is throttled like any other pass instead of running back to back.
      if (this.pendingPass.size > 0) this.requestPassFlush()
    })
  }

  private flushLayoutPass(): void {
    const pending = this.pendingPass
    this.pendingPass = new Map()
    const interactive = this.interactive
    // A pass over N panes does N scrollback reflows back to back, and the frame
    // it runs in cannot paint until the last one finishes. Divider drags never
    // enter this path; their fits are held until pointerup. During a native
    // window resize, stop once the frame budget is spent and put the remaining
    // panes back on the queue. They are deferred, never dropped, and the final
    // settle re-fits every pane unconditionally.
    const deadline = interactive ? performance.now() + INTERACTIVE_FIT_FRAME_BUDGET_MS : undefined
    for (const [paneId, pass] of pending) {
      if (deadline !== undefined && performance.now() >= deadline) {
        // Re-queue verbatim; merge with anything scheduled since this pass began.
        const queued = this.pendingPass.get(paneId)
        this.pendingPass.set(paneId, queued ? {
          fit: true,
          syncPty: queued.syncPty || pass.syncPty,
          force: queued.force || pass.force,
          repaint: queued.repaint || pass.repaint,
          clearWebglTextureAtlas: queued.clearWebglTextureAtlas || pass.clearWebglTextureAtlas,
        } : pass)
        continue
      }
      const entry = this.entries.get(paneId)
      if (!entry?.opened || entry.remoteLease || !pass.fit) continue
      // Prefer the size the ResizeObserver already measured: calling
      // getBoundingClientRect() here forces a synchronous layout in the middle
      // of a frame that also writes (fit/resize/refresh), which was the single
      // largest JS cost during a divider drag.
      const rect = entry.observedSize ?? entry.container?.getBoundingClientRect()
      const measurement = this.observeMeasureState(entry, rect)
      if (!rect || !measurement.measurable) continue
      if (this.shouldPromoteQuietWebgl(entry) && this.promoteToWebglRenderer(entry)) {
        entry.lastFitRect = { width: rect.width, height: rect.height }
        if (shouldSyncPtyNow({ interactive, syncPtyRequested: pass.syncPty, now: Date.now(), lastPtySyncAt: entry.lastPtySyncAt })) this.syncEntryPtySize(entry)
        continue
      }
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
        // A grid change does NOT need a repaint from us, though it reads like
        // it should: xterm's `resize()` fires `onResize`, wired straight to
        // `RenderService.handleResize()` -> `_fullRefresh()`, so every visible
        // row is already dirty before we could ask. Repainting anyway made the
        // renderer re-upload the whole model a second time on exactly the panes
        // a divider drag reflows (verified live by counting
        // `RenderService.refreshRows`: a lone resize issues 2, our follow-up
        // refresh only added a redundant 3rd). Removing it measured fit-pass
        // p90 24.8 ms -> 10.8 ms and drag frames over 16.7 ms 24 -> 5.
        // Only an explicit repair may redraw; clearing the pane's private
        // atlas is itself a repair, so it implies one.
        if (pass.repaint || pass.clearWebglTextureAtlas) {
          this.redraw(entry, { clearWebglTextureAtlas: pass.clearWebglTextureAtlas && entry.webgl !== undefined })
        }
      }
      entry.lastFitRect = { width: rect.width, height: rect.height }
      // A PTY resize held back during an interaction is sent by the settle pass
      // that endInteraction() schedules, so nothing is lost by skipping it here.
      if (shouldSyncPtyNow({ interactive, syncPtyRequested: pass.syncPty, now: Date.now(), lastPtySyncAt: entry.lastPtySyncAt })) this.syncEntryPtySize(entry)
    }
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
    this.dividerResizePaneIds.delete(paneId)
    if (entry.dividerFitFrame !== undefined) cancelAnimationFrame(entry.dividerFitFrame)
    entry.observer?.disconnect()
    if (entry.fitFrame !== undefined) cancelAnimationFrame(entry.fitFrame)
    this.pendingPass.delete(paneId)
    clearTimeout(entry.rendererReloadTimer)
    entry.rendererReloadPending = false
    clearTimeout(entry.clickRepairTimer)
    clearTimeout(entry.webglPromotionTimer)
    entry.webglPromotionTimer = undefined
    this.removeQueuedOutput(entry)
    entry.titleDisposable?.dispose()
    this.titleCoalescer.clear(paneId)
    entry.linkDisposables?.forEach((d) => d.dispose())
    this.dropToDomRenderer(entry)
    entry.term.dispose()
    this.entries.delete(paneId)
  }

  pruneWorkspaceCache(activeSessionId: string, livePaneIds: Set<string>): void {
    for (const [paneId, entry] of [...this.entries]) {
      if (entry.sessionId === activeSessionId && !livePaneIds.has(paneId)) this.dispose(paneId)
    }
    const background = [...this.entries.values()]
      .filter((entry) => entry.sessionId !== activeSessionId && !entry.visible)
      .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
    const overflow = background.length - MAX_CACHED_BACKGROUND_TERMINALS
    for (let index = 0; index < overflow; index += 1) this.dispose(background[index].paneId)
  }

  private loadWebglRenderer(entry: Entry): void {
    this.promoteToWebglRenderer(entry, { allowUnmeasured: true })
  }

  private promoteToWebglRenderer(entry: Entry, options: { allowUnmeasured?: boolean } = {}): boolean {
    if (entry.webgl || entry.webglPromotionPending || entry.webglAttachFailed) return false
    if (!entry.opened || !entry.container || entry.remoteLease || entry.attachFailureNoticeWritten) return false
    const rect = entry.observedSize ?? entry.container.getBoundingClientRect()
    if (!options.allowUnmeasured && (entry.visible !== true || rect.width < 1 || rect.height < 1)) {
      entry.forceFitOnNextMeasure = true
      return false
    }

    entry.webglPromotionPending = true
    let webgl: WebglAddon | undefined
    let contextLossDisposable: { dispose(): void } | undefined
    try {
      const addon = new WebglAddon()
      webgl = addon
      contextLossDisposable = addon.onContextLoss(() => {
        if (entry.webgl !== addon) return
        entry.webglAttachFailed = true
        entry.demotedForOutputBurst = false
        this.dropToDomRenderer(entry)
        entry.forceFitOnNextMeasure = true
        entry.rendererResetPending = true
        this.scheduleLayoutPass({ paneIds: [entry.paneId], force: true, repaint: true, syncPty: true })
      })
      entry.term.loadAddon(addon)
      entry.webgl = addon
      entry.webglContextLossDisposable = contextLossDisposable
      entry.webglAttachFailed = false
      entry.demotedForOutputBurst = false
      if (!this.safeFit(entry)) entry.forceFitOnNextMeasure = true
      this.redraw(entry)
      return true
    } catch {
      if (entry.webgl === webgl) this.dropToDomRenderer(entry)
      else {
        contextLossDisposable?.dispose()
        if (webgl) {
          releaseXtermWebglContext(webgl)
          webgl.dispose()
        }
      }
      entry.webglAttachFailed = true
      return false
    } finally {
      entry.webglPromotionPending = false
    }
  }

  private shouldPromoteQuietWebgl(entry: Entry): boolean {
    return entry.demotedForOutputBurst === true
      && entry.webgl === undefined
      && entry.webglPromotionTimer === undefined
      && (entry.pendingOutputBytes ?? 0) === 0
      && !entry.pendingOutput?.length
  }

  private scheduleWebglPromotion(entry: Entry): void {
    if (entry.demotedForOutputBurst !== true) return
    clearTimeout(entry.webglPromotionTimer)
    entry.webglPromotionTimer = window.setTimeout(() => {
      entry.webglPromotionTimer = undefined
      if (this.entries.get(entry.paneId) !== entry || !entry.opened) return
      if ((entry.pendingOutputBytes ?? 0) !== 0 || entry.pendingOutput?.length) return
      this.promoteToWebglRenderer(entry)
    }, WEBGL_REPROMOTION_QUIET_MS)
  }

  /** Every pane owns a persistent scrollbar instance. xterm builds the
   *  scrollable element lazily inside `term.open()`; App.css exposes its slider
   *  only while that pane is active. */
  private ensurePersistentScrollbar(entry: Entry): void {
    if (entry.scrollbarPersistent || !entry.opened) return
    entry.scrollbarPersistent = showPaneScrollbar(entry.term)
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
    if (!forceRepaintThroughRenderPause(entry.term)) entry.term.refresh(0, Math.max(0, entry.term.rows - 1))
  }

  private redrawAfterNextFrame(entry: Entry, options: { clearWebglTextureAtlas?: boolean } = {}): void {
    this.redraw(entry, options)
    requestAnimationFrame(() => this.redraw(entry))
  }


  // Fit only when PaneFitAddon proposes sane dimensions. During dockview's
  // maximize/restore the container can be transiently ~1px (measurable by
  // width/height > 0, but not yet laid out), and the addon then proposes
  // something like 2x1. Resizing xterm to that reflows the buffer into thousands
  // of 2-column rows and destroys the content — so every fit path must go through
  // this guard, not entry.fit.fit() directly. Returns true when a fit was applied
  // (or none was needed).
  private safeFit(entry: Entry, force = false): boolean {
    if (entry.remoteLease) return true
    const proposed = entry.fit.proposeDimensions()
    if (!proposed || proposed.cols < MIN_FIT_COLS || proposed.rows < MIN_FIT_ROWS) return false
    if (force || entry.term.cols !== proposed.cols || entry.term.rows !== proposed.rows) entry.fit.fit()
    return true
  }

  private restoreDesktopFit(entry: Entry, attempt = 0): void {
    if (isDividerResizeActive()) {
      entry.forceFitOnNextMeasure = true
      this.scheduleLayoutPass({ paneIds: [entry.paneId], force: true, repaint: true, syncPty: true })
      return
    }
    try {
      if (!this.safeFit(entry, true)) {
        entry.forceFitOnNextMeasure = true
        if (attempt < MAX_FIT_ATTEMPTS) {
          window.setTimeout(() => {
            if (this.entries.get(entry.paneId) === entry && entry.opened) this.restoreDesktopFit(entry, attempt + 1)
          }, DEGENERATE_FIT_RETRY_MS)
        }
        return
      }
      entry.forceFitOnNextMeasure = false
      this.redrawAfterNextFrame(entry)
      this.syncEntryPtySize(entry)
    } catch {
      if (attempt < MAX_FIT_ATTEMPTS) {
        window.setTimeout(() => {
          if (this.entries.get(entry.paneId) === entry && entry.opened) this.restoreDesktopFit(entry, attempt + 1)
        }, DEGENERATE_FIT_RETRY_MS)
      }
    }
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

  // Stale glyphs usually mean xterm's WebGL texture atlas lost coherent GPU
  // contents, not that the terminal buffer or renderer is invalid. Clear the
  // atlas and repaint in place so healthy panes keep accelerated rendering.
  // Alternate-buffer TUIs defer the same repair until their resize redraw has
  // landed, avoiding a refresh of a transitional frame.
  private resetRenderer(entry: Entry, options: { immediate: boolean }): void {
    if (!entry.opened || !entry.container) return
    if (options.immediate) {
      this.clearWebglTextureAtlas(entry)
      this.redraw(entry)
      return
    }
    if (entry.rendererReloadPending) return
    entry.rendererReloadPending = true
    clearTimeout(entry.rendererReloadTimer)
    entry.rendererReloadTimer = window.setTimeout(() => this.performRendererReload(entry), RENDERER_RESET_SETTLE_MS)
  }

  // xterm swaps back to its DOM renderer when the addon is disposed. Explicitly
  // lose and zero the native context first so rapid pane churn cannot exhaust
  // Chromium/ANGLE's active WebGL context budget.
  private dropToDomRenderer(entry: Entry): void {
    const webgl = entry.webgl
    if (!webgl) return
    entry.webglContextLossDisposable?.dispose()
    entry.webglContextLossDisposable = undefined
    releaseXtermWebglContext(webgl)
    webgl.dispose()
    entry.webgl = undefined
  }

  // Deferred atlas repair for alternate-buffer TUIs. The output callback or
  // settle timeout runs this after the TUI's resize redraw has landed.
  private performRendererReload(entry: Entry): void {
    if (!entry.rendererReloadPending) return
    entry.rendererReloadPending = false
    clearTimeout(entry.rendererReloadTimer)
    entry.rendererReloadTimer = undefined
    if (this.entries.get(entry.paneId) !== entry || !entry.opened || !entry.container) return
    this.clearWebglTextureAtlas(entry)
    this.redraw(entry)
  }

  private fitAfterFontsLoad(entry: Entry): void {
    const fonts = document.fonts
    if (!fonts) return
    void fonts.ready.then(() => this.fit(entry, 0, true))
  }

  private isForegroundOutput(entry: Entry): boolean {
    if (!entry.visible) return false
    if (typeof document === 'undefined') return true
    return document.visibilityState === 'visible'
      && document.hasFocus()
      && entry.container?.parentElement?.dataset.active === 'true'
  }

  private enqueueOutput(entry: Entry, foreground: boolean): void {
    entry.outputHighPriority ||= foreground
    if (!this.queuedOutputPaneIds.has(entry.paneId)) {
      this.queuedOutputPaneIds.add(entry.paneId)
      this.outputQueue.push(entry)
    }
    this.scheduleOutputDrain(foreground ? 0 : BACKGROUND_OUTPUT_COALESCE_MS)
  }

  private scheduleOutputDrain(delayMs: number): void {
    if (this.outputFrame !== undefined) return
    if (delayMs <= 0) {
      if (this.outputDelayTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(this.outputDelayTimer)
      this.outputDelayTimer = undefined
      this.outputDelayDueAt = undefined
      this.armOutputDrain()
      return
    }
    const dueAt = Date.now() + delayMs
    if (this.outputDelayTimer !== undefined && (this.outputDelayDueAt ?? Number.POSITIVE_INFINITY) <= dueAt) return
    if (this.outputDelayTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(this.outputDelayTimer)
    if (typeof window === 'undefined') {
      this.armOutputDrain()
      return
    }
    this.outputDelayDueAt = dueAt
    this.outputDelayTimer = window.setTimeout(() => {
      this.outputDelayTimer = undefined
      this.outputDelayDueAt = undefined
      this.armOutputDrain()
    }, delayMs)
  }

  private armOutputDrain(): void {
    if (this.outputFrame !== undefined) return
    const drain = () => {
      this.cancelOutputDrainSchedule()
      this.drainOutputQueue()
    }
    if (typeof requestAnimationFrame !== 'undefined') this.outputFrame = requestAnimationFrame(drain)
    if (typeof window !== 'undefined') this.outputFallbackTimer = window.setTimeout(drain, OUTPUT_FLUSH_FALLBACK_MS)
    if (this.outputFrame === undefined && this.outputFallbackTimer === undefined) this.drainOutputQueue()
  }

  private cancelOutputDrainSchedule(): void {
    if (this.outputDelayTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(this.outputDelayTimer)
    if (this.outputFrame !== undefined && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.outputFrame)
    if (this.outputFallbackTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(this.outputFallbackTimer)
    this.outputDelayTimer = undefined
    this.outputDelayDueAt = undefined
    this.outputFrame = undefined
    this.outputFallbackTimer = undefined
  }

  private removeQueuedOutput(entry: Entry): void {
    if (!this.queuedOutputPaneIds.delete(entry.paneId)) return
    this.outputQueue = this.outputQueue.filter((queued) => queued !== entry)
    entry.outputHighPriority = false
    if (this.outputQueue.length === 0) this.cancelOutputDrainSchedule()
  }

  private drainOutputQueue(): void {
    let writes = 0
    const requeueAfterDrain: Entry[] = []
    const startedAt = typeof performance === 'undefined' ? Date.now() : performance.now()
    while (this.outputQueue.length > 0 && writes < MAX_OUTPUT_WRITES_PER_DRAIN) {
      const priorityIndex = this.outputQueue.findIndex((entry) => entry.outputHighPriority)
      const index = priorityIndex >= 0 ? priorityIndex : 0
      const [entry] = this.outputQueue.splice(index, 1)
      this.queuedOutputPaneIds.delete(entry.paneId)
      entry.outputHighPriority = false
      if (this.entries.get(entry.paneId) !== entry || !entry.pendingOutput?.length) continue
      this.flushOutput(entry)
      writes += 1
      if (entry.pendingOutput?.length) {
        // Do not let one resume flood consume both writes in this drain. Keep
        // the remaining slot available to another pane, then revisit this pane
        // only after the browser has had a paint/input opportunity.
        entry.outputHighPriority = this.isForegroundOutput(entry)
        this.queuedOutputPaneIds.add(entry.paneId)
        requeueAfterDrain.push(entry)
      }
      const now = typeof performance === 'undefined' ? Date.now() : performance.now()
      if (now - startedAt >= OUTPUT_DRAIN_TIME_BUDGET_MS) break
    }
    this.outputQueue.push(...requeueAfterDrain)
    if (this.outputQueue.length > 0) this.scheduleOutputDrain(0)
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
    this.removeQueuedOutput(entry)
    while (entry.pendingOutput?.length) {
      this.flushOutput(entry)
    }
    if (!entry.pendingOutput?.length) entry.outputTrimNoticeWritten = false
  }

  private flushOutput(entry: Entry, maxBytes = MAX_OUTPUT_BYTES_PER_WRITE): void {
    const pending = entry.pendingOutput
    if (!pending?.length) {
      entry.outputTrimNoticeWritten = false
      return
    }

    // Software WebView2 turns sustained WebGL ANSI painting into 80-90 ms
    // renderer-thread stalls. Hardware WebView2 keeps WebGL; its parser work is
    // already bounded by the 16 KiB chunk and drain budgets below.
    if (this.webviewRenderMode === 'software'
      && (entry.pendingOutputBytes ?? 0) >= HIGH_VOLUME_OUTPUT_DOM_THRESHOLD_BYTES
      && entry.webgl) {
      this.dropToDomRenderer(entry)
      entry.demotedForOutputBurst = true
    }

    // xterm applies its 12 ms cooperative timeout BETWEEN write() chunks, not
    // while parsing one chunk. Daemon reads can be 64 KiB, and forwarding one
    // whole frame therefore creates a 25-30 ms renderer-thread task for dense
    // ANSI resume output. Split even a single incoming frame so pointermove,
    // Dockview layout, paint, and input regain control between parser chunks.
    const chunks: Uint8Array[] = []
    let bytesToWrite = 0
    while (pending.length > 0 && bytesToWrite < maxBytes) {
      const next = pending[0]
      const remaining = maxBytes - bytesToWrite
      if (next.byteLength <= remaining) {
        chunks.push(next)
        pending.shift()
        bytesToWrite += next.byteLength
        continue
      }
      chunks.push(next.subarray(0, remaining))
      pending[0] = next.subarray(remaining)
      bytesToWrite += remaining
    }

    entry.pendingOutputBytes = Math.max(0, (entry.pendingOutputBytes ?? bytesToWrite) - bytesToWrite)
    this.writeTerminalOutput(entry, concatUint8Arrays(chunks, bytesToWrite))
    if (pending.length === 0) {
      entry.pendingOutput = undefined
      entry.outputTrimNoticeWritten = false
      this.removeQueuedOutput(entry)
      this.scheduleWebglPromotion(entry)
    }

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
    if (entry.remoteLease || isDividerResizeActive()) return
    const sessionId = entry.sessionId
    if (!sessionId || !entry.opened) return
    this.flushOutput(entry)
    const cols = entry.term.cols
    const rows = entry.term.rows
    if (entry.lastSentPtyCols === cols && entry.lastSentPtyRows === rows) return
    entry.lastSentPtyCols = cols
    entry.lastSentPtyRows = rows
    entry.lastPtySyncAt = Date.now()
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
    if (isDividerResizeActive()) {
      this.requestStableDividerFit(entry)
      return
    }
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

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
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

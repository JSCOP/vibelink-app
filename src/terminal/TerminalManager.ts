import { invoke } from '@tauri-apps/api/core'
import { Terminal } from '@xterm/xterm'
import { ClipboardAddon } from '@xterm/addon-clipboard'
import { FitAddon } from '@xterm/addon-fit'
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
import { showPaneScrollbar } from './scrollbar'

const MAX_FIT_ATTEMPTS = 120
const MAX_OUTPUT_BYTES_PER_FRAME = 64 * 1024
const MAX_OUTPUT_WRITES_PER_DRAIN = 2
const MAX_PENDING_OUTPUT_BYTES = 8 * 1024 * 1024
const BACKGROUND_OUTPUT_COALESCE_MS = 50
const OUTPUT_DRAIN_TIME_BUDGET_MS = 8
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

type PendingInputChunk = { data: string; bytes: number }

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
  fit: FitAddon
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
  webglAttempted?: boolean
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

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        // Returning from hidden re-measures against geometry that may have
        // changed while we were not painting, so this one is a forced settle.
        if (document.visibilityState === 'visible') this.settleLayout({ repaint: true })
      })
      document.addEventListener('pointerdown', this.handlePointerDown, true)
    }
    if (typeof window !== 'undefined') {
      // A plain focus regain must NOT force a refit + full repaint of every
      // pane: nothing has resized, and the forced pass was visible as a flash
      // on every window switch. Let the ordinary rect guards decide.
      window.addEventListener('focus', () => this.reflowAll())
      window.addEventListener('resize', this.handleWindowResize)
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
  private settleLayout(options: { paneIds?: string[]; repaint?: boolean } = {}): void {
    this.scheduleLayoutPass({ paneIds: options.paneIds, force: true, repaint: options.repaint, syncPty: true })
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
    const fit = new FitAddon()
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

    const entry: Entry = { paneId, term, fit, search, opened: false, daemonAttached: false, dataWired: false, daemonGeneration: 0, remoteLease: Boolean(useRemotePaneLeaseStore.getState().leases[paneId]), visible: false }
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
        if (entry.remoteLease) return
        // OMP 17.1+ renders its interactive TUI in xterm's normal buffer.
        // AgentActivityTracker already capability-gates the pane, so buffer
        // type must not suppress prompt tracking for inline agent renderers.
        agentActivityTracker.noteUserInput(paneId, data)
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
      const currentReplayIsEnough = !force
        && entry.sessionId === sessionId
        && (entry.replayPending || (entry.paneGeneration !== undefined && entry.replayedContainer === entry.container))
      entry.sessionId = sessionId
      if (!currentReplayIsEnough) {
        entry.paneGeneration = undefined
        entry.outputSequence = undefined
        entry.replayRevision = (entry.replayRevision ?? 0) + 1
      }
      this.beginDaemonAttach(entry, sessionId, !currentReplayIsEnough)
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
      const snapshotBytes = decodeBase64Bytes(snapshot.dataBase64)
      this.removeQueuedOutput(entry)
      entry.pendingOutput = undefined
      entry.pendingOutputBytes = 0
      entry.outputTrimNoticeWritten = false
      entry.lastSentPtyCols = snapshot.cols
      entry.lastSentPtyRows = snapshot.rows
      if (entry.term.cols !== snapshot.cols || entry.term.rows !== snapshot.rows) {
        entry.term.resize(snapshot.cols, snapshot.rows)
      }
      entry.term.reset()
      entry.paneGeneration = paneGeneration
      entry.outputSequence = outputSequence
      entry.daemonAttached = true
      await this.writeReplayBytes(entry, snapshotBytes)

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
      entry.rendererResetPending = true
      this.scheduleLayoutPass({
        paneIds: [entry.paneId],
        force: true,
        repaint: true,
        syncPty: true,
        clearWebglTextureAtlas: true,
      })
      this.nudgeAlternateBuffer(entry)
      if (!snapshot.alive) this.markExited(entry.paneId)
    } catch {
      if (this.entries.get(entry.paneId) === entry && entry.sessionId === sessionId) {
        entry.daemonAttached = false
      }
    }
  }

  private writeReplayBytes(entry: Entry, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength === 0) return Promise.resolve()
    const output = terminalOutputAfterLastHardClear(bytes)
    const { promise, resolve } = Promise.withResolvers<void>()
    entry.term.write(output.bytes, () => {
      if (entry.rendererReloadPending) this.performRendererReload(entry)
      resolve()
    })
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
    this.removeQueuedOutput(entry)
    entry.titleDisposable?.dispose()
    this.titleCoalescer.clear(paneId)
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
        this.scheduleLayoutPass({ paneIds: [entry.paneId], force: true, repaint: true, syncPty: true })
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

  /** Every pane keeps its own always-visible scrollbar. xterm builds the
   *  scrollable element lazily inside `term.open()`, so this runs after the
   *  terminal is opened and only needs to succeed once per pane. */
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
        entry.outputHighPriority = this.isForegroundOutput(entry)
        this.queuedOutputPaneIds.add(entry.paneId)
        this.outputQueue.push(entry)
      }
      const now = typeof performance === 'undefined' ? Date.now() : performance.now()
      if (now - startedAt >= OUTPUT_DRAIN_TIME_BUDGET_MS) break
    }
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
    if (pending.length === 0) {
      entry.outputTrimNoticeWritten = false
      this.removeQueuedOutput(entry)
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

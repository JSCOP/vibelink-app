import type { IModes, Terminal } from '@xterm/xterm'

/**
 * Keeping a pane readable while a full-screen TUI owns the mouse.
 *
 * Measured against @xterm/xterm 6.0.0 in Chromium 136 (WebView2's engine), with
 * Claude Code 2.1.238 as the reference app. Claude Code enables VT200 tracking
 * with SGR encoding (`ESC[?1000h ESC[?1006h`, both strings verified in its
 * binary) and renders INLINE — normal buffer, real scrollback above it — so
 * every "the app owns the mouse" shortcut xterm takes is wrong for this pane:
 *
 *  - `Viewport` (browser/Viewport.ts:65) sets `handleMouseWheel: false` as soon
 *    as the active protocol includes WHEEL, so the wheel stops scrolling a
 *    scrollback that genuinely exists. Measured: ydisp 277 -> 277, the notch
 *    leaves as `ESC[<64;…M` instead.
 *  - `CoreService.triggerDataEvent(report, true)` (common/services/CoreService.ts:69)
 *    treats every mouse report as user input, so `scrollOnUserInput` yanks the
 *    viewport back to the bottom. Measured: scrollbar drag to ydisp 141, one
 *    left click, ydisp 277 — which is what makes the scrollbar feel dead.
 *  - `CoreMouseService`'s `activeProtocol` setter fires `onProtocolChange`
 *    unconditionally, and `InputHandler.ts:1925` re-assigns it on every
 *    `ESC[?1000h`. Claude Code re-emits that pair inside its redraw, so each
 *    frame reaches `_selectionService.disable()` -> `clearSelection()`.
 *    Measured: a Shift-forced selection survives ~one frame, then vanishes.
 *
 * Local selection itself stays xterm's: `SelectionService.shouldForceSelection`
 * returns `event.shiftKey` off macOS, so Shift+drag selects even while the app
 * is being sent reports, and no report is generated for that drag. VibeLink's
 * link handler only claims Shift alongside Ctrl/Meta (links.ts openModeForClick),
 * so the bare modifier is free. What was missing is that the selection did not
 * survive the next frame; `guardRedundantProtocolChanges` is what fixes that.
 */

export type MouseTrackingMode = IModes['mouseTrackingMode']
export type TerminalBufferType = 'normal' | 'alternate'

/** What should happen to a wheel notch over a pane. */
export type WheelAction =
  /** Hand the event back to xterm: viewport scroll, or a wheel report if the app asked for one. */
  | 'default'
  /** Scroll this pane's own viewport and tell the app nothing. */
  | 'scroll-viewport'
  /** Drop the event entirely. */
  | 'swallow'

export type WheelContext = {
  bufferType: TerminalBufferType
  mouseTrackingMode: MouseTrackingMode
  /** Alt is the escape hatch back to the application's own wheel handling. */
  altKey: boolean
}

/** x10 reports button-down only, so xterm's viewport still owns the wheel there;
 *  every other non-none protocol takes the wheel away from the viewport. */
function wheelIsReported(mode: MouseTrackingMode): boolean {
  return mode !== 'none' && mode !== 'x10'
}

export function resolveWheelAction({ bufferType, mouseTrackingMode, altKey }: WheelContext): WheelAction {
  if (bufferType === 'alternate') {
    // The alternate buffer has no scrollback, and without wheel-capable
    // reporting xterm converts the notch into CSI A/B (CoreBrowserTerminal.ts:838).
    // Full-screen TUIs such as OMP read ArrowUp as prompt-history recall, so the
    // notch would corrupt the prompt rather than scroll anything.
    return wheelIsReported(mouseTrackingMode) ? 'default' : 'swallow'
  }
  // Normal buffer: scrollback is real, so the reader gets it. Alt forwards the
  // notch to the rare inline TUI that draws its own scroll region.
  if (!wheelIsReported(mouseTrackingMode) || altKey) return 'default'
  return 'scroll-viewport'
}

export type WheelDeltaLike = { deltaY: number; deltaMode: number }

/** Lines to scroll for one wheel event. Fractions are intentional: xterm's
 *  viewport converts lines to pixels (`Viewport.scrollLines`), so a partial line
 *  is a partial pixel offset rather than a dropped notch. */
export function wheelScrollLines(event: WheelDeltaLike, cellHeight: number, rows: number): number {
  if (!Number.isFinite(event.deltaY) || event.deltaY === 0) return 0
  if (event.deltaMode === 1 /* DOM_DELTA_LINE */) return event.deltaY
  if (event.deltaMode === 2 /* DOM_DELTA_PAGE */) return event.deltaY * rows
  return cellHeight > 0 ? event.deltaY / cellHeight : 0
}

type CoreMouseServiceLike = {
  activeProtocol: string
  triggerMouseEvent: (event: unknown) => boolean
}
type TerminalInternals = {
  _core?: {
    coreMouseService?: CoreMouseServiceLike
    _renderService?: { dimensions: { css: { cell: { height: number } } } }
  }
}

function coreMouseService(term: Terminal): CoreMouseServiceLike | undefined {
  return (term as Terminal & TerminalInternals)._core?.coreMouseService
}

/** CSS pixel height of one row, or 0 before the renderer has measured. */
export function terminalCellHeight(term: Terminal): number {
  const height = (term as Terminal & TerminalInternals)._core?._renderService?.dimensions?.css?.cell?.height
  return typeof height === 'number' && Number.isFinite(height) ? height : 0
}

/** Returns true when the pane's protocol setter was wrapped. A false result
 *  means xterm's internal shape changed and the pane keeps upstream behaviour:
 *  a selection wiped by the app's next redraw. */
export function guardRedundantProtocolChanges(term: Terminal): boolean {
  const service = coreMouseService(term)
  if (!service) return false
  const prototype = Object.getPrototypeOf(service) as object | null
  const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'activeProtocol') : undefined
  const read = descriptor?.get
  const write = descriptor?.set
  if (!read || !write) return false
  Object.defineProperty(service, 'activeProtocol', {
    configurable: true,
    get: () => read.call(service) as string,
    set: (name: string) => {
      // A real transition still fires onProtocolChange; only the app re-asserting
      // the mode it already set is dropped. That single guard is what keeps a
      // selection, the `enable-mouse-events` class and the viewport's wheel
      // options from being rebuilt on every animation frame of a TUI redraw.
      if (read.call(service) === name) return
      write.call(service, name)
    },
  })
  return true
}

/** Returns true when mouse reports were detached from `scrollOnUserInput`.
 *  Keystrokes keep jumping the reader back to the prompt; a click, a drag report
 *  or a forwarded wheel notch no longer does, so a pane scrolled up with the
 *  scrollbar stays where the reader put it. */
export function keepScrollPositionAcrossMouseReports(term: Terminal): boolean {
  const service = coreMouseService(term)
  if (typeof service?.triggerMouseEvent !== 'function') return false
  const original = service.triggerMouseEvent.bind(service)
  service.triggerMouseEvent = (event: unknown) => {
    const previous = term.options.scrollOnUserInput
    term.options.scrollOnUserInput = false
    try {
      return original(event)
    } finally {
      term.options.scrollOnUserInput = previous
    }
  }
  return true
}

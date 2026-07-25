import type { TerminalHostSize } from './geometry'

/** Minimum gap between terminal fit passes while an interactive resize (divider
 *  drag, native window drag-resize) is in flight.
 *
 *  This used to be 100 ms, which capped the terminal at 10 refits per second
 *  while Dockview moved the pane box at display rate — the divider slid
 *  smoothly and the text inside visibly lagged behind it. Measured live during
 *  a sash drag with the 100 ms throttle in place: rAF stayed at 163 fps, p50
 *  6.1 ms, p90 6.1 ms, max 18 ms, zero frames over 100 ms. The frame budget was
 *  not the constraint; the throttle was. One pass per display frame lets the
 *  content track the divider, and the pass still coalesces every pane into a
 *  single animation-frame flush and skips panes whose rect did not move. */
export const INTERACTIVE_FIT_INTERVAL_MS = 16

/** Minimum gap between PTY resizes while an interactive resize is in flight.
 *
 *  A PTY resize is an IPC round trip that SIGWINCHes the child, so it must not
 *  run per frame — but withholding it for the whole drag (the previous
 *  behaviour) means a full-screen TUI never reflows until the pointer is
 *  released, which is the single biggest reason a drag looks frozen rather than
 *  live. Sending at roughly this cadence keeps the child redrawing during the
 *  drag; the settle pass still sends the exact size the drag landed on. */
export const INTERACTIVE_PTY_INTERVAL_MS = 100

/** A viewport smaller than this is not a window the user can work in; it is the
 *  transient geometry the webview reports while the window is minimized. */
const MIN_VIEWPORT_WIDTH = 200
const MIN_VIEWPORT_HEIGHT = 120

/** Milliseconds to wait before running the next layout pass. 0 means "now". */
export function interactivePassDelay(args: {
  interactive: boolean
  now: number
  lastPassAt: number | undefined
}): number {
  if (!args.interactive || args.lastPassAt === undefined) return 0
  const elapsed = args.now - args.lastPassAt
  if (elapsed >= INTERACTIVE_FIT_INTERVAL_MS) return 0
  // A backwards clock jump must not park the pass indefinitely.
  if (elapsed < 0) return INTERACTIVE_FIT_INTERVAL_MS
  return INTERACTIVE_FIT_INTERVAL_MS - elapsed
}

/** Whether the window geometry can host a real terminal fit.
 *
 *  Minimizing the window makes the webview report a degenerate viewport (144x19
 *  observed live). Refitting every pane to that and back on restore is what
 *  produces the blank-then-rebuild flash, so passes are skipped until the
 *  viewport is usable again. */
export function isViewportViable(size: TerminalHostSize | null | undefined): boolean {
  if (!size) return false
  return size.width >= MIN_VIEWPORT_WIDTH && size.height >= MIN_VIEWPORT_HEIGHT
}

/** `term.refresh(0, rows - 1)` marks every visible row dirty and makes the
 *  renderer re-upload the whole model, so it must not run on passes where the
 *  fit left the grid untouched.
 *
 *  `force` and `repaint` are deliberately SEPARATE intents. `force` only means
 *  "re-fit even though the observed rect looks unchanged" — the settle pipeline
 *  needs that after a split, because a pane's Dockview render overlay can still
 *  report its pre-split box. Repainting on those passes as well is what made a
 *  single split blink: the settle loop runs many frames, and every one of them
 *  repainted EVERY pane (measured: 147 `term.refresh` calls over ~21 whole-grid
 *  repaints for one split). Only a real grid change or an explicit repair
 *  request (`repaint`, which the renderer-recovery and pointer-activation paths
 *  set) may redraw. */
export function shouldRedrawAfterFit(args: { gridChanged: boolean; repaint: boolean }): boolean {
  return args.gridChanged || args.repaint
}

/** PTY resizes are rate-limited, not suppressed, during an interactive resize.
 *  Each one is an IPC round trip that SIGWINCHes the child, so a drag must not
 *  emit one per frame — but a drag that emits none leaves every full-screen TUI
 *  frozen at its old geometry until release. Outside an interaction the request
 *  always goes through; the settle pass at the end of the interaction still
 *  sends the exact size the drag landed on. */
export function shouldSyncPtyNow(args: {
  interactive: boolean
  syncPtyRequested: boolean
  now?: number
  lastPtySyncAt?: number | undefined
}): boolean {
  if (!args.syncPtyRequested) return false
  if (!args.interactive) return true
  if (args.now === undefined || args.lastPtySyncAt === undefined) return true
  const elapsed = args.now - args.lastPtySyncAt
  // A backwards clock jump must not park PTY resizes for the rest of the drag.
  return elapsed < 0 || elapsed >= INTERACTIVE_PTY_INTERVAL_MS
}

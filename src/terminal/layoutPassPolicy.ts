import type { TerminalHostSize } from './geometry'

/** Floor for the gap between terminal fit passes while an interactive resize
 *  (divider drag, native window drag-resize) is in flight.
 *
 *  This used to be 100 ms, which capped the terminal at 10 refits per second
 *  while Dockview moved the pane box at display rate — the divider slid
 *  smoothly and the text inside visibly lagged behind it. One pass per display
 *  frame lets the content track the divider, and the pass still coalesces every
 *  pane into a single animation-frame flush and skips panes whose rect did not
 *  move.
 *
 *  This is only the FLOOR. A fixed 16 ms cadence silently assumes the pass is
 *  cheap, which is true for idle panes and false for loaded ones — see
 *  `interactiveFitInterval`. */
export const INTERACTIVE_FIT_INTERVAL_MS = 16

/** Share of wall-clock time the interactive fit pass may occupy.
 *
 *  The pass is not free and its cost scales with the work the user actually has
 *  on screen: `term.resize()` reflows the whole scrollback whenever the COLUMN
 *  count changes. Measured on a 4x2 grid of eight panes holding 5,000 lines
 *  each, one column-changing resize costs ~4.2 ms per affected pane, so a
 *  single pass over the four panes a vertical divider touches costs ~17 ms —
 *  measured pass duration p90 15.2 ms, max 21.1 ms.
 *
 *  Re-arming that pass every 16 ms asks the main thread to spend ~100% of every
 *  frame reflowing, leaving no headroom for Dockview's own pointermove layout
 *  and paint. That is the jank: with the fixed floor the same drag measured rAF
 *  p90 15 ms / p99 37.4 ms / 21 frames over 16.7 ms, against a 6.5 ms p90 floor
 *  with the fit pass stubbed out.
 *
 *  Budgeting the pass to half the wall clock keeps a cheap pass at one per
 *  display frame (unchanged) and stretches an expensive one just far enough to
 *  leave the compositor a whole frame to itself. */
export const INTERACTIVE_FIT_MAX_DUTY_CYCLE = 0.5

/** Ceiling for the adaptive interval. A pathological pane must slow the content
 *  down, never stop it: past this the drag would read as frozen rather than
 *  merely coarse, which is the failure mode the old 100 ms throttle had. */
export const INTERACTIVE_FIT_MAX_INTERVAL_MS = 64

/** Gap to leave before the next interactive fit pass, given what the previous
 *  pass actually cost. Unknown/degenerate cost falls back to the floor. */
export function interactiveFitInterval(lastPassDurationMs: number | undefined): number {
  if (lastPassDurationMs === undefined || !Number.isFinite(lastPassDurationMs) || lastPassDurationMs <= 0) return INTERACTIVE_FIT_INTERVAL_MS
  const budgeted = Math.ceil(lastPassDurationMs / INTERACTIVE_FIT_MAX_DUTY_CYCLE)
  return Math.min(INTERACTIVE_FIT_MAX_INTERVAL_MS, Math.max(INTERACTIVE_FIT_INTERVAL_MS, budgeted))
}

/** Wall-clock a single interactive fit pass may spend before deferring the
 *  panes it has not reached yet to the next pass.
 *
 *  The throttle controls how OFTEN the pass runs; it cannot make one pass
 *  cheaper. A pass refits every dirty pane back to back, and the frame it runs
 *  in cannot paint until the last reflow returns — on an 8-pane grid holding
 *  5,000 lines each, the four panes a vertical divider touches cost ~5 ms
 *  apiece, so one unbounded pass blocks a frame for ~21 ms no matter how
 *  rarely it is scheduled.
 *
 *  Half a 60 Hz frame leaves the rest of the budget to Dockview's own
 *  pointermove layout and the compositor. Deferred panes are re-queued, never
 *  dropped, and the drag-end settle refits every pane on the final geometry. */
export const INTERACTIVE_FIT_FRAME_BUDGET_MS = 8

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

/** Milliseconds to wait before running the next layout pass. 0 means "now".
 *
 *  `lastPassAt` is the moment the previous pass FINISHED, so this is a genuine
 *  cooldown. Measuring from the pass start instead lets an expensive pass
 *  overrun its own interval and re-arm immediately, which is how a 16 ms
 *  cadence degenerates into back-to-back reflow. */
export function interactivePassDelay(args: {
  interactive: boolean
  now: number
  lastPassAt: number | undefined
  lastPassDurationMs?: number | undefined
}): number {
  if (!args.interactive || args.lastPassAt === undefined) return 0
  const interval = interactiveFitInterval(args.lastPassDurationMs)
  const elapsed = args.now - args.lastPassAt
  if (elapsed >= interval) return 0
  // A backwards clock jump must not park the pass indefinitely.
  if (elapsed < 0) return interval
  return interval - elapsed
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

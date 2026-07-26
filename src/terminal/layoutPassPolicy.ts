import type { TerminalHostSize } from './geometry'

/** Floor for live terminal fits during a native window drag-resize.
 *
 * Divider drags do not use this cadence: `TerminalManager` holds their xterm
 * fits completely until pointerup because a column-changing fit reflows all
 * scrollback and cannot be made frame-safe. Window resizing still benefits
 * from adaptive live fits because the whole viewport is changing. */
export const INTERACTIVE_FIT_INTERVAL_MS = 16

/** Share of wall-clock time a native-window fit pass may occupy.
 *
 * Fit cost scales with visible scrollback: `term.resize()` reflows the whole
 * buffer when the column count changes. The adaptive interval leaves half of
 * the wall clock to browser layout and paint. Divider drags bypass this policy
 * and settle once after release. */
export const INTERACTIVE_FIT_MAX_DUTY_CYCLE = 0.5

/** Ceiling for the adaptive native-window interval. */
export const INTERACTIVE_FIT_MAX_INTERVAL_MS = 64

/** Gap to leave before the next interactive fit pass, given what the previous
 *  pass actually cost. Unknown/degenerate cost falls back to the floor. */
export function interactiveFitInterval(lastPassDurationMs: number | undefined): number {
  if (lastPassDurationMs === undefined || !Number.isFinite(lastPassDurationMs) || lastPassDurationMs <= 0) return INTERACTIVE_FIT_INTERVAL_MS
  const budgeted = Math.ceil(lastPassDurationMs / INTERACTIVE_FIT_MAX_DUTY_CYCLE)
  return Math.min(INTERACTIVE_FIT_MAX_INTERVAL_MS, Math.max(INTERACTIVE_FIT_INTERVAL_MS, budgeted))
}

/** Wall-clock a single native-window fit pass may spend before deferring panes
 *  to the next pass. A fit cannot be preempted once it starts, but this budget
 *  prevents several loaded panes from reflowing back to back in one frame.
 *  Divider drags never enter this path. */
export const INTERACTIVE_FIT_FRAME_BUDGET_MS = 8

/** Minimum gap between PTY resizes for an interactive fit path that reaches
 *  xterm. Ordinary divider drags produce no intermediate fits or PTY resizes;
 *  their pointerup settle sends the exact landed grid. */
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

/** PTY resizes are rate-limited for interactive paths that still fit live
 *  (currently native window resizing). Outside an interaction the request
 *  always goes through; the final settle sends the exact landed size. */
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

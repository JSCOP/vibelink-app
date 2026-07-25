import type { TerminalHostSize } from './geometry'

/** Minimum gap between terminal fit passes while an interactive resize (divider
 *  drag, native window drag-resize) is in flight.
 *
 *  Dockview's sash drag calls `layoutViews()` synchronously on every
 *  `pointermove`, which trips each pane's ResizeObserver and schedules a full
 *  layout pass. Measured on a 5-pane workspace at 165 Hz, running that pass per
 *  frame cost p90 12.2 ms / p99 24.1 ms against 6.1 ms / 12.1 ms with the pass
 *  suppressed. Throttling to this interval keeps the terminal content following
 *  the divider continuously (the pane box itself still moves every frame) while
 *  the per-frame budget stays clear. */
export const INTERACTIVE_FIT_INTERVAL_MS = 100

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
 *  fit left the grid untouched. Forced passes still repaint: the renderer
 *  repair paths (maximize/restore, pointer activation) depend on it. */
export function shouldRedrawAfterFit(args: { gridChanged: boolean; force: boolean }): boolean {
  return args.gridChanged || args.force
}

/** PTY resizes are held back for the duration of an interactive resize: each one
 *  is an IPC round trip that makes the child program repaint on SIGWINCH, and a
 *  drag would emit one per pass. The settle pass at the end of the interaction
 *  sends the final size. */
export function shouldSyncPtyNow(args: { interactive: boolean; syncPtyRequested: boolean }): boolean {
  return args.syncPtyRequested && !args.interactive
}

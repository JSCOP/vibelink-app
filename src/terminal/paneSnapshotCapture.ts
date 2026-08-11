import { invoke } from '@tauri-apps/api/core'
import type { SerializeAddon } from '@xterm/addon-serialize'

/** Leading `ESC[3J ESC[2J ESC[H` makes a snapshot self-clearing: the daemon's
 *  ring drops everything before it, `terminalOutputAfterLastHardClear` trims the
 *  replay to it, and `vibelink terminal read` starts at the snapshot too. */
export const HARD_CLEAR = '\x1b[3J\x1b[2J\x1b[H'

/** A resize is not one event. A divider drag, a window resize, and a layout
 *  settle all walk the grid through sizes the pane never lands on, and the
 *  program needs a moment to repaint into the size it does. Re-arm rather than
 *  serialize per step. */
const CAPTURE_DELAY_MS = 600

/** Serialize cost is linear in rows (measured under jsdom at 306 columns): 500
 *  rows 5.5 ms, 2,000 rows 36 ms, the full 50,000-row scrollback default 1,300 ms
 *  and 14 MiB. 2,000 rows is several screens of recoverable history at a cost
 *  that stays inside the repaint the resize already forced. */
const SCROLLBACK_ROWS = 2_000

/** The part of a `TerminalManager` entry a snapshot needs. */
export type SnapshotTarget = {
  paneId: string
  sessionId?: string
  serialize: SerializeAddon
  opened: boolean
  daemonAttached: boolean
  remoteLease?: boolean
  replayPending?: boolean
  snapshotTimer?: number
}

/** Hand the daemon what this pane RENDERS, replacing the raw PTY bytes it holds.
 *
 *  Raw bytes carry no geometry: replay them into a terminal of a different width
 *  and every full-width rule re-wraps while every absolute cursor move lands in
 *  the wrong cell, which is the stacked half-overwritten agent frames users see
 *  after a restart. A serialized buffer is plain text plus SGR, so it reflows at
 *  any width, and the bytes recorded after it were all produced at the geometry
 *  they will be replayed at.
 *
 *  Skipped without a live daemon attachment or while a replay is in flight: the
 *  buffer then describes something other than the pane's settled screen, and
 *  writing that back would make the daemon's copy worse than the bytes it holds. */
export function captureSnapshot(target: SnapshotTarget): void {
  const sessionId = target.sessionId
  if (!sessionId || !target.opened || !target.daemonAttached || target.remoteLease || target.replayPending) return
  let rendered: string
  try {
    rendered = target.serialize.serialize({ scrollback: SCROLLBACK_ROWS })
  } catch {
    // A pane whose emulator is mid-teardown has nothing worth persisting.
    return
  }
  void invoke('set_pane_snapshot', {
    sessionId,
    paneId: target.paneId,
    data: `${HARD_CLEAR}${rendered}`,
  }).catch(() => undefined)
}

export function scheduleSnapshotCapture(target: SnapshotTarget): void {
  cancelSnapshotCapture(target)
  target.snapshotTimer = window.setTimeout(() => {
    target.snapshotTimer = undefined
    captureSnapshot(target)
  }, CAPTURE_DELAY_MS)
}

export function cancelSnapshotCapture(target: SnapshotTarget): void {
  clearTimeout(target.snapshotTimer)
  target.snapshotTimer = undefined
}

import { describe, expect, it } from 'vitest'
import {
  INTERACTIVE_FIT_INTERVAL_MS,
  INTERACTIVE_FIT_MAX_INTERVAL_MS,
  interactiveFitInterval,
  interactivePassDelay,
  isViewportViable,
  shouldSyncPtyNow,
} from './layoutPassPolicy'

describe('interactivePassDelay for native window resizing', () => {
  it('runs immediately when no interaction is in flight', () => {
    expect(interactivePassDelay({ interactive: false, now: 1_000, lastPassAt: 999 })).toBe(0)
  })

  it('runs immediately on the first pass of an interaction', () => {
    expect(interactivePassDelay({ interactive: true, now: 1_000, lastPassAt: undefined })).toBe(0)
  })

  it('defers the remainder of the fit interval while resizing the window', () => {
    expect(interactivePassDelay({ interactive: true, now: 1_005, lastPassAt: 1_000 })).toBe(INTERACTIVE_FIT_INTERVAL_MS - 5)
  })

  it('keeps a cheap pass at one refit per display frame', () => {
    // Divider drags bypass live fits; this cadence preserves live feedback when
    // the native window itself is being resized.
    expect(INTERACTIVE_FIT_INTERVAL_MS).toBeLessThanOrEqual(16)
    expect(interactivePassDelay({ interactive: true, now: 1_016, lastPassAt: 1_000, lastPassDurationMs: 4 })).toBe(0)
  })

  it('stretches the interval when the previous pass was expensive', () => {
    // Eight panes holding 5,000 lines each: one column change reflows every
    // affected pane's scrollback, so the pass measured p90 15.2 ms. Re-arming
    // that every 16 ms leaves the gesture no frame time of its own.
    expect(interactivePassDelay({ interactive: true, now: 1_016, lastPassAt: 1_000, lastPassDurationMs: 15 })).toBe(14)
    expect(interactivePassDelay({ interactive: true, now: 1_030, lastPassAt: 1_000, lastPassDurationMs: 15 })).toBe(0)
  })

  it('runs immediately once the fit interval has elapsed', () => {
    expect(interactivePassDelay({ interactive: true, now: 1_100, lastPassAt: 1_000 })).toBe(0)
    expect(interactivePassDelay({ interactive: true, now: 1_500, lastPassAt: 1_000 })).toBe(0)
  })

  it('never defers longer than one interval when the clock jumps backwards', () => {
    expect(interactivePassDelay({ interactive: true, now: 900, lastPassAt: 1_000 })).toBe(INTERACTIVE_FIT_INTERVAL_MS)
  })
})

describe('interactiveFitInterval', () => {
  it('falls back to the floor when no pass has been measured', () => {
    expect(interactiveFitInterval(undefined)).toBe(INTERACTIVE_FIT_INTERVAL_MS)
  })

  it('never re-arms faster than one display frame for a cheap pass', () => {
    // Half of a 0.5 ms pass is well under a frame; the floor avoids chasing the
    // sample downwards during a native window resize.
    expect(interactiveFitInterval(0.5)).toBe(INTERACTIVE_FIT_INTERVAL_MS)
    expect(interactiveFitInterval(4)).toBe(INTERACTIVE_FIT_INTERVAL_MS)
  })

  it('leaves the gesture at least half of the wall clock', () => {
    expect(interactiveFitInterval(15)).toBe(30)
    expect(interactiveFitInterval(21)).toBe(42)
  })

  it('caps the interval so a pathological pane cannot monopolize window resizing', () => {
    expect(interactiveFitInterval(500)).toBe(INTERACTIVE_FIT_MAX_INTERVAL_MS)
  })

  it('ignores a degenerate cost sample', () => {
    expect(interactiveFitInterval(0)).toBe(INTERACTIVE_FIT_INTERVAL_MS)
    expect(interactiveFitInterval(Number.NaN)).toBe(INTERACTIVE_FIT_INTERVAL_MS)
    expect(interactiveFitInterval(-5)).toBe(INTERACTIVE_FIT_INTERVAL_MS)
  })
})

describe('isViewportViable', () => {
  it('accepts a normal desktop viewport', () => {
    expect(isViewportViable({ width: 2552, height: 1390 })).toBe(true)
  })

  it('accepts a deliberately small but usable window', () => {
    expect(isViewportViable({ width: 320, height: 240 })).toBe(true)
  })

  it('rejects the degenerate viewport reported while the window is minimized', () => {
    // Observed live: the webview reports 144x19 on minimize, then restores.
    expect(isViewportViable({ width: 144, height: 19 })).toBe(false)
  })

  it('rejects a collapsed viewport', () => {
    expect(isViewportViable({ width: 0, height: 0 })).toBe(false)
    expect(isViewportViable(null)).toBe(false)
  })
})

describe('shouldSyncPtyNow', () => {
  it('sends the PTY resize when no interaction is in flight', () => {
    expect(shouldSyncPtyNow({ interactive: false, syncPtyRequested: true })).toBe(true)
  })

  it('rate-limits PTY resize on an interactive live-fit path', () => {
    // Divider drags are held before xterm resize; native window resizing still
    // reaches this guard and must not SIGWINCH on every frame.
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 1_050, lastPtySyncAt: 1_000 })).toBe(false)
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 1_100, lastPtySyncAt: 1_000 })).toBe(true)
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 1_400, lastPtySyncAt: 1_000 })).toBe(true)
  })

  it('sends the first PTY resize of an interaction immediately', () => {
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 1_000, lastPtySyncAt: undefined })).toBe(true)
  })

  it('never parks PTY resizes when the clock jumps backwards', () => {
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 900, lastPtySyncAt: 1_000 })).toBe(true)
  })

  it('stays false when no sync was requested', () => {
    expect(shouldSyncPtyNow({ interactive: false, syncPtyRequested: false })).toBe(false)
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: false, now: 2_000, lastPtySyncAt: 1_000 })).toBe(false)
  })
})

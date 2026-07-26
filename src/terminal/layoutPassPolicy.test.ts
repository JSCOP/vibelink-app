import { describe, expect, it } from 'vitest'
import {
  INTERACTIVE_FIT_INTERVAL_MS,
  INTERACTIVE_FIT_MAX_INTERVAL_MS,
  interactiveFitInterval,
  interactivePassDelay,
  isViewportViable,
  shouldSyncPtyNow,
} from './layoutPassPolicy'

describe('interactivePassDelay', () => {
  it('runs immediately when no interaction is in flight', () => {
    expect(interactivePassDelay({ interactive: false, now: 1_000, lastPassAt: 999 })).toBe(0)
  })

  it('runs immediately on the first pass of an interaction', () => {
    expect(interactivePassDelay({ interactive: true, now: 1_000, lastPassAt: undefined })).toBe(0)
  })

  it('defers the remainder of the fit interval while dragging', () => {
    expect(interactivePassDelay({ interactive: true, now: 1_005, lastPassAt: 1_000 })).toBe(INTERACTIVE_FIT_INTERVAL_MS - 5)
  })

  it('keeps a cheap pass at one refit per display frame', () => {
    // At the old 100 ms the terminal refit 10x/s while the divider itself moved
    // at display rate, so the text visibly trailed the divider.
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
    // Half of a 0.5 ms pass is well under a frame; the floor keeps the content
    // tracking the divider instead of chasing the sample downwards.
    expect(interactiveFitInterval(0.5)).toBe(INTERACTIVE_FIT_INTERVAL_MS)
    expect(interactiveFitInterval(4)).toBe(INTERACTIVE_FIT_INTERVAL_MS)
  })

  it('leaves the gesture at least half of the wall clock', () => {
    expect(interactiveFitInterval(15)).toBe(30)
    expect(interactiveFitInterval(21)).toBe(42)
  })

  it('caps the interval so a pathological pane slows but never freezes the drag', () => {
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

  it('rate-limits rather than suppresses the PTY resize during a divider drag', () => {
    // Suppressing it for the whole drag left every full-screen TUI frozen at its
    // old geometry until the pointer was released.
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 1_050, lastPtySyncAt: 1_000 })).toBe(false)
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 1_100, lastPtySyncAt: 1_000 })).toBe(true)
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 1_400, lastPtySyncAt: 1_000 })).toBe(true)
  })

  it('sends the first PTY resize of a drag immediately', () => {
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 1_000, lastPtySyncAt: undefined })).toBe(true)
  })

  it('never parks PTY resizes for the rest of a drag when the clock jumps backwards', () => {
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true, now: 900, lastPtySyncAt: 1_000 })).toBe(true)
  })

  it('stays false when no sync was requested', () => {
    expect(shouldSyncPtyNow({ interactive: false, syncPtyRequested: false })).toBe(false)
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: false, now: 2_000, lastPtySyncAt: 1_000 })).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import {
  INTERACTIVE_FIT_INTERVAL_MS,
  interactivePassDelay,
  isViewportViable,
  shouldRedrawAfterFit,
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

  it('keeps the interval short enough to refit once per display frame', () => {
    // At the old 100 ms the terminal refit 10x/s while the divider itself moved
    // at display rate, so the text visibly trailed the divider.
    expect(INTERACTIVE_FIT_INTERVAL_MS).toBeLessThanOrEqual(16)
  })

  it('runs immediately once the fit interval has elapsed', () => {
    expect(interactivePassDelay({ interactive: true, now: 1_100, lastPassAt: 1_000 })).toBe(0)
    expect(interactivePassDelay({ interactive: true, now: 1_500, lastPassAt: 1_000 })).toBe(0)
  })

  it('never defers longer than one interval when the clock jumps backwards', () => {
    expect(interactivePassDelay({ interactive: true, now: 900, lastPassAt: 1_000 })).toBe(INTERACTIVE_FIT_INTERVAL_MS)
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

describe('shouldRedrawAfterFit', () => {
  it('repaints when the fit changed the terminal grid', () => {
    expect(shouldRedrawAfterFit({ gridChanged: true, repaint: false })).toBe(true)
  })

  it('repaints when a caller explicitly asked for renderer repair', () => {
    // Pane became visible, restore from minimize, pointer repair, WebGL loss.
    expect(shouldRedrawAfterFit({ gridChanged: false, repaint: true })).toBe(true)
  })

  it('skips the full-buffer repaint when nothing changed', () => {
    expect(shouldRedrawAfterFit({ gridChanged: false, repaint: false })).toBe(false)
  })

  it('does NOT repaint a forced re-fit that left the grid alone', () => {
    // A split runs the settle loop over many frames and forces a re-fit on each
    // one because overlay rects go stale. Repainting there too made every pane
    // redraw ~21 times per split, which is the visible blink.
    expect(shouldRedrawAfterFit({ gridChanged: false, repaint: false })).toBe(false)
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

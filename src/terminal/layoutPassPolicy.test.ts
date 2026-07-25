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
    expect(interactivePassDelay({ interactive: true, now: 1_030, lastPassAt: 1_000 })).toBe(70)
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

  it('holds the PTY resize back while a divider drag is in flight', () => {
    expect(shouldSyncPtyNow({ interactive: true, syncPtyRequested: true })).toBe(false)
  })

  it('stays false when no sync was requested', () => {
    expect(shouldSyncPtyNow({ interactive: false, syncPtyRequested: false })).toBe(false)
  })
})

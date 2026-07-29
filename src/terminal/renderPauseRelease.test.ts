import { describe, expect, it, vi } from 'vitest'
import { forceRepaintThroughRenderPause } from './renderPauseRelease'

type FakeRenderService = {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  refreshRows?: (start: number, end: number, sync?: boolean) => void
}

function terminal(options: { rows?: number; service?: FakeRenderService | null; withoutCore?: boolean } = {}): unknown {
  if (options.withoutCore) return { rows: options.rows ?? 24 }
  return {
    rows: options.rows ?? 24,
    _core: { _renderService: options.service ?? null },
  }
}

describe('forceRepaintThroughRenderPause', () => {
  it('clears pause latches and synchronously repaints the full viewport', () => {
    const refreshRows = vi.fn()
    const service = { _isPaused: true, _needsFullRefresh: true, refreshRows }

    expect(forceRepaintThroughRenderPause(terminal({ rows: 30, service }))).toBe(true)
    expect(refreshRows).toHaveBeenCalledWith(0, 29, true)
    expect(service._isPaused).toBe(false)
    expect(service._needsFullRefresh).toBe(false)
  })

  it('leaves an unpaused renderer untouched', () => {
    const refreshRows = vi.fn()
    expect(forceRepaintThroughRenderPause(terminal({ service: { _isPaused: false, refreshRows } }))).toBe(false)
    expect(refreshRows).not.toHaveBeenCalled()
  })

  it('returns false when internals or rows are unavailable', () => {
    expect(forceRepaintThroughRenderPause(null)).toBe(false)
    expect(forceRepaintThroughRenderPause(terminal({ withoutCore: true }))).toBe(false)
    expect(forceRepaintThroughRenderPause(terminal({ service: {} }))).toBe(false)
    expect(forceRepaintThroughRenderPause(terminal({ rows: 0, service: { _isPaused: true, refreshRows: vi.fn() } }))).toBe(false)
  })

  it('never throws when a terminal is disposed mid-repaint', () => {
    const service = {
      _isPaused: true,
      _needsFullRefresh: true,
      refreshRows: vi.fn(() => { throw new Error('disposed') }),
    }

    expect(forceRepaintThroughRenderPause(terminal({ service }))).toBe(false)
    expect(service._isPaused).toBe(false)
    expect(service._needsFullRefresh).toBe(false)
  })
})

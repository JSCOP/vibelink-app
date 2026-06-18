import { describe, expect, it } from 'vitest'
import { shouldRestoreDockviewLayout } from './layoutRestore'

describe('shouldRestoreDockviewLayout', () => {
  it('rejects an empty persisted layout when live panes exist', () => {
    const emptyLayout = JSON.stringify({
      grid: { root: { type: 'branch', data: [], size: 100 }, width: 100, height: 100, orientation: 'HORIZONTAL' },
      panels: {},
    })

    expect(shouldRestoreDockviewLayout(emptyLayout, ['pane-1'])).toBe(false)
  })

  it('rejects a persisted layout missing a live pane panel', () => {
    const staleLayout = JSON.stringify({
      panels: {
        'pane-1': { id: 'pane-1' },
      },
    })

    expect(shouldRestoreDockviewLayout(staleLayout, ['pane-1', 'pane-2'])).toBe(false)
  })

  it('accepts a layout that contains every live pane panel', () => {
    const layout = JSON.stringify({
      panels: {
        'pane-1': { id: 'pane-1' },
        'pane-2': { id: 'pane-2' },
      },
    })

    expect(shouldRestoreDockviewLayout(layout, ['pane-1', 'pane-2'])).toBe(true)
  })
})

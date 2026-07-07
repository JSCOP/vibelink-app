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
      ...layoutGrid(['pane-1']),
      panels: {
        'pane-1': { id: 'pane-1' },
      },
    })

    expect(shouldRestoreDockviewLayout(staleLayout, ['pane-1', 'pane-2'])).toBe(false)
  })

  it('rejects a zero-sized grid saved while the dock was hidden', () => {
    const zeroSizedLayout = JSON.stringify({
      ...layoutGrid(['pane-1', 'pane-2'], { width: 0, height: 0, size: 0 }),
      panels: {
        'pane-1': { id: 'pane-1' },
        'pane-2': { id: 'pane-2' },
      },
    })

    expect(shouldRestoreDockviewLayout(zeroSizedLayout, ['pane-1', 'pane-2'])).toBe(false)
  })

  it('rejects a persisted grid missing a live pane leaf', () => {
    const missingLeafLayout = JSON.stringify({
      ...layoutGrid(['pane-1']),
      panels: {
        'pane-1': { id: 'pane-1' },
        'pane-2': { id: 'pane-2' },
      },
    })

    expect(shouldRestoreDockviewLayout(missingLeafLayout, ['pane-1', 'pane-2'])).toBe(false)
  })

  it('rejects a persisted layout containing a dead pane leaf and panel', () => {
    const deadPaneLayout = JSON.stringify({
      ...layoutGrid(['pane-1', 'pane-dead']),
      panels: {
        'pane-1': { id: 'pane-1' },
        'pane-dead': { id: 'pane-dead' },
      },
    })

    expect(shouldRestoreDockviewLayout(deadPaneLayout, ['pane-1'])).toBe(false)
  })

  it('accepts allowlisted non-terminal panels in restored layouts', () => {
    const mixedLayout = JSON.stringify({
      ...layoutGrid(['pane-1', 'terminal-window']),
      panels: {
        'pane-1': { id: 'pane-1' },
        'terminal-window': { id: 'terminal-window', contentComponent: 'terminalWindow' },
      },
    })

    expect(shouldRestoreDockviewLayout(mixedLayout, ['pane-1'], ['terminal-window'])).toBe(true)
  })

  it('accepts a layout that contains every live pane panel and grid leaf', () => {
    const layout = JSON.stringify({
      ...layoutGrid(['pane-1', 'pane-2']),
      panels: {
        'pane-1': { id: 'pane-1' },
        'pane-2': { id: 'pane-2' },
      },
    })

    expect(shouldRestoreDockviewLayout(layout, ['pane-1', 'pane-2'])).toBe(true)
  })
})

function layoutGrid(paneIds: string[], dimensions = { width: 200, height: 100, size: 200 }) {
  return {
    grid: {
      root: {
        type: 'branch',
        data: paneIds.map((paneId) => ({
          type: 'leaf',
          data: { id: `group-${paneId}`, views: [paneId], activeView: paneId },
          size: dimensions.size / Math.max(1, paneIds.length),
        })),
        size: dimensions.size,
      },
      width: dimensions.width,
      height: dimensions.height,
      orientation: 'HORIZONTAL',
    },
  }
}

import { describe, expect, it } from 'vitest'
import { nearestPaneIdInDirection, swapPanelIdsInDockviewLayout, type PaneRect } from './paneSwap'

describe('swapPanelIdsInDockviewLayout', () => {
  it('swaps pane ids between grid groups without changing panel state', () => {
    const layout = {
      grid: {
        root: {
          type: 'branch',
          data: [
            { type: 'leaf', data: { id: 'group-1', views: ['pane-a'], activeView: 'pane-a' } },
            { type: 'leaf', data: { id: 'group-2', views: ['pane-b'], activeView: 'pane-b' } },
          ],
        },
      },
      panels: {
        'pane-a': { id: 'pane-a', title: 'A' },
        'pane-b': { id: 'pane-b', title: 'B' },
      },
    }

    expect(swapPanelIdsInDockviewLayout(layout, 'pane-a', 'pane-b')).toBe(true)
    expect(layout.grid.root.data[0].data.views).toEqual(['pane-b'])
    expect(layout.grid.root.data[0].data.activeView).toBe('pane-b')
    expect(layout.grid.root.data[1].data.views).toEqual(['pane-a'])
    expect(layout.grid.root.data[1].data.activeView).toBe('pane-a')
    expect(Object.keys(layout.panels)).toEqual(['pane-a', 'pane-b'])
  })

  it('does not mutate pane ids inside the same tab group', () => {
    const layout = {
      grid: {
        root: {
          type: 'leaf',
          data: {
            id: 'group-1',
            views: ['pane-a', 'pane-b', 'pane-c'],
            activeView: 'pane-c',
            tabGroups: [{ id: 'tabs', panelIds: ['pane-a', 'pane-b', 'pane-c'] }],
          },
        },
      },
    }

    expect(swapPanelIdsInDockviewLayout(layout, 'pane-a', 'pane-c')).toBe(false)
    expect(layout.grid.root.data.views).toEqual(['pane-a', 'pane-b', 'pane-c'])
    expect(layout.grid.root.data.activeView).toBe('pane-c')
    expect(layout.grid.root.data.tabGroups[0].panelIds).toEqual(['pane-a', 'pane-b', 'pane-c'])
  })

  it('does not mutate when either pane is missing', () => {
    const layout = {
      grid: { root: { type: 'leaf', data: { id: 'group-1', views: ['pane-a'], activeView: 'pane-a' } } },
    }

    expect(swapPanelIdsInDockviewLayout(layout, 'pane-a', 'pane-missing')).toBe(false)
    expect(layout.grid.root.data.views).toEqual(['pane-a'])
    expect(layout.grid.root.data.activeView).toBe('pane-a')
  })
})

describe('nearestPaneIdInDirection', () => {
  const rects: Record<string, PaneRect> = {
    center: rect(100, 100, 100, 100),
    left: rect(0, 100, 100, 100),
    right: rect(200, 100, 100, 100),
    up: rect(100, 0, 100, 100),
    down: rect(100, 200, 100, 100),
    farRight: rect(300, 100, 100, 100),
  }

  it('selects the nearest pane in each requested direction', () => {
    const paneIds = Object.keys(rects)
    const lookup = (paneId: string) => rects[paneId] ?? null

    expect(nearestPaneIdInDirection('center', paneIds, 'left', lookup)).toBe('left')
    expect(nearestPaneIdInDirection('center', paneIds, 'right', lookup)).toBe('right')
    expect(nearestPaneIdInDirection('center', paneIds, 'up', lookup)).toBe('up')
    expect(nearestPaneIdInDirection('center', paneIds, 'down', lookup)).toBe('down')
  })

  it('returns null instead of wrapping when no pane exists in that direction', () => {
    expect(nearestPaneIdInDirection('left', Object.keys(rects), 'left', (paneId) => rects[paneId] ?? null)).toBeNull()
  })
})

function rect(left: number, top: number, width: number, height: number): PaneRect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

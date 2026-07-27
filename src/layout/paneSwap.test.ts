// @vitest-environment jsdom
import { createDockview } from 'dockview-core'
import { describe, expect, it } from 'vitest'
import { nearestPaneIdInDirection, paneIdsInReadingOrder, swapPanelIdsInDockviewLayout, swapPanelsInDockviewApi, type PaneRect } from './paneSwap'

Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })

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

  it('swaps live pane locations without merging either pane into a tab group', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
    })
    try {
      api.layout(600, 400)
      const topLeft = api.addPanel({ id: 'pane-a', component: 'test' })
      const topRight = api.addPanel({ id: 'pane-b', component: 'test', position: { referencePanel: topLeft, direction: 'right' } })
      api.addPanel({ id: 'pane-c', component: 'test', position: { referencePanel: topLeft, direction: 'below' } })
      api.addPanel({ id: 'pane-d', component: 'test', position: { referencePanel: topRight, direction: 'below' } })
      const sourceGroupId = topLeft.group.id
      const targetGroupId = topRight.group.id

      expect(swapPanelsInDockviewApi(api, 'pane-a', 'pane-b')).toBe(true)

      expect(api.getPanel('pane-a')?.group.id).toBe(targetGroupId)
      expect(api.getPanel('pane-b')?.group.id).toBe(sourceGroupId)
      expect(api.groups).toHaveLength(4)
      expect(api.groups.every((group) => group.panels.length === 1)).toBe(true)
      expect(api.panels).toHaveLength(4)
    } finally {
      api.dispose()
      host.remove()
    }
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

  it('does not jump diagonally into another row at a horizontal edge', () => {
    const edgeRects: Record<string, PaneRect> = {
      active: rect(300, 0, 100, 98),
      'next-row': rect(402, 102, 100, 98),
    }

    expect(nearestPaneIdInDirection('active', Object.keys(edgeRects), 'right', (paneId) => edgeRects[paneId] ?? null)).toBeNull()
  })

  it('does not jump diagonally into another column at a vertical edge', () => {
    const edgeRects: Record<string, PaneRect> = {
      active: rect(0, 300, 98, 100),
      'next-column': rect(102, 402, 98, 100),
    }

    expect(nearestPaneIdInDirection('active', Object.keys(edgeRects), 'down', (paneId) => edgeRects[paneId] ?? null)).toBeNull()
  })
})

describe('paneIdsInReadingOrder', () => {
  it('preserves visual positions when aligning a slightly uneven 4x2 grid', () => {
    const rects: Record<string, PaneRect> = {
      'top-1': rect(0, 0, 98, 98),
      'top-2': rect(102, 2, 101, 96),
      'top-3': rect(207, 1, 99, 100),
      'top-4': rect(310, 0, 100, 97),
      'bottom-1': rect(0, 103, 100, 97),
      'bottom-2': rect(104, 101, 98, 99),
      'bottom-3': rect(206, 105, 101, 95),
      'bottom-4': rect(311, 102, 99, 98),
    }
    const storedOrder = ['bottom-3', 'top-1', 'bottom-1', 'top-4', 'top-2', 'bottom-4', 'top-3', 'bottom-2']

    expect(paneIdsInReadingOrder(storedOrder, (paneId) => rects[paneId] ?? null)).toEqual([
      'top-1', 'top-2', 'top-3', 'top-4',
      'bottom-1', 'bottom-2', 'bottom-3', 'bottom-4',
    ])
  })
})

function rect(left: number, top: number, width: number, height: number): PaneRect {
  return { left, top, width, height, right: left + width, bottom: top + height }
}

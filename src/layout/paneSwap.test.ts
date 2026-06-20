import { describe, expect, it } from 'vitest'
import { swapPanelIdsInDockviewLayout } from './paneSwap'

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

  it('swaps pane ids inside tab groups', () => {
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

    expect(swapPanelIdsInDockviewLayout(layout, 'pane-a', 'pane-c')).toBe(true)
    expect(layout.grid.root.data.views).toEqual(['pane-c', 'pane-b', 'pane-a'])
    expect(layout.grid.root.data.activeView).toBe('pane-a')
    expect(layout.grid.root.data.tabGroups[0].panelIds).toEqual(['pane-c', 'pane-b', 'pane-a'])
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

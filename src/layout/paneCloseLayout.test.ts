// @vitest-environment jsdom
import { createDockview, type SerializedDockview } from 'dockview-core'
import { describe, expect, it } from 'vitest'
import { removePanelPreservingLayout } from './paneCloseLayout'

Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })

describe('terminal pane close sizing', () => {
  it('hands the closed pane extent to the previous sibling and preserves the rest', () => {
    const layout = horizontalLayout([
      leaf('pane-a', 'group-a', 300),
      leaf('pane-b', 'group-b', 200),
      leaf('pane-c', 'group-c', 100),
    ])

    const next = removePanelPreservingLayout(layout, 'pane-b')

    expect(next?.grid.root).toMatchObject({
      type: 'branch',
      data: [
        { type: 'leaf', size: 500, data: { views: ['pane-a'] } },
        { type: 'leaf', size: 100, data: { views: ['pane-c'] } },
      ],
    })
    expect(next?.panels).toEqual({ 'pane-a': { id: 'pane-a' }, 'pane-c': { id: 'pane-c' } })
    expect(next?.activeGroup).toBe('group-a')
  })

  it('hands the leading pane extent to the next sibling and preserves the rest', () => {
    const layout = horizontalLayout([
      leaf('pane-a', 'group-a', 300),
      leaf('pane-b', 'group-b', 150),
      leaf('pane-c', 'group-c', 150),
    ], 'group-a')

    const next = removePanelPreservingLayout(layout, 'pane-a')

    expect(next?.grid.root).toMatchObject({
      type: 'branch',
      data: [
        { type: 'leaf', size: 450, data: { views: ['pane-b'] } },
        { type: 'leaf', size: 150, data: { views: ['pane-c'] } },
      ],
    })
    expect(next?.activeGroup).toBe('group-b')
  })

  it('collapses a nested split locally while preserving the other column width', () => {
    const layout = horizontalLayout([
      {
        type: 'branch',
        size: 400,
        data: [leaf('pane-a', 'group-a', 250), leaf('pane-b', 'group-b', 150)],
      },
      leaf('pane-c', 'group-c', 200),
    ])

    const next = removePanelPreservingLayout(layout, 'pane-b')

    expect(next?.grid.root).toMatchObject({
      type: 'branch',
      data: [
        { type: 'leaf', size: 400, data: { views: ['pane-a'] } },
        { type: 'leaf', size: 200, data: { views: ['pane-c'] } },
      ],
    })
  })

  it('removes only the selected tab when panes share one group', () => {
    const layout = horizontalLayout([{
      type: 'leaf',
      size: 600,
      data: {
        id: 'group-tabs',
        views: ['pane-a', 'pane-b'],
        activeView: 'pane-a',
        tabGroups: [{ id: 'tabs', panelIds: ['pane-a', 'pane-b'] }],
      },
    }], 'group-tabs')

    const next = removePanelPreservingLayout(layout, 'pane-a')
    const root = next?.grid.root

    expect(root).toMatchObject({
      type: 'branch',
      data: [{
        type: 'leaf',
        size: 600,
        data: {
          views: ['pane-b'],
          activeView: 'pane-b',
          tabGroups: [{ id: 'tabs', panelIds: ['pane-b'] }],
        },
      }],
    })
    expect(next?.activeGroup).toBe('group-tabs')
  })
  it('hands the closed pane extent to one neighbor through Dockview panel reuse', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
    })
    try {
      api.layout(600, 400)
      const first = api.addPanel({ id: 'pane-a', component: 'test' })
      const second = api.addPanel({ id: 'pane-b', component: 'test', position: { referencePanel: first, direction: 'right' } })
      api.addPanel({ id: 'pane-c', component: 'test', position: { referencePanel: second, direction: 'right' } })
      api.addPanel({ id: 'pane-d', component: 'test', position: { referencePanel: second, direction: 'right' } })
      const next = removePanelPreservingLayout(api.toJSON(), 'pane-b')
      expect(next).not.toBeNull()

      api.fromJSON(next!, { reuseExistingPanels: true })
      api.layout(600, 400, true)

      expect(api.getPanel('pane-a')?.group.api.width).toBeCloseTo(300, 0)
      expect(api.getPanel('pane-c')?.group.api.width).toBeCloseTo(150, 0)
      expect(api.getPanel('pane-d')?.group.api.width).toBeCloseTo(150, 0)
    } finally {
      api.dispose()
      host.remove()
    }
  })
})

type TestNode =
  | { type: 'leaf'; size: number; data: { id: string; views: string[]; activeView: string; tabGroups?: Array<{ id: string; panelIds: string[] }> } }
  | { type: 'branch'; size: number; data: TestNode[] }

function leaf(panelId: string, groupId: string, size: number): TestNode {
  return { type: 'leaf', size, data: { id: groupId, views: [panelId], activeView: panelId } }
}

function horizontalLayout(nodes: TestNode[], activeGroup = 'group-b'): SerializedDockview {
  const panelIds = nodes.flatMap(panelIdsInNode)
  return {
    grid: {
      root: { type: 'branch', size: 600, data: nodes } as SerializedDockview['grid']['root'],
      width: 600,
      height: 400,
      orientation: 1,
    },
    panels: Object.fromEntries(panelIds.map((id) => [id, { id }])),
    activeGroup,
  } as unknown as SerializedDockview
}

function panelIdsInNode(node: TestNode): string[] {
  return node.type === 'leaf' ? node.data.views : node.data.flatMap(panelIdsInNode)
}

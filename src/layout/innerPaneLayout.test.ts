// @vitest-environment jsdom
import { Orientation, createDockview, type SerializedDockview } from 'dockview-core'
import { describe, expect, it } from 'vitest'
import {
  arrangeTerminalPaneGrid,
  clearTerminalPaneDropGuide,
  defaultTerminalPaneSplitDirection,
  equalizeSerializedGridTracks,
  preventTerminalPaneStackDrop,
  terminalPaneDropDirection,
  unstackSerializedDockview,
  updateTerminalPaneDropGuide,
} from './innerPaneLayout'

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
})

describe('inner terminal pane layout', () => {
  it('turns one eight-tab group into eight single-pane leaves in reading order', () => {
    const paneIds = Array.from({ length: 8 }, (_, index) => `pane-${index + 1}`)
    const layout = stackedLayout(paneIds, 'pane-5')

    const repaired = unstackSerializedDockview(layout)
    const leaves = collectLeaves(repaired.grid.root)

    expect(repaired).not.toBe(layout)
    expect(leaves.map((leaf) => leaf.data.views)).toEqual(paneIds.map((paneId) => [paneId]))
    expect(new Set(leaves.map((leaf) => leaf.data.id)).size).toBe(8)
    expect(leaves.every((leaf) => leaf.data.tabGroups === undefined)).toBe(true)
    expect(repaired.activeGroup).toBe(leaves[4].data.id)
    expect(repaired.panels).toEqual(layout.panels)
  })

  it('returns an already tiled layout untouched', () => {
    const layout = tiledLayout(4, 2)

    expect(unstackSerializedDockview(layout)).toBe(layout)
  })

  it('blocks tab/header/center-content drops but keeps edge splits available', () => {
    expect(preventTerminalPaneStackDrop('tab', 'center')).toBe(true)
    expect(preventTerminalPaneStackDrop('header_space', 'left')).toBe(true)
    expect(preventTerminalPaneStackDrop('content', 'center')).toBe(true)
    expect(preventTerminalPaneStackDrop('content', 'left')).toBe(false)
    expect(preventTerminalPaneStackDrop('edge', 'center')).toBe(false)
  })

  it('splits along the shorter grid axis and defaults right for a square', () => {
    expect(defaultTerminalPaneSplitDirection(tiledLayout(4, 2))).toBe('below')
    expect(defaultTerminalPaneSplitDirection(tiledLayout(2, 4))).toBe('right')
    expect(defaultTerminalPaneSplitDirection(tiledLayout(2, 2))).toBe('right')
  })

  it('arranges eight initially tab-stacked panels into eight groups in a flat 4x2 grid', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
    })

    try {
      api.layout(1200, 800)
      const paneIds = Array.from({ length: 8 }, (_, index) => `pane-${index + 1}`)
      for (const paneId of paneIds) api.addPanel({ id: paneId, component: 'test' })

      expect(api.groups).toHaveLength(1)
      expect(api.groups[0].panels).toHaveLength(8)

      arrangeTerminalPaneGrid(api, paneIds, { cols: 4, rows: 2 }, paneIds[0])
      api.layout(1200, 800)

      expect(api.groups).toHaveLength(8)
      expect(api.groups.every((group) => group.panels.length === 1)).toBe(true)
      const root = api.toJSON().grid.root
      expect(root.type).toBe('branch')
      const columns = (root as TestBranch).data
      expect(columns).toHaveLength(4)
      for (const column of columns) {
        expect(column.type).toBe('branch')
        expect((column as TestBranch).data).toHaveLength(2)
      }
    } finally {
      api.dispose()
      host.remove()
    }
  })

  it('evens out lopsided tracks and leaves an already even layout untouched', () => {
    const even = tiledLayout(4, 2)
    expect(equalizeSerializedGridTracks(even)).toBe(even)

    const lopsided = structuredClone(even) as SerializedDockview
    const columns = (lopsided.grid.root as TestBranch).data
    columns[0].size = 222
    columns[1].size = 734
    columns[2].size = 478
    columns[3].size = 478

    const equalized = equalizeSerializedGridTracks(lopsided)
    // A node's size is its extent along the PARENT axis, so the four columns
    // share the sum of their own widths, not the root's (cross-axis) size.
    const width = 222 + 734 + 478 + 478
    expect(equalized).not.toBe(lopsided)
    expect((equalized.grid.root as TestBranch).data.map((column) => column.size)).toEqual([width / 4, width / 4, width / 4, width / 4])
  })

  it('leaves an arranged grid with equal columns and rows', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
    })

    try {
      api.layout(1200, 800)
      const paneIds = Array.from({ length: 8 }, (_, index) => `pane-${index + 1}`)
      for (const paneId of paneIds) api.addPanel({ id: paneId, component: 'test' })
      arrangeTerminalPaneGrid(api, paneIds, { cols: 4, rows: 2 }, paneIds[0])
      api.layout(1200, 800)

      const columns = (api.toJSON().grid.root as TestBranch).data
      const columnSizes = columns.map((column) => column.size)
      expect(new Set(columnSizes).size).toBe(1)
      for (const column of columns) {
        const rowSizes = (column as TestBranch).data.map((row) => row.size)
        expect(new Set(rowSizes).size).toBe(1)
      }
    } finally {
      api.dispose()
      host.remove()
    }
  })

  // A group left without an active panel renders as a watermark, reports
  // `isVisible === false`, and is skipped by BOTH the overlay reposition and the
  // settled check — the pane then never paints and its PTY spawns at the
  // unpositioned overlay's geometry. Grid creation adds every pane inactive and
  // to the right, exactly as `openContent({kind:'terminal-grid'})` does.
  it('leaves every arranged group with an active, visible panel', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
    })

    try {
      api.layout(1200, 800)
      const paneIds = Array.from({ length: 8 }, (_, index) => `pane-${index + 1}`)
      for (const paneId of paneIds) {
        const reference = api.activePanel ?? api.panels.at(-1)
        api.addPanel({
          id: paneId,
          component: 'test',
          inactive: true,
          ...(reference ? { position: { referencePanel: reference, direction: 'right' as const } } : {}),
        })
      }

      arrangeTerminalPaneGrid(api, paneIds, { cols: 4, rows: 2 }, paneIds[0])
      api.layout(1200, 800)

      expect(api.groups).toHaveLength(8)
      expect(api.groups.filter((group) => group.activePanel === undefined)).toEqual([])
      expect(api.panels.filter((panel) => !panel.api.isVisible)).toEqual([])
      expect(api.activePanel?.id).toBe(paneIds[0])
    } finally {
      api.dispose()
      host.remove()
    }
  })
  it('maps the centered pane chooser to four split directions and a swap center', () => {
    const rect = { left: 0, top: 0, right: 300, bottom: 300, width: 300, height: 300 }
    expect(terminalPaneDropDirection(rect, 150, 50)).toBe('top')
    expect(terminalPaneDropDirection(rect, 50, 150)).toBe('left')
    expect(terminalPaneDropDirection(rect, 250, 150)).toBe('right')
    expect(terminalPaneDropDirection(rect, 150, 250)).toBe('bottom')
    expect(terminalPaneDropDirection(rect, 150, 150)).toBe('center')
    expect(terminalPaneDropDirection(rect, 50, 50)).toBeNull()
  })

  it('shows and clears one pane drop chooser on the hovered group', () => {
    const group = document.createElement('div')
    group.getBoundingClientRect = () => ({ left: 10, top: 20, right: 310, bottom: 320, width: 300, height: 300 } as DOMRect)
    document.body.appendChild(group)

    expect(updateTerminalPaneDropGuide({ id: 'target', element: group }, 'source', 160, 90)).toBe('top')
    expect(group.querySelector('.terminal-pane-drop-guide')?.getAttribute('data-active-direction')).toBe('top')

    expect(updateTerminalPaneDropGuide({ id: 'target', element: group }, 'source', 160, 170)).toBe('center')
    expect(group.querySelector('.terminal-pane-drop-guide')?.getAttribute('data-active-direction')).toBe('center')

    clearTerminalPaneDropGuide()
    expect(group.querySelector('.terminal-pane-drop-guide')).toBeNull()
    group.remove()
  })

})

type TestLeaf = {
  type: 'leaf'
  size: number
  data: {
    id: string
    views: string[]
    activeView: string
    tabGroups?: Array<{ id: string; collapsed: boolean; panelIds: string[] }>
  }
}

type TestBranch = {
  type: 'branch'
  size: number
  data: TestNode[]
}

type TestNode = TestLeaf | TestBranch

function stackedLayout(paneIds: string[], activePaneId: string): SerializedDockview {
  return {
    grid: {
      root: {
        type: 'leaf',
        size: 800,
        data: {
          id: 'stacked-group',
          views: paneIds,
          activeView: activePaneId,
          tabGroups: [{ id: 'stacked-tabs', collapsed: false, panelIds: paneIds }],
        },
      },
      width: 800,
      height: 400,
      orientation: Orientation.HORIZONTAL,
    },
    panels: Object.fromEntries(paneIds.map((paneId) => [paneId, { id: paneId }])),
    activeGroup: 'stacked-group',
  }
}

function tiledLayout(cols: number, rows: number): SerializedDockview {
  const paneIds = Array.from({ length: cols * rows }, (_, index) => `pane-${index + 1}`)
  const columnWidth = 800 / cols
  const rowHeight = 400 / rows
  const columns: TestNode[] = Array.from({ length: cols }, (_, col) => {
    const leaves = Array.from({ length: rows }, (_, row): TestLeaf => {
      const paneId = paneIds[row * cols + col]
      return {
        type: 'leaf',
        size: rowHeight,
        data: { id: `group-${row}-${col}`, views: [paneId], activeView: paneId },
      }
    })
    return rows === 1 ? { ...leaves[0], size: columnWidth } : { type: 'branch', size: columnWidth, data: leaves }
  })
  return {
    grid: {
      root: { type: 'branch', size: 800, data: columns } as SerializedDockview['grid']['root'],
      width: 800,
      height: 400,
      orientation: Orientation.HORIZONTAL,
    },
    panels: Object.fromEntries(paneIds.map((paneId) => [paneId, { id: paneId }])),
    activeGroup: 'group-0-0',
  }
}

function collectLeaves(node: SerializedDockview['grid']['root']): TestLeaf[] {
  if (node.type === 'leaf') return [node as TestLeaf]
  return (node as TestBranch).data.flatMap((child) => collectLeaves(child as SerializedDockview['grid']['root']))
}

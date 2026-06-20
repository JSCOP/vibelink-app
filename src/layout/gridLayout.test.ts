import { describe, expect, it } from 'vitest'
import { createDockviewGridLayout, type GridPaneDescriptor } from './gridLayout'

describe('createDockviewGridLayout', () => {
  it('builds a 3x2 row-major dockview grid without dropping panel metadata', () => {
    const layout = createDockviewGridLayout(baseLayout(), { cols: 3, rows: 2 }, panes(6), [], 'pane-4')

    expect(layout?.grid?.orientation).toBe('HORIZONTAL')
    const root = layout?.grid?.root
    expect(root?.type).toBe('branch')
    if (root?.type !== 'branch') return

    expect(root.data).toHaveLength(3)
    expect(columnViews(root.data[0])).toEqual(['pane-0', 'pane-3'])
    expect(columnViews(root.data[1])).toEqual(['pane-1', 'pane-4'])
    expect(columnViews(root.data[2])).toEqual(['pane-2', 'pane-5'])
    expect(layout?.activeGroup).toBe('grid-3')
    expect(layout?.panels?.['pane-4']).toMatchObject({
      id: 'pane-4',
      contentComponent: 'terminal',
      renderer: 'always',
      params: {
        paneId: 'pane-4',
        title: 'Pane 4',
        icon: 'bot',
      },
    })
  })

  it('builds taller templates in row-major order', () => {
    const layout = createDockviewGridLayout(baseLayout(), { cols: 2, rows: 3 }, panes(6))
    const root = layout?.grid?.root
    expect(root?.type).toBe('branch')
    if (root?.type !== 'branch') return

    expect(columnViews(root.data[0])).toEqual(['pane-0', 'pane-2', 'pane-4'])
    expect(columnViews(root.data[1])).toEqual(['pane-1', 'pane-3', 'pane-5'])
  })

  it('keeps overflow panes as tabs in the last grid leaf', () => {
    const layout = createDockviewGridLayout(baseLayout(), { cols: 2, rows: 2 }, panes(4), panes(2, 4), 'pane-5')
    const root = layout?.grid?.root
    expect(root?.type).toBe('branch')
    if (root?.type !== 'branch') return

    const lastColumn = root.data[1]
    expect(lastColumn.type).toBe('branch')
    if (lastColumn.type !== 'branch') return
    const lastLeaf = lastColumn.data[1]
    expect(lastLeaf.type).toBe('leaf')
    if (lastLeaf.type !== 'leaf') return

    expect(lastLeaf.data.views).toEqual(['pane-3', 'pane-4', 'pane-5'])
    expect(lastLeaf.data.activeView).toBe('pane-5')
    expect(layout?.activeGroup).toBe(lastLeaf.data.id)
  })

  it('fills sparse columns instead of leaving blank grid rows', () => {
    const layout = createDockviewGridLayout(baseLayout(), { cols: 3, rows: 2 }, panes(5))
    const root = layout?.grid?.root
    expect(root?.type).toBe('branch')
    if (root?.type !== 'branch') return

    const sparseColumn = root.data[2]
    expect(sparseColumn.type).toBe('branch')
    if (sparseColumn.type !== 'branch') return
    expect(sparseColumn.data).toHaveLength(1)
    expect(sparseColumn.data[0].size).toBe(200)
  })
})

function baseLayout() {
  return {
    grid: { width: 300, height: 200 },
    panels: {
      'pane-4': {
        id: 'pane-4',
        contentComponent: 'terminal',
        tabComponent: 'props.defaultTabComponent',
        params: { paneId: 'pane-4', title: 'Old title' },
        title: 'Old title',
        renderer: 'always',
      },
    },
  }
}

function panes(count: number, start = 0): GridPaneDescriptor[] {
  return Array.from({ length: count }, (_, index) => {
    const number = start + index
    return {
      id: `pane-${number}`,
      title: `Pane ${number}`,
      icon: 'bot',
    }
  })
}

type TestNode =
  | { type: 'leaf'; data: { views: string[] } }
  | { type: 'branch'; data: TestNode[] }

function columnViews(node: TestNode | undefined): string[] {
  if (!node) return []
  if (node.type === 'leaf') return node.data.views
  return node.data.flatMap((child) => child.type === 'leaf' ? child.data.views[0] : [])
}

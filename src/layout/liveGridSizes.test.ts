// @vitest-environment jsdom
import { createDockview, type DockviewApi } from 'dockview-core'
import { afterEach, describe, expect, it } from 'vitest'
import { applySerializedGridSizes, serializedActiveViewId } from './liveGridSizes'
import { removePanelPreservingLayout } from './paneCloseLayout'

Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} unobserve() {} disconnect() {} } })

const disposals: Array<() => void> = []

afterEach(() => {
  while (disposals.length > 0) disposals.pop()?.()
})

function makeDock(): DockviewApi {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const api = createDockview(host, {
    createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
  })
  api.layout(600, 400)
  disposals.push(() => {
    api.dispose()
    host.remove()
  })
  return api
}

describe('applySerializedGridSizes', () => {
  it('restores exact sizes after a native close without a rebuild', () => {
    const api = makeDock()
    const first = api.addPanel({ id: 'pane-a', component: 'test' })
    const second = api.addPanel({ id: 'pane-b', component: 'test', position: { referencePanel: first, direction: 'right' } })
    api.addPanel({ id: 'pane-c', component: 'test', position: { referencePanel: second, direction: 'right' } })
    api.addPanel({ id: 'pane-d', component: 'test', position: { referencePanel: second, direction: 'right' } })
    second.api.setActive()

    const target = removePanelPreservingLayout(api.toJSON(), 'pane-b')
    expect(target).not.toBeNull()

    second.api.close()
    expect(applySerializedGridSizes(api, target!)).toBe(true)

    // The closed pane's extent went to its previous sibling; the rest kept
    // their exact widths instead of Dockview's distribute rebalance.
    expect(api.getPanel('pane-a')?.group.api.width).toBeCloseTo(300, 0)
    expect(api.getPanel('pane-c')?.group.api.width).toBeCloseTo(150, 0)
    expect(api.getPanel('pane-d')?.group.api.width).toBeCloseTo(150, 0)
    expect(serializedActiveViewId(target!)).toBe('pane-a')
  })

  it('applies nested branch sizes recursively', () => {
    const api = makeDock()
    const first = api.addPanel({ id: 'pane-a', component: 'test' })
    const second = api.addPanel({ id: 'pane-b', component: 'test', position: { referencePanel: first, direction: 'right' } })
    api.addPanel({ id: 'pane-c', component: 'test', position: { referencePanel: second, direction: 'below' } })

    const target = api.toJSON()
    const root = target.grid.root
    if (!Array.isArray(root.data)) throw new Error('expected a branch root')
    root.data[0].size = 200
    root.data[1].size = 400
    const column = root.data[1]
    if (!Array.isArray(column.data)) throw new Error('expected a nested branch')
    column.data[0].size = 150
    column.data[1].size = 250

    expect(applySerializedGridSizes(api, target)).toBe(true)

    expect(api.getPanel('pane-a')?.group.api.width).toBeCloseTo(200, 0)
    expect(api.getPanel('pane-b')?.group.api.width).toBeCloseTo(400, 0)
    expect(api.getPanel('pane-b')?.group.api.height).toBeCloseTo(150, 0)
    expect(api.getPanel('pane-c')?.group.api.height).toBeCloseTo(250, 0)
  })

  it('refuses a target whose topology does not match the live grid', () => {
    const api = makeDock()
    const first = api.addPanel({ id: 'pane-a', component: 'test' })
    const second = api.addPanel({ id: 'pane-b', component: 'test', position: { referencePanel: first, direction: 'right' } })
    api.addPanel({ id: 'pane-c', component: 'test', position: { referencePanel: second, direction: 'right' } })

    const target = removePanelPreservingLayout(api.toJSON(), 'pane-b')
    expect(target).not.toBeNull()

    // pane-b was NOT closed, so the live grid still has three columns.
    expect(applySerializedGridSizes(api, target!)).toBe(false)
    expect(api.getPanel('pane-b')?.group.api.width).toBeCloseTo(200, 0)
  })

  it('refuses while a group is maximized', () => {
    const api = makeDock()
    const first = api.addPanel({ id: 'pane-a', component: 'test' })
    const second = api.addPanel({ id: 'pane-b', component: 'test', position: { referencePanel: first, direction: 'right' } })

    const target = api.toJSON()
    api.maximizeGroup(second)

    expect(applySerializedGridSizes(api, target)).toBe(false)
  })
})

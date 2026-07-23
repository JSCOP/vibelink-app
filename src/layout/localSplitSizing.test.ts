// @vitest-environment jsdom

import { createDockview, getGridLocation, type AddPanelOptions } from 'dockview-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { finalizeLocalSplitSize, localSplitInitialSize, localSplitSiblingIndex } from './localSplitSizing'

const disposals: Array<() => void> = []

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

describe('local terminal split sizing', () => {
  it('targets the selected sibling at the current split-tree depth', () => {
    expect(localSplitSiblingIndex([])).toBe(0)
    expect(localSplitSiblingIndex([2])).toBe(2)
    expect(localSplitSiblingIndex([1, 3])).toBe(3)
    expect(localSplitInitialSize([1], 'right')).toEqual({
      initialWidth: { type: 'split', index: 1 },
    })
    expect(localSplitInitialSize([2, 0], 'below')).toEqual({
      initialHeight: { type: 'split', index: 0 },
    })
  })

  it.each(['right', 'below'] as const)('halves only the selected pane for a %s split', (direction) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({
        element: document.createElement('div'),
        init: () => undefined,
      }),
    })
    disposals.push(() => api.dispose())
    api.layout(1200, 800)

    const first = api.addPanel({ id: 'first', component: 'test' })
    const second = api.addPanel({
      id: 'second',
      component: 'test',
      position: { referencePanel: first, direction },
    })
    const originalSize = direction === 'right' ? first.group.api.width : first.group.api.height
    const secondSize = direction === 'right' ? second.group.api.width : second.group.api.height
    expect(originalSize).toBeCloseTo(secondSize, 0)

    const createdOptions = {
      id: 'created',
      component: 'test',
      position: { referencePanel: first, direction },
      ...localSplitInitialSize(getGridLocation(first.group.element), direction),
    }
    const created = api.addPanel(createdOptions as AddPanelOptions)
    finalizeLocalSplitSize(first.group, created.group, direction, originalSize)

    const finalFirstSize = direction === 'right' ? first.group.api.width : first.group.api.height
    const finalCreatedSize = direction === 'right' ? created.group.api.width : created.group.api.height
    const finalSecondSize = direction === 'right' ? second.group.api.width : second.group.api.height
    expect(finalFirstSize).toBeCloseTo(originalSize / 2, 0)
    expect(finalCreatedSize).toBeCloseTo(originalSize / 2, 0)
    expect(finalSecondSize).toBeCloseTo(originalSize, 0)
  })

  it('preserves every unrelated sibling when splitting the middle pane', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({
        element: document.createElement('div'),
        init: () => undefined,
      }),
    })
    disposals.push(() => api.dispose())
    api.layout(1200, 800)

    const first = api.addPanel({ id: 'first', component: 'test' })
    const middle = api.addPanel({
      id: 'middle',
      component: 'test',
      position: { referencePanel: first, direction: 'right' },
    })
    const last = api.addPanel({
      id: 'last',
      component: 'test',
      position: { referencePanel: middle, direction: 'right' },
    })
    const middleWidth = middle.group.api.width
    const unrelatedWidths = [first.group.api.width, last.group.api.width]

    const created = api.addPanel({
      id: 'created',
      component: 'test',
      position: { referencePanel: middle, direction: 'right' },
      ...localSplitInitialSize(getGridLocation(middle.group.element), 'right'),
    } as AddPanelOptions)
    finalizeLocalSplitSize(middle.group, created.group, 'right', middleWidth)

    expect(middle.group.api.width).toBeCloseTo(middleWidth / 2, 0)
    expect(created.group.api.width).toBeCloseTo(middleWidth / 2, 0)
    expect(first.group.api.width).toBeCloseTo(unrelatedWidths[0], 0)
    expect(last.group.api.width).toBeCloseTo(unrelatedWidths[1], 0)
  })
  it('keeps four same-axis splits equal when each original pane is split once', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({
        element: document.createElement('div'),
        init: () => undefined,
      }),
    })
    disposals.push(() => api.dispose())
    api.layout(1200, 800)

    const first = api.addPanel({ id: 'first', component: 'test' })
    const second = api.addPanel({
      id: 'second',
      component: 'test',
      position: { referencePanel: first, direction: 'right' },
    })

    const split = (reference: typeof first, id: string) => {
      const originalWidth = reference.group.api.width
      const created = api.addPanel({
        id,
        component: 'test',
        position: { referencePanel: reference, direction: 'right' },
        ...localSplitInitialSize(getGridLocation(reference.group.element), 'right'),
      } as AddPanelOptions)
      finalizeLocalSplitSize(reference.group, created.group, 'right', originalWidth)
      return created
    }

    const third = split(first, 'third')
    const fourth = split(second, 'fourth')
    const widths = [first, third, second, fourth].map((panel) => panel.group.api.width)
    for (const width of widths) expect(width).toBeCloseTo(300, 0)
  })
})

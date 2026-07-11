import { describe, expect, it } from 'vitest'
import { connectedResizeDeltaAt, connectedResizeHandles, createConnectedResizeDragSession, createSingleResizeDragSession, resizeConnectedBoundaryAt, resizeConnectedBoundaryForPane, resizeSingleBoundaryAt, singleResizeDeltaAt, singleResizeHandleAt, singleResizeHandles } from './connectedResize'

const RAW_DELTAS = [-500, -40, -3, 0, 3, 35, 500] as const
const SNAP_TOLERANCES = [0, 32] as const

describe('connected dockview resizing', () => {
  it('resizes a connected vertical column boundary across rows', () => {
    const resized = resizeConnectedBoundaryForPane(makeGrid3x2(), 'pane-1', 'right', 25, 50) as TestLayout

    expect(resized.grid.root.data[1].size).toBe(125)
    expect(resized.grid.root.data[2].size).toBe(75)
    expect(resized.grid.root.data[1].data.map((child) => child.size)).toEqual([100, 100])
  })

  it('resizes connected horizontal row boundaries across columns', () => {
    const resized = resizeConnectedBoundaryForPane(makeGrid3x2(), 'pane-1', 'down', 20, 50) as TestLayout

    expect(resized.grid.root.data.map((column) => column.data[0].size)).toEqual([120, 120, 120])
    expect(resized.grid.root.data.map((column) => column.data[1].size)).toEqual([80, 80, 80])
  })

  it('clamps keyboard and mouse resize deltas to the smallest connected neighbor', () => {
    const resized = resizeConnectedBoundaryForPane(makeGrid3x2(), 'pane-1', 'down', 80, 70) as TestLayout

    expect(resized.grid.root.data.map((column) => column.data[0].size)).toEqual([130, 130, 130])
    expect(resized.grid.root.data.map((column) => column.data[1].size)).toEqual([70, 70, 70])
  })

  it('stops at the resize limit instead of reversing direction', () => {
    const layout = makeGrid3x2()
    layout.grid.root.data[0].size = 40
    layout.grid.root.data[1].size = 160
    layout.grid.root.data[2].size = 100
    layout.grid.root.data[0].data[0].size = 40
    layout.grid.root.data[0].data[1].size = 160

    expect(resizeConnectedBoundaryForPane(layout, 'pane-1', 'left', 20, 50)).toBeNull()
    expect(resizeConnectedBoundaryForPane(layout, 'pane-3', 'up', 20, 50)).toBeNull()
  })

  it('groups connected resize handles by shared line', () => {
    const handles = connectedResizeHandles(makeGrid3x2())

    expect(handles.filter((handle) => handle.axis === 'x')).toHaveLength(2)
    expect(handles.filter((handle) => handle.axis === 'y')).toHaveLength(1)
    expect(handles.find((handle) => handle.axis === 'y')).toMatchObject({ start: 0, end: 300 })
  })

  it('resolves connected previews without exposing clean shared dividers as single handles', () => {
    expect(connectedResizeDeltaAt(makeGrid3x2(), 'y', 100, 0, 300, 80, 70)).toBe(30)
    expect(singleResizeDeltaAt(makeGrid3x2(), 'y', 100, 50, 80, 70)).toBeNull()
    expect(singleResizeHandleAt(makeGrid3x2(), 'y', 100, 50)).toBeNull()
  })

  it('does not expose individual handles for fully connected clean dividers', () => {
    expect(singleResizeHandles(makeGrid3x2())).toEqual([])
  })

  it('exposes clean connected dividers as individual handles for Ctrl resize mode', () => {
    const handles = singleResizeHandles(makeGrid3x2(), true)

    expect(handles).toContainEqual(expect.objectContaining({ axis: 'y', coordinate: 100, start: 0, end: 100 }))
    expect(singleResizeHandleAt(makeGrid3x2(), 'y', 100, 50, true)).toMatchObject({ axis: 'y', coordinate: 100, start: 0, end: 100 })
  })

  it('can break a clean divider segment in Ctrl resize mode', () => {
    const resized = resizeSingleBoundaryAt(makeGrid3x2(), 'y', 100, 50, 20, 50, 32, true) as TestLayout

    expect(resized.grid.root.data[0].data.map((child) => child.size)).toEqual([120, 80])
    expect(resized.grid.root.data[1].data.map((child) => child.size)).toEqual([100, 100])
  })

  it('exposes individual handles only for broken divider segments that can rejoin a neighbor', () => {
    const handles = singleResizeHandles(makeBrokenHorizontalSegment())

    expect(handles).toContainEqual(expect.objectContaining({ axis: 'y', coordinate: 120, start: 0, end: 100 }))
    expect(handles).not.toContainEqual(expect.objectContaining({ axis: 'y', coordinate: 100, start: 100, end: 200 }))
  })

  it('maps left and up resize directions to the active pane boundary', () => {
    const left = resizeConnectedBoundaryForPane(makeGrid3x2(), 'pane-1', 'left', 20, 50) as TestLayout
    const up = resizeConnectedBoundaryForPane(makeGrid3x2(), 'pane-4', 'up', 20, 50) as TestLayout

    expect(left.grid.root.data.map((column) => column.size)).toEqual([80, 120, 100])
    expect(up.grid.root.data.map((column) => column.data[0].size)).toEqual([80, 80, 80])
    expect(up.grid.root.data.map((column) => column.data[1].size)).toEqual([120, 120, 120])
  })

  it('can resize one broken horizontal divider segment without moving connected segments', () => {
    const resized = resizeSingleBoundaryAt(makeBrokenHorizontalSegment(), 'y', 120, 50, 10, 50) as TestLayout

    expect(resized.grid.root.data[0].data.map((child) => child.size)).toEqual([130, 70])
    expect(resized.grid.root.data[1].data.map((child) => child.size)).toEqual([100, 100])
    expect(resized.grid.root.data[2].data.map((child) => child.size)).toEqual([100, 100])
  })

  it('can resize one broken vertical divider segment by rebuilding a rectangular grid', () => {
    const resized = resizeSingleBoundaryAt(makeBrokenVerticalSegment(), 'x', 120, 50, 10, 50) as TestLayout

    expect(resized.grid.orientation).toBe('VERTICAL')
    expect(resized.grid.root.data[0].data.map((child) => child.size)).toEqual([130, 70, 100])
    expect(resized.grid.root.data[1].data.map((child) => child.size)).toEqual([100, 100, 100])
  })

  it('groups a manually resized segment again when it snaps back to the shared line', () => {
    const snapped = resizeSingleBoundaryAt(makeBrokenHorizontalSegment(), 'y', 120, 50, -20, 50) as TestLayout

    expect(snapped.grid.root.data.map((column) => column.data[0].size)).toEqual([100, 100, 100])
    expect(connectedResizeHandles(snapped).filter((handle) => handle.axis === 'y')).toHaveLength(1)
    expect(connectedResizeHandles(snapped).find((handle) => handle.axis === 'y')).toMatchObject({ start: 0, end: 300 })
  })

  it('snaps a single divider segment back to a nearby shared line', () => {
    const snapped = resizeSingleBoundaryAt(makeBrokenHorizontalSegment(), 'y', 120, 50, -15, 50) as TestLayout

    expect(snapped.grid.root.data.map((column) => column.data[0].size)).toEqual([100, 100, 100])
    expect(connectedResizeHandles(snapped).filter((handle) => handle.axis === 'y')).toHaveLength(1)
  })

  it('uses the configured snap tolerance for single divider snapping', () => {
    const broken = makeBrokenHorizontalSegment(140)

    expect(singleResizeDeltaAt(broken, 'y', 140, 50, -20, 50, 12)).toBe(-20)
    expect(singleResizeDeltaAt(broken, 'y', 140, 50, -20, 50, 24)).toBe(-40)
  })

  it('snaps connected resize guides to nearby broken boundaries', () => {
    const broken = makeBrokenHorizontalSegment()

    expect(connectedResizeDeltaAt(broken, 'y', 120, 0, 100, -15, 50, 32)).toBe(-20)
    const snapped = resizeConnectedBoundaryAt(broken, 'y', 120, 0, 100, -15, 50, 32) as TestLayout

    expect(snapped.grid.root.data.map((column) => column.data[0].size)).toEqual([100, 100, 100])
  })

  it('does not promote connected dividers to individual handles after perpendicular segment resize', () => {
    const broken = makeBrokenVerticalSegment()

    expect(singleResizeHandleAt(broken, 'y', 100, 150)).toBeNull()
    expect(singleResizeHandleAt(makeBrokenHorizontalSegment(), 'x', 100, 50)).toBeNull()
  })

  it('keeps connected drag sessions in parity with connected resize math', () => {
    const cases = [
      { name: '2x2 rectangular grid', layout: makeGrid2x2(), axis: 'x' as const, coordinate: 120, start: 0, end: 200 },
      { name: 'split-column boundary', layout: makeThreeColumnWithSplitColumn(), axis: 'x' as const, coordinate: 100, start: 0, end: 200 },
      { name: 'snapping broken horizontal segment', layout: makeBrokenHorizontalSegment(104), axis: 'y' as const, coordinate: 104, start: 0, end: 100 },
    ]

    for (const resizeCase of cases) {
      for (const snapTolerance of SNAP_TOLERANCES) {
        const session = createConnectedResizeDragSession(
          resizeCase.layout,
          resizeCase.axis,
          resizeCase.coordinate,
          resizeCase.start,
          resizeCase.end,
          undefined,
          snapTolerance,
        )

        expect(session, `${resizeCase.name} session`).not.toBeNull()
        if (!session) continue

        for (const rawDelta of RAW_DELTAS) {
          const expectedDelta = connectedResizeDeltaAt(
            resizeCase.layout,
            resizeCase.axis,
            resizeCase.coordinate,
            resizeCase.start,
            resizeCase.end,
            rawDelta,
            undefined,
            snapTolerance,
          )
          const actualDelta = session.deltaFor(rawDelta)

          expect(actualDelta, `${resizeCase.name} raw ${rawDelta} tolerance ${snapTolerance}`).toBe(expectedDelta)
          expect(session.layoutFor(actualDelta), `${resizeCase.name} layout raw ${rawDelta} tolerance ${snapTolerance}`).toEqual(
            resizeConnectedBoundaryAt(
              resizeCase.layout,
              resizeCase.axis,
              resizeCase.coordinate,
              resizeCase.start,
              resizeCase.end,
              actualDelta,
              undefined,
              snapTolerance,
            ),
          )
        }

        expect(session.layoutFor(0), `${resizeCase.name} zero layout`).toBeNull()
      }
    }
  })

  it('precomputes live resize targets and affected panes', () => {
    const session = createConnectedResizeDragSession(makeGrid2x2(), 'x', 120, 0, 200)

    expect(session).not.toBeNull()
    expect(session?.liveTargets).toEqual([{ paneId: 'pane-2', axis: 'x', baseSize: 120 }])
    expect(session?.affectedPaneIds).toEqual(['pane-0', 'pane-2', 'pane-1', 'pane-3'])
  })

  it('keeps single drag sessions in parity with single resize math', () => {
    const cases = [
      { name: 'split-column segment', layout: makeThreeColumnWithSplitColumn(), axis: 'y' as const, coordinate: 100, point: 50 },
      { name: 'snapping broken horizontal segment', layout: makeBrokenHorizontalSegment(104), axis: 'y' as const, coordinate: 104, point: 50 },
    ]

    for (const resizeCase of cases) {
      for (const snapTolerance of SNAP_TOLERANCES) {
        const session = createSingleResizeDragSession(
          resizeCase.layout,
          resizeCase.axis,
          resizeCase.coordinate,
          resizeCase.point,
          undefined,
          snapTolerance,
          true,
        )

        expect(session, `${resizeCase.name} session`).not.toBeNull()
        if (!session) continue

        for (const rawDelta of RAW_DELTAS) {
          const expectedDelta = singleResizeDeltaAt(
            resizeCase.layout,
            resizeCase.axis,
            resizeCase.coordinate,
            resizeCase.point,
            rawDelta,
            undefined,
            snapTolerance,
            true,
          )
          const actualDelta = session.deltaFor(rawDelta)

          expect(actualDelta, `${resizeCase.name} raw ${rawDelta} tolerance ${snapTolerance}`).toBe(expectedDelta)
          expect(session.layoutFor(actualDelta), `${resizeCase.name} layout raw ${rawDelta} tolerance ${snapTolerance}`).toEqual(
            resizeSingleBoundaryAt(
              resizeCase.layout,
              resizeCase.axis,
              resizeCase.coordinate,
              resizeCase.point,
              actualDelta,
              undefined,
              snapTolerance,
              true,
            ),
          )
        }

        expect(session.layoutFor(0), `${resizeCase.name} zero layout`).toBeNull()
      }
    }
  })

  it('keeps clamped-out drags in parity and skips zero-delta layouts', () => {
    const connectedLayout = makeGrid2x2()
    const connectedSession = createConnectedResizeDragSession(connectedLayout, 'x', 120, 0, 200, undefined, 32)
    expect(connectedSession).not.toBeNull()
    if (connectedSession) {
      const delta = connectedSession.deltaFor(500)

      expect(delta).toBe(connectedResizeDeltaAt(connectedLayout, 'x', 120, 0, 200, 500, undefined, 32))
      expect(connectedSession.layoutFor(delta)).toEqual(resizeConnectedBoundaryAt(connectedLayout, 'x', 120, 0, 200, delta, undefined, 32))
      expect(connectedSession.layoutFor(0)).toBeNull()
    }

    const singleLayout = makeThreeColumnWithSplitColumn()
    const singleSession = createSingleResizeDragSession(singleLayout, 'y', 100, 50, undefined, 32, true)
    expect(singleSession).not.toBeNull()
    if (singleSession) {
      const delta = singleSession.deltaFor(-500)

      expect(delta).toBe(singleResizeDeltaAt(singleLayout, 'y', 100, 50, -500, undefined, 32, true))
      expect(singleSession.layoutFor(delta)).toEqual(resizeSingleBoundaryAt(singleLayout, 'y', 100, 50, delta, undefined, 32, true))
      expect(singleSession.layoutFor(0)).toBeNull()
    }
  })

  it('disables resize handles and deltas while a pane is maximized', () => {
    const layout = makeGrid3x2() as TestLayout
    layout.grid.maximizedNode = { location: [0, 0] }

    expect(connectedResizeHandles(layout)).toEqual([])
    expect(singleResizeHandles(layout)).toEqual([])
    expect(connectedResizeDeltaAt(layout, 'y', 100, 0, 300, 80, 70)).toBeNull()
    expect(singleResizeDeltaAt(layout, 'y', 100, 50, 80, 70)).toBeNull()
    expect(resizeConnectedBoundaryForPane(layout, 'pane-1', 'down', 20, 50)).toBeNull()
    expect(resizeSingleBoundaryAt(layout, 'y', 120, 50, 10, 50)).toBeNull()
  })
})

type TestLayout = {
  grid: {
    orientation: string
    maximizedNode?: { location: number[] }
    root: {
      data: Array<{
        size: number
        data: Array<{ size: number }>
      }>
    }
  }
}

function makeGrid3x2() {
  const leaf = (id: string, size = 100) => ({
    type: 'leaf' as const,
    size,
    data: { views: [id] },
  })

  const column = (top: string, bottom: string) => ({
    type: 'branch' as const,
    size: 100,
    data: [leaf(top), leaf(bottom)],
  })

  return {
    grid: {
      root: {
        type: 'branch' as const,
        size: 200,
        data: [
          column('pane-0', 'pane-3'),
          column('pane-1', 'pane-4'),
          column('pane-2', 'pane-5'),
        ],
      },
      width: 300,
      height: 200,
      orientation: 'HORIZONTAL',
    },
  }
}

function makeGrid2x2() {
  const leaf = (id: string, size = 100) => ({
    type: 'leaf' as const,
    size,
    data: { views: [id] },
  })

  const column = (top: string, bottom: string) => ({
    type: 'branch' as const,
    size: 120,
    data: [leaf(top), leaf(bottom)],
  })

  return {
    grid: {
      root: {
        type: 'branch' as const,
        size: 240,
        data: [column('pane-0', 'pane-2'), column('pane-1', 'pane-3')],
      },
      width: 240,
      height: 200,
      orientation: 'HORIZONTAL',
    },
  }
}

function makeThreeColumnWithSplitColumn() {
  const leaf = (id: string, size = 100) => ({
    type: 'leaf' as const,
    size,
    data: { views: [id] },
  })

  return {
    grid: {
      root: {
        type: 'branch' as const,
        size: 300,
        data: [
          {
            type: 'branch' as const,
            size: 100,
            data: [leaf('pane-0'), leaf('pane-3')],
          },
          leaf('pane-1'),
          leaf('pane-2'),
        ],
      },
      width: 300,
      height: 200,
      orientation: 'HORIZONTAL',
    },
  }
}

function makeBrokenHorizontalSegment(topSize = 120) {
  const leaf = (id: string, size = 100) => ({
    type: 'leaf' as const,
    size,
    data: { views: [id] },
  })

  const column = (top: string, bottom: string, firstSize = 100) => ({
    type: 'branch' as const,
    size: 100,
    data: [leaf(top, firstSize), leaf(bottom, 200 - firstSize)],
  })

  return {
    grid: {
      root: {
        type: 'branch' as const,
        size: 300,
        data: [
          column('pane-0', 'pane-3', topSize),
          column('pane-1', 'pane-4'),
          column('pane-2', 'pane-5'),
        ],
      },
      width: 300,
      height: 200,
      orientation: 'HORIZONTAL',
    },
  }
}

function makeBrokenVerticalSegment(leftSize = 120) {
  const leaf = (id: string, size = 100) => ({
    type: 'leaf' as const,
    size,
    data: { views: [id] },
  })

  const row = (left: string, middle: string, right: string, firstSize = 100) => ({
    type: 'branch' as const,
    size: 100,
    data: [leaf(left, firstSize), leaf(middle, 200 - firstSize), leaf(right)],
  })

  return {
    grid: {
      root: {
        type: 'branch' as const,
        size: 200,
        data: [
          row('pane-0', 'pane-1', 'pane-2', leftSize),
          row('pane-3', 'pane-4', 'pane-5'),
        ],
      },
      width: 300,
      height: 200,
      orientation: 'VERTICAL',
    },
  }
}

type SplitAxis = 'x' | 'y'
export type ResizeDirection = 'left' | 'right' | 'up' | 'down'

type Rect = {
  x: number
  y: number
  width: number
  height: number
}

type SerializedLeafNode = {
  type: 'leaf'
  data: {
    views?: string[]
  } & Record<string, unknown>
  size: number
}

type SerializedBranchNode = {
  type: 'branch'
  data: SerializedNode[]
  size: number
}

type SerializedNode = SerializedLeafNode | SerializedBranchNode

type DockviewLayoutLike = {
  grid?: {
    root?: SerializedNode
    width?: number
    height?: number
    orientation?: string
  }
}

type LeafRect = {
  paneIds: string[]
  rect: Rect
  node: SerializedLeafNode
}

type Boundary = {
  axis: SplitAxis
  coordinate: number
  start: number
  end: number
  path: number[]
  index: number
}

export type ConnectedResizeHandle = {
  id: string
  axis: SplitAxis
  coordinate: number
  start: number
  end: number
}

const COORDINATE_TOLERANCE = 2
const CONNECTED_GAP_TOLERANCE = 3
const SINGLE_POINT_TOLERANCE = 12
export const DEFAULT_SNAP_TOLERANCE = 32
const DEFAULT_MIN_SIZE = 96

export function resizeConnectedBoundaryForPane(
  layout: unknown,
  paneId: string,
  direction: ResizeDirection,
  amount: number,
  minSize = DEFAULT_MIN_SIZE,
): unknown | null {
  const analysis = analyzeLayout(layout)
  if (!analysis) return null

  const leaf = analysis.leaves.find((item) => item.paneIds.includes(paneId))
  if (!leaf) return null

  const axis = direction === 'left' || direction === 'right' ? 'x' : 'y'
  const coordinate = direction === 'right'
    ? leaf.rect.x + leaf.rect.width
    : direction === 'left'
      ? leaf.rect.x
      : direction === 'down'
        ? leaf.rect.y + leaf.rect.height
        : leaf.rect.y
  const delta = direction === 'right' || direction === 'down' ? amount : -amount
  const span = axis === 'x'
    ? { start: leaf.rect.y, end: leaf.rect.y + leaf.rect.height }
    : { start: leaf.rect.x, end: leaf.rect.x + leaf.rect.width }

  return resizeConnectedBoundaryAt(layout, axis, coordinate, span.start, span.end, delta, minSize)
}

export function resizeConnectedBoundaryAt(
  layout: unknown,
  axis: SplitAxis,
  coordinate: number,
  start: number,
  end: number,
  delta: number,
  minSize = DEFAULT_MIN_SIZE,
): unknown | null {
  const analysis = analyzeLayout(layout)
  if (!analysis) return null

  const selected = selectConnectedBoundaries(analysis.boundaries, axis, coordinate, start, end)
  if (selected.length === 0) return null

  const next = structuredClone(layout) as DockviewLayoutLike
  const root = next.grid?.root
  if (!root) return null

  const clampedDelta = clampDelta(root, selected, delta, minSize)
  if (Math.abs(clampedDelta) < 1) return null

  for (const boundary of selected) {
    const branch = nodeAtPath(root, boundary.path)
    if (!branch || branch.type !== 'branch') continue
    const before = branch.data[boundary.index]
    const after = branch.data[boundary.index + 1]
    if (!before || !after) continue
    before.size = Math.max(minSize, Math.round(before.size + clampedDelta))
    after.size = Math.max(minSize, Math.round(after.size - clampedDelta))
  }

  return next
}

export function connectedResizeDeltaAt(
  layout: unknown,
  axis: SplitAxis,
  coordinate: number,
  start: number,
  end: number,
  delta: number,
  minSize = DEFAULT_MIN_SIZE,
): number | null {
  const analysis = analyzeLayout(layout)
  if (!analysis) return null

  const selected = selectConnectedBoundaries(analysis.boundaries, axis, coordinate, start, end)
  if (selected.length === 0) return null

  const root = (layout as DockviewLayoutLike).grid?.root
  if (!root) return null

  return clampDelta(root, selected, delta, minSize)
}

export function resizeSingleBoundaryAt(
  layout: unknown,
  axis: SplitAxis,
  coordinate: number,
  point: number,
  delta: number,
  minSize = DEFAULT_MIN_SIZE,
  snapTolerance = DEFAULT_SNAP_TOLERANCE,
): unknown | null {
  const workingLayout = normalizeLayoutForSingleResize(layout, axis) ?? layout
  const analysis = analyzeLayout(workingLayout)
  if (!analysis) return null

  const selected = selectSingleBoundary(analysis.boundaries, axis, coordinate, point)
  if (!selected) return null

  const next = structuredClone(workingLayout) as DockviewLayoutLike
  const root = next.grid?.root
  if (!root) return null

  const clampedDelta = snapSingleDelta(root, analysis.boundaries, selected, clampDelta(root, [selected], delta, minSize), minSize, snapTolerance)
  if (Math.abs(clampedDelta) < 1) return null

  const branch = nodeAtPath(root, selected.path)
  if (!branch || branch.type !== 'branch') return null
  const before = branch.data[selected.index]
  const after = branch.data[selected.index + 1]
  if (!before || !after) return null

  before.size = Math.max(minSize, Math.round(before.size + clampedDelta))
  after.size = Math.max(minSize, Math.round(after.size - clampedDelta))

  return next
}

export function singleResizeDeltaAt(
  layout: unknown,
  axis: SplitAxis,
  coordinate: number,
  point: number,
  delta: number,
  minSize = DEFAULT_MIN_SIZE,
  snapTolerance = DEFAULT_SNAP_TOLERANCE,
): number | null {
  const workingLayout = normalizeLayoutForSingleResize(layout, axis) ?? layout
  const analysis = analyzeLayout(workingLayout)
  if (!analysis) return null

  const selected = selectSingleBoundary(analysis.boundaries, axis, coordinate, point)
  if (!selected) return null

  const root = (workingLayout as DockviewLayoutLike).grid?.root
  if (!root) return null

  return snapSingleDelta(root, analysis.boundaries, selected, clampDelta(root, [selected], delta, minSize), minSize, snapTolerance)
}

export function singleResizeHandleAt(
  layout: unknown,
  axis: SplitAxis,
  coordinate: number,
  point: number,
): ConnectedResizeHandle | null {
  const workingLayout = normalizeLayoutForSingleResize(layout, axis) ?? layout
  const analysis = analyzeLayout(workingLayout)
  if (!analysis) return null

  const selected = selectSingleBoundary(analysis.boundaries, axis, coordinate, point)
  if (!selected) return null

  return {
    id: `single:${axis}:${Math.round(selected.coordinate)}:${Math.round(selected.start)}:${Math.round(selected.end)}`,
    axis,
    coordinate: selected.coordinate,
    start: selected.start,
    end: selected.end,
  }
}

export function connectedResizeHandles(layout: unknown): ConnectedResizeHandle[] {
  const analysis = analyzeLayout(layout)
  if (!analysis) return []
  return groupConnectedBoundaries(analysis.boundaries)
}

export function singleResizeHandles(layout: unknown): ConnectedResizeHandle[] {
  const handles: ConnectedResizeHandle[] = []
  for (const axis of ['x', 'y'] as const) {
    const workingLayout = normalizeLayoutForSingleResize(layout, axis) ?? layout
    const analysis = analyzeLayout(workingLayout)
    if (!analysis) continue
    for (const boundary of analysis.boundaries.filter((item) => item.axis === axis)) {
      handles.push({
        id: `single:${axis}:${Math.round(boundary.coordinate)}:${Math.round(boundary.start)}:${Math.round(boundary.end)}`,
        axis,
        coordinate: boundary.coordinate,
        start: boundary.start,
        end: boundary.end,
      })
    }
  }
  return handles
}

function analyzeLayout(layout: unknown): { leaves: LeafRect[]; boundaries: Boundary[] } | null {
  if (!isLayout(layout)) return null
  const root = layout.grid?.root
  const width = layout.grid?.width
  const height = layout.grid?.height
  if (!root || !width || !height) return null

  const leaves: LeafRect[] = []
  const boundaries: Boundary[] = []
  collectLayout(root, { x: 0, y: 0, width, height }, axisFromOrientation(layout.grid?.orientation), [], leaves, boundaries)
  return { leaves, boundaries }
}

function collectLayout(
  node: SerializedNode,
  rect: Rect,
  axis: SplitAxis,
  path: number[],
  leaves: LeafRect[],
  boundaries: Boundary[],
): void {
  if (node.type === 'leaf') {
    leaves.push({ paneIds: node.data.views ?? [], rect, node })
    return
  }

  let offset = axis === 'x' ? rect.x : rect.y
  const childRects: Rect[] = []
  node.data.forEach((child, index) => {
    const size = Math.max(0, Number(child.size) || 0)
    const childRect = axis === 'x'
      ? { x: offset, y: rect.y, width: size, height: rect.height }
      : { x: rect.x, y: offset, width: rect.width, height: size }
    childRects.push(childRect)
    collectLayout(child, childRect, oppositeAxis(axis), [...path, index], leaves, boundaries)
    offset += size
  })

  for (let index = 0; index < childRects.length - 1; index += 1) {
    const before = childRects[index]
    boundaries.push({
      axis,
      coordinate: axis === 'x' ? before.x + before.width : before.y + before.height,
      start: axis === 'x' ? rect.y : rect.x,
      end: axis === 'x' ? rect.y + rect.height : rect.x + rect.width,
      path,
      index,
    })
  }
}

function normalizeLayoutForSingleResize(layout: unknown, resizeAxis: SplitAxis): DockviewLayoutLike | null {
  if (!isLayout(layout)) return null
  const grid = layout.grid
  const width = grid?.width
  const height = grid?.height
  if (!grid?.root || !width || !height) return null

  const analysis = analyzeLayout(layout)
  if (!analysis || analysis.leaves.length === 0) return null

  const targetRootAxis = resizeAxis === 'x' ? 'y' : 'x'
  return rebuildRectangularLayout(layout, analysis.leaves, targetRootAxis, width, height)
}

function rebuildRectangularLayout(
  layout: DockviewLayoutLike,
  leaves: LeafRect[],
  rootAxis: SplitAxis,
  width: number,
  height: number,
): DockviewLayoutLike | null {
  const xCoordinates = sortedCoordinates(leaves.flatMap((leaf) => [leaf.rect.x, leaf.rect.x + leaf.rect.width]))
  const yCoordinates = sortedCoordinates(leaves.flatMap((leaf) => [leaf.rect.y, leaf.rect.y + leaf.rect.height]))
  if (xCoordinates.length < 2 || yCoordinates.length < 2) return null

  const leafByCell = new Map<string, LeafRect>()
  const usedLeaves = new Set<LeafRect>()
  for (let row = 0; row < yCoordinates.length - 1; row += 1) {
    for (let col = 0; col < xCoordinates.length - 1; col += 1) {
      const cell = {
        x: xCoordinates[col],
        y: yCoordinates[row],
        width: xCoordinates[col + 1] - xCoordinates[col],
        height: yCoordinates[row + 1] - yCoordinates[row],
      }
      const leaf = leaves.find((item) => rectsMatch(item.rect, cell))
      if (!leaf || usedLeaves.has(leaf)) return null
      usedLeaves.add(leaf)
      leafByCell.set(`${row}:${col}`, leaf)
    }
  }
  if (usedLeaves.size !== leaves.length) return null

  const next = structuredClone(layout) as DockviewLayoutLike
  if (!next.grid) return null

  if (rootAxis === 'y') {
    next.grid.orientation = 'VERTICAL'
    next.grid.root = {
      type: 'branch',
      size: height,
      data: yCoordinates.slice(0, -1).map((y, row) => ({
        type: 'branch',
        size: yCoordinates[row + 1] - y,
        data: xCoordinates.slice(0, -1).map((x, col) => {
          const leaf = structuredClone(leafByCell.get(`${row}:${col}`)?.node)
          if (!leaf) throw new Error('missing rectangular leaf')
          leaf.size = xCoordinates[col + 1] - x
          return leaf
        }),
      })),
    }
  } else {
    next.grid.orientation = 'HORIZONTAL'
    next.grid.root = {
      type: 'branch',
      size: width,
      data: xCoordinates.slice(0, -1).map((x, col) => ({
        type: 'branch',
        size: xCoordinates[col + 1] - x,
        data: yCoordinates.slice(0, -1).map((y, row) => {
          const leaf = structuredClone(leafByCell.get(`${row}:${col}`)?.node)
          if (!leaf) throw new Error('missing rectangular leaf')
          leaf.size = yCoordinates[row + 1] - y
          return leaf
        }),
      })),
    }
  }

  return next
}

function sortedCoordinates(values: number[]): number[] {
  const coordinates: number[] = []
  for (const value of values.sort((a, b) => a - b)) {
    const previous = coordinates.at(-1)
    if (previous === undefined || Math.abs(previous - value) > COORDINATE_TOLERANCE) {
      coordinates.push(value)
    }
  }
  return coordinates
}

function rectsMatch(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) <= COORDINATE_TOLERANCE
    && Math.abs(a.y - b.y) <= COORDINATE_TOLERANCE
    && Math.abs(a.width - b.width) <= COORDINATE_TOLERANCE
    && Math.abs(a.height - b.height) <= COORDINATE_TOLERANCE
}

function selectConnectedBoundaries(boundaries: Boundary[], axis: SplitAxis, coordinate: number, start: number, end: number): Boundary[] {
  const candidates = boundaries.filter((boundary) => boundary.axis === axis && Math.abs(boundary.coordinate - coordinate) <= COORDINATE_TOLERANCE)
  const selected = new Set<Boundary>()
  const queue = candidates.filter((boundary) => intervalsTouch(boundary.start, boundary.end, start, end))
  for (const boundary of queue) selected.add(boundary)

  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) continue
    for (const candidate of candidates) {
      if (selected.has(candidate)) continue
      if (!intervalsTouch(current.start, current.end, candidate.start, candidate.end)) continue
      selected.add(candidate)
      queue.push(candidate)
    }
  }

  return [...selected]
}

function selectSingleBoundary(boundaries: Boundary[], axis: SplitAxis, coordinate: number, point: number): Boundary | null {
  const candidates = boundaries.filter((boundary) =>
    boundary.axis === axis
    && Math.abs(boundary.coordinate - coordinate) <= COORDINATE_TOLERANCE
    && point >= boundary.start - SINGLE_POINT_TOLERANCE
    && point <= boundary.end + SINGLE_POINT_TOLERANCE,
  )
  if (candidates.length === 0) return null

  return candidates.reduce((best, candidate) => {
    const bestLength = best.end - best.start
    const candidateLength = candidate.end - candidate.start
    if (candidateLength !== bestLength) return candidateLength < bestLength ? candidate : best
    return Math.abs(candidate.coordinate - coordinate) < Math.abs(best.coordinate - coordinate) ? candidate : best
  })
}

function snapSingleDelta(root: SerializedNode, boundaries: Boundary[], selected: Boundary, delta: number, minSize: number, snapTolerance: number): number {
  if (Math.abs(delta) < 1) return delta
  const tolerance = Math.max(0, snapTolerance)
  const targetCoordinate = selected.coordinate + delta
  const snapTarget = boundaries
    .filter((boundary) =>
      boundary !== selected
      && boundary.axis === selected.axis
      && Math.abs(boundary.coordinate - selected.coordinate) > COORDINATE_TOLERANCE
      && Math.abs(boundary.coordinate - targetCoordinate) <= tolerance,
    )
    .sort((a, b) => Math.abs(a.coordinate - targetCoordinate) - Math.abs(b.coordinate - targetCoordinate))[0]
  if (!snapTarget) return delta

  const snappedDelta = snapTarget.coordinate - selected.coordinate
  const clamped = clampDelta(root, [selected], snappedDelta, minSize)
  if (Math.abs(clamped - snappedDelta) > COORDINATE_TOLERANCE) return delta
  return clamped
}

function groupConnectedBoundaries(boundaries: Boundary[]): ConnectedResizeHandle[] {
  const handles: ConnectedResizeHandle[] = []
  const remaining = new Set(boundaries)

  for (const boundary of boundaries) {
    if (!remaining.has(boundary)) continue
    remaining.delete(boundary)
    const group = [boundary]
    const queue = [boundary]

    while (queue.length > 0) {
      const current = queue.shift()
      if (!current) continue
      for (const candidate of [...remaining]) {
        if (candidate.axis !== boundary.axis) continue
        if (Math.abs(candidate.coordinate - boundary.coordinate) > COORDINATE_TOLERANCE) continue
        if (!intervalsTouch(current.start, current.end, candidate.start, candidate.end)) continue
        remaining.delete(candidate)
        group.push(candidate)
        queue.push(candidate)
      }
    }

    handles.push({
      id: `${boundary.axis}:${Math.round(boundary.coordinate)}:${Math.round(Math.min(...group.map((item) => item.start)))}`,
      axis: boundary.axis,
      coordinate: average(group.map((item) => item.coordinate)),
      start: Math.min(...group.map((item) => item.start)),
      end: Math.max(...group.map((item) => item.end)),
    })
  }

  return handles
}

function clampDelta(root: SerializedNode, boundaries: Boundary[], delta: number, minSize: number): number {
  let lower = Number.NEGATIVE_INFINITY
  let upper = Number.POSITIVE_INFINITY

  for (const boundary of boundaries) {
    const branch = nodeAtPath(root, boundary.path)
    if (!branch || branch.type !== 'branch') continue
    const before = branch.data[boundary.index]
    const after = branch.data[boundary.index + 1]
    if (!before || !after) continue
    lower = Math.max(lower, minSize - before.size)
    upper = Math.min(upper, after.size - minSize)
  }

  if (lower > upper) return 0

  const clamped = Math.max(lower, Math.min(upper, delta))
  if (delta < 0 && clamped > 0) return 0
  if (delta > 0 && clamped < 0) return 0
  return clamped
}

function nodeAtPath(root: SerializedNode, path: number[]): SerializedNode | null {
  let current: SerializedNode = root
  for (const index of path) {
    if (current.type !== 'branch') return null
    const next = current.data[index]
    if (!next) return null
    current = next
  }
  return current
}

function intervalsTouch(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart <= bEnd + CONNECTED_GAP_TOLERANCE && bStart <= aEnd + CONNECTED_GAP_TOLERANCE
}

function axisFromOrientation(orientation: string | undefined): SplitAxis {
  return orientation === 'VERTICAL' ? 'y' : 'x'
}

function oppositeAxis(axis: SplitAxis): SplitAxis {
  return axis === 'x' ? 'y' : 'x'
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)
}

function isLayout(value: unknown): value is DockviewLayoutLike {
  return typeof value === 'object' && value !== null && 'grid' in value
}

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
    maximizedNode?: unknown
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
  snapTolerance = 0,
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

  return resizeConnectedBoundaryAt(layout, axis, coordinate, span.start, span.end, delta, minSize, snapTolerance)
}

export function resizeConnectedBoundaryAt(
  layout: unknown,
  axis: SplitAxis,
  coordinate: number,
  start: number,
  end: number,
  delta: number,
  minSize = DEFAULT_MIN_SIZE,
  snapTolerance = 0,
): unknown | null {
  const analysis = analyzeLayout(layout)
  if (!analysis) return null

  const selected = selectConnectedBoundaries(analysis.boundaries, axis, coordinate, start, end)
  if (selected.length === 0) return null

  const next = structuredClone(layout) as DockviewLayoutLike
  const root = next.grid?.root
  if (!root) return null

  const clampedDelta = clampDelta(root, selected, delta, minSize)
  const snappedDelta = snapConnectedDelta(root, analysis.boundaries, selected, clampedDelta, minSize, snapTolerance)
  if (Math.abs(snappedDelta) < 1) return null

  for (const boundary of selected) {
    const branch = nodeAtPath(root, boundary.path)
    if (!branch || branch.type !== 'branch') continue
    const before = branch.data[boundary.index]
    const after = branch.data[boundary.index + 1]
    if (!before || !after) continue
    before.size = Math.max(minSize, Math.round(before.size + snappedDelta))
    after.size = Math.max(minSize, Math.round(after.size - snappedDelta))
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
  snapTolerance = 0,
): number | null {
  const analysis = analyzeLayout(layout)
  if (!analysis) return null

  const selected = selectConnectedBoundaries(analysis.boundaries, axis, coordinate, start, end)
  if (selected.length === 0) return null

  const root = (layout as DockviewLayoutLike).grid?.root
  if (!root) return null

  return snapConnectedDelta(root, analysis.boundaries, selected, clampDelta(root, selected, delta, minSize), minSize, snapTolerance)
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
  const selectedHandle = singleResizeHandleAt(layout, axis, coordinate, point)
  if (!selectedHandle) return null

  const workingLayout = normalizeLayoutForSingleResize(layout, axis, selectedHandle, snapTolerance)
  if (!workingLayout) return null

  const analysis = analyzeLayout(workingLayout)
  if (!analysis) return null

  const selected = selectSingleBoundary(analysis.boundaries, axis, selectedHandle.coordinate, point)
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
  const selectedHandle = singleResizeHandleAt(layout, axis, coordinate, point)
  if (!selectedHandle) return null

  const workingLayout = normalizeLayoutForSingleResize(layout, axis, selectedHandle, snapTolerance)
  if (!workingLayout) return null

  const analysis = analyzeLayout(workingLayout)
  if (!analysis) return null

  const selected = selectSingleBoundary(analysis.boundaries, axis, selectedHandle.coordinate, point)
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
  return selectSingleHandle(leafAdjacentResizeHandles(layout, axis), axis, coordinate, point)
}

export function connectedResizeHandles(layout: unknown): ConnectedResizeHandle[] {
  const analysis = analyzeLayout(layout)
  if (!analysis) return []
  return groupConnectedBoundaries(analysis.boundaries)
}

export function singleResizeHandles(layout: unknown): ConnectedResizeHandle[] {
  return [
    ...leafAdjacentResizeHandles(layout, 'x'),
    ...leafAdjacentResizeHandles(layout, 'y'),
  ]
}

function analyzeLayout(layout: unknown): { leaves: LeafRect[]; boundaries: Boundary[] } | null {
  if (!isLayout(layout)) return null
  const root = layout.grid?.root
  const width = layout.grid?.width
  const height = layout.grid?.height
  if (!root || !width || !height || layout.grid?.maximizedNode) return null

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

function normalizeLayoutForSingleResize(
  layout: unknown,
  resizeAxis: SplitAxis,
  selectedHandle: ConnectedResizeHandle,
  snapTolerance: number,
): DockviewLayoutLike | null {
  if (!isLayout(layout)) return null
  const grid = layout.grid
  const width = grid?.width
  const height = grid?.height
  if (!grid?.root || !width || !height) return null

  const analysis = analyzeLayout(layout)
  if (!analysis || analysis.leaves.length === 0) return null

  const targetRootAxis = resizeAxis === 'x' ? 'y' : 'x'
  return rebuildRectangularLayout(layout, analysis.leaves, targetRootAxis, width, height)
    ?? rebuildSlicedLayoutForSingleResize(layout, analysis.leaves, targetRootAxis, selectedHandle, width, height, snapTolerance)
}

function leafAdjacentResizeHandles(layout: unknown, axis: SplitAxis): ConnectedResizeHandle[] {
  const analysis = analyzeLayout(layout)
  if (!analysis) return []

  const handles: ConnectedResizeHandle[] = []
  const seen = new Set<string>()
  for (let leftIndex = 0; leftIndex < analysis.leaves.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < analysis.leaves.length; rightIndex += 1) {
      const handle = leafAdjacentResizeHandle(analysis.leaves[leftIndex], analysis.leaves[rightIndex], axis)
      if (!handle) continue
      if (!isSingleResizeHandleEligible(handle, analysis.boundaries)) continue
      const key = `${handle.axis}:${Math.round(handle.coordinate)}:${Math.round(handle.start)}:${Math.round(handle.end)}`
      if (seen.has(key)) continue
      seen.add(key)
      handles.push({ ...handle, id: `single:${key}` })
    }
  }

  return handles.sort((a, b) => a.axis.localeCompare(b.axis)
    || a.coordinate - b.coordinate
    || a.start - b.start
    || a.end - b.end)
}

function leafAdjacentResizeHandle(a: LeafRect, b: LeafRect, axis: SplitAxis): Omit<ConnectedResizeHandle, 'id'> | null {
  if (axis === 'x') {
    const aRight = a.rect.x + a.rect.width
    const bRight = b.rect.x + b.rect.width
    const coordinate = Math.abs(aRight - b.rect.x) <= COORDINATE_TOLERANCE
      ? average([aRight, b.rect.x])
      : Math.abs(bRight - a.rect.x) <= COORDINATE_TOLERANCE
        ? average([bRight, a.rect.x])
        : null
    if (coordinate === null) return null
    const start = Math.max(a.rect.y, b.rect.y)
    const end = Math.min(a.rect.y + a.rect.height, b.rect.y + b.rect.height)
    if (end - start <= COORDINATE_TOLERANCE) return null
    return { axis, coordinate, start, end }
  }

  const aBottom = a.rect.y + a.rect.height
  const bBottom = b.rect.y + b.rect.height
  const coordinate = Math.abs(aBottom - b.rect.y) <= COORDINATE_TOLERANCE
    ? average([aBottom, b.rect.y])
    : Math.abs(bBottom - a.rect.y) <= COORDINATE_TOLERANCE
      ? average([bBottom, a.rect.y])
      : null
  if (coordinate === null) return null
  const start = Math.max(a.rect.x, b.rect.x)
  const end = Math.min(a.rect.x + a.rect.width, b.rect.x + b.rect.width)
  if (end - start <= COORDINATE_TOLERANCE) return null
  return { axis, coordinate, start, end }
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

function rebuildSlicedLayoutForSingleResize(
  layout: DockviewLayoutLike,
  leaves: LeafRect[],
  rootAxis: SplitAxis,
  selectedHandle: ConnectedResizeHandle,
  width: number,
  height: number,
  snapTolerance: number,
): DockviewLayoutLike | null {
  const rootSize = rootAxis === 'x' ? width : height
  const nestedSize = rootAxis === 'x' ? height : width
  const rootCoordinates = snappedCoordinatesForAxis(
    leaves.flatMap((leaf) => rootAxis === 'x'
      ? [leaf.rect.x, leaf.rect.x + leaf.rect.width]
      : [leaf.rect.y, leaf.rect.y + leaf.rect.height]),
    [0, selectedHandle.start, selectedHandle.end, rootSize],
    Math.max(COORDINATE_TOLERANCE, snapTolerance),
  )

  if (rootCoordinates.length < 2) return null
  if (Math.abs(rootCoordinates[0] - 0) > COORDINATE_TOLERANCE) return null
  if (Math.abs(rootCoordinates[rootCoordinates.length - 1] - rootSize) > COORDINATE_TOLERANCE) return null

  const assignments = new Map<number, LeafRect[]>()
  const usedLeaves = new Set<LeafRect>()
  for (const leaf of leaves) {
    const start = rootAxis === 'x' ? leaf.rect.x : leaf.rect.y
    const end = rootAxis === 'x' ? leaf.rect.x + leaf.rect.width : leaf.rect.y + leaf.rect.height
    const startIndex = nearestCoordinateIndex(rootCoordinates, start, Math.max(COORDINATE_TOLERANCE, snapTolerance))
    const endIndex = nearestCoordinateIndex(rootCoordinates, end, Math.max(COORDINATE_TOLERANCE, snapTolerance))
    if (startIndex < 0 || endIndex < 0 || endIndex - startIndex !== 1) return null
    const items = assignments.get(startIndex) ?? []
    items.push(leaf)
    assignments.set(startIndex, items)
    usedLeaves.add(leaf)
  }
  if (usedLeaves.size !== leaves.length) return null

  const rootChildren: SerializedNode[] = []
  for (let index = 0; index < rootCoordinates.length - 1; index += 1) {
    const bandLeaves = assignments.get(index)
    if (!bandLeaves || bandLeaves.length === 0) return null
    if (!coversNestedAxis(bandLeaves, rootAxis === 'x' ? 'y' : 'x', nestedSize)) return null

    const bandSize = rootCoordinates[index + 1] - rootCoordinates[index]
    const sortedLeaves = [...bandLeaves].sort((a, b) => rootAxis === 'x'
      ? a.rect.y - b.rect.y
      : a.rect.x - b.rect.x)

    if (sortedLeaves.length === 1) {
      const leaf = structuredClone(sortedLeaves[0].node)
      leaf.size = bandSize
      rootChildren.push(leaf)
      continue
    }

    rootChildren.push({
      type: 'branch',
      size: bandSize,
      data: sortedLeaves.map((item) => {
        const leaf = structuredClone(item.node)
        leaf.size = rootAxis === 'x' ? item.rect.height : item.rect.width
        return leaf
      }),
    })
  }

  const next = structuredClone(layout) as DockviewLayoutLike
  if (!next.grid) return null
  next.grid.orientation = rootAxis === 'x' ? 'HORIZONTAL' : 'VERTICAL'
  next.grid.root = {
    type: 'branch',
    size: rootSize,
    data: rootChildren,
  }
  return next
}

function snappedCoordinatesForAxis(values: number[], anchors: number[], tolerance: number): number[] {
  return sortedCoordinates([
    ...anchors,
    ...values.map((value) => {
      const anchor = nearestCoordinate(anchors, value, tolerance)
      return anchor ?? value
    }),
  ])
}

function nearestCoordinate(values: number[], target: number, tolerance: number): number | null {
  let best: { value: number; distance: number } | null = null
  for (const value of values) {
    const distance = Math.abs(value - target)
    if (distance > tolerance) continue
    if (!best || distance < best.distance) best = { value, distance }
  }
  return best?.value ?? null
}

function nearestCoordinateIndex(values: number[], target: number, tolerance: number): number {
  let best: { index: number; distance: number } | null = null
  for (let index = 0; index < values.length; index += 1) {
    const distance = Math.abs(values[index] - target)
    if (distance > tolerance) continue
    if (!best || distance < best.distance) best = { index, distance }
  }
  return best?.index ?? -1
}

function coversNestedAxis(leaves: LeafRect[], axis: SplitAxis, size: number): boolean {
  const sorted = [...leaves].sort((a, b) => axis === 'x' ? a.rect.x - b.rect.x : a.rect.y - b.rect.y)
  let cursor = 0
  for (const leaf of sorted) {
    const start = axis === 'x' ? leaf.rect.x : leaf.rect.y
    const end = axis === 'x' ? leaf.rect.x + leaf.rect.width : leaf.rect.y + leaf.rect.height
    if (Math.abs(start - cursor) > COORDINATE_TOLERANCE) return false
    cursor = end
  }
  return Math.abs(cursor - size) <= COORDINATE_TOLERANCE
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

function selectSingleHandle(handles: ConnectedResizeHandle[], axis: SplitAxis, coordinate: number, point: number): ConnectedResizeHandle | null {
  const candidates = handles.filter((handle) =>
    handle.axis === axis
    && Math.abs(handle.coordinate - coordinate) <= COORDINATE_TOLERANCE
    && point >= handle.start - SINGLE_POINT_TOLERANCE
    && point <= handle.end + SINGLE_POINT_TOLERANCE,
  )
  if (candidates.length === 0) return null

  return candidates.reduce((best, candidate) => {
    const bestLength = best.end - best.start
    const candidateLength = candidate.end - candidate.start
    if (candidateLength !== bestLength) return candidateLength < bestLength ? candidate : best
    return Math.abs(candidate.coordinate - coordinate) < Math.abs(best.coordinate - coordinate) ? candidate : best
  })
}

function isSingleResizeHandleEligible(handle: Omit<ConnectedResizeHandle, 'id'>, boundaries: Boundary[]): boolean {
  const group = selectConnectedBoundaries(boundaries, handle.axis, handle.coordinate, handle.start, handle.end)
  if (group.length === 0) return false
  const groupStart = Math.min(...group.map((boundary) => boundary.start))
  const groupEnd = Math.max(...group.map((boundary) => boundary.end))
  if (Math.abs(groupStart - handle.start) > COORDINATE_TOLERANCE) return false
  if (Math.abs(groupEnd - handle.end) > COORDINATE_TOLERANCE) return false

  return boundaries.some((boundary) =>
    !group.includes(boundary)
    && boundary.axis === handle.axis
    && Math.abs(boundary.coordinate - handle.coordinate) > COORDINATE_TOLERANCE
    && intervalsMeetAtEndpoint(boundary.start, boundary.end, handle.start, handle.end),
  )
}

function snapConnectedDelta(root: SerializedNode, boundaries: Boundary[], selected: Boundary[], delta: number, minSize: number, snapTolerance: number): number {
  if (Math.abs(delta) < 1) return delta
  const tolerance = Math.max(0, snapTolerance)
  if (tolerance <= 0) return delta

  const selectedSet = new Set(selected)
  const selectedCoordinate = average(selected.map((boundary) => boundary.coordinate))
  const selectedStart = Math.min(...selected.map((boundary) => boundary.start))
  const selectedEnd = Math.max(...selected.map((boundary) => boundary.end))
  const targetCoordinate = selectedCoordinate + delta
  const snapTarget = boundaries
    .filter((boundary) =>
      !selectedSet.has(boundary)
      && boundary.axis === selected[0]?.axis
      && Math.abs(boundary.coordinate - selectedCoordinate) > COORDINATE_TOLERANCE
      && Math.abs(boundary.coordinate - targetCoordinate) <= tolerance
      && sameDirection(delta, boundary.coordinate - selectedCoordinate)
      && intervalsMeetAtEndpoint(boundary.start, boundary.end, selectedStart, selectedEnd),
    )
    .sort((a, b) => Math.abs(a.coordinate - targetCoordinate) - Math.abs(b.coordinate - targetCoordinate))[0]
  if (!snapTarget) return delta

  const snappedDelta = snapTarget.coordinate - selectedCoordinate
  const clamped = clampDelta(root, selected, snappedDelta, minSize)
  if (Math.abs(clamped - snappedDelta) > COORDINATE_TOLERANCE) return delta
  return clamped
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
      && Math.abs(boundary.coordinate - targetCoordinate) <= tolerance
      && sameDirection(delta, boundary.coordinate - selected.coordinate)
      && intervalsMeetAtEndpoint(boundary.start, boundary.end, selected.start, selected.end),
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

function intervalsMeetAtEndpoint(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return Math.abs(aEnd - bStart) <= CONNECTED_GAP_TOLERANCE || Math.abs(bEnd - aStart) <= CONNECTED_GAP_TOLERANCE
}

function sameDirection(delta: number, targetDelta: number): boolean {
  return (delta < 0 && targetDelta < 0) || (delta > 0 && targetDelta > 0)
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

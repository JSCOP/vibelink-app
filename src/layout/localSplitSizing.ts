import { Sizing, type DockviewApi, type SplitSizing } from 'dockview-core'

export type LocalSplitDirection = 'right' | 'below'

export type LocalSplitInitialSize = {
  initialWidth?: SplitSizing
  initialHeight?: SplitSizing
}

type ResizableDockviewGroup = {
  api: {
    setSize(size: { width?: number; height?: number }): void
  }
}

type SplitAxis = 'x' | 'y'

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
  viewIds: string[]
  rect: Rect
}

export function localSplitSiblingIndex(referenceLocation: readonly number[]): number {
  return Math.max(0, referenceLocation.at(-1) ?? 0)
}

/**
 * Dockview's default add-panel sizing redistributes every sibling on the same
 * axis. A direct terminal split should instead halve only the selected pane,
 * preserving the space owned by every unrelated pane.
 */
export function localSplitInitialSize(
  referenceLocation: readonly number[],
  direction: LocalSplitDirection,
): LocalSplitInitialSize {
  const sizing = Sizing.Split(localSplitSiblingIndex(referenceLocation))
  return direction === 'right'
    ? { initialWidth: sizing }
    : { initialHeight: sizing }
}

export function finalizeLocalSplitSize(
  referenceGroup: ResizableDockviewGroup,
  createdGroup: ResizableDockviewGroup,
  direction: LocalSplitDirection,
  referenceSize: number,
): void {
  const half = Math.max(1, Math.floor(referenceSize / 2))
  const size = direction === 'right' ? { width: half } : { height: half }
  referenceGroup.api.setSize(size)
  createdGroup.api.setSize(size)
}

/**
 * `Sizing.Split(index)` gives the new view half of the reference size, but
 * Dockview's relayout can take that space from later siblings instead of from
 * the reference view. Sequential `setSize` calls cannot repair that reliably:
 * each call may redistribute the correction into another sibling.
 *
 * Restore the pre-split rectangles for every unrelated group, divide only the
 * reference rectangle, and apply every branch size in one `fromJSON` update.
 */
export function finalizeLocalSplitLayout(
  api: Pick<DockviewApi, 'toJSON' | 'fromJSON'>,
  beforeLayout: ReturnType<DockviewApi['toJSON']>,
  referencePanelId: string,
  createdPanelId: string,
  direction: LocalSplitDirection,
): boolean {
  const next = localSplitLayout(beforeLayout, api.toJSON(), referencePanelId, createdPanelId, direction)
  if (!next) return false
  api.fromJSON(next as ReturnType<DockviewApi['toJSON']>, { reuseExistingPanels: true })
  return true
}

export function localSplitLayout(
  beforeLayout: unknown,
  afterLayout: unknown,
  referencePanelId: string,
  createdPanelId: string,
  direction: LocalSplitDirection,
): unknown | null {
  if (!isDockviewLayout(beforeLayout) || !isDockviewLayout(afterLayout)) return null
  const beforeRoot = beforeLayout.grid?.root
  const width = beforeLayout.grid?.width
  const height = beforeLayout.grid?.height
  if (!beforeRoot || !positiveNumber(width) || !positiveNumber(height)) return null

  const beforeLeaves: LeafRect[] = []
  collectLeafRects(
    beforeRoot,
    { x: 0, y: 0, width, height },
    axisFromOrientation(beforeLayout.grid?.orientation),
    beforeLeaves,
  )
  const referenceLeaf = beforeLeaves.find((leaf) => leaf.viewIds.includes(referencePanelId))
  if (!referenceLeaf) return null

  const desiredRects = new Map<string, Rect>()
  for (const leaf of beforeLeaves) {
    for (const viewId of leaf.viewIds) desiredRects.set(viewId, leaf.rect)
  }

  const [referenceRect, createdRect] = splitRect(referenceLeaf.rect, direction)
  for (const viewId of referenceLeaf.viewIds) desiredRects.set(viewId, referenceRect)
  desiredRects.set(createdPanelId, createdRect)

  const next = structuredClone(afterLayout) as DockviewLayoutLike
  const nextRoot = next.grid?.root
  if (!nextRoot || !applyDesiredSizes(nextRoot, axisFromOrientation(next.grid?.orientation), desiredRects)) return null
  return next
}

function collectLeafRects(node: SerializedNode, rect: Rect, axis: SplitAxis, leaves: LeafRect[]): void {
  if (node.type === 'leaf') {
    leaves.push({ viewIds: node.data.views ?? [], rect })
    return
  }

  let offset = axis === 'x' ? rect.x : rect.y
  for (const child of node.data) {
    const size = Math.max(0, Number(child.size) || 0)
    const childRect = axis === 'x'
      ? { x: offset, y: rect.y, width: size, height: rect.height }
      : { x: rect.x, y: offset, width: rect.width, height: size }
    collectLeafRects(child, childRect, oppositeAxis(axis), leaves)
    offset += size
  }
}

function applyDesiredSizes(node: SerializedNode, axis: SplitAxis, desiredRects: ReadonlyMap<string, Rect>): boolean {
  if (node.type === 'leaf') return node.data.views?.every((viewId) => desiredRects.has(viewId)) ?? false

  for (const child of node.data) {
    const bounds = desiredBounds(child, desiredRects)
    if (!bounds) return false
    child.size = Math.max(1, Math.round(axis === 'x' ? bounds.width : bounds.height))
    if (!applyDesiredSizes(child, oppositeAxis(axis), desiredRects)) return false
  }
  return true
}

function desiredBounds(node: SerializedNode, desiredRects: ReadonlyMap<string, Rect>): Rect | null {
  const rects: Rect[] = []
  collectDesiredRects(node, desiredRects, rects)
  if (rects.length === 0) return null
  const left = Math.min(...rects.map((rect) => rect.x))
  const top = Math.min(...rects.map((rect) => rect.y))
  const right = Math.max(...rects.map((rect) => rect.x + rect.width))
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function collectDesiredRects(node: SerializedNode, desiredRects: ReadonlyMap<string, Rect>, out: Rect[]): void {
  if (node.type === 'branch') {
    for (const child of node.data) collectDesiredRects(child, desiredRects, out)
    return
  }
  for (const viewId of node.data.views ?? []) {
    const rect = desiredRects.get(viewId)
    if (rect) out.push(rect)
  }
}

function splitRect(rect: Rect, direction: LocalSplitDirection): [Rect, Rect] {
  if (direction === 'right') {
    const referenceWidth = Math.max(1, Math.floor(rect.width / 2))
    return [
      { ...rect, width: referenceWidth },
      { ...rect, x: rect.x + referenceWidth, width: Math.max(1, rect.width - referenceWidth) },
    ]
  }
  const referenceHeight = Math.max(1, Math.floor(rect.height / 2))
  return [
    { ...rect, height: referenceHeight },
    { ...rect, y: rect.y + referenceHeight, height: Math.max(1, rect.height - referenceHeight) },
  ]
}

function axisFromOrientation(orientation: string | undefined): SplitAxis {
  return orientation === 'VERTICAL' ? 'y' : 'x'
}

function oppositeAxis(axis: SplitAxis): SplitAxis {
  return axis === 'x' ? 'y' : 'x'
}

function positiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isDockviewLayout(value: unknown): value is DockviewLayoutLike {
  return typeof value === 'object' && value !== null && 'grid' in value
}

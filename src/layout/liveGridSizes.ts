import type { SerializedDockview } from 'dockview-core'

type SerializedGridNode = SerializedDockview['grid']['root']
/** The group state carried by a serialized leaf (`GroupPanelViewState` is not
 * re-exported from the dockview-core package root). */
type SerializedGroupState = Exclude<SerializedGridNode['data'], unknown[]>

/** dockview-core 6.6.1 internals reached from the public api object. Every
 * member is probed at runtime before use; a missing member returns `false`
 * so callers fall back to the `fromJSON` rebuild. */
type DockviewLiveInternals = {
  component?: {
    gridview?: {
      root?: unknown
      hasMaximizedView?: () => boolean
    }
  }
}

type LiveBranchNode = {
  children: unknown[]
  getChildSize: (index: number) => number
  resizeChild: (index: number, size: number) => void
}

/**
 * Apply ONLY the branch child sizes of a serialized Dockview layout onto the
 * live grid, without the `fromJSON(..., { reuseExistingPanels: true })`
 * rebuild. The rebuild re-creates the whole inner grid DOM and re-attaches
 * every panel, which measured ~100 ms per surviving pane on close/split; the
 * live grid already has the right topology after Dockview's native
 * add/remove, so only sizes need restoring.
 *
 * Mechanism: each live `BranchNode` exposes `getChildSize`/`resizeChild`
 * (public methods in dockview-core 6.6.1). Applying exact target sizes to
 * children 0..n-2 left-to-right converges exactly, because Splitview's
 * `resizeView` keeps the resized item fixed and pushes the delta into the
 * later siblings first — the last child ends up with precisely the residual,
 * which equals its own target when the targets are mutually consistent.
 *
 * Returns `false` without touching anything when the internals are absent,
 * a view is hidden/maximized, or the serialized topology does not match the
 * live tree — callers keep the `fromJSON` rebuild as the fallback.
 */
export function applySerializedGridSizes(api: object, target: SerializedDockview): boolean {
  const grid = target.grid
  const root = grid?.root
  if (!root) return false
  // toJSON records a maximize outside the public typings; sizes cannot be
  // applied while a view is (or is about to be) maximized.
  if ('maximizedNode' in grid && grid.maximizedNode) return false
  // Named-boundary assert: the internal shape is probed member by member below.
  const internals = api as DockviewLiveInternals
  const gridview = internals.component?.gridview
  const liveRoot = gridview?.root
  if (!gridview || !liveRoot) return false
  if (typeof gridview.hasMaximizedView === 'function' && gridview.hasMaximizedView()) return false
  if (!isBranchNode(root) || !isLiveBranch(liveRoot)) return false
  if (!structureMatches(liveRoot, root)) return false
  applyBranchSizes(liveRoot, root)
  return true
}

/** The panel id that the serialized layout's active group would activate —
 * used to restore focus parity with the `fromJSON` path after a native close. */
export function serializedActiveViewId(target: SerializedDockview): string | null {
  const activeGroup = target.activeGroup
  if (!activeGroup) return null
  const group = findLeafByGroupId(target.grid?.root, activeGroup)
  if (!group) return null
  return group.activeView ?? group.views[0] ?? null
}

function isBranchNode(node: SerializedGridNode): node is SerializedGridNode & { data: SerializedGridNode[] } {
  return node.type === 'branch' && Array.isArray(node.data)
}

function isLiveBranch(node: unknown): node is LiveBranchNode {
  if (typeof node !== 'object' || node === null) return false
  return 'children' in node && Array.isArray(node.children)
    && 'getChildSize' in node && typeof node.getChildSize === 'function'
    && 'resizeChild' in node && typeof node.resizeChild === 'function'
}

/** The live `LeafNode.view` is the group panel; its id matches the serialized
 * leaf's `data.id`. */
function liveLeafGroupId(node: unknown): string | null {
  if (typeof node !== 'object' || node === null || !('view' in node)) return null
  const view = node.view
  if (typeof view !== 'object' || view === null || !('id' in view)) return null
  return typeof view.id === 'string' ? view.id : null
}

function structureMatches(liveNode: unknown, node: SerializedGridNode): boolean {
  if (isBranchNode(node)) {
    if (!isLiveBranch(liveNode)) return false
    if (liveNode.children.length !== node.data.length || node.data.length === 0) return false
    return node.data.every((child, index) => structureMatches(liveNode.children[index], child))
  }
  if (node.type !== 'leaf' || Array.isArray(node.data)) return false
  // A hidden leaf (e.g. a leased pane) keeps a cached invisible size the
  // resize math cannot see — let the rebuild handle that layout.
  if (node.visible === false) return false
  if (typeof node.size !== 'number' || !Number.isFinite(node.size)) return false
  const liveId = liveLeafGroupId(liveNode)
  return liveId !== null && liveId === node.data.id
}

function applyBranchSizes(liveNode: LiveBranchNode, node: SerializedGridNode & { data: SerializedGridNode[] }): void {
  for (let index = 0; index < node.data.length - 1; index += 1) {
    const size = node.data[index].size
    if (typeof size !== 'number' || !Number.isFinite(size)) continue
    const targetSize = Math.max(1, Math.round(size))
    if (Math.abs(liveNode.getChildSize(index) - targetSize) >= 1) liveNode.resizeChild(index, targetSize)
  }
  for (let index = 0; index < node.data.length; index += 1) {
    const child = node.data[index]
    const liveChild = liveNode.children[index]
    if (isBranchNode(child) && isLiveBranch(liveChild)) applyBranchSizes(liveChild, child)
  }
}

function findLeafByGroupId(node: SerializedGridNode | undefined, groupId: string): SerializedGroupState | null {
  if (!node) return null
  if (isBranchNode(node)) {
    for (const child of node.data) {
      const leaf = findLeafByGroupId(child, groupId)
      if (leaf) return leaf
    }
    return null
  }
  if (node.type !== 'leaf' || Array.isArray(node.data)) return null
  return node.data.id === groupId ? node.data : null
}

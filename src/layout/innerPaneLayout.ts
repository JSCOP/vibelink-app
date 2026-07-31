import type { DockviewApi, SerializedDockview } from 'dockview-core'
import type { GridSize } from './templatePlan'
import { planTerminalArrangement } from './workspaceLayoutModel'

export type TerminalPaneSplitDirection = 'right' | 'below'
export type TerminalPaneDropKind = 'tab' | 'header_space' | 'content' | 'edge'
export type TerminalPaneDropPosition = 'top' | 'bottom' | 'left' | 'right' | 'center'

type MutableGroupState = Record<string, unknown> & {
  id?: unknown
  views?: unknown
  activeView?: unknown
  tabGroups?: unknown
}

type MutableLeafNode = {
  type: 'leaf'
  data: MutableGroupState
  size?: number
  visible?: boolean
}

type MutableBranchNode = {
  type: 'branch'
  data: MutableNode[]
  size?: number
}

type MutableNode = MutableLeafNode | MutableBranchNode

type MutableDockview = Omit<SerializedDockview, 'grid'> & {
  grid: Omit<SerializedDockview['grid'], 'root'> & {
    root: MutableNode
    maximizedNode?: unknown
  }
}

/** A terminal window is a spatial pane grid, never a tab container. Repair old
 * serialized layouts by replacing every multi-view leaf with sibling leaves in
 * the leaf's existing reading-order position. Already-spatial layouts retain
 * their original object identity so callers can guard persistence cheaply. */
export function unstackSerializedDockview(layout: SerializedDockview): SerializedDockview {
  const root = layout.grid.root as MutableNode
  if (!hasStackedLeaf(root)) return layout

  const next = structuredClone(layout) as MutableDockview
  const usedGroupIds = new Set<string>()
  collectGroupIds(next.grid.root, usedGroupIds)
  const originalActiveGroup = typeof next.activeGroup === 'string' ? next.activeGroup : null
  let repairedActiveGroup = originalActiveGroup

  const repairNode = (node: MutableNode): MutableNode => {
    if (node.type === 'branch') {
      node.data = node.data.map(repairNode)
      return node
    }

    const views = stringViews(node.data.views)
    if (views.length <= 1) return node

    const originalGroupId = typeof node.data.id === 'string' ? node.data.id : nextGroupId('terminal-pane-group', usedGroupIds)
    const activeView = typeof node.data.activeView === 'string' && views.includes(node.data.activeView)
      ? node.data.activeView
      : views[0]
    const totalSize = positiveSize(node.size) ?? views.length
    const sizes = distributeSize(totalSize, views.length)
    const leaves = views.map((panelId, index): MutableLeafNode => {
      const groupId = index === 0 ? originalGroupId : nextGroupId(`${originalGroupId}-pane-${index + 1}`, usedGroupIds)
      usedGroupIds.add(groupId)
      const data: MutableGroupState = {
        ...node.data,
        id: groupId,
        views: [panelId],
        activeView: panelId,
      }
      delete data.tabGroups
      if (originalActiveGroup === originalGroupId && panelId === activeView) repairedActiveGroup = groupId
      return {
        type: 'leaf',
        data,
        size: sizes[index],
        ...(node.visible === undefined ? {} : { visible: node.visible }),
      }
    })

    return { type: 'branch', data: leaves, size: totalSize }
  }

  next.grid.root = repairNode(next.grid.root)
  delete next.grid.maximizedNode
  if (repairedActiveGroup) next.activeGroup = repairedActiveGroup
  return next as unknown as SerializedDockview
}

/** Pick the axis with fewer current tracks so default pane creation grows a
 * compact grid. A square/unknown layout grows to the right deterministically. */
export function defaultTerminalPaneSplitDirection(layout: SerializedDockview): TerminalPaneSplitDirection {
  const tracks = countTracks(layout.grid.root as MutableNode, layout.grid.orientation === 'VERTICAL' ? 'vertical' : 'horizontal')
  if (tracks.rows < tracks.cols) return 'below'
  return 'right'
}

/** Tab/header and center-content targets merge panes into one Dockview group.
 * Terminal-window DnD exposes edge targets only. */
export function preventTerminalPaneStackDrop(kind: TerminalPaneDropKind, position: TerminalPaneDropPosition): boolean {
  return kind === 'tab' || kind === 'header_space' || (kind === 'content' && position === 'center')
}

/** Apply the shared row-major arrangement plan to a live inner Dockview. The
 * first row grows right; later panes move below the pane in the same column.
 * Moving panes preserves whatever extents the panes already had, so an explicit
 * grid request would otherwise inherit lopsided columns from the panes it grew
 * out of. Grid creation and Arrange are whole-grid NORMALIZATION commands, so
 * the tracks are equalized afterwards. */
export function arrangeTerminalPaneGrid(
  api: DockviewApi,
  panelIds: readonly string[],
  grid: GridSize,
  activePanelId: string | null = api.activePanel?.id ?? null,
): void {
  for (const step of planTerminalArrangement(panelIds, grid)) {
    const panel = api.getPanel(step.panelId)
    const reference = api.getPanel(step.referencePanelId)
    if (panel && reference) panel.api.moveTo({ group: reference.group, position: step.position, skipSetActive: true })
  }
  equalizeGridTracks(api)
  activateOrphanedPaneGroups(api)
  if (activePanelId) api.getPanel(activePanelId)?.api.setActive()
}

/** `skipSetActive` moves a pane into a group without opening it there, so a group
 * the move CREATED is left with no active panel. Dockview then renders that group
 * as an empty watermark, reports `panel.api.isVisible === false`, never positions
 * the panel's `renderer: 'always'` overlay (it stays `visibility: hidden` at the
 * container's default rect), and `dockviewOverlaysSettled` skips it — so the settle
 * loop reports success while the pane is invisible. Its terminal then fits to the
 * unpositioned overlay and spawns its PTY at that bogus geometry (353x75 observed
 * live on a 4x2 grid), which a later activation reflows into a duplicated,
 * wrongly-wrapped scrollback for any normal-buffer TUI (OMP). Re-open the panel in
 * every group that lost its active panel; the caller restores the intended active
 * panel afterwards. */
export function activateOrphanedPaneGroups(api: DockviewApi): void {
  for (const group of api.groups) {
    if (group.activePanel) continue
    group.panels[0]?.api.setActive()
  }
}

/** Give every sibling branch/leaf an equal share of its parent's extent, so an
 * arranged grid renders as even columns and rows. Sizes are rewritten on the
 * serialized layout and restored with `reuseExistingPanels`, which keeps every
 * live panel instance (and therefore every PTY) attached. */
export function equalizeGridTracks(api: DockviewApi): void {
  let layout: SerializedDockview
  try {
    layout = api.toJSON()
  } catch {
    return
  }
  const next = equalizeSerializedGridTracks(layout)
  if (next === layout) return
  try {
    api.fromJSON(next, { reuseExistingPanels: true })
  } catch {
    // A layout we cannot restore is left exactly as Dockview arranged it.
  }
}

/** Pure half of {@link equalizeGridTracks}: returns a layout whose every branch
 * splits its extent evenly across its children, or the original object when it
 * is already even. */
export function equalizeSerializedGridTracks(layout: SerializedDockview): SerializedDockview {
  const root = layout.grid.root as MutableNode
  if (!hasUnevenBranch(root)) return layout
  const next = structuredClone(layout) as MutableDockview
  equalizeNode(next.grid.root)
  return next as unknown as SerializedDockview
}

function hasStackedLeaf(node: MutableNode): boolean {
  if (node.type === 'leaf') return stringViews(node.data.views).length > 1
  return node.data.some(hasStackedLeaf)
}

function collectGroupIds(node: MutableNode, ids: Set<string>): void {
  if (node.type === 'leaf') {
    if (typeof node.data.id === 'string') ids.add(node.data.id)
    return
  }
  for (const child of node.data) collectGroupIds(child, ids)
}

function nextGroupId(base: string, used: Set<string>): string {
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  used.add(candidate)
  return candidate
}

function stringViews(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((view): view is string => typeof view === 'string') : []
}

function positiveSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

function distributeSize(total: number, count: number): number[] {
  const size = total / Math.max(1, count)
  return Array.from({ length: count }, (_, index) => index === count - 1 ? total - size * (count - 1) : size)
}

// Dockview stores fractional sizes, so equality is compared with a tolerance
// rather than exactly; a sub-pixel drift is not worth a layout rewrite.
const TRACK_SIZE_TOLERANCE = 1

// A node's `size` is its extent along its PARENT's axis, so a branch's children
// are equalized against the sum of their own sizes, never against the branch's
// own (cross-axis) size.
function childExtentTotal(node: MutableBranchNode): number | null {
  let total = 0
  for (const child of node.data) {
    const size = positiveSize(child.size)
    if (size === null) return null
    total += size
  }
  return total > 0 ? total : null
}

function hasUnevenBranch(node: MutableNode): boolean {
  if (node.type === 'leaf') return false
  const total = node.data.length > 1 ? childExtentTotal(node) : null
  if (total !== null) {
    const even = total / node.data.length
    if (node.data.some((child) => Math.abs((positiveSize(child.size) ?? 0) - even) > TRACK_SIZE_TOLERANCE)) return true
  }
  return node.data.some(hasUnevenBranch)
}

function equalizeNode(node: MutableNode): void {
  if (node.type === 'leaf') return
  const total = childExtentTotal(node)
  if (total !== null) {
    const sizes = distributeSize(total, node.data.length)
    for (const [index, child] of node.data.entries()) child.size = sizes[index]
  }
  for (const child of node.data) equalizeNode(child)
}

type GridAxis = 'horizontal' | 'vertical'
type GridTracks = { cols: number; rows: number }

function countTracks(node: MutableNode, axis: GridAxis): GridTracks {
  if (node.type === 'leaf') return { cols: 1, rows: 1 }
  const children = node.data.map((child) => countTracks(child, axis === 'horizontal' ? 'vertical' : 'horizontal'))
  if (children.length === 0) return { cols: 1, rows: 1 }
  if (axis === 'horizontal') {
    return {
      cols: children.reduce((total, child) => total + child.cols, 0),
      rows: Math.max(...children.map((child) => child.rows)),
    }
  }
  return {
    cols: Math.max(...children.map((child) => child.cols)),
    rows: children.reduce((total, child) => total + child.rows, 0),
  }
}

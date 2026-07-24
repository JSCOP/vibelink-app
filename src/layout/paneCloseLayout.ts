import type { SerializedDockview } from 'dockview-core'

type MutableGroupState = Record<string, unknown> & {
  id?: unknown
  views?: unknown
  activeView?: unknown
  tabGroups?: unknown
}

type MutableLeafNode = {
  type: 'leaf'
  data: MutableGroupState
  size: number
  visible?: boolean
}

type MutableBranchNode = {
  type: 'branch'
  data: MutableNode[]
  size: number
}

type MutableNode = MutableLeafNode | MutableBranchNode

type RemovalResult = {
  node: MutableNode | null
  removed: boolean
  removedGroupId: string | null
  fallbackGroupId: string | null
  removedLeaf: boolean
}

type MutableDockview = Omit<SerializedDockview, 'grid' | 'panels'> & {
  grid: Omit<SerializedDockview['grid'], 'root'> & { root: MutableNode; maximizedNode?: unknown }
  panels: Record<string, unknown>
}

/** Remove one terminal panel without Dockview's default equal-size rewrite.
 * The closed leaf's extent is redistributed across the surviving siblings in
 * the same branch, preserving their relative sizes and every unrelated branch. */
export function removePanelPreservingLayout(layout: SerializedDockview, panelId: string): SerializedDockview | null {
  const next = structuredClone(layout) as MutableDockview
  const result = removePanelFromNode(next.grid.root, panelId, true)
  if (!result.removed || !result.node) return null

  next.grid.root = result.node
  delete next.panels[panelId]
  if (result.removedLeaf) delete next.grid.maximizedNode
  if (next.activeGroup === result.removedGroupId) {
    next.activeGroup = result.fallbackGroupId ?? firstLeafGroupId(next.grid.root) ?? undefined
  }
  return next as unknown as SerializedDockview
}

function removePanelFromNode(node: MutableNode, panelId: string, isRoot: boolean): RemovalResult {
  if (node.type === 'leaf') {
    const views = Array.isArray(node.data.views) ? node.data.views.filter((view): view is string => typeof view === 'string') : []
    if (!views.includes(panelId)) return { node, removed: false, removedGroupId: null, fallbackGroupId: null, removedLeaf: false }

    const groupId = typeof node.data.id === 'string' ? node.data.id : null
    if (views.length > 1) {
      const remainingViews = views.filter((view) => view !== panelId)
      node.data.views = remainingViews
      if (node.data.activeView === panelId) node.data.activeView = remainingViews[0]
      removePanelFromTabGroups(node.data, panelId)
      return { node, removed: true, removedGroupId: groupId, fallbackGroupId: groupId, removedLeaf: false }
    }
    return { node: null, removed: true, removedGroupId: groupId, fallbackGroupId: null, removedLeaf: true }
  }

  for (let index = 0; index < node.data.length; index += 1) {
    const child = node.data[index]
    const result = removePanelFromNode(child, panelId, false)
    if (!result.removed) continue

    if (result.node) {
      node.data[index] = result.node
      return { ...result, node }
    }

    const removedExtent = child.size
    node.data.splice(index, 1)
    if (node.data.length === 0) return { ...result, node: null }

    const fallbackIndex = index > 0 ? index - 1 : 0
    const fallbackGroupId = firstLeafGroupId(node.data[fallbackIndex])

    if (!isRoot && node.data.length === 1) {
      const remaining = node.data[0]
      remaining.size = node.size
      return { ...result, node: remaining, fallbackGroupId }
    }
    redistributeExtent(node.data, removedExtent)
    return { ...result, node, fallbackGroupId }
  }

  return { node, removed: false, removedGroupId: null, fallbackGroupId: null, removedLeaf: false }
}

function redistributeExtent(nodes: MutableNode[], removedExtent: number): void {
  const survivingExtent = nodes.reduce((total, child) => total + child.size, 0)
  const targetExtent = survivingExtent + removedExtent
  if (!(survivingExtent > 0) || !(targetExtent > 0)) {
    const equalExtent = targetExtent > 0 ? targetExtent / nodes.length : 0
    for (const child of nodes) child.size = equalExtent
    return
  }

  const scale = targetExtent / survivingExtent
  let distributed = 0
  for (let index = 0; index < nodes.length - 1; index += 1) {
    nodes[index].size *= scale
    distributed += nodes[index].size
  }
  nodes[nodes.length - 1].size = targetExtent - distributed
}

function removePanelFromTabGroups(group: MutableGroupState, panelId: string): void {
  if (!Array.isArray(group.tabGroups)) return
  group.tabGroups = group.tabGroups.flatMap((tabGroup) => {
    if (!isRecord(tabGroup) || !Array.isArray(tabGroup.panelIds)) return [tabGroup]
    const panelIds = tabGroup.panelIds.filter((id) => id !== panelId)
    return panelIds.length > 0 ? [{ ...tabGroup, panelIds }] : []
  })
}

function firstLeafGroupId(node: MutableNode): string | null {
  if (node.type === 'leaf') return typeof node.data.id === 'string' ? node.data.id : null
  for (const child of node.data) {
    const groupId = firstLeafGroupId(child)
    if (groupId) return groupId
  }
  return null
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

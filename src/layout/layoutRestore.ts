type DockviewLayout = {
  grid?: {
    root?: unknown
    width?: unknown
    height?: unknown
  }
  panels?: Record<string, unknown>
}

type SerializedGridNode = {
  type?: unknown
  data?: unknown
  size?: unknown
}

export function shouldRestoreDockviewLayout(layoutJson: string, paneIds: string[]): boolean {
  if (paneIds.length === 0) return false

  let layout: DockviewLayout
  try {
    layout = JSON.parse(layoutJson) as DockviewLayout
  } catch {
    return false
  }

  const panels = layout.panels
  if (!panels) return false

  for (const paneId of paneIds) {
    if (!Object.prototype.hasOwnProperty.call(panels, paneId)) return false
  }

  return hasRestorableGrid(layout.grid, paneIds)
}

function hasRestorableGrid(grid: DockviewLayout['grid'], paneIds: string[]): boolean {
  if (!isRecord(grid) || !isPositiveNumber(grid.width) || !isPositiveNumber(grid.height)) return false

  const seenPaneIds = new Set<string>()
  if (!collectPaneIdsFromNode(grid.root, seenPaneIds)) return false
  return paneIds.every((paneId) => seenPaneIds.has(paneId))
}

function collectPaneIdsFromNode(node: unknown, seenPaneIds: Set<string>): boolean {
  if (!isRecord(node) || !isPositiveNumber((node as SerializedGridNode).size)) return false

  if (node.type === 'branch') {
    const children = node.data
    return Array.isArray(children) && children.length > 0 && children.every((child) => collectPaneIdsFromNode(child, seenPaneIds))
  }

  if (node.type === 'leaf') {
    const data = node.data
    if (!isRecord(data) || !Array.isArray(data.views) || data.views.length === 0) return false
    for (const view of data.views) {
      if (typeof view === 'string') seenPaneIds.add(view)
    }
    return true
  }

  return false
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down'

export type PaneRect = {
  left: number
  right: number
  top: number
  bottom: number
  width: number
  height: number
}

export function nearestPaneIdInDirection(
  activePaneId: string,
  paneIds: string[],
  direction: PaneDirection,
  rectForPane: (paneId: string) => PaneRect | null,
): string | null {
  const activeRect = rectForPane(activePaneId)
  if (!activeRect) return null

  let best: { id: string; score: number } | null = null
  for (const paneId of paneIds) {
    if (paneId === activePaneId) continue
    const rect = rectForPane(paneId)
    if (!rect || !isInDirection(activeRect, rect, direction)) continue
    const score = directionalDistance(activeRect, rect, direction)
    if (!best || score < best.score) best = { id: paneId, score }
  }
  return best?.id ?? null
}

function isInDirection(active: PaneRect, candidate: PaneRect, direction: PaneDirection): boolean {
  const tolerance = 2
  if (direction === 'left') return candidate.right <= active.left + tolerance
  if (direction === 'right') return candidate.left >= active.right - tolerance
  if (direction === 'up') return candidate.bottom <= active.top + tolerance
  return candidate.top >= active.bottom - tolerance
}

function directionalDistance(active: PaneRect, candidate: PaneRect, direction: PaneDirection): number {
  const activeCenterX = active.left + active.width / 2
  const activeCenterY = active.top + active.height / 2
  const candidateCenterX = candidate.left + candidate.width / 2
  const candidateCenterY = candidate.top + candidate.height / 2
  const primary = direction === 'left'
    ? active.left - candidate.right
    : direction === 'right'
      ? candidate.left - active.right
      : direction === 'up'
        ? active.top - candidate.bottom
        : candidate.top - active.bottom
  const secondary = direction === 'left' || direction === 'right'
    ? Math.abs(activeCenterY - candidateCenterY)
    : Math.abs(activeCenterX - candidateCenterX)
  return primary * 10000 + secondary
}

type MutableRecord = Record<string, unknown>

type GroupState = MutableRecord & {
  views?: unknown
  activeView?: unknown
  tabGroups?: unknown
}

const edgeGroupKeys = ['top', 'bottom', 'left', 'right'] as const

export function swapPanelIdsInDockviewLayout(layout: unknown, firstId: string, secondId: string): boolean {
  if (firstId === secondId) return false

  let hasFirst = false
  let hasSecond = false
  let sharesGroup = false
  visitGroups(layout, (group) => {
    if (!isRecord(group)) return
    const state = group as GroupState
    const groupHasFirst = arrayContains(state.views, firstId)
      || state.activeView === firstId
      || (Array.isArray(state.tabGroups) && state.tabGroups.some((tabGroup) => isRecord(tabGroup) && arrayContains(tabGroup.panelIds, firstId)))
    const groupHasSecond = arrayContains(state.views, secondId)
      || state.activeView === secondId
      || (Array.isArray(state.tabGroups) && state.tabGroups.some((tabGroup) => isRecord(tabGroup) && arrayContains(tabGroup.panelIds, secondId)))
    hasFirst = hasFirst || groupHasFirst
    hasSecond = hasSecond || groupHasSecond
    sharesGroup = sharesGroup || (groupHasFirst && groupHasSecond)
  })
  if (!hasFirst || !hasSecond || sharesGroup) return false

  const swapId = (value: unknown) => {
    if (value === firstId) return secondId
    if (value === secondId) return firstId
    return value
  }

  const swapGroup = (group: unknown) => {
    if (!isRecord(group)) return
    const state = group as GroupState
    if (Array.isArray(state.views)) {
      state.views = state.views.map(swapId)
    }
    state.activeView = swapId(state.activeView)
    if (Array.isArray(state.tabGroups)) {
      for (const tabGroup of state.tabGroups) {
        if (isRecord(tabGroup) && Array.isArray(tabGroup.panelIds)) {
          tabGroup.panelIds = tabGroup.panelIds.map(swapId)
        }
      }
    }
  }

  visitGroups(layout, swapGroup)
  return true
}


function visitGroups(layout: unknown, visitor: (group: unknown) => void): void {
  if (!isRecord(layout)) return
  const grid = layout.grid
  if (isRecord(grid)) visitGridNode(grid.root, visitor)

  if (Array.isArray(layout.floatingGroups)) {
    for (const floatingGroup of layout.floatingGroups) {
      if (isRecord(floatingGroup)) visitor(floatingGroup.data)
    }
  }

  if (Array.isArray(layout.popoutGroups)) {
    for (const popoutGroup of layout.popoutGroups) {
      if (isRecord(popoutGroup)) visitor(popoutGroup.data)
    }
  }

  const edgeGroups = layout.edgeGroups
  if (isRecord(edgeGroups)) {
    for (const key of edgeGroupKeys) {
      const edgeGroup = edgeGroups[key]
      if (isRecord(edgeGroup)) visitor(edgeGroup.group)
    }
  }
}

function visitGridNode(node: unknown, visitor: (group: unknown) => void): void {
  if (!isRecord(node)) return
  if (node.type === 'leaf') {
    visitor(node.data)
    return
  }
  if (Array.isArray(node.data)) {
    for (const child of node.data) visitGridNode(child, visitor)
  }
}

function arrayContains(value: unknown, needle: string): boolean {
  return Array.isArray(value) && value.includes(needle)
}

function isRecord(value: unknown): value is MutableRecord {
  return typeof value === 'object' && value !== null
}

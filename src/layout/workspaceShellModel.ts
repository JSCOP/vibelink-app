import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import {
  isStructuralWorkspaceContentKind,
  parseWorkspaceContentParams,
  workspaceContentPanelId,
  workspaceContentResourceKey,
  type SerializedDockview,
  type WorkspaceContentKind,
  type WorkspaceContentParams,
} from './workspaceContentModel'
import {
  createSingletonContentParams,
  workspaceDefaultEdgeCollapse,
  workspaceEdgeCollapsedSize,
  workspaceEdgeGroupOptions,
  workspaceLeftEdgeGroupId,
  workspaceLeftStructuralKinds,
  workspaceMinimumCenterWidth,
  workspaceRightEdgeGroupId,
  workspaceRightStructuralKinds,
} from './workspaceLayoutModel'
import type { WorkspaceContentChromeState } from './contentActions'

type StructuralWorkspaceContentKind = typeof workspaceLeftStructuralKinds[number] | typeof workspaceRightStructuralKinds[number]

const workspaceStructuralPlacement: Record<StructuralWorkspaceContentKind, { groupId: string; index: number }> = {
  workspaces: { groupId: workspaceLeftEdgeGroupId, index: 0 },
  explorer: { groupId: workspaceLeftEdgeGroupId, index: 1 },
  sourceControl: { groupId: workspaceLeftEdgeGroupId, index: 2 },
  gitHistory: { groupId: workspaceLeftEdgeGroupId, index: 3 },
  gitBranches: { groupId: workspaceLeftEdgeGroupId, index: 4 },
  agentSessions: { groupId: workspaceRightEdgeGroupId, index: 0 },
}

export type WorkspaceResizeCoordinator = {
  request: (width: number, layoutDockview: boolean) => void
  dispose: () => void
}

/**
 * Bounded history of layout strings the workspace view saved itself.
 *
 * `save_layout` round-trips back into the store, and several persists can be in
 * flight at once, so "the store's layout changed" does not mean "someone else
 * changed the layout". Without this history the view rebuilds the whole dock
 * from its own (sometimes older) write, which drops live pane titles back to the
 * persisted copy, persists again, and flickers in a loop.
 */
export const authoredWorkspaceLayoutHistoryLimit = 12

export function rememberAuthoredLayout(history: Set<string>, layoutJson: string): void {
  // Re-insert so the most recently authored layout is the newest entry.
  history.delete(layoutJson)
  history.add(layoutJson)
  while (history.size > authoredWorkspaceLayoutHistoryLimit) {
    const oldest = history.values().next().value
    if (oldest === undefined) break
    history.delete(oldest)
  }
}

type WorkspaceResizeCoordinatorCallbacks = {
  onLive: (width: number, layoutDockview: boolean) => void
  onSettled: () => void
}

type WorkspaceResizeCoordinatorScheduling = {
  requestFrame: (callback: () => void) => number
  cancelFrame: (handle: number) => void
  setQuietTimer: (callback: () => void, delay: number) => number
  clearQuietTimer: (handle: number) => void
  quietMs?: number
}

export function createWorkspaceResizeCoordinator(
  callbacks: WorkspaceResizeCoordinatorCallbacks,
  scheduling: WorkspaceResizeCoordinatorScheduling = {
    requestFrame: (callback) => requestAnimationFrame(() => callback()),
    cancelFrame: (handle) => cancelAnimationFrame(handle),
    setQuietTimer: (callback, delay) => window.setTimeout(callback, delay),
    clearQuietTimer: (handle) => window.clearTimeout(handle),
  },
): WorkspaceResizeCoordinator {
  let frame: number | undefined
  let quietTimer: number | undefined
  let latestWidth = 0
  let shouldLayoutDockview = false

  return {
    request(width, layoutDockview) {
      latestWidth = width
      shouldLayoutDockview ||= layoutDockview
      if (frame === undefined) {
        frame = scheduling.requestFrame(() => {
          frame = undefined
          const layoutRequested = shouldLayoutDockview
          shouldLayoutDockview = false
          callbacks.onLive(latestWidth, layoutRequested)
        })
      }
      if (quietTimer !== undefined) scheduling.clearQuietTimer(quietTimer)
      quietTimer = scheduling.setQuietTimer(() => {
        quietTimer = undefined
        callbacks.onSettled()
      }, scheduling.quietMs ?? 140)
    },
    dispose() {
      if (frame !== undefined) scheduling.cancelFrame(frame)
      if (quietTimer !== undefined) scheduling.clearQuietTimer(quietTimer)
      frame = undefined
      quietTimer = undefined
    },
  }
}

export function workspaceChromeStatesEqual(left: WorkspaceContentChromeState | null, right: WorkspaceContentChromeState): boolean {
  return left?.contentCount === right.contentCount
    && left.activeContentKind === right.activeContentKind
    && left.activePanelId === right.activePanelId
    && left.activeGroupId === right.activeGroupId
}

export function workspaceGroupShowsCreationControls(locationType: 'grid' | 'edge' | 'floating' | 'popout', groupId: string, currentMainGroupId: string | null | undefined): boolean {
  return locationType === 'grid' && groupId === currentMainGroupId
}

/** Whether a grid group currently holds at least one terminal panel. */
function groupContainsTerminals(group: { panels: readonly IDockviewPanel[] }): boolean {
  return group.panels.some((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal')
}

/** Whether a grid group holds only terminal panels (or is empty). */
function groupIsTerminalOnly(group: { panels: readonly IDockviewPanel[] }): boolean {
  return group.panels.every((panel) => parseWorkspaceContentParams(panel.params)?.kind === 'terminal')
}

export function resolveMainContentGroup(api: DockviewApi, preferredGroupId?: string) {
  const preferred = preferredGroupId ? api.groups.find((group) => group.id === preferredGroupId && group.api.location.type === 'grid') : undefined
  if (preferred) return preferred
  if (api.activeGroup?.api.location.type === 'grid') return api.activeGroup
  const visible = api.groups.find((group) => group.api.location.type === 'grid' && group.api.isVisible)
  if (visible) return visible
  const existingIds = new Set(api.groups.map((group) => group.id))
  let index = 1
  let id = 'content-group-main'
  while (existingIds.has(id)) id = `content-group-main-${++index}`
  return api.addGroup({ id, direction: 'right' })
}

/**
 * Keep terminals and other content in distinct central grid groups so a
 * "terminal window" never shares its tab strip with editors/browser/etc.
 * Terminals go to the group that already holds terminals; non-terminals go to a
 * grid group with no terminals — creating a fresh sibling group when the only
 * candidate is the terminal window. Grouping is not part of the persisted
 * pane-identity contract, so this needs no schema change.
 */
function resolveTypedCentralGroup(api: DockviewApi, wantsTerminal: boolean, preferredGroupId?: string) {
  const gridGroups = api.groups.filter((group) => group.api.location.type === 'grid')
  const preferred = preferredGroupId ? gridGroups.find((group) => group.id === preferredGroupId) : undefined
  if (preferred && groupContainsTerminals(preferred) === wantsTerminal) return preferred
  const match = gridGroups.find((group) => wantsTerminal ? groupContainsTerminals(group) : (!groupContainsTerminals(group) && group.panels.length > 0))
  if (match) return match
  if (!wantsTerminal) {
    // No non-terminal group exists yet. Reuse an empty group, else split a new
    // group beside the terminal window rather than dropping content into it.
    const empty = gridGroups.find((group) => group.panels.length === 0)
    if (empty) return empty
    const terminalWindow = gridGroups.find((group) => groupIsTerminalOnly(group) && group.panels.length > 0)
    if (terminalWindow) {
      const existingIds = new Set(api.groups.map((group) => group.id))
      let index = 1
      let id = 'content-group-main'
      while (existingIds.has(id)) id = `content-group-main-${++index}`
      return api.addGroup({ id, direction: 'right', referenceGroup: terminalWindow })
    }
  }
  return resolveMainContentGroup(api, preferredGroupId)
}

export function resolveWorkspaceContentGroup(api: DockviewApi, kind: WorkspaceContentKind, requestedGroupId?: string, lastMainGroupId?: string | null) {
  if (isStructuralWorkspaceContentKind(kind)) {
    const placement = workspaceStructuralPlacement[kind as StructuralWorkspaceContentKind]
    return api.groups.find((group) => group.id === placement.groupId && group.api.location.type === 'edge') ?? null
  }
  const requestedGridGroup = requestedGroupId
    ? api.groups.find((group) => group.id === requestedGroupId && group.api.location.type === 'grid')
    : undefined
  return resolveTypedCentralGroup(api, kind === 'terminal', requestedGridGroup?.id ?? lastMainGroupId ?? undefined)
}

export function updateOpenPreviewPanel(panel: IDockviewPanel, params: Extract<WorkspaceContentParams, { kind: 'preview' }>, activate = true): string {
  panel.update({ params })
  panel.api.setTitle(params.title)
  if (activate) panel.api.setActive()
  return panel.id
}

export function collapseStructuralWorkspacePanel(panel: IDockviewPanel, content: WorkspaceContentParams): boolean {
  if (!isStructuralWorkspaceContentKind(content.kind)) return false
  if (panel.group.api.location.type === 'edge') panel.group.api.collapse()
  return true
}

export function toggleStructuralWorkspacePanel(api: DockviewApi, kind: StructuralWorkspaceContentKind): boolean {
  const panel = api.getPanel(workspaceContentPanelId(createSingletonContentParams(kind)))
  if (!panel || panel.group.api.location.type !== 'edge') return false
  if (panel.group.activePanel?.id === panel.id && !panel.group.api.isCollapsed()) {
    panel.group.api.collapse()
    return true
  }
  panel.group.api.expand()
  panel.api.setActive()
  return true
}

export function toggleWorkspaceLeftSidebar(api: DockviewApi): boolean {
  const left = api.getEdgeGroup('left')
  if (!left) return false
  if (left.isCollapsed()) left.expand()
  else left.collapse()
  return true
}

export function registerWorkspaceEdgeGroups(api: DockviewApi, rootWidth: number): void {
  const collapsed = workspaceDefaultEdgeCollapse(rootWidth)
  const left = api.getEdgeGroup('left') ?? api.addEdgeGroup('left', { ...workspaceEdgeGroupOptions.left, collapsed: collapsed.left })
  const right = api.getEdgeGroup('right') ?? api.addEdgeGroup('right', { ...workspaceEdgeGroupOptions.right, collapsed: collapsed.right })
  left.locked = 'no-drop-target'
  right.locked = 'no-drop-target'
}

export function resetWorkspaceEdgeDefaults(api: DockviewApi, rootWidth: number): void {
  registerWorkspaceEdgeGroups(api, rootWidth)
  api.setEdgeGroupVisible('left', true)
  api.setEdgeGroupVisible('right', true)
  const collapsed = workspaceDefaultEdgeCollapse(rootWidth)
  const left = api.getEdgeGroup('left')
  const right = api.getEdgeGroup('right')
  if (left) {
    left.expand()
    left.setSize({ width: workspaceEdgeGroupOptions.left.initialSize })
    if (collapsed.left) left.collapse()
  }
  if (right) {
    right.expand()
    right.setSize({ width: workspaceEdgeGroupOptions.right.initialSize })
    if (collapsed.right) right.collapse()
  }
}

export function ensureWorkspaceEdgeShell(api: DockviewApi): void {
  registerWorkspaceEdgeGroups(api, Number.POSITIVE_INFINITY)
  for (const kind of [...workspaceLeftStructuralKinds, ...workspaceRightStructuralKinds]) {
    const placement = workspaceStructuralPlacement[kind]
    const group = api.groups.find((candidate) => candidate.id === placement.groupId && candidate.api.location.type === 'edge')
    if (!group) continue
    const params = createSingletonContentParams(kind)
    const resourceKey = workspaceContentResourceKey(params)
    let panel = api.panels.find((candidate) => {
      const current = parseWorkspaceContentParams(candidate.params)
      return current ? workspaceContentResourceKey(current) === resourceKey : false
    })
    if (!panel) {
      panel = api.addPanel({
        id: workspaceContentPanelId(params),
        component: kind,
        tabComponent: 'workspaceContentTab',
        title: params.title,
        params,
        renderer: 'always',
        inactive: true,
        position: { referenceGroup: group },
      })
    }
    if (panel.group.id !== group.id || group.panels[placement.index]?.id !== panel.id) {
      panel.api.moveTo({ group, position: 'center', index: placement.index, skipSetActive: true })
    }
  }
  api.getEdgeGroup('left')!.locked = 'no-drop-target'
  api.getEdgeGroup('right')!.locked = 'no-drop-target'
}

export function collapseWorkspaceEdgesForCenterWidth(api: DockviewApi, rootWidth: number): void {
  const serialized = api.toJSON() as SerializedDockview
  const leftState = serialized.edgeGroups?.left
  const rightState = serialized.edgeGroups?.right
  const visibleWidth = (state: typeof leftState) => !state?.visible ? 0 : state.collapsed ? workspaceEdgeCollapsedSize : state.size
  let centerWidth = rootWidth - visibleWidth(leftState) - visibleWidth(rightState)
  if (centerWidth >= workspaceMinimumCenterWidth) return
  const right = api.getEdgeGroup('right')
  if (right && rightState?.visible && !right.isCollapsed()) {
    right.collapse()
    centerWidth += rightState.size - workspaceEdgeCollapsedSize
  }
  const left = api.getEdgeGroup('left')
  if (centerWidth < workspaceMinimumCenterWidth && left && leftState?.visible && !left.isCollapsed()) left.collapse()
}

export function centralGridIsEmpty(api: DockviewApi): boolean {
  return !api.groups.some((group) => group.api.location.type === 'grid' && group.panels.length > 0)
}

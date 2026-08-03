import type { DockviewApi } from 'dockview-core'

export type WorkspaceWindowHandle = {
  windowId: string
  outerPanelId: string
  getInnerApi: () => DockviewApi | null
  settle: () => Promise<void>
  persist: () => void
  panelIds: () => string[]
  activePanelId: () => string | null
  focusActive: () => void
}
export type WorkspaceWindowSplitPosition = 'top' | 'bottom' | 'left' | 'right'
export const workspaceWindowDragType = 'application/x-vibelink-workspace-window'

type WorkspaceWindowContentDropTarget = {
  group: DockviewApi['groups'][number]
  position: WorkspaceWindowSplitPosition
}

let draggedPanelId: string | null = null

export function beginWorkspaceWindowDrag(panelId: string): void {
  draggedPanelId = panelId
}

export function endWorkspaceWindowDrag(): void {
  draggedPanelId = null
}

export function workspaceWindowDragPanelId(): string | null {
  return draggedPanelId
}

export function workspaceWindowContentDropTarget(
  api: DockviewApi,
  sourcePanelId: string,
  clientX: number,
  clientY: number,
): WorkspaceWindowContentDropTarget | null {
  const group = api.groups.find((candidate) => {
    if (!candidate.panels.some((panel) => panel.id !== sourcePanelId)) return false
    const rect = candidate.element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
      && clientX >= rect.left && clientX <= rect.right
      && clientY >= rect.top && clientY <= rect.bottom
  })
  if (!group) return null
  const rect = group.element.getBoundingClientRect()
  const y = clientY - rect.top
  const position: WorkspaceWindowSplitPosition = y < rect.height / 4
    ? 'top'
    : y > rect.height * 3 / 4
      ? 'bottom'
      : clientX - rect.left < rect.width / 2 ? 'left' : 'right'
  return { group, position }
}

export function moveWorkspaceWindowPanelFromContentDrop(
  api: DockviewApi,
  sourcePanelId: string,
  clientX: number,
  clientY: number,
): { groupId: string; position: WorkspaceWindowSplitPosition } | null {
  const sourcePanel = api.getPanel(sourcePanelId)
  const target = workspaceWindowContentDropTarget(api, sourcePanelId, clientX, clientY)
  if (!sourcePanel || !target) return null
  sourcePanel.api.moveTo({ group: target.group, position: target.position })
  return { groupId: target.group.id, position: target.position }
}

const windows = new Map<string, WorkspaceWindowHandle>()

export function registerWorkspaceWindow(handle: WorkspaceWindowHandle): () => void {
  windows.set(handle.windowId, handle)
  return () => {
    if (windows.get(handle.windowId) === handle) windows.delete(handle.windowId)
  }
}

export function getWorkspaceWindow(windowId: string): WorkspaceWindowHandle | undefined {
  return windows.get(windowId)
}

export function listWorkspaceWindows(): WorkspaceWindowHandle[] {
  return [...windows.values()]
}

export function findWorkspaceWindowForPanel(panelId: string): WorkspaceWindowHandle | undefined {
  return listWorkspaceWindows().find((handle) => handle.getInnerApi()?.getPanel(panelId))
}

export function findWorkspaceWindowForGroup(groupId: string): WorkspaceWindowHandle | undefined {
  return listWorkspaceWindows().find((handle) => handle.getInnerApi()?.groups.some((group) => group.id === groupId))
}

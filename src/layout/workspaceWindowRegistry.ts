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

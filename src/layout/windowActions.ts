import { createContext, useContext } from 'react'
import type { WindowDropPosition } from './windowDrag'
import type { WorkspaceWindowKind } from './workspaceLayoutModel'
import type { SplitDirection } from './actions'
import type { GridSize } from './templatePlan'

export type TerminalGridLaunchRequest = {
  cols: number
  rows: number
  occupiedGrid?: GridSize
  profileId?: string | null
}

export type WorkspaceWindowActions = {
  activateWindow: (panelId: string) => void
  openWindow: (kind: WorkspaceWindowKind) => Promise<void>
  splitTerminal: (paneId: string, direction: SplitDirection) => Promise<void>
  closeWindow: (panelId: string) => Promise<void>
  toggleMaximize: (panelId: string) => void
  renameTerminalTitle: (paneId: string, title: string) => Promise<void>
  swapWindowLocations: (sourcePanelId: string, targetPanelId: string) => Promise<void>
  moveWindowToPosition: (sourcePanelId: string, targetPanelId: string, position: Exclude<WindowDropPosition, 'center'>) => Promise<void>
  clearTerminals: () => void
  arrangeTerminals: (grid?: GridSize | null) => void
  launchTerminalGrid: (request: TerminalGridLaunchRequest) => void
  getTerminalLayoutSnapshot: () => unknown | null
}

export type WorkspaceChromeState = {
  windowCount: number
  activeWindowKind: WorkspaceWindowKind | null
}

export const WorkspaceWindowActionsContext = createContext<WorkspaceWindowActions | null>(null)

export function useWorkspaceWindowActions(): WorkspaceWindowActions {
  const actions = useContext(WorkspaceWindowActionsContext)
  if (!actions) throw new Error('Workspace window actions are not available')
  return actions
}

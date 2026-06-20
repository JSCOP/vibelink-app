import { createContext, useContext } from 'react'

export type SplitDirection = 'left' | 'right' | 'above' | 'below'

export type WorkspaceActions = {
  activatePane: (paneId: string) => void
  splitPane: (paneId: string, direction: SplitDirection) => Promise<void>
  newTab: (paneId: string) => Promise<void>
  closePane: (paneId: string) => Promise<void>
  toggleMaximize: (paneId: string) => void
  renamePaneTitle: (paneId: string, title: string) => Promise<void>
  swapPaneLocations: (sourcePaneId: string, targetPaneId: string) => Promise<void>
  movePaneToPosition: (sourcePaneId: string, targetPaneId: string, position: 'left' | 'right' | 'top' | 'bottom') => Promise<void>
}

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null)

export function useWorkspaceActions(): WorkspaceActions {
  const actions = useContext(WorkspaceActionsContext)
  if (!actions) throw new Error('Workspace actions are not available')
  return actions
}

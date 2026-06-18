import { createContext, useContext } from 'react'

export type SplitDirection = 'left' | 'right' | 'above' | 'below'

export type WorkspaceActions = {
  splitPane: (paneId: string, direction: SplitDirection) => Promise<void>
  newTab: (paneId: string) => Promise<void>
  closePane: (paneId: string) => Promise<void>
  toggleMaximize: (paneId: string) => void
}

export const WorkspaceActionsContext = createContext<WorkspaceActions | null>(null)

export function useWorkspaceActions(): WorkspaceActions {
  const actions = useContext(WorkspaceActionsContext)
  if (!actions) throw new Error('Workspace actions are not available')
  return actions
}

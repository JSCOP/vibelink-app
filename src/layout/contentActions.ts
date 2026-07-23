import { createContext, useContext } from 'react'
import type { GridSize } from './templatePlan'
import type { WorkspaceContentKind, WorkspaceContentParams } from './workspaceContentModel'

export type TerminalGridLaunchRequest = {
  cols: number
  rows: number
  occupiedGrid?: GridSize
  profileId?: string | null
}

export type WorkspaceContentOwnership = {
  workspaceId?: string
  workspaceEpoch?: number
}

export type OpenContentRequest = WorkspaceContentOwnership & (
  | { kind: 'terminal'; targetGroupId?: string; profileId?: string | null; cwd?: string | null; split?: 'right' | 'below'; shell?: string | null; args?: string[]; title?: string }
  | { kind: 'terminal-grid'; targetGroupId?: string; grid: TerminalGridLaunchRequest }
  | { kind: 'browser'; targetGroupId?: string; profileId?: string | null; private?: boolean }
  | { kind: 'editor'; targetGroupId?: string; relPath: string }
  | { kind: 'preview'; targetGroupId?: string; relPath: string; activate?: boolean }
  | { kind: Exclude<WorkspaceContentKind, 'terminal' | 'browser' | 'editor' | 'preview'>; targetGroupId?: string }
)

export type WorkspaceContentActions = {
  openContent(request: OpenContentRequest): Promise<string>
  activateContent(panelId: string): void
  requestCloseContent(panelId: string, ownership?: WorkspaceContentOwnership): Promise<'closed' | 'cancelled'>
  splitTerminal(paneId: string, direction: 'right' | 'below'): Promise<void>
  arrangeTerminals(grid?: GridSize | null): Promise<void>
  clearTerminals(): Promise<void>
  toggleMaximizeContent(panelId: string): void
  renameTerminal(paneId: string, title: string): Promise<void>
  resetLayout(): Promise<void>
  getContentParams(panelId: string): WorkspaceContentParams | null
}

export type WorkspaceContentChromeState = {
  contentCount: number
  activeContentKind: WorkspaceContentKind | null
  activePanelId: string | null
  activeGroupId: string | null
}

export const WorkspaceContentActionsContext = createContext<WorkspaceContentActions | null>(null)

export function useWorkspaceContentActions(): WorkspaceContentActions {
  const actions = useContext(WorkspaceContentActionsContext)
  if (!actions) throw new Error('Workspace content actions are not available')
  return actions
}

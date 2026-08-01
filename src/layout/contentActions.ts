import { createContext, useContext } from 'react'
import type { GridSize } from './templatePlan'
import type { WorkspaceContentKind, WorkspaceContentParams } from './workspaceContentModel'

export type TerminalGridLaunchRequest = {
  cols: number
  rows: number
  occupiedGrid?: GridSize
  profileId?: string | null
  windowId?: string
}

export type WorkspaceContentOwnership = {
  workspaceId?: string
  workspaceEpoch?: number
}

export type OpenContentRequest = WorkspaceContentOwnership & (
  | { kind: 'terminal'; targetGroupId?: string; windowId?: string; referencePaneId?: string; replacePaneId?: string; profileId?: string | null; cwd?: string | null; split?: 'right' | 'below'; shell?: string | null; args?: string[]; title?: string; newWindow?: boolean }
  | { kind: 'terminalWindow'; targetGroupId?: string }
  | { kind: 'terminal-grid'; targetGroupId?: string; grid: TerminalGridLaunchRequest }
  | { kind: 'browser'; targetGroupId?: string; profileId?: string | null; private?: boolean }
  | { kind: 'editor'; targetGroupId?: string; relPath: string }
  | { kind: 'preview'; targetGroupId?: string; relPath: string; activate?: boolean }
  | { kind: Exclude<WorkspaceContentKind, 'terminal' | 'terminalWindow' | 'browser' | 'editor' | 'preview'>; targetGroupId?: string }
)

export type WorkspaceContentActions = {
  openContent(request: OpenContentRequest): Promise<string>
  activateContent(panelId: string): void
  requestCloseContent(panelId: string, ownership?: WorkspaceContentOwnership): Promise<'closed' | 'cancelled'>
  splitTerminal(paneId: string, direction: 'right' | 'below'): Promise<void>
  arrangeTerminals(grid?: GridSize | null, windowId?: string): Promise<void>
  /** Close every terminal pane. Scoped to one terminal window when a
   *  `windowId` is given, matching `arrangeTerminals`. */
  clearTerminals(windowId?: string): Promise<void>
  toggleMaximizeContent(panelId: string): void
  /** Zoom the focused terminal pane inside its window; other content maximizes. */
  toggleZoomContent(panelId: string): void
  toggleTerminalWindowTitles(windowId: string): void
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

import { Orientation, type SerializedDockview } from 'dockview-core'
import type { PaneMeta } from '../ipc/types'
import type { GridSize } from './templatePlan'
import { occupiedGridForPaneCount } from './paneGridPlan'
import {
  freshWorkspaceLayoutEnvelope,
  normalizeWorkspaceLayoutEnvelope,
  normalizeWorkspaceRelativePath,
  serializeWorkspaceLayoutEnvelope,
  workspaceContentPanelId,
  type WorkspaceContentKind,
  type WorkspaceContentParams,
  type WorkspaceLayoutEnvelope,
} from './workspaceContentModel'

export type WorkspaceLayoutState = WorkspaceLayoutEnvelope

export type WorkspaceContentDescriptor = {
  kind: WorkspaceContentKind
  component: WorkspaceContentKind
  title: string
  icon: string
}

export const workspaceContentDescriptors: Record<WorkspaceContentKind, WorkspaceContentDescriptor> = {
  terminal: { kind: 'terminal', component: 'terminal', title: 'Terminal', icon: 'terminal' },
  terminalWindow: { kind: 'terminalWindow', component: 'terminalWindow', title: 'Terminal', icon: 'terminal' },
  browser: { kind: 'browser', component: 'browser', title: 'Browser', icon: 'globe' },
  editor: { kind: 'editor', component: 'editor', title: 'Editor', icon: 'file-code' },
  preview: { kind: 'preview', component: 'preview', title: 'Preview', icon: 'file-search' },
  workspaces: { kind: 'workspaces', component: 'workspaces', title: 'Workspaces', icon: 'folder' },
  explorer: { kind: 'explorer', component: 'explorer', title: 'Explorer', icon: 'folder-tree' },
  workspaceFiles: { kind: 'workspaceFiles', component: 'workspaceFiles', title: 'Workspace Files', icon: 'file-search' },
  sourceControl: { kind: 'sourceControl', component: 'sourceControl', title: 'Source Control', icon: 'git-compare-arrows' },
  gitHistory: { kind: 'gitHistory', component: 'gitHistory', title: 'Git History', icon: 'history' },
  gitBranches: { kind: 'gitBranches', component: 'gitBranches', title: 'Branches', icon: 'git-branch' },
  workbench: { kind: 'workbench', component: 'workbench', title: 'Workbench', icon: 'git-branch' },
  agent: { kind: 'agent', component: 'agent', title: 'VibeLink Agent', icon: 'bot' },
  orchestration: { kind: 'orchestration', component: 'orchestration', title: 'Orchestration', icon: 'monitor-cog' },
  kanban: { kind: 'kanban', component: 'kanban', title: 'Kanban', icon: 'layout-grid' },
  todo: { kind: 'todo', component: 'todo', title: 'Todo List', icon: 'list-todo' },
  diff: { kind: 'diff', component: 'diff', title: 'Diff', icon: 'git-compare' },
  agentSessions: { kind: 'agentSessions', component: 'agentSessions', title: 'Agent Sessions', icon: 'messages-square' },
}

export const workspaceLeftEdgeGroupId = 'workspace-left-tools'
export const workspaceRightEdgeGroupId = 'workspace-right-tools'
export const workspaceEdgeCollapsedSize = 38
export const workspaceMinimumCenterWidth = 640

export const workspaceLeftStructuralKinds = ['workspaces', 'explorer'] as const
export const workspaceRightStructuralKinds = ['workspaceFiles', 'sourceControl', 'gitHistory', 'gitBranches', 'agentSessions'] as const

export const workspaceEdgeGroupOptions = {
  left: { id: workspaceLeftEdgeGroupId, initialSize: 300, minimumSize: 240, maximumSize: 440, collapsedSize: workspaceEdgeCollapsedSize },
  right: { id: workspaceRightEdgeGroupId, initialSize: 340, minimumSize: 280, maximumSize: 520, collapsedSize: workspaceEdgeCollapsedSize },
} as const

export function workspaceDefaultEdgeCollapse(rootWidth: number): { left: boolean; right: boolean } {
  if (rootWidth < 900) return { left: true, right: true }
  if (rootWidth < 1280) return { left: false, right: true }
  return { left: false, right: false }
}

export function normalizeWorkspaceLayoutState(raw: string | null | undefined): WorkspaceLayoutState {
  return normalizeWorkspaceLayoutEnvelope(raw)
}

export function serializeWorkspaceLayoutState(state: WorkspaceLayoutState): string {
  return serializeWorkspaceLayoutEnvelope(state)
}

export function createTerminalContentParams(pane: Pick<PaneMeta, 'id' | 'config'>): Extract<WorkspaceContentParams, { kind: 'terminal' }> {
  return {
    schema: 1,
    kind: 'terminal',
    instanceId: pane.id,
    title: pane.config.title?.trim() || 'Shell',
    icon: pane.config.icon?.trim() || 'terminal',
    paneId: pane.id,
  }
}

export function createSingletonContentParams(kind: Exclude<WorkspaceContentKind, 'terminal' | 'terminalWindow' | 'browser' | 'editor' | 'preview'>): WorkspaceContentParams {
  const descriptor = workspaceContentDescriptors[kind]
  return { schema: 1, kind, instanceId: kind, title: descriptor.title, icon: descriptor.icon }
}

/** Panel entry for the INNER terminal-window Dockview. Its tab renderer is the
 * per-pane title bar, not the outer window content tab. */
export function createTerminalPanePanel(params: Extract<WorkspaceContentParams, { kind: 'terminal' }>): SerializedDockview['panels'][string] {
  return {
    id: workspaceContentPanelId(params),
    contentComponent: 'terminal',
    tabComponent: 'paneTitleBar',
    params,
    title: params.title,
    renderer: 'always',
  }
}

/** Row-major nested Dockview holding a terminal window's panes. Each pane is a
 * leaf group so every pane is simultaneously visible (the containment grid). */
export function createTerminalWindowInnerLayout(paneParams: Array<Extract<WorkspaceContentParams, { kind: 'terminal' }>>, grid: GridSize, width = 1000, height = 640): SerializedDockview {
  const panels: SerializedDockview['panels'] = {}
  for (const params of paneParams) panels[workspaceContentPanelId(params)] = createTerminalPanePanel(params)
  const ids = paneParams.map((params) => workspaceContentPanelId(params))
  const cols = Math.max(1, grid.cols)
  const distribute = (total: number, count: number): number[] => {
    const base = Math.floor(total / Math.max(1, count))
    return Array.from({ length: count }, (_, index) => (index === count - 1 ? total - base * (count - 1) : base))
  }
  let groupIndex = 0
  const leaf = (panelId: string, size: number): SerializedDockview['grid']['root'] => ({
    type: 'leaf',
    data: { views: [panelId], activeView: panelId, id: `pane-group-${groupIndex++}` },
    size,
  })
  const columnCount = Math.min(cols, Math.max(1, ids.length))
  const columnSizes = distribute(width, columnCount)
  const columns: SerializedDockview['grid']['root'][] = []
  for (let col = 0; col < columnCount; col += 1) {
    const columnPanes: string[] = []
    for (let row = 0; row * cols + col < ids.length; row += 1) columnPanes.push(ids[row * cols + col])
    if (columnPanes.length === 0) continue
    const rowSizes = distribute(height, columnPanes.length)
    columns.push(columnPanes.length === 1
      ? { ...leaf(columnPanes[0], columnSizes[col]) }
      : { type: 'branch', data: columnPanes.map((panelId, row) => leaf(panelId, rowSizes[row])), size: columnSizes[col] })
  }
  return {
    panels,
    grid: { root: { type: 'branch', data: columns, size: width }, width, height, orientation: Orientation.HORIZONTAL },
    ...(ids[0] ? { activeGroup: `pane-group-0` } : {}),
  }
}

export function createTerminalWindowParams(
  instanceId: string,
  paneParams: Array<Extract<WorkspaceContentParams, { kind: 'terminal' }>>,
  grid: GridSize,
  options: { titlesHidden?: boolean; title?: string } = {},
): Extract<WorkspaceContentParams, { kind: 'terminalWindow' }> {
  return {
    schema: 1,
    kind: 'terminalWindow',
    instanceId,
    title: options.title?.trim() || 'Terminal',
    icon: 'terminal',
    inner: paneParams.length > 0 ? createTerminalWindowInnerLayout(paneParams, grid) : null,
    titlesHidden: options.titlesHidden ?? false,
  }
}

export function createPreviewContentParams(relPathValue: string): Extract<WorkspaceContentParams, { kind: 'preview' }> {
  const relPath = normalizePreviewPath(relPathValue)
  return { schema: 1, kind: 'preview', instanceId: 'preview', title: relPath.split('/').at(-1) ?? 'Preview', icon: 'file-search', relPath }
}

export function createWorkspaceContentPanel(params: WorkspaceContentParams): SerializedDockview['panels'][string] {
  return {
    id: workspaceContentPanelId(params),
    contentComponent: params.kind,
    tabComponent: 'workspaceContentTab',
    params,
    title: params.title,
    renderer: 'always',
  }
}

export function createDefaultWorkspaceDockviewLayout(panes: Array<Pick<PaneMeta, 'id' | 'config'>>, rootWidth = 1280): SerializedDockview {
  const terminalParams = panes.map(createTerminalContentParams)
  return createWorkspaceDockview(terminalParams, rootWidth)
}

export type TerminalArrangementStep = {
  panelId: string
  referencePanelId: string
  position: 'right' | 'bottom'
}

/**
 * Plans a row-major terminal grid using Dockview's native panel movement.
 * The first row is built horizontally; every later pane is placed below the
 * pane in the same column. Moving only terminal panels lets Dockview retain
 * every non-terminal tab group while empty terminal-only groups collapse.
 */
export function planTerminalArrangement(panelIds: readonly string[], grid: GridSize): TerminalArrangementStep[] {
  if (grid.cols <= 0 || grid.rows <= 0) return []
  const steps: TerminalArrangementStep[] = []
  for (let index = 1; index < panelIds.length; index += 1) {
    const row = Math.floor(index / grid.cols)
    const referenceIndex = row === 0 ? index - 1 : index - grid.cols
    const referencePanelId = panelIds[referenceIndex]
    if (!referencePanelId) continue
    steps.push({
      panelId: panelIds[index],
      referencePanelId,
      position: row === 0 ? 'right' : 'bottom',
    })
  }
  return steps
}

export function freshWorkspaceLayoutState(): WorkspaceLayoutState {
  return freshWorkspaceLayoutEnvelope()
}

function createWorkspaceDockview(terminalParams: Array<Extract<WorkspaceContentParams, { kind: 'terminal' }>>, rootWidth: number): SerializedDockview {
  const leftParams = workspaceLeftStructuralKinds.map(createSingletonContentParams)
  const rightParams = workspaceRightStructuralKinds.map(createSingletonContentParams)
  const structuralParams = [...leftParams, ...rightParams]
  const terminalCount = terminalParams.length
  const centerWidth = Math.max(workspaceMinimumCenterWidth, Math.min(Math.max(1, terminalCount), 4) * 500)
  const height = Math.max(1, Math.ceil(Math.max(1, terminalCount) / 2)) * 320
  const panels: SerializedDockview['panels'] = {}
  for (const entry of structuralParams) panels[workspaceContentPanelId(entry)] = createWorkspaceContentPanel(entry)

  // Terminals live INSIDE one terminal window (nested pane grid). The outer grid
  // always holds that single window panel — even with zero panes — so a
  // workspace always has a terminal window (and its + New button), and editors/
  // browser open as sibling window tabs instead of wedging into the pane grid.
  const grid = occupiedGridForPaneCount(terminalCount) satisfies GridSize
  const firstTerminalGroupId = 'content-group-0'
  const windowParams = createTerminalWindowParams(crypto.randomUUID(), terminalParams, grid.cols > 0 ? grid : { cols: 1, rows: 1 })
  const windowPanelId = workspaceContentPanelId(windowParams)
  panels[windowPanelId] = createWorkspaceContentPanel(windowParams)
  const columns: SerializedDockview['grid']['root'][] = [{
    type: 'leaf',
    data: { views: [windowPanelId], activeView: windowPanelId, id: firstTerminalGroupId },
    size: centerWidth,
  }]

  const collapsed = workspaceDefaultEdgeCollapse(rootWidth)
  const workspacesId = workspaceContentPanelId(leftParams[0])
  const workspaceFilesId = workspaceContentPanelId(rightParams[0])
  return {
    panels,
    grid: {
      root: { type: 'branch', data: columns, size: centerWidth },
      width: centerWidth,
      height,
      orientation: Orientation.HORIZONTAL,
    },
    ...(firstTerminalGroupId ? { activeGroup: firstTerminalGroupId } : {}),
    edgeGroups: {
      left: {
        size: workspaceEdgeGroupOptions.left.initialSize,
        visible: true,
        collapsed: collapsed.left || undefined,
        group: {
          id: workspaceLeftEdgeGroupId,
          views: leftParams.map(workspaceContentPanelId),
          activeView: workspacesId,
        },
      },
      right: {
        size: workspaceEdgeGroupOptions.right.initialSize,
        visible: true,
        collapsed: collapsed.right || undefined,
        group: {
          id: workspaceRightEdgeGroupId,
          views: rightParams.map(workspaceContentPanelId),
          activeView: workspaceFilesId,
        },
      },
    },
  }
}

function normalizePreviewPath(value: string): string {
  const normalized = normalizeWorkspaceRelativePath(value)
  if (!normalized) throw new Error('Preview paths must be workspace-relative and cannot contain parent segments.')
  return normalized
}


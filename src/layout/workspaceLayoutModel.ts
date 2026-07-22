import { Orientation, type SerializedDockview } from 'dockview-core'
import type { PaneMeta } from '../ipc/types'
import { balancedGridForPaneCount, type GridSize } from './templatePlan'
import {
  freshWorkspaceLayoutEnvelope,
  normalizeWorkspaceLayoutEnvelope,
  normalizeWorkspaceRelativePath,
  parseWorkspaceContentParams,
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
  browser: { kind: 'browser', component: 'browser', title: 'Browser', icon: 'globe' },
  editor: { kind: 'editor', component: 'editor', title: 'Editor', icon: 'file-code' },
  preview: { kind: 'preview', component: 'preview', title: 'Preview', icon: 'file-search' },
  explorer: { kind: 'explorer', component: 'explorer', title: 'Explorer', icon: 'folder-tree' },
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

export const workspaceLeftStructuralKinds = ['explorer', 'sourceControl', 'gitHistory', 'gitBranches'] as const
export const workspaceRightStructuralKinds = ['agentSessions'] as const

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

export function createTerminalContentParams(pane: Pick<PaneMeta, 'id' | 'config'>): WorkspaceContentParams {
  return {
    schema: 1,
    kind: 'terminal',
    instanceId: pane.id,
    title: pane.config.title?.trim() || 'Shell',
    icon: pane.config.icon?.trim() || 'terminal',
    paneId: pane.id,
  }
}

export function createSingletonContentParams(kind: Exclude<WorkspaceContentKind, 'terminal' | 'browser' | 'editor' | 'preview'>): WorkspaceContentParams {
  const descriptor = workspaceContentDescriptors[kind]
  return { schema: 1, kind, instanceId: kind, title: descriptor.title, icon: descriptor.icon }
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
  const terminalGrid = terminalParams.length > 0
    ? balancedGridForPaneCount(terminalParams.length, 16 / 9)
    : { cols: 0, rows: 0 }
  return createWorkspaceDockview(terminalParams, terminalGrid, rootWidth)
}

export function workspaceLayoutHasExactLiveTerminals(envelope: WorkspaceLayoutEnvelope, livePaneIds: readonly string[]): boolean {
  const dockview = envelope.dockview
  if (!dockview) return livePaneIds.length === 0
  const layout = dockview as unknown
  if (!isRecord(layout) || !isRecord(layout.panels) || !isRecord(layout.grid)) return false
  const panels = layout.panels
  const grid = layout.grid
  if (!isPositiveNumber(grid.width) || !isPositiveNumber(grid.height)) return false

  const viewIds: string[] = []
  if (!collectGridViewIds(grid.root, viewIds, true) || !collectAdditionalViewIds(layout, viewIds)) return false
  const viewIdSet = new Set(viewIds)
  if (viewIdSet.size !== viewIds.length) return false

  const live = new Set(livePaneIds)
  if (live.size !== livePaneIds.length) return false
  const layoutPanes = new Set<string>()
  for (const [panelId, value] of Object.entries(panels)) {
    if (!isRecord(value)) return false
    const params = parseWorkspaceContentParams(value.params)
    if (
      !params
      || workspaceContentPanelId(params) !== panelId
      || !viewIdSet.has(panelId)
      || value.contentComponent !== params.kind
      || value.tabComponent !== 'workspaceContentTab'
      || value.renderer !== 'always'
    ) return false
    if (params.kind !== 'terminal') continue
    if (!live.has(params.paneId) || layoutPanes.has(params.paneId)) return false
    layoutPanes.add(params.paneId)
  }
  if (viewIds.some((panelId) => !(panelId in panels)) || viewIds.length !== Object.keys(panels).length) return false
  if (layoutPanes.size !== live.size) return false
  return [...live].every((paneId) => layoutPanes.has(paneId))
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

function createWorkspaceDockview(terminalParams: WorkspaceContentParams[], grid: GridSize, rootWidth: number): SerializedDockview {
  const leftParams = workspaceLeftStructuralKinds.map(createSingletonContentParams)
  const rightParams = workspaceRightStructuralKinds.map(createSingletonContentParams)
  const structuralParams = [...leftParams, ...rightParams]
  const terminalIds = terminalParams.map((entry) => workspaceContentPanelId(entry))
  const requestedColumns = Number.isFinite(grid.cols) ? Math.floor(grid.cols) : 1
  const requestedRows = Number.isFinite(grid.rows) ? Math.floor(grid.rows) : 1
  const terminalColumns = terminalIds.length > 0 ? Math.max(1, Math.min(requestedColumns, terminalIds.length)) : 0
  const terminalRows = terminalIds.length > 0 ? Math.max(Math.ceil(terminalIds.length / terminalColumns), requestedRows, 1) : 0
  const terminalColumnWidth = 500
  const centerWidth = Math.max(workspaceMinimumCenterWidth, terminalColumns * terminalColumnWidth)
  const height = Math.max(1, terminalRows) * 320
  const panels: SerializedDockview['panels'] = {}
  for (const entry of structuralParams) panels[workspaceContentPanelId(entry)] = createWorkspaceContentPanel(entry)
  for (const entry of terminalParams) panels[workspaceContentPanelId(entry)] = createWorkspaceContentPanel(entry)

  let groupIndex = 0
  let firstTerminalGroupId: string | null = null
  const leaf = (panelId: string, size: number): SerializedDockview['grid']['root'] => {
    const groupId = `content-group-${groupIndex++}`
    if (firstTerminalGroupId === null) firstTerminalGroupId = groupId
    return {
      type: 'leaf',
      data: { views: [panelId], activeView: panelId, id: groupId },
      size,
    }
  }

  const columns: SerializedDockview['grid']['root'][] = []
  for (let col = 0; col < terminalColumns; col += 1) {
    const columnIds: string[] = []
    for (let row = 0; row < terminalRows; row += 1) {
      const panelId = terminalIds[row * terminalColumns + col]
      if (panelId) columnIds.push(panelId)
    }
    if (columnIds.length === 0) continue
    if (columnIds.length === 1) columns.push(leaf(columnIds[0], terminalColumnWidth))
    else {
      columns.push({
        type: 'branch',
        data: columnIds.map((panelId) => leaf(panelId, Math.max(1, Math.floor(height / columnIds.length)))),
        size: terminalColumnWidth,
      })
    }
  }

  const collapsed = workspaceDefaultEdgeCollapse(rootWidth)
  const explorerId = workspaceContentPanelId(leftParams[0])
  const agentSessionsId = workspaceContentPanelId(rightParams[0])
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
          activeView: explorerId,
        },
      },
      right: {
        size: workspaceEdgeGroupOptions.right.initialSize,
        visible: true,
        collapsed: collapsed.right || undefined,
        group: {
          id: workspaceRightEdgeGroupId,
          views: rightParams.map(workspaceContentPanelId),
          activeView: agentSessionsId,
        },
      },
    },
  }
}

function collectGridViewIds(node: unknown, output: string[], allowEmptyRoot = false): boolean {
  if (!isRecord(node) || !isPositiveNumber(node.size)) return false
  if (node.type === 'leaf') {
    if (!isRecord(node.data) || !Array.isArray(node.data.views) || node.data.views.length === 0) return false
    for (const view of node.data.views) {
      if (typeof view !== 'string' || !view) return false
      output.push(view)
    }
    return true
  }
  if (node.type !== 'branch' || !Array.isArray(node.data)) return false
  if (node.data.length === 0) return allowEmptyRoot
  return node.data.every((child) => collectGridViewIds(child, output, false))
}

function collectAdditionalViewIds(layout: Record<string, unknown>, output: string[]): boolean {
  for (const key of ['floatingGroups', 'popoutGroups'] as const) {
    const groups = layout[key]
    if (groups === undefined) continue
    if (!Array.isArray(groups)) return false
    for (const entry of groups) {
      if (!isRecord(entry) || !collectGroupViews(entry.data, output)) return false
    }
  }
  if (layout.edgeGroups !== undefined) {
    if (!isRecord(layout.edgeGroups)) return false
    for (const position of ['top', 'bottom', 'left', 'right']) {
      const entry = layout.edgeGroups[position]
      if (entry === undefined) continue
      if (!isRecord(entry) || (entry.group !== undefined && !collectGroupViews(entry.group, output))) return false
    }
  }
  return true
}

function collectGroupViews(group: unknown, output: string[]): boolean {
  if (!isRecord(group) || !Array.isArray(group.views) || group.views.length === 0) return false
  for (const view of group.views) {
    if (typeof view !== 'string' || !view) return false
    output.push(view)
  }
  return true
}

function normalizePreviewPath(value: string): string {
  const normalized = normalizeWorkspaceRelativePath(value)
  if (!normalized) throw new Error('Preview paths must be workspace-relative and cannot contain parent segments.')
  return normalized
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

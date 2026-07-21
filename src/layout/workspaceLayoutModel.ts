import { Orientation, type SerializedDockview } from 'dockview-core'
import type { PaneMeta } from '../ipc/types'
import { balancedGridForPaneCount, type GridSize } from './templatePlan'
import {
  freshWorkspaceLayoutEnvelope,
  normalizeWorkspaceLayoutEnvelope,
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
  explorer: { kind: 'explorer', component: 'explorer', title: 'Explorer', icon: 'folder-tree' },
  workbench: { kind: 'workbench', component: 'workbench', title: 'Workbench', icon: 'git-branch' },
  agent: { kind: 'agent', component: 'agent', title: 'VibeLink Agent', icon: 'bot' },
  orchestration: { kind: 'orchestration', component: 'orchestration', title: 'Orchestration', icon: 'monitor-cog' },
  kanban: { kind: 'kanban', component: 'kanban', title: 'Kanban', icon: 'layout-grid' },
  todo: { kind: 'todo', component: 'todo', title: 'Todo List', icon: 'list-todo' },
  diff: { kind: 'diff', component: 'diff', title: 'Diff', icon: 'git-compare' },
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

export function createSingletonContentParams(kind: Exclude<WorkspaceContentKind, 'terminal' | 'browser' | 'editor'>): WorkspaceContentParams {
  const descriptor = workspaceContentDescriptors[kind]
  return { schema: 1, kind, instanceId: kind, title: descriptor.title, icon: descriptor.icon }
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

export function createDefaultWorkspaceDockviewLayout(panes: Array<Pick<PaneMeta, 'id' | 'config'>>): SerializedDockview {
  const terminalParams = panes.map(createTerminalContentParams)
  const terminalGrid = terminalParams.length > 0
    ? balancedGridForPaneCount(terminalParams.length, 16 / 9)
    : { cols: 0, rows: 0 }
  return createNavigatorTerminalDockview(terminalParams, terminalGrid)
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
  if (!collectViewIds(grid.root, viewIds) || viewIds.length === 0) return false
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
  if (viewIds.some((panelId) => !(panelId in panels))) return false
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
 * Moving only terminal panels lets Dockview retain every non-terminal tab
 * group and its active view while empty terminal-only groups collapse.
 */
export function planTerminalArrangement(panelIds: readonly string[], grid: GridSize): TerminalArrangementStep[] {
  if (grid.cols <= 0 || grid.rows <= 0) return []
  const steps: TerminalArrangementStep[] = []
  for (let index = 1; index < panelIds.length; index += 1) {
    const col = index % grid.cols
    const referenceIndex = col === 0 ? index - grid.cols : index - 1
    const referencePanelId = panelIds[referenceIndex]
    if (!referencePanelId) continue
    steps.push({
      panelId: panelIds[index],
      referencePanelId,
      position: col === 0 ? 'bottom' : 'right',
    })
  }
  return steps
}

export function freshWorkspaceLayoutState(): WorkspaceLayoutState {
  return freshWorkspaceLayoutEnvelope()
}

function createNavigatorTerminalDockview(terminalParams: WorkspaceContentParams[], grid: GridSize): SerializedDockview {
  const explorerParams = createSingletonContentParams('explorer')
  const explorerPanelId = workspaceContentPanelId(explorerParams)
  const terminalIds = terminalParams.map((entry) => workspaceContentPanelId(entry))
  const requestedColumns = Number.isFinite(grid.cols) ? Math.floor(grid.cols) : 1
  const requestedRows = Number.isFinite(grid.rows) ? Math.floor(grid.rows) : 1
  const terminalColumns = terminalIds.length > 0 ? Math.max(1, Math.min(requestedColumns, terminalIds.length)) : 0
  const terminalRows = terminalIds.length > 0 ? Math.max(Math.ceil(terminalIds.length / terminalColumns), requestedRows, 1) : 0
  const explorerWidth = 280
  const terminalColumnWidth = 500
  const width = explorerWidth + terminalColumns * terminalColumnWidth
  const height = Math.max(1, terminalRows) * 320
  const panels: SerializedDockview['panels'] = {
    [explorerPanelId]: createWorkspaceContentPanel(explorerParams),
  }
  for (const entry of terminalParams) panels[workspaceContentPanelId(entry)] = createWorkspaceContentPanel(entry)

  let groupIndex = 0
  let firstTerminalGroupId: string | null = null
  const leaf = (panelId: string, size: number): SerializedDockview['grid']['root'] => {
    const groupId = `content-group-${groupIndex++}`
    if (panelId !== explorerPanelId && firstTerminalGroupId === null) firstTerminalGroupId = groupId
    return {
      type: 'leaf',
      data: { views: [panelId], activeView: panelId, id: groupId },
      size,
    }
  }

  const columns: SerializedDockview['grid']['root'][] = [leaf(explorerPanelId, explorerWidth)]
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

  return {
    panels,
    grid: {
      root: { type: 'branch', data: columns, size: width },
      width,
      height,
      orientation: Orientation.HORIZONTAL,
    },
    activeGroup: firstTerminalGroupId ?? 'content-group-0',
  }
}

function collectViewIds(node: unknown, output: string[]): boolean {
  if (!isRecord(node) || !isPositiveNumber(node.size)) return false
  if (node.type === 'leaf') {
    if (!isRecord(node.data) || !Array.isArray(node.data.views) || node.data.views.length === 0) return false
    for (const view of node.data.views) {
      if (typeof view !== 'string' || !view) return false
      output.push(view)
    }
    return true
  }
  if (node.type !== 'branch' || !Array.isArray(node.data) || node.data.length === 0) return false
  return node.data.every((child) => collectViewIds(child, output))
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

import type { GridSize } from './templatePlan'

export type GridPaneDescriptor = {
  id: string
  title?: string | null
  icon?: string | null
}

type SerializedPanel = Record<string, unknown> & {
  id?: string
  params?: Record<string, unknown>
}

type SerializedLeafNode = {
  type: 'leaf'
  data: {
    views: string[]
    activeView: string
    id: string
  }
  size: number
}

type SerializedBranchNode = {
  type: 'branch'
  data: SerializedNode[]
  size: number
}

type SerializedNode = SerializedLeafNode | SerializedBranchNode

type DockviewLayoutLike = {
  grid?: {
    root?: SerializedNode
    width?: number
    height?: number
    orientation?: string
  }
  panels?: Record<string, SerializedPanel>
  activeGroup?: string
}

export function createDockviewGridLayout(
  baseLayout: unknown,
  grid: GridSize,
  gridPanes: GridPaneDescriptor[],
  overflowPanes: GridPaneDescriptor[] = [],
  activePaneId?: string | null,
): DockviewLayoutLike | null {
  if (grid.cols <= 0 || grid.rows <= 0 || gridPanes.length === 0) return null

  const base = isLayout(baseLayout) ? baseLayout : {}
  const width = positiveInteger(base.grid?.width) ?? grid.cols * 100
  const height = positiveInteger(base.grid?.height) ?? grid.rows * 100
  const columnSizes = distributeSize(width, grid.cols)
  const panels = buildPanels(base.panels ?? {}, [...gridPanes, ...overflowPanes])
  const overflowIds = overflowPanes.map((pane) => pane.id)
  const lastGridPaneId = gridPanes.at(-1)?.id
  let groupIndex = 0
  let activeGroup: string | undefined

  const makeLeaf = (pane: GridPaneDescriptor, size: number): SerializedLeafNode => {
    const views = pane.id === lastGridPaneId ? [pane.id, ...overflowIds] : [pane.id]
    const activeView = activePaneId && views.includes(activePaneId) ? activePaneId : views[0]
    const groupId = `grid-${groupIndex}`
    groupIndex += 1
    if (activePaneId && views.includes(activePaneId)) activeGroup = groupId
    return {
      type: 'leaf',
      data: { views, activeView, id: groupId },
      size,
    }
  }

  let root: SerializedBranchNode
  let orientation: 'HORIZONTAL' | 'VERTICAL'
  if (grid.cols === 1) {
    orientation = 'VERTICAL'
    const presentPanes = gridPanes.slice(0, grid.rows)
    const sizes = distributeSize(height, presentPanes.length)
    const leaves: SerializedNode[] = []
    for (let index = 0; index < presentPanes.length; index += 1) {
      const pane = presentPanes[index]
      if (pane) leaves.push(makeLeaf(pane, sizes[index]))
    }
    root = { type: 'branch', data: leaves, size: height }
  } else {
    orientation = 'HORIZONTAL'
    const columns: SerializedNode[] = []
    for (let col = 0; col < grid.cols; col += 1) {
      const columnPanes: GridPaneDescriptor[] = []
      for (let row = 0; row < grid.rows; row += 1) {
        const pane = gridPanes[row * grid.cols + col]
        if (pane) columnPanes.push(pane)
      }
      if (columnPanes.length === 0) continue
      const rowSizes = distributeSize(height, columnPanes.length)
      const leaves: SerializedNode[] = []
      for (let row = 0; row < columnPanes.length; row += 1) {
        leaves.push(makeLeaf(columnPanes[row], rowSizes[row]))
      }
      columns.push(grid.rows === 1
        ? { ...(leaves[0] as SerializedLeafNode), size: columnSizes[col] }
        : { type: 'branch', data: leaves, size: columnSizes[col] })
    }
    root = { type: 'branch', data: columns, size: width }
  }

  return {
    ...base,
    grid: {
      root,
      width,
      height,
      orientation,
    },
    panels,
    activeGroup: activeGroup ?? firstLeafGroupId(root),
  }
}

function buildPanels(existing: Record<string, SerializedPanel>, panes: GridPaneDescriptor[]): Record<string, SerializedPanel> {
  const panels: Record<string, SerializedPanel> = {}
  for (const pane of panes) {
    const current = existing[pane.id] ?? {}
    const params = current.params ?? {}
    const title = pane.title ?? (typeof current.title === 'string' ? current.title : 'Shell')
    panels[pane.id] = {
      ...current,
      id: pane.id,
      contentComponent: current.contentComponent ?? 'terminal',
      tabComponent: current.tabComponent ?? 'props.defaultTabComponent',
      params: {
        ...params,
        paneId: pane.id,
        title,
        icon: pane.icon ?? params.icon,
      },
      title,
      renderer: current.renderer ?? 'always',
    }
  }
  return panels
}

function distributeSize(total: number, count: number): number[] {
  const base = Math.floor(total / count)
  const remainder = total - base * count
  return Array.from({ length: count }, (_, index) => base + (index < remainder ? 1 : 0))
}

function firstLeafGroupId(node: SerializedNode): string | undefined {
  if (node.type === 'leaf') return node.data.id
  for (const child of node.data) {
    const id = firstLeafGroupId(child)
    if (id) return id
  }
  return undefined
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : null
}

function isLayout(value: unknown): value is DockviewLayoutLike {
  return typeof value === 'object' && value !== null
}

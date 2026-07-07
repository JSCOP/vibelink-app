import { MAX_TERMINAL_GRID_COLS, MAX_TERMINAL_GRID_ROWS, clampTerminalGridCols, clampTerminalGridRows, occupiedGridForPaneCount as plannedOccupiedGridForPaneCount, type GridSize } from '../layout/paneGridPlan'

export type { GridSize }
export type TerminalGridCellState = 'occupied' | 'selected' | 'available'
export type TerminalOccupancyGrid = {
  cols: number
  rows: number
  cells: boolean[][]
}

export function occupancyFromDockLayout(layout: unknown): TerminalOccupancyGrid | null {
  const grid = isRecord(layout) && isRecord(layout.grid) ? layout.grid : null
  if (!grid || grid.maximizedNode) return null

  const width = positiveFiniteNumber(grid.width)
  const height = positiveFiniteNumber(grid.height)
  if (width === null || height === null || !grid.root) return null

  const leaves: DockRect[] = []
  if (!collectDockLeafRects(grid.root, { x: 0, y: 0, width, height }, axisFromDockOrientation(grid.orientation), leaves)) return null
  const occupiedLeaves = leaves.filter((leaf) => leaf.width > 0 && leaf.height > 0)
  if (occupiedLeaves.length === 0) return null

  const columnBreaks = coordinateBreaks(occupiedLeaves.map((leaf) => leaf.x), width)
  const rowBreaks = coordinateBreaks(occupiedLeaves.map((leaf) => leaf.y), height)
  const cols = columnBreaks.length - 1
  const rows = rowBreaks.length - 1
  if (cols <= 0 || rows <= 0) return null

  const cells = Array.from({ length: rows }, (_, row) => {
    const centerY = (rowBreaks[row] + rowBreaks[row + 1]) / 2
    return Array.from({ length: cols }, (__, col) => {
      const centerX = (columnBreaks[col] + columnBreaks[col + 1]) / 2
      return occupiedLeaves.some((leaf) => rectContainsPoint(leaf, centerX, centerY))
    })
  })

  return cells.some((row) => row.some(Boolean)) ? { cols, rows, cells } : null
}

export function occupiedGridForPaneCount(paneCount: number, preferred?: GridSize | null): GridSize {
  const occupied = plannedOccupiedGridForPaneCount(paneCount, preferred)
  if (!preferred || paneCount <= 0 || occupied.rows <= 0) return occupied

  const safeCount = Math.max(0, Math.floor(Number.isFinite(paneCount) ? paneCount : 0))
  const compactCols = clampTerminalGridCols(Math.ceil(safeCount / occupied.rows))
  if (compactCols < occupied.cols && compactCols * occupied.rows >= safeCount) return { cols: compactCols, rows: occupied.rows }
  return occupied
}

export function defaultTerminalGridSelection(paneCount: number, preferred?: GridSize | null): GridSize {
  const occupied = occupiedGridForPaneCount(paneCount, preferred)
  if (paneCount <= 0) return { cols: 2, rows: 2 }
  if (preferred) return occupied
  if (occupied.rows < MAX_TERMINAL_GRID_ROWS) return { cols: Math.max(1, occupied.cols), rows: occupied.rows + 1 }
  return { cols: Math.min(MAX_TERMINAL_GRID_COLS, occupied.cols + 1), rows: occupied.rows }
}

export function terminalAlignGridForNewPaneBasis(paneCount: number, preferred?: GridSize | null): GridSize | null {
  if (paneCount <= 0) return null
  return defaultTerminalGridSelection(paneCount, preferred)
}

export function terminalGridSelectionFromCell(occupied: GridSize, col: number, row: number): GridSize {
  return {
    cols: clampTerminalGridCols(Math.max(occupied.cols, col + 1)),
    rows: clampTerminalGridRows(Math.max(occupied.rows, row + 1)),
  }
}

export function terminalGridSelectionFromDimensions(occupied: GridSize, cols: number, rows: number): GridSize {
  return {
    cols: clampTerminalGridCols(Math.max(occupied.cols || 1, cols)),
    rows: clampTerminalGridRows(Math.max(occupied.rows || 1, rows)),
  }
}

export function selectedNewPaneCount(paneCount: number, selection: GridSize): number {
  return Math.max(0, clampTerminalGridCols(selection.cols) * clampTerminalGridRows(selection.rows) - Math.max(0, Math.floor(paneCount)))
}

export function terminalGridCellState(paneCount: number, occupied: GridSize, selection: GridSize, col: number, row: number): TerminalGridCellState {
  if (row < occupied.rows && col < occupied.cols && row * occupied.cols + col < paneCount) return 'occupied'
  if (row < selection.rows && col < selection.cols) return 'selected'
  return 'available'
}

export function terminalOccupancyGridCellState(occupied: TerminalOccupancyGrid, selection: GridSize, col: number, row: number): TerminalGridCellState {
  if (row < occupied.rows && col < occupied.cols) return occupied.cells[row]?.[col] ? 'occupied' : 'available'
  if (row < selection.rows && col < selection.cols) return 'selected'
  return 'available'
}


export function displayGridSize(): GridSize {
  return { cols: MAX_TERMINAL_GRID_COLS, rows: MAX_TERMINAL_GRID_ROWS }
}

export function clampGridCols(value: number): number {
  return clampTerminalGridCols(value)
}

export function clampGridRows(value: number): number {
  return clampTerminalGridRows(value)
}

type DockSplitAxis = 'x' | 'y'

type DockRect = {
  x: number
  y: number
  width: number
  height: number
}

const DOCK_COORDINATE_TOLERANCE = 2

function collectDockLeafRects(node: unknown, rect: DockRect, axis: DockSplitAxis, leaves: DockRect[]): boolean {
  if (!isRecord(node)) return false
  if (node.type === 'leaf') {
    const views = isRecord(node.data) && Array.isArray(node.data.views) ? node.data.views : []
    if (views.length > 0) leaves.push(rect)
    return true
  }
  if (node.type !== 'branch' || !Array.isArray(node.data)) return false

  let offset = axis === 'x' ? rect.x : rect.y
  for (const child of node.data) {
    if (!isRecord(child)) return false
    const size = positiveFiniteNumber(child.size)
    if (size === null) return false
    const childRect = axis === 'x'
      ? { x: offset, y: rect.y, width: size, height: rect.height }
      : { x: rect.x, y: offset, width: rect.width, height: size }
    if (!collectDockLeafRects(child, childRect, oppositeDockAxis(axis), leaves)) return false
    offset += size
  }
  return true
}

function coordinateBreaks(starts: number[], end: number): number[] {
  const breaks = distinctCoordinates([0, ...starts.filter((value) => Number.isFinite(value) && value >= -DOCK_COORDINATE_TOLERANCE && value <= end + DOCK_COORDINATE_TOLERANCE)])
  if (breaks.length === 0 || Math.abs(breaks[0]) > DOCK_COORDINATE_TOLERANCE) {
    breaks.unshift(0)
  } else {
    breaks[0] = 0
  }

  const lastIndex = breaks.length - 1
  if (end - breaks[lastIndex] > DOCK_COORDINATE_TOLERANCE) {
    breaks.push(end)
  } else {
    breaks[lastIndex] = end
  }

  return breaks.filter((value, index, values) => index === 0 || value - values[index - 1] > DOCK_COORDINATE_TOLERANCE)
}

function distinctCoordinates(values: number[]): number[] {
  const sorted = values.slice().sort((left, right) => left - right)
  const result: number[] = []
  for (const value of sorted) {
    const last = result[result.length - 1]
    if (last === undefined || Math.abs(value - last) > DOCK_COORDINATE_TOLERANCE) result.push(value)
  }
  return result
}

function rectContainsPoint(rect: DockRect, x: number, y: number): boolean {
  return x >= rect.x - DOCK_COORDINATE_TOLERANCE
    && x <= rect.x + rect.width + DOCK_COORDINATE_TOLERANCE
    && y >= rect.y - DOCK_COORDINATE_TOLERANCE
    && y <= rect.y + rect.height + DOCK_COORDINATE_TOLERANCE
}

function axisFromDockOrientation(orientation: unknown): DockSplitAxis {
  return orientation === 'VERTICAL' ? 'y' : 'x'
}

function oppositeDockAxis(axis: DockSplitAxis): DockSplitAxis {
  return axis === 'x' ? 'y' : 'x'
}

function positiveFiniteNumber(value: unknown): number | null {
  const numeric = Number(value)
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

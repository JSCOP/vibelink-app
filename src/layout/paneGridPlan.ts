import type { GridSize } from './templatePlan'
export type { GridSize } from './templatePlan'

export const MAX_TERMINAL_GRID_COLS = 20
export const MAX_TERMINAL_GRID_ROWS = 10

export function occupiedGridForPaneCount(paneCount: number, preferred?: GridSize | null): GridSize {
  const safeCount = Math.max(0, Math.floor(Number.isFinite(paneCount) ? paneCount : 0))
  if (safeCount === 0) return { cols: 0, rows: 0 }

  if (preferred) {
    const cols = clampTerminalGridCols(preferred.cols)
    const rows = Math.ceil(safeCount / cols)
    if (rows <= MAX_TERMINAL_GRID_ROWS) return { cols, rows: clampTerminalGridRows(rows) }
  }

  let best: GridSize | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (let cols = 1; cols <= Math.min(MAX_TERMINAL_GRID_COLS, safeCount); cols += 1) {
    const rows = Math.ceil(safeCount / cols)
    if (rows > MAX_TERMINAL_GRID_ROWS) continue
    const emptyCells = cols * rows - safeCount
    const wideBias = cols >= rows ? 0 : 0.35
    const score = emptyCells * 4 + Math.abs(cols - rows) + wideBias
    if (score < bestScore) {
      best = { cols, rows }
      bestScore = score
    }
  }

  return best ?? {
    cols: Math.min(MAX_TERMINAL_GRID_COLS, safeCount),
    rows: Math.min(MAX_TERMINAL_GRID_ROWS, Math.ceil(safeCount / MAX_TERMINAL_GRID_COLS)),
  }
}

export function expandPaneIdsIntoGrid(existingPaneIds: string[], newPaneIds: string[], occupied: GridSize, target: GridSize): string[] {
  const gridPaneIds: string[] = []
  let newIndex = 0

  for (let row = 0; row < target.rows; row += 1) {
    for (let col = 0; col < target.cols; col += 1) {
      const occupiedIndex = row < occupied.rows && col < occupied.cols ? row * occupied.cols + col : -1
      const existingPaneId = occupiedIndex >= 0 ? existingPaneIds[occupiedIndex] : undefined
      if (existingPaneId) {
        gridPaneIds.push(existingPaneId)
      } else {
        const newPaneId = newPaneIds[newIndex]
        if (newPaneId) gridPaneIds.push(newPaneId)
        newIndex += 1
      }
    }
  }

  return gridPaneIds
}

export function expandGridRowsForPaneCount(preferred: GridSize, paneCount: number): GridSize {
  const cols = clampTerminalGridCols(preferred.cols)
  const preferredRows = clampTerminalGridRows(preferred.rows)
  const safeCount = Math.max(0, Math.floor(Number.isFinite(paneCount) ? paneCount : 0))
  const requiredRows = safeCount <= 0 ? 1 : Math.ceil(safeCount / cols)
  return {
    cols,
    rows: clampTerminalGridRows(Math.max(preferredRows, requiredRows)),
  }
}

export function clampTerminalGridCols(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(MAX_TERMINAL_GRID_COLS, Math.floor(value)))
}

export function clampTerminalGridRows(value: number): number {
  if (!Number.isFinite(value)) return 1
  return Math.max(1, Math.min(MAX_TERMINAL_GRID_ROWS, Math.floor(value)))
}

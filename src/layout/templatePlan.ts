export type GridSize = {
  cols: number
  rows: number
}

export type TemplateReconcilePlan = {
  gridPaneIds: string[]
  overflowPaneIds: string[]
  missingPaneCount: number
}

export function planTemplateReconcile(existingPaneIds: string[], targetPaneCount: number): TemplateReconcilePlan {
  const safeTarget = Math.max(0, targetPaneCount)
  const gridPaneIds = existingPaneIds.slice(0, safeTarget)
  const overflowPaneIds = existingPaneIds.slice(safeTarget)
  return {
    gridPaneIds,
    overflowPaneIds,
    missingPaneCount: Math.max(0, safeTarget - existingPaneIds.length),
  }
}

export function balancedGridForPaneCount(paneCount: number, aspectRatio = 1): GridSize {
  const safePaneCount = Math.max(0, Math.floor(paneCount))
  if (safePaneCount === 0) return { cols: 0, rows: 0 }
  const safeAspectRatio = Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : 1
  let best: { grid: GridSize; score: number } | null = null
  for (let cols = 1; cols <= safePaneCount; cols += 1) {
    const rows = Math.ceil(safePaneCount / cols)
    const emptyCells = cols * rows - safePaneCount
    const gridRatio = cols / rows
    const squareness = Math.abs(cols - rows) / safePaneCount
    const score = emptyCells * 0.1 + Math.abs(gridRatio - safeAspectRatio) + squareness * 0.01
    if (!best || score < best.score) best = { grid: { cols, rows }, score }
  }
  return best?.grid ?? { cols: safePaneCount, rows: 1 }
}

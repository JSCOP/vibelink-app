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

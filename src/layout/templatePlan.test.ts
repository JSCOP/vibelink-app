import { describe, expect, it } from 'vitest'
import { planTemplateReconcile } from './templatePlan'

describe('planTemplateReconcile', () => {
  it('keeps existing panes first and only reports missing panes', () => {
    const plan = planTemplateReconcile(['a', 'b', 'c'], 6)

    expect(plan.gridPaneIds).toEqual(['a', 'b', 'c'])
    expect(plan.overflowPaneIds).toEqual([])
    expect(plan.missingPaneCount).toBe(3)
  })

  it('keeps extra existing panes as overflow instead of closing them', () => {
    const plan = planTemplateReconcile(['a', 'b', 'c', 'd'], 2)

    expect(plan.gridPaneIds).toEqual(['a', 'b'])
    expect(plan.overflowPaneIds).toEqual(['c', 'd'])
    expect(plan.missingPaneCount).toBe(0)
  })
})

import { describe, expect, test } from 'vitest'
import { SIDEBAR_REVEAL_DELAY_MS, shouldCancelSidebarReveal } from './sidebarRevealPolicy'

describe('SidebarRevealEdge', () => {
  test('keeps the delayed reveal pending when the pointer exits the app at the physical left edge', () => {
    const outsideWindow = {} as EventTarget
    const isAppTarget = (target: EventTarget) => target !== outsideWindow

    expect(shouldCancelSidebarReveal(null, isAppTarget)).toBe(false)
    expect(shouldCancelSidebarReveal(outsideWindow, isAppTarget)).toBe(false)
  })

  test('cancels the delayed reveal when the pointer returns to the app surface', () => {
    const appSurface = {} as EventTarget
    expect(shouldCancelSidebarReveal(appSurface, (target) => target === appSurface)).toBe(true)
  })

  test('retains a deliberate hover delay', () => {
    expect(SIDEBAR_REVEAL_DELAY_MS).toBe(180)
  })
})

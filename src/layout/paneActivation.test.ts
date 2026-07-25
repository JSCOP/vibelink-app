import { describe, expect, it } from 'vitest'
import { paneIdFromEventTarget } from './paneActivation'

describe('pane activation helpers', () => {
  it('finds the nearest pane id from the terminal body', () => {
    const target = {
      closest: (selector: string) => selector === '.terminal-panel-shell[data-pane-id]' ? { dataset: { paneId: 'pane-b' } } : null,
    } as unknown as EventTarget

    expect(paneIdFromEventTarget(target)).toBe('pane-b')
  })

  it('does not claim a pane title bar that Dockview owns for activation and drag', () => {
    const titleTarget = {
      closest: (selector: string) => selector === '[data-pane-id]' ? { dataset: { paneId: 'pane-b' } } : null,
    } as unknown as EventTarget

    expect(paneIdFromEventTarget(titleTarget)).toBeNull()
  })

  it('ignores targets without element traversal', () => {
    expect(paneIdFromEventTarget({} as unknown as EventTarget)).toBeNull()
  })
})

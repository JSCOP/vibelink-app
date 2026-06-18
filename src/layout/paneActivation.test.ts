import { describe, expect, it } from 'vitest'
import { paneIdFromEventTarget } from './paneActivation'

describe('pane activation helpers', () => {
  it('finds the nearest pane id from nested terminal chrome', () => {
    const target = {
      closest: (selector: string) => selector === '[data-pane-id]' ? { dataset: { paneId: 'pane-b' } } : null,
    } as unknown as EventTarget

    expect(paneIdFromEventTarget(target)).toBe('pane-b')
  })

  it('ignores targets without element traversal', () => {
    expect(paneIdFromEventTarget({} as unknown as EventTarget)).toBeNull()
  })
})

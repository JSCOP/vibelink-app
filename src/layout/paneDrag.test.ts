import { describe, expect, it } from 'vitest'
import { paneDropPositionFromPoint } from './paneDrag'

const rect = { left: 100, top: 50, width: 400, height: 300 } as DOMRect

describe('pane drag helpers', () => {
  it('keeps center drops as swaps', () => {
    expect(paneDropPositionFromPoint(rect, 300, 200)).toBe('center')
  })

  it('maps edge drops to split positions', () => {
    expect(paneDropPositionFromPoint(rect, 110, 200)).toBe('left')
    expect(paneDropPositionFromPoint(rect, 490, 200)).toBe('right')
    expect(paneDropPositionFromPoint(rect, 300, 60)).toBe('top')
    expect(paneDropPositionFromPoint(rect, 300, 340)).toBe('bottom')
  })

  it('activates an edge split at the exact threshold', () => {
    expect(paneDropPositionFromPoint(rect, rect.left + rect.width * 0.28, 200)).toBe('left')
  })

  it('chooses the closest edge near corners', () => {
    expect(paneDropPositionFromPoint(rect, 102, 100)).toBe('left')
    expect(paneDropPositionFromPoint(rect, 160, 52)).toBe('top')
  })
})

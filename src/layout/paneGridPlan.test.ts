import { describe, expect, it } from 'vitest'
import { expandGridRowsForPaneCount, expandPaneIdsIntoGrid, occupiedGridForPaneCount } from './paneGridPlan'

describe('pane grid planning', () => {
  it('preserves a 3x3 occupied block when expanding to 4x4', () => {
    const existing = Array.from({ length: 9 }, (_, index) => `old-${index + 1}`)
    const added = Array.from({ length: 7 }, (_, index) => `new-${index + 1}`)

    expect(expandPaneIdsIntoGrid(existing, added, { cols: 3, rows: 3 }, { cols: 4, rows: 4 })).toEqual([
      'old-1', 'old-2', 'old-3', 'new-1',
      'old-4', 'old-5', 'old-6', 'new-2',
      'old-7', 'old-8', 'old-9', 'new-3',
      'new-4', 'new-5', 'new-6', 'new-7',
    ])
  })

  it('chooses compact occupied dimensions for current panes', () => {
    expect(occupiedGridForPaneCount(9)).toEqual({ cols: 3, rows: 3 })
  })

  it('uses preferred columns without stretching existing panes into future rows', () => {
    expect(occupiedGridForPaneCount(12, { cols: 6, rows: 4 })).toEqual({ cols: 6, rows: 2 })
  })

  it('keeps a 6x2 occupied block when expanding to 6x4', () => {
    const existing = Array.from({ length: 12 }, (_, index) => `old-${index + 1}`)
    const added = Array.from({ length: 12 }, (_, index) => `new-${index + 1}`)

    expect(expandPaneIdsIntoGrid(existing, added, { cols: 6, rows: 2 }, { cols: 6, rows: 4 })).toEqual([
      'old-1', 'old-2', 'old-3', 'old-4', 'old-5', 'old-6',
      'old-7', 'old-8', 'old-9', 'old-10', 'old-11', 'old-12',
      'new-1', 'new-2', 'new-3', 'new-4', 'new-5', 'new-6',
      'new-7', 'new-8', 'new-9', 'new-10', 'new-11', 'new-12',
    ])
  })

  it('keeps preferred columns and adds rows for extra panes', () => {
    expect(expandGridRowsForPaneCount({ cols: 4, rows: 3 }, 13)).toEqual({ cols: 4, rows: 4 })
    expect(expandGridRowsForPaneCount({ cols: 4, rows: 3 }, 8)).toEqual({ cols: 4, rows: 3 })
  })
})

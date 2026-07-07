import { describe, expect, it } from 'vitest'
import { defaultTerminalGridSelection, displayGridSize, occupancyFromDockLayout, occupiedGridForPaneCount, selectedNewPaneCount, terminalGridCellState, terminalGridSelectionFromCell } from './newTerminalGrid'

describe('new terminal occupancy grid', () => {
  it('defaults empty workspaces to a selectable 2x2 creation range', () => {
    expect(occupiedGridForPaneCount(0)).toEqual({ cols: 0, rows: 0 })
    expect(defaultTerminalGridSelection(0)).toEqual({ cols: 2, rows: 2 })
    expect(selectedNewPaneCount(0, { cols: 2, rows: 2 })).toBe(4)
  })

  it('ignores stale preferred grids when the workspace has no panes', () => {
    expect(occupiedGridForPaneCount(0, { cols: 6, rows: 4 })).toEqual({ cols: 0, rows: 0 })
    expect(defaultTerminalGridSelection(0, { cols: 6, rows: 4 })).toEqual({ cols: 2, rows: 2 })
  })

  it('normalizes a stale preferred grid after right-edge panes are deleted', () => {
    const occupied = occupiedGridForPaneCount(8, { cols: 5, rows: 2 })
    const selection = defaultTerminalGridSelection(8, { cols: 5, rows: 2 })

    expect(occupied).toEqual({ cols: 4, rows: 2 })
    expect(selection).toEqual({ cols: 4, rows: 2 })
    expect(selectedNewPaneCount(8, selection)).toBe(0)
    expect(terminalGridCellState(8, occupied, selection, 3, 1)).toBe('occupied')
    expect(terminalGridCellState(8, occupied, selection, 4, 0)).toBe('available')
  })

  it('keeps the preferred width while a pane remains in the rightmost column', () => {
    const occupied = occupiedGridForPaneCount(9, { cols: 5, rows: 2 })
    const selection = defaultTerminalGridSelection(9, { cols: 5, rows: 2 })

    expect(occupied).toEqual({ cols: 5, rows: 2 })
    expect(selection).toEqual({ cols: 5, rows: 2 })
    expect(selectedNewPaneCount(9, selection)).toBe(1)
    expect(terminalGridCellState(9, occupied, selection, 4, 0)).toBe('occupied')
    expect(terminalGridCellState(9, occupied, selection, 4, 1)).toBe('selected')
  })

  it('marks existing panes occupied and new target cells selected', () => {
    const occupied = occupiedGridForPaneCount(4)
    const selection = terminalGridSelectionFromCell(occupied, 1, 2)

    expect(occupied).toEqual({ cols: 2, rows: 2 })
    expect(selection).toEqual({ cols: 2, rows: 3 })
    expect(selectedNewPaneCount(4, selection)).toBe(2)
    expect(terminalGridCellState(4, occupied, selection, 0, 0)).toBe('occupied')
    expect(terminalGridCellState(4, occupied, selection, 1, 2)).toBe('selected')
    expect(terminalGridCellState(4, occupied, selection, 2, 2)).toBe('available')
  })

  it('preserves a committed grid as the occupied shape', () => {
    const occupied = occupiedGridForPaneCount(12, { cols: 6, rows: 2 })
    const selection = terminalGridSelectionFromCell(occupied, 5, 2)

    expect(occupied).toEqual({ cols: 6, rows: 2 })
    expect(defaultTerminalGridSelection(12, { cols: 6, rows: 2 })).toEqual({ cols: 6, rows: 2 })
    expect(selection).toEqual({ cols: 6, rows: 3 })
    expect(selectedNewPaneCount(12, selection)).toBe(6)
    expect(terminalGridCellState(12, occupied, { cols: 6, rows: 2 }, 5, 1)).toBe('occupied')
    expect(terminalGridCellState(12, occupied, { cols: 6, rows: 2 }, 0, 2)).toBe('available')
  })

  it('derives sparse occupancy from a serialized Dockview layout', () => {
    const layout = {
      grid: {
        width: 400,
        height: 200,
        orientation: 'HORIZONTAL',
        root: {
          type: 'branch' as const,
          size: 400,
          data: [
            dockColumn('left-0-top', 'left-0-bottom'),
            dockColumn('left-1-top'),
            dockColumn('left-2-top', 'left-2-bottom'),
            dockColumn('right-top', 'right-bottom'),
          ],
        },
      },
    }

    const occupancy = occupancyFromDockLayout(layout)

    expect(occupancy).not.toBeNull()
    expect(occupancy?.rows).toBe(2)
    expect(occupancy?.cols).toBeGreaterThanOrEqual(4)
    expect(occupancy?.cells[0]?.slice(0, 4)).toEqual([true, true, true, true])
    expect(occupancy?.cells[1]?.slice(0, 4)).toEqual([true, false, true, true])
  })

  it('returns null for malformed Dockview layout input', () => {
    expect(occupancyFromDockLayout({ grid: { width: 400, height: 200 } })).toBeNull()
  })

  it('always displays the full 20x10 pick area', () => {
    expect(displayGridSize()).toEqual({ cols: 20, rows: 10 })
  })
})

function dockLeaf(id: string) {
  return {
    type: 'leaf' as const,
    size: 100,
    data: { views: [id], activeView: id, id: `group-${id}` },
  }
}

function dockColumn(...paneIds: string[]) {
  return {
    type: 'branch' as const,
    size: 100,
    data: paneIds.map((paneId) => dockLeaf(paneId)),
  }
}

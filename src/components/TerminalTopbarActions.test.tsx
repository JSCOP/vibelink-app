import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import { TerminalTopbarActions } from './TerminalTopbarActions'
import type { WorkspaceWindowActions } from '../layout/windowActions'
import { defaultTerminalGridSelection, terminalAlignGridForNewPaneBasis } from './newTerminalGrid'

const actions: WorkspaceWindowActions = {
  activateWindow: vi.fn(),
  splitTerminal: vi.fn(),
  closeWindow: vi.fn(),
  toggleMaximize: vi.fn(),
  renameTerminalTitle: vi.fn(),
  swapWindowLocations: vi.fn(),
  moveWindowToPosition: vi.fn(),
  clearTerminals: vi.fn(),
  arrangeTerminals: vi.fn(),
  launchTerminalGrid: vi.fn(),
  getTerminalLayoutSnapshot: vi.fn(() => null),
}

function renderTopbarActions(providedActions: WorkspaceWindowActions | null = actions) {
  return renderToString(<TerminalTopbarActions actions={providedActions} />)
}

describe('TerminalTopbarActions', () => {
  it('renders the terminal toolbar when actions are provided', () => {
    const html = renderTopbarActions()

    expect(html).toContain('Profile')
    expect(html).toContain('New')
  })

  it('renders nothing when actions are null', () => {
    expect(renderTopbarActions(null)).toBe('')
  })
})

describe('terminalAlignGridForNewPaneBasis', () => {
  it('matches the New pane grid basis for populated workspaces', () => {
    const cases = [
      { name: 'committed 3x2 grid with six panes', paneCount: 6, preferredGrid: { cols: 3, rows: 2 }, expected: { cols: 3, rows: 2 } },
      { name: 'stale 5x2 grid after right-edge panes are deleted', paneCount: 8, preferredGrid: { cols: 5, rows: 2 }, expected: { cols: 4, rows: 2 } },
    ]

    for (const { paneCount, preferredGrid, expected } of cases) {
      expect(terminalAlignGridForNewPaneBasis(paneCount, preferredGrid)).toEqual(expected)
      expect(terminalAlignGridForNewPaneBasis(paneCount, preferredGrid)).toEqual(
        defaultTerminalGridSelection(paneCount, preferredGrid),
      )
    }
  })

  it('has no meaningful alignment grid for an empty workspace', () => {
    expect(terminalAlignGridForNewPaneBasis(0, { cols: 6, rows: 4 })).toBeNull()
  })
})

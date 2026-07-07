import { describe, expect, it, vi } from 'vitest'
import { renderToString } from 'react-dom/server'
import type { IDockviewHeaderActionsProps } from 'dockview-react'
import { WorkspaceWindowHeaderActions } from './WorkspaceWindowHeaderActions'
import { WorkspaceWindowActionsContext, type WorkspaceWindowActions } from '../layout/windowActions'
import { workspaceWindowDescriptors } from '../layout/workspaceLayoutModel'
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

function renderHeaderActions(activePanelId: string) {
  const props = {
    activePanel: { id: activePanelId },
    panels: [],
    isGroupActive: true,
    headerPosition: 'top',
  } as unknown as IDockviewHeaderActionsProps
  return renderToString(
    <WorkspaceWindowActionsContext.Provider value={actions}>
      <WorkspaceWindowHeaderActions {...props} />
    </WorkspaceWindowActionsContext.Provider>,
  )
}

describe('WorkspaceWindowHeaderActions', () => {
  it('renders terminal launcher controls for the terminal window', () => {
    const html = renderHeaderActions(workspaceWindowDescriptors.terminal.panelId)

    expect(html).toContain('Profile')
    expect(html).toContain('New')
  })

  it('does not render terminal launcher controls for other windows', () => {
    const html = renderHeaderActions(workspaceWindowDescriptors.agent.panelId)

    expect(html).not.toContain('New')
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

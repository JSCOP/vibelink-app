import type { DockviewApi } from 'dockview-react'
import { describe, expect, it } from 'vitest'
import { activeTerminalPaneId, paneIdFromEventTarget } from './paneActivation'

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

  it('keeps the active pane when a terminal window is selected', () => {
    const api = {
      activePanel: {
        params: { schema: 1, kind: 'terminal', instanceId: 'pane-b', paneId: 'pane-b', title: 'B', icon: 'terminal' },
      },
    } as unknown as DockviewApi

    expect(activeTerminalPaneId(api, ['pane-a', 'pane-b'])).toBe('pane-b')
    expect(activeTerminalPaneId({ activePanel: null } as unknown as DockviewApi, ['pane-a', 'pane-b'])).toBe('pane-a')
  })

  it('ignores targets without element traversal', () => {
    expect(paneIdFromEventTarget({} as unknown as EventTarget)).toBeNull()
  })
})

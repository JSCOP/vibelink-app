import { describe, expect, it, vi } from 'vitest'
import { shouldRevealTabForDrag, workspaceAgentTabStatus } from './workspaceContentTabModel'
import { buildWorkspaceContentTabContextMenu } from '../layout/workspaceContentTabMenu'
import { createSingletonContentParams, createTerminalContentParams } from '../layout/workspaceLayoutModel'
import type { WorkspaceContentActions } from '../layout/contentActions'

const actions = {
  openContent: vi.fn(async () => ''),
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameTerminal: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
} satisfies WorkspaceContentActions

describe('WorkspaceContentTab rail state', () => {
  it('maps authoritative Hermes state with pending permission precedence', () => {
    expect(workspaceAgentTabStatus('busy', 1)).toEqual({ label: 'Waiting for input', tone: 'waiting', pulsing: false })
    expect(workspaceAgentTabStatus('starting', 0)).toEqual({ label: 'Working', tone: 'working', pulsing: true })
    expect(workspaceAgentTabStatus('busy', 0)).toEqual({ label: 'Working', tone: 'working', pulsing: true })
    expect(workspaceAgentTabStatus('running', 0)).toEqual({ label: 'Idle', tone: 'idle', pulsing: false })
    expect(workspaceAgentTabStatus('error', 0)).toEqual({ label: 'Error', tone: 'error', pulsing: false })
    expect(workspaceAgentTabStatus('idle', 0)).toEqual({ label: 'Stopped', tone: 'stopped', pulsing: false })
  })

  it('omits close, maximize, float, popout, and creation actions for structural tabs', () => {
    const params = createSingletonContentParams('sourceControl')
    const items = buildWorkspaceContentTabContextMenu({
      panel: { id: 'content:sourceControl:sourceControl', params },
      group: { id: 'workspace-left-tools' },
    } as never, actions)

    expect(items).toEqual([])
  })

  it('keeps central terminal actions targeted at the owning grid group', () => {
    const params = createTerminalContentParams({ id: 'pane-a', config: { paneId: 'pane-a', args: [], env: [], title: 'Shell', icon: 'terminal', cols: 80, rows: 24 } })
    const items = buildWorkspaceContentTabContextMenu({
      panel: { id: 'content:terminal:pane-a', params },
      group: { id: 'grid-main' },
    } as never, actions)

    items[0]?.action?.()
    expect(actions.openContent).toHaveBeenCalledWith({ kind: 'terminal', targetGroupId: 'grid-main' })
    expect(items.map((item) => item.label)).toEqual([
      'New terminal in this group',
      'Split terminal right',
      'Split terminal below',
      'Arrange Terminals',
      'Maximize / restore content',
      'Close terminal',
    ])
  })

  it('reveals a hovered tab only for a same-instance drag onto a different inactive tab', () => {
    const tab = { viewId: 'dock-1', panelId: 'content:terminalWindow:b', isActive: false }
    // Live drag of another window in this instance → reveal.
    expect(shouldRevealTabForDrag({ viewId: 'dock-1', panelId: 'content:terminalWindow:a' }, tab)).toBe(true)
    // No active drag → nothing to reveal.
    expect(shouldRevealTabForDrag(undefined, tab)).toBe(false)
    // The dragged tab itself must not re-activate.
    expect(shouldRevealTabForDrag({ viewId: 'dock-1', panelId: 'content:terminalWindow:b' }, tab)).toBe(false)
    // A drag from a different Dockview instance (e.g. an inner pane grid) is ignored.
    expect(shouldRevealTabForDrag({ viewId: 'dock-2', panelId: 'content:terminalWindow:a' }, tab)).toBe(false)
    // An already-active tab needs no reveal.
    expect(shouldRevealTabForDrag({ viewId: 'dock-1', panelId: 'content:terminalWindow:a' }, { ...tab, isActive: true })).toBe(false)
  })
})

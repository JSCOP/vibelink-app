// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceContentActions } from '../layout/contentActions'
import { defaultSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { WorkspaceAddMenu } from './WorkspaceAddMenu'
import { workspaceAddMenuPlacement } from './workspaceContentTabModel'

const openContent = vi.fn(async () => '')
const actions: WorkspaceContentActions = {
  openContent,
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleZoomContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameContent: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

const profiles = defaultSettings.profiles.filter((profile) => profile.id === 'powershell' || profile.id === 'codex')

beforeEach(() => {
  openContent.mockClear()
  useWorkspaceStore.setState({
    settings: { ...defaultSettings, profiles, defaultProfileId: 'powershell' },
    agentClis: [{ id: 'codex', displayName: 'Codex', installed: false, auth: 'unknown', loginHint: 'Install Codex' }],
  })
})

afterEach(() => {
  cleanup()
  useWorkspaceStore.setState({ settings: defaultSettings, agentClis: [] })
})

describe('WorkspaceAddMenu', () => {
  it('filters commands and opens the selected profile in a new terminal window', () => {
    render(
      <WorkspaceAddMenu
        actions={actions}
        targetGroupId="grid-main"
        overlayId="group-menu:grid-main"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add terminal or window' }))
    const filter = screen.getByPlaceholderText('Open a file, URL, or agent…')
    const powershell = screen.getByRole('button', { name: 'New Terminal: PowerShell' })
    const browser = screen.getByRole('button', { name: 'Browser' })
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    expect(browser.getAttribute('data-active')).toBe('true')
    fireEvent.keyDown(filter, { key: 'ArrowUp' })
    expect(powershell.getAttribute('data-active')).toBe('true')

    fireEvent.change(filter, { target: { value: 'power' } })
    expect(screen.queryByRole('button', { name: 'Browser' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'New Terminal: Codex' })).toBeNull()

    fireEvent.keyDown(filter, { key: 'Enter' })
    expect(openContent).toHaveBeenCalledWith({ kind: 'terminal', targetGroupId: 'grid-main', profileId: 'powershell', newWindow: true })
    expect(screen.queryByRole('dialog', { name: 'Add terminal or window' })).toBeNull()
  })

  it('disables missing agent profiles with the launcher install hint', () => {
    render(
      <WorkspaceAddMenu
        actions={actions}
        targetGroupId="grid-main"
        overlayId="group-menu:grid-main"
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add terminal or window' }))
    const codex = screen.getByRole('button', { name: 'New Terminal: Codex' })
    expect(codex.hasAttribute('disabled')).toBe(true)
    expect(codex.getAttribute('title')).toBe('Install Codex or pick another profile')
  })

  it('opens rightward from the trigger and only slides left when the right edge runs out', () => {
    // Left rail collapsed: the `+` sits near the left edge and the palette used
    // to be right-aligned to it, i.e. drawn off-screen.
    expect(workspaceAddMenuPlacement(40, 1400)).toEqual({ left: 40, width: 380 })
    // No room on the right: clamp back instead of overflowing.
    expect(workspaceAddMenuPlacement(1200, 1400)).toEqual({ left: 1012, width: 380 })
    // Never off-screen left, even in a viewport narrower than the palette.
    expect(workspaceAddMenuPlacement(4, 300)).toEqual({ left: 8, width: 284 })
  })
})

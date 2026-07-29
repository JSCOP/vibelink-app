// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus } from '../../ipc/appUpdate'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  checkAppUpdate: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../ipc/appUpdate', () => ({ checkAppUpdate: mocks.checkAppUpdate }))

import { WorkspaceSidebarToolbar } from './WorkspaceSidebarToolbar'
import { useAppChromeStore } from '../../state/appChrome'

const current: AppUpdateStatus = {
  currentVersion: '0.4.13',
  latestVersion: '0.4.13',
  updateAvailable: false,
  releaseNotesUrl: 'https://vibelink.moobang.net/releases',
  installUrl: 'https://vibelink.moobang.net/api/download/windows-exe',
}

describe('WorkspaceSidebarToolbar', () => {
  beforeEach(() => {
    mocks.invoke.mockReset()
    mocks.checkAppUpdate.mockReset().mockResolvedValue(current)
    useAppChromeStore.setState({ settingsSection: null, bugReportOpen: false })
  })

  afterEach(cleanup)

  it('opens settings on its default section from the gear button', () => {
    render(<WorkspaceSidebarToolbar />)

    fireEvent.click(screen.getByRole('button', { name: 'Open settings' }))

    expect(useAppChromeStore.getState().settingsSection).toBe('account')
  })

  it('deep-links the help menu to the shortcut and About sections', () => {
    render(<WorkspaceSidebarToolbar />)
    const help = screen.getByRole('button', { name: 'Help and resources' })

    fireEvent.click(help)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keyboard shortcuts' }))
    expect(useAppChromeStore.getState().settingsSection).toBe('advanced')
    // Choosing an item closes the menu so the sidebar is usable again.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()

    fireEvent.click(help)
    fireEvent.click(screen.getByRole('menuitem', { name: 'About VibeLink' }))
    expect(useAppChromeStore.getState().settingsSection).toBe('about')
  })

  it('routes bug reports and external resources to their owning surfaces', () => {
    render(<WorkspaceSidebarToolbar />)
    const help = screen.getByRole('button', { name: 'Help and resources' })

    fireEvent.click(help)
    fireEvent.click(screen.getByRole('menuitem', { name: 'Report a bug' }))
    expect(useAppChromeStore.getState().bugReportOpen).toBe(true)

    fireEvent.click(help)
    fireEvent.click(screen.getByRole('menuitem', { name: /Releases & changelog/ }))
    expect(mocks.invoke).toHaveBeenCalledWith('open_path', { path: 'https://vibelink.moobang.net/releases' })
  })

  it('reports the result of an on-demand update check', async () => {
    render(<WorkspaceSidebarToolbar />)

    fireEvent.click(screen.getByRole('button', { name: 'Help and resources' }))
    fireEvent.click(screen.getByRole('menuitem', { name: /Check for updates/ }))

    await waitFor(() => expect(screen.getByText('Up to date')).toBeInTheDocument())
    expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1)
  })

  it('dismisses the help menu with Escape', () => {
    render(<WorkspaceSidebarToolbar />)

    fireEvent.click(screen.getByRole('button', { name: 'Help and resources' }))
    expect(screen.getByRole('menu')).toBeInTheDocument()

    fireEvent.keyDown(window, { key: 'Escape' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppUpdateStatus } from '../../ipc/appUpdate'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  checkAppUpdate: vi.fn(),
  store: { settings: { sessionRestore: 'resume' as 'resume' | 'clean' } },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../../ipc/appUpdate', () => ({ checkAppUpdate: mocks.checkAppUpdate }))
vi.mock('../../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
}))

import { UpdateCard } from './UpdateCard'
import { setAppUpdateStatus, startAppUpdateChecks } from './updateStore'

const available: AppUpdateStatus = {
  currentVersion: '0.4.13',
  latestVersion: '0.5.0',
  updateAvailable: true,
  releaseNotesUrl: 'https://vibelink.moobang.net/releases',
  installUrl: 'https://vibelink.moobang.net/api/download/windows-exe',
}

describe('UpdateCard', () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined)
    mocks.checkAppUpdate.mockReset()
    mocks.store.settings.sessionRestore = 'resume'
    window.localStorage.clear()
    setAppUpdateStatus(null)
  })

  afterEach(cleanup)

  it('stays hidden while the installed build is current', () => {
    render(<UpdateCard />)
    act(() => setAppUpdateStatus({ ...available, latestVersion: '0.4.13', updateAvailable: false }))

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
  })

  it('announces the published version and opens the release notes and installer', () => {
    render(<UpdateCard />)
    act(() => setAppUpdateStatus(available))

    expect(screen.getByRole('heading', { name: 'Update available' })).toBeInTheDocument()
    expect(screen.getByText('VibeLink v0.5.0 is ready.')).toBeInTheDocument()
    expect(screen.getByText('Your terminal sessions keep running while you install.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))
    expect(mocks.invoke).toHaveBeenCalledWith('open_path', { path: available.releaseNotesUrl })

    fireEvent.click(screen.getByRole('button', { name: 'Update' }))
    expect(mocks.invoke).toHaveBeenCalledWith('open_path', { path: available.installUrl })
    expect(screen.getByRole('heading', { name: 'Update downloading' })).toBeInTheDocument()
    expect(screen.getByText('Run the downloaded VibeLink v0.5.0 installer to finish updating.')).toBeInTheDocument()
  })

  it('warns instead of promising session survival when Start fresh is selected', () => {
    mocks.store.settings.sessionRestore = 'clean'
    render(<UpdateCard />)
    act(() => setAppUpdateStatus(available))

    expect(screen.getByText('Start fresh is on, so quitting to install stops running terminals.')).toBeInTheDocument()
  })

  it('keeps a dismissed version hidden but shows the next one', () => {
    render(<UpdateCard />)
    act(() => setAppUpdateStatus(available))

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss update' }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()

    act(() => setAppUpdateStatus({ ...available }))
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()

    act(() => setAppUpdateStatus({ ...available, latestVersion: '0.5.1' }))
    expect(screen.getByText('VibeLink v0.5.1 is ready.')).toBeInTheDocument()
  })
})

describe('startAppUpdateChecks', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.checkAppUpdate.mockReset()
    window.localStorage.clear()
    setAppUpdateStatus(null)
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('polls after startup settles and repeats on the long interval', async () => {
    mocks.checkAppUpdate.mockResolvedValue(available)
    const stop = startAppUpdateChecks()

    expect(mocks.checkAppUpdate).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000) })
    expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(2)

    stop()
    await act(async () => { await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1_000) })
    expect(mocks.checkAppUpdate).toHaveBeenCalledTimes(2)
  })

  it('never surfaces anything when the update service is unreachable', async () => {
    mocks.checkAppUpdate.mockRejectedValue(new Error('Update service is unreachable.'))
    const stop = startAppUpdateChecks()
    render(<UpdateCard />)

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })

    expect(screen.queryByRole('complementary')).not.toBeInTheDocument()
    stop()
  })
})

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { StrictMode } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { ToastHost } from './ToastHost'
import { useDaemonReplacementNotice } from './daemonReplacementNotice'
import { clearToasts } from './toastStore'

function NoticeHarness() {
  useDaemonReplacementNotice()
  return <ToastHost />
}


describe('daemon replacement notice', () => {
  afterEach(() => {
    cleanup()
    clearToasts()
    invoke.mockReset()
  })

  it('takes the startup replacement once, shows the pane count, and dismisses the notice', async () => {
    invoke.mockResolvedValue({ fromVersion: '0.5.23', toVersion: '0.5.24', terminatedPanes: 3 })
    render(<StrictMode><NoticeHarness /></StrictMode>)

    await waitFor(() => expect(screen.getByText('The update replaced the background service (0.5.23 → 0.5.24). Commands running in 3 terminal panes were stopped.')).toBeInTheDocument())
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke).toHaveBeenCalledWith('take_daemon_replacement')

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('describes an older unversioned service without a broken range', async () => {
    invoke.mockResolvedValue({ fromVersion: null, toVersion: '0.5.24', terminatedPanes: 1 })
    render(<StrictMode><NoticeHarness /></StrictMode>)

    await waitFor(() => expect(screen.getByText('The update replaced a background service that predated this build. A command running in 1 terminal pane was stopped.')).toBeInTheDocument())
    expect(screen.queryByText(/null|→/)).not.toBeInTheDocument()
  })

  it('shows nothing on a normal start', async () => {
    invoke.mockResolvedValue(null)
    render(<StrictMode><NoticeHarness /></StrictMode>)

    await waitFor(() => expect(invoke).toHaveBeenCalledOnce())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})

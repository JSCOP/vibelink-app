// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus } from '../ipc/types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  pollAccountSignIn: vi.fn(),
  setState: vi.fn(),
  startAccountSignIn: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../ipc/account', () => ({
  pollAccountSignIn: mocks.pollAccountSignIn,
  startAccountSignIn: mocks.startAccountSignIn,
}))
vi.mock('../state/store', () => ({ useWorkspaceStore: { setState: mocks.setState } }))

import { AccountSignIn } from './AccountSignIn'

const signedInStatus: AccountStatus = { signedIn: true, email: 'account@example.com' }

describe('AccountSignIn', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.invoke.mockReset().mockResolvedValue(undefined)
    mocks.pollAccountSignIn.mockReset()
    mocks.setState.mockReset()
    mocks.startAccountSignIn.mockReset().mockResolvedValue({
      userCode: 'ABCD-EFGH',
      verificationUriComplete: 'https://vibelink.moobang.net/device?user_code=ABCD-EFGH',
      deviceCode: 'device-code',
      interval: 1,
    })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('opens the browser and completes sign-in when signedIn is true', async () => {
    const onActivated = vi.fn()
    mocks.pollAccountSignIn.mockResolvedValueOnce('pending').mockResolvedValueOnce(signedInStatus)
    render(<AccountSignIn onActivated={onActivated} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with Moobang account' }))
    })

    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('open_path', {
      path: 'https://vibelink.moobang.net/device?user_code=ABCD-EFGH',
    })

    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })
    expect(screen.getByText('Waiting for approval…')).toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })
    expect(mocks.setState).toHaveBeenCalledWith({ account: { ready: true, status: signedInStatus } })
    expect(screen.getByText('Moobang account connected.')).toBeInTheDocument()
    expect(onActivated).toHaveBeenCalledOnce()
  })

  it('does not report success when signedIn is false', async () => {
    const onActivated = vi.fn()
    const signedOutStatus: AccountStatus = { signedIn: false, email: null }
    mocks.pollAccountSignIn.mockResolvedValue(signedOutStatus)
    render(<AccountSignIn onActivated={onActivated} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with Moobang account' }))
    })
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })

    expect(mocks.setState).toHaveBeenCalledWith({ account: { ready: true, status: signedOutStatus } })
    expect(screen.getByText('Could not finish signing in to this Moobang account.')).toBeInTheDocument()
    expect(onActivated).not.toHaveBeenCalled()
  })
})

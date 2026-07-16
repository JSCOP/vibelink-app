// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LicenseStatus } from '../ipc/types'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  pollAccountSignIn: vi.fn(),
  setState: vi.fn(),
  startAccountSignIn: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../ipc/license', () => ({
  pollAccountSignIn: mocks.pollAccountSignIn,
  startAccountSignIn: mocks.startAccountSignIn,
}))
vi.mock('../state/store', () => ({ useWorkspaceStore: { setState: mocks.setState } }))

import { AccountSignIn } from './AccountSignIn'

const proStatus: LicenseStatus = {
  state: 'validOnline',
  entitled: true,
  provider: 'vibelink',
  plan: 'pro',
  email: 'account@example.com',
  maskedKey: null,
  activationId: 'activation-1',
  deviceId: 'device-1',
  deviceName: 'Desktop',
  maxDevices: 3,
  devices: [],
  validatedAt: '2026-07-16T00:00:00.000Z',
  offlineGraceUntil: '2026-07-23T00:00:00.000Z',
  purchaseUrl: 'https://vibelink.moobang.net/checkout',
  message: 'VibeLink Pro is active.',
}

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

  it('opens the browser, renders the code, and applies the approved entitlement after pending polls', async () => {
    const onActivated = vi.fn()
    mocks.pollAccountSignIn.mockResolvedValueOnce('pending').mockResolvedValueOnce(proStatus)
    render(<AccountSignIn onActivated={onActivated} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with Moobang account' }))
    })

    expect(screen.getByText('ABCD-EFGH')).toBeInTheDocument()
    expect(mocks.invoke).toHaveBeenCalledWith('open_path', {
      path: 'https://vibelink.moobang.net/device?user_code=ABCD-EFGH',
    })

    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })
    expect(mocks.pollAccountSignIn).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Waiting for approval…')).toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })
    expect(mocks.pollAccountSignIn).toHaveBeenCalledTimes(2)
    expect(mocks.setState).toHaveBeenCalledWith({ license: { ready: true, status: proStatus } })
    expect(onActivated).toHaveBeenCalledOnce()
  })

  it('keeps a transport failure from masquerading as a connected Core account', async () => {
    const onActivated = vi.fn()
    const unavailableStatus: LicenseStatus = {
      ...proStatus,
      state: 'configurationError',
      entitled: false,
      provider: null,
      plan: undefined,
      email: undefined,
      activationId: null,
      validatedAt: null,
      offlineGraceUntil: null,
      message: 'Account service is unavailable.',
    }
    mocks.pollAccountSignIn.mockResolvedValue(unavailableStatus)
    render(<AccountSignIn onActivated={onActivated} />)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign in with Moobang account' }))
    })
    await act(async () => { vi.advanceTimersByTime(1_000); await Promise.resolve() })

    expect(mocks.setState).toHaveBeenCalledWith({ license: { ready: true, status: unavailableStatus } })
    expect(screen.getByText('Account service is unavailable.')).toBeInTheDocument()
    expect(onActivated).not.toHaveBeenCalled()
  })
})

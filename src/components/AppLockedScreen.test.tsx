// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LicenseStatus } from '../ipc/types'

const mocks = vi.hoisted(() => {
  const revalidateLicense = vi.fn()
  const signOutAccount = vi.fn()
  return {
    invoke: vi.fn(),
    revalidateLicense,
    signOutAccount,
    store: {
      license: { ready: true, status: null as LicenseStatus | null },
      revalidateLicense,
      signOutAccount,
    },
  }
})

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.store) => unknown) => selector(mocks.store),
}))

import { AppLockedScreen } from './AppLockedScreen'

const trialExpiredStatus: LicenseStatus = {
  state: 'trialExpired',
  entitled: false,
  provider: 'vibelink',
  plan: 'none',
  email: 'buyer@example.com',
  maskedKey: null,
  activationId: null,
  deviceId: 'device-1',
  deviceName: 'Desktop',
  maxDevices: 3,
  devices: [],
  validatedAt: '2026-07-19T00:00:00.000Z',
  offlineGraceUntil: null,
  trialEndsAt: '2026-07-18T00:00:00.000Z',
  purchaseUrl: 'https://vibelink.moobang.net/checkout',
  message: 'Your VibeLink trial has ended.',
}

describe('AppLockedScreen', () => {
  beforeEach(() => {
    mocks.invoke.mockReset().mockResolvedValue(undefined)
    mocks.revalidateLicense.mockReset().mockResolvedValue(undefined)
    mocks.signOutAccount.mockReset().mockResolvedValue(undefined)
    mocks.store.license.status = trialExpiredStatus
  })

  afterEach(cleanup)

  it('offers purchase, account refresh, and account switching for an expired trial', async () => {
    render(<AppLockedScreen />)

    expect(screen.getByRole('heading', { name: 'Your 7-day VibeLink trial has ended' })).toBeInTheDocument()
    expect(screen.getByText('Use the same signed-in Moobang account to purchase. VibeLink will unlock within at most 70 seconds.')).toBeInTheDocument()
    expect(screen.getByText('Signed in as buyer@example.com')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Buy VibeLink' }))
    expect(mocks.invoke).toHaveBeenCalledWith('open_path', {
      path: 'https://vibelink.moobang.net/checkout',
    })

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'I already purchased — Refresh account' }))
    })
    expect(mocks.revalidateLicense).toHaveBeenCalledOnce()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out / switch account' }))
    })
    expect(mocks.signOutAccount).toHaveBeenCalledOnce()
  })

  it('uses generic entitlement copy for other locked account states', () => {
    mocks.store.license.status = {
      ...trialExpiredStatus,
      state: 'revoked',
      trialEndsAt: null,
      message: 'Account access was revoked.',
    }

    render(<AppLockedScreen />)

    expect(screen.getByRole('heading', { name: 'VibeLink is locked' })).toBeInTheDocument()
    expect(screen.getByText('VibeLink does not currently have an active account entitlement. Your workspaces stay in place while you refresh the account or switch to another Moobang account.')).toBeInTheDocument()
    expect(screen.queryByText(/trial has ended/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/70 seconds/i)).not.toBeInTheDocument()
  })
})

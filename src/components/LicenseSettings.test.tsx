// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  state: {
    license: {
      ready: true,
      status: {
        state: 'trial',
        entitled: true,
        provider: 'vibelink',
        plan: 'trial',
        email: 'trial@example.com',
        maskedKey: null,
        activationId: null,
        deviceId: 'device-1',
        deviceName: 'Desktop',
        maxDevices: 3,
        devices: [],
        validatedAt: '2026-07-18T00:00:00.000Z',
        offlineGraceUntil: '2026-07-19T01:00:00.000Z',
        trialEndsAt: '2026-07-19T01:00:00.000Z',
        purchaseUrl: 'https://vibelink.moobang.net/checkout',
        message: 'Your VibeLink trial is active.',
      },
    },
    deactivateLicenseDevice: vi.fn(),
    revalidateLicense: vi.fn(),
    signOutAccount: vi.fn(),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}))

import { LicenseSettings } from './LicenseSettings'

describe('LicenseSettings', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('updates the trial countdown from an effect-driven clock', async () => {
    render(<LicenseSettings />)

    await act(async () => { vi.advanceTimersByTime(0) })
    expect(screen.getByText(/Trial ends .*\(2 days left\)/)).toBeInTheDocument()

    await act(async () => { vi.advanceTimersByTime(2 * 60 * 60 * 1_000) })
    expect(screen.getByText(/Trial ends .*\(1 day left\)/)).toBeInTheDocument()
  })
})

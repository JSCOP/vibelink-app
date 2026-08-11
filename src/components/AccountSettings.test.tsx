// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AccountStatus } from '../ipc/types'

const mocks = vi.hoisted(() => ({
  state: {
    account: {
      ready: true,
      status: { signedIn: true, email: 'account@example.com' } as AccountStatus,
    },
    signOutAccount: vi.fn(),
  },
}))

vi.mock('../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}))

import { AccountSettings } from './AccountSettings'

describe('AccountSettings', () => {
  beforeEach(() => {
    mocks.state.account.status = { signedIn: true, email: 'account@example.com' }
  })

  afterEach(cleanup)

  it('shows only the signed-in account identity and sign-out action', () => {
    render(<AccountSettings />)

    expect(screen.getByText('account@example.com')).toBeInTheDocument()
    expect(screen.getByText('Signed in')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument()
    expect(screen.getByLabelText('VibeLink is free and open source. Sign in only to send bug reports.')).toBeInTheDocument()
    expect(screen.queryByText(/plan|trial|device|purchase|buy pro/i)).not.toBeInTheDocument()
  })

  it('offers sign-in when the account is signed out', () => {
    mocks.state.account.status = { signedIn: false, email: null }

    render(<AccountSettings />)

    expect(screen.getByText('Signed out')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in with Moobang account' })).toBeInTheDocument()
    expect(screen.queryByText('account@example.com')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument()
  })
})

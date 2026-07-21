// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { ProviderIntegrationsPanel } from './ProviderIntegrationsPanel'
import * as integrations from '../ipc/providerIntegrations'

vi.mock('../ipc/providerIntegrations', async () => {
  const actual = await vi.importActual<typeof integrations>('../ipc/providerIntegrations')
  return {
    ...actual,
    providerScopes: vi.fn(),
    providerCredentialStatus: vi.fn(),
    providerCredentialCapture: vi.fn(),
    providerCredentialDelete: vi.fn(),
    providerDiscover: vi.fn(),
    providerWorkspaceInput: vi.fn(),
    providerReviewComment: vi.fn(),
  }
})

afterEach(cleanup)

const credential: integrations.CredentialReference = {
  credentialId: 'credential-1', provider: 'github', account: 'github.com', scopes: ['repositories:read', 'issues:read', 'reviews:read', 'reviews:comment'],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(integrations.providerScopes).mockImplementation(async (provider) => provider === 'linear' ? ['issues:read', 'issues:comment'] : ['repositories:read', 'issues:read', 'reviews:read', 'reviews:comment'])
  vi.mocked(integrations.providerCredentialStatus).mockResolvedValue(null)
  vi.mocked(integrations.providerCredentialCapture).mockResolvedValue(credential)
  vi.mocked(integrations.providerDiscover).mockResolvedValue([])
})

describe('ProviderIntegrationsPanel', () => {
  test('captures scoped credentials through the native Windows prompt', async () => {
    vi.stubGlobal('crypto', { randomUUID: vi.fn(() => 'credential-1') })
    render(<ProviderIntegrationsPanel />)
    expect(await screen.findByText('repositories:read')).toBeTruthy()
    expect(screen.queryByLabelText('Access token')).toBeNull()
    const capture = screen.getByRole('button', { name: /Open Windows credential prompt/ }) as HTMLButtonElement
    expect(capture.disabled).toBe(false)
    fireEvent.click(capture)
    await waitFor(() => expect(integrations.providerCredentialCapture).toHaveBeenCalledWith('github', 'github.com', expect.arrayContaining(['repositories:read', 'issues:read', 'reviews:read']), 'credential-1'))
    expect(await screen.findByText(/credential captured and saved by Windows/)).toBeTruthy()
  })

  test('limits Linear discovery to issues and exposes issue comment scope', async () => {
    render(<ProviderIntegrationsPanel />)
    fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'linear' } })
    expect(await screen.findByText('issues:comment')).toBeTruthy()
    expect(screen.queryByRole('option', { name: 'Repositories' })).toBeNull()
    expect(screen.queryByRole('option', { name: 'Pull / merge requests' })).toBeNull()
    expect(screen.getByRole('option', { name: 'Issues' })).toBeTruthy()
  })
})

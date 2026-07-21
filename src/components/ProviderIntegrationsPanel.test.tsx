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
    providerCredentialStore: vi.fn(),
    providerCredentialDelete: vi.fn(),
    providerDiscover: vi.fn(),
    providerWorkspaceInput: vi.fn(),
    providerReviewComment: vi.fn(),
  }
})

afterEach(cleanup)

const credential: integrations.CredentialReference = {
  id: 'credential-1', provider: 'github', account: 'github.com', scopes: ['repositories:read', 'issues:read', 'reviews:read', 'reviews:comment'],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(integrations.providerScopes).mockImplementation(async (provider) => provider === 'linear' ? ['issues:read', 'issues:comment'] : ['repositories:read', 'issues:read', 'reviews:read', 'reviews:comment'])
  vi.mocked(integrations.providerCredentialStatus).mockResolvedValue(null)
  vi.mocked(integrations.providerCredentialStore).mockResolvedValue(credential)
  vi.mocked(integrations.providerDiscover).mockResolvedValue([])
})

describe('ProviderIntegrationsPanel', () => {
  test('requires explicit scopes before storing a credential', async () => {
    render(<ProviderIntegrationsPanel />)
    expect(await screen.findByText('repositories:read')).toBeTruthy()
    const save = screen.getByRole('button', { name: /Save scoped credential/ }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    fireEvent.change(screen.getByLabelText('Access token'), { target: { value: 'secret' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(integrations.providerCredentialStore).toHaveBeenCalledWith('github', 'github.com', 'secret', expect.arrayContaining(['repositories:read', 'issues:read', 'reviews:read'])))
    expect(screen.queryByDisplayValue('secret')).toBeNull()
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

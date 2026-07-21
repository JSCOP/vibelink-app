import { invoke } from '@tauri-apps/api/core'

export type ProviderKind = 'github' | 'gitlab' | 'linear'
export type ProviderScope = 'repositories:read' | 'issues:read' | 'reviews:read' | 'reviews:comment' | 'issues:comment'
export type DiscoveryResource = 'repositories' | 'issues' | 'reviews'

export type CredentialReference = {
  id: string
  provider: ProviderKind
  account: string
  scopes: ProviderScope[]
}

export type ProviderItem =
  | { kind: 'repository'; id: string; name: string; owner: string; webUrl: string; cloneUrl: string; defaultBranch: string | null; private: boolean }
  | { kind: 'issue'; id: string; identifier: string; title: string; state: string; webUrl: string; repository: string | null; cloneUrl: string | null }
  | { kind: 'review'; id: string; identifier: string; title: string; state: string; webUrl: string; repository: string; cloneUrl: string | null }

export type WorkspaceCreationInput = {
  name: string
  sourceKind: 'repository' | 'issue' | 'review'
  cloneUrl: string | null
  suggestedDirectoryName: string | null
  provider: ProviderKind
  sourceId: string
  sourceUrl: string
  sourceTitle: string | null
}

export type ReviewCommentResult = { id: string; webUrl: string | null }

export const providerAccounts: Record<ProviderKind, string> = {
  github: 'github.com',
  gitlab: 'gitlab.com',
  linear: 'api.linear.app',
}

export async function providerScopes(provider: ProviderKind): Promise<ProviderScope[]> {
  return invoke<ProviderScope[]>('provider_scopes_list', { provider })
}

export async function providerCredentialStatus(provider: ProviderKind, account: string): Promise<CredentialReference | null> {
  return invoke<CredentialReference | null>('provider_credential_status', { provider, account })
}

export async function providerCredentialStore(provider: ProviderKind, account: string, token: string, scopes: ProviderScope[]): Promise<CredentialReference> {
  return invoke<CredentialReference>('provider_credential_store', { request: { provider, account, token, scopes } })
}

export async function providerCredentialDelete(reference: CredentialReference): Promise<void> {
  return invoke('provider_credential_delete', { reference })
}

export async function providerDiscover(credential: CredentialReference, resource: DiscoveryResource, query: string, limit = 30): Promise<ProviderItem[]> {
  return invoke<ProviderItem[]>('provider_discover', { request: { credential, resource, query, limit } })
}

export async function providerWorkspaceInput(provider: ProviderKind, item: ProviderItem): Promise<WorkspaceCreationInput> {
  return invoke<WorkspaceCreationInput>('provider_workspace_input', { provider, item })
}

export async function providerReviewComment(credential: CredentialReference, item: ProviderItem, body: string): Promise<ReviewCommentResult> {
  const repository = item.kind === 'review' ? item.repository : item.kind === 'issue' ? item.repository : null
  const targetId = item.kind === 'repository' ? item.id : item.identifier.replace(/^.*?[#!]\s*/, '') || item.id
  return invoke<ReviewCommentResult>('provider_review_comment', { request: { credential, repository, targetId: credential.provider === 'linear' ? item.id : targetId, body } })
}

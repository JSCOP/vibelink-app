import { useEffect, useMemo, useState } from 'react'
import { ExternalLink, KeyRound, LoaderCircle, MessageSquare, Search, Trash2 } from 'lucide-react'
import {
  providerAccounts,
  providerCredentialDelete,
  providerCredentialStatus,
  providerCredentialStore,
  providerDiscover,
  providerReviewComment,
  providerScopes,
  providerWorkspaceInput,
  type CredentialReference,
  type DiscoveryResource,
  type ProviderItem,
  type ProviderKind,
  type ProviderScope,
  type WorkspaceCreationInput,
} from '../ipc/providerIntegrations'
import './ProviderIntegrationsPanel.css'

export type ProviderIntegrationsPanelProps = {
  onWorkspaceInput?: (input: WorkspaceCreationInput) => void | Promise<void>
}

const labels: Record<ProviderKind, string> = { github: 'GitHub', gitlab: 'GitLab', linear: 'Linear' }

export function ProviderIntegrationsPanel({ onWorkspaceInput }: ProviderIntegrationsPanelProps) {
  const [provider, setProvider] = useState<ProviderKind>('github')
  const [account, setAccount] = useState(providerAccounts.github)
  const [token, setToken] = useState('')
  const [allowedScopes, setAllowedScopes] = useState<ProviderScope[]>([])
  const [selectedScopes, setSelectedScopes] = useState<ProviderScope[]>([])
  const [credential, setCredential] = useState<CredentialReference | null>(null)
  const [resource, setResource] = useState<DiscoveryResource>('repositories')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ProviderItem[]>([])
  const [selected, setSelected] = useState<ProviderItem | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void providerScopes(provider)
      .then((scopes) => {
        if (cancelled) return
        setAllowedScopes(scopes)
        setSelectedScopes(scopes.filter((scope) => scope.endsWith(':read')))
      })
      .catch((error) => { if (!cancelled) setMessage(errorMessage(error)) })
    return () => { cancelled = true }
  }, [provider])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void providerCredentialStatus(provider, account)
        .then(setCredential)
        .catch((error) => setMessage(errorMessage(error)))
    }, 200)
    return () => window.clearTimeout(timer)
  }, [account, provider])

  const canComment = useMemo(() => {
    if (!credential || !selected || selected.kind === 'repository') return false
    return credential.scopes.includes(provider === 'linear' ? 'issues:comment' : 'reviews:comment')
  }, [credential, provider, selected])

  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    try { await operation() }
    catch (error) { setMessage(errorMessage(error)) }
    finally { setBusy(false) }
  }

  const changeProvider = (nextProvider: ProviderKind) => {
    setProvider(nextProvider)
    setAccount(providerAccounts[nextProvider])
    setCredential(null)
    setItems([])
    setSelected(null)
    setResource(nextProvider === 'linear' ? 'issues' : 'repositories')
  }

  const saveCredential = () => run(async () => {
    const next = await providerCredentialStore(provider, account, token, selectedScopes)
    setCredential(next)
    setToken('')
    setMessage(`${labels[provider]} credential saved in OS secure storage.`)
  })

  const clearCredential = () => run(async () => {
    if (!credential) return
    await providerCredentialDelete(credential)
    setCredential(null)
    setItems([])
    setMessage(`${labels[provider]} credential removed.`)
  })

  const search = () => run(async () => {
    if (!credential) throw new Error('Store a scoped credential first.')
    const next = await providerDiscover(credential, resource, query)
    setItems(next)
    setSelected(next[0] ?? null)
    setMessage(`${next.length} ${resource} found.`)
  })

  const prepareForWorkspace = (item: ProviderItem) => run(async () => {
    const input = await providerWorkspaceInput(provider, item)
    await onWorkspaceInput?.(input)
    setMessage(input.cloneUrl
      ? `Workspace input prepared. Clone with the existing Git clone flow into ${input.suggestedDirectoryName ?? 'a selected folder'}.`
      : `Workspace input prepared from ${input.sourceKind} ${input.sourceId}.`)
  })

  const postComment = () => run(async () => {
    if (!credential || !selected) return
    const result = await providerReviewComment(credential, selected, comment)
    setComment('')
    setMessage(`Comment ${result.id} created${result.webUrl ? `: ${result.webUrl}` : '.'}`)
  })

  return (
    <section className="provider-integrations-panel" aria-label="Provider integrations">
      <header>
        <div>
          <h3>Provider integrations</h3>
          <p>Credentials stay in OS secure storage. VibeLink passes only credential references and enforces the scopes selected here.</p>
        </div>
        {busy ? <LoaderCircle className="spin" size={16} aria-label="Working" /> : null}
      </header>

      <div className="provider-integrations-grid">
        <label>Provider<select value={provider} onChange={(event) => changeProvider(event.target.value as ProviderKind)}><option value="github">GitHub</option><option value="gitlab">GitLab</option><option value="linear">Linear</option></select></label>
        <label>Account / host<input value={account} disabled={provider === 'linear'} onChange={(event) => setAccount(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      </div>

      <fieldset className="provider-scopes">
        <legend>Explicit scopes</legend>
        {allowedScopes.map((scope) => (
          <label key={scope}>
            <input type="checkbox" checked={selectedScopes.includes(scope)} onChange={(event) => setSelectedScopes((current) => event.target.checked ? [...current, scope] : current.filter((item) => item !== scope))} />
            <span>{scope}</span>
          </label>
        ))}
      </fieldset>

      <label>Access token<input type="password" value={token} placeholder="Stored securely and never displayed again" onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      <div className="provider-integrations-actions">
        <button type="button" disabled={busy || !token.trim() || selectedScopes.length === 0} onClick={() => void saveCredential()}><KeyRound size={14} /> Save scoped credential</button>
        <button type="button" disabled={busy || !credential} onClick={() => void clearCredential()}><Trash2 size={14} /> Remove credential</button>
        <span role="status">{credential ? `${credential.scopes.length} scopes active for ${credential.account}` : 'No credential reference loaded'}</span>
      </div>

      <div className="provider-discovery-toolbar">
        <select aria-label="Discovery resource" value={resource} onChange={(event) => setResource(event.target.value as DiscoveryResource)}>
          {provider !== 'linear' ? <option value="repositories">Repositories</option> : null}
          <option value="issues">Issues</option>
          {provider !== 'linear' ? <option value="reviews">Pull / merge requests</option> : null}
        </select>
        <input aria-label="Provider search" value={query} placeholder={`Search ${labels[provider]}`} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search() }} />
        <button type="button" disabled={busy || !credential} onClick={() => void search()}><Search size={14} /> Discover</button>
      </div>

      <div className="provider-discovery-results">
        {items.map((item) => (
          <article key={`${item.kind}:${item.id}`} data-selected={selected?.id === item.id || undefined}>
            <button type="button" className="provider-item-main" onClick={() => setSelected(item)}>
              <strong>{item.kind === 'repository' ? `${item.owner}/${item.name}` : `${item.identifier} ${item.title}`}</strong>
              <span>{item.kind === 'repository' ? `${item.private ? 'Private' : 'Public'} · ${item.defaultBranch ?? 'default branch unknown'}` : `${item.state}${item.repository ? ` · ${item.repository}` : ''}`}</span>
            </button>
            <button type="button" onClick={() => void prepareForWorkspace(item)}>Use for workspace</button>
            <a href={item.webUrl} target="_blank" rel="noreferrer" aria-label="Open provider item"><ExternalLink size={14} /></a>
          </article>
        ))}
        {!busy && items.length === 0 ? <p>No discovered items.</p> : null}
      </div>

      {selected && selected.kind !== 'repository' ? (
        <div className="provider-review-comment">
          <label>Review / issue comment<textarea value={comment} maxLength={64 * 1024} onChange={(event) => setComment(event.target.value)} placeholder="Comment is sent only to the selected provider item." /></label>
          <button type="button" disabled={busy || !canComment || !comment.trim()} title={canComment ? undefined : `Grant ${provider === 'linear' ? 'issues:comment' : 'reviews:comment'} to comment`} onClick={() => void postComment()}><MessageSquare size={14} /> Post comment</button>
        </div>
      ) : null}

      {message ? <div className="provider-integrations-message" role="status">{message}</div> : null}
    </section>
  )
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

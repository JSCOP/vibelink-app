import { useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, KeyRound, ListFilter, LoaderCircle, MessageSquare, Plug, Search, Server, ShieldCheck, Trash2 } from 'lucide-react'
import {
  providerAccounts,
  providerCredentialCapture,
  providerCredentialDelete,
  providerCredentialStatus,
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
import {
  SettingsButton,
  SettingsCard,
  SettingsMessage,
  SettingsPill,
  SettingsRow,
  SettingsSegmented,
  SettingsSelect,
  SettingsText,
} from './settings/controls'
import './ProviderIntegrationsPanel.css'

export type ProviderIntegrationsPanelProps = {
  onWorkspaceInput?: (input: WorkspaceCreationInput) => void | Promise<void>
}

const labels: Record<ProviderKind, string> = { github: 'GitHub', gitlab: 'GitLab', linear: 'Linear' }

type PanelMessage = {
  section: 'credentials' | 'discovery'
  text: string
  tone: 'ok' | 'danger'
}

export function ProviderIntegrationsPanel({ onWorkspaceInput }: ProviderIntegrationsPanelProps) {
  const [provider, setProvider] = useState<ProviderKind>('github')
  const [account, setAccount] = useState(providerAccounts.github)
  const [allowedScopes, setAllowedScopes] = useState<ProviderScope[]>([])
  const [selectedScopes, setSelectedScopes] = useState<ProviderScope[]>([])
  const [credential, setCredential] = useState<CredentialReference | null>(null)
  const [resource, setResource] = useState<DiscoveryResource>('repositories')
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<ProviderItem[]>([])
  const [selected, setSelected] = useState<ProviderItem | null>(null)
  const [comment, setComment] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<PanelMessage | null>(null)

  useEffect(() => {
    let cancelled = false
    void providerScopes(provider)
      .then((scopes) => {
        if (cancelled) return
        setAllowedScopes(scopes)
        setSelectedScopes(scopes.filter((scope) => scope.endsWith(':read')))
      })
      .catch((error) => { if (!cancelled) setMessage({ section: 'credentials', text: errorMessage(error), tone: 'danger' }) })
    return () => { cancelled = true }
  }, [provider])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      void providerCredentialStatus(provider, account)
        .then((next) => { if (!cancelled) setCredential(next) })
        .catch((error) => { if (!cancelled) setMessage({ section: 'credentials', text: errorMessage(error), tone: 'danger' }) })
    }, 200)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [account, provider])

  const canComment = useMemo(() => {
    if (!credential || !selected || selected.kind === 'repository') return false
    return credential.scopes.includes(provider === 'linear' ? 'issues:comment' : 'reviews:comment')
  }, [credential, provider, selected])

  const run = async (section: PanelMessage['section'], operation: () => Promise<void>) => {
    setBusy(true)
    setMessage(null)
    try { await operation() }
    catch (error) { setMessage({ section, text: errorMessage(error), tone: 'danger' }) }
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

  // Raw tokens are captured only by native Windows CredUI. React and IPC retain
  // only the returned credential reference, never the secret itself.
  const saveCredential = () => run('credentials', async () => {
    const credentialId = credential?.credentialId ?? crypto.randomUUID()
    const next = await providerCredentialCapture(provider, account, selectedScopes, credentialId)
    setCredential(next)
    setMessage({ section: 'credentials', text: `${labels[provider]} credential captured and saved by Windows.`, tone: 'ok' })
  })

  const clearCredential = () => run('credentials', async () => {
    if (!credential) return
    await providerCredentialDelete(credential)
    setCredential(null)
    setItems([])
    setMessage({ section: 'credentials', text: `${labels[provider]} credential removed.`, tone: 'ok' })
  })

  const search = () => run('discovery', async () => {
    if (!credential) throw new Error('Store a scoped credential first.')
    const next = await providerDiscover(credential, resource, query)
    setItems(next)
    setSelected(next[0] ?? null)
    setMessage({ section: 'discovery', text: `${next.length} ${resource} found.`, tone: 'ok' })
  })

  const prepareForWorkspace = (item: ProviderItem) => run('discovery', async () => {
    const input = await providerWorkspaceInput(provider, item)
    await onWorkspaceInput?.(input)
    setMessage({
      section: 'discovery',
      tone: 'ok',
      text: input.cloneUrl
        ? `Workspace input prepared. Clone with the existing Git clone flow into ${input.suggestedDirectoryName ?? 'a selected folder'}.`
        : `Workspace input prepared from ${input.sourceKind} ${input.sourceId}.`,
    })
  })

  const postComment = () => run('discovery', async () => {
    if (!credential || !selected) return
    const result = await providerReviewComment(credential, selected, comment)
    setComment('')
    setMessage({ section: 'discovery', text: `Comment ${result.id} created${result.webUrl ? `: ${result.webUrl}` : '.'}`, tone: 'ok' })
  })

  return (
    <>
      <SettingsCard
        icon={Plug}
        title="Provider credentials"
        hint="Tokens are captured by the native Windows credential prompt and stored in Credential Manager. Only credential references cross IPC."
        status={(
          <span title={credential ? `${credential.scopes.length} scopes active for ${credential.account}` : 'No credential reference loaded'}>
            <SettingsPill tone={credential ? 'ok' : undefined} icon={credential ? ShieldCheck : KeyRound}>
              {credential ? `${credential.scopes.length} scopes` : 'Not stored'}
              {busy ? <LoaderCircle className="spin" size={11} aria-hidden="true" /> : null}
            </SettingsPill>
          </span>
        )}
      >
        <SettingsRow
          icon={Plug}
          label="Provider"
          control={(
            <SettingsSegmented
              label="Provider"
              value={provider}
              options={([
                { value: 'github', label: 'GitHub' },
                { value: 'gitlab', label: 'GitLab' },
                { value: 'linear', label: 'Linear' },
              ] satisfies { value: ProviderKind; label: string }[])}
              onChange={changeProvider}
            />
          )}
        />
        <SettingsRow
          icon={Server}
          label="Account / host"
          control={(
            <SettingsText
              label="Account / host"
              value={account}
              disabled={provider === 'linear'}
              onChange={(value) => { setAccount(value); setCredential(null); setItems([]); setSelected(null) }}
            />
          )}
        />
        <SettingsRow
          icon={ShieldCheck}
          label="Scopes"
          hint="Grant only the provider operations VibeLink may perform."
          stacked
          control={(
            <div className="vl-set-chips" role="group" aria-label="Explicit scopes">
              {allowedScopes.map((scope) => {
                const active = selectedScopes.includes(scope)
                return (
                  <button
                    key={scope}
                    type="button"
                    className="vl-set-chip"
                    aria-label={scope}
                    aria-pressed={active}
                    onClick={() => setSelectedScopes((current) => current.includes(scope) ? current.filter((item) => item !== scope) : [...current, scope])}
                  >
                    {active ? <Check size={12} strokeWidth={2.2} aria-hidden="true" /> : null}
                    <span>{scope}</span>
                  </button>
                )
              })}
            </div>
          )}
        />
        <div className="vl-set-actions vl-set-actions-bordered">
          {/* This control opens native CredUI; there is intentionally no token textbox in the WebView. */}
          <button
            type="button"
            className="vl-set-button"
            data-tone="accent"
            aria-label="Open Windows credential prompt"
            title="Open Windows credential prompt"
            disabled={busy || selectedScopes.length === 0}
            onClick={() => void saveCredential()}
          >
            <KeyRound size={13} strokeWidth={1.9} aria-hidden="true" />
            Capture
          </button>
          <SettingsButton icon={Trash2} label="Remove" tone="danger" disabled={busy || !credential} onClick={() => void clearCredential()} />
        </div>
        {message?.section === 'credentials' ? <SettingsMessage tone={message.tone}>{message.text}</SettingsMessage> : null}
      </SettingsCard>

      <SettingsCard
        icon={Search}
        title="Discovery"
        hint="Search provider resources with the stored scoped credential, then use a result to prepare workspace input."
      >
        <SettingsRow
          icon={ListFilter}
          label="Resource"
          control={(
            <SettingsSelect label="Discovery resource" value={resource} onChange={(value) => setResource(value as DiscoveryResource)}>
              {provider !== 'linear' ? <option value="repositories">Repositories</option> : null}
              <option value="issues">Issues</option>
              {provider !== 'linear' ? <option value="reviews">Pull / merge requests</option> : null}
            </SettingsSelect>
          )}
        />
        <SettingsRow
          icon={Search}
          label="Search"
          stacked
          control={(
            <div className="vl-set-actions">
              <input
                className="vl-set-input"
                style={{ flex: '1 1 220px' }}
                aria-label="Provider search"
                value={query}
                placeholder={`Search ${labels[provider]}`}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void search() }}
              />
              <SettingsButton icon={Search} label="Discover" tone="accent" disabled={busy || !credential} onClick={() => void search()} />
            </div>
          )}
        />

        <div className="provider-discovery-results">
          {items.map((item) => (
            <article key={`${item.kind}:${item.id}`} data-selected={selected?.id === item.id || undefined}>
              <button type="button" className="provider-item-main" onClick={() => setSelected(item)}>
                <strong>{item.kind === 'repository' ? `${item.owner}/${item.name}` : `${item.identifier} ${item.title}`}</strong>
                <span>{item.kind === 'repository' ? `${item.private ? 'Private' : 'Public'} · ${item.defaultBranch ?? 'default branch unknown'}` : `${item.state}${item.repository ? ` · ${item.repository}` : ''}`}</span>
              </button>
              <SettingsButton label="Use for workspace" onClick={() => void prepareForWorkspace(item)} />
              <a href={item.webUrl} target="_blank" rel="noreferrer" aria-label="Open provider item" title="Open provider item"><ExternalLink size={14} /></a>
            </article>
          ))}
          {!busy && items.length === 0 ? <span className="provider-discovery-empty">No discovered items.</span> : null}
        </div>

        {selected && selected.kind !== 'repository' ? (
          <SettingsRow
            icon={MessageSquare}
            label="Comment"
            hint="Comments are sent only to the selected provider item."
            stacked
            control={(
              <div className="provider-review-comment">
                <textarea
                  className="vl-set-textarea"
                  aria-label="Review / issue comment"
                  value={comment}
                  maxLength={64 * 1024}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Comment on the selected item"
                />
                <SettingsButton
                  icon={MessageSquare}
                  label="Post"
                  disabled={busy || !canComment || !comment.trim()}
                  title={canComment ? undefined : `Grant ${provider === 'linear' ? 'issues:comment' : 'reviews:comment'} to comment`}
                  onClick={() => void postComment()}
                />
              </div>
            )}
          />
        ) : null}

        {message?.section === 'discovery' ? <SettingsMessage tone={message.tone}>{message.text}</SettingsMessage> : null}
      </SettingsCard>
    </>
  )
}

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return String(error)
}

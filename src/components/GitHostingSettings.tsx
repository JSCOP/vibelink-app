import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { Check, KeyRound, LoaderCircle, Trash2 } from 'lucide-react'
import './GitHostingSettings.css'

export function GitHostingSettings() {
  const [host, setHost] = useState('github.com')
  const [token, setToken] = useState('')
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github')
  const [tokenPresent, setTokenPresent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = async (nextHost = host) => {
    if (!nextHost.trim()) { setTokenPresent(false); return }
    try { setTokenPresent(await invoke<boolean>('hosting_token_status', { host: nextHost.trim() })) }
    catch (reason) { setMessage(String(reason)) }
  }
  useEffect(() => { const timer = window.setTimeout(() => { void refresh() }, 250); return () => window.clearTimeout(timer) }, [host])

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true)
    setMessage(null)
    try { await operation(); await refresh(); setMessage(success) }
    catch (reason) { setMessage(String(reason)) }
    finally { setBusy(false) }
  }

  return (
    <div className="git-hosting-settings" data-git-hosting-settings="true">
      <div className="vibelink-settings-grid">
        <label>Host<input value={host} placeholder="github.com" autoComplete="off" spellCheck={false} onChange={(event) => setHost(event.target.value)} /></label>
        <label>Provider<select value={provider} onChange={(event) => setProvider(event.target.value as 'github' | 'gitlab')}><option value="github">GitHub</option><option value="gitlab">GitLab</option></select></label>
      </div>
      <div className="git-hosting-status" data-present={tokenPresent || undefined} role="status">
        <span className="git-hosting-status-icon" aria-hidden="true">{tokenPresent ? <Check size={13} strokeWidth={2.1} /> : <KeyRound size={13} strokeWidth={1.9} />}</span>
        <span>{tokenPresent ? `Token stored for ${host.trim() || 'this host'} in Windows Credential Manager` : 'No token stored for this host'}</span>
        {busy ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : null}
      </div>
      <label>Personal access token<input type="password" value={token} placeholder="Stored securely; never displayed again" autoComplete="off" spellCheck={false} onChange={(event) => setToken(event.target.value)} /></label>
      <div className="vibelink-settings-actions">
        <button type="button" disabled={busy || !host.trim() || !token.trim()} onClick={() => void run(() => invoke('hosting_token_set', { host: host.trim(), token: token.trim() }), 'Token saved.').then(() => setToken(''))}><KeyRound size={14} strokeWidth={1.9} aria-hidden="true" />Set token</button>
        <button type="button" disabled={busy || !host.trim() || !tokenPresent} onClick={() => void run(() => invoke('hosting_token_clear', { host: host.trim() }), 'Token cleared.')}><Trash2 size={14} strokeWidth={1.9} aria-hidden="true" />Clear token</button>
        <button type="button" disabled={busy || !host.trim()} onClick={() => void run(() => invoke('hosting_provider_override', { host: host.trim(), provider }), `Provider override saved as ${provider}.`)}>Save provider override</button>
      </div>
      {message ? <div className="vibelink-settings-note" role="status"><span>{message}</span></div> : null}
    </div>
  )
}

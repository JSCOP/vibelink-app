import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useState } from 'react'
import { Check, GitBranch, GitPullRequest, KeyRound, LoaderCircle, Server, Trash2 } from 'lucide-react'
import {
  SettingsButton,
  SettingsCard,
  SettingsMessage,
  SettingsPill,
  SettingsRow,
  SettingsSegmented,
  SettingsText,
} from './settings/controls'

export function GitHostingSettings() {
  const [host, setHost] = useState('github.com')
  const [token, setToken] = useState('')
  const [provider, setProvider] = useState<'github' | 'gitlab'>('github')
  const [tokenPresent, setTokenPresent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [messageTone, setMessageTone] = useState<'ok' | 'danger' | undefined>()

  const refresh = useCallback(async (nextHost = host) => {
    if (!nextHost.trim()) { setTokenPresent(false); return }
    try { setTokenPresent(await invoke<boolean>('hosting_token_status', { host: nextHost.trim() })) }
    catch (reason) { setMessageTone('danger'); setMessage(String(reason)) }
  }, [host])
  useEffect(() => { const timer = window.setTimeout(() => { void refresh() }, 250); return () => window.clearTimeout(timer) }, [refresh])

  const run = async (operation: () => Promise<unknown>, success: string) => {
    setBusy(true)
    setMessage(null)
    setMessageTone(undefined)
    try { await operation(); await refresh(); setMessageTone('ok'); setMessage(success) }
    catch (reason) { setMessageTone('danger'); setMessage(String(reason)) }
    finally { setBusy(false) }
  }

  return (
    <SettingsCard
      icon={GitPullRequest}
      title="Git hosting token"
      hint="Personal access tokens are stored in Windows Credential Manager and are never displayed after saving."
      status={(
        <span title={tokenPresent ? `Token stored for ${host.trim() || 'this host'}` : 'No token stored for this host'}>
          <SettingsPill tone={tokenPresent ? 'ok' : undefined} icon={tokenPresent ? Check : KeyRound}>
            {tokenPresent ? 'Stored' : 'Not stored'}
            {busy ? <LoaderCircle className="spin" size={11} aria-hidden="true" /> : null}
          </SettingsPill>
        </span>
      )}
    >
      <SettingsRow
        icon={Server}
        label="Host"
        control={<SettingsText label="Host" value={host} placeholder="github.com" onChange={setHost} />}
      />
      <SettingsRow
        icon={GitBranch}
        label="Provider"
        control={(
          <SettingsSegmented
            label="Provider"
            value={provider}
            options={[
              { value: 'github', label: 'GitHub' },
              { value: 'gitlab', label: 'GitLab' },
            ]}
            onChange={setProvider}
          />
        )}
      />
      <SettingsRow
        icon={KeyRound}
        label="Access token"
        hint="The token is sent once to native secure storage and is never displayed again."
        stacked
        control={(
          <input
            className="vl-set-input"
            type="password"
            aria-label="Personal access token"
            value={token}
            placeholder="Stored securely; never displayed again"
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setToken(event.target.value)}
          />
        )}
      />
      <div className="vl-set-actions vl-set-actions-bordered">
        <SettingsButton icon={KeyRound} label="Save token" tone="accent" disabled={busy || !host.trim() || !token.trim()} onClick={() => void run(() => invoke('hosting_token_set', { host: host.trim(), token: token.trim() }), 'Token saved.').then(() => setToken(''))} />
        <SettingsButton icon={Trash2} label="Clear" tone="danger" disabled={busy || !host.trim() || !tokenPresent} onClick={() => void run(() => invoke('hosting_token_clear', { host: host.trim() }), 'Token cleared.')} />
        <SettingsButton icon={Check} label="Save provider" disabled={busy || !host.trim()} onClick={() => void run(() => invoke('hosting_provider_override', { host: host.trim(), provider }), `Provider override saved as ${provider}.`)} />
      </div>
      {message ? <SettingsMessage tone={messageTone}>{message}</SettingsMessage> : null}
    </SettingsCard>
  )
}

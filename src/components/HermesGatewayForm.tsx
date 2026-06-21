import { invoke } from '@tauri-apps/api/core'
import { useMemo, useState } from 'react'
import type { HermesGatewayConfig, HermesGatewayStatus } from '../ipc/types'
import { defaultHermesGateway } from '../state/hermes'
import { useWorkspaceStore } from '../state/store'

const platforms: HermesGatewayConfig['platform'][] = ['telegram', 'discord', 'slack']

export function HermesGatewayForm({ sessionId }: { sessionId: string }) {
  const gateways = useWorkspaceStore((state) => state.hermesGateways)
  const setHermesGateway = useWorkspaceStore((state) => state.setHermesGateway)
  const gateway = useMemo(() => gateways[sessionId] ?? defaultHermesGateway('telegram'), [gateways, sessionId])
  const [draft, setDraft] = useState(gateway)
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<HermesGatewayStatus | null>(null)
  const [message, setMessage] = useState('')

  const updatePlatform = (platform: HermesGatewayConfig['platform']) => {
    setDraft({ ...defaultHermesGateway(platform), allowedUsers: draft.allowedUsers, tokenSet: draft.platform === platform ? draft.tokenSet : false })
  }

  const provision = async () => {
    const trimmed = token.trim()
    const next = { ...draft, tokenSet: draft.tokenSet || trimmed.length > 0 }
    await invoke('hermes_gateway_provision', { sessionId, gateway: next, token: trimmed || null })
    setToken('')
    setHermesGateway(sessionId, next)
    setMessage('Gateway provisioned')
  }

  const refresh = async () => {
    setStatus(await invoke<HermesGatewayStatus>('hermes_gateway_status', { sessionId }))
  }

  const start = async () => {
    const pid = await invoke<number>('hermes_gateway_start', { sessionId })
    setStatus({ running: true, pid })
  }

  const stop = async () => {
    await invoke('hermes_gateway_stop', { sessionId })
    setStatus({ running: false })
  }

  return (
    <details className="hermes-gateway">
      <summary>Messaging gateway</summary>
      <label>
        Platform
        <select value={draft.platform} onChange={(event) => updatePlatform(event.target.value as HermesGatewayConfig['platform'])}>
          {platforms.map((platform) => <option key={platform} value={platform}>{platform}</option>)}
        </select>
      </label>
      <label>
        Token env var
        <input value={draft.tokenEnv} onChange={(event) => setDraft((current) => ({ ...current, tokenEnv: event.target.value }))} />
      </label>
      <label>
        Token {draft.tokenSet ? <span className="hermes-inline-note">already set</span> : null}
        <input type="password" value={token} placeholder="Stored only in HERMES_HOME/.env" onChange={(event) => setToken(event.target.value)} />
      </label>
      <label>
        Allowed users
        <input value={draft.allowedUsers} onChange={(event) => setDraft((current) => ({ ...current, allowedUsers: event.target.value }))} />
      </label>
      <div className="hermes-permission-actions">
        <button type="button" onClick={() => void provision()}>Provision</button>
        <button type="button" onClick={() => void start()}>Start</button>
        <button type="button" onClick={() => void stop()}>Stop</button>
        <button type="button" onClick={() => void refresh()}>Status</button>
      </div>
      {status ? <p className="hermes-form-message">{status.running ? `Running pid ${status.pid ?? ''}` : 'Stopped'}</p> : null}
      {message ? <p className="hermes-form-message">{message}</p> : null}
    </details>
  )
}

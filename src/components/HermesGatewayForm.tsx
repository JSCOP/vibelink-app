import { invoke } from '@tauri-apps/api/core'
import { useMemo, useState } from 'react'
import { Play, RefreshCw, Save, Square } from 'lucide-react'
import type { HermesGatewayConfig, HermesGatewayStatus } from '../ipc/types'
import { defaultHermesGateway } from '../state/hermes'
import { useWorkspaceStore } from '../state/store'

const platforms: { id: HermesGatewayConfig['platform']; label: string; tokenEnv: string; allowedHint: string }[] = [
  { id: 'telegram', label: 'Telegram', tokenEnv: 'TELEGRAM_BOT_TOKEN', allowedHint: 'Telegram user IDs, comma separated' },
  { id: 'discord', label: 'Discord', tokenEnv: 'DISCORD_BOT_TOKEN', allowedHint: 'Discord user IDs, comma separated' },
  { id: 'slack', label: 'Slack', tokenEnv: 'SLACK_BOT_TOKEN', allowedHint: 'Slack user IDs, comma separated' },
]

export function HermesGatewayForm({ sessionId }: { sessionId: string }) {
  const gateways = useWorkspaceStore((state) => state.hermesGateways)
  const setHermesGateway = useWorkspaceStore((state) => state.setHermesGateway)
  const gateway = useMemo(() => gateways[sessionId] ?? defaultHermesGateway('telegram'), [gateways, sessionId])
  const gatewayKey = `${sessionId}:${gateway.platform}:${gateway.tokenEnv}:${gateway.tokenSet}:${gateway.allowedUsers}`
  const [draftState, setDraftState] = useState<{ key: string; value: HermesGatewayConfig }>({ key: gatewayKey, value: gateway })
  const [transientState, setTransientState] = useState<{ key: string; token: string; status: HermesGatewayStatus | null; message: string }>({
    key: gatewayKey,
    token: '',
    status: null,
    message: '',
  })
  const [busy, setBusy] = useState(false)
  const draft = draftState.key === gatewayKey ? draftState.value : gateway
  const transient = transientState.key === gatewayKey ? transientState : { key: gatewayKey, token: '', status: null, message: '' }
  const { token, status, message } = transient
  const selectedPlatform = platforms.find((platform) => platform.id === draft.platform) ?? platforms[0]

  const setDraft = (next: HermesGatewayConfig | ((current: HermesGatewayConfig) => HermesGatewayConfig)) => {
    setDraftState((current) => {
      const base = current.key === gatewayKey ? current.value : gateway
      return { key: gatewayKey, value: typeof next === 'function' ? next(base) : next }
    })
  }

  const setTransient = (patch: Partial<Omit<typeof transient, 'key'>>) => {
    setTransientState((current) => ({
      ...(current.key === gatewayKey ? current : { key: gatewayKey, token: '', status: null, message: '' }),
      ...patch,
    }))
  }

  const updatePlatform = (platform: HermesGatewayConfig['platform']) => {
    setDraft({ ...defaultHermesGateway(platform), allowedUsers: draft.allowedUsers, tokenSet: draft.platform === platform ? draft.tokenSet : false })
  }

  const provision = async () => {
    setBusy(true)
    setTransient({ message: '' })
    try {
      const trimmed = token.trim()
      const next = { ...draft, tokenSet: draft.tokenSet || trimmed.length > 0 }
      await invoke('hermes_gateway_provision', { sessionId, gateway: next, token: trimmed || null })
      setTransient({ token: '' })
      setDraft(next)
      setHermesGateway(sessionId, next)
      setTransient({ message: 'Messaging gateway saved.' })
    } catch (error) {
      setTransient({ message: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const refresh = async () => {
    setBusy(true)
    setTransient({ message: '' })
    try {
      setTransient({ status: await invoke<HermesGatewayStatus>('hermes_gateway_status', { sessionId }) })
    } catch (error) {
      setTransient({ message: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const start = async () => {
    setBusy(true)
    setTransient({ message: '' })
    try {
      const pid = await invoke<number>('hermes_gateway_start', { sessionId })
      setTransient({ status: { running: true, pid }, message: `Gateway running on pid ${pid}.` })
    } catch (error) {
      setTransient({ message: String(error) })
    } finally {
      setBusy(false)
    }
  }

  const stop = async () => {
    setBusy(true)
    setTransient({ message: '' })
    try {
      await invoke('hermes_gateway_stop', { sessionId })
      setTransient({ status: { running: false }, message: 'Gateway stopped.' })
    } catch (error) {
      setTransient({ message: String(error) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="hermes-gateway">
      <div className="hermes-gateway-platforms" role="group" aria-label="Messaging platform">
        {platforms.map((platform) => (
          <button
            key={platform.id}
            type="button"
            className={draft.platform === platform.id ? 'selected' : undefined}
            onClick={() => updatePlatform(platform.id)}
          >
            {platform.label}
          </button>
        ))}
      </div>
      <label>
        Token environment variable
        <input value={draft.tokenEnv} onChange={(event) => setDraft((current) => ({ ...current, tokenEnv: event.target.value }))} />
      </label>
      <label>
        Token {draft.tokenSet ? <span className="hermes-inline-note">already set</span> : null}
        <input type="password" value={token} placeholder={`Stored in HERMES_HOME/.env as ${draft.tokenEnv || selectedPlatform.tokenEnv}`} onChange={(event) => setTransient({ token: event.target.value })} />
      </label>
      <label>
        Allowed users
        <input value={draft.allowedUsers} placeholder={selectedPlatform.allowedHint} onChange={(event) => setDraft((current) => ({ ...current, allowedUsers: event.target.value }))} />
      </label>
      <div className="hermes-permission-actions">
        <button type="button" disabled={busy} onClick={() => void provision()}><Save size={14} /> Save</button>
        <button type="button" disabled={busy} onClick={() => void start()}><Play size={14} /> Start</button>
        <button type="button" disabled={busy} onClick={() => void stop()}><Square size={14} /> Stop</button>
        <button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /> Status</button>
      </div>
      {status ? <p className="hermes-form-message">{status.running ? `Running pid ${status.pid ?? ''}` : status.pid ? `Stopped, last pid ${status.pid}` : 'Stopped'}</p> : null}
      {message ? <p className="hermes-form-message">{message}</p> : null}
    </div>
  )
}

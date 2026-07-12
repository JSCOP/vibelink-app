import { invoke } from '@tauri-apps/api/core'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldAlert, Smartphone, Trash2, Wifi } from 'lucide-react'

type RemoteDevice = { id: string; name: string; createdAt: number; lastSeenAt: number }
type RemoteStatus = {
  enabled: boolean
  running: boolean
  port: number
  fingerprint: string
  hosts: string[]
  devices: RemoteDevice[]
}
type PairingPayload = { code: string; expiresAt: number; qrPayload: string }

export function RemoteSettings() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [port, setPort] = useState('42811')
  const [pairing, setPairing] = useState<PairingPayload | null>(null)
  const [qrUrl, setQrUrl] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = async () => {
    const next = await invoke<RemoteStatus>('remote_get_status')
    setStatus(next)
    setPort(String(next.port))
  }

  useEffect(() => {
    void invoke<RemoteStatus>('remote_get_status').then((next) => {
      setStatus(next)
      setPort(String(next.port))
    }).catch((error) => setMessage(String(error)))
  }, [])
  useEffect(() => {
    if (!pairing) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairing])

  const expiresIn = useMemo(() => pairing ? Math.max(0, pairing.expiresAt - Math.floor(now / 1000)) : 0, [now, pairing])

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }

  const toggleEnabled = () => void run(async () => {
    const next = await invoke<RemoteStatus>('remote_set_enabled', { enabled: !status?.enabled })
    setStatus(next)
    setPort(String(next.port))
  })

  const savePort = () => void run(async () => {
    const nextPort = Number(port)
    const next = await invoke<RemoteStatus>('remote_set_port', { port: nextPort })
    setStatus(next)
    setPort(String(next.port))
  })

  const createPairing = () => void run(async () => {
    const next = await invoke<PairingPayload>('remote_create_pairing')
    setPairing(next)
    setNow(Date.now())
    setQrUrl(await QRCode.toDataURL(next.qrPayload, { margin: 1, width: 240 }))
  })

  const revoke = (deviceId: string) => void run(async () => {
    await invoke('remote_revoke_device', { deviceId })
    await refresh()
  })

  const regenerate = () => {
    if (!window.confirm('인증서를 재생성하면 페어링된 모든 기기가 해제되며 다시 페어링해야 합니다. 계속할까요?')) return
    void run(async () => {
      const next = await invoke<RemoteStatus>('remote_regenerate_identity')
      setStatus(next)
      setPairing(null)
      setQrUrl('')
    })
  }

  return (
    <section className="settings-section remote-settings">
      <div className="settings-section-heading">
        <div>
          <h2>Remote access</h2>
          <p>TLS와 인증서 고정으로 Android 기기에서 현재 VibeLink 워크스페이스에 연결합니다.</p>
        </div>
        <span className={`remote-state remote-state-${status?.running ? 'running' : 'stopped'}`}>
          {status?.running ? 'running' : 'stopped'}
        </span>
      </div>

      <div className="remote-status-grid">
        <div><span>Server</span><strong>{status?.enabled ? 'Enabled' : 'Disabled'}</strong></div>
        <div><span>Hosts</span><strong>{status?.hosts.length ? status.hosts.join(', ') : 'No LAN address'}</strong></div>
        <div><span>Fingerprint</span><code title={status?.fingerprint}>{status?.fingerprint ? `${status.fingerprint.slice(0, 18)}…` : 'Loading…'}</code></div>
      </div>

      <div className="remote-actions">
        <button type="button" disabled={busy || !status} onClick={toggleEnabled}><Wifi size={14} /> {status?.enabled ? 'Disable remote' : 'Enable remote'}</button>
        <label>Port<input aria-label="Remote port" type="number" min="1024" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label>
        <button type="button" disabled={busy || Number(port) === status?.port} onClick={savePort}>Apply port</button>
        <button type="button" title="Refresh status" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={14} /> Refresh</button>
      </div>

      <div className="remote-pairing-panel">
        <button type="button" disabled={busy || !status?.running} onClick={createPairing}><Smartphone size={14} /> 페어링 QR 표시</button>
        {pairing ? (
          <div className="remote-pairing-content">
            {qrUrl ? <img src={qrUrl} width={240} height={240} alt="VibeLink Mobile pairing QR" /> : null}
            <div><span>Pairing code</span><strong>{pairing.code}</strong><small>{expiresIn > 0 ? `${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, '0')} 후 만료` : '만료됨'}</small></div>
          </div>
        ) : null}
      </div>

      <div className="remote-device-list">
        <h3>Paired devices</h3>
        {status?.devices.length ? status.devices.map((device) => (
          <div className="remote-device-row" key={device.id}>
            <div><strong>{device.name}</strong><span>Last seen {new Date(device.lastSeenAt * 1000).toLocaleString()}</span></div>
            <button type="button" title={`Revoke ${device.name}`} disabled={busy} onClick={() => revoke(device.id)}><Trash2 size={14} /> Revoke</button>
          </div>
        )) : <p className="vibelink-settings-note">페어링된 기기가 없습니다.</p>}
      </div>

      <button type="button" className="remote-danger" disabled={busy} onClick={regenerate}><ShieldAlert size={14} /> 인증서 재생성</button>
      <div className="remote-hints">
        <span>Windows 방화벽에서 선택한 포트의 인바운드 연결을 허용해야 합니다.</span>
        <span>원격 접속은 VibeLink 실행 중에만 동작합니다.</span>
      </div>
      {message ? <p className="settings-error">{message}</p> : null}
    </section>
  )
}

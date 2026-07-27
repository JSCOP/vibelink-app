import { invoke } from '@tauri-apps/api/core'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { RefreshCw, ShieldAlert, ShieldCheck, Smartphone, Trash2, Wifi } from 'lucide-react'
import { confirmDialog } from './appDialogStore'

type RemoteDevice = { id: string; name: string; createdAt: number; lastSeenAt: number }
type RemoteStatus = {
  enabled: boolean
  running: boolean
  port: number
  lanEnabled: boolean
  fingerprint: string
  hosts: string[]
  devices: RemoteDevice[]
}
type PairingPayload = { code: string; expiresAt: number; qrPayload: string }

async function readRemoteStatusAndFirewall() {
  const status = await invoke<RemoteStatus>('remote_get_status')
  const firewallReady = await invoke<boolean>('remote_firewall_status', { port: status.port }).catch(() => null)
  return { status, firewallReady }
}

export function RemoteSettings() {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [port, setPort] = useState('42811')
  const [pairing, setPairing] = useState<PairingPayload | null>(null)
  const [qrUrl, setQrUrl] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  // Keyed by port: a rule proves nothing about a port it was not created for.
  const [firewall, setFirewall] = useState<{ port: number | null; ready: boolean | null }>({ port: null, ready: null })

  const applyStatus = (next: RemoteStatus) => {
    setStatus(next)
    setPort(String(next.port))
  }

  const refresh = async () => {
    const next = await readRemoteStatusAndFirewall()
    applyStatus(next.status)
    setFirewall({ port: next.status.port, ready: next.firewallReady })
  }

  useEffect(() => {
    let active = true
    void readRemoteStatusAndFirewall().then((next) => {
      if (!active) return
      setStatus(next.status)
      setPort(String(next.status.port))
      setFirewall({ port: next.status.port, ready: next.firewallReady })
    }).catch((error) => {
      if (active) setMessage(String(error))
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    if (!pairing) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [pairing])

  const expiresIn = useMemo(() => pairing ? Math.max(0, pairing.expiresAt - Math.floor(now / 1000)) : 0, [now, pairing])
  // A rule confirmed for a different port says nothing about the current one.
  const ruleReady = firewall.port === status?.port && firewall.ready === true

  const run = async (action: () => Promise<void>) => {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(String(error)) } finally { setBusy(false) }
  }

  // Fail-closed gate in front of every inbound bind. Windows raises its listen
  // prompt the moment a LAN socket opens without a matching rule, so the rule
  // is installed and confirmed BEFORE the native call that starts listening.
  const ensureFirewallRule = async (targetPort: number) => {
    const ready = await invoke<boolean>('remote_firewall_status', { port: targetPort }).catch(() => false)
    if (ready) {
      setFirewall({ port: targetPort, ready: true })
      return
    }
    const configured = await invoke<boolean>('remote_setup_firewall', { port: targetPort })
    setFirewall({ port: targetPort, ready: configured })
    if (!configured) throw new Error(`포트 ${targetPort}의 Private 네트워크 인바운드 규칙이 없어 LAN 접속을 시작하지 않았습니다.`)
  }

  const setupFirewall = () => void run(async () => {
    if (status) await ensureFirewallRule(status.port)
  })

  const toggleEnabled = () => void run(async () => {
    const current = status
    if (!current) return
    if (current.running) {
      // Shutting the server down closes sockets; it must never ask for elevation.
      applyStatus(await invoke<RemoteStatus>('remote_set_enabled', { enabled: false }))
      return
    }
    if (current.lanEnabled) await ensureFirewallRule(current.port)
    applyStatus(await invoke<RemoteStatus>('remote_set_enabled', { enabled: true }))
  })

  const savePort = () => void run(async () => {
    const nextPort = Number(port)
    if (!Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) {
      throw new Error('포트는 1024–65535 범위의 정수여야 합니다.')
    }
    // A LAN server rebinds on the new port, so that port needs its own rule first.
    if (status?.lanEnabled) await ensureFirewallRule(nextPort)
    applyStatus(await invoke<RemoteStatus>('remote_set_port', { port: nextPort }))
  })

  const toggleLan = () => void run(async () => {
    const current = status
    if (!current) return
    if (current.lanEnabled) {
      // Narrowing back to loopback needs no rule and no elevation.
      applyStatus(await invoke<RemoteStatus>('remote_set_lan_enabled', { lanEnabled: false }))
      return
    }
    await ensureFirewallRule(current.port)
    applyStatus(await invoke<RemoteStatus>('remote_set_lan_enabled', { lanEnabled: true }))
  })

  const createPairing = (legacy = false) => void run(async () => {
    let current = status
    if (!current?.lanEnabled) throw new Error('Enable LAN/VPN access before creating a pairing code.')
    if (!current.running) {
      // Auto-start is still a LAN bind: clear the rule before starting it.
      await ensureFirewallRule(current.port)
      current = await invoke<RemoteStatus>('remote_set_enabled', { enabled: true })
      applyStatus(current)
    }
    const next = await invoke<PairingPayload>(legacy ? 'remote_create_pairing' : 'remote_create_pairing_v2')
    setPairing(next)
    setNow(Date.now())
    // margin 4 = the QR spec's minimum quiet zone; the dense multi-host JSON
    // payload needs it plus a large optical size for phone cameras to lock on.
    setQrUrl(await QRCode.toDataURL(next.qrPayload, { margin: 4, width: 720 }))
  })

  const revoke = (deviceId: string) => void run(async () => {
    await invoke('remote_revoke_device', { deviceId })
    await refresh()
  })

  const regenerate = async () => {
    const confirmed = await confirmDialog({
      title: '인증서 재생성',
      message: '인증서를 재생성하면 페어링된 모든 기기가 해제되며 다시 페어링해야 합니다. 계속할까요?',
      confirmLabel: '재생성',
      cancelLabel: '취소',
      danger: true,
    })
    if (!confirmed) return
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
          <p>Remote v2는 TLS 인증서 고정과 Noise 종단간 암호화로 모바일, 브라우저, 오케스트레이션을 연결합니다.</p>
        </div>
        <span className={`remote-state remote-state-${status?.running ? 'running' : 'stopped'}`}>
          {status?.running ? 'running' : 'stopped'}
        </span>
      </div>

      <div className="remote-status-grid">
        <div><span>Server</span><strong>{status?.running ? 'Running' : 'Stopped'}</strong></div>
        <div><span>Scope</span><strong>{status?.lanEnabled ? 'LAN / VPN' : 'This PC only'}</strong></div>
        <div><span>Fingerprint</span><code title={status?.fingerprint}>{status?.fingerprint ? `${status.fingerprint.slice(0, 18)}…` : 'Loading…'}</code></div>
      </div>

      <div className="remote-actions">
        <button type="button" disabled={busy || !status} onClick={toggleEnabled}><Wifi size={14} /> {status?.running ? 'Disable remote' : 'Enable remote'}</button>
        <button type="button" disabled={busy || !status} onClick={toggleLan}>{status?.lanEnabled ? 'Disable LAN/VPN' : 'Enable LAN/VPN'}</button>
        <label>Port<input aria-label="Remote port" type="number" min="1024" max="65535" value={port} onChange={(event) => setPort(event.target.value)} /></label>
        <button type="button" disabled={busy || Number(port) === status?.port} onClick={savePort}>Apply port</button>
        <button type="button" title="Refresh status" disabled={busy} onClick={() => void run(refresh)}><RefreshCw size={14} /> Refresh</button>
      </div>

      <div className="remote-pairing-panel">
        <button type="button" disabled={busy || !status || !status.lanEnabled} onClick={() => createPairing(false)}><Smartphone size={14} /> Remote v2 QR</button>
        <button type="button" disabled={busy || !status || !status.lanEnabled} onClick={() => createPairing(true)}>Legacy v1 QR</button>
        {!status?.lanEnabled ? <p className="vibelink-settings-note">LAN/VPN access is off by default. Enable it explicitly before pairing a phone.</p> : !status.running ? <p className="vibelink-settings-note">서버가 꺼져 있으면 QR 생성 시 Private 네트워크 인바운드 규칙을 먼저 확인한 뒤 자동으로 켜집니다.</p> : null}
        {pairing ? (
          <div className="remote-pairing-content">
            {qrUrl ? <img src={qrUrl} width={360} height={360} alt="VibeLink Mobile pairing QR" /> : null}
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

      <button type="button" className="remote-danger" disabled={busy} onClick={() => void regenerate()}><ShieldAlert size={14} /> 인증서 재생성</button>
      {status?.lanEnabled ? <div className="remote-firewall-row">
        {ruleReady ? <span className="remote-firewall-ok"><ShieldCheck size={14} /> 포트 {status.port} Private 네트워크 인바운드 규칙이 설정되어 있습니다.</span> : <>
          <span className="remote-firewall-warn"><ShieldAlert size={14} /> 포트 {status.port} Private 네트워크 인바운드 허용 규칙이 필요합니다.</span>
          <button type="button" disabled={busy} onClick={setupFirewall}>방화벽 자동 설정</button>
        </>}
      </div> : null}
      <div className="remote-hints">
        <span>방화벽 규칙은 Private(개인) 네트워크 프로필의 인바운드 접속만 허용하며, 관리자 승인(UAC) 창을 한 번 표시합니다.</span>
        <span>LAN 접속을 켜거나 포트를 바꾸기 전에 해당 포트 규칙을 먼저 확인합니다. LAN을 끄거나 서버를 중지할 때는 승인이 필요하지 않습니다.</span>
        {import.meta.env.DEV ? <span>개발 빌드의 Remote는 온디맨드입니다. 여기서 직접 켜기 전에는 시작되지 않으며, 자동 시작은 `VIBELINK_REMOTE_AUTOSTART=1`에서만 동작합니다.</span> : null}
        <span>원격 접속은 VibeLink 실행 중에만 동작합니다.</span>
      </div>
      {message ? <p className="settings-error">{message}</p> : null}
    </section>
  )
}

import { invoke } from '@tauri-apps/api/core'
import QRCode from 'qrcode'
import { useEffect, useMemo, useState } from 'react'
import { Clock3, Fingerprint, Hash, KeyRound, MonitorSmartphone, Network, QrCode, RefreshCw, ShieldAlert, ShieldCheck, Smartphone, Trash2, Wifi } from 'lucide-react'
import { confirmDialog } from './appDialogStore'
import { SettingsButton, SettingsCard, SettingsIconButton, SettingsMessage, SettingsNumber, SettingsPill, SettingsRow, SettingsSwitch, SettingsValue } from './settings/controls'

type RemoteDevice = { id: string; name: string; createdAt: number; lastSeenAt: number; grants: string[] }

/** Order matches the remote-v2 capability list; admin last and clearly marked. */
const GRANT_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'terminal.view', label: '터미널 보기' },
  { id: 'terminal.input', label: '터미널 입력' },
  { id: 'orchestration.view', label: '에이전트/런 보기' },
  { id: 'orchestration.control', label: '에이전트/런 제어' },
  { id: 'files.view', label: '파일 보기' },
  { id: 'git.write', label: 'Git 쓰기' },
  { id: 'browser.view', label: '브라우저 보기' },
  { id: 'browser.control', label: '브라우저 제어' },
  { id: 'admin', label: '관리자(모든 권한)' },
]
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
    if (!configured) throw new Error(`포트 ${targetPort}의 인바운드 방화벽 규칙이 없어 LAN 접속을 시작하지 않았습니다.`)
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

  const toggleGrant = (device: RemoteDevice, grant: string) => void run(async () => {
    const next = device.grants.includes(grant)
      ? device.grants.filter((value) => value !== grant)
      : [...device.grants, grant]
    const confirmed = await confirmDialog({
      title: '기기 권한 변경',
      message: `${device.name}의 권한을 저장하면 기기 연결이 끊기고 다시 연결됩니다.`,
      confirmLabel: '저장',
    })
    if (!confirmed) return
    await invoke('remote_set_device_grants', { deviceId: device.id, grants: next })
    await refresh()
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
    <>
      <SettingsCard
        icon={Wifi}
        title="원격 접속"
        hint="원격 접속은 VibeLink 실행 중에만 동작합니다."
        status={<SettingsPill tone={status?.running ? 'ok' : undefined}>{status?.running ? 'running' : 'stopped'}</SettingsPill>}
      >
        <SettingsRow
          icon={Wifi}
          label="원격 서버"
          control={<SettingsSwitch label="원격 서버" checked={status?.running ?? false} disabled={busy || !status} onChange={toggleEnabled} />}
        />
        <SettingsRow
          icon={Network}
          label="LAN / VPN"
          hint="LAN을 켜거나 포트를 바꾸기 전에 방화벽 규칙을 확인하며, 끌 때는 승인이 필요하지 않습니다."
          control={<SettingsSwitch label="LAN / VPN" checked={status?.lanEnabled ?? false} disabled={busy || !status} onChange={toggleLan} />}
        />
        <SettingsRow
          icon={Hash}
          label="포트"
          control={<>
            <SettingsNumber label="Remote port" value={Number(port)} min={1024} max={65535} disabled={busy || !status} onChange={(value) => setPort(String(value))} />
            <SettingsButton label="적용" disabled={busy || !status || Number(port) === status.port} onClick={savePort} />
          </>}
        />
        <SettingsRow
          icon={Fingerprint}
          label="인증서 지문"
          control={<>
            <SettingsValue mono value={status?.fingerprint ? `${status.fingerprint.slice(0, 18)}…` : 'Loading…'} title={status?.fingerprint} />
            <SettingsIconButton icon={RefreshCw} label="Refresh" disabled={busy} onClick={() => void run(refresh)} />
          </>}
        />
        {message ? <SettingsMessage tone="danger">{message}</SettingsMessage> : null}
      </SettingsCard>

      <SettingsCard
        icon={Smartphone}
        title="기기 페어링"
        hint={import.meta.env.DEV
          ? '개발 빌드 Remote는 온디맨드이며 VIBELINK_REMOTE_AUTOSTART=1에서만 자동 시작됩니다.'
          : 'Remote v2는 TLS 인증서 고정과 Noise 종단간 암호화를 사용합니다.'}
      >
        <div className="vl-set-actions">
          <SettingsButton
            icon={QrCode}
            label="QR 생성"
            title="Remote v2 QR"
            disabled={busy || !status || !status.lanEnabled}
            onClick={() => createPairing(false)}
          />
          <SettingsButton
            label="레거시 v1"
            title="Legacy v1 QR"
            disabled={busy || !status || !status.lanEnabled}
            onClick={() => createPairing(true)}
          />
        </div>
        {pairing ? (
          <>
            {qrUrl ? (
              <SettingsRow
                icon={QrCode}
                label="QR 코드"
                stacked
                control={<img
                  src={qrUrl}
                  width={240}
                  height={240}
                  alt="VibeLink Mobile pairing QR"
                  style={{ background: '#fff', borderRadius: 6, flex: '0 1 240px', height: 'auto', imageRendering: 'pixelated', maxWidth: '100%', width: 240 }}
                />}
              />
            ) : null}
            <SettingsRow icon={KeyRound} label="페어링 코드" control={<SettingsValue mono value={pairing.code} />} />
            <SettingsRow icon={Clock3} label="만료" control={<SettingsValue value={expiresIn > 0 ? `${Math.floor(expiresIn / 60)}:${String(expiresIn % 60).padStart(2, '0')}` : '만료됨'} />} />
          </>
        ) : null}
      </SettingsCard>

      <SettingsCard icon={MonitorSmartphone} title="페어링된 기기">
        {status?.devices.length ? status.devices.map((device) => (
          <div key={device.id} className="remote-device-entry">
            <SettingsRow
              icon={Smartphone}
              label={device.name}
              sub={`Last seen ${new Date(device.lastSeenAt * 1000).toLocaleString()}`}
              control={<SettingsIconButton icon={Trash2} label={`Revoke ${device.name}`} tone="danger" disabled={busy} onClick={() => revoke(device.id)} />}
            />
            <div className="remote-grant-editor" role="group" aria-label={`${device.name} 권한`}>
              {GRANT_OPTIONS.map((grant) => (
                <label key={grant.id} className={device.grants.includes(grant.id) ? 'is-granted' : undefined}>
                  <input
                    type="checkbox"
                    checked={device.grants.includes(grant.id)}
                    disabled={busy}
                    onChange={() => toggleGrant(device, grant.id)}
                  />
                  {grant.label}
                </label>
              ))}
            </div>
          </div>
        )) : <SettingsMessage>페어링된 기기 없음</SettingsMessage>}
      </SettingsCard>

      <SettingsCard
        icon={ShieldAlert}
        title="보안"
        hint="인바운드 방화벽 규칙(로컬 서브넷 + Tailscale)을 만들 때 관리자 승인(UAC)이 한 번 필요합니다."
      >
        <SettingsRow
          icon={ruleReady ? ShieldCheck : ShieldAlert}
          label="방화벽"
          control={<>
            <SettingsPill tone={ruleReady ? 'ok' : firewall.ready === false ? 'danger' : 'warn'}>
              {ruleReady ? `설정됨 · ${status?.port}` : firewall.ready === false ? `필요 · ${status?.port ?? '—'}` : '확인 중'}
            </SettingsPill>
            {!ruleReady && status ? <SettingsButton label="방화벽 설정" disabled={busy} onClick={setupFirewall} /> : null}
          </>}
        />
        <div className="vl-set-actions vl-set-actions-bordered">
          <SettingsButton icon={ShieldAlert} label="인증서 재생성" tone="danger" disabled={busy} onClick={() => void regenerate()} />
        </div>
      </SettingsCard>
    </>
  )
}

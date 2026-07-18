import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../state/store'
import { AccountSignIn } from './AccountSignIn'

export function LicenseSettings() {
  const license = useWorkspaceStore((state) => state.license)
  const deactivate = useWorkspaceStore((state) => state.deactivateLicenseDevice)
  const revalidate = useWorkspaceStore((state) => state.revalidateLicense)
  const signOut = useWorkspaceStore((state) => state.signOutAccount)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const status = license.status
  const signedIn = Boolean(status?.email)
  const plan = status?.plan ?? (status?.entitled ? 'pro' : 'none')
  const trialEndsAt = status?.trialEndsAt
  const [nowMs, setNowMs] = useState<number | null>(null)

  useEffect(() => {
    if (!trialEndsAt) return
    const updateNow = () => setNowMs(Date.now())
    const initialTimer = window.setTimeout(updateNow, 0)
    const interval = window.setInterval(updateNow, 60_000)
    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(interval)
    }
  }, [trialEndsAt])

  const trialDaysLeft = trialEndsAt && nowMs !== null
    ? Math.max(0, Math.ceil((new Date(trialEndsAt).getTime() - nowMs) / (24 * 60 * 60 * 1000)))
    : null

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="settings-section license-settings">
      <div className="settings-section-heading">
        <div>
          <h2>Moobang account</h2>
          <p>Account actions run immediately and are not affected by Settings Apply or Cancel.</p>
        </div>
        <span className={`license-state license-state-${status?.state ?? 'loading'}`}>{signedIn ? plan : status?.state ?? 'loading'}</span>
      </div>

      {!signedIn ? <AccountSignIn /> : (
        <div className="license-summary">
          <strong>{status?.email}</strong>
          <span>{status?.message}</span>
          {plan === 'trial' && status?.trialEndsAt ? (
            <span>Trial ends {new Date(status.trialEndsAt).toLocaleDateString()}{trialDaysLeft !== null ? ` (${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left)` : ''}</span>
          ) : null}
          {status?.validatedAt ? <span>Validated {new Date(status.validatedAt).toLocaleString()}</span> : null}
          {status?.offlineGraceUntil ? <span>Offline grace until {new Date(status.offlineGraceUntil).toLocaleString()}</span> : null}
        </div>
      )}

      {signedIn && status?.devices.length ? (
        <div className="license-device-list">
          {status.devices.map((device) => (
            <div className="license-device-row" key={device.activationId}>
              <div>
                <strong>{device.deviceName}{device.current ? ' · Current' : ''}</strong>
                <span>{device.appVersion} · {device.status}</span>
              </div>
              {device.status !== 'deactivated' ? (
                <button disabled={busy} onClick={() => void run(() => deactivate(device.activationId))}>Remove</button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {signedIn ? (
        <div className="license-actions">
          <button disabled={busy} onClick={() => void run(revalidate)}>Refresh account</button>
          {!status?.entitled ? <button onClick={() => void invoke('open_path', { path: status?.purchaseUrl })}>Buy VibeLink Pro</button> : null}
          <button disabled={busy} onClick={() => {
            if (window.confirm('Sign out of this Moobang account on this device?')) void run(signOut)
          }}>Sign out</button>
        </div>
      ) : null}
      {message ? <p className="settings-error">{message}</p> : null}
    </section>
  )
}

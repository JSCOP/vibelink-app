import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { useWorkspaceStore } from '../state/store'
import { LicenseActivationForm } from './LicenseActivationForm'

export function LicenseSettings() {
  const license = useWorkspaceStore((state) => state.license)
  const deactivate = useWorkspaceStore((state) => state.deactivateLicenseDevice)
  const forget = useWorkspaceStore((state) => state.forgetLocalLicense)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const status = license.status

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
          <h2>VibeLink Pro license</h2>
          <p>License actions run immediately and are not affected by Settings Apply or Cancel.</p>
        </div>
        <span className={`license-state license-state-${status?.state ?? 'loading'}`}>{status?.state ?? 'loading'}</span>
      </div>

      <LicenseActivationForm />

      <div className="license-device-list">
        {status?.devices.map((device) => (
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

      <div className="license-actions">
        {!status?.entitled ? <button onClick={() => void invoke('open_path', { path: status?.purchaseUrl })}>Get VibeLink Pro</button> : null}
        {status && ['invalid', 'revoked', 'configurationError'].includes(status.state) ? (
          <button disabled={busy} onClick={() => {
            if (window.confirm('Forget the local credential? This does not release a provider device slot.')) void run(forget)
          }}>Forget local</button>
        ) : null}
      </div>
      {message ? <p className="settings-error">{message}</p> : null}
    </section>
  )
}

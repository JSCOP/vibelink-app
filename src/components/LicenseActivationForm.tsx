import { useState } from 'react'
import { useWorkspaceStore } from '../state/store'

type LicenseActivationFormProps = {
  onActivated?: () => void
  showRevalidate?: boolean
}

export function LicenseActivationForm({ onActivated, showRevalidate = true }: LicenseActivationFormProps) {
  const license = useWorkspaceStore((state) => state.license)
  const activate = useWorkspaceStore((state) => state.activateLicense)
  const revalidate = useWorkspaceStore((state) => state.revalidateLicense)
  const [licenseKey, setLicenseKey] = useState('')
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
    <div className="license-activation-form">
      <div className="license-summary">
        <strong>{status?.maskedKey ?? 'No license activated'}</strong>
        <span>{status?.message ?? 'Checking license…'}</span>
        {status?.validatedAt ? <span>Validated {new Date(status.validatedAt).toLocaleString()}</span> : null}
        {status?.offlineGraceUntil ? <span>Offline grace until {new Date(status.offlineGraceUntil).toLocaleString()}</span> : null}
      </div>
      <div className="license-activate-row">
        <input
          aria-label="VibeLink Pro license key"
          value={licenseKey}
          onChange={(event) => setLicenseKey(event.target.value)}
          placeholder="VBL-••••-••••-••••-•••• or Lemon license key"
          autoComplete="off"
          spellCheck={false}
          disabled={busy}
        />
        <button disabled={busy || licenseKey.trim().length === 0} onClick={() => void run(async () => {
          await activate(licenseKey)
          setLicenseKey('')
          onActivated?.()
        })}>Activate</button>
        {showRevalidate ? <button disabled={busy || !status?.activationId} onClick={() => void run(revalidate)}>Revalidate</button> : null}
      </div>
      {message ? <p className="settings-error">{message}</p> : null}
    </div>
  )
}

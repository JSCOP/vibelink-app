import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../state/store'
import { BadgeCheck, CalendarDays, CircleUser, Clock3, FlaskConical, Laptop, LogOut, Mail, MonitorSmartphone, RefreshCw, ShoppingCart, Trash2, WifiOff } from 'lucide-react'
import { AccountSignIn } from './AccountSignIn'
import { confirmDialog } from './appDialogStore'
import { SettingsButton, SettingsCard, SettingsIconButton, SettingsMessage, SettingsPill, SettingsRow, SettingsValue } from './settings/controls'

export function LicenseSettings() {
  const license = useWorkspaceStore((state) => state.license)
  const deactivate = useWorkspaceStore((state) => state.deactivateLicenseDevice)
  const revalidate = useWorkspaceStore((state) => state.revalidateLicense)
  const signOut = useWorkspaceStore((state) => state.signOutAccount)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const status = license.status
  const development = status?.state === 'development'
  const signedIn = !development && Boolean(status?.email)
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

  const stateLabel = development ? 'development' : signedIn ? plan : status?.state ?? 'loading'
  // A null status means the license query has not resolved yet, so the pill
  // stays neutral instead of claiming a problem.
  const stateTone = plan === 'trial'
    ? 'warn'
    : development || status?.entitled
      ? 'ok'
      : status
        ? 'danger'
        : undefined
  const trialEndValue = trialEndsAt
    ? `${new Date(trialEndsAt).toLocaleDateString()}${trialDaysLeft !== null ? ` · ${trialDaysLeft} day${trialDaysLeft === 1 ? '' : 's'} left` : ''}`
    : '—'

  return (
    <>
      <SettingsCard
        icon={CircleUser}
        title="Moobang account"
        hint="Account actions run immediately and are not affected by Settings Apply or Cancel."
        status={<SettingsPill tone={stateTone}>{stateLabel}</SettingsPill>}
      >
        {development ? (
          <>
            <SettingsRow icon={FlaskConical} label="Build" control={<SettingsValue value="Development build" />} />
            <SettingsRow icon={BadgeCheck} label="Entitlement" sub={status?.message} control={<SettingsValue value="Enabled" />} />
            <SettingsRow
              icon={FlaskConical}
              label="License test"
              hint="Set this environment variable before launch to test the real sign-in and trial lock."
              control={<SettingsValue mono value="VIBELINK_ENFORCE_LICENSE=1" />}
            />
          </>
        ) : !signedIn ? <AccountSignIn /> : (
          <>
            <SettingsRow icon={Mail} label="Email" control={<SettingsValue value={status?.email ?? '—'} />} />
            <SettingsRow icon={BadgeCheck} label="Plan" sub={status?.message} control={<SettingsValue value={plan === 'none' ? 'None' : `${plan[0].toUpperCase()}${plan.slice(1)}`} />} />
            <SettingsRow icon={CalendarDays} label="Trial end" control={<SettingsValue value={trialEndValue} />} />
            <SettingsRow icon={Clock3} label="Last validated" control={<SettingsValue value={status?.validatedAt ? new Date(status.validatedAt).toLocaleString() : '—'} />} />
            <SettingsRow icon={WifiOff} label="Offline grace" control={<SettingsValue value={status?.offlineGraceUntil ? new Date(status.offlineGraceUntil).toLocaleString() : '—'} />} />
            <div className="vl-set-actions vl-set-actions-bordered">
              <SettingsButton icon={RefreshCw} label="Refresh" disabled={busy} onClick={() => void run(revalidate)} />
              {!status?.entitled ? <SettingsButton icon={ShoppingCart} label="Buy Pro" tone="accent" onClick={() => void invoke('open_path', { path: status?.purchaseUrl })} /> : null}
              <SettingsButton icon={LogOut} label="Sign out" disabled={busy} onClick={() => {
                void confirmDialog({ title: 'Sign out', message: 'Sign out of this Moobang account on this device?', confirmLabel: 'Sign out' })
                  .then((confirmed) => { if (confirmed) return run(signOut) })
              }} />
            </div>
          </>
        )}
        {message ? <SettingsMessage tone="danger">{message}</SettingsMessage> : null}
      </SettingsCard>

      {signedIn ? (
        <SettingsCard icon={MonitorSmartphone} title="Devices">
          {status?.devices.length ? status.devices.map((device) => (
            <SettingsRow
              key={device.activationId}
              icon={Laptop}
              label={device.deviceName}
              sub={`${device.appVersion} · ${device.status}`}
              control={<>
                {device.current ? <SettingsPill tone="ok">Current</SettingsPill> : null}
                {device.status !== 'deactivated' ? (
                  <SettingsIconButton icon={Trash2} label={`Remove ${device.deviceName}`} disabled={busy} onClick={() => void run(() => deactivate(device.activationId))} />
                ) : null}
              </>}
            />
          )) : <SettingsMessage>No devices</SettingsMessage>}
        </SettingsCard>
      ) : null}
    </>
  )
}

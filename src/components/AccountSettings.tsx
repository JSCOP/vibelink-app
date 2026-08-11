import { useState } from 'react'
import { CircleUser, LogOut, Mail } from 'lucide-react'
import { useWorkspaceStore } from '../state/store'
import { AccountSignIn } from './AccountSignIn'
import { confirmDialog } from './appDialogStore'
import { SettingsButton, SettingsCard, SettingsMessage, SettingsPill, SettingsRow, SettingsValue } from './settings/controls'

export function AccountSettings() {
  const account = useWorkspaceStore((state) => state.account)
  const signOut = useWorkspaceStore((state) => state.signOutAccount)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const status = account.status
  const signedIn = status?.signedIn === true

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
    <SettingsCard
      icon={CircleUser}
      title="Moobang account"
      hint="VibeLink is free and open source. Sign in only to send bug reports."
      status={<SettingsPill tone={signedIn ? 'ok' : undefined}>{account.ready ? (signedIn ? 'Signed in' : 'Signed out') : 'Loading'}</SettingsPill>}
    >
      {!signedIn ? <AccountSignIn /> : (
        <>
          {status?.email ? <SettingsRow icon={Mail} label="Email" control={<SettingsValue value={status.email} />} /> : null}
          <div className="vl-set-actions vl-set-actions-bordered">
            <SettingsButton icon={LogOut} label="Sign out" disabled={busy} onClick={() => {
              void confirmDialog({ title: 'Sign out', message: 'Sign out of this Moobang account on this device?', confirmLabel: 'Sign out' })
                .then((confirmed) => { if (confirmed) return run(signOut) })
            }} />
          </div>
        </>
      )}
      {message ? <SettingsMessage tone="danger">{message}</SettingsMessage> : null}
    </SettingsCard>
  )
}

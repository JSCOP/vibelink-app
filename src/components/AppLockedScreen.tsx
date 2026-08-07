import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import { AccountSignIn } from './AccountSignIn'
import { appLockReason, lockScreenCopy, type LockScreenAction } from '../state/lockScreenCopy'
import { useWorkspaceStore } from '../state/store'

type AppLockedScreenProps = {
  onReportBug?: () => void
}

export function AppLockedScreen({ onReportBug }: AppLockedScreenProps) {
  const status = useWorkspaceStore((state) => state.license.status)
  const revalidateLicense = useWorkspaceStore((state) => state.revalidateLicense)
  const signOutAccount = useWorkspaceStore((state) => state.signOutAccount)
  const [busyAction, setBusyAction] = useState<'refresh' | 'switchAccount' | null>(null)
  const purchaseUrl = status?.purchaseUrl.trim() ?? ''
  const copy = lockScreenCopy(appLockReason(status?.state), purchaseUrl.length > 0)

  const refresh = async () => {
    setBusyAction('refresh')
    try {
      await revalidateLicense()
    } finally {
      setBusyAction(null)
    }
  }

  const switchAccount = async () => {
    setBusyAction('switchAccount')
    try {
      await signOutAccount()
    } finally {
      setBusyAction(null)
    }
  }

  const renderAction = (action: LockScreenAction, primary: boolean) => {
    if (action.kind === 'signIn') return <AccountSignIn onActivated={() => { void refresh() }} />
    const onClick = action.available
      ? action.kind === 'purchase'
        ? () => { void invoke('open_path', { path: purchaseUrl }) }
        : action.kind === 'refresh'
          ? () => { void refresh() }
          : () => { void switchAccount() }
      : undefined
    return (
      <button type="button" className={primary ? 'primary-action' : undefined} disabled={busyAction !== null || !action.available} onClick={onClick}>
        {action.label}
      </button>
    )
  }

  return (
    <div className="app-locked-screen" role="dialog" aria-modal="true" aria-label="VibeLink locked">
      <div className="app-locked-card">
        <LockKeyhole size={32} />
        <h1>{copy.heading}</h1>
        <p>{copy.body}</p>
        <div className="app-locked-actions">
          {renderAction(copy.primary, true)}
          {copy.secondary ? renderAction(copy.secondary, false) : null}
          {onReportBug ? <button type="button" disabled={busyAction !== null} onClick={onReportBug}>Report a bug</button> : null}
        </div>
        {!copy.primary.available ? <p className="settings-error" role="status">{copy.primary.unavailableReason}</p> : null}
        {status?.email ? <p className="app-locked-account">Signed in as {status.email}</p> : null}
      </div>
    </div>
  )
}

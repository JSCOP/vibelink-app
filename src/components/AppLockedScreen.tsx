import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import { AccountSignIn } from './AccountSignIn'
import { useWorkspaceStore } from '../state/store'


export function AppLockedScreen() {
  const status = useWorkspaceStore((state) => state.license.status)
  const revalidateLicense = useWorkspaceStore((state) => state.revalidateLicense)
  const signOutAccount = useWorkspaceStore((state) => state.signOutAccount)
  const [busyAction, setBusyAction] = useState<'refresh' | 'signOut' | null>(null)

  const signedOut = status?.state === 'unlicensed'
  const trialExpired = status?.state === 'trialExpired'

  const refresh = async () => {
    setBusyAction('refresh')
    try {
      await revalidateLicense()
    } finally {
      setBusyAction(null)
    }
  }

  const signOut = async () => {
    setBusyAction('signOut')
    try {
      await signOutAccount()
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="app-locked-screen" role="dialog" aria-modal="true" aria-label="VibeLink locked">
      <div className="app-locked-card">
        <LockKeyhole size={32} />
        {signedOut ? (
          <>
            <h1>Start your 7-day free trial</h1>
            <p>Sign in with your Moobang account to unlock every VibeLink feature free for 7 days. No card required.</p>
            <AccountSignIn onActivated={() => { void refresh() }} />
          </>
        ) : (
          <>
            <h1>{trialExpired ? 'Your 7-day VibeLink trial has ended' : 'VibeLink is locked'}</h1>
            {trialExpired ? (
              <>
                <p>Buy VibeLink to keep using every feature. Your workspaces stay in place.</p>
                <p>Use the same signed-in Moobang account to purchase. VibeLink will unlock within at most 70 seconds.</p>
              </>
            ) : (
              <p>VibeLink does not currently have an active account entitlement. Your workspaces stay in place while you refresh the account or switch to another Moobang account.</p>
            )}
            <div className="app-locked-actions">
              <button type="button" className="primary-action" disabled={busyAction !== null} onClick={() => void invoke('open_path', { path: status?.purchaseUrl })}>
                Buy VibeLink
              </button>
              <button type="button" disabled={busyAction !== null} onClick={() => void refresh()}>
                {busyAction === 'refresh' ? 'Refreshing account…' : 'I already purchased — Refresh account'}
              </button>
              <button type="button" disabled={busyAction !== null} onClick={() => void signOut()}>
                {busyAction === 'signOut' ? 'Signing out…' : 'Sign out / switch account'}
              </button>
            </div>
            {status?.email ? <p className="app-locked-account">Signed in as {status.email}</p> : null}
          </>
        )}
      </div>
    </div>
  )
}

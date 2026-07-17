import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { LockKeyhole } from 'lucide-react'
import { AccountSignIn } from './AccountSignIn'
import { useWorkspaceStore } from '../state/store'

function trialDaysLeft(trialEndsAt: string | null | undefined): number | null {
  if (!trialEndsAt) return null
  const ends = new Date(trialEndsAt).getTime()
  if (Number.isNaN(ends)) return null
  return Math.max(0, Math.ceil((ends - Date.now()) / (24 * 60 * 60 * 1000)))
}

export function AppLockedScreen() {
  const status = useWorkspaceStore((state) => state.license.status)
  const revalidateLicense = useWorkspaceStore((state) => state.revalidateLicense)
  const signOutAccount = useWorkspaceStore((state) => state.signOutAccount)
  const [busy, setBusy] = useState(false)

  // Signed out (or never signed in): the only path forward is the Moobang
  // device sign-in that starts the 7-day trial.
  const signedOut = !status?.email

  const refresh = async () => {
    setBusy(true)
    try {
      await revalidateLicense()
    } finally {
      setBusy(false)
    }
  }

  const signOut = async () => {
    setBusy(true)
    try {
      await signOutAccount()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="app-locked-screen" role="dialog" aria-modal="true" aria-label="VibeLink sign-in required">
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
            <h1>Your 7-day VibeLink trial has ended</h1>
            <p>
              {trialDaysLeft(status?.trialEndsAt) === 0
                ? 'Purchase VibeLink to keep using every feature. Your workspaces stay in place.'
                : (status?.message ?? 'Purchase VibeLink to continue.')}
            </p>
            <div className="app-locked-actions">
              <button type="button" className="primary-action" disabled={busy} onClick={() => void invoke('open_path', { path: status?.purchaseUrl })}>
                Purchase VibeLink
              </button>
              <button type="button" disabled={busy} onClick={() => void refresh()}>
                {busy ? 'Checking…' : 'Refresh status'}
              </button>
              <button type="button" disabled={busy} onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
            {status?.email ? <p className="app-locked-account">Signed in as {status.email}</p> : null}
          </>
        )}
      </div>
    </div>
  )
}

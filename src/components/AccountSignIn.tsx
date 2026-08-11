import { invoke } from '@tauri-apps/api/core'
import { useEffect, useState } from 'react'
import { pollAccountSignIn, startAccountSignIn, type AccountSignInStart } from '../ipc/account'
import { useWorkspaceStore } from '../state/store'

type AccountSignInProps = {
  onActivated?: () => void
}

type PendingSignIn = AccountSignInStart & { startedAt: number }

const signInTimeoutMs = 30 * 60 * 1_000

export function AccountSignIn({ onActivated }: AccountSignInProps) {
  const [pending, setPending] = useState<PendingSignIn | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!pending) return
    let cancelled = false
    let timer: number | undefined

    const poll = async () => {
      if (Date.now() - pending.startedAt >= signInTimeoutMs) {
        setPending(null)
        setMessage('This sign-in request expired. Start again to get a new code.')
        return
      }
      try {
        const result = await pollAccountSignIn(pending.deviceCode)
        if (cancelled) return
        if (result === 'pending') {
          timer = window.setTimeout(poll, Math.max(1, pending.interval) * 1_000)
          return
        }
        useWorkspaceStore.setState({ account: { ready: true, status: result } })
        setPending(null)
        if (result.signedIn !== true) {
          setMessage('Could not finish signing in to this Moobang account.')
          return
        }
        setMessage('Moobang account connected.')
        onActivated?.()
      } catch (error) {
        if (cancelled) return
        setPending(null)
        setMessage(String(error))
      }
    }

    timer = window.setTimeout(poll, Math.max(1, pending.interval) * 1_000)
    return () => {
      cancelled = true
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [onActivated, pending])

  const start = async () => {
    setBusy(true)
    setMessage('')
    try {
      const result = await startAccountSignIn()
      setPending({ ...result, startedAt: Date.now() })
      try {
        await invoke('open_path', { path: result.verificationUriComplete })
      } catch {
        setMessage('Could not open the browser automatically. Open the verification page and enter the code below.')
      }
    } catch (error) {
      setMessage(String(error))
    } finally {
      setBusy(false)
    }
  }

  const copyCode = async () => {
    if (!pending) return
    try {
      await navigator.clipboard.writeText(pending.userCode)
      setMessage('Code copied.')
    } catch {
      setMessage('Could not copy the code. Select it manually.')
    }
  }

  return (
    <div className="account-sign-in">
      {!pending ? (
        <button type="button" className="primary-action" disabled={busy} onClick={() => void start()}>
          {busy ? 'Starting sign-in…' : 'Sign in with Moobang account'}
        </button>
      ) : (
        <div className="account-sign-in-request" aria-live="polite">
          <span>Approve the sign-in in your browser.</span>
          <strong className="account-sign-in-code">{pending.userCode}</strong>
          <div className="license-actions">
            <button type="button" onClick={() => void copyCode()}>Copy code</button>
            <button type="button" onClick={() => setPending(null)}>Start over</button>
          </div>
          <span>Waiting for approval…</span>
        </div>
      )}
      {message ? <p className="settings-error" role="status">{message}</p> : null}
    </div>
  )
}

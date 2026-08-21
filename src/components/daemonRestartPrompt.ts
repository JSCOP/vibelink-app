import { useEffect, useRef } from 'react'
import { pendingDaemonRestart, restartDaemon, type DaemonRestartRequest } from '../ipc/daemonRestart'
import { confirmDialog } from './appDialogStore'
import { toast } from './toast/toastStore'

/** Offers the daemon restart an update left pending, once per app start.
 *
 *  An update no longer replaces a running daemon on its own: doing that stops every command in
 *  every pane, which is not a cost an installer gets to impose silently. The app keeps talking to
 *  the daemon that is already there — the protocol handshake proved they still understand each
 *  other — and asks here instead. Declining is not permanent: the backend keeps the offer, so
 *  Restart daemon in the resource monitor still performs it later. */
export function useDaemonRestartPrompt(): void {
  const asked = useRef(false)

  useEffect(() => {
    if (asked.current) return
    asked.current = true
    void (async () => {
      const request = await pendingDaemonRestart().catch(() => null)
      if (!request) return
      const confirmed = await confirmDialog({
        title: 'Restart the background service?',
        message: daemonRestartMessage(request),
        confirmLabel: 'Restart now',
        cancelLabel: 'Later',
      })
      if (!confirmed) return
      try {
        await restartDaemon()
      } catch (error) {
        toast.error(`The background service could not be restarted. ${String(error)}`)
      }
    })()
  }, [])
}

export function daemonRestartMessage(request: DaemonRestartRequest): string {
  const origin = request.fromVersion === null
    ? 'A background service from an earlier build is still running.'
    : `The background service is still the one from ${request.fromVersion}; this build is ${request.toVersion}.`
  // Say what it costs and what waiting costs, because both are real and neither is obvious.
  return `${origin} Restarting adopts this build's behaviour and stops every command currently running in your terminal panes. Choosing Later keeps them running; the offer stays available.`
}

import { useEffect, useRef } from 'react'
import { takeDaemonReplacement, type DaemonReplacement } from '../../ipc/daemonReplacement'
import { toast } from './toastStore'

const noticeDurationMs = 12_000

export function useDaemonReplacementNotice(): void {
  const requested = useRef(false)

  useEffect(() => {
    if (requested.current) return
    requested.current = true
    void takeDaemonReplacement().then((replacement) => {
      if (replacement) toast.info(daemonReplacementMessage(replacement), { durationMs: noticeDurationMs })
    }).catch(() => undefined)
  }, [])
}

function daemonReplacementMessage(payload: DaemonReplacement): string {
  const replacement = payload.fromVersion === null
    ? 'The update replaced a background service that predated this build.'
    : `The update replaced the background service (${payload.fromVersion} → ${payload.toVersion}).`
  const stopped = payload.terminatedPanes === 1
    ? 'A command running in 1 terminal pane was stopped.'
    : payload.terminatedPanes > 1
      ? `Commands running in ${payload.terminatedPanes} terminal panes were stopped.`
      : 'Any commands running in terminal panes were stopped.'
  return `${replacement} ${stopped}`
}

import { checkAppUpdate, type AppUpdateStatus } from '../../ipc/appUpdate'

const DISMISSED_STORAGE_KEY = 'vibelink.update.dismissedVersion'
/** Late enough that startup IPC, daemon attach, and the first paint are done. */
const FIRST_CHECK_DELAY_MS = 20_000
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000

const listeners = new Set<() => void>()

let latestStatus: AppUpdateStatus | null = null
let dismissedVersion = readDismissedVersion()
let snapshot: AppUpdateStatus | null = null
let running = false

function readDismissedVersion(): string | null {
  try {
    return window.localStorage.getItem(DISMISSED_STORAGE_KEY)
  } catch {
    return null
  }
}

/**
 * The card is shown only for an unreleased-to-this-install version the user has
 * not already dismissed, so a declined update never reappears until the next one.
 */
function recompute(): void {
  const next = latestStatus
    && latestStatus.updateAvailable
    && latestStatus.latestVersion !== dismissedVersion
    ? latestStatus
    : null
  if (next === snapshot) return
  snapshot = next
  for (const listener of listeners) listener()
}

export function setAppUpdateStatus(status: AppUpdateStatus | null): void {
  latestStatus = status
  // Fresh data is the natural point to re-read persisted dismissals, so a
  // dismissal made in another window is honoured on the next check.
  dismissedVersion = readDismissedVersion()
  recompute()
}

export function dismissAppUpdate(): void {
  if (!snapshot) return
  dismissedVersion = snapshot.latestVersion
  try {
    window.localStorage.setItem(DISMISSED_STORAGE_KEY, dismissedVersion)
  } catch {
    // A blocked write only costs the user a repeated notice on the next check;
    // the in-memory value still hides the card for this session.
  }
  recompute()
}

export function subscribeAppUpdate(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAppUpdateSnapshot(): AppUpdateStatus | null {
  return snapshot
}

/**
 * Polls the public release manifest. Every failure is silent: an update notice
 * is never important enough to interrupt a workspace with an error.
 */
export function startAppUpdateChecks(): () => void {
  if (running) return () => {}
  running = true
  let stopped = false
  let intervalId: number | undefined

  const check = () => {
    void checkAppUpdate()
      .then((status) => { if (!stopped) setAppUpdateStatus(status) })
      .catch(() => {})
  }
  const timeoutId = window.setTimeout(() => {
    check()
    intervalId = window.setInterval(check, CHECK_INTERVAL_MS)
  }, FIRST_CHECK_DELAY_MS)

  return () => {
    stopped = true
    running = false
    window.clearTimeout(timeoutId)
    if (intervalId !== undefined) window.clearInterval(intervalId)
  }
}

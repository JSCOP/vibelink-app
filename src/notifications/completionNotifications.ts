import { isPermissionGranted, requestPermission, sendNotification } from '@tauri-apps/plugin-notification'

export type CompletionNotificationSettings = {
  completionNotificationEnabled: boolean
  /** When false (the default), a finished pane the user is already looking at
   *  raises no toast — the on-screen highlight is the whole message there. */
  completionNotificationWhileFocused: boolean
}

type CompletionHighlight = { completedAt: number }

export type PaneCompletionNotification = {
  paneId: string
  paneTitle: string
  workspaceName: string
  agentName?: string
}

/** Panes whose completion alert is new since the previous store snapshot. */
export function newCompletionPaneIds(
  current: Readonly<Record<string, CompletionHighlight>>,
  previous: Readonly<Record<string, CompletionHighlight>>,
): string[] {
  return Object.entries(current)
    .filter(([paneId, highlight]) => previous[paneId]?.completedAt !== highlight.completedAt)
    .map(([paneId]) => paneId)
}

export type CompletionNotificationContext = {
  settings: CompletionNotificationSettings
  /** True when the VibeLink window has OS focus. */
  windowFocused: boolean
  /** True when the finished pane is the one the user is currently looking at. */
  paneVisible: boolean
}

/** A toast is for work the user is NOT watching. Suppressing the focused,
 *  visible case is what keeps the feature from becoming noise during an
 *  ordinary back-and-forth in a single pane. */
export function shouldRaiseCompletionNotification(context: CompletionNotificationContext): boolean {
  if (!context.settings.completionNotificationEnabled) return false
  if (context.settings.completionNotificationWhileFocused) return true
  return !(context.windowFocused && context.paneVisible)
}

export function completionNotificationText(event: PaneCompletionNotification): { title: string; body: string } {
  const agent = event.agentName?.trim()
  return {
    title: `${event.workspaceName} · ${event.paneTitle}`,
    body: agent ? `${agent} finished its turn.` : 'The agent finished its turn.',
  }
}

let permissionState: 'unknown' | 'granted' | 'denied' = 'unknown'

/** Reset for tests; the granted/denied answer is otherwise cached for the
 *  process because asking Windows on every completion is pure overhead. */
export function resetCompletionNotificationPermissionForTests(): void {
  permissionState = 'unknown'
}

async function ensurePermission(): Promise<boolean> {
  if (permissionState !== 'unknown') return permissionState === 'granted'
  const granted = (await isPermissionGranted()) || (await requestPermission()) === 'granted'
  permissionState = granted ? 'granted' : 'denied'
  return granted
}

/** Raise the OS notification for one finished agent turn.
 *
 *  Returns whether a toast was actually shown so callers (and tests) can tell
 *  suppression apart from a delivery failure. */
export async function notifyPaneCompletion(
  event: PaneCompletionNotification,
  context: CompletionNotificationContext,
): Promise<boolean> {
  if (!shouldRaiseCompletionNotification(context)) return false
  if (!(await ensurePermission())) return false
  sendNotification(completionNotificationText(event))
  return true
}

/** Debounced screen-content agent state detection per pane.
 *
 *  Output settles for `DETECT_DEBOUNCE_MS`, then the pane's trailing screen
 *  lines and last OSC title run through the herdr-ported rule engine and the
 *  result lands in the store's `paneScreenStates` slice, where the agent
 *  status dots and (later) the daemon projection consume it. */

import { invoke } from '@tauri-apps/api/core'
import { detectAgentScreenState } from './agentScreenDetect'
import { agentKindForPane } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'

const DETECT_DEBOUNCE_MS = 400
/** A pure debounce starves under sustained output (a build spamming stdout
 *  resets the timer forever); force an evaluation at least this often. */
const DETECT_MAX_WAIT_MS = 1_500
const SCREEN_LINES = 40

type ReadScreen = (paneId: string, maxLines: number) => string

const timers = new Map<string, number>()
const firstScheduledAt = new Map<string, number>()
const lastTitles = new Map<string, string>()
const lastReported = new Map<string, string | null>()
let readScreen: ReadScreen | null = null

/** Mirrors state changes to the daemon so attention snapshots (and remote
 *  clients) see screen-detected states for panes orchestration does not own.
 *  Fire-and-forget: a miss self-heals on the next change. */
function reportToDaemon(paneId: string, state: 'working' | 'blocked' | 'idle' | null): void {
  // A clear for a pane we never reported is a no-op, not an IPC call: every
  // plain shell pane would otherwise send one useless clear on first output.
  if (state === null && (lastReported.get(paneId) ?? null) === null) return
  if (lastReported.get(paneId) === state) return
  lastReported.set(paneId, state)
  void invoke('report_pane_screen_state', { paneId, state }).catch(() => {
    lastReported.delete(paneId)
  })
}

export function initAgentScreenDetection(reader: ReadScreen): void {
  readScreen = reader
}

/** Cheap to call per output frame; work happens once per quiet window. */
export function scheduleAgentScreenDetection(paneId: string): void {
  if (!readScreen) return
  const now = Date.now()
  const first = firstScheduledAt.get(paneId) ?? now
  firstScheduledAt.set(paneId, first)
  const existing = timers.get(paneId)
  if (existing !== undefined) window.clearTimeout(existing)
  const delay = Math.max(0, Math.min(DETECT_DEBOUNCE_MS, first + DETECT_MAX_WAIT_MS - now))
  timers.set(paneId, window.setTimeout(() => {
    timers.delete(paneId)
    firstScheduledAt.delete(paneId)
    evaluate(paneId)
  }, delay))
}

export function noteAgentScreenTitle(paneId: string, title: string): void {
  lastTitles.set(paneId, title)
  scheduleAgentScreenDetection(paneId)
}

export function clearAgentScreenDetection(paneId: string): void {
  const existing = timers.get(paneId)
  if (existing !== undefined) window.clearTimeout(existing)
  timers.delete(paneId)
  firstScheduledAt.delete(paneId)
  lastTitles.delete(paneId)
  useWorkspaceStore.getState().setPaneScreenState(paneId, null)
  reportToDaemon(paneId, null)
  lastReported.delete(paneId)
}

function evaluate(paneId: string): void {
  if (!readScreen) return
  const store = useWorkspaceStore.getState()
  const pane = store.panes[paneId]
  if (!pane || !pane.alive) {
    store.setPaneScreenState(paneId, null)
    reportToDaemon(paneId, null)
    return
  }
  const kind = agentKindForPane(pane)
  if (!kind) {
    store.setPaneScreenState(paneId, null)
    reportToDaemon(paneId, null)
    return
  }
  const screen = readScreen(paneId, SCREEN_LINES)
  const title = lastTitles.get(paneId) ?? pane.config.title ?? ''
  const detection = detectAgentScreenState(kind, screen, title)
  if (!detection) {
    store.setPaneScreenState(paneId, null)
    reportToDaemon(paneId, null)
    return
  }
  // 'hold' means an overlay (transcript viewer, model picker) hides the real
  // state — keep whatever we last knew rather than flapping to idle.
  if (detection.state === 'hold') return
  store.setPaneScreenState(paneId, { state: detection.state, ruleId: detection.ruleId, at: Date.now() })
  reportToDaemon(paneId, detection.state)
}

import type { PaneMeta } from '../ipc/types'
import { isAgentPane } from './profiles'
import type { Settings } from './profiles'
import type { AttentionSnapshot, NativeAttentionPane } from './worktreeAttention'
import { EXPLICIT_ATTENTION_TTL_MS } from './worktreeAttention'

/** Live state of one AI coding agent pane.
 *
 *  These literals intentionally mirror `NativeAttentionState` so the workspace
 *  aggregate and the per-pane dot never disagree about vocabulary. `blocked`
 *  collapses into `waiting` because both mean "the agent stopped and needs the
 *  user", which is a single colour for the user. */
export type AgentPaneState = 'working' | 'waiting' | 'done' | 'error' | 'idle'

/** Where the winning evidence came from, strongest first.
 *
 *  `agent-hook` is the agent reporting its own turn end; `orchestration` is the
 *  daemon's dispatch projection; `terminal-title` is the agent's own OSC title
 *  (spinner glyphs, "Running"/"Idle"); `terminal-activity` is VibeLink's local
 *  typed-prompt heuristic. */
export type AgentPaneStatusSource = 'agent-hook' | 'orchestration' | 'terminal-title' | 'terminal-activity' | 'none' | 'screen'

export type AgentPaneStatus = {
  state: AgentPaneState
  source: AgentPaneStatusSource
  label: string
  /** Working states animate; settled states must not, or every idle pane in a
   *  large workspace runs a permanent animation. */
  pulsing: boolean
}

/** A `working` report VibeLink inferred locally is evidence that an agent turn
 *  started, not proof it is still running: a crashed agent, a detached process,
 *  or a turn ended through a path we cannot observe leaves it dangling. After
 *  this window the pane falls back to whatever the agent itself reports. */
export const agentActivityStaleMs = 10 * 60 * 1_000

export type AgentPaneActivity = { startedAt: number }

const idleStatus: AgentPaneStatus = { state: 'idle', source: 'none', label: 'Idle', pulsing: false }

/** Spinner frames an agent animates in its OSC title while a turn is running:
 *  the Braille block used by Claude Code / Codex / OMP / ora-style spinners,
 *  the circle-quarter set, and Gemini's own working glyphs. U+2800 (blank) is
 *  excluded because it is padding, not motion. */
const spinnerGlyphs = /[\u2801-\u28ff\u25d0-\u25d3\u25f0-\u25f3\u2726\u23f2]/u
/** Gemini renders a raised hand while a tool call awaits approval. */
const waitingGlyphs = /\u270b/u
const workingTitle = /\b(working|running|thinking|executing|building|testing|generating|compacting|processing|streaming)\b/i
const waitingTitle = /(permission|approve|approval|confirm|allow|waiting for input|needs? input|awaiting|action required)/i
const idleTitle = /\b(idle|ready|done|complete|completed|finished)\b/i

/** Read the agent's own status out of the terminal title.
 *
 *  This is the only signal that covers every agent without an installed hook,
 *  and it is authored by the agent itself, so it outranks VibeLink's local
 *  typed-prompt heuristic. Returns `null` when the title says nothing. */
export function agentStateFromTitle(title: string | null | undefined): 'working' | 'waiting' | 'idle' | null {
  if (!title) return null
  if (waitingGlyphs.test(title) || waitingTitle.test(title)) return 'waiting'
  if (spinnerGlyphs.test(title) || workingTitle.test(title)) return 'working'
  if (idleTitle.test(title)) return 'idle'
  return null
}

/** A screen-content detection result published by the terminal layer. */
export type PaneScreenState = {
  state: 'working' | 'blocked' | 'idle'
  ruleId: string
  at: number
}

/** Screen evidence goes stale fast: a detached or scrolled pane must not pin
 *  a state forever. */
export const paneScreenStateTtlMs = 20_000

export type AgentPaneStatusInput = {
  /** Whether VibeLink recognizes an agent in this pane. Gates only the INFERRED
   *  signals: a hook or the daemon reporting a turn is proof by itself, and
   *  gating those re-creates the exact bug agent hooks exist to solve (users
   *  open the plain Shell profile and then type `omp`). */
  isAgentPane: boolean
  alive: boolean
  title?: string | null
  /** Daemon dispatch projection for this pane, when the snapshot carries one. */
  attention?: Pick<NativeAttentionPane, 'state' | 'stateUpdatedAt'>
  /** Local typed-prompt evidence that a turn started. */
  activity?: AgentPaneActivity
  /** Screen-content rule match (herdr-style), when fresh. */
  screen?: PaneScreenState
  /** Unacknowledged completion alert for this pane. */
  completed?: boolean
  now?: number
}

/** Resolve one pane's displayed agent state from every available signal.
 *
 *  Precedence is by evidence quality, not recency: the daemon's own projection
 *  beats the agent's title, which beats VibeLink's typed-prompt guess. `done`
 *  sits BELOW every live signal on purpose — a completion alert stays pending
 *  until the user opens the pane (see `paneCompletionHighlights`), so a new
 *  turn started on top of an unacknowledged alert must read as `working`. */
export function resolveAgentPaneStatus(input: AgentPaneStatusInput): AgentPaneStatus {
  const now = input.now ?? Date.now()
  if (!input.alive) return input.completed ? doneStatus('agent-hook') : idleStatus

  const attention = input.attention
  if (attention && attention.stateUpdatedAt > 0 && now - attention.stateUpdatedAt <= EXPLICIT_ATTENTION_TTL_MS) {
    if (attention.state === 'blocked' || attention.state === 'waiting') return waitingStatus('orchestration')
    if (attention.state === 'error') return { state: 'error', source: 'orchestration', label: 'Error', pulsing: false }
    if (attention.state === 'working') return workingStatus('orchestration')
  }

  // Screen-content rules see the actual prompt UI (permission forms, pickers)
  // that neither the title nor local heuristics can, so they outrank both.
  const screen = input.screen
  if (screen && input.isAgentPane && now - screen.at <= paneScreenStateTtlMs) {
    if (screen.state === 'blocked') return waitingStatus('screen')
    if (screen.state === 'working') return workingStatus('screen')
    // An explicit idle prompt box falls through: title/completion still apply.
  }

  const titleState = input.isAgentPane ? agentStateFromTitle(input.title) : null
  if (titleState === 'waiting') return waitingStatus('terminal-title')
  if (titleState === 'working') return workingStatus('terminal-title')

  const activityFresh = Boolean(input.isAgentPane && input.activity && now - input.activity.startedAt <= agentActivityStaleMs)
  // An explicit idle title is the agent saying the turn ended, so it beats a
  // local prompt guess that our quiet window has not retired yet.
  if (titleState !== 'idle' && activityFresh) return workingStatus('terminal-activity')

  if (input.completed) return doneStatus('agent-hook')
  return idleStatus
}

function workingStatus(source: AgentPaneStatusSource): AgentPaneStatus {
  return { state: 'working', source, label: 'Working', pulsing: true }
}

function waitingStatus(source: AgentPaneStatusSource): AgentPaneStatus {
  return { state: 'waiting', source, label: 'Waiting for input', pulsing: true }
}

function doneStatus(source: AgentPaneStatusSource): AgentPaneStatus {
  return { state: 'done', source, label: 'Finished', pulsing: false }
}

/** Class suffix for the shared `.workspace-agent-status-dot` tones. */
export function agentPaneStatusClassName(status: AgentPaneStatus, base = 'workspace-agent-status-dot'): string {
  return `${base} is-${status.state}${status.pulsing ? ' is-pulsing' : ''}`
}

/** Worst-first ordering: a collapsed group must advertise the member that
 *  needs the user most, not the first one in layout order. */
const aggregateRank: Record<AgentPaneState, number> = { waiting: 0, error: 1, working: 2, done: 3, idle: 4 }

export function aggregateAgentPaneStatus(statuses: readonly AgentPaneStatus[]): AgentPaneStatus | null {
  let best: AgentPaneStatus | null = null
  for (const status of statuses) {
    if (!best || aggregateRank[status.state] < aggregateRank[best.state]) best = status
  }
  return best
}

export type AgentPaneStatusesInput = {
  panes: Record<string, PaneMeta>
  settings: Settings
  activity: Record<string, AgentPaneActivity>
  screenStates?: Record<string, PaneScreenState>
  attention: AttentionSnapshot | null
  /** Unacknowledged completion alerts, keyed by pane id. */
  completions: Readonly<Record<string, unknown>>
  now?: number
}

/** Resolve every attached pane at once.
 *
 *  Sidebar rows are rendered from a plain loop rather than child components,
 *  so per-row hooks are not an option; one memoised map keeps the whole tree
 *  on a single consistent `now`. */
export function buildAgentPaneStatuses(input: AgentPaneStatusesInput): Record<string, AgentPaneStatus> {
  const now = input.now ?? Date.now()
  const attentionByPane = new Map((input.attention?.panes ?? []).map((pane) => [pane.paneId, pane] as const))
  const statuses: Record<string, AgentPaneStatus> = {}
  for (const [paneId, pane] of Object.entries(input.panes)) {
    const status = resolveAgentPaneStatus({
      isAgentPane: isAgentPane(pane, input.settings),
      alive: pane.alive,
      title: pane.config.title,
      attention: attentionByPane.get(paneId),
      activity: input.activity[paneId],
      screen: input.screenStates?.[paneId],
      completed: Boolean(input.completions[paneId]),
      now,
    })
    if (status.state !== 'idle') statuses[paneId] = status
  }
  return statuses
}

import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Activity, Bell, GitBranch, MemoryStick, SquareTerminal } from 'lucide-react'
import { useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { resolveAttention, type AttentionSnapshot } from '../../state/worktreeAttention'
import type { ResourceSnapshot } from '../../ipc/types'
import './statusbar.css'

const RESOURCE_POLL_MS = 15_000

export type StatusBarProps = {
  onActivateAgentPane: (workspaceId: string, paneId: string) => void | Promise<void>
  onOpenResourceMonitor: () => void
  onOpenCompletionHistory: () => void
}

const formatMemory = (bytes: number) => bytes >= 1024 * 1024 * 1024
  ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  : `${(bytes / (1024 * 1024)).toFixed(0)} MB`

type AgentActivityState = 'Error' | 'Waiting for input' | 'Working' | 'Finished'

type AgentActivityCandidate = {
  workspaceId: string
  paneId: string
  state: AgentActivityState
  changedAt: number
}

type AgentActivitySummary = AgentActivityCandidate & {
  count: number
  workspaceCount: number
}

const agentActivityPriority: Record<AgentActivityState, number> = {
  Error: 0,
  'Waiting for input': 1,
  Working: 2,
  Finished: 3,
}

function summarizeAgentActivity(
  snapshot: AttentionSnapshot | null,
  completionHighlights: Record<string, { completedAt: number; sessionId: string }>,
  reviewMarkers: Record<string, unknown>,
  now = Date.now(),
): AgentActivitySummary | null {
  const candidates = new Map<string, AgentActivityCandidate>()
  const snapshotPanes = snapshot?.panes ?? []
  const paneById = new Map(snapshotPanes.map((pane) => [pane.paneId, pane] as const))
  for (const pane of snapshotPanes) {
    const resolved = resolveAttention(pane, now)
    const state = resolved.attentionClass === 1
      ? resolved.cause === 'error' ? 'Error' : 'Waiting for input'
      : resolved.attentionClass === 3 ? 'Working' : null
    if (state) candidates.set(pane.paneId, { workspaceId: pane.workspaceId, paneId: pane.paneId, state, changedAt: resolved.timestamp })
  }
  for (const [paneId, highlight] of Object.entries(completionHighlights)) {
    const pane = paneById.get(paneId)
    if ((snapshot && !pane) || reviewMarkers[paneId] || pane?.interrupted || candidates.has(paneId)) continue
    candidates.set(paneId, { workspaceId: highlight.sessionId, paneId, state: 'Finished', changedAt: highlight.completedAt })
  }

  let summary: AgentActivitySummary | null = null
  let priority = Number.POSITIVE_INFINITY
  let workspaces = new Set<string>()
  for (const candidate of candidates.values()) {
    const candidatePriority = agentActivityPriority[candidate.state]
    if (candidatePriority < priority) {
      priority = candidatePriority
      workspaces = new Set([candidate.workspaceId])
      summary = { ...candidate, count: 1, workspaceCount: 1 }
      continue
    }
    if (candidatePriority !== priority || !summary) continue
    workspaces.add(candidate.workspaceId)
    summary.count += 1
    summary.workspaceCount = workspaces.size
    if (candidate.changedAt > summary.changedAt) Object.assign(summary, candidate)
  }
  return summary
}

/** Bottom status strip: workspace context on the left and one Orca-style
 *  resource trigger on the right. Full process details are returned only when open. */
export function StatusBar({ onActivateAgentPane, onOpenResourceMonitor, onOpenCompletionHistory }: StatusBarProps) {
  const session = useWorkspaceStore((state) => state.sessions.find((entry) => entry.id === state.activeSessionId))
  const activeSessionId = useWorkspaceStore((state) => state.activeSessionId)
  const activeLivePaneCount = useWorkspaceStore((state) => Object.values(state.panes).filter((pane) => pane.alive).length)
  const attentionSnapshot = useWorkspaceStore((state) => state.attentionSnapshot)
  const paneCompletionHighlights = useWorkspaceStore((state) => state.paneCompletionHighlights)
  const paneReviewMarkers = useWorkspaceStore((state) => state.paneReviewMarkers)
  const completionHistoryCount = useWorkspaceStore((state) => state.completionHistory.length)
  const unreadCompletionCount = useWorkspaceStore((state) => state.completionHistory.filter((entry) => !entry.read).length)
  const repoInfo = useGitStore((state) => (activeSessionId ? state.sessions[activeSessionId]?.repositories['']?.repoInfo ?? null : null))
  const [resources, setResources] = useState<ResourceSnapshot | null>(null)
  const agentActivity = useMemo(
    () => summarizeAgentActivity(attentionSnapshot, paneCompletionHighlights, paneReviewMarkers),
    [attentionSnapshot, paneCompletionHighlights, paneReviewMarkers],
  )

  useEffect(() => {
    let cancelled = false
    const poll = async () => {
      if (document.visibilityState === 'hidden') return
      try {
        const snapshot = await invoke<ResourceSnapshot>('resource_snapshot', { includeDetails: false })
        if (!cancelled) setResources(snapshot)
      } catch {
        if (!cancelled) setResources(null)
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), RESOURCE_POLL_MS)
    window.addEventListener('focus', poll)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener('focus', poll)
    }
  }, [])

  const terminalCount = resources?.panes.length ?? activeLivePaneCount
  const terminalLabel = `${terminalCount} terminal${terminalCount === 1 ? '' : 's'}`
  const memoryLabel = resources ? formatMemory(resources.totalMemBytes) : '—'
  const processCount = resources ? resources.app.processCount + resources.daemon.processCount + resources.panes.reduce((total, pane) => total + pane.processCount, 0) : null
  const processLabel = processCount === null ? null : `${processCount} process${processCount === 1 ? '' : 'es'}`
  const resourceTitle = resources
    ? `Open resource manager · ${memoryLabel} · ${terminalLabel} · ${processLabel}`
    : `Open resource manager · ${terminalLabel}`
  const agentActivityLabel = agentActivity
    ? `${agentActivity.count} ${agentActivity.state} terminal pane${agentActivity.count === 1 ? '' : 's'} in ${agentActivity.workspaceCount} workspace${agentActivity.workspaceCount === 1 ? '' : 's'}`
    : null

  return (
    <footer className="statusbar" aria-label="Status bar">
      <span className="statusbar-segment statusbar-workspace" title={session?.workspaceFolder ?? undefined}>
        {repoInfo?.branch ? <GitBranch size={12} aria-hidden="true" /> : null}
        <span className="statusbar-workspace-name">{session?.name ?? 'No workspace'}</span>
        {repoInfo?.branch ? <span className="statusbar-branch">{repoInfo.branch}</span> : null}
        {repoInfo && (repoInfo.ahead > 0 || repoInfo.behind > 0) ? (
          <span className="statusbar-sync">{repoInfo.ahead > 0 ? `↑${repoInfo.ahead}` : ''}{repoInfo.behind > 0 ? `↓${repoInfo.behind}` : ''}</span>
        ) : null}
      </span>
      <span className="statusbar-spacer" />
      {agentActivity && agentActivityLabel ? (
        <button type="button" className="statusbar-segment statusbar-resources" title={agentActivityLabel} aria-label={agentActivityLabel} onClick={() => void onActivateAgentPane(agentActivity.workspaceId, agentActivity.paneId)}>
          <Activity size={12} aria-hidden="true" />
          <span>{agentActivity.state}</span>
          <span className="statusbar-resource-count">{agentActivity.count}</span>
        </button>
      ) : null}
      {completionHistoryCount > 0 ? <button type="button" className="statusbar-segment" title="Open completion history" onClick={onOpenCompletionHistory}><Bell size={12} aria-hidden="true" />{unreadCompletionCount}</button> : null}
      <button type="button" className="statusbar-segment statusbar-resources" title={resourceTitle} aria-label={resourceTitle} onClick={onOpenResourceMonitor}>
        <MemoryStick size={12} aria-hidden="true" />
        <span>{memoryLabel}</span>
        <span className="statusbar-resource-separator" aria-hidden="true">·</span>
        <SquareTerminal size={12} aria-hidden="true" />
        <span className="statusbar-resource-count">{terminalCount}</span>
      </button>
    </footer>
  )
}

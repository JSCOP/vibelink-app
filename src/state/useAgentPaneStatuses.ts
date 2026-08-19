import { useMemo } from 'react'
import type { PaneMeta } from '../ipc/types'
import {
  buildAgentPaneStatuses,
  resolveAgentPaneStatus,
  type AgentPaneActivity,
  type AgentPaneStatus,
  type PaneScreenState,
} from './agentPaneStatus'
import { isAgentPane, type Settings } from './profiles'
import { useWorkspaceStore } from './store'
import type { AttentionSnapshot } from './worktreeAttention'

export type AgentPaneStatusesSelectorState = {
  panes: Record<string, PaneMeta>
  settings: Settings
  paneAgentActivity: Record<string, AgentPaneActivity>
  paneScreenStates: Record<string, PaneScreenState>
  attentionSnapshot: AttentionSnapshot | null
  paneCompletionHighlights: Readonly<Record<string, unknown>>
}

function equalAgentPaneStatuses(
  previous: Record<string, AgentPaneStatus>,
  next: Record<string, AgentPaneStatus>,
): boolean {
  const paneIds = Object.keys(previous)
  if (paneIds.length !== Object.keys(next).length) return false
  return paneIds.every((paneId) => {
    const previousStatus = previous[paneId]
    const nextStatus = next[paneId]
    return nextStatus?.state === previousStatus.state && nextStatus.source === previousStatus.source
  })
}

export function createAgentPaneStatusesSelector() {
  let panes: AgentPaneStatusesSelectorState['panes'] | undefined
  let profiles: Settings['profiles'] | undefined
  let activity: AgentPaneStatusesSelectorState['paneAgentActivity'] | undefined
  let screenStates: AgentPaneStatusesSelectorState['paneScreenStates'] | undefined
  let attention: AttentionSnapshot | null | undefined
  let completions: AgentPaneStatusesSelectorState['paneCompletionHighlights'] | undefined
  let statuses: Record<string, AgentPaneStatus> | undefined

  return (state: AgentPaneStatusesSelectorState): Record<string, AgentPaneStatus> => {
    if (
      statuses
      && panes === state.panes
      && profiles === state.settings.profiles
      && activity === state.paneAgentActivity
      && screenStates === state.paneScreenStates
      && attention === state.attentionSnapshot
      && completions === state.paneCompletionHighlights
    ) return statuses

    const next = buildAgentPaneStatuses({
      panes: state.panes,
      settings: state.settings,
      activity: state.paneAgentActivity,
      screenStates: state.paneScreenStates,
      attention: state.attentionSnapshot,
      completions: state.paneCompletionHighlights,
    })
    panes = state.panes
    profiles = state.settings.profiles
    activity = state.paneAgentActivity
    screenStates = state.paneScreenStates
    attention = state.attentionSnapshot
    completions = state.paneCompletionHighlights
    if (statuses && equalAgentPaneStatuses(statuses, next)) return statuses
    statuses = next
    return statuses
  }
}

/** Live agent state for every pane of the attached workspace.
 *
 *  Panes resolving to `idle` are omitted, so a plain shell never renders a dot
 *  and consumers can treat a missing entry as "nothing to show". */
export function useAgentPaneStatuses(): Record<string, AgentPaneStatus> {
  const selector = useMemo(() => createAgentPaneStatusesSelector(), [])
  return useWorkspaceStore(selector)
}

/** Live agent state for one pane. Kept separate from the map builder so a
 *  per-pane title bar does not resolve every sibling on each render. */
export function useAgentPaneStatus(paneId: string | null | undefined): AgentPaneStatus | null {
  const pane = useWorkspaceStore((state) => paneId ? state.panes[paneId] : undefined)
  const settings = useWorkspaceStore((state) => state.settings)
  const activity = useWorkspaceStore((state) => paneId ? state.paneAgentActivity[paneId] : undefined)
  const screen = useWorkspaceStore((state) => paneId ? state.paneScreenStates[paneId] : undefined)
  const attentionState = useWorkspaceStore((state) => paneId ? state.attentionSnapshot?.panes.find((entry) => entry.paneId === paneId)?.state : undefined)
  const attentionUpdatedAt = useWorkspaceStore((state) => paneId ? state.attentionSnapshot?.panes.find((entry) => entry.paneId === paneId)?.stateUpdatedAt ?? 0 : 0)
  const completed = useWorkspaceStore((state) => paneId ? Boolean(state.paneCompletionHighlights[paneId]) : false)
  return useMemo(() => {
    if (!pane || !paneId) return null
    const status = resolveAgentPaneStatus({
      isAgentPane: isAgentPane(pane, settings),
      alive: pane.alive,
      title: pane.config.title,
      attention: attentionState ? { state: attentionState, stateUpdatedAt: attentionUpdatedAt } : undefined,
      activity,
      screen,
      completed,
    })
    return status.state === 'idle' ? null : status
  }, [activity, attentionState, attentionUpdatedAt, completed, pane, paneId, screen, settings])
}

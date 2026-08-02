import { useMemo } from 'react'
import { buildAgentPaneStatuses, resolveAgentPaneStatus, type AgentPaneStatus } from './agentPaneStatus'
import { isAgentPane } from './profiles'
import { useWorkspaceStore } from './store'

/** Live agent state for every pane of the attached workspace.
 *
 *  Panes resolving to `idle` are omitted, so a plain shell never renders a dot
 *  and consumers can treat a missing entry as "nothing to show". */
export function useAgentPaneStatuses(): Record<string, AgentPaneStatus> {
  const panes = useWorkspaceStore((state) => state.panes)
  const settings = useWorkspaceStore((state) => state.settings)
  const activity = useWorkspaceStore((state) => state.paneAgentActivity)
  const attention = useWorkspaceStore((state) => state.attentionSnapshot)
  const completions = useWorkspaceStore((state) => state.paneCompletionHighlights)
  return useMemo(
    // `attention` is refreshed on a timer, so the memo is also how a stale
    // local `working` guess eventually decays back to idle on screen.
    () => buildAgentPaneStatuses({ panes, settings, activity, attention, completions }),
    [activity, attention, completions, panes, settings],
  )
}

/** Live agent state for one pane. Kept separate from the map builder so a
 *  per-pane title bar does not resolve every sibling on each render. */
export function useAgentPaneStatus(paneId: string | null | undefined): AgentPaneStatus | null {
  const pane = useWorkspaceStore((state) => paneId ? state.panes[paneId] : undefined)
  const settings = useWorkspaceStore((state) => state.settings)
  const activity = useWorkspaceStore((state) => paneId ? state.paneAgentActivity[paneId] : undefined)
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
      completed,
    })
    return status.state === 'idle' ? null : status
  }, [activity, attentionState, attentionUpdatedAt, completed, pane, paneId, settings])
}

import type { DockviewApi } from 'dockview-react'

export type RemotePaneVisibilityState =
  | { kind: 'group'; paneId: string; groupId: string; wasActive: boolean }
  | { kind: 'detached'; paneId: string; originalGroupId: string; originalIndex: number; temporaryGroupId: string; wasActive: boolean }

export function hideRemoteLeasedPane(api: DockviewApi, paneId: string): RemotePaneVisibilityState | null {
  const panel = api.getPanel(paneId)
  if (!panel) return null
  const group = panel.group
  const wasActive = api.activePanel?.id === paneId

  if (group.panels.length === 1) {
    group.api.setVisible(false)
    activateFirstVisibleSibling(api, paneId)
    return { kind: 'group', paneId, groupId: group.id, wasActive }
  }

  const originalIndex = group.panels.findIndex((candidate) => candidate.id === paneId)
  const temporaryGroupId = uniqueTemporaryGroupId(api, paneId)
  const temporaryGroup = api.addGroup({ id: temporaryGroupId, referenceGroup: group, direction: 'right', hideHeader: true, skipSetActive: true })
  panel.api.moveTo({ group: temporaryGroup, position: 'center', skipSetActive: true })
  temporaryGroup.api.setVisible(false)
  activateFirstVisibleSibling(api, paneId)
  return { kind: 'detached', paneId, originalGroupId: group.id, originalIndex, temporaryGroupId, wasActive }
}

export function restoreRemoteLeasedPane(api: DockviewApi, state: RemotePaneVisibilityState): boolean {
  const panel = api.getPanel(state.paneId)
  if (!panel) return false

  if (state.kind === 'group') {
    const group = api.groups.find((candidate) => candidate.id === state.groupId)
    if (!group) return false
    group.api.setVisible(true)
    if (state.wasActive) panel.api.setActive()
    return true
  }

  const originalGroup = api.groups.find((candidate) => candidate.id === state.originalGroupId)
  const temporaryGroup = api.groups.find((candidate) => candidate.id === state.temporaryGroupId)
  if (!originalGroup || !temporaryGroup) {
    temporaryGroup?.api.setVisible(true)
    return false
  }
  temporaryGroup.api.setVisible(true)
  panel.api.moveTo({ group: originalGroup, position: 'center', index: state.originalIndex, skipSetActive: !state.wasActive })
  const leftover = api.groups.find((candidate) => candidate.id === state.temporaryGroupId)
  if (leftover && leftover.panels.length === 0) api.removeGroup(leftover)
  if (state.wasActive) panel.api.setActive()
  return true
}

function activateFirstVisibleSibling(api: DockviewApi, hiddenPaneId: string): void {
  const sibling = api.panels.find((panel) => panel.id !== hiddenPaneId && panel.group.api.isVisible)
  sibling?.api.setActive()
}

function uniqueTemporaryGroupId(api: DockviewApi, paneId: string): string {
  const prefix = `remote-lease-${paneId}`
  let id = prefix
  let suffix = 1
  while (api.getGroup(id)) id = `${prefix}-${suffix++}`
  return id
}

export function paneIdsForSession(
  leases: Record<string, { sessionId: string }>,
  sessionId: string | undefined,
): string[] {
  if (!sessionId) return []
  return Object.entries(leases)
    .filter(([, lease]) => lease.sessionId === sessionId)
    .map(([paneId]) => paneId)
}

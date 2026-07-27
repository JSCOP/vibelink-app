import type { DockviewApi } from 'dockview-react'
import { profileById, profileIconForPane } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { getTerminalWindow } from './terminalWindowRegistry'
import { workspaceContentDescriptors } from './workspaceLayoutModel'
import {
  isStructuralWorkspaceContentKind,
  parseWorkspaceContentParams,
  workspaceContentPanelId,
  type WorkspaceContentKind,
} from './workspaceContentModel'

export type OpenContentItem = {
  panelId: string
  kind: WorkspaceContentKind
  title: string
  icon: string
  active: boolean
  parentPanelId?: string | null
}

export type OpenContentSnapshot = readonly OpenContentItem[]

const emptySnapshot: OpenContentSnapshot = []
const listeners = new Set<() => void>()
let snapshot: OpenContentSnapshot = emptySnapshot

export function subscribeOpenContent(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getOpenContentSnapshot(): OpenContentSnapshot {
  return snapshot
}

export function publishOpenContentSnapshot(next: OpenContentSnapshot): boolean {
  if (openContentSnapshotsEqual(snapshot, next)) return false
  snapshot = next.length > 0 ? next : emptySnapshot
  for (const listener of listeners) listener()
  return true
}

export function clearOpenContentSnapshot(): boolean {
  return publishOpenContentSnapshot(emptySnapshot)
}

export function publishOpenContentFromDockview(api: DockviewApi): boolean {
  const state = useWorkspaceStore.getState()
  const activeOuterPanelId = api.activePanel?.id ?? null
  const items: OpenContentItem[] = []

  for (const panel of api.panels) {
    const content = parseWorkspaceContentParams(panel.params)
    // Rail panels (Workspaces/Explorer/Source Control/Git History/Branches/
    // Agent Sessions) are permanent chrome, not things the user "opened", so
    // they never appear in this list.
    if (!content || isStructuralWorkspaceContentKind(content.kind)) continue

    const terminalWindow = content.kind === 'terminalWindow'
      ? getTerminalWindow(content.instanceId)
      : undefined
    const paneIds = terminalWindow?.paneIds() ?? []
    const outerActive = panel.id === activeOuterPanelId

    items.push({
      panelId: panel.id,
      kind: content.kind,
      title: content.title,
      icon: content.kind === 'terminal' || content.kind === 'terminalWindow' || content.kind === 'agent'
        ? content.icon
        : workspaceContentDescriptors[content.kind].icon,
      active: outerActive && paneIds.length === 0,
      parentPanelId: null,
    })

    if (content.kind !== 'terminalWindow') continue
    const activeInnerPanelId = terminalWindow?.getInnerApi()?.activePanel?.id ?? null
    for (const paneId of paneIds) {
      const pane = state.panes[paneId]
      if (!pane) continue
      const profile = profileById(state.settings, pane.config.profileId)
      const panePanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: paneId })
      items.push({
        panelId: panePanelId,
        kind: 'terminal',
        title: pane.config.title?.trim() || profile.name || 'Shell',
        icon: profileIconForPane(profile, pane.config.icon),
        active: outerActive && (activeInnerPanelId ? activeInnerPanelId === panePanelId : state.activePaneId === paneId),
        parentPanelId: panel.id,
      })
    }
  }

  return publishOpenContentSnapshot(items)
}


function openContentSnapshotsEqual(left: OpenContentSnapshot, right: OpenContentSnapshot): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]
    const b = right[index]
    if (a.panelId !== b.panelId
      || a.kind !== b.kind
      || a.title !== b.title
      || a.icon !== b.icon
      || a.active !== b.active
      || a.parentPanelId !== b.parentPanelId) return false
  }
  return true
}

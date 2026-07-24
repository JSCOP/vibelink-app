import type { HermesStatus } from '../state/hermes'

export type WorkspaceAgentTabStatus = {
  label: 'Waiting for input' | 'Working' | 'Idle' | 'Error' | 'Stopped'
  tone: 'waiting' | 'working' | 'idle' | 'error' | 'stopped'
  pulsing: boolean
}

export function workspaceAgentTabStatus(status: HermesStatus, pendingPermissions: number): WorkspaceAgentTabStatus {
  if (pendingPermissions > 0) return { label: 'Waiting for input', tone: 'waiting', pulsing: false }
  if (status === 'starting' || status === 'busy') return { label: 'Working', tone: 'working', pulsing: true }
  if (status === 'running') return { label: 'Idle', tone: 'idle', pulsing: false }
  if (status === 'error') return { label: 'Error', tone: 'error', pulsing: false }
  return { label: 'Stopped', tone: 'stopped', pulsing: false }
}

/** Payload Dockview reports for the drag in flight (panelId is null for a whole-group drag). */
export type DraggedPanel = { viewId: string; panelId: string | null }

/**
 * Whether hovering this tab during a drag should reveal (activate) its content.
 * True only for a live drag from the SAME Dockview instance onto a different,
 * not-already-active tab — so the user can drop to split beside that window.
 */
export function shouldRevealTabForDrag(
  dragged: DraggedPanel | undefined,
  tab: { viewId: string; panelId: string; isActive: boolean },
): boolean {
  if (tab.isActive || !dragged) return false
  return dragged.viewId === tab.viewId && dragged.panelId !== tab.panelId
}

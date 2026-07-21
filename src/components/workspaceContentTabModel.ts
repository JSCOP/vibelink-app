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

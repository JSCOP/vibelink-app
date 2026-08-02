import { invoke } from '@tauri-apps/api/core'

export type AgentAuthState = 'loggedIn' | 'unknown'

export type AgentCliStatus = {
  id: string
  displayName: string
  installed: boolean
  path?: string | null
  version?: string | null
  auth: AgentAuthState
  accountLabel?: string | null
  loginHint: string
}

export function getAgentCliStatus(): Promise<AgentCliStatus[]> {
  return invoke<AgentCliStatus[]>('agent_cli_status')
}

export function agentStatusLabel(status: AgentCliStatus): string {
  if (!status.installed) return 'Not found'
  if (status.accountLabel) return `Installed · ${status.accountLabel}`
  if (status.auth === 'loggedIn') return 'Installed · Signed in'
  return 'Installed · Login unknown'
}

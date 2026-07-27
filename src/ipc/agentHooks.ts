import { invoke } from '@tauri-apps/api/core'

/**
 * One supported agent's completion-hook state.
 *
 * `configPath` is surfaced in Settings on purpose: installing a hook touches a
 * file the user owns, so the exact path must be visible before they opt in.
 */
export type AgentHookStatus = {
  id: string
  displayName: string
  /** Our hook is currently installed for this agent. */
  installed: boolean
  /** The agent's config/hook location already exists. Absence is not an error. */
  configPresent: boolean
  configPath: string
  /**
   * Set when the config exists but VibeLink refuses to modify it, for example a
   * malformed JSON settings file or a `notify` slot already owned by another
   * tool. Install is blocked rather than risking the user's configuration.
   */
  blockedReason: string | null
}

export async function agentHookStatus(): Promise<AgentHookStatus[]> {
  return invoke<AgentHookStatus[]>('agent_hook_status')
}

export async function setAgentHookEnabled(agentId: string, enabled: boolean): Promise<AgentHookStatus> {
  return invoke<AgentHookStatus>('set_agent_hook_enabled', { agentId, enabled })
}

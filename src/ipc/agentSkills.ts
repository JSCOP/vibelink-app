import { invoke } from '@tauri-apps/api/core'

/**
 * Install state of the `vibelink-memory` skill in one agent's home skills root.
 *
 * `agentAbsent` means the agent's own home directory does not exist on this
 * machine. The target is still offered — installing would create the directory —
 * but it is left unchecked so a bare host does not collect config folders for
 * agents the user never installed.
 */
export type AgentSkillState = 'installed' | 'stale' | 'missing' | 'agentAbsent'

/**
 * One install location. `path` is the exact directory VibeLink writes
 * `<path>/vibelink-memory/SKILL.md` into, and is shown in Settings because the
 * write lands in a directory the user owns.
 */
export type AgentSkillTarget = {
  id: string
  label: string
  path: string
  state: AgentSkillState
  /** Revision found on disk, or null when nothing is installed there. */
  installedRevision: number | null
}

/** Built-in skill revision plus the per-target scan result. */
export type AgentSkillStatus = {
  skill: string
  revision: number
  targets: AgentSkillTarget[]
}

export async function fetchAgentSkillStatus(): Promise<AgentSkillStatus> {
  return invoke<AgentSkillStatus>('agent_skill_status')
}

export async function installAgentSkill(targetIds: string[]): Promise<AgentSkillStatus> {
  return invoke<AgentSkillStatus>('agent_skill_install', { targetIds })
}

export async function uninstallAgentSkill(targetIds: string[]): Promise<AgentSkillStatus> {
  return invoke<AgentSkillStatus>('agent_skill_uninstall', { targetIds })
}

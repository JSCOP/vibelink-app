import { invoke } from '@tauri-apps/api/core'

/** Install state of one bundled skill in one agent-owned skills root. */
export type AgentSkillState = 'installed' | 'stale' | 'missing' | 'agentAbsent'

export type AgentSkillTargetSkill = {
  name: string
  state: AgentSkillState
  /** Revision found beside this skill, or null when it is absent or invalid. */
  installedRevision: number | null
}

/**
 * One install location. `path` is the directory VibeLink writes each
 * `<path>/<skill>/SKILL.md` into, and is shown in Settings because the
 * write lands in a directory the user owns.
 */
export type AgentSkillTarget = {
  id: string
  label: string
  path: string
  /** Aggregate state; a partial bundle remains `stale` until the user installs it. */
  state: AgentSkillState
  skills: AgentSkillTargetSkill[]
}

/** Bundled skill names, their shared revision, and per-skill state at each target. */
export type AgentSkillStatus = {
  skills: string[]
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

/**
 * Refreshes each skill that is already present on disk and installs nothing
 * missing. A newly bundled skill and a new agent home both require an explicit
 * user-initiated install.
 */
export async function refreshAgentSkill(): Promise<AgentSkillStatus> {
  return invoke<AgentSkillStatus>('agent_skill_refresh')
}

/**
 * Builds the `npx skills add …` command for agents VibeLink cannot write to
 * directly. The backend owns the string — including validating every key —
 * because a command missing `--agent` makes the CLI scatter config folders
 * across the user's home for agents they never installed.
 */
export async function agentSkillCliCommand(agentKeys: string[]): Promise<string> {
  return invoke<string>('agent_skill_cli_command', { agentKeys })
}

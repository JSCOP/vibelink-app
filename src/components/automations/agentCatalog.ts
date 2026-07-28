import type { AutomationAgent } from '../../ipc/automations'

export type AutomationAgentEntry = {
  id: AutomationAgent
  label: string
  /** Icon name in the shared profile/brand icon registry (`state/profileIcons`). */
  icon: string
  /** CLI binary VibeLink probes on PATH. */
  command: string
  /** One-line description of what the scheduled run does. */
  summary: string
  /** True when the agent reads VibeLink's toolset/skill selection. */
  supportsToolsets: boolean
  /** Example of the model value this agent expects when a run pins one. */
  modelPlaceholder: string
}

/** Mirrors `daemon/automation/agents.rs`; the daemon rejects any other id. */
export const automationAgents: AutomationAgentEntry[] = [
  {
    id: 'hermes',
    label: 'Hermes',
    icon: 'hermes',
    command: 'hermes',
    summary: 'Full toolsets, skills, and usage reporting.',
    supportsToolsets: true,
    modelPlaceholder: 'gpt-5.2',
  },
  {
    id: 'omp',
    label: 'Oh My Pi',
    icon: 'oh-my-pi',
    command: 'omp',
    summary: 'Runs headless with auto-approved tools.',
    supportsToolsets: false,
    modelPlaceholder: 'opus',
  },
  {
    id: 'claude',
    label: 'Claude Code',
    icon: 'claude-code',
    command: 'claude',
    summary: 'Print mode with permissions bypassed.',
    supportsToolsets: false,
    modelPlaceholder: 'sonnet',
  },
  {
    id: 'codex',
    label: 'Codex',
    icon: 'codex',
    command: 'codex',
    summary: 'Codex exec without sandbox approvals.',
    supportsToolsets: false,
    modelPlaceholder: 'gpt-5-codex',
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    icon: 'opencode',
    command: 'opencode',
    summary: 'Single run with permissions auto-approved.',
    supportsToolsets: false,
    modelPlaceholder: 'anthropic/claude-sonnet-4',
  },
]

export const defaultAutomationAgent: AutomationAgent = 'hermes'

const fallbackAgent = automationAgents.find((entry) => entry.id === defaultAutomationAgent)!

/** Resolve an id to its catalog entry, falling back to the default agent so a
 *  record written by a newer build still renders instead of blanking the row. */
export function automationAgentEntry(agent: string): AutomationAgentEntry {
  return automationAgents.find((entry) => entry.id === agent) ?? fallbackAgent
}

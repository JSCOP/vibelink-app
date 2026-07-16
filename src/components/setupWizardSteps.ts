import type { AgentCliStatus } from '../ipc/agents'
import type { McpCheckReport } from '../ipc/mcp'

export const setupStepIds = ['welcome', 'license', 'agents', 'runtime', 'model', 'mcp', 'finish'] as const
export type SetupStepId = typeof setupStepIds[number]

export function setupStepAutoPass(input: {
  entitled: boolean
  runtimeInstalled: boolean
  agentClis: AgentCliStatus[]
  mcp?: McpCheckReport | null
}): Partial<Record<SetupStepId, boolean>> {
  return {
    license: input.entitled,
    agents: input.agentClis.length > 0 && input.agentClis.every((status) => status.installed && status.auth === 'loggedIn'),
    runtime: input.runtimeInstalled,
    mcp: Boolean(input.mcp?.initializeOk),
  }
}

export function setupStepTitle(step: SetupStepId): string {
  return ({
    welcome: 'Welcome',
    license: 'Account',
    agents: 'Agent CLIs',
    runtime: 'Hermes runtime',
    model: 'Model & auth',
    mcp: 'MCP self-check',
    finish: 'Finish',
  } satisfies Record<SetupStepId, string>)[step]
}

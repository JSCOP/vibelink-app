import { describe, expect, test } from 'vitest'
import type { AgentCliStatus } from '../ipc/agents'
import { setupStepAutoPass } from './setupWizardSteps'

const detectedAgent: AgentCliStatus = {
  id: 'codex',
  displayName: 'Codex',
  installed: true,
  path: 'C:/tools/codex.exe',
  version: 'codex 1.0',
  auth: 'loggedIn',
  loginHint: 'codex login',
}

describe('setup wizard auto-pass', () => {
  test('pre-checks license and runtime when already satisfied', () => {
    expect(setupStepAutoPass({
      entitled: true,
      runtimeInstalled: true,
      agentClis: [detectedAgent],
      mcp: { spawnOk: true, initializeOk: true, toolCount: 16 },
    })).toEqual({ license: true, agents: true, runtime: true, mcp: true })
  })

  test('leaves Pro setup steps incomplete in Core mode', () => {
    expect(setupStepAutoPass({
      entitled: false,
      runtimeInstalled: false,
      agentClis: [],
      mcp: null,
    })).toEqual({ license: false, agents: false, runtime: false, mcp: false })
  })
})

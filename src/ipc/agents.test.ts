import { describe, expect, test } from 'vitest'
import { agentStatusLabel, type AgentCliStatus } from './agents'

const status: AgentCliStatus = {
  id: 'claude',
  displayName: 'Claude Code',
  installed: true,
  auth: 'loggedIn',
  loginHint: 'claude',
}

describe('agentStatusLabel', () => {
  test('prefers a safe account label and falls back to signed-in state', () => {
    expect(agentStatusLabel({ ...status, accountLabel: 'account@example.com' })).toBe('Installed · account@example.com')
    expect(agentStatusLabel(status)).toBe('Installed · Signed in')
    expect(agentStatusLabel({ ...status, installed: false })).toBe('Not found')
  })
})

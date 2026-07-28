import { describe, expect, it } from 'vitest'
import { agentIconName } from '../components/settings/agentBrand'
import { automationAgents } from '../components/automations/agentCatalog'
import { workspaceContentDescriptors } from '../layout/workspaceLayoutModel'
import { defaultProfileIconName, profileIcons } from './profileIcons'

/** Every agent id VibeLink integrates with. Mirrors `AGENT_HOOK_SPECS` in
 *  `src-tauri/src/app/agent_hooks.rs` plus the `AGENT_PROBES` CLI ids; adding a
 *  backend agent without its vendor mark must fail here, not silently render a
 *  generic robot glyph in Settings, the setup wizard, and pane tabs. */
const integratedAgentIds = [
  'claude', 'codex', 'gemini', 'antigravity', 'amp', 'opencode', 'mimo-code',
  'cursor', 'pi', 'omp', 'droid', 'command-code', 'grok', 'copilot', 'hermes',
  'devin', 'kimi',
]

describe('workspace content descriptor icons', () => {
  it('resolves every built-in descriptor without falling back to the terminal icon', () => {
    for (const descriptor of Object.values(workspaceContentDescriptors)) {
      expect(profileIcons[descriptor.icon], `${descriptor.kind}:${descriptor.icon}`).toBeDefined()
      if (descriptor.kind !== 'terminal' && descriptor.kind !== 'terminalWindow') expect(descriptor.icon).not.toBe(defaultProfileIconName)
    }
  })
})

describe('agent brand icons', () => {
  it('gives every integrated agent a registered brand mark instead of a generic glyph', () => {
    for (const agentId of integratedAgentIds) {
      const iconName = agentIconName(agentId)
      expect(iconName, agentId).not.toBe('bot')
      expect(profileIcons[iconName], `${agentId}:${iconName}`).toBeDefined()
    }
  })

  it('keeps every automation agent pointed at a registered icon', () => {
    for (const entry of automationAgents) {
      expect(profileIcons[entry.icon], `${entry.id}:${entry.icon}`).toBeDefined()
    }
  })

  it('still falls back for an agent id we ship no icon for', () => {
    expect(agentIconName('not-a-real-agent')).toBe('bot')
  })
})

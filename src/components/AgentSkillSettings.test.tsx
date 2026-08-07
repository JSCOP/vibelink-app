// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AgentSkillStatus } from '../ipc/agentSkills'
import { AgentSkillSettings } from './AgentSkillSettings'

const freshStatus: AgentSkillStatus = {
  skill: 'vibelink-memory',
  revision: 2,
  targets: [
    { id: 'agents', label: 'Shared agents', path: 'C:/Users/js/.agents/skills', state: 'installed', installedRevision: 2 },
    { id: 'claude', label: 'Claude Code', path: 'C:/Users/js/.claude/skills', state: 'missing', installedRevision: null },
    { id: 'grok', label: 'Grok', path: 'C:/Users/js/.grok/skills', state: 'agentAbsent', installedRevision: null },
  ],
}

const mocks = vi.hoisted(() => ({
  fetchAgentSkillStatus: vi.fn(),
  installAgentSkill: vi.fn(),
  uninstallAgentSkill: vi.fn(),
}))
vi.mock('../ipc/agentSkills', () => ({
  fetchAgentSkillStatus: mocks.fetchAgentSkillStatus,
  installAgentSkill: mocks.installAgentSkill,
  uninstallAgentSkill: mocks.uninstallAgentSkill,
}))

describe('AgentSkillSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchAgentSkillStatus.mockResolvedValue(freshStatus)
    mocks.installAgentSkill.mockResolvedValue(freshStatus)
    mocks.uninstallAgentSkill.mockResolvedValue(freshStatus)
  })

  afterEach(() => { cleanup() })

  test('lists every install target with its path and state badge', async () => {
    render(<AgentSkillSettings />)

    expect(await screen.findByText('Claude Code')).toBeInTheDocument()
    expect(screen.getByText('C:/Users/js/.claude/skills')).toBeInTheDocument()
    expect(screen.getByText('Installed')).toBeInTheDocument()
    expect(screen.getByText('Not installed')).toBeInTheDocument()
    expect(screen.getByText('Agent not found')).toBeInTheDocument()
  })

  test('leaves targets whose agent is absent unchecked by default', async () => {
    render(<AgentSkillSettings />)

    expect(await screen.findByRole('checkbox', { name: 'Grok' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Claude Code' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Shared agents' })).toBeChecked()
  })

  test('shows no update notice while every installed copy is current', async () => {
    render(<AgentSkillSettings />)

    await screen.findByText('Claude Code')
    expect(screen.queryByText(/Skill update available/)).not.toBeInTheDocument()
  })

  test('announces an available update when a target runs an older revision', async () => {
    mocks.fetchAgentSkillStatus.mockResolvedValue({
      ...freshStatus,
      targets: [{ ...freshStatus.targets[0], state: 'stale', installedRevision: 1 }, ...freshStatus.targets.slice(1)],
    })
    render(<AgentSkillSettings />)

    expect(await screen.findByText(/Skill update available \(revision 2\)/)).toBeInTheDocument()
    expect(screen.getByText('Update available')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Update all/ }))
    await waitFor(() => expect(mocks.installAgentSkill).toHaveBeenCalledWith(['agents']))
  })

  test('installs exactly the selected targets', async () => {
    render(<AgentSkillSettings />)

    fireEvent.click(await screen.findByRole('checkbox', { name: 'Shared agents' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Grok' }))
    fireEvent.click(screen.getByRole('button', { name: /Install/ }))

    await waitFor(() => expect(mocks.installAgentSkill).toHaveBeenCalledWith(['claude', 'grok']))
  })

  test('surfaces a failing install instead of swallowing it', async () => {
    mocks.installAgentSkill.mockRejectedValue('permission denied')
    render(<AgentSkillSettings />)

    fireEvent.click(await screen.findByRole('button', { name: /Install/ }))
    expect(await screen.findByText('permission denied')).toBeInTheDocument()
  })
})

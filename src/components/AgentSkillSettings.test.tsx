// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => null) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const mocks = vi.hoisted(() => ({
  fetchAgentSkillStatus: vi.fn(),
  installAgentSkill: vi.fn(),
  uninstallAgentSkill: vi.fn(),
  refreshAgentSkill: vi.fn(),
  agentSkillCliCommand: vi.fn(),
}))
vi.mock('../ipc/agentSkills', () => ({
  fetchAgentSkillStatus: mocks.fetchAgentSkillStatus,
  installAgentSkill: mocks.installAgentSkill,
  uninstallAgentSkill: mocks.uninstallAgentSkill,
  refreshAgentSkill: mocks.refreshAgentSkill,
  agentSkillCliCommand: mocks.agentSkillCliCommand,
}))

import type { AgentSkillState, AgentSkillStatus, AgentSkillTarget } from '../ipc/agentSkills'
import { defaultSettings, normalizeSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { AgentSkillSettings } from './AgentSkillSettings'

const targetSkills = (memory: AgentSkillState, browser: AgentSkillState): AgentSkillTarget['skills'] => [
  {
    name: 'vibelink-memory',
    state: memory,
    installedRevision: memory === 'installed' ? 3 : memory === 'stale' ? 1 : null,
  },
  {
    name: 'vibelink-browser',
    state: browser,
    installedRevision: browser === 'installed' ? 3 : browser === 'stale' ? 1 : null,
  },
]

const freshStatus: AgentSkillStatus = {
  skills: ['vibelink-memory', 'vibelink-browser'],
  revision: 3,
  targets: [
    { id: 'agents', label: 'Shared agents', path: 'C:/Users/js/.agents/skills', state: 'installed', skills: targetSkills('installed', 'installed') },
    { id: 'claude', label: 'Claude Code', path: 'C:/Users/js/.claude/skills', state: 'installed', skills: targetSkills('installed', 'installed') },
    { id: 'codex', label: 'Codex', path: 'C:/Users/js/.codex/skills', state: 'missing', skills: targetSkills('missing', 'missing') },
    { id: 'grok', label: 'Grok', path: 'C:/Users/js/.grok/skills', state: 'agentAbsent', skills: targetSkills('agentAbsent', 'agentAbsent') },
  ],
}

const staleStatus: AgentSkillStatus = {
  ...freshStatus,
  targets: [{ ...freshStatus.targets[0], state: 'stale', skills: targetSkills('stale', 'installed') }, ...freshStatus.targets.slice(1)],
}

/** What a machine that has never installed the skill reports. */
const bareStatus: AgentSkillStatus = {
  ...freshStatus,
  targets: freshStatus.targets.map((target) => target.state === 'agentAbsent'
    ? target
    : { ...target, state: 'missing', skills: targetSkills('missing', 'missing') }),
}

/** An existing memory install must not imply consent to browser control. */
const memoryOnlyStatus: AgentSkillStatus = {
  ...freshStatus,
  targets: [{ ...freshStatus.targets[0], state: 'stale', skills: targetSkills('installed', 'missing') }],
}

const setAutoUpdate = (autoUpdateAgentSkill: boolean) => {
  useWorkspaceStore.setState({ settings: normalizeSettings({ ...defaultSettings, autoUpdateAgentSkill }) })
}

const showDetails = () => fireEvent.click(screen.getByRole('button', { name: 'Show details' }))
const openCliSection = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Command for other agents' }))
}
const skillRow = (label: string) => {
  const row = screen.getByText(label).closest('.vl-set-row')
  if (!(row instanceof HTMLElement)) throw new Error(`Missing settings row for ${label}`)
  return within(row)
}

describe('AgentSkillSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchAgentSkillStatus.mockResolvedValue(freshStatus)
    mocks.installAgentSkill.mockResolvedValue(freshStatus)
    mocks.uninstallAgentSkill.mockResolvedValue(freshStatus)
    mocks.refreshAgentSkill.mockResolvedValue(freshStatus)
    mocks.agentSkillCliCommand.mockImplementation(async (keys: string[]) =>
      `npx skills add JSCOP/vibelink-skills --skill vibelink-memory --agent ${keys.join(',')} -y`)
    setAutoUpdate(true)
  })

  afterEach(() => {
    cleanup()
    useWorkspaceStore.setState({ settings: normalizeSettings(defaultSettings) })
  })

  test('summarises how many agents carry the skill', async () => {
    render(<AgentSkillSettings />)

    expect(await screen.findByText('Installed for 2 agents · 1 not installed · 1 not on this machine')).toBeInTheDocument()
  })

  test('counts a lone install in the singular and omits empty groups', async () => {
    mocks.fetchAgentSkillStatus.mockResolvedValue({ ...freshStatus, targets: freshStatus.targets.slice(0, 1) })
    render(<AgentSkillSettings />)

    expect(await screen.findByText('Installed for 1 agent')).toBeInTheDocument()
  })

  describe('first run, nothing installed', () => {
    beforeEach(() => {
      mocks.fetchAgentSkillStatus.mockResolvedValue(bareStatus)
      mocks.installAgentSkill.mockResolvedValue(freshStatus)
    })

    test('says so and writes nothing until the install button is pressed', async () => {
      // A launch refresh may already have run; it only touches installed copies,
      // so the card must still report an untouched home directory.
      await mocks.refreshAgentSkill()
      render(<AgentSkillSettings />)

      expect(await screen.findByText('Not installed yet · 3 agents found on this machine')).toBeInTheDocument()
      expect(screen.getByText(/VibeLink has not written anything to your home folder/)).toBeInTheDocument()
      expect(mocks.installAgentSkill).not.toHaveBeenCalled()

      fireEvent.click(screen.getByRole('button', { name: 'Install for 3 agents' }))
      await waitFor(() => expect(mocks.installAgentSkill).toHaveBeenCalledWith(['agents', 'claude', 'codex']))
    })

    test('never offers to create a home for an agent that is not on this machine', async () => {
      render(<AgentSkillSettings />)

      fireEvent.click(await screen.findByRole('button', { name: 'Install for 3 agents' }))
      await waitFor(() => expect(mocks.installAgentSkill).toHaveBeenCalled())
      expect(mocks.installAgentSkill.mock.calls[0][0]).not.toContain('grok')
    })

    test('hides the install prompt once at least one copy exists', async () => {
      mocks.fetchAgentSkillStatus.mockResolvedValue(freshStatus)
      render(<AgentSkillSettings />)

      await screen.findByText(/Installed for 2 agents/)
      expect(screen.queryByRole('button', { name: /^Install for/ })).not.toBeInTheDocument()
    })
  })

  test('the auto-update switch records the choice and refreshes on the way on', async () => {
    render(<AgentSkillSettings />)

    const auto = await screen.findByRole('switch', { name: 'Keep the installed skill up to date' })
    expect(auto).toBeChecked()

    fireEvent.click(auto)
    expect(useWorkspaceStore.getState().settings.autoUpdateAgentSkill).toBe(false)
    expect(mocks.refreshAgentSkill).not.toHaveBeenCalled()
    expect(auto).not.toBeChecked()

    fireEvent.click(auto)
    expect(useWorkspaceStore.getState().settings.autoUpdateAgentSkill).toBe(true)
    await waitFor(() => expect(mocks.refreshAgentSkill).toHaveBeenCalledTimes(1))
  })

  test('keeps Browser use uninstalled when auto-update refreshes a memory-only home', async () => {
    setAutoUpdate(false)
    mocks.fetchAgentSkillStatus.mockResolvedValue(memoryOnlyStatus)
    mocks.refreshAgentSkill.mockResolvedValue(memoryOnlyStatus)
    render(<AgentSkillSettings />)

    await screen.findByText('Browser use')
    expect(skillRow('Memory').getByText('Installed')).toBeInTheDocument()
    expect(skillRow('Browser use').getByText('Not installed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Install missing skills' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Keep the installed skill up to date' }))
    await waitFor(() => expect(mocks.refreshAgentSkill).toHaveBeenCalledTimes(1))
    expect(skillRow('Browser use').getByText('Not installed')).toBeInTheDocument()
    expect(mocks.installAgentSkill).not.toHaveBeenCalled()

    const installMissing = screen.getByRole('button', { name: 'Install missing skills' })
    await waitFor(() => expect(installMissing).not.toBeDisabled())
    fireEvent.click(installMissing)
    await waitFor(() => expect(mocks.installAgentSkill).toHaveBeenCalledWith(['agents']))
  })

  test('hides the stale notice while auto-update keeps every copy current', async () => {
    mocks.fetchAgentSkillStatus.mockResolvedValue(staleStatus)
    render(<AgentSkillSettings />)

    await screen.findByRole('switch', { name: 'Keep the installed skill up to date' })
    expect(screen.queryByText(/Skill update available/)).not.toBeInTheDocument()
  })

  test('announces a stale copy once auto-update is off', async () => {
    setAutoUpdate(false)
    mocks.fetchAgentSkillStatus.mockResolvedValue(staleStatus)
    render(<AgentSkillSettings />)

    expect(await screen.findByText(/Skill update available \(revision 3\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Update all/ }))
    await waitFor(() => expect(mocks.installAgentSkill).toHaveBeenCalledWith(['agents']))
  })

  test('keeps the target list behind the details toggle', async () => {
    render(<AgentSkillSettings />)

    await screen.findByRole('button', { name: 'Show details' })
    expect(screen.queryByText('C:/Users/js/.claude/skills')).not.toBeInTheDocument()

    showDetails()
    expect(screen.getByText('C:/Users/js/.claude/skills')).toBeInTheDocument()
    expect(skillRow('Memory').getByText('Installed')).toBeInTheDocument()
    expect(skillRow('Browser use').getByText('Installed')).toBeInTheDocument()
    expect(screen.getByText('Not installed')).toBeInTheDocument()
    expect(screen.getByText('Agent not found')).toBeInTheDocument()
  })

  test('installs and removes one target at a time from the details list', async () => {
    render(<AgentSkillSettings />)

    await screen.findByRole('button', { name: 'Show details' })
    showDetails()

    fireEvent.click(screen.getAllByRole('button', { name: /Install/ })[0])
    await waitFor(() => expect(mocks.installAgentSkill).toHaveBeenCalledWith(['codex']))

    fireEvent.click(screen.getAllByRole('button', { name: /Remove/ })[0])
    await waitFor(() => expect(mocks.uninstallAgentSkill).toHaveBeenCalledWith(['agents']))
  })

  test('surfaces a failing install instead of swallowing it', async () => {
    mocks.installAgentSkill.mockRejectedValue('permission denied')
    render(<AgentSkillSettings />)

    await screen.findByRole('button', { name: 'Show details' })
    showDetails()
    fireEvent.click(screen.getAllByRole('button', { name: /Install/ })[0])

    expect(await screen.findByText('permission denied')).toBeInTheDocument()
  })

  describe('command for other agents', () => {
    test('stays collapsed until asked for', async () => {
      render(<AgentSkillSettings />)

      await screen.findByRole('button', { name: 'Command for other agents' })
      expect(screen.queryByRole('checkbox', { name: 'claude-code' })).not.toBeInTheDocument()
    })

    test('refuses to show a command until at least one agent is picked', async () => {
      render(<AgentSkillSettings />)
      await openCliSection()

      expect(screen.getByText(/Pick at least one agent/)).toBeInTheDocument()
      expect(screen.queryByText(/npx skills add/)).not.toBeInTheDocument()
      expect(mocks.agentSkillCliCommand).not.toHaveBeenCalled()
    })

    test('asks the backend to build the command for exactly the picked keys', async () => {
      render(<AgentSkillSettings />)
      await openCliSection()

      fireEvent.click(screen.getByRole('checkbox', { name: 'codex' }))
      await waitFor(() => expect(mocks.agentSkillCliCommand).toHaveBeenCalledWith(['codex']))

      fireEvent.click(screen.getByRole('checkbox', { name: 'claude-code' }))
      await waitFor(() => expect(mocks.agentSkillCliCommand).toHaveBeenLastCalledWith(['claude-code', 'codex']))

      expect(await screen.findByText('npx skills add JSCOP/vibelink-skills --skill vibelink-memory --agent claude-code,codex -y')).toBeInTheDocument()
      expect(screen.queryByText(/Pick at least one agent/)).not.toBeInTheDocument()
    })

    test('unticking the last agent takes the command away again', async () => {
      render(<AgentSkillSettings />)
      await openCliSection()

      const codex = screen.getByRole('checkbox', { name: 'codex' })
      fireEvent.click(codex)
      await screen.findByText(/npx skills add/)

      fireEvent.click(codex)
      expect(screen.queryByText(/npx skills add/)).not.toBeInTheDocument()
      expect(screen.getByText(/Pick at least one agent/)).toBeInTheDocument()
    })

    test('reaches agents the app has no install path for, behind one more disclosure', async () => {
      render(<AgentSkillSettings />)
      await openCliSection()

      expect(screen.queryByRole('checkbox', { name: 'kilo' })).not.toBeInTheDocument()
      fireEvent.click(screen.getByRole('button', { name: /Show \d+ more agents/ }))

      fireEvent.click(screen.getByRole('checkbox', { name: 'kilo' }))
      await waitFor(() => expect(mocks.agentSkillCliCommand).toHaveBeenCalledWith(['kilo']))
    })

    test('copies the command the backend produced', async () => {
      render(<AgentSkillSettings />)
      await openCliSection()

      fireEvent.click(screen.getByRole('checkbox', { name: 'cursor' }))
      await screen.findByText(/npx skills add/)

      fireEvent.click(screen.getByRole('button', { name: /Copy/ }))
      await waitFor(() => expect(invoke).toHaveBeenCalledWith('clipboard_write_text', {
        text: 'npx skills add JSCOP/vibelink-skills --skill vibelink-memory --agent cursor -y',
      }))
    })

    test('surfaces a rejected key instead of showing a command', async () => {
      mocks.agentSkillCliCommand.mockRejectedValue('unknown agent key')
      render(<AgentSkillSettings />)
      await openCliSection()

      fireEvent.click(screen.getByRole('checkbox', { name: 'zed' }))

      expect(await screen.findByText('unknown agent key')).toBeInTheDocument()
      expect(screen.queryByText(/npx skills add/)).not.toBeInTheDocument()
    })
  })
})

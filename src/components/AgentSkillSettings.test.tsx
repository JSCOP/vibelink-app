// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn(async () => null) }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

const mocks = vi.hoisted(() => ({
  fetchAgentSkillStatus: vi.fn(),
  installAgentSkill: vi.fn(),
  uninstallAgentSkill: vi.fn(),
  syncAgentSkill: vi.fn(),
}))
vi.mock('../ipc/agentSkills', () => ({
  fetchAgentSkillStatus: mocks.fetchAgentSkillStatus,
  installAgentSkill: mocks.installAgentSkill,
  uninstallAgentSkill: mocks.uninstallAgentSkill,
  syncAgentSkill: mocks.syncAgentSkill,
}))

import type { AgentSkillStatus } from '../ipc/agentSkills'
import { defaultSettings, normalizeSettings } from '../state/profiles'
import { useWorkspaceStore } from '../state/store'
import { AgentSkillSettings } from './AgentSkillSettings'

const freshStatus: AgentSkillStatus = {
  skill: 'vibelink-memory',
  revision: 2,
  targets: [
    { id: 'agents', label: 'Shared agents', path: 'C:/Users/js/.agents/skills', state: 'installed', installedRevision: 2 },
    { id: 'claude', label: 'Claude Code', path: 'C:/Users/js/.claude/skills', state: 'installed', installedRevision: 2 },
    { id: 'codex', label: 'Codex', path: 'C:/Users/js/.codex/skills', state: 'missing', installedRevision: null },
    { id: 'grok', label: 'Grok', path: 'C:/Users/js/.grok/skills', state: 'agentAbsent', installedRevision: null },
  ],
}

const staleStatus: AgentSkillStatus = {
  ...freshStatus,
  targets: [{ ...freshStatus.targets[0], state: 'stale', installedRevision: 1 }, ...freshStatus.targets.slice(1)],
}

const setAutoInstall = (autoInstallAgentSkill: boolean) => {
  useWorkspaceStore.setState({ settings: normalizeSettings({ ...defaultSettings, autoInstallAgentSkill }) })
}

const showDetails = () => fireEvent.click(screen.getByRole('button', { name: 'Show details' }))

describe('AgentSkillSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.fetchAgentSkillStatus.mockResolvedValue(freshStatus)
    mocks.installAgentSkill.mockResolvedValue(freshStatus)
    mocks.uninstallAgentSkill.mockResolvedValue(freshStatus)
    mocks.syncAgentSkill.mockResolvedValue(freshStatus)
    setAutoInstall(true)
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

  test('turning the switch off records the choice without syncing', async () => {
    render(<AgentSkillSettings />)

    const auto = await screen.findByRole('switch', { name: /Keep the memory skill installed/ })
    expect(auto).toBeChecked()

    fireEvent.click(auto)
    expect(useWorkspaceStore.getState().settings.autoInstallAgentSkill).toBe(false)
    expect(mocks.syncAgentSkill).not.toHaveBeenCalled()
    expect(auto).not.toBeChecked()
  })

  test('turning the switch back on installs immediately instead of waiting for the next launch', async () => {
    setAutoInstall(false)
    render(<AgentSkillSettings />)

    fireEvent.click(await screen.findByRole('switch', { name: /Keep the memory skill installed/ }))

    expect(useWorkspaceStore.getState().settings.autoInstallAgentSkill).toBe(true)
    await waitFor(() => expect(mocks.syncAgentSkill).toHaveBeenCalledTimes(1))
  })

  test('hides the stale notice while auto-install keeps every copy current', async () => {
    mocks.fetchAgentSkillStatus.mockResolvedValue(staleStatus)
    render(<AgentSkillSettings />)

    await screen.findByRole('switch', { name: /Keep the memory skill installed/ })
    expect(screen.queryByText(/Skill update available/)).not.toBeInTheDocument()
  })

  test('announces a stale copy once auto-install is off', async () => {
    setAutoInstall(false)
    mocks.fetchAgentSkillStatus.mockResolvedValue(staleStatus)
    render(<AgentSkillSettings />)

    expect(await screen.findByText(/Skill update available \(revision 2\)/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Update all/ }))
    await waitFor(() => expect(mocks.installAgentSkill).toHaveBeenCalledWith(['agents']))
  })

  test('keeps the target list behind the details toggle', async () => {
    render(<AgentSkillSettings />)

    await screen.findByRole('button', { name: 'Show details' })
    expect(screen.queryByText('C:/Users/js/.claude/skills')).not.toBeInTheDocument()

    showDetails()
    expect(screen.getByText('C:/Users/js/.claude/skills')).toBeInTheDocument()
    expect(screen.getAllByText('Installed')).toHaveLength(2)
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
})

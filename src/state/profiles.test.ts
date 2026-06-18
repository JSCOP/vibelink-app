import { describe, expect, test } from 'vitest'
import { defaultSettings, normalizeSettings, paneOverridesFromProfile, selectedProfile } from './profiles'

describe('terminal profiles', () => {
  test('normalizes empty settings with a default profile', () => {
    const settings = normalizeSettings(null)

    expect(settings.profiles.length).toBeGreaterThan(0)
    expect(settings.defaultProfileId).toBe(settings.profiles[0].id)
    expect(selectedProfile(settings).id).toBe(settings.defaultProfileId)
  })

  test('ships common terminal and agent profiles by default', () => {
    const profileNames = normalizeSettings(null).profiles.map((profile) => profile.name)

    expect(profileNames).toEqual(expect.arrayContaining(['Shell', 'PowerShell', 'CMD', 'Claude', 'Codex', 'OMP']))
  })

  test('migrates legacy flat shell into the default profile only', () => {
    const settings = normalizeSettings({ shell: 'cmd.exe', fontSize: 15 })

    expect(settings.fontSize).toBe(15)
    expect(settings.profiles[0]).toMatchObject({ shell: 'cmd.exe' })
    expect('shell' in settings).toBe(false)
  })

  test('normalizes keybinding settings with Windows Terminal compatible defaults', () => {
    const settings = normalizeSettings({ keybindings: { closePane: 'ctrl+q' } })

    expect(settings.keybindings.closePane).toBe('ctrl+q')
    expect(settings.keybindings.focusLeft).toBe('ctrl+left')
  })

  test('builds pane config fields from selected profile', () => {
    const settings = normalizeSettings({
      ...defaultSettings,
      defaultProfileId: 'agent',
      profiles: [
        {
          id: 'agent',
          name: 'Codex',
          shell: 'codex.cmd',
          args: ['--dangerously-bypass-approvals-and-sandbox'],
          env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
          cwd: 'E:/work',
          color: '#7ee787',
          icon: 'sparkles',
        },
      ],
    })

    expect(paneOverridesFromProfile(selectedProfile(settings), 'Codex 1')).toEqual({
      shell: 'codex.cmd',
      args: ['--dangerously-bypass-approvals-and-sandbox'],
      env: [['TERM_PROGRAM', 'AgenticWorkspaceTerminal']],
      cwd: 'E:/work',
      title: 'Codex 1',
    })
  })
})

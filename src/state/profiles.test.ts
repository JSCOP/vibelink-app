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

  test('normalizes terminal font and theme choices', () => {
    const themed = normalizeSettings({ fontFamily: '  Cascadia Code  ', terminalThemeId: 'aurora' })

    expect(themed.fontFamily).toBe('Cascadia Code')
    expect(themed.terminalThemeId).toBe('aurora')

    const fallback = normalizeSettings({ fontFamily: '   ', terminalThemeId: 'missing-theme' })

    expect(fallback.fontFamily).toBe(defaultSettings.fontFamily)
    expect(fallback.terminalThemeId).toBe(defaultSettings.terminalThemeId)
  })

  test('normalizes terminal scrollbar visibility setting', () => {
    expect(normalizeSettings({ terminalScrollbarVisible: false }).terminalScrollbarVisible).toBe(false)
    expect(normalizeSettings({ terminalScrollbarVisible: 'nope' }).terminalScrollbarVisible).toBe(defaultSettings.terminalScrollbarVisible)
  })

  test('normalizes terminal font weight and UI scale settings', () => {
    expect(normalizeSettings({ terminalFontWeight: 500 }).terminalFontWeight).toBe(500)
    expect(normalizeSettings({ terminalFontWeight: 1200 }).terminalFontWeight).toBe(defaultSettings.terminalFontWeight)
    expect(normalizeSettings({ uiScale: 1.1 }).uiScale).toBe(1.1)
    expect(normalizeSettings({ uiScale: 3 }).uiScale).toBe(defaultSettings.uiScale)
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

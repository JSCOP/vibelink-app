import { describe, expect, it } from 'vitest'
import { buildRemoteAppearance } from './appearancePayload'
import { defaultSettings } from '../state/profiles'
import { terminalThemeDefinitionById } from '../state/terminalThemes'

describe('buildRemoteAppearance', () => {
  it('resolves the default terminal theme and appearance settings', () => {
    const payload = buildRemoteAppearance(defaultSettings)
    const theme = terminalThemeDefinitionById(defaultSettings.terminalThemeId)

    expect(payload.themeId).toBe('orcaDark')
    expect(payload.themeName).toBe(theme.name)
    expect(payload.terminal).toEqual(theme.terminal)
    expect(payload.uiVars['--vibelink-terminal-bg']).toBe(theme.terminal.background)
    expect(payload.fontFamily).toBe(defaultSettings.fontFamily)
    expect(payload.fontWeight).toBe(String(defaultSettings.terminalFontWeight))
    expect(payload.fontWeightBold).toBe('700')
    expect(payload.selectedPaneHighlightColor).toBe('#737373')
    expect(payload.alarmHighlightColor).toBe('#86efac')
    expect(payload.reviewedPaneHighlightColor).toBe('#3794ff')
    expect(payload).not.toHaveProperty('workspaceAlerts')
  })
})

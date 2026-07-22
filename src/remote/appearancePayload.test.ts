import { describe, expect, it } from 'vitest'
import { buildRemoteAppearance } from './appearancePayload'
import { defaultSettings } from '../state/profiles'
import { terminalThemeDefinitionById } from '../state/terminalThemes'

describe('buildRemoteAppearance', () => {
  it('resolves the default terminal theme and appearance settings', () => {
    const payload = buildRemoteAppearance(defaultSettings)
    const abyss = terminalThemeDefinitionById('abyss')

    expect(payload.themeId).toBe('abyss')
    expect(payload.themeName).toBe(abyss.name)
    expect(payload.terminal).toEqual(abyss.terminal)
    expect(payload.uiVars['--vibelink-terminal-bg']).toBe(abyss.terminal.background)
    expect(payload.fontFamily).toBe(defaultSettings.fontFamily)
    expect(payload.fontWeight).toBe(String(defaultSettings.terminalFontWeight))
    expect(payload.fontWeightBold).toBe('700')
    expect(payload.selectedPaneHighlightColor).toBe('#ff9f1a')
    expect(payload.alarmHighlightColor).toBe('#7ee787')
    expect(payload.reviewedPaneHighlightColor).toBe('#58a6ff')
    expect(payload).not.toHaveProperty('workspaceAlerts')
  })
})

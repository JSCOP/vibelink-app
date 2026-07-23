import { describe, expect, test, vi } from 'vitest'
import { terminalThemeDefinitionById } from '../state/terminalThemes'
import { registerVibeLinkMonacoThemes, vibeLinkMonacoThemeName } from './monacoTheme'

describe('VibeLink Monaco themes', () => {
  test('defines synchronized dark and light themes from terminal palettes', () => {
    const defineTheme = vi.fn()
    const monaco = { editor: { defineTheme } } as never

    expect(registerVibeLinkMonacoThemes(monaco, 'tokyoNight')).toBe('vibelink-dark')
    expect(defineTheme).toHaveBeenCalledTimes(2)
    const dark = defineTheme.mock.calls.find(([name]) => name === 'vibelink-dark')?.[1]
    expect(dark).toMatchObject({
      base: 'vs-dark',
      colors: {
        'editor.background': terminalThemeDefinitionById('tokyoNight').ui.panel,
        'editor.foreground': terminalThemeDefinitionById('tokyoNight').ui.text,
      },
    })

    defineTheme.mockClear()
    expect(registerVibeLinkMonacoThemes(monaco, 'oneHalfLight')).toBe('vibelink-light')
    const light = defineTheme.mock.calls.find(([name]) => name === 'vibelink-light')?.[1]
    expect(light).toMatchObject({
      base: 'vs',
      colors: {
        'editor.background': terminalThemeDefinitionById('oneHalfLight').ui.panel,
        'editor.foreground': terminalThemeDefinitionById('oneHalfLight').ui.text,
      },
    })
    expect(vibeLinkMonacoThemeName('oneHalfLight')).toBe('vibelink-light')
  })

  test('maps code and markdown token scopes to distinct palette colors', () => {
    const defineTheme = vi.fn()
    const monaco = { editor: { defineTheme } } as never
    registerVibeLinkMonacoThemes(monaco, 'tokyoNight')
    const dark = defineTheme.mock.calls.find(([name]) => name === 'vibelink-dark')?.[1] as { rules: { token: string; foreground?: string; fontStyle?: string }[] }
    const tokens = new Set(dark.rules.map((rule) => rule.token))
    // Code scopes that must be colored, not left at the default foreground.
    for (const scope of ['keyword', 'string', 'number', 'comment', 'type', 'regexp']) {
      expect(tokens.has(scope)).toBe(true)
    }
    // Markdown scopes Monaco's Monarch grammar emits — these were previously
    // unmapped, which is why markdown rendered almost entirely gray.
    for (const scope of ['strong', 'emphasis', 'string.link.md', 'variable.source.md']) {
      expect(tokens.has(scope)).toBe(true)
    }
    const strong = dark.rules.find((rule) => rule.token === 'strong')
    expect(strong?.fontStyle).toContain('bold')
    const emphasis = dark.rules.find((rule) => rule.token === 'emphasis')
    expect(emphasis?.fontStyle).toContain('italic')
  })
})

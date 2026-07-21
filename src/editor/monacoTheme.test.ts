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
})

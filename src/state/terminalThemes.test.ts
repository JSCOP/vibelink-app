import { describe, expect, test } from 'vitest'
import {
  defaultTerminalThemeId,
  agentTerminalTheme,
  terminalThemeById,
  terminalThemeDefinitionById,
  terminalThemeGroups,
  terminalThemes,
  themeCssVariables,
  type RequiredTerminalTheme,
} from './terminalThemes'

const terminalColorKeys: (keyof RequiredTerminalTheme)[] = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
]

const requiredCssVariables = [
  '--awt-bg',
  '--awt-sidebar',
  '--awt-panel',
  '--awt-panel-2',
  '--awt-panel-3',
  '--awt-input',
  '--awt-border',
  '--awt-border-soft',
  '--awt-text',
  '--awt-muted',
  '--awt-accent',
  '--awt-danger',
  '--awt-overlay',
  '--awt-dialog',
] as const

describe('terminalThemes', () => {
  test('provides the expected curated theme count with unique ids', () => {
    expect(terminalThemes).toHaveLength(24)
    expect(new Set(terminalThemes.map((theme) => theme.id)).size).toBe(terminalThemes.length)
    expect(terminalThemes.some((theme) => theme.id === defaultTerminalThemeId)).toBe(true)
  })

  test('defines complete terminal palettes', () => {
    for (const theme of terminalThemes) {
      expect(['dark', 'light']).toContain(theme.colorScheme)
      for (const key of terminalColorKeys) {
        expect(theme.terminal[key], `${theme.id}.${key}`).toMatch(/^#[0-9a-f]{6}$/i)
      }
    }
  })

  test('creates app css variables for every theme', () => {
    for (const theme of terminalThemes) {
      const variables = themeCssVariables(theme.id)
      for (const variable of requiredCssVariables) {
        expect(variables[variable], `${theme.id}.${variable}`).toBeTruthy()
      }
      expect(variables['--awt-bg']).toBe(theme.ui.background)
      expect(variables['--awt-accent']).toBe(theme.ui.accent)
    }
  })

  test('groups themes without dropping entries', () => {
    const groupedThemeIds = terminalThemeGroups.flatMap((group) => group.themes.map((theme) => theme.id))

    expect(groupedThemeIds).toEqual(terminalThemes.map((theme) => theme.id))
  })

  test('falls back to the default theme for unknown ids', () => {
    expect(terminalThemeDefinitionById('missing-theme')).toBe(terminalThemeDefinitionById(defaultTerminalThemeId))
    expect(terminalThemeById('missing-theme')).toBe(terminalThemeById(defaultTerminalThemeId))
  })

  test('pins terminal panes to the agent-friendly palette', () => {
    expect(agentTerminalTheme).toBe(terminalThemeById(defaultTerminalThemeId))
    expect(agentTerminalTheme.background).toBe('#0b0f14')
    expect(agentTerminalTheme.foreground).toBe('#d6deeb')
    expect(agentTerminalTheme.yellow).toBe('#f2cc60')
    expect(agentTerminalTheme.green).toBe('#7ee787')
    expect(agentTerminalTheme.blue).toBe('#79c0ff')
    expect(agentTerminalTheme.cyan).toBe('#76e3ea')
  })
})

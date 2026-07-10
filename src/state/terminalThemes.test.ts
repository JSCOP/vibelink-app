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
  '--vibelink-bg',
  '--vibelink-sidebar',
  '--vibelink-panel',
  '--vibelink-panel-2',
  '--vibelink-panel-3',
  '--vibelink-input',
  '--vibelink-border',
  '--vibelink-border-soft',
  '--vibelink-text',
  '--vibelink-muted',
  '--vibelink-accent',
  '--vibelink-danger',
  '--vibelink-overlay',
  '--vibelink-dialog',
  '--vibelink-focus',
] as const

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)

  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  const [red, green, blue] = [r, g, b].map((value) => {
    const channel = value / 255
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  })

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) throw new Error(`Expected hex color, received ${hex}`)
  const value = match[1]

  return {
    r: Number.parseInt(value.slice(0, 2), 16),
    g: Number.parseInt(value.slice(2, 4), 16),
    b: Number.parseInt(value.slice(4, 6), 16),
  }
}

describe('terminalThemes', () => {
  test('provides the expected curated theme count with unique ids', () => {
    expect(terminalThemes).toHaveLength(26)
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
      expect(variables['--vibelink-bg']).toBe(theme.ui.background)
      expect(variables['--vibelink-accent']).toBe(theme.ui.accent)
      // App.css paints terminal hosts/viewports from these (with !important);
      // if they fall back to the static :root defaults every theme's terminal
      // stays pinned to the Abyss background.
      expect(variables['--vibelink-terminal-bg']).toBe(theme.terminal.background)
      expect(variables['--vibelink-terminal-fg']).toBe(theme.terminal.foreground)
    }
  })

  test('keeps muted text legible against theme backgrounds', () => {
    for (const theme of terminalThemes) {
      const minimumContrast = theme.colorScheme === 'light' ? 4.5 : 4.0
      expect(contrastRatio(theme.ui.muted, theme.ui.background), `${theme.id}.muted`).toBeGreaterThanOrEqual(minimumContrast)
    }
  })

  test('keeps remapped Solarized bright ANSI colors legible', () => {
    const keys: (keyof RequiredTerminalTheme)[] = ['brightBlack', 'brightGreen', 'brightYellow', 'brightBlue']

    for (const themeId of ['solarizedDark', 'solarizedLight']) {
      const theme = terminalThemeDefinitionById(themeId)
      for (const key of keys) {
        expect(contrastRatio(theme.terminal[key], theme.terminal.background), `${theme.id}.${key}`).toBeGreaterThanOrEqual(4.5)
      }
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

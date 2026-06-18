import type { ITheme } from '@xterm/xterm'

export type TerminalThemeId = 'abyss' | 'aurora' | 'paper'

export type TerminalThemeDefinition = {
  id: TerminalThemeId
  name: string
  description: string
  theme: ITheme
}

export const terminalThemes: TerminalThemeDefinition[] = [
  {
    id: 'abyss',
    name: 'Abyss',
    description: 'Low-glare dark terminal for long agent sessions.',
    theme: {
      background: '#0b0f14',
      foreground: '#d6deeb',
      cursor: '#7ee787',
      cursorAccent: '#0b0f14',
      selectionBackground: '#264f78',
      black: '#0b0f14',
      red: '#ff6b6b',
      green: '#7ee787',
      yellow: '#f2cc60',
      blue: '#79c0ff',
      magenta: '#d2a8ff',
      cyan: '#76e3ea',
      white: '#d6deeb',
      brightBlack: '#5c6773',
      brightRed: '#ff8f8f',
      brightGreen: '#9ff5b7',
      brightYellow: '#f7dc84',
      brightBlue: '#9ecbff',
      brightMagenta: '#e2c5ff',
      brightCyan: '#9af0f5',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Dark blue-green theme with higher contrast prompts.',
    theme: {
      background: '#07131a',
      foreground: '#d8fff0',
      cursor: '#8cffc1',
      cursorAccent: '#07131a',
      selectionBackground: '#174c57',
      black: '#07131a',
      red: '#ff7a90',
      green: '#8cffc1',
      yellow: '#ffd479',
      blue: '#79d7ff',
      magenta: '#c7a5ff',
      cyan: '#5df2e6',
      white: '#d8fff0',
      brightBlack: '#52717a',
      brightRed: '#ff9caf',
      brightGreen: '#b0ffd4',
      brightYellow: '#ffe39e',
      brightBlue: '#a7e5ff',
      brightMagenta: '#dcc6ff',
      brightCyan: '#96fff4',
      brightWhite: '#ffffff',
    },
  },
  {
    id: 'paper',
    name: 'Paper dark',
    description: 'Warm dark neutral with muted ANSI colors.',
    theme: {
      background: '#11100f',
      foreground: '#ece1d2',
      cursor: '#e8bf6a',
      cursorAccent: '#11100f',
      selectionBackground: '#4a3d2b',
      black: '#11100f',
      red: '#e68183',
      green: '#a8c77b',
      yellow: '#d9b56f',
      blue: '#8ab4d8',
      magenta: '#c29bd6',
      cyan: '#8ccfc4',
      white: '#ece1d2',
      brightBlack: '#766b60',
      brightRed: '#f0a0a2',
      brightGreen: '#c0dc95',
      brightYellow: '#e7c987',
      brightBlue: '#a4cae8',
      brightMagenta: '#d8b2e7',
      brightCyan: '#a9e3da',
      brightWhite: '#fff8ed',
    },
  },
]

export const defaultTerminalThemeId: TerminalThemeId = 'abyss'

export function terminalThemeById(id: string): ITheme {
  return terminalThemes.find((theme) => theme.id === id)?.theme ?? terminalThemes[0].theme
}

export function isTerminalThemeId(value: string): value is TerminalThemeId {
  return terminalThemes.some((theme) => theme.id === value)
}

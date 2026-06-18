import type { ITheme } from '@xterm/xterm'

export type TerminalThemeId = 'abyss' | 'campbell' | 'oneHalfDark' | 'solarizedDark' | 'tangoDark' | 'vintage' | 'aurora' | 'paper'

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
      background: '#0b0f14', foreground: '#d6deeb', cursor: '#7ee787', cursorAccent: '#0b0f14', selectionBackground: '#264f78',
      black: '#0b0f14', red: '#ff6b6b', green: '#7ee787', yellow: '#f2cc60', blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#76e3ea', white: '#d6deeb',
      brightBlack: '#5c6773', brightRed: '#ff8f8f', brightGreen: '#9ff5b7', brightYellow: '#f7dc84', brightBlue: '#9ecbff', brightMagenta: '#e2c5ff', brightCyan: '#9af0f5', brightWhite: '#ffffff',
    },
  },
  {
    id: 'campbell',
    name: 'Campbell',
    description: 'Windows Terminal default dark palette.',
    theme: {
      background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#0c0c0c', selectionBackground: '#0037da',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
  },
  {
    id: 'oneHalfDark',
    name: 'One Half Dark',
    description: 'Windows Terminal One Half dark scheme.',
    theme: {
      background: '#282c34', foreground: '#dcdfe4', cursor: '#dcdfe4', cursorAccent: '#282c34', selectionBackground: '#3e4451',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
      brightBlack: '#5a6374', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#dcdfe4',
    },
  },
  {
    id: 'solarizedDark',
    name: 'Solarized Dark',
    description: 'Classic low-contrast Solarized dark.',
    theme: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  },
  {
    id: 'tangoDark',
    name: 'Tango Dark',
    description: 'Windows Terminal Tango dark scheme.',
    theme: {
      background: '#000000', foreground: '#d3d7cf', cursor: '#d3d7cf', cursorAccent: '#000000', selectionBackground: '#3465a4',
      black: '#000000', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000', blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    },
  },
  {
    id: 'vintage',
    name: 'Vintage',
    description: 'Windows Terminal retro green phosphor look.',
    theme: {
      background: '#000000', foreground: '#00ff00', cursor: '#00ff00', cursorAccent: '#000000', selectionBackground: '#00aa00',
      black: '#000000', red: '#800000', green: '#008000', yellow: '#808000', blue: '#000080', magenta: '#800080', cyan: '#008080', white: '#c0c0c0',
      brightBlack: '#808080', brightRed: '#ff0000', brightGreen: '#00ff00', brightYellow: '#ffff00', brightBlue: '#0000ff', brightMagenta: '#ff00ff', brightCyan: '#00ffff', brightWhite: '#ffffff',
    },
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Dark blue-green theme with higher contrast prompts.',
    theme: {
      background: '#07131a', foreground: '#d8fff0', cursor: '#8cffc1', cursorAccent: '#07131a', selectionBackground: '#174c57',
      black: '#07131a', red: '#ff7a90', green: '#8cffc1', yellow: '#ffd479', blue: '#79d7ff', magenta: '#c7a5ff', cyan: '#5df2e6', white: '#d8fff0',
      brightBlack: '#52717a', brightRed: '#ff9caf', brightGreen: '#b0ffd4', brightYellow: '#ffe39e', brightBlue: '#a7e5ff', brightMagenta: '#dcc6ff', brightCyan: '#96fff4', brightWhite: '#ffffff',
    },
  },
  {
    id: 'paper',
    name: 'Paper dark',
    description: 'Warm dark neutral with muted ANSI colors.',
    theme: {
      background: '#11100f', foreground: '#ece1d2', cursor: '#e8bf6a', cursorAccent: '#11100f', selectionBackground: '#4a3d2b',
      black: '#11100f', red: '#e68183', green: '#a8c77b', yellow: '#d9b56f', blue: '#8ab4d8', magenta: '#c29bd6', cyan: '#8ccfc4', white: '#ece1d2',
      brightBlack: '#766b60', brightRed: '#f0a0a2', brightGreen: '#c0dc95', brightYellow: '#e7c987', brightBlue: '#a4cae8', brightMagenta: '#d8b2e7', brightCyan: '#a9e3da', brightWhite: '#fff8ed',
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

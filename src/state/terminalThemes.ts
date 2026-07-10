import type { ITheme } from '@xterm/xterm'

type AnsiColorKey =
  | 'black'
  | 'red'
  | 'green'
  | 'yellow'
  | 'blue'
  | 'magenta'
  | 'cyan'
  | 'white'
  | 'brightBlack'
  | 'brightRed'
  | 'brightGreen'
  | 'brightYellow'
  | 'brightBlue'
  | 'brightMagenta'
  | 'brightCyan'
  | 'brightWhite'
export type TerminalColorScheme = 'dark' | 'light'

export type RequiredTerminalTheme = Required<Pick<ITheme,
  | 'background'
  | 'foreground'
  | 'cursor'
  | 'cursorAccent'
  | 'selectionBackground'
  | AnsiColorKey
>>

export type AppThemeTokens = {
  background: string
  sidebar: string
  panel: string
  panel2: string
  panel3: string
  input: string
  inputStrong: string
  border: string
  borderSoft: string
  text: string
  muted: string
  accent: string
  accentSoft: string
  accentMuted: string
  accentBorder: string
  danger: string
  dangerSoft: string
  dangerBorder: string
  dangerText: string
  hover: string
  active: string
  selection: string
  overlay: string
  dialog: string
  shadow: string
  shadowSoft: string
  inset: string
  scrollbarTrack: string
  scrollbarThumb: string
  blue: string
  blueSoft: string
  cyan: string
  cyanSoft: string
  warning: string
  warningSoft: string
  focus: string
}

export type TerminalThemeDefinition<TId extends string = string> = {
  id: TId
  name: string
  description: string
  category: string
  colorScheme: TerminalColorScheme
  terminal: RequiredTerminalTheme
  ui: AppThemeTokens
}

type ThemeInput<TId extends string> = Omit<TerminalThemeDefinition<TId>, 'ui'> & {
  ui?: Partial<AppThemeTokens>
}

function defineTheme<const TId extends string>(input: ThemeInput<TId>): TerminalThemeDefinition<TId> {
  const baseUi = createAppTheme(input.colorScheme, input.terminal)
  const ui = {
    ...baseUi,
    ...input.ui,
  }
  ui.focus = input.ui?.focus ?? ui.accent

  return {
    ...input,
    ui,
  }
}

export const terminalThemes = [
  defineTheme({
    id: 'abyss',
    name: 'Abyss',
    category: 'VibeLink',
    colorScheme: 'dark',
    description: 'Low-glare dark terminal for long agent sessions.',
    terminal: {
      background: '#0b0f14', foreground: '#d6deeb', cursor: '#7ee787', cursorAccent: '#0b0f14', selectionBackground: '#264f78',
      black: '#0b0f14', red: '#ff6b6b', green: '#7ee787', yellow: '#f2cc60', blue: '#79c0ff', magenta: '#d2a8ff', cyan: '#76e3ea', white: '#d6deeb',
      brightBlack: '#5c6773', brightRed: '#ff8f8f', brightGreen: '#9ff5b7', brightYellow: '#f7dc84', brightBlue: '#9ecbff', brightMagenta: '#e2c5ff', brightCyan: '#9af0f5', brightWhite: '#ffffff',
    },
    ui: {
      background: '#0d0f12',
      sidebar: '#090c10',
      panel: '#11161c',
      panel2: '#151b22',
      panel3: '#0f151d',
      input: '#10161d',
      inputStrong: '#05080e',
    },
  }),
  defineTheme({
    id: 'aurora',
    name: 'Aurora',
    category: 'VibeLink',
    colorScheme: 'dark',
    description: 'Dark blue-green theme with higher contrast prompts.',
    terminal: {
      background: '#07131a', foreground: '#d8fff0', cursor: '#8cffc1', cursorAccent: '#07131a', selectionBackground: '#174c57',
      black: '#07131a', red: '#ff7a90', green: '#8cffc1', yellow: '#ffd479', blue: '#79d7ff', magenta: '#c7a5ff', cyan: '#5df2e6', white: '#d8fff0',
      brightBlack: '#52717a', brightRed: '#ff9caf', brightGreen: '#b0ffd4', brightYellow: '#ffe39e', brightBlue: '#a7e5ff', brightMagenta: '#dcc6ff', brightCyan: '#96fff4', brightWhite: '#ffffff',
    },
  }),
  defineTheme({
    id: 'paper',
    name: 'Paper Dark',
    category: 'VibeLink',
    colorScheme: 'dark',
    description: 'Warm dark neutral with muted ANSI colors.',
    terminal: {
      background: '#11100f', foreground: '#ece1d2', cursor: '#e8bf6a', cursorAccent: '#11100f', selectionBackground: '#4a3d2b',
      black: '#11100f', red: '#e68183', green: '#a8c77b', yellow: '#d9b56f', blue: '#8ab4d8', magenta: '#c29bd6', cyan: '#8ccfc4', white: '#ece1d2',
      brightBlack: '#766b60', brightRed: '#f0a0a2', brightGreen: '#c0dc95', brightYellow: '#e7c987', brightBlue: '#a4cae8', brightMagenta: '#d8b2e7', brightCyan: '#a9e3da', brightWhite: '#fff8ed',
    },
  }),
  defineTheme({
    id: 'nightOwl',
    name: 'Night Owl',
    category: 'VibeLink',
    colorScheme: 'dark',
    description: 'Deep blue palette tuned for late-night readability.',
    terminal: {
      background: '#011627', foreground: '#d6deeb', cursor: '#80a4c2', cursorAccent: '#011627', selectionBackground: '#1d3b53',
      black: '#011627', red: '#ef5350', green: '#22da6e', yellow: '#addb67', blue: '#82aaff', magenta: '#c792ea', cyan: '#21c7a8', white: '#ffffff',
      brightBlack: '#575656', brightRed: '#ef5350', brightGreen: '#22da6e', brightYellow: '#ffeb95', brightBlue: '#82aaff', brightMagenta: '#c792ea', brightCyan: '#7fdbca', brightWhite: '#ffffff',
    },
  }),
  defineTheme({
    id: 'pureBlack',
    name: 'Pure Black',
    category: 'VibeLink',
    colorScheme: 'dark',
    description: 'True-black background with high-contrast standard ANSI colors.',
    terminal: {
      background: '#000000', foreground: '#e6e6e6', cursor: '#ffffff', cursorAccent: '#000000', selectionBackground: '#3a3a3a',
      black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
      brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#ffffff',
    },
    ui: {
      // Neutral chrome: no blue-tinted borders/hover — separation comes from
      // plain white alpha so the whole app stays pitch black and high contrast.
      background: '#000000',
      sidebar: '#000000',
      panel: '#0a0a0a',
      panel2: '#111111',
      panel3: '#161616',
      input: '#0d0d0d',
      inputStrong: '#050505',
      border: 'rgba(255, 255, 255, 0.24)',
      borderSoft: 'rgba(255, 255, 255, 0.13)',
      hover: 'rgba(255, 255, 255, 0.09)',
      dialog: '#0a0a0a',
      scrollbarTrack: '#000000',
      scrollbarThumb: 'rgba(255, 255, 255, 0.4)',
    },
  }),
  defineTheme({
    id: 'carbon',
    name: 'Carbon',
    category: 'VibeLink',
    colorScheme: 'dark',
    description: 'Neutral charcoal without any blue tint, ordinary contrast.',
    terminal: {
      background: '#121212', foreground: '#dcdcdc', cursor: '#dcdcdc', cursorAccent: '#121212', selectionBackground: '#3f3f3f',
      black: '#121212', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdcdc',
      brightBlack: '#7a7a7a', brightRed: '#ef8a93', brightGreen: '#b2d69a', brightYellow: '#efd394', brightBlue: '#8cc6f4', brightMagenta: '#d99ae8', brightCyan: '#7fcdd6', brightWhite: '#ffffff',
    },
    ui: {
      background: '#121212',
      sidebar: '#0e0e0e',
      panel: '#1a1a1a',
      panel2: '#202020',
      panel3: '#262626',
      input: '#1c1c1c',
      inputStrong: '#0c0c0c',
      border: 'rgba(255, 255, 255, 0.2)',
      borderSoft: 'rgba(255, 255, 255, 0.11)',
      hover: 'rgba(255, 255, 255, 0.07)',
      dialog: '#1a1a1a',
    },
  }),
  defineTheme({
    id: 'campbell',
    name: 'Campbell',
    category: 'Windows Terminal',
    colorScheme: 'dark',
    description: 'Windows Terminal default dark palette.',
    terminal: {
      background: '#0c0c0c', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#0c0c0c', selectionBackground: '#0037da',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
  }),
  defineTheme({
    id: 'campbellPowershell',
    name: 'Campbell PowerShell',
    category: 'Windows Terminal',
    colorScheme: 'dark',
    description: 'Classic PowerShell blue background with Campbell ANSI colors.',
    terminal: {
      background: '#012456', foreground: '#cccccc', cursor: '#ffffff', cursorAccent: '#012456', selectionBackground: '#3a96dd',
      black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da', magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
      brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5', brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
    },
    ui: {
      accent: '#61d6d6',
      blue: '#3b78ff',
      cyan: '#61d6d6',
    },
  }),
  defineTheme({
    id: 'oneHalfDark',
    name: 'One Half Dark',
    category: 'Windows Terminal',
    colorScheme: 'dark',
    description: 'Windows Terminal One Half dark scheme.',
    terminal: {
      background: '#282c34', foreground: '#dcdfe4', cursor: '#dcdfe4', cursorAccent: '#282c34', selectionBackground: '#3e4451',
      black: '#282c34', red: '#e06c75', green: '#98c379', yellow: '#e5c07b', blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
      brightBlack: '#5a6374', brightRed: '#e06c75', brightGreen: '#98c379', brightYellow: '#e5c07b', brightBlue: '#61afef', brightMagenta: '#c678dd', brightCyan: '#56b6c2', brightWhite: '#dcdfe4',
    },
  }),
  defineTheme({
    id: 'oneHalfLight',
    name: 'One Half Light',
    category: 'Windows Terminal',
    colorScheme: 'light',
    description: 'Light counterpart to One Half Dark.',
    terminal: {
      background: '#fafafa', foreground: '#383a42', cursor: '#383a42', cursorAccent: '#fafafa', selectionBackground: '#bfceff',
      black: '#383a42', red: '#e45649', green: '#50a14f', yellow: '#c18401', blue: '#0184bc', magenta: '#a626a4', cyan: '#0997b3', white: '#fafafa',
      brightBlack: '#4f525d', brightRed: '#df6c75', brightGreen: '#98c379', brightYellow: '#e4c07a', brightBlue: '#61afef', brightMagenta: '#c577dd', brightCyan: '#56b5c1', brightWhite: '#ffffff',
    },
  }),
  defineTheme({
    id: 'solarizedDark',
    name: 'Solarized Dark',
    category: 'Windows Terminal',
    colorScheme: 'dark',
    description: 'Classic low-contrast Solarized dark.',
    terminal: {
      background: '#002b36', foreground: '#839496', cursor: '#93a1a1', cursorAccent: '#002b36', selectionBackground: '#073642',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#92a1a5', brightRed: '#cb4b16', brightGreen: '#b0bd59', brightYellow: '#cfb259', brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  }),
  defineTheme({
    id: 'solarizedLight',
    name: 'Solarized Light',
    category: 'Windows Terminal',
    colorScheme: 'light',
    description: 'Solarized light palette with calm contrast.',
    terminal: {
      background: '#fdf6e3', foreground: '#657b83', cursor: '#586e75', cursorAccent: '#fdf6e3', selectionBackground: '#eee8d5',
      black: '#073642', red: '#dc322f', green: '#859900', yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#002b36', brightRed: '#cb4b16', brightGreen: '#647300', brightYellow: '#886700', brightBlue: '#1e6fa8', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    },
  }),
  defineTheme({
    id: 'tangoDark',
    name: 'Tango Dark',
    category: 'Windows Terminal',
    colorScheme: 'dark',
    description: 'Windows Terminal Tango dark scheme.',
    terminal: {
      background: '#000000', foreground: '#d3d7cf', cursor: '#d3d7cf', cursorAccent: '#000000', selectionBackground: '#3465a4',
      black: '#000000', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000', blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    },
  }),
  defineTheme({
    id: 'tangoLight',
    name: 'Tango Light',
    category: 'Windows Terminal',
    colorScheme: 'light',
    description: 'Light Tango palette with GNOME-era ANSI colors.',
    terminal: {
      background: '#ffffff', foreground: '#555753', cursor: '#555753', cursorAccent: '#ffffff', selectionBackground: '#d3d7cf',
      black: '#000000', red: '#cc0000', green: '#4e9a06', yellow: '#c4a000', blue: '#3465a4', magenta: '#75507b', cyan: '#06989a', white: '#d3d7cf',
      brightBlack: '#555753', brightRed: '#ef2929', brightGreen: '#8ae234', brightYellow: '#fce94f', brightBlue: '#729fcf', brightMagenta: '#ad7fa8', brightCyan: '#34e2e2', brightWhite: '#eeeeec',
    },
  }),
  defineTheme({
    id: 'vintage',
    name: 'Vintage',
    category: 'Windows Terminal',
    colorScheme: 'dark',
    description: 'Windows Terminal retro green phosphor look.',
    terminal: {
      background: '#000000', foreground: '#00ff00', cursor: '#00ff00', cursorAccent: '#000000', selectionBackground: '#00aa00',
      black: '#000000', red: '#800000', green: '#008000', yellow: '#808000', blue: '#000080', magenta: '#800080', cyan: '#008080', white: '#c0c0c0',
      brightBlack: '#808080', brightRed: '#ff0000', brightGreen: '#00ff00', brightYellow: '#ffff00', brightBlue: '#0000ff', brightMagenta: '#ff00ff', brightCyan: '#00ffff', brightWhite: '#ffffff',
    },
  }),
  defineTheme({
    id: 'dracula',
    name: 'Dracula',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'High-contrast violet dark palette.',
    terminal: {
      background: '#282a36', foreground: '#f8f8f2', cursor: '#f8f8f2', cursorAccent: '#282a36', selectionBackground: '#44475a',
      black: '#21222c', red: '#ff5555', green: '#50fa7b', yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5', brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    },
  }),
  defineTheme({
    id: 'nord',
    name: 'Nord',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'Cool arctic dark palette with soft contrast.',
    terminal: {
      background: '#2e3440', foreground: '#d8dee9', cursor: '#d8dee9', cursorAccent: '#2e3440', selectionBackground: '#434c5e',
      black: '#3b4252', red: '#bf616a', green: '#a3be8c', yellow: '#ebcb8b', blue: '#81a1c1', magenta: '#b48ead', cyan: '#88c0d0', white: '#e5e9f0',
      brightBlack: '#4c566a', brightRed: '#bf616a', brightGreen: '#a3be8c', brightYellow: '#ebcb8b', brightBlue: '#81a1c1', brightMagenta: '#b48ead', brightCyan: '#8fbcbb', brightWhite: '#eceff4',
    },
  }),
  defineTheme({
    id: 'catppuccinMocha',
    name: 'Catppuccin Mocha',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'Soft pastel dark palette with readable accents.',
    terminal: {
      background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc', cursorAccent: '#1e1e2e', selectionBackground: '#45475a',
      black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af', blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
      brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af', brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8',
    },
  }),
  defineTheme({
    id: 'monokai',
    name: 'Monokai',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'Classic saturated editor palette.',
    terminal: {
      background: '#272822', foreground: '#f8f8f2', cursor: '#f8f8f0', cursorAccent: '#272822', selectionBackground: '#49483e',
      black: '#272822', red: '#f92672', green: '#a6e22e', yellow: '#f4bf75', blue: '#66d9ef', magenta: '#ae81ff', cyan: '#a1efe4', white: '#f8f8f2',
      brightBlack: '#75715e', brightRed: '#f92672', brightGreen: '#a6e22e', brightYellow: '#f4bf75', brightBlue: '#66d9ef', brightMagenta: '#ae81ff', brightCyan: '#a1efe4', brightWhite: '#f9f8f5',
    },
  }),
  defineTheme({
    id: 'githubDark',
    name: 'GitHub Dark',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'GitHub-inspired dark interface colors.',
    terminal: {
      background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', cursorAccent: '#0d1117', selectionBackground: '#1f6feb',
      black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922', blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
      brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364', brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff', brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
    },
  }),
  defineTheme({
    id: 'githubLight',
    name: 'GitHub Light',
    category: 'Popular',
    colorScheme: 'light',
    description: 'GitHub-inspired light terminal palette.',
    terminal: {
      background: '#ffffff', foreground: '#24292f', cursor: '#0969da', cursorAccent: '#ffffff', selectionBackground: '#ddf4ff',
      black: '#24292f', red: '#cf222e', green: '#116329', yellow: '#4d2d00', blue: '#0969da', magenta: '#8250df', cyan: '#1b7c83', white: '#f6f8fa',
      brightBlack: '#57606a', brightRed: '#a40e26', brightGreen: '#1a7f37', brightYellow: '#9a6700', brightBlue: '#218bff', brightMagenta: '#a475f9', brightCyan: '#3192aa', brightWhite: '#ffffff',
    },
  }),
  defineTheme({
    id: 'gruvboxDark',
    name: 'Gruvbox Dark',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'Warm retro dark palette with earthy ANSI colors.',
    terminal: {
      background: '#282828', foreground: '#ebdbb2', cursor: '#ebdbb2', cursorAccent: '#282828', selectionBackground: '#504945',
      black: '#282828', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f', brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#ebdbb2',
    },
  }),
  defineTheme({
    id: 'gruvboxLight',
    name: 'Gruvbox Light',
    category: 'Popular',
    colorScheme: 'light',
    description: 'Warm light variant of Gruvbox.',
    terminal: {
      background: '#fbf1c7', foreground: '#3c3836', cursor: '#3c3836', cursorAccent: '#fbf1c7', selectionBackground: '#d5c4a1',
      black: '#fbf1c7', red: '#cc241d', green: '#98971a', yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#7c6f64',
      brightBlack: '#928374', brightRed: '#9d0006', brightGreen: '#79740e', brightYellow: '#b57614', brightBlue: '#076678', brightMagenta: '#8f3f71', brightCyan: '#427b58', brightWhite: '#3c3836',
    },
  }),
  defineTheme({
    id: 'tokyoNight',
    name: 'Tokyo Night',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'Clean blue-black palette for dense terminal work.',
    terminal: {
      background: '#1a1b26', foreground: '#c0caf5', cursor: '#c0caf5', cursorAccent: '#1a1b26', selectionBackground: '#33467c',
      black: '#15161e', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68', blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#a9b1d6',
      brightBlack: '#414868', brightRed: '#f7768e', brightGreen: '#9ece6a', brightYellow: '#e0af68', brightBlue: '#7aa2f7', brightMagenta: '#bb9af7', brightCyan: '#7dcfff', brightWhite: '#c0caf5',
    },
  }),
  defineTheme({
    id: 'kanagawaWave',
    name: 'Kanagawa Wave',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'Ink-inspired dark palette with muted contrast.',
    terminal: {
      background: '#1f1f28', foreground: '#dcd7ba', cursor: '#c8c093', cursorAccent: '#1f1f28', selectionBackground: '#2d4f67',
      black: '#090618', red: '#c34043', green: '#76946a', yellow: '#c0a36e', blue: '#7e9cd8', magenta: '#957fb8', cyan: '#6a9589', white: '#c8c093',
      brightBlack: '#727169', brightRed: '#e82424', brightGreen: '#98bb6c', brightYellow: '#e6c384', brightBlue: '#7fb4ca', brightMagenta: '#938aa9', brightCyan: '#7aa89f', brightWhite: '#dcd7ba',
    },
  }),
  defineTheme({
    id: 'everforestDark',
    name: 'Everforest Dark',
    category: 'Popular',
    colorScheme: 'dark',
    description: 'Green-leaning dark palette with softened contrast.',
    terminal: {
      background: '#2d353b', foreground: '#d3c6aa', cursor: '#d3c6aa', cursorAccent: '#2d353b', selectionBackground: '#475258',
      black: '#343f44', red: '#e67e80', green: '#a7c080', yellow: '#dbbc7f', blue: '#7fbbb3', magenta: '#d699b6', cyan: '#83c092', white: '#d3c6aa',
      brightBlack: '#5c6a72', brightRed: '#e67e80', brightGreen: '#a7c080', brightYellow: '#dbbc7f', brightBlue: '#7fbbb3', brightMagenta: '#d699b6', brightCyan: '#83c092', brightWhite: '#d3c6aa',
    },
  }),
] as const

export type TerminalThemeId = (typeof terminalThemes)[number]['id']

export const defaultTerminalThemeId: TerminalThemeId = 'abyss'

export const terminalThemeGroups = groupThemesByCategory(terminalThemes)
export const agentTerminalTheme = terminalThemeById(defaultTerminalThemeId)

export function terminalThemeDefinitionById(id: string): TerminalThemeDefinition<TerminalThemeId> {
  return terminalThemes.find((theme) => theme.id === id) ?? terminalThemes[0]
}

export function terminalThemeById(id: string): ITheme {
  return terminalThemeDefinitionById(id).terminal
}

export function appThemeById(id: string): AppThemeTokens {
  return terminalThemeDefinitionById(id).ui
}

export function themeCssVariables(id: string): Record<`--vibelink-${string}`, string> {
  const theme = appThemeById(id)
  const terminal = terminalThemeDefinitionById(id).terminal
  return {
    // Terminal host + xterm viewport backgrounds are painted from these vars
    // (with !important in App.css), so they MUST track the selected theme —
    // as static :root defaults they pinned every theme's terminal to Abyss.
    '--vibelink-terminal-bg': terminal.background,
    '--vibelink-terminal-fg': terminal.foreground,
    '--vibelink-bg': theme.background,
    '--vibelink-sidebar': theme.sidebar,
    '--vibelink-panel': theme.panel,
    '--vibelink-panel-2': theme.panel2,
    '--vibelink-panel-3': theme.panel3,
    '--vibelink-input': theme.input,
    '--vibelink-input-strong': theme.inputStrong,
    '--vibelink-border': theme.border,
    '--vibelink-border-soft': theme.borderSoft,
    '--vibelink-text': theme.text,
    '--vibelink-muted': theme.muted,
    '--vibelink-accent': theme.accent,
    '--vibelink-accent-soft': theme.accentSoft,
    '--vibelink-accent-muted': theme.accentMuted,
    '--vibelink-accent-border': theme.accentBorder,
    '--vibelink-danger': theme.danger,
    '--vibelink-danger-soft': theme.dangerSoft,
    '--vibelink-danger-border': theme.dangerBorder,
    '--vibelink-danger-text': theme.dangerText,
    '--vibelink-hover': theme.hover,
    '--vibelink-active': theme.active,
    '--vibelink-selection': theme.selection,
    '--vibelink-overlay': theme.overlay,
    '--vibelink-dialog': theme.dialog,
    '--vibelink-shadow': theme.shadow,
    '--vibelink-shadow-soft': theme.shadowSoft,
    '--vibelink-inset': theme.inset,
    '--vibelink-scrollbar-track': theme.scrollbarTrack,
    '--vibelink-scrollbar-thumb': theme.scrollbarThumb,
    '--vibelink-blue': theme.blue,
    '--vibelink-blue-soft': theme.blueSoft,
    '--vibelink-cyan': theme.cyan,
    '--vibelink-cyan-soft': theme.cyanSoft,
    '--vibelink-warning': theme.warning,
    '--vibelink-warning-soft': theme.warningSoft,
    '--vibelink-focus': theme.focus,
  }
}

export function isTerminalThemeId(value: string): value is TerminalThemeId {
  return terminalThemes.some((theme) => theme.id === value)
}

function createAppTheme(colorScheme: TerminalColorScheme, terminal: RequiredTerminalTheme): AppThemeTokens {
  const isDark = colorScheme === 'dark'
  const background = terminal.background
  const foreground = terminal.foreground
  const panel = mixHex(background, foreground, isDark ? 0.05 : 0.025)
  const panel2 = mixHex(background, foreground, isDark ? 0.09 : 0.05)
  const panel3 = mixHex(background, foreground, isDark ? 0.12 : 0.08)
  const input = mixHex(background, foreground, isDark ? 0.07 : 0.018)
  const inputStrong = mixHex(background, foreground, isDark ? 0.025 : 0.01)
  const accent = terminal.cursor || terminal.green
  const muted = isDark
    ? readableMuted(background, foreground, 0.62, 4)
    : mixHex(foreground, '#000000', 0.15)

  return {
    background,
    sidebar: mixHex(background, foreground, isDark ? 0.025 : 0.015),
    panel,
    panel2,
    panel3,
    input,
    inputStrong,
    border: rgbaFromHex(terminal.blue, isDark ? 0.28 : 0.34),
    borderSoft: rgbaFromHex(terminal.blue, isDark ? 0.16 : 0.22),
    text: foreground,
    muted,
    accent,
    accentSoft: rgbaFromHex(accent, isDark ? 0.12 : 0.16),
    accentMuted: rgbaFromHex(accent, isDark ? 0.08 : 0.1),
    accentBorder: rgbaFromHex(accent, isDark ? 0.42 : 0.5),
    danger: terminal.red,
    dangerSoft: rgbaFromHex(terminal.red, isDark ? 0.12 : 0.14),
    dangerBorder: rgbaFromHex(terminal.red, isDark ? 0.28 : 0.36),
    dangerText: isDark ? mixHex(terminal.red, '#ffffff', 0.62) : mixHex(terminal.red, '#000000', 0.1),
    hover: rgbaFromHex(terminal.blue, isDark ? 0.12 : 0.1),
    active: rgbaFromHex(accent, isDark ? 0.12 : 0.14),
    selection: terminal.selectionBackground,
    overlay: isDark ? 'rgba(2, 6, 12, 0.72)' : 'rgba(229, 234, 242, 0.72)',
    dialog: isDark ? panel : '#ffffff',
    shadow: isDark ? '0 18px 60px rgba(0, 0, 0, 0.5)' : '0 18px 60px rgba(31, 35, 40, 0.18)',
    shadowSoft: isDark ? '10px 0 28px rgba(0, 0, 0, 0.28)' : '10px 0 28px rgba(31, 35, 40, 0.12)',
    inset: isDark ? 'inset 0 0 0 1px rgba(255, 255, 255, 0.035)' : 'inset 0 0 0 1px rgba(31, 35, 40, 0.055)',
    scrollbarTrack: isDark ? mixHex(background, '#000000', 0.18) : mixHex(background, '#000000', 0.04),
    scrollbarThumb: rgbaFromHex(accent, isDark ? 0.75 : 0.65),
    blue: terminal.blue,
    blueSoft: rgbaFromHex(terminal.blue, isDark ? 0.12 : 0.1),
    cyan: terminal.cyan,
    cyanSoft: rgbaFromHex(terminal.cyan, isDark ? 0.12 : 0.14),
    warning: terminal.yellow,
    warningSoft: rgbaFromHex(terminal.yellow, isDark ? 0.16 : 0.18),
    focus: accent,
  }
}

function groupThemesByCategory(themes: readonly TerminalThemeDefinition<TerminalThemeId>[]): { category: string; themes: readonly TerminalThemeDefinition<TerminalThemeId>[] }[] {
  const groups = new Map<string, TerminalThemeDefinition<TerminalThemeId>[]>()
  for (const theme of themes) {
    groups.set(theme.category, [...(groups.get(theme.category) ?? []), theme])
  }
  return [...groups.entries()].map(([category, items]) => ({ category, themes: items }))
}

function mixHex(first: string, second: string, weight: number): string {
  const a = hexToRgb(first)
  const b = hexToRgb(second)
  if (!a || !b) return first
  const clamped = Math.min(1, Math.max(0, weight))
  return rgbToHex(
    Math.round(a.r + (b.r - a.r) * clamped),
    Math.round(a.g + (b.g - a.g) * clamped),
    Math.round(a.b + (b.b - a.b) * clamped),
  )
}

function readableMuted(background: string, foreground: string, initialWeight: number, minimumContrast: number): string {
  const initial = mixHex(background, foreground, initialWeight)
  if (contrastRatio(initial, background) >= minimumContrast) return initial

  for (let weight = initialWeight + 0.05; weight <= 1; weight += 0.05) {
    const candidate = mixHex(background, foreground, weight)
    if (contrastRatio(candidate, background) >= minimumContrast) return candidate
  }

  return foreground
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = relativeLuminance(first)
  const secondLuminance = relativeLuminance(second)
  if (firstLuminance === null || secondLuminance === null) return 0

  const lighter = Math.max(firstLuminance, secondLuminance)
  const darker = Math.min(firstLuminance, secondLuminance)

  return (lighter + 0.05) / (darker + 0.05)
}

function relativeLuminance(hex: string): number | null {
  const rgb = hexToRgb(hex)
  if (!rgb) return null
  const red = linearizeColorChannel(rgb.r)
  const green = linearizeColorChannel(rgb.g)
  const blue = linearizeColorChannel(rgb.b)

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue
}

function linearizeColorChannel(value: number): number {
  const channel = value / 255
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
}

function rgbaFromHex(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return hex
  const clamped = Math.min(1, Math.max(0, alpha))
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${trimNumber(clamped)})`
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return null
  const value = Number.parseInt(match[1], 16)
  return {
    r: (value >> 16) & 255,
    g: (value >> 8) & 255,
    b: value & 255,
  }
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, '0')
}

function trimNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

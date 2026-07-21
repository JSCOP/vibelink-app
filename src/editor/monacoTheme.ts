import type * as Monaco from 'monaco-editor'
import { terminalThemeDefinitionById, terminalThemes, type TerminalColorScheme, type TerminalThemeDefinition } from '../state/terminalThemes'

export const VIBELINK_MONACO_THEME_DARK = 'vibelink-dark'
export const VIBELINK_MONACO_THEME_LIGHT = 'vibelink-light'

export type MonacoModule = typeof Monaco

export function registerVibeLinkMonacoThemes(monaco: MonacoModule, terminalThemeId: string): string {
  const selected = terminalThemeDefinitionById(terminalThemeId)
  const dark = themeForScheme(selected, 'dark')
  const light = themeForScheme(selected, 'light')
  monaco.editor.defineTheme(VIBELINK_MONACO_THEME_DARK, themeData(dark))
  monaco.editor.defineTheme(VIBELINK_MONACO_THEME_LIGHT, themeData(light))
  return vibeLinkMonacoThemeName(terminalThemeId)
}

export function vibeLinkMonacoThemeName(terminalThemeId: string): string {
  return terminalThemeDefinitionById(terminalThemeId).colorScheme === 'light' ? VIBELINK_MONACO_THEME_LIGHT : VIBELINK_MONACO_THEME_DARK
}

function themeForScheme(selected: TerminalThemeDefinition, scheme: TerminalColorScheme): TerminalThemeDefinition {
  if (selected.colorScheme === scheme) return selected
  return terminalThemes.find((theme) => theme.colorScheme === scheme) ?? selected
}

function themeData(theme: TerminalThemeDefinition): Monaco.editor.IStandaloneThemeData {
  const terminal = theme.terminal
  const ui = theme.ui
  return {
    base: theme.colorScheme === 'light' ? 'vs' : 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: hex(terminal.brightBlack), fontStyle: 'italic' },
      { token: 'string', foreground: hex(terminal.green) },
      { token: 'number', foreground: hex(terminal.magenta) },
      { token: 'keyword', foreground: hex(terminal.blue) },
      { token: 'type', foreground: hex(terminal.cyan) },
      { token: 'type.identifier', foreground: hex(terminal.cyan) },
      { token: 'identifier.function', foreground: hex(terminal.yellow) },
      { token: 'variable', foreground: hex(terminal.foreground) },
      { token: 'variable.predefined', foreground: hex(terminal.brightCyan) },
      { token: 'constant', foreground: hex(terminal.brightMagenta) },
      { token: 'tag', foreground: hex(terminal.blue) },
      { token: 'attribute.name', foreground: hex(terminal.cyan) },
      { token: 'invalid', foreground: hex(terminal.brightRed), fontStyle: 'underline' },
      { token: 'deprecated', foreground: hex(terminal.brightBlack), fontStyle: 'strikethrough' },
    ],
    colors: {
      'editor.background': ui.panel,
      'editor.foreground': ui.text,
      'editorCursor.foreground': terminal.cursor,
      'editor.selectionBackground': ui.selection,
      'editor.inactiveSelectionBackground': ui.active,
      'editor.lineHighlightBackground': ui.active,
      'editorLineNumber.foreground': ui.muted,
      'editorLineNumber.activeForeground': ui.text,
      'editorIndentGuide.background1': ui.borderSoft,
      'editorIndentGuide.activeBackground1': ui.border,
      'editorWhitespace.foreground': ui.border,
      'editorWidget.background': ui.panel2,
      'editorWidget.border': ui.border,
      'editorSuggestWidget.background': ui.panel2,
      'editorSuggestWidget.border': ui.border,
      'editorSuggestWidget.selectedBackground': ui.active,
      'editorHoverWidget.background': ui.panel2,
      'editorHoverWidget.border': ui.border,
      'input.background': ui.input,
      'input.foreground': ui.text,
      'input.border': ui.border,
      'focusBorder': ui.focus,
      'scrollbarSlider.background': ui.scrollbarThumb,
      'scrollbarSlider.hoverBackground': ui.muted,
      'breadcrumb.background': ui.panel,
      'breadcrumb.foreground': ui.muted,
      'breadcrumb.focusForeground': ui.text,
    },
  }
}

function hex(color: string): string {
  return color.startsWith('#') ? color.slice(1) : color
}

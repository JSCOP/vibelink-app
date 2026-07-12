import type { Settings } from '../state/profiles'
import { terminalThemeDefinitionById, themeCssVariables, type RequiredTerminalTheme } from '../state/terminalThemes'

export type RemoteAppearancePayload = {
  themeId: string
  themeName: string
  terminal: RequiredTerminalTheme
  fontFamily: string
  fontSize: number
  fontWeight: string
  fontWeightBold: string
  cursorStyle: Settings['cursorStyle']
  cursorWidth: number
  scrollback: number
  uiVars: Record<`--vibelink-${string}`, string>
  selectedPaneHighlightColor: string
  alarmHighlightColor: string
  reviewedPaneHighlightColor: string
}

export function buildRemoteAppearance(settings: Settings): RemoteAppearancePayload {
  const theme = terminalThemeDefinitionById(settings.terminalThemeId)
  return {
    themeId: theme.id,
    themeName: theme.name,
    terminal: { ...theme.terminal },
    fontFamily: settings.fontFamily,
    fontSize: settings.fontSize,
    fontWeight: String(settings.terminalFontWeight),
    fontWeightBold: '700',
    cursorStyle: settings.cursorStyle,
    cursorWidth: settings.cursorWidth,
    scrollback: settings.scrollback,
    uiVars: themeCssVariables(settings.terminalThemeId),
    selectedPaneHighlightColor: settings.selectedPaneHighlightColor,
    alarmHighlightColor: settings.alarmHighlightColor,
    reviewedPaneHighlightColor: settings.reviewedPaneHighlightColor,
  }
}

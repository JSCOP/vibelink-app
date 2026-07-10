import { terminalThemeDefinitionById, themeCssVariables } from './terminalThemes'

/** Apply a theme's CSS variables and color scheme to the document root.
 *  Shared by the committed-settings effect in App and the live theme preview
 *  in the settings dialog, so both always paint the chrome the same way. */
export function applyThemeToDocument(themeId: string, selectedPaneHighlightColor: string, alarmHighlightColor: string): void {
  const root = document.documentElement
  const theme = terminalThemeDefinitionById(themeId)
  root.dataset.vibelinkTheme = theme.id
  root.style.colorScheme = theme.colorScheme
  for (const [name, value] of Object.entries(themeCssVariables(theme.id))) {
    root.style.setProperty(name, value)
  }
  root.style.setProperty('--vibelink-selected-pane-highlight', selectedPaneHighlightColor)
  root.style.setProperty('--vibelink-alarm-highlight', alarmHighlightColor)
}

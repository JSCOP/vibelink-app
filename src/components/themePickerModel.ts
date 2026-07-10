import { terminalThemeGroups, type TerminalThemeId } from '../state/terminalThemes'
import type { PickerEntry } from './pickerModel'

/** Flatten the grouped theme catalog into picker rows, filtered by a search
 *  needle matched against theme name, id, and category. Category headers are
 *  kept only when at least one of their themes survives the filter. */
export function themePickerEntries(filter: string): PickerEntry<TerminalThemeId>[] {
  const needle = filter.trim().toLowerCase()
  const entries: PickerEntry<TerminalThemeId>[] = []
  for (const group of terminalThemeGroups) {
    const themes = group.themes.filter((theme) =>
      needle.length === 0
      || theme.name.toLowerCase().includes(needle)
      || theme.id.toLowerCase().includes(needle)
      || group.category.toLowerCase().includes(needle))
    if (themes.length === 0) continue
    entries.push({ kind: 'header', label: group.category })
    for (const theme of themes) {
      entries.push({ kind: 'item', id: theme.id, name: theme.name, description: theme.description })
    }
  }
  return entries
}

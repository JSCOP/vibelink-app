import { normalizeFontChoices } from '../state/fonts'
import type { PickerEntry } from './pickerModel'

/** Flatten font choices into quick-pick rows: the current selection and the
 *  bundled fallbacks under "Recommended", then the remaining installed fonts.
 *  The filter needle matches font names and group labels case-insensitively;
 *  groups are kept only when at least one of their fonts survives the filter. */
export function fontPickerEntries(installedFonts: string[], currentFontFamily: string, filter: string): PickerEntry[] {
  const needle = filter.trim().toLowerCase()
  const choices = normalizeFontChoices(installedFonts, currentFontFamily)
  // normalizeFontChoices adds the current font, then the bundled defaults,
  // then installed fonts — so the recommended prefix is exactly what it
  // returns when no installed fonts are supplied.
  const recommendedCount = normalizeFontChoices([], currentFontFamily).length
  const entries: PickerEntry[] = []
  const pushGroup = (label: string, fonts: string[]): void => {
    const groupMatches = label.toLowerCase().includes(needle)
    const kept = needle.length === 0
      ? fonts
      : fonts.filter((font) => groupMatches || font.toLowerCase().includes(needle))
    if (kept.length === 0) return
    entries.push({ kind: 'header', label })
    for (const font of kept) entries.push({ kind: 'item', id: font, name: font })
  }
  pushGroup('Recommended', choices.slice(0, recommendedCount))
  pushGroup('Installed fonts', choices.slice(recommendedCount))
  return entries
}

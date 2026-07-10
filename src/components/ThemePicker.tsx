import { Palette } from 'lucide-react'
import { terminalThemeDefinitionById, type TerminalThemeId } from '../state/terminalThemes'
import { themePickerEntries } from './themePickerModel'
import { QuickPick } from './QuickPick'

type ThemePickerProps = {
  value: TerminalThemeId
  onPreview: (id: TerminalThemeId) => void
  onSelect: (id: TerminalThemeId) => void
  onCancel: () => void
}

/** Theme quick pick: each row shows a palette swatch, and stepping or hovering
 *  previews the theme live on the whole app before Enter/click commits it. */
export function ThemePicker({ value, onPreview, onSelect, onCancel }: ThemePickerProps) {
  return (
    <QuickPick
      value={value}
      ariaLabel="Select color theme"
      placeholder="Select color theme (↑↓ to preview, Enter to apply, Esc to cancel)"
      icon={<Palette size={14} />}
      noMatchLabel="themes"
      entriesForFilter={themePickerEntries}
      renderItem={(item) => {
        const swatch = terminalThemeDefinitionById(item.id).terminal
        return (
          <>
            <span className="awt-theme-picker-swatch" style={{ background: swatch.background, color: swatch.foreground }} aria-hidden>
              <span style={{ background: swatch.blue }} />
              <span style={{ background: swatch.green }} />
              <span style={{ background: swatch.red }} />
            </span>
            <span className="awt-quick-pick-name">{item.name}</span>
            <span className="awt-quick-pick-description">{item.description}</span>
          </>
        )
      }}
      onPreview={onPreview}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  )
}

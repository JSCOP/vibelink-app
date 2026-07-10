import { useCallback } from 'react'
import { Type } from 'lucide-react'
import { terminalFontStack } from '../state/fonts'
import { fontPickerEntries } from './fontPickerModel'
import { hangulSampleFontFamily } from './fontSample'
import { QuickPick } from './QuickPick'

type FontPickerProps = {
  value: string
  installedFonts: string[]
  onPreview: (fontFamily: string) => void
  onSelect: (fontFamily: string) => void
  onCancel: () => void
}

/** Font quick pick: each row renders its name in that font family, and
 *  stepping or hovering previews the font live on every terminal pane before
 *  Enter/click commits it. */
export function FontPicker({ value, installedFonts, onPreview, onSelect, onCancel }: FontPickerProps) {
  const entriesForFilter = useCallback(
    (filter: string) => fontPickerEntries(installedFonts, value, filter),
    [installedFonts, value],
  )
  return (
    <QuickPick
      value={value}
      ariaLabel="Select terminal font"
      placeholder="Select terminal font (↑↓ to preview, Enter to apply, Esc to cancel)"
      icon={<Type size={14} />}
      noMatchLabel="fonts"
      entriesForFilter={entriesForFilter}
      renderItem={(item) => (
        <>
          <span className="vibelink-quick-pick-name" style={{ fontFamily: terminalFontStack(item.id) }}>{item.name}</span>
          <span className="vibelink-quick-pick-description" style={{ fontFamily: terminalFontStack(item.id) }}>
            AaBb 0123 <span style={{ fontFamily: hangulSampleFontFamily(item.id) }}>가나다</span> =&gt; -&gt;
          </span>
        </>
      )}
      onPreview={onPreview}
      onSelect={onSelect}
      onCancel={onCancel}
    />
  )
}

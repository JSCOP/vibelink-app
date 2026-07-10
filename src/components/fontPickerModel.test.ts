import { describe, expect, it } from 'vitest'
import { fontPickerEntries } from './fontPickerModel'
import { pickerItemIds } from './pickerModel'
import { defaultFontChoices } from '../state/fonts'

describe('fontPickerEntries', () => {
  it('lists the current font first under Recommended, then installed fonts', () => {
    const entries = fontPickerEntries(['Arial', 'Fira Code', 'Noto Sans KR'], 'Custom Mono', '')

    expect(entries[0]).toEqual({ kind: 'header', label: 'Recommended' })
    expect(entries[1]).toMatchObject({ kind: 'item', id: 'Custom Mono' })
    const ids = pickerItemIds(entries)
    for (const font of defaultFontChoices) expect(ids).toContain(font)
    expect(entries.filter((entry) => entry.kind === 'header').map((entry) => entry.kind === 'header' && entry.label)).toEqual(['Recommended', 'Installed fonts'])
    expect(ids).toContain('Arial')
    expect(ids).toContain('Noto Sans KR')
  })

  it('does not repeat a bundled default in the installed group', () => {
    const entries = fontPickerEntries(['Fira Code'], 'Consolas', '')

    const ids = pickerItemIds(entries)
    expect(ids.filter((id) => id === 'Fira Code')).toHaveLength(1)
    // Fira Code is a bundled default, so nothing remains for the installed group.
    expect(entries.some((entry) => entry.kind === 'header' && entry.label === 'Installed fonts')).toBe(false)
  })

  it('filters by font name case-insensitively and drops empty groups', () => {
    const entries = fontPickerEntries(['Arial', 'Noto Sans KR'], 'Consolas', 'NOTO')

    expect(pickerItemIds(entries)).toEqual(['Noto Sans KR'])
    expect(entries.filter((entry) => entry.kind === 'header')).toEqual([{ kind: 'header', label: 'Installed fonts' }])
  })

  it('matches group labels so a whole group can be browsed', () => {
    const entries = fontPickerEntries(['Arial'], 'Consolas', 'recommended')

    const ids = pickerItemIds(entries)
    expect(ids).toContain('Consolas')
    expect(ids).not.toContain('Arial')
  })

  it('returns no entries when nothing matches', () => {
    expect(fontPickerEntries(['Arial'], 'Consolas', 'no-such-font-xyz')).toEqual([])
  })
})

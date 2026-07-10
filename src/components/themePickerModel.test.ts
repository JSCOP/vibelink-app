import { describe, expect, it } from 'vitest'
import { pickerItemIds, steppedPickerId } from './pickerModel'
import { themePickerEntries } from './themePickerModel'
import { terminalThemeGroups } from '../state/terminalThemes'

const allThemeCount = terminalThemeGroups.reduce((total, group) => total + group.themes.length, 0)

describe('themePickerEntries', () => {
  it('lists every theme under its category header when unfiltered', () => {
    const entries = themePickerEntries('')

    expect(entries.filter((entry) => entry.kind === 'item')).toHaveLength(allThemeCount)
    expect(entries.filter((entry) => entry.kind === 'header')).toHaveLength(terminalThemeGroups.length)
    expect(entries[0].kind).toBe('header')
  })

  it('filters by name case-insensitively and drops empty categories', () => {
    const entries = themePickerEntries('ABYSS')

    const themes = entries.filter((entry) => entry.kind === 'item')
    expect(themes.length).toBeGreaterThan(0)
    expect(themes.every((theme) => theme.kind === 'item' && `${theme.name} ${theme.id}`.toLowerCase().includes('abyss'))).toBe(true)
    for (const entry of entries) {
      if (entry.kind === 'header') {
        const index = entries.indexOf(entry)
        expect(entries[index + 1]?.kind).toBe('item')
      }
    }
  })

  it('matches category names so a group can be browsed as a unit', () => {
    const entries = themePickerEntries(terminalThemeGroups[0].category.toLowerCase())

    expect(entries.filter((entry) => entry.kind === 'item').length).toBeGreaterThanOrEqual(terminalThemeGroups[0].themes.length)
  })
})

describe('steppedPickerId', () => {
  const entries = themePickerEntries('')
  const ids = pickerItemIds(entries)

  it('steps down and up through pickable themes, skipping headers', () => {
    expect(steppedPickerId(entries, ids[0], 1)).toBe(ids[1])
    expect(steppedPickerId(entries, ids[1], -1)).toBe(ids[0])
  })

  it('clamps at both ends', () => {
    expect(steppedPickerId(entries, ids[0], -1)).toBe(ids[0])
    expect(steppedPickerId(entries, ids[ids.length - 1], 1)).toBe(ids[ids.length - 1])
  })

  it('falls back to an end when the current theme is filtered out', () => {
    expect(steppedPickerId(entries, null, 1)).toBe(ids[0])
    expect(steppedPickerId(entries, null, -1)).toBe(ids[ids.length - 1])
  })

  it('returns null when nothing matches', () => {
    expect(steppedPickerId(themePickerEntries('no-such-theme-xyz'), null, 1)).toBeNull()
  })
})

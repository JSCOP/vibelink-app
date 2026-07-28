import { describe, expect, it } from 'vitest'
import { filterSettingsSections, searchSettingsEntries, settingsSearchEntries, settingsSections } from './sections'

describe('settings section search index', () => {
  it('keeps at least one curated row per section', () => {
    const covered = new Set(settingsSearchEntries.map((entry) => entry.section))
    for (const section of settingsSections) {
      expect(covered.has(section.id), `section '${section.id}' has a search entry`).toBe(true)
    }
  })

  it('finds rows by English and Korean row terms', () => {
    expect(searchSettingsEntries('font family')[0]).toMatchObject({ section: 'appearance', label: 'Font family / size / weight' })
    expect(searchSettingsEntries('폰트')[0]?.section).toBe('appearance')
    expect(searchSettingsEntries('로그인')[0]?.section).toBe('account')
  })

  it('requires every query token to match (AND)', () => {
    expect(searchSettingsEntries('font wizard')).toEqual([])
    expect(searchSettingsEntries('theme color').every((result) => result.section === 'appearance')).toBe(true)
  })

  it('ranks row-label hits above keyword-only hits', () => {
    const results = searchSettingsEntries('sound')
    expect(results[0]?.label).toBe('Completion sound & volume')
  })

  it('returns nothing for an empty query and honors the cap', () => {
    expect(searchSettingsEntries('   ')).toEqual([])
    expect(searchSettingsEntries('a', 5).length).toBeLessThanOrEqual(5)
  })

  it('keeps the legacy section filter working alongside the row index', () => {
    const groups = filterSettingsSections('theme')
    expect(groups.flatMap((group) => group.sections).map((section) => section.id)).toContain('appearance')
  })
})

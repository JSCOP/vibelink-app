// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { filterPaletteItems, fuzzyScore, orderWithRecents, paletteCategoryTitle, type PaletteCategory, type PaletteItem } from './paletteModel'
import { closePalette, isPaletteOpen, openPalette, readPaletteRecents, recordPaletteRecent, togglePalette } from './paletteStore'

const item = (id: string, label: string, category: PaletteItem['category'] = 'command', detail?: string): PaletteItem => ({
  id,
  category,
  label,
  detail,
  run: () => undefined,
})

describe('fuzzyScore', () => {
  it('returns -1 when the query is not a subsequence', () => {
    expect(fuzzyScore('xyz', 'Open Settings')).toBe(-1)
  })

  it('scores word-start and prefix matches above scattered hits', () => {
    const prefix = fuzzyScore('os', 'Open Settings')
    const scattered = fuzzyScore('os', 'Do Something Else')
    expect(prefix).toBeGreaterThan(scattered)
    expect(scattered).toBeGreaterThanOrEqual(0)
  })

  it('is case-insensitive and skips spaces in the query', () => {
    expect(fuzzyScore('open set', 'Open Settings')).toBeGreaterThanOrEqual(0)
    expect(fuzzyScore('RESOURCE', 'Resource monitor')).toBeGreaterThanOrEqual(0)
  })
})

describe('palette categories', () => {
  it('names project and workspace group sections', () => {
    const categories: PaletteCategory[] = ['project', 'group']
    expect(categories.map((category) => paletteCategoryTitle[category])).toEqual(['Project workspaces', 'Workspace groups'])
  })
})

describe('filterPaletteItems', () => {
  const items = [
    item('ws:a', 'vibelink', 'workspace'),
    item('cmd:settings', 'Open settings'),
    item('cmd:monitor', 'Resource monitor'),
    item('content:b', 'Terminal 2 · omp', 'content'),
  ]

  it('returns the input order for an empty query', () => {
    expect(filterPaletteItems(items, '').map((entry) => entry.id)).toEqual(items.map((entry) => entry.id))
  })

  it('ranks the best label match first and drops non-matches', () => {
    const result = filterPaletteItems(items, 'settings')
    expect(result[0]?.id).toBe('cmd:settings')
    expect(result.some((entry) => entry.id === 'cmd:monitor')).toBe(false)
  })

  it('matches against detail text with lower priority than the label', () => {
    const labelHit = filterPaletteItems([item('a', 'omp', 'content', 'zzz'), item('b', 'Terminal 2', 'content', 'omp')], 'omp')
    expect(labelHit[0]?.id).toBe('a')
    expect(labelHit.map((entry) => entry.id)).toContain('b')
  })

  it('matches workspace host, project, and group metadata through search text', () => {
    const workspace: PaletteItem = {
      ...item('ws:metadata', 'Fix login', 'project', 'E:/worktrees/fix-login'),
      host: 'github.com',
      project: 'VibeLink',
      group: 'Desktop apps',
      searchText: 'github.com VibeLink Desktop apps',
    }
    expect(filterPaletteItems([workspace], 'github').map((entry) => entry.id)).toEqual(['ws:metadata'])
    expect(filterPaletteItems([workspace], 'vibelink').map((entry) => entry.id)).toEqual(['ws:metadata'])
    expect(filterPaletteItems([workspace], 'desktop apps').map((entry) => entry.id)).toEqual(['ws:metadata'])
  })
})

describe('orderWithRecents', () => {
  it('moves recent ids first in recency order and keeps the rest stable', () => {
    const items = [item('a', 'A'), item('b', 'B'), item('c', 'C')]
    const { recents, rest } = orderWithRecents(items, ['c', 'a', 'missing'])
    expect(recents.map((entry) => entry.id)).toEqual(['c', 'a'])
    expect(rest.map((entry) => entry.id)).toEqual(['b'])
  })
})

describe('paletteStore', () => {
  beforeEach(() => {
    closePalette()
    window.localStorage.clear()
  })

  it('opens, closes, and toggles', () => {
    expect(isPaletteOpen()).toBe(false)
    openPalette()
    expect(isPaletteOpen()).toBe(true)
    togglePalette()
    expect(isPaletteOpen()).toBe(false)
    togglePalette()
    expect(isPaletteOpen()).toBe(true)
  })

  it('records recents newest-first, deduplicated, and capped', () => {
    for (let index = 0; index < 25; index += 1) recordPaletteRecent(`id-${index}`)
    recordPaletteRecent('id-24')
    recordPaletteRecent('id-10')
    const recents = readPaletteRecents()
    expect(recents[0]).toBe('id-10')
    expect(recents[1]).toBe('id-24')
    expect(recents).toHaveLength(20)
    expect(new Set(recents).size).toBe(20)
  })

  it('tolerates malformed stored recents', () => {
    window.localStorage.setItem('vibelink:paletteRecent', '{broken')
    expect(readPaletteRecents()).toEqual([])
  })
})

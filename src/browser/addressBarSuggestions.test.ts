import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildBrowserAddressBarSuggestions } from './addressBarSuggestions'
import type { BrowserUrlHistoryEntry } from './browserUrlHistory'

const NOW = 1_700_000_000_000
const HOUR = 60 * 60 * 1000

function historyEntry(index: number, overrides: Partial<BrowserUrlHistoryEntry> = {}): BrowserUrlHistoryEntry {
  return {
    url: `https://site${index}.example/item`,
    title: `Site ${index}`,
    visitCount: 1,
    lastVisitedAt: NOW - index * HOUR,
    ...overrides,
  }
}

afterEach(() => vi.restoreAllMocks())

describe('browser address bar suggestions', () => {
  it('returns blank-query history newest-first and caps it at eight rows', () => {
    const history = Array.from({ length: 10 }, (_, index) => historyEntry(index))
    const suggestions = buildBrowserAddressBarSuggestions(history.reverse(), '')

    expect(suggestions).toHaveLength(8)
    expect(suggestions.map((entry) => entry.url)).toEqual(history.slice().reverse().slice(0, 8).map((entry) => entry.url))
  })

  it('caps matching history at seven rows to reserve the synthetic top row', () => {
    const suggestions = buildBrowserAddressBarSuggestions(
      Array.from({ length: 10 }, (_, index) => historyEntry(index, { title: `React page ${index}` })),
      'react',
    )

    expect(suggestions).toHaveLength(8)
    expect(suggestions[0]).toMatchObject({ isSearch: true, subtitle: 'Google Search' })
    expect(suggestions.filter((entry) => !entry.isSearch)).toHaveLength(7)
  })

  it('ranks a URL prefix match above a much higher visit count', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const suggestions = buildBrowserAddressBarSuggestions([
      historyEntry(0, { url: 'https://other.example.com/docs', title: 'Docs archive', visitCount: 50, lastVisitedAt: NOW + 26.5 * HOUR }),
      historyEntry(0, { url: 'https://docs.example.com/', title: 'Documentation', visitCount: 1, lastVisitedAt: NOW - 24 * HOUR }),
    ], 'docs')

    expect(suggestions.slice(1).map((entry) => entry.url)).toEqual([
      'https://docs.example.com/',
      'https://other.example.com/docs',
    ])
  })

  it('lets the 24-hour recency bonus decay enough to change ranking', () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW)
    const suggestions = buildBrowserAddressBarSuggestions([
      historyEntry(0, { url: 'https://older.test/', title: 'Example older', visitCount: 24, lastVisitedAt: NOW - 25 * HOUR }),
      historyEntry(0, { url: 'https://recent.test/', title: 'Example recent', visitCount: 1, lastVisitedAt: NOW }),
    ], 'example')

    expect(suggestions.slice(1).map((entry) => entry.url)).toEqual([
      'https://recent.test/',
      'https://older.test/',
    ])
  })

  it('drops a synthetic navigation row that duplicates a history URL', () => {
    const suggestions = buildBrowserAddressBarSuggestions([
      historyEntry(0, { url: 'https://example.com/', title: 'Saved Example', visitCount: 4 }),
    ], 'example.com')

    expect(suggestions).toHaveLength(1)
    expect(suggestions[0]).toMatchObject({ url: 'https://example.com/', title: 'Saved Example', isSearch: false })
  })

  it('rejects input over 2048 UTF-8 bytes before ranking', () => {
    const throwingHistory = new Proxy([] as BrowserUrlHistoryEntry[], {
      get() {
        throw new Error('history should not be read')
      },
    })

    expect(buildBrowserAddressBarSuggestions([], 'é'.repeat(1024))).toHaveLength(1)
    expect(buildBrowserAddressBarSuggestions(throwingHistory, 'é'.repeat(1025))).toEqual([])
  })
})

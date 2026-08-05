import type { BrowserUrlHistoryEntry } from './browserUrlHistory'

const MAX_SUGGESTIONS = 8
const MAX_QUERY_BYTES = 2048
const LOOKS_LIKE_URL_PATTERN = /^[^\s]+\.[a-z]{2,}(\/.*)?$/i
const LOCAL_ADDRESS_PATTERN = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i

export type BrowserAddressBarSuggestion = BrowserUrlHistoryEntry & {
  subtitle: string
  isSearch: boolean
}

function looksLikeUrl(input: string): boolean {
  if (input.includes(' ')) return false
  return LOOKS_LIKE_URL_PATTERN.test(input) || input.includes('.') || input.includes(':')
}

function normalizeNavigationUrl(input: string): string | null {
  if (LOCAL_ADDRESS_PATTERN.test(input)) return new URL(`http://${input}`).toString()
  try {
    const parsed = new URL(input)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null
  } catch {
    try {
      return new URL(`https://${input}`).toString()
    } catch {
      return null
    }
  }
}

function scoreBrowserAddressBarSuggestion(entry: BrowserUrlHistoryEntry, query: string): number {
  const lowerQuery = query.toLowerCase()
  const lowerUrl = entry.url.toLowerCase()
  const lowerTitle = entry.title.toLowerCase()
  if (!lowerUrl.includes(lowerQuery) && !lowerTitle.includes(lowerQuery)) return -1

  let score = 0
  if (lowerUrl.startsWith(lowerQuery) || lowerUrl.startsWith(`https://${lowerQuery}`)) score += 100
  score += Math.min(entry.visitCount, 50)
  const ageHours = (Date.now() - entry.lastVisitedAt) / (1000 * 60 * 60)
  score += Math.max(0, 24 - ageHours)
  return score
}

export function buildBrowserAddressBarSuggestions(
  browserUrlHistory: readonly BrowserUrlHistoryEntry[],
  value: string,
): BrowserAddressBarSuggestion[] {
  if (new TextEncoder().encode(value).byteLength > MAX_QUERY_BYTES) return []

  const trimmed = value.trim()
  if (trimmed === '' || trimmed === 'about:blank' || trimmed.startsWith('data:')) {
    return [...browserUrlHistory]
      .sort((left, right) => right.lastVisitedAt - left.lastVisitedAt)
      .slice(0, MAX_SUGGESTIONS)
      .map((entry) => ({ ...entry, subtitle: entry.url, isSearch: false }))
  }

  const historySuggestions = browserUrlHistory
    .map((entry) => ({ entry, score: scoreBrowserAddressBarSuggestion(entry, trimmed) }))
    .filter((item) => item.score >= 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, MAX_SUGGESTIONS - 1)
    .map(({ entry }) => ({ ...entry, subtitle: entry.url, isSearch: false }))

  const isSearch = !looksLikeUrl(trimmed)
  const url = isSearch
    ? `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`
    : normalizeNavigationUrl(trimmed)
  if (!url) return historySuggestions

  const topAction: BrowserAddressBarSuggestion = {
    url,
    title: trimmed,
    subtitle: isSearch ? 'Google Search' : '',
    lastVisitedAt: 0,
    visitCount: 0,
    isSearch,
  }
  return historySuggestions.some((entry) => entry.url === topAction.url)
    ? historySuggestions
    : [topAction, ...historySuggestions].slice(0, MAX_SUGGESTIONS)
}

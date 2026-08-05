const BROWSER_URL_HISTORY_KEY = 'vibelink.browser.history'
const MAX_BROWSER_URL_HISTORY_ENTRIES = 300

export type BrowserUrlHistoryEntry = {
  url: string
  title: string
  visitCount: number
  lastVisitedAt: number
}

function isBrowserUrlHistoryEntry(value: unknown): value is BrowserUrlHistoryEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<BrowserUrlHistoryEntry>
  return typeof entry.url === 'string'
    && typeof entry.title === 'string'
    && typeof entry.visitCount === 'number'
    && Number.isFinite(entry.visitCount)
    && typeof entry.lastVisitedAt === 'number'
    && Number.isFinite(entry.lastVisitedAt)
}

export function readBrowserUrlHistory(): BrowserUrlHistoryEntry[] {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(BROWSER_URL_HISTORY_KEY) ?? '[]')
    return Array.isArray(stored)
      ? stored.filter(isBrowserUrlHistoryEntry)
          .sort((left, right) => right.lastVisitedAt - left.lastVisitedAt)
          .slice(0, MAX_BROWSER_URL_HISTORY_ENTRIES)
      : []
  } catch {
    return []
  }
}

export function recordBrowserVisit(url: string, title: string): void {
  const target = url.trim()
  if (!target || target === 'about:blank') return
  try {
    const parsed = new URL(target)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
    const history = readBrowserUrlHistory()
    const existing = history.find((entry) => entry.url === target)
    const now = Date.now()
    const next = existing
      ? history.map((entry) => entry === existing
          ? { ...entry, title: title.trim() || target, visitCount: entry.visitCount + 1, lastVisitedAt: now }
          : entry)
      : [{ url: target, title: title.trim() || target, visitCount: 1, lastVisitedAt: now }, ...history]
    localStorage.setItem(
      BROWSER_URL_HISTORY_KEY,
      JSON.stringify(next.sort((left, right) => right.lastVisitedAt - left.lastVisitedAt).slice(0, MAX_BROWSER_URL_HISTORY_ENTRIES)),
    )
  } catch {
    // Navigation must not depend on browser-history persistence.
  }
}

/** Attach the real page title once it arrives. A commit knows the URL but the
 *  document title is still the PREVIOUS page's, so recording both at commit
 *  labels every entry with the title of the page the user just left. This is a
 *  correction, not a visit: it never touches `visitCount` or `lastVisitedAt`. */
export function recordBrowserVisitTitle(url: string, title: string): void {
  const target = url.trim()
  const label = title.trim()
  if (!target || !label) return
  try {
    const history = readBrowserUrlHistory()
    const existing = history.find((entry) => entry.url === target)
    if (!existing || existing.title === label) return
    localStorage.setItem(
      BROWSER_URL_HISTORY_KEY,
      JSON.stringify(history.map((entry) => (entry === existing ? { ...entry, title: label } : entry))),
    )
  } catch {
    // Navigation must not depend on browser-history persistence.
  }
}

export function clearBrowserUrlHistory(): void {
  try {
    localStorage.removeItem(BROWSER_URL_HISTORY_KEY)
  } catch {
    // Navigation must not depend on browser-history persistence.
  }
}

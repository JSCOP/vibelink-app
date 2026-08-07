import type { LucideIcon } from 'lucide-react'

export type PaletteCategory = 'recent' | 'group' | 'project' | 'workspace' | 'content' | 'terminal' | 'command'

export type PaletteItem = {
  id: string
  category: Exclude<PaletteCategory, 'recent'>
  label: string
  detail?: string
  /** Workspace scope metadata used by palette search and filter chips. */
  host?: string
  project?: string
  group?: string
  searchText?: string
  icon?: LucideIcon
  /** Profile-icon registry name (brand marks, agent icons); wins over `icon`. */
  iconName?: string
  /** Runs the item; the host closes the palette first. */
  run: () => void | Promise<void>
}

export const paletteCategoryTitle: Record<PaletteCategory, string> = {
  recent: 'Recent',
  group: 'Workspace groups',
  project: 'Project workspaces',
  workspace: 'Switch workspace',
  content: 'Open content',
  terminal: 'New terminal',
  command: 'Commands',
}

/**
 * Subsequence fuzzy match. Returns a score (higher is better) or -1 when the
 * filter is not a subsequence of the candidate. Consecutive matches and
 * matches on word/camel boundaries score higher; early matches win ties so
 * short precise prefixes beat scattered hits inside long labels.
 */
export function fuzzyScore(filter: string, candidate: string): number {
  const needle = filter.trim().toLowerCase()
  if (!needle) return 0
  const hay = candidate.toLowerCase()
  let score = 0
  let hayIndex = 0
  let streak = 0
  let firstIndex = -1
  for (let i = 0; i < needle.length; i += 1) {
    const ch = needle[i]
    if (ch === ' ') continue
    const found = hay.indexOf(ch, hayIndex)
    if (found === -1) return -1
    if (firstIndex === -1) firstIndex = found
    const wordStart = found === 0 || /[\s\-_./\\]/.test(hay[found - 1] ?? '') || (hay[found] !== hay[found].toLowerCase() && hay[found - 1] === hay[found - 1].toLowerCase())
    streak = found === hayIndex ? streak + 1 : 0
    score += 1 + streak * 3 + (wordStart ? 5 : 0)
    hayIndex = found + 1
  }
  return score * 100 - firstIndex - candidate.length * 0.01
}

/** Filter + rank items against the query. Empty query returns items in the
 *  given order. Categories keep their relative position from build time. */
export function filterPaletteItems(items: PaletteItem[], query: string): PaletteItem[] {
  const trimmed = query.trim()
  if (!trimmed) return items
  return items
    .map((item, index) => ({ item, index, score: Math.max(fuzzyScore(trimmed, item.label), item.detail ? fuzzyScore(trimmed, item.detail) * 0.6 : -1, item.searchText ? fuzzyScore(trimmed, item.searchText) * 0.5 : -1) }))
    .filter((entry) => entry.score >= 0)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .map((entry) => entry.item)
}

/** Bubble recent ids to the front of a category-preserving list. The recent
 *  section is rendered separately by the host; this returns the reordered
 *  item list with `recent` items first, newest first. */
export function orderWithRecents(items: PaletteItem[], recentIds: string[]): { recents: PaletteItem[]; rest: PaletteItem[] } {
  const byId = new Map(items.map((item) => [item.id, item]))
  const recents: PaletteItem[] = []
  for (const id of recentIds) {
    const item = byId.get(id)
    if (item) {
      recents.push(item)
      byId.delete(id)
    }
  }
  return { recents, rest: items.filter((item) => byId.has(item.id)) }
}

export type ManualPaneTitleMap = Record<string, boolean>

type PaneTitleStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const manualPaneTitlesStorageKey = 'vibelink:manualPaneTitles'


export function loadManualPaneTitles(storage: PaneTitleStorage | undefined = typeof window === 'undefined' ? undefined : window.localStorage): ManualPaneTitleMap {
  if (!storage) return {}
  try {
    const parsed = JSON.parse(storage.getItem(manualPaneTitlesStorageKey) ?? 'null')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const titles: ManualPaneTitleMap = {}
    for (const [paneId, value] of Object.entries(parsed)) if (value === true) titles[paneId] = true
    return titles
  } catch {
    return {}
  }
}

export function persistManualPaneTitles(titles: ManualPaneTitleMap, storage: PaneTitleStorage | undefined = typeof window === 'undefined' ? undefined : window.localStorage): void {
  if (!storage) return
  try {
    const entries = Object.entries(titles).filter(([, value]) => value === true)
    if (entries.length === 0) storage.removeItem(manualPaneTitlesStorageKey)
    else storage.setItem(manualPaneTitlesStorageKey, JSON.stringify(Object.fromEntries(entries)))
  } catch {
    // A storage failure must not block a pane rename in the live workspace.
  }
}

export function normalizePaneTitle(title: string): string | null {
  const normalized = [...title]
    .map((char) => {
      const codePoint = char.codePointAt(0) ?? 0
      return codePoint < 32 || codePoint === 127 ? ' ' : char
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length > 0 ? normalized : null
}

export function shouldApplyAutoTitle(paneId: string, manualTitles: ManualPaneTitleMap): boolean {
  return manualTitles[paneId] !== true
}

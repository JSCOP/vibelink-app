const RECENTS_STORAGE_KEY = 'vibelink:paletteRecent'
const MAX_RECENTS = 20

type PaletteSnapshot = { open: boolean }

let snapshot: PaletteSnapshot = { open: false }
const listeners = new Set<() => void>()

const setOpen = (open: boolean) => {
  snapshot = { open }
  for (const listener of listeners) listener()
}

export const paletteStore = {
  subscribe: (listener: () => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getSnapshot: (): PaletteSnapshot => snapshot,
}

export const isPaletteOpen = () => snapshot.open
export const openPalette = () => setOpen(true)
export const closePalette = () => setOpen(false)
export const togglePalette = () => setOpen(!snapshot.open)

export function readPaletteRecents(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENTS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string').slice(0, MAX_RECENTS) : []
  } catch {
    return []
  }
}

export function recordPaletteRecent(id: string): void {
  const next = [id, ...readPaletteRecents().filter((entry) => entry !== id)].slice(0, MAX_RECENTS)
  try {
    window.localStorage.setItem(RECENTS_STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Storage failures must never break palette execution.
  }
}

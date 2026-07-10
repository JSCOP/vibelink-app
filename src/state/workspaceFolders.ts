export type WorkspaceFolderHistory = {
  recent: string[]
  favorites: string[]
}

const maxRecentFolders = 8

export function normalizeWorkspaceFolderHistory(value: unknown): WorkspaceFolderHistory {
  const record = isRecord(value) ? value : undefined
  return {
    recent: readFolderList(record?.recent, maxRecentFolders),
    favorites: readFolderList(record?.favorites),
  }
}

export function rememberWorkspaceFolder(history: WorkspaceFolderHistory, folder: string): WorkspaceFolderHistory {
  const normalized = normalizeFolder(folder)
  if (!normalized) return normalizeWorkspaceFolderHistory(history)
  const current = normalizeWorkspaceFolderHistory(history)
  return {
    ...current,
    recent: [normalized, ...current.recent.filter((item) => item.toLowerCase() !== normalized.toLowerCase())].slice(0, maxRecentFolders),
  }
}

export function toggleFavoriteWorkspaceFolder(history: WorkspaceFolderHistory, folder: string): WorkspaceFolderHistory {
  const normalized = normalizeFolder(folder)
  const current = normalizeWorkspaceFolderHistory(history)
  if (!normalized) return current
  const exists = current.favorites.some((item) => item.toLowerCase() === normalized.toLowerCase())
  return {
    ...current,
    favorites: exists
      ? current.favorites.filter((item) => item.toLowerCase() !== normalized.toLowerCase())
      : [...current.favorites, normalized],
  }
}

export function loadWorkspaceFolderHistory(storage: Storage | undefined = globalThis.localStorage): WorkspaceFolderHistory {
  if (!storage) return { recent: [], favorites: [] }
  try {
    return normalizeWorkspaceFolderHistory(JSON.parse(storage.getItem('vibelink:workspaceFolders') ?? 'null'))
  } catch {
    return { recent: [], favorites: [] }
  }
}

export function saveWorkspaceFolderHistory(history: WorkspaceFolderHistory, storage: Storage | undefined = globalThis.localStorage): void {
  storage?.setItem('vibelink:workspaceFolders', JSON.stringify(normalizeWorkspaceFolderHistory(history)))
}

function readFolderList(value: unknown, limit = Number.POSITIVE_INFINITY): string[] {
  if (!Array.isArray(value)) return []
  const folders: string[] = []
  for (const item of value) {
    const folder = normalizeFolder(item)
    if (!folder || folders.some((existing) => existing.toLowerCase() === folder.toLowerCase())) continue
    folders.push(folder)
    if (folders.length >= limit) break
  }
  return folders
}

function normalizeFolder(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim()
  return normalized.length > 0 ? normalized : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

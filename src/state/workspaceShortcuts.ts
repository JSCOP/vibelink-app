export const MAX_NUMBERED_WORKSPACE_SHORTCUTS = 9

export function workspaceShortcutIndex(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): number | null {
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return null
  if (!/^[1-9]$/.test(event.key)) return null
  return Number(event.key) - 1
}

export function workspaceForShortcut<T>(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>, orderedWorkspaces: readonly T[]): T | null {
  const index = workspaceShortcutIndex(event)
  return index === null ? null : orderedWorkspaces[index] ?? null
}

import { invoke } from '@tauri-apps/api/core'

export type MemoryScope = 'workspace' | 'global'
export type MemoryQueryScope = 'workspace' | 'global' | 'all'
export type MemoryOriginKind = 'agent' | 'user' | 'harvest'
export type MemoryOrigin = {
  kind: MemoryOriginKind
  agentId?: string
  paneId?: string
  sourcePath?: string
}
export type MemoryEntry = {
  id: string
  scope: MemoryScope
  sessionId: string | null
  title: string
  body: string
  tags: string[]
  refs: string[]
  origin: MemoryOrigin
  createdAt: number
  updatedAt: number
  pinned: boolean
  readers: string[]
}
export type MemoryWorkspaceRef = {
  sessionId: string
  name: string
  workspaceFolder: string | null
}
export type MemorySnapshot = {
  workspaces: MemoryWorkspaceRef[]
  entries: MemoryEntry[]
  truncated: boolean
}
export type MemoryAddInput = {
  title: string
  body: string
  tags?: string[]
  refs?: string[]
  scope: MemoryScope
  sessionId?: string | null
  origin: MemoryOrigin
  pinned?: boolean
  id?: string
}

export async function fetchMemorySnapshot(workspaces: MemoryWorkspaceRef[]): Promise<MemorySnapshot> {
  // Web previews have no Tauri bridge; real backend failures remain visible to the retry surface.
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return { workspaces, entries: [], truncated: false }
  }
  return invoke<MemorySnapshot>('memory_snapshot', { workspaces })
}

export function addMemory(input: MemoryAddInput): Promise<MemoryEntry> {
  return invoke<MemoryEntry>('memory_add', { input })
}

export function removeMemory(id: string, sessionId: string | null, scope: MemoryScope): Promise<void> {
  return invoke<void>('memory_remove', { id, sessionId, scope })
}

export function setMemoryPinned(
  id: string,
  sessionId: string | null,
  scope: MemoryScope,
  pinned: boolean,
): Promise<MemoryEntry> {
  return invoke<MemoryEntry>('memory_set_pinned', { id, sessionId, scope, pinned })
}

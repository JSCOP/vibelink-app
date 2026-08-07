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
export type MemoryLinkTarget = {
  id: string
  relativePath: string
  exists: boolean
  enabled: boolean
}
export type MemoryProjectionStatus = {
  digestPath: string
  entryCount: number
  targets: MemoryLinkTarget[]
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

export function addMemory(input: MemoryAddInput, workspaceFolder: string | null): Promise<MemoryEntry> {
  return invoke<MemoryEntry>('memory_add', { input, workspaceFolder })
}

export function removeMemory(
  id: string,
  sessionId: string | null,
  scope: MemoryScope,
  workspaceFolder: string | null,
): Promise<void> {
  return invoke<void>('memory_remove', { id, sessionId, scope, workspaceFolder })
}

export function setMemoryPinned(
  id: string,
  sessionId: string | null,
  scope: MemoryScope,
  pinned: boolean,
  workspaceFolder: string | null,
): Promise<MemoryEntry> {
  return invoke<MemoryEntry>('memory_set_pinned', { id, sessionId, scope, pinned, workspaceFolder })
}

export function fetchProjectionStatus(
  sessionId: string,
  workspaceFolder: string,
): Promise<MemoryProjectionStatus> {
  return invoke<MemoryProjectionStatus>('memory_projection_status', { sessionId, workspaceFolder })
}

export function setMemoryLink(
  sessionId: string,
  workspaceFolder: string,
  target: string,
  enabled: boolean,
): Promise<MemoryProjectionStatus> {
  return invoke<MemoryProjectionStatus>('memory_set_link', { sessionId, workspaceFolder, target, enabled })
}

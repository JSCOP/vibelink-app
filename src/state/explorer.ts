import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { ChangeType, DirEntryInfo, WorkingStatus } from '../ipc/types'
export type ExplorerDecoration = ChangeType | 'conflicted'

export type ExplorerSessionState = {
  expandedPaths: Set<string>
  childrenByPath: Map<string, DirEntryInfo[]>
  ignoredPaths: Set<string>
  selectedPath: string | null
  loadingPaths: Set<string>
  error: string | null
}

export type ExplorerNode = {
  path: string
  parentPath: string
  name: string
  depth: number
  entry: DirEntryInfo
  expanded: boolean
  ignored: boolean
  decoration: ExplorerDecoration | null
  ancestorChanged: boolean
}

type ExplorerStore = {
  sessions: Record<string, ExplorerSessionState>
  loadChildren: (sessionId: string, workspaceFolder: string, relPath: string) => Promise<void>
  setExpanded: (sessionId: string, path: string, expanded: boolean) => void
  setSelectedPath: (sessionId: string, path: string | null) => void
  invalidatePath: (sessionId: string, path: string) => void
  setError: (sessionId: string, error: string | null) => void
}

export const emptyExplorerSessionState: ExplorerSessionState = {
  expandedPaths: new Set(),
  childrenByPath: new Map(),
  ignoredPaths: new Set(),
  selectedPath: null,
  loadingPaths: new Set(),
  error: null,
}

export const useExplorerStore = create<ExplorerStore>((set) => ({
  sessions: {},
  loadChildren: async (sessionId, workspaceFolder, relPath) => {
    set((state) => {
      const current = state.sessions[sessionId] ?? emptyExplorerSessionState
      return { sessions: { ...state.sessions, [sessionId]: { ...current, loadingPaths: new Set(current.loadingPaths).add(relPath), error: null } } }
    })
    try {
      const entries = await invoke<DirEntryInfo[]>('fs_list_dir', { workspaceFolder, relPath })
      entries.sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
      const paths = entries.map((entry) => joinPath(relPath, entry.name))
      const ignored = await invoke<string[]>('git_check_ignored', { workspaceFolder, relPaths: paths }).catch(() => [])
      set((state) => {
        const current = state.sessions[sessionId] ?? emptyExplorerSessionState
        const childrenByPath = new Map(current.childrenByPath)
        childrenByPath.set(relPath, entries)
        const ignoredPaths = new Set(current.ignoredPaths)
        for (const path of paths) ignoredPaths.delete(path)
        for (const path of ignored) ignoredPaths.add(path)
        const loadingPaths = new Set(current.loadingPaths)
        loadingPaths.delete(relPath)
        return { sessions: { ...state.sessions, [sessionId]: { ...current, childrenByPath, ignoredPaths, loadingPaths, error: null } } }
      })
    } catch (reason) {
      set((state) => {
        const current = state.sessions[sessionId] ?? emptyExplorerSessionState
        const loadingPaths = new Set(current.loadingPaths)
        loadingPaths.delete(relPath)
        return { sessions: { ...state.sessions, [sessionId]: { ...current, loadingPaths, error: String(reason) } } }
      })
    }
  },
  setExpanded: (sessionId, path, expanded) => set((state) => {
    const current = state.sessions[sessionId] ?? emptyExplorerSessionState
    const expandedPaths = new Set(current.expandedPaths)
    if (expanded) expandedPaths.add(path)
    else expandedPaths.delete(path)
    return { sessions: { ...state.sessions, [sessionId]: { ...current, expandedPaths } } }
  }),
  setSelectedPath: (sessionId, selectedPath) => set((state) => {
    const current = state.sessions[sessionId] ?? emptyExplorerSessionState
    return { sessions: { ...state.sessions, [sessionId]: { ...current, selectedPath } } }
  }),
  invalidatePath: (sessionId, path) => set((state) => {
    const current = state.sessions[sessionId] ?? emptyExplorerSessionState
    const childrenByPath = new Map(current.childrenByPath)
    childrenByPath.delete(path)
    childrenByPath.delete(parentPath(path))
    return { sessions: { ...state.sessions, [sessionId]: { ...current, childrenByPath } } }
  }),
  setError: (sessionId, error) => set((state) => {
    const current = state.sessions[sessionId] ?? emptyExplorerSessionState
    return { sessions: { ...state.sessions, [sessionId]: { ...current, error } } }
  }),
}))

export function flattenExplorerTree(session: ExplorerSessionState, decorations: Map<string, ExplorerDecoration>): ExplorerNode[] {
  const nodes: ExplorerNode[] = []
  const changedAncestors = changedAncestorPaths(decorations.keys())
  const visit = (path: string, depth: number) => {
    for (const entry of session.childrenByPath.get(path) ?? []) {
      const childPath = joinPath(path, entry.name)
      const expanded = entry.isDir && session.expandedPaths.has(childPath)
      nodes.push({
        path: childPath,
        parentPath: path,
        name: entry.name,
        depth,
        entry,
        expanded,
        ignored: session.ignoredPaths.has(childPath),
        decoration: decorations.get(childPath) ?? null,
        ancestorChanged: changedAncestors.has(childPath),
      })
      if (expanded) visit(childPath, depth + 1)
    }
  }
  visit('', 0)
  return nodes
}

export function deriveGitDecorations(status: WorkingStatus | null): Map<string, ExplorerDecoration> {
  const decorations = new Map<string, ExplorerDecoration>()
  if (!status) return decorations
  for (const entry of status.untracked) decorations.set(entry.path, entry.changeType)
  for (const entry of status.unstaged) decorations.set(entry.path, entry.changeType)
  for (const entry of status.staged) decorations.set(entry.path, entry.changeType)
  for (const entry of status.conflicted) decorations.set(entry.path, 'conflicted')
  return decorations
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function changedAncestorPaths(paths: Iterable<string>): Set<string> {
  const ancestors = new Set<string>()
  for (const path of paths) {
    let parent = parentPath(path)
    while (parent) {
      ancestors.add(parent)
      parent = parentPath(parent)
    }
  }
  return ancestors
}

import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import type { ChangeType, DirEntryInfo, RepoKind, WorkingStatus } from '../ipc/types'
export type ExplorerGitDecoration = {
  staged: ChangeType | null
  unstaged: ChangeType | null
  untracked: boolean
  conflicted: boolean
  directory: boolean
  repoKind: RepoKind | null
  repoRoot: string | null
}

export type ExplorerChangeSummary = {
  total: number
  conflicted: number
  staged: number
  unstaged: number
  untracked: number
}

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
  decoration: ExplorerGitDecoration | null
  changeSummary: ExplorerChangeSummary | null
  gitOnly: boolean
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

export function flattenExplorerTree(session: ExplorerSessionState, decorations: Map<string, ExplorerGitDecoration>): ExplorerNode[] {
  const nodes: ExplorerNode[] = []
  const summaries = changeSummaries(decorations)
  const gitEntries = gitTreeEntries(decorations)
  const visit = (path: string, depth: number) => {
    const filesystemEntries = session.childrenByPath.get(path) ?? []
    const filesystemNames = new Set(filesystemEntries.map((entry) => entry.name))
    const entries = [...filesystemEntries]
    for (const entry of gitEntries.get(path) ?? []) {
      if (!filesystemNames.has(entry.name)) entries.push(entry)
    }
    entries.sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))

    for (const entry of entries) {
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
        changeSummary: entry.isDir ? summaries.get(childPath) ?? null : null,
        gitOnly: !filesystemNames.has(entry.name),
      })
      if (expanded) visit(childPath, depth + 1)
    }
  }
  visit('', 0)
  return nodes
}

export function deriveGitDecorations(status: WorkingStatus | null, prefix = '', repoRoot: string | null = null): Map<string, ExplorerGitDecoration> {
  const decorations = new Map<string, ExplorerGitDecoration>()
  if (!status) return decorations
  const apply = (entry: WorkingStatus['staged'][number], area: 'staged' | 'unstaged' | 'untracked' | 'conflicted') => {
    const relativePath = entry.path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    const path = joinPath(prefix, relativePath)
    if (!path) return
    const current = decorations.get(path) ?? { staged: null, unstaged: null, untracked: false, conflicted: false, directory: false, repoKind: null, repoRoot }
    const entryRepoRoot = repoRoot ?? current.repoRoot
    const next = {
      ...current,
      directory: current.directory || entry.path.endsWith('/') || Boolean(entry.repoKind),
      repoKind: entry.repoKind ?? current.repoKind,
      repoRoot: entryRepoRoot,
    }
    if (area === 'staged') next.staged = entry.changeType
    else if (area === 'unstaged') next.unstaged = entry.changeType
    else if (area === 'untracked') next.untracked = true
    else next.conflicted = true
    decorations.set(path, next)
  }
  for (const entry of status.staged) apply(entry, 'staged')
  for (const entry of status.unstaged) apply(entry, 'unstaged')
  for (const entry of status.untracked) apply(entry, 'untracked')
  for (const entry of status.conflicted) apply(entry, 'conflicted')
  return decorations
}

export function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name
}

export function parentPath(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}


function changeSummaries(decorations: Map<string, ExplorerGitDecoration>): Map<string, ExplorerChangeSummary> {
  const summaries = new Map<string, ExplorerChangeSummary>()
  for (const [path, decoration] of decorations) {
    const folders: string[] = []
    if (decoration.directory) folders.push(path)
    let parent = parentPath(path)
    while (parent) {
      folders.push(parent)
      parent = parentPath(parent)
    }
    for (const folder of folders) {
      const summary = summaries.get(folder) ?? { total: 0, conflicted: 0, staged: 0, unstaged: 0, untracked: 0 }
      summary.total += 1
      if (decoration.conflicted) summary.conflicted += 1
      if (decoration.staged) summary.staged += 1
      if (decoration.unstaged) summary.unstaged += 1
      if (decoration.untracked) summary.untracked += 1
      summaries.set(folder, summary)
    }
  }
  return summaries
}

function gitTreeEntries(decorations: Map<string, ExplorerGitDecoration>): Map<string, DirEntryInfo[]> {
  const entriesByParent = new Map<string, Map<string, DirEntryInfo>>()
  for (const [path, decoration] of decorations) {
    const parts = path.split('/').filter(Boolean)
    for (let index = 0; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/')
      const name = parts[index]
      const isDir = index < parts.length - 1 || decoration.directory
      const entries = entriesByParent.get(parent) ?? new Map<string, DirEntryInfo>()
      const existing = entries.get(name)
      if (!existing || isDir) entries.set(name, { name, isDir, isSymlink: false, size: 0, modifiedAt: null })
      entriesByParent.set(parent, entries)
    }
  }
  return new Map([...entriesByParent].map(([parent, entries]) => [parent, [...entries.values()]]))
}

import type { GitDirEntry, RepoKind, StatusEntry } from '../../ipc/types'

export type ChangeTreeState = {
  collapsedDirs: ReadonlySet<string>
  expandedFsDirs: ReadonlySet<string>
  fsChildren: ReadonlyMap<string, GitDirEntry[] | 'loading'>
}

export type ChangeTreeDirNode = {
  kind: 'dir'
  path: string
  name: string
  depth: number
  count: number
  fsBacked: boolean
  repoKind: RepoKind | null
  repoRoot: string | null
  ignored: boolean
  expanded: boolean
  loading: boolean
  entry: StatusEntry | null
}

export type ChangeTreeEntryNode = {
  kind: 'entry'
  path: string
  name: string
  depth: number
  entry: StatusEntry
}

export type ChangeTreeFsEntryNode = {
  kind: 'fsEntry'
  path: string
  name: string
  depth: number
  ignored: boolean
  repoRoot: string | null
}

export type ChangeTreeNode = ChangeTreeDirNode | ChangeTreeEntryNode | ChangeTreeFsEntryNode

export function buildChangeTree(entries: StatusEntry[], state: ChangeTreeState): ChangeTreeNode[] {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path))
  const counts = new Map<string, number>()
  for (const entry of sorted) {
    const segments = entry.path.replace(/\/$/, '').split('/')
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join('/')
      counts.set(prefix, (counts.get(prefix) ?? 0) + 1)
    }
  }

  const nodes: ChangeTreeNode[] = []
  let openDirs: string[] = []
  for (const entry of sorted) {
    const isDirEntry = entry.path.endsWith('/') || Boolean(entry.repoKind)
    const cleanPath = entry.path.replace(/\/$/, '')
    const segments = cleanPath.split('/')
    const dirSegments = segments.slice(0, -1)
    let common = 0
    while (common < openDirs.length && common < dirSegments.length && openDirs[common] === dirSegments[common]) common += 1
    openDirs = openDirs.slice(0, common)
    for (let index = common; index < dirSegments.length; index += 1) {
      if (!anyPrefixCollapsed(dirSegments, index, state.collapsedDirs)) {
        const prefix = dirSegments.slice(0, index + 1).join('/')
        nodes.push({
          kind: 'dir',
          path: prefix,
          name: dirSegments[index],
          depth: index,
          count: counts.get(prefix) ?? 0,
          fsBacked: false,
          repoKind: null,
          repoRoot: null,
          ignored: false,
          expanded: !state.collapsedDirs.has(prefix),
          loading: false,
          entry: null,
        })
      }
      openDirs.push(dirSegments[index])
    }
    if (anyPrefixCollapsed(dirSegments, dirSegments.length, state.collapsedDirs)) continue

    const depth = dirSegments.length
    const name = segments[segments.length - 1]
    if (isDirEntry) {
      const expanded = state.expandedFsDirs.has(cleanPath)
      const children = state.fsChildren.get(cleanPath)
      const repoRoot = entry.repoKind ? cleanPath : null
      nodes.push({
        kind: 'dir',
        path: cleanPath,
        name,
        depth,
        count: counts.get(cleanPath) ?? 0,
        fsBacked: true,
        repoKind: entry.repoKind ?? null,
        repoRoot,
        ignored: false,
        expanded,
        loading: expanded && children === 'loading',
        entry,
      })
      if (expanded && Array.isArray(children)) appendFsNodes(nodes, cleanPath, children, depth + 1, repoRoot, state)
    } else {
      nodes.push({ kind: 'entry', path: entry.path, name, depth, entry })
    }
  }
  return nodes
}

function appendFsNodes(
  nodes: ChangeTreeNode[],
  dirPath: string,
  children: GitDirEntry[],
  depth: number,
  repoRoot: string | null,
  state: ChangeTreeState,
): void {
  for (const child of children) {
    const childPath = `${dirPath}/${child.name}`
    if (child.isDir) {
      const expanded = state.expandedFsDirs.has(childPath)
      const grandChildren = state.fsChildren.get(childPath)
      const childRepoRoot = child.repoKind ? childPath : repoRoot
      nodes.push({
        kind: 'dir',
        path: childPath,
        name: child.name,
        depth,
        count: 0,
        fsBacked: true,
        repoKind: child.repoKind,
        repoRoot: childRepoRoot,
        ignored: child.ignored,
        expanded,
        loading: expanded && grandChildren === 'loading',
        entry: null,
      })
      if (expanded && Array.isArray(grandChildren)) appendFsNodes(nodes, childPath, grandChildren, depth + 1, childRepoRoot, state)
    } else {
      nodes.push({ kind: 'fsEntry', path: childPath, name: child.name, depth, ignored: child.ignored, repoRoot })
    }
  }
}

function anyPrefixCollapsed(segments: string[], length: number, collapsed: ReadonlySet<string>): boolean {
  for (let index = 1; index <= length; index += 1) {
    if (collapsed.has(segments.slice(0, index).join('/'))) return true
  }
  return false
}

import { describe, expect, it } from 'vitest'
import type { GitDirEntry, StatusEntry } from '../../ipc/types'
import { buildChangeTree } from './changeTree'

const modified = (path: string): StatusEntry => ({ path, oldPath: null, changeType: 'modified', repoKind: null })

describe('buildChangeTree', () => {
  it('groups changed files into collapsible folder rows', () => {
    const nodes = buildChangeTree([
      modified('src/app.ts'),
      modified('src/components/Button.tsx'),
    ], {
      collapsedDirs: new Set(),
      expandedFsDirs: new Set(),
      fsChildren: new Map(),
    })

    expect(nodes.map((node) => [node.kind, node.path, node.depth])).toEqual([
      ['dir', 'src', 0],
      ['entry', 'src/app.ts', 1],
      ['dir', 'src/components', 1],
      ['entry', 'src/components/Button.tsx', 2],
    ])
    expect(nodes[0]).toMatchObject({ count: 2, expanded: true })
  })

  it('expands an untracked nested repo into selectable filesystem files', () => {
    const repo: StatusEntry = { path: 'vendor/tool/', oldPath: null, changeType: 'untracked', repoKind: 'nestedRepo' }
    const children: GitDirEntry[] = [
      { name: 'src', isDir: true, repoKind: null, ignored: false },
      { name: 'README.md', isDir: false, repoKind: null, ignored: false },
    ]
    const nodes = buildChangeTree([repo], {
      collapsedDirs: new Set(),
      expandedFsDirs: new Set(['vendor/tool']),
      fsChildren: new Map([['vendor/tool', children]]),
    })

    expect(nodes.map((node) => [node.kind, node.path, node.depth])).toEqual([
      ['dir', 'vendor', 0],
      ['dir', 'vendor/tool', 1],
      ['dir', 'vendor/tool/src', 2],
      ['fsEntry', 'vendor/tool/README.md', 2],
    ])
    expect(nodes[1]).toMatchObject({ repoKind: 'nestedRepo', expanded: true })
    expect(nodes[3]).toMatchObject({ repoRoot: 'vendor/tool' })
  })

  it('treats a tracked submodule path as an expandable directory', () => {
    const submodule: StatusEntry = { path: 'vendor/lib', oldPath: null, changeType: 'modified', repoKind: 'submodule' }
    const nodes = buildChangeTree([submodule], {
      collapsedDirs: new Set(),
      expandedFsDirs: new Set(),
      fsChildren: new Map(),
    })

    expect(nodes).toHaveLength(2)
    expect(nodes[1]).toMatchObject({ kind: 'dir', path: 'vendor/lib', repoKind: 'submodule', fsBacked: true })
  })

  it('hides descendants while a status folder is collapsed', () => {
    const nodes = buildChangeTree([modified('src/app.ts')], {
      collapsedDirs: new Set(['src']),
      expandedFsDirs: new Set(),
      fsChildren: new Map(),
    })

    expect(nodes).toHaveLength(1)
    expect(nodes[0]).toMatchObject({ kind: 'dir', path: 'src', expanded: false })
  })
})

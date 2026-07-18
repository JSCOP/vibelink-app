import { describe, expect, test } from 'vitest'
import type { DirEntryInfo, WorkingStatus } from '../ipc/types'
import { deriveGitDecorations, emptyExplorerSessionState, flattenExplorerTree } from './explorer'

const directory: DirEntryInfo = { name: 'src', isDir: true, isSymlink: false, size: 0, modifiedAt: null }
const file: DirEntryInfo = { name: 'file.ts', isDir: false, isSymlink: false, size: 10, modifiedAt: null }

describe('Explorer tree helpers', () => {
  test('flattens expanded children with stable depth', () => {
    const session = {
      ...emptyExplorerSessionState,
      expandedPaths: new Set(['src']),
      childrenByPath: new Map([['', [directory]], ['src', [file]]]),
    }
    expect(flattenExplorerTree(session, new Map()).map((node) => ({ path: node.path, depth: node.depth }))).toEqual([
      { path: 'src', depth: 0 },
      { path: 'src/file.ts', depth: 1 },
    ])
  })

  test('applies conflict then staged precedence and marks changed ancestors', () => {
    const status: WorkingStatus = {
      staged: [{ path: 'src/file.ts', oldPath: null, changeType: 'added' }],
      unstaged: [{ path: 'src/file.ts', oldPath: null, changeType: 'modified' }],
      untracked: [],
      conflicted: [{ path: 'src/conflict.ts', oldPath: null, changeType: 'modified' }],
      truncated: false,
    }
    const decorations = deriveGitDecorations(status)
    expect(decorations.get('src/file.ts')).toBe('added')
    expect(decorations.get('src/conflict.ts')).toBe('conflicted')
    const session = {
      ...emptyExplorerSessionState,
      childrenByPath: new Map([['', [directory]]]),
    }
    expect(flattenExplorerTree(session, decorations)[0].ancestorChanged).toBe(true)
  })
})

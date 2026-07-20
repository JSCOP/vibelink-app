import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { DirEntryInfo, WorkingStatus } from '../ipc/types'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke }))

import { deriveGitDecorations, emptyExplorerSessionState, flattenExplorerTree, useExplorerStore } from './explorer'

const directory: DirEntryInfo = { name: 'src', isDir: true, isSymlink: false, size: 0, modifiedAt: null }
const file: DirEntryInfo = { name: 'file.ts', isDir: false, isSymlink: false, size: 10, modifiedAt: null }

beforeEach(() => {
  invoke.mockReset()
  useExplorerStore.setState({ sessions: {} })
})

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

  test('preserves staged and working-tree states and summarizes changed folders', () => {
    const status: WorkingStatus = {
      staged: [{ path: 'src/file.ts', oldPath: null, changeType: 'added' }],
      unstaged: [{ path: 'src/file.ts', oldPath: null, changeType: 'modified' }],
      untracked: [{ path: 'assets/', oldPath: null, changeType: 'untracked' }],
      conflicted: [{ path: 'src/conflict.ts', oldPath: null, changeType: 'modified' }],
      truncated: false,
    }
    const decorations = deriveGitDecorations(status)
    expect(decorations.get('src/file.ts')).toMatchObject({ staged: 'added', unstaged: 'modified', untracked: false, conflicted: false })
    expect(decorations.get('src/conflict.ts')).toMatchObject({ conflicted: true })
    expect(decorations.get('assets')).toMatchObject({ untracked: true, directory: true })

    const session = {
      ...emptyExplorerSessionState,
      childrenByPath: new Map([['', [directory, { ...directory, name: 'assets' }]]]),
    }
    const nodes = flattenExplorerTree(session, decorations)
    expect(nodes.find((node) => node.path === 'src')?.changeSummary).toEqual({ total: 2, conflicted: 1, staged: 1, unstaged: 1, untracked: 0 })
    expect(nodes.find((node) => node.path === 'assets')?.changeSummary).toEqual({ total: 1, conflicted: 0, staged: 0, unstaged: 0, untracked: 1 })
  })

  test('keeps deleted files visible as Git-only explorer entries', () => {
    const status: WorkingStatus = {
      staged: [],
      unstaged: [{ path: 'src/deleted.ts', oldPath: null, changeType: 'deleted' }],
      untracked: [],
      conflicted: [],
      truncated: false,
    }
    const session = {
      ...emptyExplorerSessionState,
      expandedPaths: new Set(['src']),
      childrenByPath: new Map([['', [directory]], ['src', []]]),
    }

    expect(flattenExplorerTree(session, deriveGitDecorations(status)).find((node) => node.path === 'src/deleted.ts')).toMatchObject({
      gitOnly: true,
      decoration: { unstaged: 'deleted' },
    })
  })

  test('projects nested repository status into the shared Explorer paths', () => {
    const nestedStatus: WorkingStatus = {
      staged: [],
      unstaged: [{ path: 'src/changed.ts', oldPath: null, changeType: 'modified' }],
      untracked: [],
      conflicted: [],
      truncated: false,
    }

    expect(deriveGitDecorations(nestedStatus, 'vendor/tool', 'vendor/tool').get('vendor/tool/src/changed.ts')).toMatchObject({
      unstaged: 'modified',
      repoRoot: 'vendor/tool',
    })
  })

  test('loads and expands deep ancestors when another view reveals a file', async () => {
    invoke.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'git_dir_entries') return []
      if (command !== 'fs_list_dir') return []
      if (args?.relPath === '') return [{ ...directory }]
      if (args?.relPath === 'src') return [{ ...directory, name: 'deep' }]
      if (args?.relPath === 'src/deep') return [{ ...file }]
      return []
    })

    await useExplorerStore.getState().revealPath('session-1', 'C:/repo', 'src/deep/file.ts')
    const session = useExplorerStore.getState().sessions['session-1']
    expect(session.selectedPath).toBe('src/deep/file.ts')
    expect(session.expandedPaths).toEqual(new Set(['src', 'src/deep']))
    expect(session.childrenByPath.has('src/deep')).toBe(true)
  })
})

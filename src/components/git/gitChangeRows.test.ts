import { describe, expect, it } from 'vitest'
import { flattenGitChangeRows, gitChangeHeaderHeight, gitChangeItemHeight, gitChangeRowHeight } from './gitChangeRows'
import type { GitChangeGroup, GitChangeItem } from './gitWorkspaceModel'

function item(path: string, area: GitChangeItem['area'] = 'unstaged'): GitChangeItem {
  return { path, oldPath: null, changeType: 'modified', area }
}

function group(id: GitChangeGroup['id'], items: GitChangeItem[]): GitChangeGroup {
  return { id, title: id, count: items.length, actions: [], items }
}

describe('git change row flattening', () => {
  it('emits a header before each non-empty group and one row per change', () => {
    const rows = flattenGitChangeRows([
      group('staged', [item('a.ts', 'staged')]),
      group('unstaged', [item('b.ts'), item('c.ts')]),
    ])

    expect(rows.map((row) => row.kind)).toEqual(['header', 'item', 'header', 'item', 'item'])
    expect(rows.filter((row) => row.kind === 'item').map((row) => (row.kind === 'item' ? row.item.path : ''))).toEqual(['a.ts', 'b.ts', 'c.ts'])
  })

  it('skips empty groups entirely so no stray header is rendered', () => {
    const rows = flattenGitChangeRows([group('staged', []), group('unstaged', [item('b.ts')])])

    expect(rows).toHaveLength(2)
    expect(rows[0].kind === 'header' && rows[0].group.id).toBe('unstaged')
  })

  it('marks untracked rows so the discard action stays correct after virtualization', () => {
    const rows = flattenGitChangeRows([
      group('unstaged', [item('tracked.ts')]),
      group('untracked', [item('new.ts')]),
    ])

    const tracked = rows.find((row) => row.kind === 'item' && row.item.path === 'tracked.ts')
    const untracked = rows.find((row) => row.kind === 'item' && row.item.path === 'new.ts')
    expect(tracked?.kind === 'item' && tracked.untracked).toBe(false)
    expect(untracked?.kind === 'item' && untracked.untracked).toBe(true)
  })

  it('gives every row a key unique across areas with the same path', () => {
    const rows = flattenGitChangeRows([
      group('staged', [item('same.ts', 'staged')]),
      group('unstaged', [item('same.ts')]),
    ])

    const keys = rows.map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('estimates header and item heights separately', () => {
    const rows = flattenGitChangeRows([group('unstaged', [item('a.ts')])])

    expect(gitChangeRowHeight(rows[0])).toBe(gitChangeHeaderHeight)
    expect(gitChangeRowHeight(rows[1])).toBe(gitChangeItemHeight)
    expect(gitChangeRowHeight(undefined)).toBe(gitChangeItemHeight)
  })
})

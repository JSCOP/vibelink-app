import { describe, expect, test } from 'vitest'
import type { SessionMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings } from './profiles'
import { useWorkspaceStore } from './store'
import type { WorktreeProjection, WorktreeRecord } from './worktrees'
import { flattenWorkspaceRows, recoverWorkspaceGroups, workspaceRows, type WorkspaceGroup } from './workspaceGroups'

function session(id: string): SessionMeta {
  return {
    id,
    name: id,
    paneCount: 0,
    createdAt: 0,
    workspaceFolder: `E:/${id}`,
  }
}

const group: WorkspaceGroup = { id: 'group-a', name: 'Monorepo', collapsed: false }

function worktree(id: string, parentSessionId: string, branch: string): WorktreeProjection & { record: WorktreeRecord } {
  return {
    id: `record-${id}`,
    instanceId: `instance-${id}`,
    state: 'managed',
    parentWorktreeId: null,
    childWorktreeIds: [],
    native: null,
    record: {
      id: `record-${id}`, instanceId: `instance-${id}`, repositoryId: 'repository-1', repositoryPath: 'E:/repo',
      worktreePath: `E:/worktrees/${id}`, branch, head: 'abc', baseRef: 'HEAD', sessionId: id, parentSessionId,
      parentWorktreeId: null, parentInstanceId: null, origin: 'manual', lifecycle: 'active', locked: false, lockReason: null,
      prunable: false, prunableReason: null, dirty: false, untracked: false, hasConflicts: false, ahead: 0, behind: 0,
      exists: true, setupPolicy: 'inherit', sparsePreset: null, linkedFiles: [], initialAgent: null, initialPrompt: null,
      comment: null, reviewTarget: null, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
    },
  }
}

describe('workspace groups', () => {
  test('renders groups before ungrouped sessions and orders members by workspaceOrder', () => {
    const rows = workspaceRows(
      [session('ungrouped-b'), session('member-b'), session('member-a'), session('ungrouped-a')],
      [group],
      { 'member-a': group.id, 'member-b': group.id },
      ['member-a', 'ungrouped-a', 'member-b', 'ungrouped-b'],
    )

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ kind: 'group', group })
    expect(rows[0].kind === 'group' ? rows[0].sessions.map(({ session }) => session.id) : []).toEqual(['member-a', 'member-b'])
    expect(rows.slice(1).map((row) => row.kind === 'session' ? row.node.session.id : row.group.id)).toEqual(['ungrouped-a', 'ungrouped-b'])
  })

  test('assigns a group root workspace by normalized folder even before its persisted group id catches up', () => {
    const rootedGroup: WorkspaceGroup = { ...group, rootFolder: 'E:\\repos\\mono\\' }
    const root = { ...session('root'), workspaceFolder: 'E:/repos/mono' }
    const rows = workspaceRows([root, session('member'), session('ungrouped')], [rootedGroup], { member: group.id }, [])

    expect(rows[0].kind === 'group' ? rows[0].sessions.map(({ session: item }) => item.id) : []).toEqual(['root', 'member'])
    expect(rows.slice(1).map((row) => row.kind === 'session' ? row.node.session.id : row.group.id)).toEqual(['ungrouped'])
  })

  test('recovers a lost folder group from a surviving root workspace and direct child sessions', () => {
    const root = { ...session('root'), name: 'VibeLink', workspaceFolder: 'E:\\VibeCodingProject\\vibelink\\' }
    const app = { ...session('app'), workspaceFolder: 'E:/VibeCodingProject/vibelink/vibelink-app' }
    const web = { ...session('web'), workspaceFolder: 'E:/VibeCodingProject/vibelink/vibelink-web' }
    const unrelated = { ...session('unrelated'), workspaceFolder: 'E:/workspaces/updraft' }

    expect(recoverWorkspaceGroups([root, app, web, unrelated])).toEqual({
      groups: [{
        id: 'recovered-root',
        name: 'vibelink',
        collapsed: false,
        rootFolder: 'E:/VibeCodingProject/vibelink',
      }],
      groupIds: { root: 'recovered-root', app: 'recovered-root', web: 'recovered-root' },
    })
    expect(recoverWorkspaceGroups([root, app, unrelated])).toBeNull()
  })


  test('keeps empty groups in group order', () => {
    const emptyGroup: WorkspaceGroup = { id: 'group-empty', name: 'Empty', collapsed: false }
    const rows = workspaceRows([session('member-a')], [emptyGroup, group], { 'member-a': group.id }, [])

    expect(rows.map((row) => row.kind === 'group' ? row.group.id : row.node.session.id)).toEqual(['group-empty', 'group-a'])
    expect(rows[0].kind === 'group' ? rows[0].sessions : []).toEqual([])
  })

  test('flattening includes sessions from collapsed groups', () => {
    const collapsedGroup = { ...group, collapsed: true }
    const rows = workspaceRows(
      [session('ungrouped'), session('member-b'), session('member-a')],
      [collapsedGroup],
      { 'member-a': group.id, 'member-b': group.id },
      ['member-a', 'member-b', 'ungrouped'],
    )

    expect(flattenWorkspaceRows(rows).map(({ id }) => id)).toEqual(['member-a', 'member-b', 'ungrouped'])
  })

  test('nests registry worktree sessions under their repository and keeps shortcut order parent-first', () => {
    const rows = workspaceRows(
      [session('worktree-b'), session('repo'), session('ungrouped'), session('worktree-a')],
      [group],
      { repo: group.id },
      ['worktree-a', 'repo', 'worktree-b', 'ungrouped'],
      [worktree('worktree-a', 'repo', 'vibelink/a'), worktree('worktree-b', 'repo', 'vibelink/b')],
    )

    expect(rows[0].kind === 'group' ? rows[0].sessions[0]?.session.id : null).toBe('repo')
    expect(rows[0].kind === 'group' ? rows[0].sessions[0]?.worktrees.map(({ session: child }) => child.id) : []).toEqual(['worktree-a', 'worktree-b'])
    expect(flattenWorkspaceRows(rows).map(({ id }) => id)).toEqual(['repo', 'worktree-a', 'worktree-b', 'ungrouped'])
  })

  test('nests a child under its parent worktree through the registry lineage edge', () => {
    const parent = worktree('worktree-a', 'repo', 'vibelink/a')
    const child = { ...worktree('worktree-b', 'worktree-a', 'vibelink/b'), parentWorktreeId: parent.id }
    const rows = workspaceRows(
      [session('repo'), session('worktree-a'), session('worktree-b')],
      [],
      {},
      ['repo', 'worktree-a', 'worktree-b'],
      [parent, child],
    )

    const repoNode = rows[0].kind === 'session' ? rows[0].node : null
    expect(repoNode?.worktrees.map(({ session: node }) => node.id)).toEqual(['worktree-a'])
    expect(repoNode?.worktrees[0]?.worktrees.map(({ session: node }) => node.id)).toEqual(['worktree-b'])
    expect(flattenWorkspaceRows(rows).map(({ id }) => id)).toEqual(['repo', 'worktree-a', 'worktree-b'])
  })

  test('does not nest a child whose lineage edge the registry rejected', () => {
    // The daemon strips `parentWorktreeId` from cycle-participating or
    // instance-mismatched edges, so the child must surface under its repository.
    const parent = worktree('worktree-a', 'repo', 'vibelink/a')
    const child = worktree('worktree-b', 'repo', 'vibelink/b')
    const rows = workspaceRows(
      [session('repo'), session('worktree-a'), session('worktree-b')],
      [],
      {},
      ['repo', 'worktree-a', 'worktree-b'],
      [parent, child],
    )

    const repoNode = rows[0].kind === 'session' ? rows[0].node : null
    expect(repoNode?.worktrees.map(({ session: node }) => node.id)).toEqual(['worktree-a', 'worktree-b'])
    expect(repoNode?.worktrees.every((node) => node.worktrees.length === 0)).toBe(true)
  })

  test('orders child worktrees by the provided visible order, not projection order', () => {
    const rows = workspaceRows(
      [session('repo'), session('worktree-a'), session('worktree-b')],
      [],
      {},
      ['repo', 'worktree-b', 'worktree-a'],
      [worktree('worktree-a', 'repo', 'vibelink/a'), worktree('worktree-b', 'repo', 'vibelink/b')],
    )

    const repoNode = rows[0].kind === 'session' ? rows[0].node : null
    expect(repoNode?.worktrees.map(({ session: node }) => node.id)).toEqual(['worktree-b', 'worktree-a'])
  })

  test('surfaces registry rows with no workspace session as detached repository rows', () => {
    const missing = worktree('gone', 'repo', 'vibelink/gone')
    const detached: WorktreeProjection = {
      ...missing,
      state: 'missing',
      record: { ...missing.record, sessionId: null, exists: false, lifecycle: 'missing' },
    }
    const rows = workspaceRows([session('repo')], [], {}, ['repo'], [detached])

    const repoNode = rows[0].kind === 'session' ? rows[0].node : null
    expect(repoNode?.detached.map(({ id }) => id)).toEqual([detached.id])
    expect(repoNode?.worktrees).toEqual([])
    // Detached rows have no workspace, so they never enter shortcut ordering.
    expect(flattenWorkspaceRows(rows).map(({ id }) => id)).toEqual(['repo'])
  })

  test('settings round-trip preserves normalized group roots and drops malformed groups and assignments', () => {
    const normalized = normalizeSettings({
      ...defaultSettings,
      workspaceGroups: [
        { id: ' group-a ', name: ' Monorepo ', collapsed: true, rootFolder: ' E:/code/mono ' },
        { id: 'group-a', name: 'Duplicate', collapsed: false, rootFolder: 'E:/duplicate' },
        { id: 'group-b', name: 'Blank root', rootFolder: '   ' },
        { id: 'group-c', name: 'Missing root' },
        { id: 'group-d', name: 'Invalid root type', rootFolder: 42 },
        { id: 'group-invalid', name: '   ', rootFolder: 'E:/invalid' },
        { id: 42, name: 'Invalid', collapsed: false, rootFolder: 'E:/invalid' },
      ],
      workspaceGroupIds: {
        ' session-a ': ' group-a ',
        'session-b': 'missing-group',
        'session-c': 42,
      },

    })

    expect(normalized.workspaceGroups).toEqual([
      { id: 'group-a', name: 'Monorepo', collapsed: true, rootFolder: 'E:/code/mono' },
      { id: 'group-b', name: 'Blank root', collapsed: false, rootFolder: null },
      { id: 'group-c', name: 'Missing root', collapsed: false, rootFolder: null },
      { id: 'group-d', name: 'Invalid root type', collapsed: false, rootFolder: null },
    ])
    expect(normalized.workspaceGroupIds).toEqual({ 'session-a': 'group-a' })

    const roundTripped = normalizeSettings(JSON.parse(JSON.stringify(normalized)))
    expect(roundTripped.workspaceGroups).toEqual(normalized.workspaceGroups)
    expect(roundTripped.workspaceGroupIds).toEqual(normalized.workspaceGroupIds)
  })

  test('store actions create, update, assign, and delete groups without deleting sessions', () => {
    const previousSettings = useWorkspaceStore.getState().settings
    const previousSessions = useWorkspaceStore.getState().sessions
    const assignedSession = session('session-a')
    useWorkspaceStore.setState({
      sessions: [assignedSession],
      settings: normalizeSettings({ ...defaultSettings }),
    })

    try {
      const created = useWorkspaceStore.getState().createWorkspaceGroup('  Monorepo  ', '  E:/code/mono  ')
      expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      expect(created).toMatchObject({ name: 'Monorepo', collapsed: false, rootFolder: 'E:/code/mono' })

      useWorkspaceStore.getState().setWorkspaceGroup(assignedSession.id, created.id)
      useWorkspaceStore.getState().setWorkspaceGroup(assignedSession.id, null)
      expect(useWorkspaceStore.getState().settings.workspaceGroupIds).toEqual({})
      useWorkspaceStore.getState().setWorkspaceGroup(assignedSession.id, created.id)
      useWorkspaceStore.getState().renameWorkspaceGroup(created.id, '  Related repositories  ')
      useWorkspaceStore.getState().toggleWorkspaceGroupCollapsed(created.id)
      useWorkspaceStore.getState().setWorkspaceGroupRootFolder(created.id, '  E:/code/root  ')
      expect(useWorkspaceStore.getState().settings.workspaceGroups[0]?.rootFolder).toBe('E:/code/root')
      useWorkspaceStore.getState().setWorkspaceGroupRootFolder(created.id, null)

      expect(useWorkspaceStore.getState().settings.workspaceGroups).toEqual([
        { id: created.id, name: 'Related repositories', collapsed: true, rootFolder: null },
      ])
      expect(useWorkspaceStore.getState().settings.workspaceGroupIds).toEqual({ [assignedSession.id]: created.id })

      useWorkspaceStore.getState().deleteWorkspaceGroup(created.id)
      expect(useWorkspaceStore.getState().settings.workspaceGroups).toEqual([])
      expect(useWorkspaceStore.getState().settings.workspaceGroupIds).toEqual({})
      expect(useWorkspaceStore.getState().sessions).toEqual([assignedSession])
    } finally {
      useWorkspaceStore.setState({ settings: previousSettings, sessions: previousSessions })
    }
  })
})

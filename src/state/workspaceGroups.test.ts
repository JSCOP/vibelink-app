import { describe, expect, test } from 'vitest'
import type { SessionMeta } from '../ipc/types'
import { defaultSettings, normalizeSettings } from './profiles'
import { useWorkspaceStore } from './store'
import { flattenWorkspaceRows, workspaceRows, type WorkspaceGroup } from './workspaceGroups'

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
    expect(rows[0].kind === 'group' ? rows[0].sessions.map(({ id }) => id) : []).toEqual(['member-a', 'member-b'])
    expect(rows.slice(1).map((row) => row.kind === 'session' ? row.session.id : row.group.id)).toEqual(['ungrouped-a', 'ungrouped-b'])
  })

  test('keeps empty groups in group order', () => {
    const emptyGroup: WorkspaceGroup = { id: 'group-empty', name: 'Empty', collapsed: false }
    const rows = workspaceRows([session('member-a')], [emptyGroup, group], { 'member-a': group.id }, [])

    expect(rows.map((row) => row.kind === 'group' ? row.group.id : row.session.id)).toEqual(['group-empty', 'group-a'])
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

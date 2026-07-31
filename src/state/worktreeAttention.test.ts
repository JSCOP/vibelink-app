import { describe, expect, test } from 'vitest'
import type { SessionMeta } from '../ipc/types'
import {
  EXPLICIT_ATTENTION_TTL_MS,
  NEW_WORKSPACE_GRACE_MS,
  buildAttentionByWorkspace,
  buildWorkspaceComparator,
  deriveVisibleWorkspaceOrder,
  effectiveRecentActivity,
  resolveAttention,
  type NativeAttentionPane,
  type WorkspaceAttention,
} from './worktreeAttention'

function session(id: string, name = id, createdAt = 1): SessionMeta {
  return { id, name, paneCount: 0, createdAt, workspaceFolder: `E:/${id}` }
}

function pane(overrides: Partial<NativeAttentionPane> = {}): NativeAttentionPane {
  return {
    workspaceId: 'workspace-a',
    paneId: 'pane-a',
    state: 'idle',
    stateUpdatedAt: 0,
    lastOutputAt: 0,
    unreadCount: 0,
    interrupted: false,
    source: 'orchestration',
    alive: true,
    title: 'Shell',
    ...overrides,
  }
}

function attention(attentionClass: 1 | 2 | 3 | 4, timestamp: number, recentActivity: number): WorkspaceAttention {
  return {
    attentionClass,
    timestamp,
    recentActivity,
    state: attentionClass === 1 ? 'blocked' : attentionClass === 2 ? 'done' : attentionClass === 3 ? 'working' : 'idle',
    unreadCount: 0,
    completionCount: 0,
    source: '',
    cause: '',
  }
}


describe('smart workspace attention', () => {
  test('uses fresh native evidence without treating hookless done as completion', () => {
    const now = 2_000_000
    expect(resolveAttention(pane({ state: 'waiting', stateUpdatedAt: now - 10 }), now).attentionClass).toBe(1)
    expect(resolveAttention(pane({ state: 'done', stateUpdatedAt: now - 10 }), now).attentionClass).toBe(4)
    expect(resolveAttention(pane({ state: 'done', stateUpdatedAt: now - 10, interrupted: true }), now).attentionClass).toBe(4)
    expect(resolveAttention(pane({ state: 'idle', stateUpdatedAt: now - 10, title: 'Waiting for permission' }), now).attentionClass).toBe(4)
    expect(resolveAttention(pane({ state: 'error', stateUpdatedAt: now - EXPLICIT_ATTENTION_TTL_MS - 1 }), now).attentionClass).toBe(4)
    expect(resolveAttention(pane({ state: 'idle', stateUpdatedAt: now - EXPLICIT_ATTENTION_TTL_MS - 1, title: 'Waiting for permission' }), now)).toMatchObject({
      attentionClass: 1,
      source: 'terminal-title',
      cause: 'permission',
    })
  })

  test('keeps explicit completion markers until review and applies them per pane', () => {
    const now = 10_000_000
    const target = session('workspace-a')
    const marker = { completedAt: now - EXPLICIT_ATTENTION_TTL_MS * 2, source: 'agent-hook' as const, sessionId: target.id }
    const build = (nativePanes: NativeAttentionPane[], reviewedPaneIds = new Set<string>()) => buildAttentionByWorkspace(
      [target],
      [],
      { capturedAt: now, panes: nativePanes },
      { completionHighlights: { 'pane-a': marker }, hermesStatus: {}, reviewedPaneIds },
      now,
    )[target.id]

    expect(build([pane({ state: 'done', stateUpdatedAt: now - 1 })])).toMatchObject({ attentionClass: 2, completionCount: 1, source: 'agent-hook' })
    expect(build([pane({ state: 'working', stateUpdatedAt: now - 1 })])).toMatchObject({ attentionClass: 3, completionCount: 0 })
    expect(build([pane()], new Set(['pane-a']))).toMatchObject({ attentionClass: 4, completionCount: 0 })
    expect(build([
      pane(),
      pane({ paneId: 'pane-b', state: 'done', stateUpdatedAt: now - 1, interrupted: true }),
    ])).toMatchObject({ attentionClass: 2, completionCount: 1 })
  })

  test('uses Hermes and Git only when the workspace has no fresh native pane evidence', () => {
    const now = 20_000_000
    const target = session('workspace-a')
    const build = (nativePane: NativeAttentionPane) => buildAttentionByWorkspace(
      [target],
      [],
      { capturedAt: now, panes: [nativePane] },
      { completionHighlights: {}, hermesStatus: { [target.id]: 'running' }, conflictSessionIds: new Set([target.id]) },
      now,
    )[target.id]

    expect(build(pane({ state: 'idle', stateUpdatedAt: now - 1 }))).toMatchObject({ attentionClass: 4, state: 'idle' })
    expect(build(pane({ state: 'idle', stateUpdatedAt: 0 }))).toMatchObject({ attentionClass: 1, state: 'blocked', source: 'git' })
  })

  test('treats an available Hermes runtime as idle and only an active turn as working', () => {
    const now = 30_000_000
    const target = session('workspace-a')
    const build = (status: 'starting' | 'running' | 'busy') => buildAttentionByWorkspace(
      [target],
      [],
      null,
      { completionHighlights: {}, hermesStatus: { [target.id]: status } },
      now,
    )[target.id]

    expect(build('starting')).toMatchObject({ attentionClass: 4, state: 'idle' })
    expect(build('running')).toMatchObject({ attentionClass: 4, state: 'idle' })
    expect(build('busy')).toMatchObject({ attentionClass: 3, state: 'working', source: 'hermes' })
  })

  test('orders the canonical blocked, done, working, idle fixture deterministically', () => {
    const sessions = [
      session('idle', 'Idle'),
      session('working', 'Working'),
      session('done', 'Done'),
      session('blocked', 'Blocked'),
    ]
    const byWorkspace: Record<string, WorkspaceAttention> = {
      blocked: attention(1, 100, 100),
      done: attention(2, 200, 200),
      working: attention(3, 300, 300),
      idle: attention(4, 0, 400),
    }

    expect([...sessions].sort(buildWorkspaceComparator('smart', byWorkspace, [], [])).map(({ id }) => id)).toEqual([
      'blocked',
      'done',
      'working',
      'idle',
    ])
  })

  test('breaks every comparator tie by normalized name and stable session id', () => {
    const sessions = [session('z-id', 'Same'), session('a-id', 'Same')]
    const byWorkspace = { 'z-id': attention(4, 0, 1), 'a-id': attention(4, 0, 1) }

    for (const mode of ['smart', 'recent', 'name', 'repository', 'manual'] as const) {
      expect([...sessions].sort(buildWorkspaceComparator(mode, byWorkspace, [], [])).map(({ id }) => id)).toEqual(['a-id', 'z-id'])
    }
  })

  test('gives a new workspace a five-minute recency floor only during grace', () => {
    const now = 50_000_000
    const createdAtSeconds = now / 1_000
    const fresh = session('fresh', 'Fresh', createdAtSeconds)
    expect(effectiveRecentActivity(fresh, undefined, [], now)).toBe(now + NEW_WORKSPACE_GRACE_MS)

    const oldCreatedAt = now - NEW_WORKSPACE_GRACE_MS - 1
    const old = session('old', 'Old', oldCreatedAt / 1_000)
    expect(effectiveRecentActivity(old, undefined, [], now)).toBe(oldCreatedAt)
  })

  test('derives one grouped order for sidebar, startup, shortcuts, and remote consumers', () => {
    const sessions = [session('gamma', 'Gamma'), session('alpha', 'Alpha'), session('beta', 'Beta')]
    const byWorkspace = {
      gamma: attention(3, 30, 30),
      alpha: attention(1, 10, 10),
      beta: attention(2, 20, 20),
    }
    const derived = deriveVisibleWorkspaceOrder(
      sessions,
      [{ id: 'group', name: 'Group', collapsed: false }],
      { alpha: 'group', beta: 'group' },
      [],
      'smart',
      byWorkspace,
      ['gamma', 'beta', 'alpha'],
    )

    expect(derived.sessions.map(({ id }) => id)).toEqual(['alpha', 'beta', 'gamma'])
    expect(derived.sessionIds).toEqual(derived.sessions.map(({ id }) => id))
    expect(derived.rows.flatMap((row) => row.kind === 'group' ? row.sessions.map(({ session: member }) => member.id) : [row.node.session.id])).toEqual(['alpha', 'beta', 'gamma'])
  })
})

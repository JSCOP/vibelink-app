import { describe, expect, test } from 'vitest'
import type { PaneMeta, SessionMeta, Task } from '../ipc/types'
import { defaultSettings } from './profiles'
import { stateWithoutSession, withoutPaneKeys } from './sessionStateCleanup'

const removedSessionId = 'session-remove'
const keptSessionId = 'session-keep'
const removedPaneId = 'pane-remove'
const keptPaneId = 'pane-keep'
const removedTaskId = 'task-remove'
const keptTaskId = 'task-keep'

function session(id: string): SessionMeta {
  return { id, name: id, paneCount: 0, createdAt: 1, workspaceFolder: `E:/${id}` }
}

function pane(id: string): PaneMeta {
  return {
    id,
    config: {
      paneId: id,
      shell: 'pwsh.exe',
      args: [],
      cwd: 'E:/work',
      env: [],
      title: id,
      cols: 120,
      rows: 32,
    },
    alive: true,
  }
}

function task(id: string, sessionId: string): Task {
  return {
    id,
    sessionId,
    title: id,
    description: '',
    status: 'pending',
    statusTimestamps: {},
    createdAt: 1,
    updatedAt: 1,
  }
}

function cleanupState(activeSessionId = removedSessionId) {
  return {
    sessions: [session(removedSessionId), session(keptSessionId)],
    activeSessionId,
    panes: { [removedPaneId]: pane(removedPaneId) },
    paneLifecycle: { [removedPaneId]: 'live' as const },
    activePaneId: removedPaneId,
    kanban: {
      tasks: {
        [removedTaskId]: task(removedTaskId, removedSessionId),
        [keptTaskId]: task(keptTaskId, keptSessionId),
      },
      taskOrder: {
        [removedSessionId]: [removedTaskId],
        [keptSessionId]: [keptTaskId],
      },
    },
    viewModes: { [removedSessionId]: 'kanban' as const, [keptSessionId]: 'terminal' as const },
    kanbanLayouts: { [removedSessionId]: 'removed-layout', [keptSessionId]: 'kept-layout' },
    orchestratorPaneIds: { [removedSessionId]: removedPaneId, [keptSessionId]: keptPaneId },
    selectedTaskId: { [removedSessionId]: removedTaskId, [keptSessionId]: keptTaskId },
    workspaceTodos: { [removedSessionId]: [], [keptSessionId]: [] },
    workspaceTodoNotes: { [removedSessionId]: 'removed-note', [keptSessionId]: 'kept-note' },
    workspaceBriefs: { [removedSessionId]: null, [keptSessionId]: null },
    hermesStatus: { [removedSessionId]: 'busy' as const, [keptSessionId]: 'idle' as const },
    hermesTranscript: { [removedSessionId]: [], [keptSessionId]: [] },
    hermesPermissions: { [removedSessionId]: [], [keptSessionId]: [] },
    hermesUsage: { [removedSessionId]: { size: 10, used: 5 }, [keptSessionId]: { size: 20, used: 10 } },
    hermesModels: { [removedSessionId]: { available: [], current: 'removed' }, [keptSessionId]: { available: [], current: 'kept' } },
    hermesPendingPrompts: { [removedSessionId]: [], [keptSessionId]: [] },
    hermesGenerations: { [removedSessionId]: 1, [keptSessionId]: 2 },
    hermesCurrentSession: { [removedSessionId]: 'acp-remove', [keptSessionId]: 'acp-keep' },
    hermesSessions: { [removedSessionId]: [], [keptSessionId]: [] },
    manualPaneTitles: { [removedPaneId]: true },
    capturesByPane: { [removedPaneId]: ['removed.png'], [keptPaneId]: ['kept.png'] },
    captureSessionByPane: { [removedPaneId]: removedSessionId, [keptPaneId]: keptSessionId },
    paneCompletionHighlights: {
      [removedPaneId]: { completedAt: 1, source: 'agent-hook' as const, sessionId: removedSessionId },
      [keptPaneId]: { completedAt: 2, source: 'agent-hook' as const, sessionId: keptSessionId },
    },
    paneReviewMarkers: {
      [removedPaneId]: { reviewedAt: 1, sessionId: removedSessionId },
      [keptPaneId]: { reviewedAt: 2, sessionId: keptSessionId },
    },
    settings: {
      ...defaultSettings,
      paneRoles: { [removedPaneId]: 'removed-role' },
      workspaceProfileIds: { [removedSessionId]: 'removed-profile', [keptSessionId]: 'kept-profile' },
      workspaceDetails: {
        [removedSessionId]: { githubIssue: '', githubPullRequest: '', notes: 'removed' },
        [keptSessionId]: { githubIssue: '', githubPullRequest: '', notes: 'kept' },
      },
      workspaceGroupIds: { [removedSessionId]: 'removed-group', [keptSessionId]: 'kept-group' },
      workspaceOrder: [removedSessionId, keptSessionId],
    },
  }
}

describe('session state cleanup', () => {
  test('removes the session from every session-scoped map', () => {
    const state = cleanupState()
    const sessions = [session(keptSessionId)]
    const next = stateWithoutSession(state, removedSessionId, sessions)

    expect(next.sessions).toEqual(sessions)
    expect(next.activeSessionId).toBeUndefined()
    expect(next.panes).toEqual({})
    expect(next.paneLifecycle).toEqual({})
    expect(next.activePaneId).toBeUndefined()
    expect(next.kanban.tasks).toEqual({ [keptTaskId]: state.kanban.tasks[keptTaskId] })
    expect(next.kanban.taskOrder).toEqual({ [keptSessionId]: [keptTaskId] })
    expect(next.viewModes).toEqual({ [keptSessionId]: 'terminal' })
    expect(next.kanbanLayouts).toEqual({ [keptSessionId]: 'kept-layout' })
    expect(next.orchestratorPaneIds).toEqual({ [keptSessionId]: keptPaneId })
    expect(next.selectedTaskId).toEqual({ [keptSessionId]: keptTaskId })
    expect(next.workspaceTodos).toEqual({ [keptSessionId]: [] })
    expect(next.workspaceTodoNotes).toEqual({ [keptSessionId]: 'kept-note' })
    expect(next.workspaceBriefs).toEqual({ [keptSessionId]: null })
    expect(next.hermesStatus).toEqual({ [keptSessionId]: 'idle' })
    expect(next.hermesTranscript).toEqual({ [keptSessionId]: [] })
    expect(next.hermesPermissions).toEqual({ [keptSessionId]: [] })
    expect(next.hermesUsage).toEqual({ [keptSessionId]: { size: 20, used: 10 } })
    expect(next.hermesModels).toEqual({ [keptSessionId]: { available: [], current: 'kept' } })
    expect(next.hermesPendingPrompts).toEqual({ [keptSessionId]: [] })
    expect(next.hermesGenerations).toEqual({ [keptSessionId]: 2 })
    expect(next.hermesCurrentSession).toEqual({ [keptSessionId]: 'acp-keep' })
    expect(next.hermesSessions).toEqual({ [keptSessionId]: [] })
    expect(next.manualPaneTitles).toEqual({})
    expect(next.capturesByPane).toEqual({ [keptPaneId]: ['kept.png'] })
    expect(next.captureSessionByPane).toEqual({ [keptPaneId]: keptSessionId })
    expect(next.paneCompletionHighlights).toEqual({ [keptPaneId]: state.paneCompletionHighlights[keptPaneId] })
    expect(next.paneReviewMarkers).toEqual({ [keptPaneId]: state.paneReviewMarkers[keptPaneId] })
    expect(next.settings.paneRoles).toEqual({})
    expect(next.settings.workspaceProfileIds).toEqual({ [keptSessionId]: 'kept-profile' })
    expect(next.settings.workspaceDetails).toEqual({ [keptSessionId]: state.settings.workspaceDetails[keptSessionId] })
    expect(next.settings.workspaceGroupIds).toEqual({ [keptSessionId]: 'kept-group' })
    expect(next.settings.workspaceOrder).toEqual([keptSessionId])
  })

  test('leaves state unchanged for an unknown session id', () => {
    const state = cleanupState(keptSessionId)

    expect(stateWithoutSession(state, 'session-unknown', state.sessions)).toEqual(state)
  })

  test('withoutPaneKeys removes only the named pane keys', () => {
    const record = { first: 1, second: 2, third: 3 }

    expect(withoutPaneKeys(record, ['first', 'third', 'missing'])).toEqual({ second: 2 })
  })
})

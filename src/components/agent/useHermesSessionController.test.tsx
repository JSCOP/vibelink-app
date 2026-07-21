// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { normalizeSettings, defaultSettings } from '../../state/profiles'
import { useWorkspaceStore } from '../../state/store'
import { useHermesSessionController } from './useHermesSessionController'

describe('useHermesSessionController', () => {
  beforeEach(() => {
    useWorkspaceStore.setState({
      sessions: [{ id: 'workspace-a', name: 'Workspace A', paneCount: 0, createdAt: 1, workspaceFolder: 'E:/repo' }],
      activeSessionId: 'workspace-a',
      settings: normalizeSettings(defaultSettings),
      hermesStatus: { 'workspace-a': 'running' },
      hermesCurrentSession: { 'workspace-a': 'current-acp' },
      hermesSessions: {
        'workspace-a': [{ id: 'historical-acp', title: 'History', updatedAt: '2026-07-21T00:00:00.000Z', cwd: 'E:/repo' }],
      },
      hermesPermissions: {},
      error: undefined,
    })
  })

  afterEach(cleanup)

  test('injects the authoritative current session until the native list includes it', () => {
    const { result } = renderHook(() => useHermesSessionController())

    expect(result.current.currentSessionId).toBe('current-acp')
    expect(result.current.sessions).toEqual([
      { id: 'current-acp', title: null, updatedAt: null, cwd: 'E:/repo' },
      { id: 'historical-acp', title: 'History', updatedAt: '2026-07-21T00:00:00.000Z', cwd: 'E:/repo' },
    ])
    expect(result.current.workspaceName).toBe('Workspace A')
    expect(result.current.workspaceFolder).toBe('E:/repo')
  })

  test('blocks session-changing actions while Hermes is busy or starting', () => {
    useWorkspaceStore.setState({ hermesStatus: { 'workspace-a': 'busy' } })
    const { result, rerender } = renderHook(() => useHermesSessionController())
    expect(result.current.actionsDisabled).toBe(true)

    useWorkspaceStore.setState({ hermesStatus: { 'workspace-a': 'starting' } })
    rerender()
    expect(result.current.actionsDisabled).toBe(true)

    useWorkspaceStore.setState({ hermesStatus: { 'workspace-a': 'running' } })
    rerender()
    expect(result.current.actionsDisabled).toBe(false)
  })
})

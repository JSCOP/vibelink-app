import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LicenseStatus } from '../ipc/types'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command !== 'board_task_create') return null
    const now = Date.now()
    return {
      id: 'task-1',
      sessionId: String(args?.sessionId),
      title: String(args?.title),
      description: String(args?.description ?? ''),
      status: 'pending',
      statusTimestamps: { pending: now },
      createdAt: now,
      updatedAt: now,
    }
  }),
}))

import { authorizationErrorMessage, isAppLocked, isProEntitled, PRO_CONTENT_KINDS, requiresProContent } from './licenseGate'
import { useWorkspaceStore } from './store'

const unlicensed: LicenseStatus = {
  state: 'unlicensed',
  entitled: false,
  provider: null,
  maskedKey: null,
  activationId: null,
  deviceId: 'device',
  deviceName: 'Device',
  maxDevices: 3,
  devices: [],
  validatedAt: null,
  offlineGraceUntil: null,
  purchaseUrl: 'https://example.com/pricing',
  message: 'Activate Pro',
}

beforeEach(() => {
  useWorkspaceStore.setState({
    license: { ready: true, status: unlicensed },
    error: undefined,
    kanban: { tasks: {}, taskOrder: {} },
  })
})

describe('VibeLink Pro gates', () => {
  test('locks every Pro workspace content kind', async () => { expect(PRO_CONTENT_KINDS).toEqual(['browser', 'editor', 'explorer', 'workbench', 'agent', 'orchestration', 'kanban', 'todo', 'diff'])
  expect(requiresProContent('terminal')).toBe(false)
  for (const kind of PRO_CONTENT_KINDS) expect(requiresProContent(kind)).toBe(true) })

  test('rejects task creation after license bootstrap resolves unlicensed', async () => {
    await expect(useWorkspaceStore.getState().createTask('session-1', { title: 'Locked', description: '' }))
      .rejects.toThrow('VibeLink Pro license required.')
    expect(useWorkspaceStore.getState().kanban.taskOrder['session-1']).toBeUndefined()
    expect(useWorkspaceStore.getState().error).toBe('VibeLink Pro license required.')
  })

  test('allows task creation when Pro is entitled', async () => { useWorkspaceStore.setState({ license: { ready: true, status: { ...unlicensed, state: 'validOnline', entitled: true, provider: 'vibelink' } } })
  const task = await useWorkspaceStore.getState().createTask('session-1', { title: 'Allowed', description: '' })
  expect(task.title).toBe('Allowed') })

  test('isAppLocked is true only after status resolves without entitlement', () => {
    expect(isAppLocked(null)).toBe(false)
    expect(isAppLocked(undefined)).toBe(false)
    expect(isAppLocked(unlicensed)).toBe(true)
    expect(isAppLocked({ ...unlicensed, state: 'trialExpired', plan: 'none' })).toBe(true)
    const trial: LicenseStatus = { ...unlicensed, state: 'trial', entitled: true, plan: 'trial', email: 'trial@example.com', trialEndsAt: new Date(Date.now() + 6 * 86_400_000).toISOString() }
    expect(isAppLocked(trial)).toBe(false)
    expect(isProEntitled(trial)).toBe(true)
    const pro: LicenseStatus = { ...unlicensed, state: 'validOnline', entitled: true, plan: 'pro', provider: 'vibelink' }
    expect(isAppLocked(pro)).toBe(false)
    const development: LicenseStatus = { ...unlicensed, state: 'development', entitled: true, message: 'Development build' }
    expect(isAppLocked(development)).toBe(false)
    expect(isProEntitled(development)).toBe(true)
  })

  test('maps stable native authorization codes without leaking policy internals', () => {
    expect(authorizationErrorMessage('ENTITLEMENT_REQUIRED')).toContain('entitled Moobang account')
    expect(authorizationErrorMessage('AUTHORIZATION_STALE')).toContain('authorization expired')
    expect(authorizationErrorMessage('AUTH_REQUIRED')).toContain('background service')
    expect(authorizationErrorMessage('DAEMON_PROTOCOL_MISMATCH')).toContain('different versions')
    expect(authorizationErrorMessage('other failure')).toBe('other failure')
  })
})

import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { LicenseStatus } from '../ipc/types'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

import { PRO_WINDOW_KINDS, requiresProWindow } from './licenseGate'
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
  test('locks every non-terminal workspace window kind', () => {
    expect(PRO_WINDOW_KINDS).toEqual(['agent', 'kanban', 'todo', 'diff'])
    expect(requiresProWindow('terminal')).toBe(false)
    for (const kind of PRO_WINDOW_KINDS) expect(requiresProWindow(kind)).toBe(true)
  })

  test('rejects task creation after license bootstrap resolves unlicensed', () => {
    expect(() => useWorkspaceStore.getState().createTask('session-1', { title: 'Locked', description: '' })).toThrow('VibeLink Pro license required.')
    expect(useWorkspaceStore.getState().kanban.taskOrder['session-1']).toBeUndefined()
    expect(useWorkspaceStore.getState().error).toBe('VibeLink Pro license required.')
  })

  test('allows task creation when Pro is entitled', () => {
    useWorkspaceStore.setState({ license: { ready: true, status: { ...unlicensed, state: 'validOnline', entitled: true, provider: 'vibelink' } } })
    const task = useWorkspaceStore.getState().createTask('session-1', { title: 'Allowed', description: '' })
    expect(task.title).toBe('Allowed')
  })
})

import { invoke } from '@tauri-apps/api/core'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { cancelOwnedDeviceProcess, launchAndroidApp } from './deviceLab'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('crypto', { randomUUID: () => 'operation-uuid' })
})

describe('Device Lab IPC', () => {
  test('constructs typed launch requests without shell command strings', async () => {
    vi.mocked(invoke).mockResolvedValue({})
    await launchAndroidApp('C:/Android/Sdk', 'emulator-5554', 'com.example.app', '.MainActivity')
    expect(invoke).toHaveBeenCalledWith('device_lab_app_launch', {
      request: {
        operationId: 'launch-operation-uuid', sdkRoot: 'C:/Android/Sdk', serial: 'emulator-5554', package: 'com.example.app', activity: '.MainActivity', timeoutMs: 30_000,
      },
    })
  })

  test('cancellation carries both operation id and expected PID', async () => {
    vi.mocked(invoke).mockResolvedValue({})
    await cancelOwnedDeviceProcess({ operationId: 'scrcpy-1', kind: 'scrcpy', pid: 8123, executable: 'scrcpy.exe', args: [], startedAtMs: 1, running: true })
    expect(invoke).toHaveBeenCalledWith('device_lab_process_cancel', { request: { operationId: 'scrcpy-1', expectedPid: 8123 } })
  })
})

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { AndroidDeviceLabPanel } from './AndroidDeviceLabPanel'
import * as deviceLab from '../ipc/deviceLab'

vi.mock('../ipc/deviceLab', async () => {
  const actual = await vi.importActual<typeof deviceLab>('../ipc/deviceLab')
  return {
    ...actual,
    discoverAndroidSdk: vi.fn(),
    listAdbDevices: vi.fn(),
    listAvds: vi.fn(),
    startAvd: vi.fn(),
    cancelOwnedDeviceProcess: vi.fn(),
    getAccessibilityStatus: vi.fn(),
    readLogcat: vi.fn(),
    startScrcpy: vi.fn(),
  }
})

afterEach(cleanup)

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(deviceLab.discoverAndroidSdk).mockResolvedValue({
    available: true, root: 'C:/Android/Sdk', adbPath: 'C:/Android/Sdk/platform-tools/adb.exe', emulatorPath: 'C:/Android/Sdk/emulator/emulator.exe', avdManagerPath: null, sdkManagerPath: null, scrcpyPath: 'C:/tools/scrcpy.exe', source: 'ANDROID_SDK_ROOT', missing: [],
  })
  vi.mocked(deviceLab.listAdbDevices).mockResolvedValue([{ serial: 'emulator-5554', state: 'device', product: 'sdk', model: 'Pixel_9', device: 'emu', transportId: '1' }])
  vi.mocked(deviceLab.listAvds).mockResolvedValue(['Pixel_9_API_36'])
  vi.mocked(deviceLab.startAvd).mockResolvedValue({ operationId: 'avd-owned', kind: 'avd', pid: 4242, executable: 'emulator.exe', args: ['-avd', 'Pixel_9_API_36'], startedAtMs: 1, running: true })
  vi.mocked(deviceLab.cancelOwnedDeviceProcess).mockImplementation(async (process) => ({ ...process, running: false }))
})

describe('AndroidDeviceLabPanel', () => {
  test('discovers SDK/devices and stops only the exact owned PID', async () => {
    render(<AndroidDeviceLabPanel />)
    expect(await screen.findByText('SDK ready')).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Pixel_9 · device' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Start$/ }))
    expect(await screen.findByText('avd · PID 4242')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Stop exact PID/ }))
    await waitFor(() => expect(deviceLab.cancelOwnedDeviceProcess).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'avd-owned', pid: 4242 })))
    expect(screen.queryByText('avd · PID 4242')).toBeNull()
  })
})

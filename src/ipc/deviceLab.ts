import { invoke } from '@tauri-apps/api/core'

export type SdkDiscovery = {
  available: boolean
  root: string | null
  adbPath: string | null
  emulatorPath: string | null
  avdManagerPath: string | null
  sdkManagerPath: string | null
  scrcpyPath: string | null
  source: string | null
  missing: string[]
}

export type AdbDevice = {
  serial: string
  state: string
  product: string | null
  model: string | null
  device: string | null
  transportId: string | null
}

export type CommandOutput = {
  operationId: string
  executable: string
  args: string[]
  exitCode: number | null
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
  durationMs: number
}

export type OwnedProcessInfo = {
  operationId: string
  kind: string
  pid: number
  executable: string
  args: string[]
  startedAtMs: number
  running: boolean
}

export type AccessibilityStatus = { enabled: boolean; services: string[] }

export const deviceLabOperationId = (kind: string): string => `${kind}-${crypto.randomUUID()}`

export async function discoverAndroidSdk(sdkRoot?: string): Promise<SdkDiscovery> {
  return invoke<SdkDiscovery>('device_lab_sdk_discover', { sdkRoot: sdkRoot?.trim() || null })
}

export async function listAdbDevices(sdkRoot?: string): Promise<AdbDevice[]> {
  return invoke<AdbDevice[]>('device_lab_adb_devices', { request: { operationId: deviceLabOperationId('adb-devices'), sdkRoot: sdkRoot?.trim() || null, timeoutMs: 15_000 } })
}

export async function listAvds(sdkRoot?: string): Promise<string[]> {
  return invoke<string[]>('device_lab_avd_list', { request: { operationId: deviceLabOperationId('avd-list'), sdkRoot: sdkRoot?.trim() || null, timeoutMs: 15_000 } })
}

export async function startAvd(sdkRoot: string | undefined, avdName: string, coldBoot = false): Promise<OwnedProcessInfo> {
  return invoke<OwnedProcessInfo>('device_lab_avd_start', { request: { operationId: deviceLabOperationId('avd'), sdkRoot: sdkRoot?.trim() || null, avdName, coldBoot, wipeData: false, noWindow: false, writableSystem: false, port: null } })
}

export async function installApk(sdkRoot: string | undefined, serial: string, apkPath: string): Promise<CommandOutput> {
  return invoke<CommandOutput>('device_lab_apk_install', { request: { operationId: deviceLabOperationId('install'), sdkRoot: sdkRoot?.trim() || null, serial, apkPath, replace: true, allowDowngrade: false, timeoutMs: 120_000 } })
}

export async function launchAndroidApp(sdkRoot: string | undefined, serial: string, packageName: string, activity?: string): Promise<CommandOutput> {
  return invoke<CommandOutput>('device_lab_app_launch', { request: { operationId: deviceLabOperationId('launch'), sdkRoot: sdkRoot?.trim() || null, serial, package: packageName, activity: activity?.trim() || null, timeoutMs: 30_000 } })
}

export async function changeAndroidPermission(sdkRoot: string | undefined, serial: string, packageName: string, permission: string, action: 'grant' | 'revoke'): Promise<CommandOutput> {
  return invoke<CommandOutput>('device_lab_permission_change', { request: { operationId: deviceLabOperationId('permission'), sdkRoot: sdkRoot?.trim() || null, serial, package: packageName, permission, action, timeoutMs: 30_000 } })
}

export async function getAccessibilityStatus(sdkRoot: string | undefined, serial: string): Promise<AccessibilityStatus> {
  return invoke<AccessibilityStatus>('device_lab_accessibility_status', { request: { operationId: deviceLabOperationId('accessibility'), sdkRoot: sdkRoot?.trim() || null, serial, timeoutMs: 30_000 } })
}

export async function readLogcat(sdkRoot: string | undefined, serial: string, maxLines = 2_000): Promise<CommandOutput> {
  return invoke<CommandOutput>('device_lab_logcat', { request: { operationId: deviceLabOperationId('logcat'), sdkRoot: sdkRoot?.trim() || null, serial, pid: null, maxLines, filters: [], timeoutMs: 30_000 } })
}

export async function startScrcpy(sdkRoot: string | undefined, serial: string): Promise<OwnedProcessInfo> {
  return invoke<OwnedProcessInfo>('device_lab_scrcpy_start', { request: { operationId: deviceLabOperationId('scrcpy'), sdkRoot: sdkRoot?.trim() || null, scrcpyPath: null, serial, maxSize: 1920, videoBitRate: '8M', stayAwake: true, turnScreenOff: false, noAudio: false } })
}

export async function cancelOwnedDeviceProcess(process: OwnedProcessInfo): Promise<OwnedProcessInfo> {
  return invoke<OwnedProcessInfo>('device_lab_process_cancel', { request: { operationId: process.operationId, expectedPid: process.pid } })
}

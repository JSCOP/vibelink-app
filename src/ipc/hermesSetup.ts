import { invoke } from '@tauri-apps/api/core'
import type { HermesRuntimeStatus } from './types'

export async function installHermesRuntime(commandOverride?: string | null): Promise<{ command: string; status: HermesRuntimeStatus }> {
  const command = await invoke<string>('hermes_install_runtime')
  const status = await getHermesRuntimeStatus(commandOverride)
  return { command, status }
}

export function getHermesRuntimeStatus(commandOverride?: string | null): Promise<HermesRuntimeStatus> {
  return invoke<HermesRuntimeStatus>('hermes_runtime_status', { commandOverride: commandOverride || null })
}

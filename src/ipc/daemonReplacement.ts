import { invoke } from '@tauri-apps/api/core'

export type DaemonReplacement = {
  fromVersion: string | null
  toVersion: string
  terminatedPanes: number
}

export function takeDaemonReplacement(): Promise<DaemonReplacement | null> {
  return invoke<DaemonReplacement | null>('take_daemon_replacement')
}

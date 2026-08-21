import { invoke } from '@tauri-apps/api/core'

/** A running daemon whose behaviour predates this build. */
export type DaemonRestartRequest = {
  fromVersion: string | null
  toVersion: string
}

/** Reads the standing offer without consuming it, so declining is not final. */
export function pendingDaemonRestart(): Promise<DaemonRestartRequest | null> {
  return invoke<DaemonRestartRequest | null>('pending_daemon_restart')
}

export function restartDaemon(): Promise<void> {
  return invoke<void>('restart_daemon')
}

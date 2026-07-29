import { invoke } from '@tauri-apps/api/core'

export type AppUpdateStatus = {
  currentVersion: string
  latestVersion: string
  updateAvailable: boolean
  releaseNotesUrl: string
  installUrl: string
}

export function checkAppUpdate(): Promise<AppUpdateStatus> {
  return invoke<AppUpdateStatus>('app_update_check')
}

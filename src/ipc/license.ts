import { invoke } from '@tauri-apps/api/core'
import type { LicenseStatus } from './types'

export type AccountSignInStart = {
  userCode: string
  verificationUriComplete: string
  deviceCode: string
  interval: number
}

export function getLicenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_status')
}

export function startAccountSignIn(): Promise<AccountSignInStart> {
  return invoke<AccountSignInStart>('account_sign_in_start')
}

export function pollAccountSignIn(deviceCode: string): Promise<LicenseStatus | 'pending'> {
  return invoke<LicenseStatus | 'pending'>('account_sign_in_poll', { deviceCode })
}

export function signOutAccount(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('account_sign_out')
}

export function revalidateLicense(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_revalidate')
}

export function deactivateLicenseDevice(activationId: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_deactivate_device', { activationId })
}

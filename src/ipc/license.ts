import { invoke } from '@tauri-apps/api/core'
import type { LicenseStatus } from './types'

export function getLicenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_status')
}

export function activateLicense(licenseKey: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_activate', { licenseKey })
}

export function revalidateLicense(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_revalidate')
}

export function deactivateLicenseDevice(activationId: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_deactivate_device', { activationId })
}

export function forgetLocalLicense(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>('license_forget_local')
}

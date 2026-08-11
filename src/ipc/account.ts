import { invoke } from '@tauri-apps/api/core'
import type { AccountStatus } from './types'

export type AccountSignInStart = { userCode: string; verificationUriComplete: string; deviceCode: string; interval: number }

export function getAccountStatus(): Promise<AccountStatus> {
  return invoke<AccountStatus>('account_status')
}

export function startAccountSignIn(): Promise<AccountSignInStart> {
  return invoke<AccountSignInStart>('account_sign_in_start')
}

export function pollAccountSignIn(deviceCode: string): Promise<AccountStatus | 'pending'> {
  return invoke<AccountStatus | 'pending'>('account_sign_in_poll', { deviceCode })
}

export function signOutAccount(): Promise<AccountStatus> {
  return invoke<AccountStatus>('account_sign_out')
}

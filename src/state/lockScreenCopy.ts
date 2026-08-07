import type { LicenseState } from '../ipc/types'

export const APP_LOCK_REASONS = [
  'unlicensed',
  'trialExpired',
  'activationLimit',
  'reviewRequired',
  'invalid',
  'revoked',
  'configurationError',
] as const satisfies readonly LicenseState[]

export type AppLockReason = typeof APP_LOCK_REASONS[number]
export type LockScreenActionKind = 'signIn' | 'purchase' | 'refresh' | 'switchAccount'

export type LockScreenAction = {
  label: string
  kind: LockScreenActionKind
  available: boolean
  unavailableReason?: string
}

export type LockScreenCopy = {
  heading: string
  body: string
  primary: LockScreenAction
  secondary: LockScreenAction | null
}

const refreshAction: LockScreenAction = { label: 'Refresh account', kind: 'refresh', available: true }
const switchAccountAction: LockScreenAction = { label: 'Switch account', kind: 'switchAccount', available: true }

function purchaseAction(available: boolean): LockScreenAction {
  return available
    ? { label: 'Buy VibeLink', kind: 'purchase', available: true }
    : {
        label: 'Buy VibeLink',
        kind: 'purchase',
        available: false,
        unavailableReason: 'Purchase is unavailable because no checkout URL is configured.',
      }
}

export function appLockReason(state: LicenseState | null | undefined): AppLockReason {
  switch (state) {
    case 'unlicensed':
    case 'trialExpired':
    case 'activationLimit':
    case 'reviewRequired':
    case 'invalid':
    case 'revoked':
    case 'configurationError':
      return state
    default:
      return 'invalid'
  }
}

export function lockScreenCopy(reason: AppLockReason, purchaseAvailable: boolean): LockScreenCopy {
  switch (reason) {
    case 'unlicensed':
      return {
        heading: 'Sign in required',
        body: 'VibeLink is locked because no Moobang account is signed in. Sign in to continue.',
        primary: { label: 'Sign in with Moobang account', kind: 'signIn', available: true },
        secondary: null,
      }
    case 'trialExpired':
      return {
        heading: 'Your VibeLink trial has ended',
        body: 'VibeLink is locked because the trial ended. Your workspaces remain saved. Purchase VibeLink to continue.',
        primary: purchaseAction(purchaseAvailable),
        secondary: refreshAction,
      }
    case 'activationLimit':
      return {
        heading: 'This device cannot be activated',
        body: 'VibeLink is locked on this device because the account has no available activation slots. Switch to another account to continue.',
        primary: switchAccountAction,
        secondary: refreshAction,
      }
    case 'reviewRequired':
      return {
        heading: 'Account review required',
        body: 'VibeLink is locked while this account or device needs review. Refresh the account after the review is resolved.',
        primary: refreshAction,
        secondary: switchAccountAction,
      }
    case 'invalid':
      return {
        heading: 'Account validation required',
        body: 'VibeLink is locked because account validation failed. Check the internet connection and system clock, then refresh the account.',
        primary: refreshAction,
        secondary: switchAccountAction,
      }
    case 'revoked':
      return {
        heading: 'VibeLink access was revoked',
        body: 'VibeLink is locked because this account no longer has access. Switch to another account to continue.',
        primary: switchAccountAction,
        secondary: refreshAction,
      }
    case 'configurationError':
      return {
        heading: 'Account status is unavailable',
        body: 'VibeLink is locked because account status could not be loaded. Check the internet connection, then refresh the account.',
        primary: refreshAction,
        secondary: switchAccountAction,
      }
  }
}

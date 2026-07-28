import type { WorkspaceContentKind } from '../layout/workspaceContentModel'
import type { LicenseStatus } from '../ipc/types'

export const PRO_CONTENT_KINDS: readonly WorkspaceContentKind[] = ['browser', 'editor', 'explorer', 'workbench', 'agent', 'orchestration', 'kanban', 'todo', 'diff']

export function isProEntitled(status: LicenseStatus | null | undefined): boolean {
  return Boolean(status?.entitled)
}

/**
 * Full app lock: once the license status is resolved, the entire workspace is
 * locked whenever the account is not entitled. This covers signed-out
 * (`unlicensed`), expired trials (`trialExpired`), revoked/invalid, and clock
 * rollback. An active trial keeps `entitled: true`, so it is never locked.
 */
export function isAppLocked(status: LicenseStatus | null | undefined): boolean {
  return Boolean(status && !status.entitled)
}

export function requiresProContent(kind: WorkspaceContentKind): boolean {
  return PRO_CONTENT_KINDS.includes(kind)
}

export function authorizationErrorMessage(error: unknown): string {
  const text = String(error)
  if (text.includes('ENTITLEMENT_REQUIRED')) return 'Sign in to an entitled Moobang account to continue.'
  if (text.includes('AUTHORIZATION_STALE')) return 'VibeLink authorization expired. Reconnect to validate your account.'
  if (text.includes('AUTH_REQUIRED')) return 'VibeLink could not authenticate the local background service.'
  if (text.includes('DAEMON_PROTOCOL_MISMATCH')) return 'VibeLink and its background service are different versions. Restart VibeLink.'
  return text
}

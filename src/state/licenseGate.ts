import type { WorkspaceWindowKind } from '../layout/workspaceLayoutModel'
import type { LicenseStatus } from '../ipc/types'

export const PRO_WINDOW_KINDS: readonly WorkspaceWindowKind[] = ['agent', 'kanban', 'todo', 'diff']

export function isProEntitled(status: LicenseStatus | null | undefined): boolean {
  return Boolean(status?.entitled)
}

export function requiresProWindow(kind: WorkspaceWindowKind): boolean {
  return PRO_WINDOW_KINDS.includes(kind)
}

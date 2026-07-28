import { orchestrationRequest } from './orchestration'

export type NotificationRecord = {
  id: string
  sequence: number
  kind: string
  entityId: string | null
  unread: boolean
  acknowledgedAt: number | null
  payload: Record<string, unknown>
  createdAt: number
}

export type AutomationNotificationPayload = {
  sessionId: string
  automationId: string
  automationName: string
  automationRunId: string
  status: string
  worktreePath: string | null
  branch: string | null
  outputSummary: string | null
  error: string | null
}

export function catchupNotifications(afterSequence: number, limit = 200): Promise<NotificationRecord[]> {
  return orchestrationRequest('notifications.catchup', { afterSequence, limit })
}

export function acknowledgeNotification(id: string): Promise<NotificationRecord> {
  return orchestrationRequest('notification.acknowledge', { id })
}

export function automationNotificationPayload(notification: NotificationRecord): AutomationNotificationPayload | null {
  if (!notification.kind.startsWith('automation.')) return null
  const payload = notification.payload
  const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : null
  const automationId = typeof payload.automationId === 'string' ? payload.automationId : null
  const automationName = typeof payload.automationName === 'string' ? payload.automationName : null
  const automationRunId = typeof payload.automationRunId === 'string' ? payload.automationRunId : null
  const status = typeof payload.status === 'string' ? payload.status : null
  if (!sessionId || !automationId || !automationName || !automationRunId || !status) return null
  return {
    sessionId,
    automationId,
    automationName,
    automationRunId,
    status,
    worktreePath: typeof payload.worktreePath === 'string' ? payload.worktreePath : null,
    branch: typeof payload.branch === 'string' ? payload.branch : null,
    outputSummary: typeof payload.outputSummary === 'string' ? payload.outputSummary : null,
    error: typeof payload.error === 'string' ? payload.error : null,
  }
}

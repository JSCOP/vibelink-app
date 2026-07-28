import { useCallback, useEffect, useRef, useState } from 'react'
import { Bell, CheckCircle2, Clock3, X, XCircle } from 'lucide-react'
import {
  acknowledgeNotification,
  automationNotificationPayload,
  catchupNotifications,
  type AutomationNotificationPayload,
  type NotificationRecord,
} from '../../ipc/notifications'
import '../../styles/notifications.css'

type NotificationCenterProps = {
  onOpenAutomation: (payload: AutomationNotificationPayload) => Promise<void>
}

type NotificationToast = {
  id: string
  notification: NotificationRecord
  payload: AutomationNotificationPayload
}

function notificationTitle(notification: NotificationRecord): string {
  const payload = automationNotificationPayload(notification)
  if (payload) {
    if (notification.kind === 'automation.completed') return `${payload.automationName} completed`
    if (notification.kind === 'automation.cancelled') return `${payload.automationName} cancelled`
    return `${payload.automationName} failed`
  }
  return notification.kind.replaceAll('.', ' ')
}

function notificationMessage(notification: NotificationRecord): string {
  const payload = automationNotificationPayload(notification)
  if (!payload) return 'Open notification details.'
  return payload.outputSummary || payload.error || `Run ${payload.status.replaceAll('_', ' ')}.`
}

function relativeTime(createdAt: number): string {
  const elapsed = Math.max(0, Date.now() - createdAt)
  if (elapsed < 60_000) return 'now'
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`
  return `${Math.floor(elapsed / 86_400_000)}d`
}

export function NotificationCenter({ onOpenAutomation }: NotificationCenterProps) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const latestSequence = useRef(0)
  const initialized = useRef(false)
  const loading = useRef(false)
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationRecord[]>([])
  const [toasts, setToasts] = useState<NotificationToast[]>([])
  const [error, setError] = useState<string | null>(null)

  const catchup = useCallback(async () => {
    if (loading.current) return
    loading.current = true
    try {
      const received: NotificationRecord[] = []
      let after = latestSequence.current
      for (;;) {
        const page = await catchupNotifications(after, 500)
        if (page.length === 0) break
        received.push(...page)
        after = Math.max(after, ...page.map((notification) => notification.sequence))
        if (page.length < 500) break
      }
      latestSequence.current = after
      if (received.length > 0) {
        setNotifications((current) => {
          const byId = new Map(current.map((notification) => [notification.id, notification]))
          received.forEach((notification) => byId.set(notification.id, notification))
          return Array.from(byId.values()).sort((left, right) => right.sequence - left.sequence).slice(0, 150)
        })
        if (initialized.current) {
          const newToasts = received.flatMap((notification) => {
            const payload = automationNotificationPayload(notification)
            return payload ? [{ id: notification.id, notification, payload }] : []
          })
          if (newToasts.length > 0) setToasts((current) => [...current, ...newToasts].slice(-4))
        }
      }
      initialized.current = true
      setError(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      loading.current = false
    }
  }, [])

  useEffect(() => {
    // Async daemon catch-up: every setState lands after an await, in a later
    // task, so this is a subscription rather than a render cascade.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void catchup()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void catchup()
    }, 5_000)
    const refresh = () => void catchup()
    window.addEventListener('focus', refresh)
    window.addEventListener('online', refresh)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refresh)
      window.removeEventListener('online', refresh)
    }
  }, [catchup])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false)
    }
    window.addEventListener('pointerdown', closeOutside, true)
    return () => window.removeEventListener('pointerdown', closeOutside, true)
  }, [open])

  useEffect(() => {
    if (toasts.length === 0) return
    const timer = window.setTimeout(() => setToasts((current) => current.slice(1)), 6_000)
    return () => window.clearTimeout(timer)
  }, [toasts])

  const activate = async (notification: NotificationRecord) => {
    const payload = automationNotificationPayload(notification)
    if (notification.unread) {
      try {
        const acknowledged = await acknowledgeNotification(notification.id)
        setNotifications((current) => current.map((item) => item.id === acknowledged.id ? acknowledged : item))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    }
    if (payload) {
      setOpen(false)
      await onOpenAutomation(payload)
    }
  }

  const unreadCount = notifications.filter((notification) => notification.unread).length
  return (
    <div ref={rootRef} className="notification-center">
      <button type="button" className="topbar-icon-button notification-bell" title="Notifications" aria-label="Open notifications" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Bell size={16} aria-hidden="true" />
        {unreadCount > 0 ? <span className="notification-badge">{unreadCount > 99 ? '99+' : unreadCount}</span> : null}
      </button>
      {open ? <section className="notification-popover" aria-label="Notifications">
        <header><div><strong>Notifications</strong><span>{unreadCount} unread</span></div><button type="button" aria-label="Close notifications" onClick={() => setOpen(false)}><X size={14} /></button></header>
        <div className="notification-list">
          {notifications.length === 0 ? <div className="notification-empty"><Clock3 size={22} />No notifications.</div> : notifications.map((notification) => {
            const successful = notification.kind === 'automation.completed'
            return <button key={notification.id} type="button" className={`notification-item${notification.unread ? ' unread' : ''}`} onClick={() => void activate(notification)}>
              <span className={`notification-icon ${successful ? 'success' : 'failure'}`}>{successful ? <CheckCircle2 size={15} /> : <XCircle size={15} />}</span>
              <span className="notification-item-copy"><strong>{notificationTitle(notification)}</strong><span>{notificationMessage(notification)}</span></span>
              <time>{relativeTime(notification.createdAt)}</time>
            </button>
          })}
        </div>
        {error ? <div className="notification-error">{error}</div> : null}
      </section> : null}
      <div className="notification-toast-stack" aria-live="polite">
        {toasts.map((toast) => <div key={toast.id} className={`notification-toast ${toast.notification.kind === 'automation.completed' ? 'success' : 'failure'}`}>
          <button type="button" className="notification-toast-main" onClick={() => void activate(toast.notification)}>
            {toast.notification.kind === 'automation.completed' ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
            <span><strong>{notificationTitle(toast.notification)}</strong><small>{notificationMessage(toast.notification)}</small></span>
          </button>
          <button type="button" className="notification-toast-dismiss" aria-label="Dismiss notification" onClick={() => setToasts((current) => current.filter((item) => item.id !== toast.id))}><X size={13} /></button>
        </div>)}
      </div>
    </div>
  )
}

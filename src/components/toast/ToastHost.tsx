import { useCallback, useEffect, useRef, useSyncExternalStore, type FocusEvent } from 'react'
import { createPortal } from 'react-dom'
import { CircleAlert, CheckCircle2, Info, X } from 'lucide-react'
import { dismissToast, getToastSnapshot, subscribeToasts, type ToastItem } from './toastStore'
import './toast.css'

export function ToastHost() {
  const toasts = useSyncExternalStore(subscribeToasts, getToastSnapshot, getToastSnapshot)
  if (typeof document === 'undefined' || toasts.length === 0) return null

  return createPortal(
    <div className="vibelink-toast-host" role="region" aria-label="Notifications">
      {toasts.map((item) => <ToastView key={item.id} item={item} />)}
    </div>,
    document.body,
  )
}

function ToastView({ item }: { item: ToastItem }) {
  const timerRef = useRef<number | null>(null)
  const startedAtRef = useRef<number | null>(null)
  const remainingMsRef = useRef(item.durationMs)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startedAtRef.current = null
  }, [])

  const resumeTimer = useCallback(() => {
    clearTimer()
    if (remainingMsRef.current <= 0) {
      dismissToast(item.id)
      return
    }
    startedAtRef.current = Date.now()
    timerRef.current = window.setTimeout(() => dismissToast(item.id), remainingMsRef.current)
  }, [clearTimer, item.id])

  const pauseTimer = useCallback(() => {
    if (startedAtRef.current !== null) {
      remainingMsRef.current = Math.max(0, remainingMsRef.current - (Date.now() - startedAtRef.current))
    }
    clearTimer()
  }, [clearTimer])

  useEffect(() => {
    resumeTimer()
    return clearTimer
  }, [clearTimer, resumeTimer])

  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) resumeTimer()
  }
  const Icon = item.kind === 'success' ? CheckCircle2 : item.kind === 'error' ? CircleAlert : Info

  return (
    <section
      className={`vibelink-toast vibelink-toast-${item.kind}`}
      role={item.kind === 'error' ? 'alert' : 'status'}
      aria-live={item.kind === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
      onFocusCapture={pauseTimer}
      onBlurCapture={onBlur}
    >
      <Icon className="vibelink-toast-icon" size={17} aria-hidden="true" />
      <p className="vibelink-toast-message">{item.message}</p>
      {item.actionLabel && item.onAction ? (
        <button
          type="button"
          className="vibelink-toast-action"
          onClick={() => {
            try {
              item.onAction?.()
            } finally {
              dismissToast(item.id)
            }
          }}
        >
          {item.actionLabel}
        </button>
      ) : null}
      <button type="button" className="vibelink-toast-dismiss" aria-label="Dismiss notification" onClick={() => dismissToast(item.id)}>
        <X size={14} aria-hidden="true" />
      </button>
    </section>
  )
}

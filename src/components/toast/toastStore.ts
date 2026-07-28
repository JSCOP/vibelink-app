export type ToastKind = 'success' | 'info' | 'error'

export type ToastOptions = {
  actionLabel?: string
  onAction?: () => void
  durationMs?: number
}

export type ToastItem = {
  id: number
  kind: ToastKind
  message: string
  actionLabel?: string
  onAction?: () => void
  durationMs: number
}

const MAX_VISIBLE_TOASTS = 3
const DEFAULT_DURATION_MS = 4_000
const ERROR_DURATION_MS = 6_000

const queue: ToastItem[] = []
const listeners = new Set<() => void>()
let visibleToasts: ToastItem[] = []
let nextToastId = 1

function publish(): void {
  const nextVisible = queue.slice(0, MAX_VISIBLE_TOASTS)
  if (
    nextVisible.length === visibleToasts.length
    && nextVisible.every((item, index) => item === visibleToasts[index])
  ) return
  visibleToasts = nextVisible
  for (const listener of listeners) listener()
}

function enqueueToast(kind: ToastKind, message: string, options: ToastOptions = {}): number {
  const defaultDuration = kind === 'error' ? ERROR_DURATION_MS : DEFAULT_DURATION_MS
  const requestedDuration = options.durationMs ?? defaultDuration
  const durationMs = Number.isFinite(requestedDuration) ? Math.max(0, requestedDuration) : defaultDuration
  const actionLabel = options.actionLabel?.trim()
  const item: ToastItem = {
    id: nextToastId++,
    kind,
    message,
    durationMs,
    ...(actionLabel && options.onAction ? { actionLabel, onAction: options.onAction } : {}),
  }
  queue.push(item)
  publish()
  return item.id
}

export const toast = {
  success(message: string, options?: ToastOptions): number {
    return enqueueToast('success', message, options)
  },
  info(message: string, options?: ToastOptions): number {
    return enqueueToast('info', message, options)
  },
  error(message: string, options?: ToastOptions): number {
    return enqueueToast('error', message, options)
  },
}

export function dismissToast(id: number): void {
  const index = queue.findIndex((item) => item.id === id)
  if (index < 0) return
  queue.splice(index, 1)
  publish()
}

export function clearToasts(): void {
  if (queue.length === 0) return
  queue.length = 0
  publish()
}

export function subscribeToasts(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getToastSnapshot(): ToastItem[] {
  return visibleToasts
}

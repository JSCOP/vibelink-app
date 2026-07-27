/** In-app replacement for `window.confirm` / `window.prompt`.
 *
 *  WebView2 renders native dialogs as an OS-styled `localhost:1420의 메시지`
 *  bar pinned to the top of the window: it is unthemeable, breaks the frameless
 *  app chrome, and blocks the whole WebView. Every confirmation/entry flow
 *  therefore goes through this imperative queue — callers stay plain async
 *  functions, and `AppDialogHost` (mounted once by `App`) renders the head of
 *  the queue with VibeLink's own dialog styling. Requests are FIFO, so two
 *  overlapping asks never stack on screen.
 *
 *  This module is deliberately view-free so non-React modules (the editor
 *  document store, controllers) can raise a dialog without importing JSX. */

export type AppDialogChoice = { id: string; label: string; tone?: 'primary' | 'danger' }

type BaseRequest = { id: number; title: string; message: string | null }

export type ConfirmRequest = BaseRequest & {
  kind: 'confirm'
  confirmLabel: string
  cancelLabel: string
  danger: boolean
  resolve: (value: boolean) => void
}

export type PromptRequest = BaseRequest & {
  kind: 'prompt'
  label: string | null
  placeholder: string | null
  defaultValue: string
  confirmLabel: string
  cancelLabel: string
  resolve: (value: string | null) => void
}

export type ChoiceRequest = BaseRequest & {
  kind: 'choice'
  choices: AppDialogChoice[]
  cancelLabel: string
  resolve: (value: string | null) => void
}

export type AppDialogRequest = ConfirmRequest | PromptRequest | ChoiceRequest

const queue: AppDialogRequest[] = []
const listeners = new Set<() => void>()
let current: AppDialogRequest | null = null
let nextRequestId = 1

function publish(): void {
  const next = queue[0] ?? null
  if (next === current) return
  current = next
  for (const listener of listeners) listener()
}

function enqueue<T>(build: (id: number, resolve: (value: T) => void) => AppDialogRequest, cancelled: T): Promise<T> {
  // No document means no host is mounted (unit tests, the capture overlay
  // window): resolve as cancelled instead of hanging the caller forever.
  if (typeof document === 'undefined') return Promise.resolve(cancelled)
  return new Promise<T>((resolve) => {
    queue.push(build(nextRequestId++, resolve))
    publish()
  })
}

export function settleAppDialog(request: AppDialogRequest, value: boolean | string | null): void {
  const index = queue.indexOf(request)
  if (index < 0) return
  queue.splice(index, 1)
  publish()
  ;(request.resolve as (settled: typeof value) => void)(value)
}

export function subscribeAppDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getAppDialogRequest(): AppDialogRequest | null {
  return current
}

/** True while a dialog owns the app. Global capture-phase key handlers must
 *  early-return on this so workspace shortcuts do not fire behind it. */
export function isAppDialogOpen(): boolean {
  return current !== null
}

export function confirmDialog(options: {
  title: string
  message?: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}): Promise<boolean> {
  return enqueue<boolean>((id, resolve) => ({
    kind: 'confirm',
    id,
    title: options.title,
    message: options.message ?? null,
    confirmLabel: options.confirmLabel ?? 'Confirm',
    cancelLabel: options.cancelLabel ?? 'Cancel',
    danger: options.danger ?? false,
    resolve,
  }), false)
}

/** Resolves to the trimmed entry, or `null` when cancelled or left empty. */
export function promptDialog(options: {
  title: string
  message?: string
  label?: string
  placeholder?: string
  defaultValue?: string
  confirmLabel?: string
  cancelLabel?: string
}): Promise<string | null> {
  return enqueue<string | null>((id, resolve) => ({
    kind: 'prompt',
    id,
    title: options.title,
    message: options.message ?? null,
    label: options.label ?? null,
    placeholder: options.placeholder ?? null,
    defaultValue: options.defaultValue ?? '',
    confirmLabel: options.confirmLabel ?? 'OK',
    cancelLabel: options.cancelLabel ?? 'Cancel',
    resolve,
  }), null)
}

/** Three-plus-way ask (e.g. Save / Discard / Cancel). Resolves to the chosen
 *  `AppDialogChoice.id`, or `null` when cancelled. */
export function choiceDialog(options: {
  title: string
  message?: string
  choices: AppDialogChoice[]
  cancelLabel?: string
}): Promise<string | null> {
  return enqueue<string | null>((id, resolve) => ({
    kind: 'choice',
    id,
    title: options.title,
    message: options.message ?? null,
    choices: options.choices,
    cancelLabel: options.cancelLabel ?? 'Cancel',
    resolve,
  }), null)
}

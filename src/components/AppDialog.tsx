import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertTriangle } from 'lucide-react'
import {
  getAppDialogRequest,
  settleAppDialog,
  subscribeAppDialog,
  type AppDialogRequest,
} from './appDialogStore'

/** Renders the head of the `appDialogStore` queue as a VibeLink-styled modal.
 *  Mounted once by `App`; see `appDialogStore` for why native dialogs are
 *  banned. */
export function AppDialogHost() {
  const request = useSyncExternalStore(subscribeAppDialog, getAppDialogRequest, () => null)
  if (!request || typeof document === 'undefined') return null
  return createPortal(<AppDialogView key={request.id} request={request} />, document.body)
}

function AppDialogView({ request }: { request: AppDialogRequest }) {
  const dialogRef = useRef<HTMLElement | null>(null)
  const [value, setValue] = useState(request.kind === 'prompt' ? request.defaultValue : '')
  const cancel = useCallback(() => settleAppDialog(request, request.kind === 'confirm' ? false : null), [request])

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Own the keyboard while the dialog is up: workspace/pane shortcuts listen
    // on window in the capture phase, so an unswallowed Escape or Ctrl+N would
    // still reach the workspace behind the modal.
    const onKeyDown = (event: KeyboardEvent) => {
      event.stopImmediatePropagation()
      const dialog = dialogRef.current
      if (event.key === 'Escape') {
        event.preventDefault()
        cancel()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'))
      if (focusable.length === 0) {
        event.preventDefault()
        dialog.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (!(active instanceof Node) || !dialog.contains(active)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      } else if (event.shiftKey && active === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown, true)
      if (previouslyFocused?.isConnected) previouslyFocused.focus()
    }
  }, [cancel])

  const submitPrompt = (event: FormEvent) => {
    event.preventDefault()
    const trimmed = value.trim()
    settleAppDialog(request, trimmed.length > 0 ? trimmed : null)
  }

  const titleId = `app-dialog-title-${request.id}`
  const danger = request.kind === 'confirm' && request.danger
  return (
    <div className="app-dialog-backdrop" role="presentation" onMouseDown={cancel}>
      <section
        ref={dialogRef}
        className={`app-dialog${danger ? ' app-dialog-danger' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="app-dialog-header">
          {danger ? <AlertTriangle size={16} aria-hidden="true" /> : null}
          <h2 id={titleId}>{request.title}</h2>
        </header>
        {request.message ? <p className="app-dialog-message">{request.message}</p> : null}
        {request.kind === 'prompt' ? (
          <form className="app-dialog-form" onSubmit={submitPrompt}>
            <label className="app-dialog-field">
              {request.label ? <span>{request.label}</span> : null}
              <input
                autoFocus
                value={value}
                placeholder={request.placeholder ?? undefined}
                aria-label={request.label ?? request.title}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>
            <footer className="app-dialog-actions">
              <button type="button" onClick={cancel}>{request.cancelLabel}</button>
              <button type="submit" className="primary-action" disabled={value.trim().length === 0}>{request.confirmLabel}</button>
            </footer>
          </form>
        ) : null}
        {request.kind === 'confirm' ? (
          <footer className="app-dialog-actions">
            <button type="button" onClick={cancel}>{request.cancelLabel}</button>
            <button
              type="button"
              autoFocus
              className={danger ? 'app-dialog-danger-action' : 'primary-action'}
              onClick={() => settleAppDialog(request, true)}
            >
              {request.confirmLabel}
            </button>
          </footer>
        ) : null}
        {request.kind === 'choice' ? (
          <footer className="app-dialog-actions">
            <button type="button" onClick={cancel}>{request.cancelLabel}</button>
            {request.choices.map((choice, index) => (
              <button
                key={choice.id}
                type="button"
                autoFocus={index === request.choices.length - 1}
                className={choice.tone === 'danger' ? 'app-dialog-danger-action' : choice.tone === 'primary' ? 'primary-action' : undefined}
                onClick={() => settleAppDialog(request, choice.id)}
              >
                {choice.label}
              </button>
            ))}
          </footer>
        ) : null}
      </section>
    </div>
  )
}

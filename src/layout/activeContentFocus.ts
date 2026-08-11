import type { DockviewApi } from 'dockview-react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { TerminalManager } from '../terminal/TerminalManager'
import { getTerminalWindow } from './terminalWindowRegistry'
import { parseWorkspaceContentParams } from './workspaceContentModel'


const KEYBOARD_CONTROL_SELECTOR = 'input, select, textarea, [contenteditable=""], [contenteditable="true"]'
const MAIN_WINDOW_ACTIVATED_EVENT = 'vibelink://main-window-activated'

/** True while the user owns a keyboard control outside the terminal surface —
 *  a popover's `<select>`, a rename box, the search field. Reclaiming focus
 *  would blur it, and on Windows that also dismisses an open native `<select>`
 *  popup: Chromium renders it as a separate menu window, so the Tauri window
 *  loses OS activation and gets it straight back, and the resulting
 *  focus-changed event fires while the list is still on screen. xterm's own
 *  helper textarea lives inside `.xterm` and is deliberately not counted. */
function keyboardControlFocused(): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement
  return active instanceof Element
    && active.closest(KEYBOARD_CONTROL_SELECTOR) !== null
    && active.closest('.xterm') === null
}

function activeTerminalContent(api: DockviewApi) {
  const content = parseWorkspaceContentParams(api.activePanel?.params)
  return content?.kind === 'terminal' || content?.kind === 'terminalWindow' ? content : null
}

function focusActiveContent(api: DockviewApi, canFocus: () => boolean): void {
  if (!canFocus() || keyboardControlFocused()) return
  const content = activeTerminalContent(api)
  if (content?.kind === 'terminal') TerminalManager.focus(content.paneId)
  else if (content?.kind === 'terminalWindow') getTerminalWindow(content.instanceId)?.focusFirst()
}

export function focusActiveContentAfterLayout(api: DockviewApi, canFocus: () => boolean): void {
  requestAnimationFrame(() => focusActiveContent(api, canFocus))
}

/** Restores keyboard control after the OS activates the main window.
 *
 *  `workspaceInteractive` answers ONLY whether focus may move into workspace
 *  content (no modal/overlay owns the app). It MUST NEVER be a document-focus
 *  check: Windows activation is the authority here — the native half only
 *  emits after `GetForegroundWindow()` matches our HWND — and `document
 *  .hasFocus()` is false in precisely the case this recovery exists for. */
export function registerActiveContentFocusOnWindowActivation(
  getApi: () => DockviewApi | null,
  workspaceInteractive: () => boolean,
): () => void {
  let disposed = false
  let focusPending = false
  let focusFrame: number | undefined
  let nativeUnlisten: (() => void) | undefined
  let fallbackUnlisten: (() => void) | undefined

  const scheduleFocus = () => {
    if (disposed || focusPending) return
    const api = getApi()
    if (!api || !workspaceInteractive() || keyboardControlFocused() || !activeTerminalContent(api)) return

    focusPending = true
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      // Both events mean the same thing — the window was activated — and DOM
      // focus alone does not restore OS keyboard routing: the frameless
      // window's WebView2 child HWND has to be focused too. Gating that call on
      // only one of the two paths dropped it whenever Tauri's focus event won
      // the race and claimed `focusPending`, which is the "Alt+Tab back and the
      // highlighted pane still needs a click" bug.
      void getCurrentWebview().setFocus().catch(() => undefined).then(() => {
        focusPending = false
        if (disposed) return
        const current = getApi()
        if (current) focusActiveContent(current, workspaceInteractive)
      })
    })
  }

  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) scheduleFocus()
  }).then((cleanup) => {
    if (disposed) cleanup()
    else nativeUnlisten = cleanup
  }).catch(() => undefined)

  void listen<void>(MAIN_WINDOW_ACTIVATED_EVENT, () => scheduleFocus()).then((cleanup) => {
    if (disposed) cleanup()
    else fallbackUnlisten = cleanup
  }).catch(() => undefined)

  return () => {
    disposed = true
    if (focusFrame !== undefined) cancelAnimationFrame(focusFrame)
    nativeUnlisten?.()
    fallbackUnlisten?.()
  }
}

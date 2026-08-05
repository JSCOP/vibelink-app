import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
import { TerminalManager } from '../terminal/TerminalManager'
import { getTerminalWindow } from './terminalWindowRegistry'
import { getWorkspaceWindow } from './workspaceWindowRegistry'
import { parseWorkspaceContentParams } from './workspaceContentModel'

export function activeWorkspacePanel(api: DockviewApi): IDockviewPanel | null {
  const outerPanel = api.activePanel
  const content = parseWorkspaceContentParams(outerPanel?.params)
  return content?.kind === 'workspaceWindow'
    ? getWorkspaceWindow(content.instanceId)?.getInnerApi()?.activePanel ?? null
    : outerPanel ?? null
}

const MAIN_WINDOW_ACTIVATED_EVENT = 'vibelink://main-window-activated'

export function focusActiveContentAfterLayout(api: DockviewApi, canFocus: () => boolean): void {
  requestAnimationFrame(() => {
    if (!canFocus()) return
    const content = parseWorkspaceContentParams(activeWorkspacePanel(api)?.params)
    if (content?.kind === 'terminal') TerminalManager.focus(content.paneId)
    else if (content?.kind === 'terminalWindow') getTerminalWindow(content.instanceId)?.focusFirst()
  })
}

export function registerActiveContentFocusOnWindowActivation(
  getApi: () => DockviewApi | null,
  canFocus: () => boolean,
): () => void {
  let disposed = false
  let focusPending = false
  let focusFrame: number | undefined
  let nativeUnlisten: (() => void) | undefined
  let fallbackUnlisten: (() => void) | undefined

  const scheduleFocus = (ensureWebviewFocus = false) => {
    if (disposed || focusPending) return
    if (ensureWebviewFocus) {
      const api = getApi()
      const content = api ? parseWorkspaceContentParams(activeWorkspacePanel(api)?.params) : null
      if (!api || !canFocus() || (content?.kind !== 'terminal' && content?.kind !== 'terminalWindow')) return
    }

    focusPending = true
    focusFrame = requestAnimationFrame(() => {
      focusFrame = undefined
      const finishFocus = () => {
        focusPending = false
        if (disposed || !canFocus()) return
        const api = getApi()
        if (!api) return
        const content = parseWorkspaceContentParams(activeWorkspacePanel(api)?.params)
        if (content?.kind === 'terminal') TerminalManager.focus(content.paneId)
        else if (content?.kind === 'terminalWindow') getTerminalWindow(content.instanceId)?.focusFirst()
      }

      if (ensureWebviewFocus) {
        void getCurrentWebview().setFocus().catch(() => undefined).then(finishFocus)
      } else {
        finishFocus()
      }
    })
  }

  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (focused) scheduleFocus()
  }).then((cleanup) => {
    if (disposed) cleanup()
    else nativeUnlisten = cleanup
  }).catch(() => undefined)

  void listen<void>(MAIN_WINDOW_ACTIVATED_EVENT, () => scheduleFocus(true)).then((cleanup) => {
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

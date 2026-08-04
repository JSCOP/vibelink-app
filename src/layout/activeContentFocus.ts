import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import { getCurrentWindow } from '@tauri-apps/api/window'
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
  let unlisten: (() => void) | undefined
  void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
    if (!focused) return
    const api = getApi()
    if (api) focusActiveContentAfterLayout(api, canFocus)
  }).then((cleanup) => {
    if (disposed) cleanup()
    else unlisten = cleanup
  }).catch(() => undefined)
  return () => {
    disposed = true
    unlisten?.()
  }
}

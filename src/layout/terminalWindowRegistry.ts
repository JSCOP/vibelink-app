import type { DockviewApi, IDockviewPanel } from 'dockview-react'
import type { WorkspaceContentParams } from './workspaceContentModel'

export type TerminalPaneParams = Extract<WorkspaceContentParams, { kind: 'terminal' }>

export type TerminalWindowAddOptions = {
  referencePaneId?: string
  direction?: 'right' | 'below'
  inactive?: boolean
}

/** Imperative handle over one terminal window's INNER Dockview. WorkspaceView
 * owns PTY spawn/close; the handle only owns inner-layout mutation + fit. */
export type TerminalWindowHandle = {
  windowId: string
  getInnerApi: () => DockviewApi | null
  addPane: (params: TerminalPaneParams, options?: TerminalWindowAddOptions) => IDockviewPanel | null
  removePane: (paneId: string) => void
  settle: () => Promise<void>
  persist: () => void
  paneIds: () => string[]
  focusFirst: () => void
}

const registry = new Map<string, TerminalWindowHandle>()

export function registerTerminalWindow(handle: TerminalWindowHandle): () => void {
  registry.set(handle.windowId, handle)
  return () => {
    if (registry.get(handle.windowId) === handle) registry.delete(handle.windowId)
  }
}

export function getTerminalWindow(windowId: string): TerminalWindowHandle | undefined {
  return registry.get(windowId)
}

export function listTerminalWindows(): TerminalWindowHandle[] {
  return [...registry.values()]
}

export function findTerminalWindowForPane(paneId: string): TerminalWindowHandle | undefined {
  for (const handle of registry.values()) {
    if (handle.paneIds().includes(paneId)) return handle
  }
  return undefined
}

/** Every live pane id currently owned by some registered terminal window. */
export function allWindowedPaneIds(): Set<string> {
  const ids = new Set<string>()
  for (const handle of registry.values()) {
    for (const paneId of handle.paneIds()) ids.add(paneId)
  }
  return ids
}

import type { DockviewApi } from 'dockview-react'
import { parseWorkspaceContentParams } from './workspaceContentModel'

type PaneIdElement = {
  dataset?: {
    paneId?: string
  }
}

type ClosestElement = {
  closest: (selector: string) => PaneIdElement | null
}

export function paneIdFromEventTarget(target: EventTarget | null): string | null {
  if (!hasClosest(target)) return null
  return target.closest('.terminal-panel-shell[data-pane-id]')?.dataset?.paneId ?? null
}
export function activeTerminalPaneId(api: Pick<DockviewApi, 'activePanel'> | null, paneIds: readonly string[]): string | null {
  const active = parseWorkspaceContentParams(api?.activePanel?.params)
  return active?.kind === 'terminal' ? active.paneId : paneIds[0] ?? null
}

function hasClosest(target: EventTarget | null): target is EventTarget & ClosestElement {
  return typeof target === 'object' && target !== null && 'closest' in target && typeof target.closest === 'function'
}

import type { DockviewApi } from 'dockview-react'
import { TerminalManager } from '../terminal/TerminalManager'

export function reflowTerminalsAfterLayout(options: { syncPty?: boolean; paneIds?: string[] } = {}): void {
  requestAnimationFrame(() => TerminalManager.scheduleLayoutPass({ paneIds: options.paneIds, syncPty: options.syncPty, force: true }))
}

export function getContentRect(panelId: string): DOMRect | null {
  const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(panelId) : panelId.replaceAll('"', '\\"')
  const element = document.querySelector<HTMLElement>(`.terminal-panel-shell[data-content-panel-id="${escaped}"], .workspace-window-panel[data-content-panel-id="${escaped}"]`)
  return element?.getBoundingClientRect() ?? null
}

export function nextContentAfterClose(api: DockviewApi, panelId: string): string | null {
  const closing = api.getPanel(panelId)
  if (!closing) return null
  const groupPanels = closing.group.panels.filter((panel) => panel.id !== panelId)
  if (groupPanels.length > 0) return groupPanels[0].id
  const candidates = api.panels.filter((panel) => panel.id !== panelId)
  if (candidates.length === 0) return null
  const closingRect = getContentRect(panelId)
  if (!closingRect) return candidates[0].id
  let best: { id: string; distance: number } | null = null
  for (const panel of candidates) {
    const rect = getContentRect(panel.id)
    if (!rect) continue
    const distance = Math.hypot((rect.left + rect.width / 2) - (closingRect.left + closingRect.width / 2), (rect.top + rect.height / 2) - (closingRect.top + closingRect.height / 2))
    if (!best || distance < best.distance) best = { id: panel.id, distance }
  }
  return best?.id ?? candidates[0].id
}

export function workspaceAspectRatio(element: HTMLElement | null): number {
  const rect = element?.getBoundingClientRect()
  return rect && rect.height > 0 ? rect.width / rect.height : 16 / 9
}

export function isDockElementMeasurable(element: HTMLElement | null): element is HTMLElement {
  if (!element?.isConnected || element.offsetParent === null) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

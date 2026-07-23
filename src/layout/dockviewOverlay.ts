import type { DockviewApi } from 'dockview-react'

export type DockviewOverlayRenderContainer = {
  map?: Record<string, { element?: HTMLElement }>
  updateAllPositions: () => void
}

export function dockviewOverlayRenderContainer(api: DockviewApi): DockviewOverlayRenderContainer | null {
  const holder: unknown = api
  if (!holder || typeof holder !== 'object' || !('component' in holder)) return null
  const component = holder.component
  if (!component || typeof component !== 'object' || !('overlayRenderContainer' in component)) return null
  const container = component.overlayRenderContainer
  if (!container || typeof container !== 'object' || !('updateAllPositions' in container) || typeof container.updateAllPositions !== 'function') return null
  return container as DockviewOverlayRenderContainer
}

export function forceOverlayReposition(api: DockviewApi): void {
  dockviewOverlayRenderContainer(api)?.updateAllPositions()
}

export function rectsMatch(left: DOMRect, right: DOMRect, tolerance = 1): boolean {
  return Math.abs(left.left - right.left) <= tolerance
    && Math.abs(left.top - right.top) <= tolerance
    && Math.abs(left.width - right.width) <= tolerance
    && Math.abs(left.height - right.height) <= tolerance
}

export function dockviewOverlaysSettled(api: DockviewApi): boolean {
  const container = dockviewOverlayRenderContainer(api)
  if (!container?.map) return false
  for (const panel of api.panels) {
    if (!panel.api.isVisible || panel.api.renderer !== 'always') continue
    const overlay = container.map[panel.id]?.element
    const owner = panel.group.element.querySelector<HTMLElement>('.dv-content-container')
    if (!overlay || !owner || overlay.style.visibility === 'hidden') return false
    const overlayRect = overlay.getBoundingClientRect()
    const ownerRect = owner.getBoundingClientRect()
    if (ownerRect.width <= 0 || ownerRect.height <= 0 || !rectsMatch(overlayRect, ownerRect)) return false
  }
  return true
}

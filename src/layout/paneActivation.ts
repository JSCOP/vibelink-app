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
  return target.closest('[data-pane-id]')?.dataset?.paneId ?? null
}

function hasClosest(target: EventTarget | null): target is EventTarget & ClosestElement {
  return typeof target === 'object' && target !== null && 'closest' in target && typeof target.closest === 'function'
}

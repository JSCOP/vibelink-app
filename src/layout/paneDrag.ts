export const paneDragMime = 'application/x-awt-pane-id'

export type PaneDropPosition = 'left' | 'right' | 'top' | 'bottom' | 'center'

type RectLike = Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>

const edgeActivationRatio = 0.28
const edgeActivationEpsilon = 1e-6

export function hasPaneDragPayload(types: DOMStringList | readonly string[]): boolean {
  return Array.from(types).includes(paneDragMime)
}

export function paneDropPositionFromPoint(rect: RectLike, clientX: number, clientY: number): PaneDropPosition {
  if (rect.width <= 0 || rect.height <= 0) return 'center'

  const xRatio = clampRatio((clientX - rect.left) / rect.width)
  const yRatio = clampRatio((clientY - rect.top) / rect.height)
  const candidates: Array<{ position: PaneDropPosition; distance: number }> = []

  if (xRatio <= edgeActivationRatio) candidates.push({ position: 'left', distance: xRatio })
  if (1 - xRatio <= edgeActivationRatio) candidates.push({ position: 'right', distance: 1 - xRatio })
  if (yRatio <= edgeActivationRatio) candidates.push({ position: 'top', distance: yRatio })
  if (1 - yRatio <= edgeActivationRatio) candidates.push({ position: 'bottom', distance: 1 - yRatio })

  return candidates.reduce((best, candidate) => candidate.distance < best.distance ? candidate : best, { position: 'center', distance: edgeActivationRatio + edgeActivationEpsilon }).position
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

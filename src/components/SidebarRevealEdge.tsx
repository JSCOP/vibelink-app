import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react'
import { SIDEBAR_REVEAL_DELAY_MS, shouldCancelSidebarReveal } from './sidebarRevealPolicy'

type SidebarRevealEdgeProps = {
  onReveal: () => void
}

export function SidebarRevealEdge({ onReveal }: SidebarRevealEdgeProps) {
  const hoverTimerRef = useRef<number | null>(null)

  const clearPendingReveal = () => {
    if (hoverTimerRef.current === null) return
    window.clearTimeout(hoverTimerRef.current)
    hoverTimerRef.current = null
  }

  useEffect(() => clearPendingReveal, [])

  const handlePointerEnter = (event: ReactPointerEvent<HTMLDivElement>) => {
    // Do not reveal while terminal text selection is being dragged to the edge.
    if (event.buttons !== 0 || hoverTimerRef.current !== null) return
    hoverTimerRef.current = window.setTimeout(() => {
      hoverTimerRef.current = null
      onReveal()
    }, SIDEBAR_REVEAL_DELAY_MS)
  }

  const handlePointerLeave = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (shouldCancelSidebarReveal(event.relatedTarget)) clearPendingReveal()
  }

  return (
    <div
      className="sidebar-hover-edge"
      aria-hidden="true"
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onPointerDown={clearPendingReveal}
    />
  )
}

import { useSyncExternalStore } from 'react'
import type { ConnectedResizeHandle } from './connectedResize'

export type ResizePreviewState = ConnectedResizeHandle & {
  delta: number
  rawDelta?: number
  mode: 'connected' | 'single'
  snapped?: boolean
}

export type ResizePreviewStore = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ResizePreviewState | null
  set: (next: ResizePreviewState | null) => void
}

/** Preview state for divider drags, kept outside React component state.
 *
 *  A drag updates the preview once per animation frame; routing that through
 *  `useState` on WorkspaceView reconciles the entire workspace tree (both
 *  dockviews, every pane) per frame, which is what made dragging lag on
 *  high-Hz pointers. Only the overlay layer subscribes to a store, so a
 *  preview update re-renders just that overlay. Instantiate per component
 *  (useRef) so remounts never share listeners.
 */
export function createResizePreviewStore(): ResizePreviewStore {
  let state: ResizePreviewState | null = null
  const listeners = new Set<() => void>()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot: () => state,
    set(next) {
      if (next === state || (next !== null && state !== null && previewsEqual(next, state))) return
      state = next
      for (const listener of listeners) listener()
    },
  }
}

function previewsEqual(a: ResizePreviewState, b: ResizePreviewState): boolean {
  return a.id === b.id
    && a.axis === b.axis
    && a.coordinate === b.coordinate
    && a.start === b.start
    && a.end === b.end
    && a.delta === b.delta
    && a.rawDelta === b.rawDelta
    && a.mode === b.mode
    && a.snapped === b.snapped
}

export function useResizePreview(store: ResizePreviewStore): ResizePreviewState | null {
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

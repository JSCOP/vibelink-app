/** Shared "the user is dragging a layout boundary right now" signal.
 *
 *  Two different gestures resize panes and they need OPPOSITE handling:
 *
 *  - **divider** — a Dockview `.dv-sash` drag. Dockview's own document-level
 *    pointermove already resizes the splitview and repositions every view at
 *    display rate, so the geometry is ALREADY live. A forced
 *    `api.layout(w, h, true)` from our side during this window is not merely
 *    redundant, it is wrong: the container size did not change, so
 *    `Splitview.layout()` takes its proportional branch and re-applies the
 *    proportions saved at the previous `onDidSashEnd` — the sizes from BEFORE
 *    this drag. Panes snap back to their pre-drag widths, the next pointermove
 *    drags them out again, and the divider stutters behind the pointer.
 *
 *  - **window** — a native window drag-resize. Here the container really did
 *    change, so the forced layout is REQUIRED: proportions are re-applied to
 *    the new size, which is correct. Only the settle/persist tail is deferred.
 *
 *  So `isDividerResizeActive()` (suppress forced re-layout) is deliberately
 *  narrower than `isInteractiveResizeActive()` (throttle terminal work).
 *
 *  `TerminalManager` owns detection, because Dockview's stock sash exposes no
 *  drag events; this module owns the state so layout code can read it without
 *  importing the terminal singleton.
 */
export type InteractiveResizeKind = 'divider' | 'window'

const depths: Record<InteractiveResizeKind, number> = { divider: 0, window: 0 }
const endListeners = new Set<(kind: InteractiveResizeKind) => void>()

export function isInteractiveResizeActive(): boolean {
  return depths.divider > 0 || depths.window > 0
}

/** True only while a Dockview divider drag owns the geometry. */
export function isDividerResizeActive(): boolean {
  return depths.divider > 0
}

export function beginInteractiveResize(kind: InteractiveResizeKind): void {
  depths[kind] += 1
}

export function endInteractiveResize(kind: InteractiveResizeKind): void {
  if (depths[kind] === 0) return
  depths[kind] -= 1
  if (depths[kind] > 0) return
  for (const listener of [...endListeners]) listener(kind)
}

/** Fires once when a kind's last interaction finishes. Work deferred during the
 *  drag (settle, overlay reposition, persist) re-runs here, on final geometry. */
export function onInteractiveResizeEnd(listener: (kind: InteractiveResizeKind) => void): () => void {
  endListeners.add(listener)
  return () => endListeners.delete(listener)
}

/** Test-only: drop all state so one suite cannot leak a stuck interaction. */
export function resetInteractiveResizeForTests(): void {
  depths.divider = 0
  depths.window = 0
  endListeners.clear()
}

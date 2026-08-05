/** Pointer-driven drag for Agent Session History rows.
 *
 * Native HTML5 drag-and-drop is unusable here: with `dragDropEnabled: false`
 * the WebView2 host has no OLE drop target, so a `dragstart` inside the app
 * hangs the window's UI thread (observed: window stops responding, zero CPU,
 * never recovers). Terminal pane title bars already avoid this — Dockview runs
 * with `dndStrategy: "pointer"` — so agent sessions use the same gesture model:
 * pointerdown, a movement threshold, a ghost that follows the cursor, and a
 * document hit-test for the pane under the pointer.
 */

/** Matches Dockview's pointer drag source threshold. */
const DRAG_THRESHOLD_PX = 5

type Listener = () => void

const listeners = new Set<Listener>()
let dropPaneId: string | null = null

function publishDropPaneId(next: string | null): void {
  if (dropPaneId === next) return
  dropPaneId = next
  for (const listener of listeners) listener()
}

/** Subscribe to the pane currently under an agent-session drag. */
export function subscribeAgentSessionDropPane(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function agentSessionDropPaneId(): string | null {
  return dropPaneId
}

export type AgentSessionDragOptions = {
  /** Ghost caption; the conversation title. */
  label: string
  /** `false` keeps the gesture tap-only (the conversation is already open). */
  canDrag: boolean
  onDrop: (paneId: string) => void
  /** Released without passing the drag threshold. */
  onTap: () => void
}

/** Own the whole row gesture from `pointerdown`.
 *
 *  The row cannot rely on `click`: the virtualized list re-creates its row
 *  elements while the button is held, so `mousedown` and `mouseup` land on
 *  different nodes and the browser never dispatches `click` on the row. These
 *  listeners live on `window` and close over the conversation, so both a tap
 *  and a drag survive that re-render. */
export function startAgentSessionDrag(event: PointerEvent, options: AgentSessionDragOptions): void {
  if (event.button !== 0 || typeof document === 'undefined') return
  const { clientX: startX, clientY: startY, pointerId } = event
  let ghost: HTMLElement | null = null
  let dragging = false

  const finish = (dropped: boolean) => {
    window.removeEventListener('pointermove', onPointerMove)
    window.removeEventListener('pointerup', onPointerUp)
    window.removeEventListener('pointercancel', onPointerCancel)
    ghost?.remove()
    ghost = null
    const target = dropPaneId
    publishDropPaneId(null)
    if (!dragging) {
      if (dropped) {
        // A `click` may still follow on some common ancestor; the tap already
        // handled the row.
        suppressNextClick()
        options.onTap()
      }
      return
    }
    // The gesture was a drag, so the click that follows pointerup is not a row
    // activation.
    suppressNextClick()
    if (dropped && target) options.onDrop(target)
  }

  const onPointerMove = (moveEvent: PointerEvent) => {
    if (moveEvent.pointerId !== pointerId) return
    if (!dragging) {
      if (!options.canDrag) return
      if (Math.abs(moveEvent.clientX - startX) < DRAG_THRESHOLD_PX
        && Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return
      dragging = true
      ghost = document.createElement('div')
      ghost.className = 'agent-session-drag-ghost'
      ghost.textContent = options.label
      document.body.append(ghost)
    }
    // Keeps the gesture from turning into a text selection.
    moveEvent.preventDefault()
    if (ghost) ghost.style.transform = `translate(${moveEvent.clientX + 12}px, ${moveEvent.clientY + 12}px)`
    // ponytail: hit-test per pointermove rather than caching pane rects — the
    // browser answers from current layout, so a cache would only add
    // invalidation bugs when a split or resize lands mid-drag.
    publishDropPaneId(document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
      ?.closest<HTMLElement>('[data-terminal-pane-id]')
      ?.dataset.terminalPaneId ?? null)
  }

  const onPointerUp = (upEvent: PointerEvent) => {
    if (upEvent.pointerId === pointerId) finish(true)
  }

  const onPointerCancel = (cancelEvent: PointerEvent) => {
    if (cancelEvent.pointerId === pointerId) finish(false)
  }

  window.addEventListener('pointermove', onPointerMove)
  window.addEventListener('pointerup', onPointerUp)
  window.addEventListener('pointercancel', onPointerCancel)
}

function suppressNextClick(): void {
  const release = () => {
    window.removeEventListener('click', onClick, true)
    window.clearTimeout(timer)
  }
  const onClick = (event: MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    release()
  }
  window.addEventListener('click', onClick, true)
  // A drag that ends outside any clickable element never produces the click;
  // the timer keeps the guard from swallowing a later, unrelated one.
  const timer = window.setTimeout(release, 0)
}

export async function waitForDockviewOverlayLayout(
  scheduleFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): Promise<void> {
  await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
  await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
}
type DockviewOverlayLayoutCallbacks = {
  layout: () => void
  refresh?: () => void
  isSettled?: () => boolean
  complete?: () => void
}

export async function settleDockviewOverlayLayout(
  callbacks: DockviewOverlayLayoutCallbacks,
  scheduleFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): Promise<void> {
  // Every level of the nested dock re-enters here, and each level's `layout()`
  // fires dimension events that restart the level below it. Switching one edge
  // tab — which changes no geometry at all — measured 240 forced fits and 216
  // scrollToBottom calls spread over 1.25 s of that feedback. Overlays that
  // already match their group need no round AND no `complete()` fit pass: a
  // host that genuinely changed size is still caught by its own ResizeObserver.
  if (callbacks.isSettled?.()) return
  for (let attempt = 0; attempt < 12; attempt += 1) {
    callbacks.layout()
    callbacks.refresh?.()
    await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
    if (callbacks.isSettled?.() ?? true) break
  }
  callbacks.complete?.()
}

/** Edge-group collapse already resizes Dockview's grid synchronously. Wait for
 * that geometry to paint, then repair only the detached renderer overlays;
 * re-running the whole Dockview layout on every retry causes visible flicker. */
export async function settleDockviewOverlayReposition(
  callbacks: Omit<DockviewOverlayLayoutCallbacks, 'layout'>,
  scheduleFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): Promise<void> {
  if (callbacks.isSettled?.()) return
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
    callbacks.refresh?.()
    if (callbacks.isSettled?.() ?? true) break
  }
  callbacks.complete?.()
}

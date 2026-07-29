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
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
    callbacks.refresh?.()
    if (callbacks.isSettled?.() ?? true) break
  }
  callbacks.complete?.()
}

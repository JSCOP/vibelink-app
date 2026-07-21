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

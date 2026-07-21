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
  callbacks.layout()
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
    callbacks.refresh?.()
    if (callbacks.isSettled?.() ?? true) break
  }
  callbacks.complete?.()
}

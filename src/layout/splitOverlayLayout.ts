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

type NestedDockviewLayoutCallbacks = {
  layoutOuter: () => void
  refreshOuter?: () => void
  outerIsSettled?: () => boolean
  layoutInner: () => void
  refreshInner?: () => void
  innerIsSettled?: () => boolean
  recover: () => void
  restoreFocus?: () => void
}

export async function settleNestedDockviewLayout(
  callbacks: NestedDockviewLayoutCallbacks,
  scheduleFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): Promise<void> {
  callbacks.layoutOuter()
  if (callbacks.outerIsSettled || callbacks.innerIsSettled) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
      callbacks.refreshOuter?.()
      callbacks.layoutInner()
      await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
      callbacks.refreshInner?.()
      const outerSettled = callbacks.outerIsSettled?.() ?? true
      const innerSettled = callbacks.innerIsSettled?.() ?? true
      if (outerSettled && innerSettled) break
    }
  } else {
    await waitForDockviewOverlayLayout(scheduleFrame)
    callbacks.layoutInner()
    await waitForDockviewOverlayLayout(scheduleFrame)
  }
  callbacks.recover()
  callbacks.restoreFocus?.()
}

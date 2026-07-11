export async function waitForDockviewOverlayLayout(
  scheduleFrame: (callback: FrameRequestCallback) => number = requestAnimationFrame,
): Promise<void> {
  await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
  await new Promise<void>((resolve) => scheduleFrame(() => resolve()))
}

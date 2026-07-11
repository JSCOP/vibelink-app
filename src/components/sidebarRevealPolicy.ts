export const SIDEBAR_REVEAL_DELAY_MS = 180

type AppTargetCheck = (target: EventTarget) => boolean

const isTargetInsideDocument: AppTargetCheck = (target) => target instanceof Node && document.documentElement.contains(target)

export function shouldCancelSidebarReveal(
  relatedTarget: EventTarget | null,
  isAppTarget: AppTargetCheck = isTargetInsideDocument,
): boolean {
  // Native pointerleave reports null at the physical window boundary, while
  // React can normalize that same exit to Window. Cancel only when the pointer
  // actually returned to a DOM node inside this app.
  return relatedTarget !== null && isAppTarget(relatedTarget)
}

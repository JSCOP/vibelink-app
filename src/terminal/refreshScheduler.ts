export type RequestFrame = (callback: FrameRequestCallback) => number

export function createTerminalRefreshScheduler(
  refreshAll: () => void,
  requestFrame: RequestFrame = requestAnimationFrame,
): () => void {
  let pending = false

  return () => {
    if (pending) return
    pending = true
    requestFrame(() => {
      pending = false
      refreshAll()
    })
  }
}

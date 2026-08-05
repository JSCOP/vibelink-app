type BooleanRef = {
  current: boolean
}

export async function withSuppressedPanelRemoval<T>(ref: BooleanRef, work: () => Promise<T>): Promise<T> {
  ref.current = true
  try {
    return await work()
  } finally {
    ref.current = false
  }
}

export async function withAllowedPanelRemoval<T>(ref: BooleanRef, work: () => Promise<T>): Promise<T> {
  const previous = ref.current
  ref.current = false
  try {
    return await work()
  } finally {
    ref.current = previous
  }
}

// Dockview reports a panel-PARAMETER write as a layout change: `updateParameters`
// and `setTitle` both feed `_bufferOnDidLayoutChange`, an AsapEvent that
// dispatches on the microtask queue. Nested windows persist their serialized
// layout INTO their parent panel's params, so every persist looked like the
// outer grid moving: the outer handler armed a live resize plus a 140 ms quiet
// full settle, which re-ran the whole three-level settle and force-fit every
// pane in the app. One Alt+Z therefore cost 120 ms (terminal window persist) +
// 120 ms (workspace window persist) + 140 ms (quiet timer) and then a global
// fit/PTY-resize storm. Mark the write so ancestors keep PERSISTING it without
// treating it as geometry.
let layoutParamsPersistDepth = 0

export function withLayoutParamsPersist(write: () => void): void {
  layoutParamsPersistDepth += 1
  try {
    write()
  } finally {
    // The listener runs in the microtask queued by `fire()` during `write()`,
    // so the release must be queued after it, not run synchronously.
    queueMicrotask(() => { layoutParamsPersistDepth -= 1 })
  }
}

export function isLayoutParamsPersistActive(): boolean {
  return layoutParamsPersistDepth > 0
}

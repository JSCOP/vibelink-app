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

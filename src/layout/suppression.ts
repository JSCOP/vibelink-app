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

export type TerminalHostSize = {
  width: number
  height: number
}

export type TerminalHostMeasureState = 'measurable' | 'unmeasurable'

export type TerminalGridSize = {
  cols: number
  rows: number
}

export function isTerminalHostMeasurable(size: TerminalHostSize | null | undefined): size is TerminalHostSize {
  return Boolean(size && size.width > 0 && size.height > 0)
}

export function terminalHostMeasureState(size: TerminalHostSize | null | undefined): TerminalHostMeasureState {
  return isTerminalHostMeasurable(size) ? 'measurable' : 'unmeasurable'
}

export function terminalHostBecameMeasurable(previous: TerminalHostMeasureState | undefined, next: TerminalHostMeasureState): boolean {
  return previous === 'unmeasurable' && next === 'measurable'
}

export async function waitForStableTerminalGrid(
  measure: () => TerminalGridSize | null,
  nextFrame: () => Promise<void>,
  attempts = 30,
): Promise<TerminalGridSize | undefined> {
  let previous: TerminalGridSize | undefined
  for (let index = 0; index < attempts; index += 1) {
    const next = measure() ?? undefined
    if (next && next.cols === previous?.cols && next.rows === previous.rows) return next
    previous = next
    await nextFrame()
  }
  return previous
}

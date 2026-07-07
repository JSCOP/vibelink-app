export type TerminalHostSize = {
  width: number
  height: number
}

export type TerminalHostMeasureState = 'measurable' | 'unmeasurable'

export function isTerminalHostMeasurable(size: TerminalHostSize | null | undefined): size is TerminalHostSize {
  return Boolean(size && size.width > 0 && size.height > 0)
}

export function terminalHostMeasureState(size: TerminalHostSize | null | undefined): TerminalHostMeasureState {
  return isTerminalHostMeasurable(size) ? 'measurable' : 'unmeasurable'
}

export function terminalHostBecameMeasurable(previous: TerminalHostMeasureState | undefined, next: TerminalHostMeasureState): boolean {
  return previous === 'unmeasurable' && next === 'measurable'
}

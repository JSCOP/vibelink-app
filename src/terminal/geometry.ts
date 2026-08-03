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

/** Structural view of the xterm scroll surface these helpers need. */
export type TerminalScrollView = {
  buffer: { active: { baseY: number; viewportY: number } }
  scrollToBottom: () => void
  scrollToLine: (line: number) => void
}

/** Rows between the viewport top and the bottom of the scrollback. */
export function terminalScrollAnchor(term: TerminalScrollView): number {
  return term.buffer.active.baseY - term.buffer.active.viewportY
}

/** A fit that changes COLUMNS rewraps the scrollback, so `baseY` moves while
 *  xterm keeps the absolute viewport row: the line the user was reading drifts
 *  toward the top of the buffer and the pane reads as "scrolled back to the
 *  start". Restoring the distance from the bottom keeps that line in place.
 *  A viewport already at the bottom (anchor <= 0) still pins to the bottom, so
 *  a live pane never strands itself above new output. */
export function restoreTerminalScrollAnchor(term: TerminalScrollView, anchor: number): void {
  if (anchor <= 0) {
    term.scrollToBottom()
    return
  }
  const target = Math.max(0, term.buffer.active.baseY - anchor)
  if (target !== term.buffer.active.viewportY) term.scrollToLine(target)
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

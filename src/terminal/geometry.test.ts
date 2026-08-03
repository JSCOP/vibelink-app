// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { isTerminalHostMeasurable, restoreTerminalScrollAnchor, terminalHostBecameMeasurable, terminalHostMeasureState, terminalScrollAnchor, waitForStableTerminalGrid } from './geometry'

describe('terminal host geometry', () => {
  it('does not treat zero-sized dockview hosts as ready for fitting', () => {
    expect(isTerminalHostMeasurable({ width: 0, height: 320 })).toBe(false)
    expect(isTerminalHostMeasurable({ width: 640, height: 0 })).toBe(false)
  })

  it('treats visible dockview hosts as ready for fitting', () => {
    expect(isTerminalHostMeasurable({ width: 640, height: 320 })).toBe(true)
  })

  it('tracks zero-to-positive host transitions for renderer recovery', () => {
    const hidden = terminalHostMeasureState({ width: 0, height: 320 })
    const visible = terminalHostMeasureState({ width: 640, height: 320 })

    expect(hidden).toBe('unmeasurable')
    expect(visible).toBe('measurable')
    expect(terminalHostBecameMeasurable(hidden, visible)).toBe(true)
    expect(terminalHostBecameMeasurable(undefined, visible)).toBe(false)
    expect(terminalHostBecameMeasurable(visible, visible)).toBe(false)
  })

  it('waits for the final repeated grid before spawning a terminal', async () => {
    const measured = [
      { cols: 272, rows: 79 },
      { cols: 272, rows: 75 },
      { cols: 272, rows: 77 },
      { cols: 272, rows: 77 },
    ]

    await expect(waitForStableTerminalGrid(
      () => measured.shift() ?? null,
      () => Promise.resolve(),
    )).resolves.toEqual({ cols: 272, rows: 77 })
  })
})

describe('terminal scroll anchor', () => {
  /** Narrowing a pane rewraps scrollback: `baseY` grows while xterm keeps the
   *  absolute viewport row, so the reader silently drifts backwards. */
  const scrolledTerminal = async () => {
    const term = new Terminal({ cols: 20, rows: 4, scrollback: 500 })
    const body = Array.from({ length: 40 }, (_, index) => `row${String(index).padStart(2, '0')}-abcdefghi`).join('\r\n')
    await new Promise<void>((resolve) => term.write(`${body}\r\n`, resolve))
    term.scrollToLine(term.buffer.active.baseY - 12)
    return term
  }

  it('keeps the reader the same distance from the bottom when columns rewrap', async () => {
    const term = await scrolledTerminal()
    const anchor = terminalScrollAnchor(term)
    expect(anchor).toBe(12)

    term.resize(10, 4)
    expect(terminalScrollAnchor(term)).not.toBe(anchor)

    restoreTerminalScrollAnchor(term, anchor)
    expect(terminalScrollAnchor(term)).toBe(anchor)
    term.dispose()
  })

  it('pins a viewport that already sat at the bottom so new output stays visible', async () => {
    const term = await scrolledTerminal()
    term.scrollToBottom()
    const anchor = terminalScrollAnchor(term)
    expect(anchor).toBe(0)

    term.resize(10, 4)
    restoreTerminalScrollAnchor(term, anchor)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
    term.dispose()
  })

  it('clamps to the top instead of scrolling past the start of a trimmed buffer', () => {
    const scrolls: number[] = []
    const term = {
      buffer: { active: { baseY: 4, viewportY: 4 } },
      scrollToBottom: () => scrolls.push(-1),
      scrollToLine: (line: number) => scrolls.push(line),
    }

    restoreTerminalScrollAnchor(term, 900)

    expect(scrolls).toEqual([0])
  })
})

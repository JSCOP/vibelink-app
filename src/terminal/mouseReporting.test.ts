// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import {
  guardRedundantProtocolChanges,
  keepScrollPositionAcrossMouseReports,
  resolveWheelAction,
  terminalCellHeight,
  wheelScrollLines,
  type MouseTrackingMode,
  type TerminalBufferType,
} from './mouseReporting'

// jsdom implements neither of these; xterm's CoreBrowserService needs both to
// open a terminal, and the patch tests exist to run against real xterm rather
// than a mock of it.
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  HTMLCanvasElement.prototype.getContext ??= (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
})

const openTerminal = () => {
  const term = new Terminal()
  const host = document.createElement('div')
  document.body.appendChild(host)
  term.open(host)
  return {
    term,
    write: (data: string) => new Promise<void>((resolve) => term.write(data, resolve)),
    dispose: () => {
      term.dispose()
      host.remove()
    },
  }
}

describe('wheel routing while an application owns the mouse', () => {
  const wheel = (bufferType: TerminalBufferType, mouseTrackingMode: MouseTrackingMode, altKey = false) =>
    resolveWheelAction({ bufferType, mouseTrackingMode, altKey })

  it('keeps swallowing the alternate buffer notch that xterm would turn into ArrowUp', () => {
    // The regression this guards: OMP and friends read CSI A as history recall.
    expect(wheel('alternate', 'none')).toBe('swallow')
    expect(wheel('alternate', 'x10')).toBe('swallow')
    expect(wheel('alternate', 'none', true)).toBe('swallow')
  })

  it('still hands the alternate buffer notch to TUIs that asked for wheel reports', () => {
    expect(wheel('alternate', 'vt200')).toBe('default')
    expect(wheel('alternate', 'drag')).toBe('default')
    expect(wheel('alternate', 'any')).toBe('default')
  })

  it('scrolls the pane in the normal buffer even while the app is being reported to', () => {
    // Claude Code renders inline under vt200 tracking; the scrollback above it
    // is real, so the reader gets the wheel instead of the application.
    expect(wheel('normal', 'vt200')).toBe('scroll-viewport')
    expect(wheel('normal', 'drag')).toBe('scroll-viewport')
    expect(wheel('normal', 'any')).toBe('scroll-viewport')
  })

  it('leaves the normal buffer to xterm when no wheel report is in play', () => {
    // x10 reports button-down only, so xterm's own viewport still handles it.
    expect(wheel('normal', 'none')).toBe('default')
    expect(wheel('normal', 'x10')).toBe('default')
  })

  it('forwards the notch to the application when Alt is held', () => {
    expect(wheel('normal', 'vt200', true)).toBe('default')
    expect(wheel('normal', 'x10', true)).toBe('default')
  })
})

describe('wheel delta conversion', () => {
  it('converts pixel deltas with the pane cell height', () => {
    expect(wheelScrollLines({ deltaY: 100, deltaMode: 0 }, 20, 30)).toBe(5)
    expect(wheelScrollLines({ deltaY: -50, deltaMode: 0 }, 20, 30)).toBe(-2.5)
  })

  it('passes line deltas through and scales page deltas by the grid height', () => {
    expect(wheelScrollLines({ deltaY: 3, deltaMode: 1 }, 20, 30)).toBe(3)
    expect(wheelScrollLines({ deltaY: -1, deltaMode: 2 }, 20, 30)).toBe(-30)
  })

  it('scrolls nothing when there is no vertical delta or no measured cell', () => {
    expect(wheelScrollLines({ deltaY: 0, deltaMode: 0 }, 20, 30)).toBe(0)
    expect(wheelScrollLines({ deltaY: Number.NaN, deltaMode: 0 }, 20, 30)).toBe(0)
    // Before the renderer has measured, a pixel delta has no line equivalent.
    expect(wheelScrollLines({ deltaY: 100, deltaMode: 0 }, 0, 30)).toBe(0)
  })
})

/** Guards the private-API reach into xterm's core mouse service. An xterm
 *  upgrade that renames `_core.coreMouseService`, drops the `activeProtocol`
 *  accessor or moves `triggerMouseEvent` must fail here rather than silently
 *  returning every pane to selections wiped by the next TUI frame. */
describe('mouse reporting patches', () => {
  it('drops the protocol re-assertion a TUI emits on every redraw', async () => {
    const pane = openTerminal()
    expect(guardRedundantProtocolChanges(pane.term)).toBe(true)

    const changes: string[] = []
    const core = (pane.term as unknown as { _core: { coreMouseService: { onProtocolChange: (cb: (events: number) => void) => unknown; activeProtocol: string } } })._core
    core.coreMouseService.onProtocolChange(() => changes.push(core.coreMouseService.activeProtocol))

    await pane.write('\x1b[?1000h\x1b[?1006h')
    expect(core.coreMouseService.activeProtocol).toBe('VT200')
    expect(changes).toEqual(['VT200'])

    // Claude Code 2.1.238 re-emits exactly this inside its redraw frame.
    await pane.write('\x1b[2K\x1b[1A\x1b[2K\x1b[?1000h\x1b[?1006h\x1b[1G')
    expect(changes).toEqual(['VT200'])

    // A real transition must still land, or the pane would keep reporting mouse
    // events to an application that just gave them up.
    await pane.write('\x1b[?1000l')
    expect(core.coreMouseService.activeProtocol).toBe('NONE')
    expect(changes).toEqual(['VT200', 'NONE'])
    pane.dispose()
  })

  it('keeps a forced selection alive across the redraw that re-asserts the mode', async () => {
    const pane = openTerminal()
    guardRedundantProtocolChanges(pane.term)
    await pane.write('hello world\r\nsecond line\r\n')
    await pane.write('\x1b[?1000h\x1b[?1006h')

    pane.term.select(0, 0, 5)
    expect(pane.term.getSelection()).toBe('hello')

    await pane.write('\x1b[2K\x1b[1A\x1b[2K\x1b[?1000h\x1b[?1006h\x1b[1G')
    expect(pane.term.getSelection()).toBe('hello')
    pane.dispose()
  })

  it('stops mouse reports from dragging the viewport back to the bottom', async () => {
    const pane = openTerminal()
    expect(keepScrollPositionAcrossMouseReports(pane.term)).toBe(true)
    await pane.write('\x1b[?1000h\x1b[?1006h')

    const core = (pane.term as unknown as {
      _core: { coreMouseService: { triggerMouseEvent: (event: unknown) => boolean } }
    })._core
    let sawScrollOnUserInput: boolean | undefined
    pane.term.onData(() => { sawScrollOnUserInput = pane.term.options.scrollOnUserInput })

    const reported = core.coreMouseService.triggerMouseEvent({
      col: 1, row: 1, x: 1, y: 1, button: 0, action: 0, ctrl: false, alt: false, shift: false,
    })

    // The report still reaches the application; it just no longer counts as the
    // kind of user input that yanks a scrolled-up reader back to the prompt.
    expect(reported).toBe(true)
    expect(sawScrollOnUserInput).toBe(false)
    // The option is restored, so typing keeps jumping back to the prompt.
    expect(pane.term.options.scrollOnUserInput).toBe(true)
    pane.dispose()
  })

  it('reports failure instead of throwing when xterm has not built its core services', () => {
    const bare = new Terminal()
    expect(terminalCellHeight(bare)).toBe(0)
    bare.dispose()
  })
})

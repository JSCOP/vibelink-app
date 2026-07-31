// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { createTerminalOptions, defaultTerminalSettings, terminalLetterSpacing, terminalLineHeight } from './options'

describe('terminal options', () => {
  it('enables renderer-owned box drawing glyphs', () => {
    const options = createTerminalOptions(defaultTerminalSettings)

    expect(options.lineHeight).toBe(terminalLineHeight)
    expect(options.lineHeight).toBe(1)
    expect(options.letterSpacing).toBe(terminalLetterSpacing)
    expect(options.letterSpacing).toBe(0)
    expect(options.customGlyphs).toBe(true)
  })

  it('uses a thin bar cursor by default', () => {
    const options = createTerminalOptions(defaultTerminalSettings)

    expect(defaultTerminalSettings.cursorStyle).toBe('bar')
    expect(defaultTerminalSettings.cursorWidth).toBe(1)
    expect(options.cursorStyle).toBe('bar')
    expect(options.cursorWidth).toBe(1)
  })

  it('only applies cursor width to bar cursors', () => {
    const options = createTerminalOptions({
      ...defaultTerminalSettings,
      cursorStyle: 'block',
      cursorWidth: 3,
    })

    expect(options.cursorStyle).toBe('block')
    expect(options.cursorWidth).toBeUndefined()
  })

  it('clamps bold weight without changing normal weight', () => {
    const options = createTerminalOptions({
      ...defaultTerminalSettings,
      terminalFontWeight: 300,
    })

    expect(options.fontWeight).toBe('300')
    expect(options.fontWeightBold).toBe('700')
  })

  /** A pane spawns at 120x32 and grows to the measured grid moments later. With
   *  no ConPTY backend declared, xterm's row-growth path scrolls scrollback back
   *  into the viewport, stranding a fragment of the previous TUI frame above the
   *  redraw. ConPTY reprints its own screen, so growth must append blank rows. */
  it('keeps ConPTY scrollback out of the viewport when rows grow', async () => {
    const term = new Terminal({ ...createTerminalOptions(defaultTerminalSettings), cols: 20, rows: 5 })
    await new Promise<void>((resolve) => term.write('one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\n', resolve))
    const buffer = term.buffer.active
    const topRow = () => buffer.getLine(buffer.viewportY)?.translateToString(true)

    expect(buffer.viewportY).toBeGreaterThan(0)
    const before = topRow()
    term.resize(20, 7)

    expect(topRow()).toBe(before)
    term.dispose()
  })
})

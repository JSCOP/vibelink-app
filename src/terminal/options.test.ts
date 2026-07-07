import { describe, expect, it } from 'vitest'
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
})

import { describe, expect, it } from 'vitest'
import { hangulSampleFontFamily } from './fontSample'

describe('hangulSampleFontFamily', () => {
  it('always ends in the Korean-capable fallback so Hangul never falls through to a squeezed coding font', () => {
    const stack = hangulSampleFontFamily('Cascadia Code')

    expect(stack.startsWith("'Cascadia Code'")).toBe(true)
    expect(stack).toContain("'Malgun Gothic', 'Apple SD Gothic Neo', sans-serif")
    // The terminal stack's D2Coding fallback must NOT be in the Hangul run.
    expect(stack).not.toContain('D2Coding')
  })

  it('keeps generic families unquoted', () => {
    expect(hangulSampleFontFamily('monospace').startsWith('monospace,')).toBe(true)
  })
})

import { describe, expect, it } from 'vitest'
import { defaultFontChoices, normalizeFontChoices, terminalFontStack } from './fonts'

describe('font choices', () => {
  it('keeps fallback monospace fonts when native discovery returns nothing', () => {
    expect(normalizeFontChoices([], '')).toEqual(defaultFontChoices)
  })

  it('deduplicates installed fonts and keeps the current custom font selectable', () => {
    const choices = normalizeFontChoices(['Consolas', 'Cascadia Code', 'Consolas', '  Fira Code  '], 'Custom Mono')

    expect(choices.filter((choice) => choice === 'Consolas')).toHaveLength(1)
    expect(choices).toContain('Fira Code')
    expect(choices).toContain('Custom Mono')
  })

  it('prioritizes the selected Korean-capable Nerd Font when it is installed', () => {
    const choices = normalizeFontChoices(['JetBrains Mono', 'D2CodingLigature Nerd Font Mono'], 'D2CodingLigature Nerd Font Mono')

    expect(choices[0]).toBe('D2CodingLigature Nerd Font Mono')
  })

  it('builds a CSS font stack with system fallbacks', () => {
    expect(terminalFontStack('Custom Mono')).toBe("'Custom Mono', 'D2CodingLigature Nerd Font Mono', 'Cascadia Code', 'Cascadia Mono', Consolas, 'JetBrains Mono', 'Fira Code', monospace")
  })
})

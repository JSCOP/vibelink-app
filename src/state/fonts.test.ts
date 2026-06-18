import { describe, expect, it } from 'vitest'
import { defaultFontChoices, normalizeFontChoices } from './fonts'

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
})

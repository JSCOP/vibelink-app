import { cssFontFamilyName, koreanFallbackFonts } from '../state/fonts'

const HANGUL_PROBE = '가'
// Korean-capable UI fonts whose Hangul advances are correct in DOM text.
const hangulFallbackStack = [...koreanFallbackFonts.map(cssFontFamilyName), 'sans-serif'].join(', ')
const stackByFont = new Map<string, string>()

/** Font stack for the Hangul run of a font picker sample row.
 *
 *  Monospaced CJK coding fonts (e.g. D2Coding Nerd Font Mono) carry Hangul
 *  glyphs that paint at roughly double their advance — correct in xterm's
 *  cell grid, where a wide glyph occupies two cells, but overlapping into an
 *  unreadable mess in plain DOM text. When canvas metrics show the font's own
 *  Hangul advance is narrower than its painted width, drop the font for the
 *  Hangul run and let the Korean UI fallback render it, which matches how the
 *  glyphs will actually look in a terminal pane. Fonts without Hangul
 *  coverage keep the primary first; the browser falls through to the same
 *  fallback on its own. */
export function hangulSampleFontFamily(fontFamily: string): string {
  const cached = stackByFont.get(fontFamily)
  if (cached !== undefined) return cached
  const primary = cssFontFamilyName(fontFamily)
  const stack = hangulAdvanceIsSqueezed(primary) ? hangulFallbackStack : `${primary}, ${hangulFallbackStack}`
  stackByFont.set(fontFamily, stack)
  return stack
}

function hangulAdvanceIsSqueezed(cssPrimary: string): boolean {
  if (typeof document === 'undefined') return false
  const font = `16px ${cssPrimary}`
  // Only meaningful when the font itself supplies the glyph; otherwise DOM
  // text falls through to the Korean fallback anyway. Generic families
  // (monospace) always pass check() and measure with correct advances.
  if (!document.fonts?.check(font, HANGUL_PROBE)) return false
  const context = document.createElement('canvas').getContext('2d')
  if (!context) return false
  context.font = font
  const metrics = context.measureText(HANGUL_PROBE)
  const painted = metrics.actualBoundingBoxLeft + metrics.actualBoundingBoxRight
  return metrics.width > 0 && painted > metrics.width * 1.25
}

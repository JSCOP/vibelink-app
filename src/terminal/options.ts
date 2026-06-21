import type { FontWeight, ITerminalOptions } from '@xterm/xterm'
import { terminalThemeById, defaultTerminalThemeId, type TerminalThemeId } from '../state/terminalThemes'
import { preferredFontFamily, terminalFontStack } from '../state/fonts'

export type TerminalVisualSettings = {
  fontFamily: string
  fontSize: number
  terminalFontWeight: number
  scrollback: number
  terminalThemeId: TerminalThemeId
  terminalScrollbarVisible: boolean
}

export const terminalLineHeight = 1
export const terminalLetterSpacing = 0

export const defaultTerminalSettings: TerminalVisualSettings = {
  fontFamily: preferredFontFamily,
  fontSize: 11,
  terminalFontWeight: 400,
  scrollback: 5000,
  terminalThemeId: defaultTerminalThemeId,
  terminalScrollbarVisible: false,
}

export function createTerminalOptions(settings: TerminalVisualSettings): ITerminalOptions {
  return {
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    customGlyphs: true,
    fontFamily: terminalFontStack(settings.fontFamily),
    fontSize: settings.fontSize,
    fontWeight: terminalFontWeight(settings.terminalFontWeight),
    fontWeightBold: terminalBoldFontWeight(settings.terminalFontWeight),
    letterSpacing: terminalLetterSpacing,
    lineHeight: terminalLineHeight,
    scrollback: settings.scrollback,
    minimumContrastRatio: 1,
    theme: terminalThemeById(settings.terminalThemeId),
  }
}

function terminalFontWeight(weight: number): FontWeight {
  return String(weight) as FontWeight
}

function terminalBoldFontWeight(weight: number): FontWeight {
  return String(Math.min(900, Math.max(weight, 700))) as FontWeight
}

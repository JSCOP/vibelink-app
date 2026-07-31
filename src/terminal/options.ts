import type { FontWeight, ITerminalOptions } from '@xterm/xterm'
import { terminalThemeById, defaultTerminalThemeId, type TerminalThemeId } from '../state/terminalThemes'
import { preferredFontFamily, terminalFontStack } from '../state/fonts'

export type TerminalCursorStyle = 'bar' | 'block' | 'underline'

export type TerminalVisualSettings = {
  fontFamily: string
  fontSize: number
  terminalFontWeight: number
  scrollback: number
  terminalThemeId: TerminalThemeId
  cursorStyle: TerminalCursorStyle
  cursorWidth: number
}

export const terminalLineHeight = 1
export const terminalLetterSpacing = 0

export const defaultTerminalSettings: TerminalVisualSettings = {
  fontFamily: preferredFontFamily,
  fontSize: 11,
  terminalFontWeight: 400,
  scrollback: 5000,
  terminalThemeId: defaultTerminalThemeId,
  cursorStyle: 'bar',
  cursorWidth: 1,
}

export function createTerminalOptions(settings: TerminalVisualSettings): ITerminalOptions {
  return {
    allowProposedApi: true,
    convertEol: false,
    cursorBlink: true,
    cursorStyle: settings.cursorStyle,
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
    // VibeLink always drives a local ConPTY. Without this, xterm treats a row
    // *growth* like a Unix PTY and scrolls scrollback back down into the
    // viewport (Buffer.resize: `this.ybase--; this.ydisp--`). ConPTY instead
    // reprints its own view of the screen, so those recovered lines are stale
    // debris — a freshly spawned pane that grows from its 120x32 spawn size to
    // the measured grid ends up with a stranded fragment of the previous TUI
    // frame above the redraw. Naming the backend takes the "append blank rows"
    // branch; leaving buildNumber unset keeps modern reflow on and the legacy
    // pre-21376 wrapped-row heuristics off.
    windowsPty: { backend: 'conpty' },
    ...(settings.cursorStyle === 'bar' ? { cursorWidth: settings.cursorWidth } : {}),
  }
}

function terminalFontWeight(weight: number): FontWeight {
  return String(weight) as FontWeight
}

function terminalBoldFontWeight(weight: number): FontWeight {
  return String(Math.min(900, Math.max(weight, 700))) as FontWeight
}

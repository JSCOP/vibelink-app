import type { ITerminalAddon, Terminal } from '@xterm/xterm'

/**
 * xterm 6 renders each terminal's scrollbar with VS Code's
 * `SmoothScrollableElement`, constructed in `Viewport` with
 * `vertical: ScrollbarVisibility.Auto` — the slider fades out shortly after the
 * pointer leaves the pane. We flip the scrollable element to
 * `ScrollbarVisibility.Visible`; App.css hides it again on inactive panes.
 *
 * xterm's stock FitAddon always subtracts the 14px scrollbar width whenever
 * scrollback is enabled, even though this scrollbar is an overlay. That leaves
 * a permanent blank strip on inactive panes. PaneFitAddon deliberately fits the
 * terminal to the full host width so the active pane's scrollbar overlays the
 * right edge instead of reducing every pane's PTY geometry.
 */

/** `ScrollbarVisibility.Visible` from xterm's vendored `vs/base/common/scrollable`. */
const SCROLLBAR_VISIBILITY_VISIBLE = 3
const MINIMUM_COLS = 2
const MINIMUM_ROWS = 1

type ScrollableElementLike = { updateOptions?: (options: { vertical?: number }) => void }
type RenderDimensionsLike = { css: { cell: { width: number; height: number } } }
type TerminalInternals = {
  _core?: {
    _viewport?: { _scrollableElement?: ScrollableElementLike }
    _renderService?: { dimensions: RenderDimensionsLike; clear: () => void }
  }
}

const cssPixels = (value: string, fallback: number): number => {
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export type PaneHostSize = { width: number; height: number }
export type PaneGrid = { cols: number; rows: number }

export class PaneFitAddon implements ITerminalAddon {
  private terminal?: Terminal

  activate(terminal: Terminal): void {
    this.terminal = terminal
  }

  dispose(): void {
    this.terminal = undefined
  }

  /** `hostSize` is the host's CONTENT box, the same box `getComputedStyle`
   *  reports and the same one the pane's ResizeObserver already delivers. Pass
   *  it whenever the caller holds a fresh measurement: reading it here forces a
   *  style+layout flush, and during a divider drag every pane re-measures after
   *  the previous pane's `resize()` already dirtied layout. */
  proposeDimensions(hostSize?: PaneHostSize): PaneGrid | undefined {
    const terminal = this.terminal
    const parent = terminal?.element?.parentElement
    const dimensions = (terminal as (Terminal & TerminalInternals) | undefined)?._core?._renderService?.dimensions
    if (!terminal?.element || !parent || !dimensions || dimensions.css.cell.width === 0 || dimensions.css.cell.height === 0) return undefined

    const elementStyle = window.getComputedStyle(terminal.element)
    const measured = hostSize ?? measureHost(parent)
    const horizontalPadding = cssPixels(elementStyle.paddingLeft, 0) + cssPixels(elementStyle.paddingRight, 0)
    const verticalPadding = cssPixels(elementStyle.paddingTop, 0) + cssPixels(elementStyle.paddingBottom, 0)

    return {
      cols: Math.max(MINIMUM_COLS, Math.floor((measured.width - horizontalPadding) / dimensions.css.cell.width)),
      rows: Math.max(MINIMUM_ROWS, Math.floor((measured.height - verticalPadding) / dimensions.css.cell.height)),
    }
  }

  /** Callers that already proposed a grid MUST pass it back; recomputing here
   *  doubles the forced style reads of every fit. */
  fit(proposed = this.proposeDimensions()): void {
    const terminal = this.terminal
    if (!terminal || !proposed || Number.isNaN(proposed.cols) || Number.isNaN(proposed.rows)) return
    if (terminal.cols === proposed.cols && terminal.rows === proposed.rows) return
    ;(terminal as Terminal & TerminalInternals)._core?._renderService?.clear()
    terminal.resize(proposed.cols, proposed.rows)
  }
}

function measureHost(parent: HTMLElement): PaneHostSize {
  const parentStyle = window.getComputedStyle(parent)
  return {
    width: Math.max(0, cssPixels(parentStyle.width, parent.clientWidth)),
    height: Math.max(0, cssPixels(parentStyle.height, parent.clientHeight)),
  }
}

/** Returns true when the pane's scrollbar was switched to always-visible.
 *  A false result means xterm's internal shape changed and the pane keeps its
 *  default fade-on-idle scrollbar. */
export function showPaneScrollbar(term: unknown): boolean {
  const scrollableElement = (term as TerminalInternals)?._core?._viewport?._scrollableElement
  if (typeof scrollableElement?.updateOptions !== 'function') return false
  scrollableElement.updateOptions({ vertical: SCROLLBAR_VISIBILITY_VISIBLE })
  return true
}

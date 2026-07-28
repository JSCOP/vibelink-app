/**
 * xterm 6 renders each terminal's scrollbar with VS Code's
 * `SmoothScrollableElement`, constructed in `Viewport` with
 * `vertical: ScrollbarVisibility.Auto` — the slider fades out shortly after the
 * pointer leaves the pane. Every VibeLink pane must keep its own persistent
 * scrollbar, and xterm exposes no public option for that, so we flip the
 * scrollable element to `ScrollbarVisibility.Visible`.
 *
 * The slider still hides itself while the buffer fits the viewport
 * (`ScrollbarState.isNeeded`), so a pane with no scrollback shows nothing.
 *
 * xterm's own `updateOptions` calls (`scrollSensitivity`,
 * `fastScrollSensitivity`, `overviewRuler`, mouse-protocol changes) never pass
 * `vertical`, so this override survives them and only needs applying once per
 * opened terminal.
 */

/** `ScrollbarVisibility.Visible` from xterm's vendored `vs/base/common/scrollable`. */
const SCROLLBAR_VISIBILITY_VISIBLE = 3

type ScrollableElementLike = { updateOptions?: (options: { vertical?: number }) => void }

type TerminalInternals = {
  _core?: { _viewport?: { _scrollableElement?: ScrollableElementLike } }
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

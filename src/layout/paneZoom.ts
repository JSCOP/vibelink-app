export type PaneZoomContext = {
  outerMaximized: boolean
  innerMaximized: boolean
  innerPaneCount: number
  innerActivePanelId: string | null
}

/** Where a zoom (Alt+Z) toggle must land. Terminal panes live in a nested inner
 * Dockview, so maximizing the OUTER terminalWindow panel is invisible whenever
 * that window already fills the central grid — the pane has to be maximized
 * inside its own window instead. Non-terminal content has no inner dock and
 * keeps the plain outer toggle. */
export type PaneZoomTarget =
  | { scope: 'innerPane'; panelId: string }
  | { scope: 'innerRestore' }
  | { scope: 'outerToggle' }

export function resolvePaneZoomTarget(context: PaneZoomContext): PaneZoomTarget {
  if (context.innerMaximized) return { scope: 'innerRestore' }
  if (context.outerMaximized) return { scope: 'outerToggle' }
  // A lone pane cannot be zoomed against its siblings, so zoom its window.
  if (context.innerPaneCount >= 2 && context.innerActivePanelId) {
    return { scope: 'innerPane', panelId: context.innerActivePanelId }
  }
  return { scope: 'outerToggle' }
}

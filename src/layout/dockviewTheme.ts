import type { DockviewTheme } from 'dockview-react'

/** Dockview stamps the theme's className on its internal `.dv-shell`, which
 *  sits INSIDE our styled wrapper. Without an explicit theme it falls back to
 *  `themeAbyss`, whose stock class re-declares the `--dv-*` color variables on
 *  the shell and shadows the `.dockview-theme-vibelink` values — pinning every pane
 *  tab bar to Abyss navy regardless of the selected app theme. Passing our
 *  own theme puts `dockview-theme-vibelink` on the shell, so the strip follows the
 *  `--vibelink-*` variables that `applyThemeToDocument` keeps in sync. */
export const vibelinkDockviewTheme: DockviewTheme = {
  name: 'vibelink',
  className: 'dockview-theme-vibelink',
  // Matches the previous themeAbyss fallback: flat bar, no Chrome-style wrap.
  tabGroupIndicator: 'none',
}

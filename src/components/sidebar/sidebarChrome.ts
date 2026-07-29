import { createContext } from 'react'

/**
 * True inside the subtree that owns the sidebar's persistent bottom toolbar.
 * Left-edge structural panels opt in, so whichever of them is active keeps
 * settings and help one click away without every sidebar body knowing the
 * toolbar exists.
 */
export const SidebarChromeContext = createContext(false)

import { describe, expect, it } from 'vitest'
import { resolvePaneZoomTarget } from './paneZoom'

describe('resolvePaneZoomTarget', () => {
  it('zooms the focused pane inside its terminal window instead of the window itself', () => {
    expect(resolvePaneZoomTarget({
      outerMaximized: false,
      innerMaximized: false,
      innerPaneCount: 4,
      innerActivePanelId: 'content:terminal:pane-2',
    })).toEqual({ scope: 'innerPane', panelId: 'content:terminal:pane-2' })
  })

  it('restores the inner pane first so a zoomed pane toggles back', () => {
    expect(resolvePaneZoomTarget({
      outerMaximized: false,
      innerMaximized: true,
      innerPaneCount: 4,
      innerActivePanelId: 'content:terminal:pane-2',
    })).toEqual({ scope: 'innerRestore' })
  })

  it('keeps the outer toggle for a lone pane, unknown pane, or non-terminal content', () => {
    expect(resolvePaneZoomTarget({ outerMaximized: false, innerMaximized: false, innerPaneCount: 1, innerActivePanelId: 'content:terminal:pane-1' })).toEqual({ scope: 'outerToggle' })
    expect(resolvePaneZoomTarget({ outerMaximized: false, innerMaximized: false, innerPaneCount: 3, innerActivePanelId: null })).toEqual({ scope: 'outerToggle' })
    expect(resolvePaneZoomTarget({ outerMaximized: false, innerMaximized: false, innerPaneCount: 0, innerActivePanelId: null })).toEqual({ scope: 'outerToggle' })
  })

  it('restores an outer-maximized window before zooming a pane', () => {
    expect(resolvePaneZoomTarget({
      outerMaximized: true,
      innerMaximized: false,
      innerPaneCount: 4,
      innerActivePanelId: 'content:terminal:pane-2',
    })).toEqual({ scope: 'outerToggle' })
  })
})

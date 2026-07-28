// @vitest-environment jsdom
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { PaneFitAddon, showPaneScrollbar } from './scrollbar'

// jsdom implements neither of these; xterm's CoreBrowserService needs both to
// open a terminal, and this test's whole point is exercising the real xterm
// DOM rather than a mock.
beforeAll(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  HTMLCanvasElement.prototype.getContext ??= (() => null) as unknown as typeof HTMLCanvasElement.prototype.getContext
})

/** Guards the private-API reach into xterm's viewport. An xterm upgrade that
 *  renames `_core._viewport._scrollableElement` or drops `updateOptions` must
 *  fail here rather than silently returning every pane to a fade-on-idle
 *  scrollbar. */
describe('pane scrollbar', () => {
  it('switches the pane scrollbar to always-visible', () => {
    const term = new Terminal()
    const host = document.createElement('div')
    document.body.appendChild(host)
    term.open(host)

    const scrollbar = host.querySelector('.xterm-scrollable-element > .scrollbar.vertical')
    expect(scrollbar).not.toBeNull()
    expect(scrollbar?.className).toContain('invisible')

    expect(showPaneScrollbar(term)).toBe(true)
    expect(host.querySelector('.xterm-scrollable-element > .scrollbar.vertical')?.className).toContain('visible')

    term.dispose()
    host.remove()
  })

  it('reports failure instead of throwing when the viewport is missing', () => {
    expect(showPaneScrollbar(new Terminal())).toBe(false)
    expect(showPaneScrollbar(undefined)).toBe(false)
  })
})

describe('pane terminal fit', () => {
  it('uses the full host width without reserving a hidden scrollbar gutter', () => {
    const parent = document.createElement('div')
    parent.style.width = '100px'
    parent.style.height = '80px'
    const element = document.createElement('div')
    parent.appendChild(element)
    document.body.appendChild(parent)

    const clear = vi.fn()
    const resize = vi.fn()
    const terminal = {
      element,
      cols: 2,
      rows: 1,
      resize,
      _core: {
        _renderService: {
          clear,
          dimensions: { css: { cell: { width: 10, height: 10 } } },
        },
      },
    } as unknown as Terminal
    const fit = new PaneFitAddon()
    fit.activate(terminal)

    expect(fit.proposeDimensions()).toEqual({ cols: 10, rows: 8 })
    fit.fit()
    expect(clear).toHaveBeenCalledOnce()
    expect(resize).toHaveBeenCalledWith(10, 8)

    fit.dispose()
    parent.remove()
  })
})

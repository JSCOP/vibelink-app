// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/xterm'
import { showPaneScrollbar } from './scrollbar'

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

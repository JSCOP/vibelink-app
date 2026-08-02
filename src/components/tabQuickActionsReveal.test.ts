// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The collapsing tab action rail is pure CSS, and its one real failure mode is
 * an active-tab selector that reveals controls before the pointer arrives.
 * Pull the live expansion selector out of App.css and run it against active and
 * inactive Dockview groups; none may match until its own tab is hovered or
 * keyboard-focused. */
function revealSelector(): string {
  const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8')
  const rule = css.match(/([^{}]*\.terminal-tab-quick-actions\s*\{\s*grid-template-columns:\s*1fr)/)
  if (!rule) throw new Error('no expanded-rail rule in App.css')
  return rule[1].replace(/\{[\s\S]*$/, '').trim()
}

function group(active: boolean, tabs: Array<{ active: boolean }>): HTMLElement {
  const groupview = document.createElement('div')
  groupview.className = `dv-groupview ${active ? 'dv-active-group' : 'dv-inactive-group'}`
  for (const tab of tabs) {
    const dvTab = document.createElement('div')
    dvTab.className = `dv-tab ${tab.active ? 'dv-active-tab' : 'dv-inactive-tab'}`
    const shell = document.createElement('div')
    shell.className = 'workspace-content-tab'
    const rail = document.createElement('div')
    rail.className = 'terminal-tab-quick-actions'
    shell.appendChild(rail)
    dvTab.appendChild(shell)
    groupview.appendChild(dvTab)
  }
  return groupview
}

describe('tab action rail reveal', () => {
  it('keeps every rail collapsed until its own tab is hovered or focused', () => {
    document.body.innerHTML = ''
    // A 2x1 terminal window: one pane per group, exactly one group focused.
    document.body.appendChild(group(true, [{ active: true }]))
    document.body.appendChild(group(false, [{ active: true }]))
    // Plus a stacked group, including the active tab of the focused group.
    document.body.appendChild(group(true, [{ active: true }, { active: false }]))

    const selector = revealSelector()
    const rails = Array.from(document.querySelectorAll('.terminal-tab-quick-actions'))
    expect(rails).toHaveLength(4)
    expect(rails.map((rail) => rail.matches(selector))).toEqual([false, false, false, false])
  })
})

/** Window-tab drops rely on a CSS rule and a TSX attribute agreeing on one
 * name. Rename either alone and the split overlays silently stop appearing. */
describe('workspace window chrome', () => {
  it('drops renderer overlays out of hit-testing only during an inner window drag', () => {
    const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8')
    const rule = css.match(/([^{}]*\.dv-render-overlay\s*)\{\s*pointer-events:\s*none/)
    if (!rule) throw new Error('no window-drag hit-testing rule in App.css')
    const selector = rule[1].trim()

    document.body.innerHTML = '<div class="workspace-window-container"><div class="dv-render-overlay"></div></div>'
    const container = document.querySelector('.workspace-window-container') as HTMLElement
    const overlay = document.querySelector('.dv-render-overlay') as HTMLElement
    expect(overlay.matches(selector)).toBe(false)
    container.setAttribute('data-vl-window-drag', 'true')
    expect(overlay.matches(selector)).toBe(true)

    const panel = readFileSync(join(process.cwd(), 'src/layout/WorkspaceWindowPanel.tsx'), 'utf8')
    expect(panel).toContain("setAttribute('data-vl-window-drag', 'true')")
    expect(panel).toContain("removeAttribute('data-vl-window-drag')")
  })

  it('hides the outer wrapper header until more than one window group exists', () => {
    const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8')
    const rule = css.match(/([^{}]*\.workspace-content-tab-workspaceWindow[^{}]*)\{\s*display:\s*none/)
    if (!rule) throw new Error('no singleton workspace-window header rule in App.css')
    const selector = rule[1].trim()

    document.body.innerHTML = '<div class="workspace-dock"><div class="dv-groupview"><div class="dv-tabs-and-actions-container"><div class="workspace-content-tab-workspaceWindow" data-workspace-window-grouped="false"></div></div></div></div>'
    const tab = document.querySelector('.workspace-content-tab-workspaceWindow') as HTMLElement
    const header = document.querySelector('.dv-tabs-and-actions-container') as HTMLElement
    expect(header.matches(selector)).toBe(true)
    tab.setAttribute('data-workspace-window-grouped', 'true')
    expect(header.matches(selector)).toBe(false)
  })
})

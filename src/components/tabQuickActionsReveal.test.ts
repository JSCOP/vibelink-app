// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The collapsing tab action rail is pure CSS, and its one real failure mode is
 * a selector that is true for every pane: each terminal pane sits ALONE in its
 * own Dockview group, so `.dv-active-tab` by itself matches all of them and
 * every rail expands at once — the clutter the rail replaces. Pull the live
 * selector out of App.css and run it against the real Dockview DOM shape. */
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
  it('expands only the active group\'s active tab, never every single-pane group', () => {
    document.body.innerHTML = ''
    // A 2x1 terminal window: one pane per group, exactly one group focused.
    document.body.appendChild(group(true, [{ active: true }]))
    document.body.appendChild(group(false, [{ active: true }]))
    // Plus a stacked group, to keep the hidden tab of a focused group collapsed.
    document.body.appendChild(group(true, [{ active: true }, { active: false }]))

    const selector = revealSelector()
    const rails = Array.from(document.querySelectorAll('.terminal-tab-quick-actions'))
    expect(rails).toHaveLength(4)
    // Hover/focus selectors cannot match without a pointer, so only the
    // active-group rules can fire here: rails 0 and 2.
    expect(rails.map((rail) => rail.matches(selector))).toEqual([true, false, true, false])
  })
})

/** Window-tab drops rely on a CSS rule and a TSX attribute agreeing on one
 * name. Rename either alone and the split overlays silently stop appearing,
 * which is invisible until someone drags a window again. */
describe('window drag hit-testing', () => {
  it('drops the always-rendered overlays out of hit-testing only while a window drag is active', () => {
    const css = readFileSync(join(process.cwd(), 'src/App.css'), 'utf8')
    const rule = css.match(/([^{}]*\.dv-render-overlay\s*)\{\s*pointer-events:\s*none/)
    if (!rule) throw new Error('no window-drag hit-testing rule in App.css')
    const selector = rule[1].trim()

    document.body.innerHTML = ''
    const dock = document.createElement('div')
    dock.className = 'workspace-dock'
    const overlay = document.createElement('div')
    overlay.className = 'dv-render-overlay'
    dock.appendChild(overlay)
    document.body.appendChild(dock)

    document.documentElement.removeAttribute('data-vl-window-drag')
    expect(overlay.matches(selector)).toBe(false)
    document.documentElement.setAttribute('data-vl-window-drag', 'true')
    expect(overlay.matches(selector)).toBe(true)
    document.documentElement.removeAttribute('data-vl-window-drag')

    const view = readFileSync(join(process.cwd(), 'src/layout/WorkspaceView.tsx'), 'utf8')
    expect(view).toContain("setAttribute('data-vl-window-drag', 'true')")
    expect(view).toContain("removeAttribute('data-vl-window-drag')")
  })
})

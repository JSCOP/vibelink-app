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

// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { readAppStylesheet } from '../appStylesheet.test-support'

/** The activity rail is pure CSS, and its one catastrophic failure mode is a
 * sizing rule that stops matching for a beat. The strip then falls back to the
 * horizontal pane-header height, collapses to a few pixels, and Dockview's
 * overflow observer measures EVERY rail tab as clipped: the whole rail empties
 * into the "hidden tabs" dropdown and stays there until the strip happens to
 * resize again. Two invariants make that impossible, and both live only in CSS:
 * the rules are anchored on Dockview's own `dv-groupview-header-vertical`
 * (applied from headerPosition) instead of `dv-edge-group` (stamped by the
 * shell's EdgeGroupView alone), and the strip neither clamps nor clips. */
type CssRule = { selectors: string[]; body: string }

function railRules(): CssRule[] {
  const css = readAppStylesheet()
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = [...css.matchAll(/([^{}]*dv-groupview-header-vertical[^{}]*)\{([^{}]*)\}/g)]
    .map((match) => ({ selectors: match[1].split(',').map((selector) => selector.trim()).filter(Boolean), body: match[2] }))
  if (rules.length === 0) throw new Error('no vertical activity-rail rules in the app stylesheet')
  return rules
}

function rail(): HTMLElement {
  document.body.innerHTML = ''
  const dock = document.createElement('div')
  dock.className = 'workspace-dock'
  // Deliberately WITHOUT `dv-edge-group`: that class is added by the shell's
  // EdgeGroupView, so a rail that depends on it renders collapsed whenever the
  // group element is re-created before the shell re-stamps it.
  dock.innerHTML = '<div class="dv-groupview dv-groupview-header-left">'
    + '<div class="dv-tabs-and-actions-container dv-groupview-header-vertical">'
    + '<div class="dv-scrollable"><div class="dv-tabs-container dv-tabs-container-vertical dv-vertical">'
    + '<div class="dv-tab"><div class="dv-react-part"></div></div>'
    + '</div></div></div></div>'
  document.body.appendChild(dock)
  return dock
}

function ruleFor(element: Element, rules: CssRule[]): CssRule {
  const match = rules.find((rule) => rule.selectors.some((selector) => element.matches(selector)))
  if (!match) throw new Error(`no rail rule matches .${element.className}`)
  return match
}

describe('vertical activity rail sizing', () => {
  it('sizes the rail without depending on the shell-only edge-group class', () => {
    const dock = rail()
    const rules = railRules()

    for (const rule of rules) expect(rule.selectors.join(',')).not.toContain('dv-edge-group')
    for (const selector of ['.dv-tabs-and-actions-container', '.dv-scrollable', '.dv-tabs-container-vertical', '.dv-tab', '.dv-react-part']) {
      expect(() => ruleFor(dock.querySelector(selector)!, rules), selector).not.toThrow()
    }
  })

  it('keeps the strip unclamped and unclipped so no tab can be measured as hidden', () => {
    const dock = rail()
    const rules = railRules()

    const strip = ruleFor(dock.querySelector('.dv-tabs-container-vertical')!, rules)
    expect(strip.body).toContain('max-height: none')
    expect(strip.body).toContain('overflow: visible')

    // The scroll wrapper is a flex item of the header column; letting it shrink
    // is what squeezed the strip down to a few pixels.
    const scrollable = ruleFor(dock.querySelector('.dv-scrollable')!, rules)
    expect(scrollable.body).toContain('flex: 0 0 auto')
    expect(scrollable.body).toContain('overflow: visible')
  })
})

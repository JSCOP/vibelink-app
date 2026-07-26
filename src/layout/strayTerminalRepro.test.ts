// @vitest-environment jsdom
import { createDockview } from 'dockview-core'
import { describe, expect, it } from 'vitest'
import { closeStrayTerminalPanels } from './workspaceShellModel'
import { normalizeWorkspaceLayoutState, serializeWorkspaceLayoutState } from './workspaceLayoutModel'
import { parseWorkspaceContentParams } from './workspaceContentModel'
import { userLayoutJson } from './strayTerminalRepro.fixture'

Object.defineProperty(globalThis, 'ResizeObserver', {
  configurable: true,
  value: class { observe() {} unobserve() {} disconnect() {} },
})

describe('stuck top-level terminal panel', () => {
  it('reproduces and heals the real persisted release layout', () => {
    const dockview = normalizeWorkspaceLayoutState(userLayoutJson).dockview
    expect(dockview).not.toBeNull()

    const host = document.createElement('div')
    document.body.appendChild(host)
    const api = createDockview(host, {
      createComponent: () => ({ element: document.createElement('div'), init: () => undefined }),
    })
    try {
      api.layout(2222, 1356)
      api.fromJSON(dockview as Parameters<typeof api.fromJSON>[0])

      const kinds = () => api.panels.map((panel) => parseWorkspaceContentParams(panel.params)?.kind)
      // Reproduction: the restored dock holds an outer terminal PANE panel that
      // no terminal window owns, so no close path can reach it.
      expect(kinds().filter((kind) => kind === 'terminal')).toHaveLength(1)

      expect(closeStrayTerminalPanels(api)).toEqual(['content:terminal:9c2c1343-21e1-4e2b-b8f9-955d516f962e'])

      expect(kinds().filter((kind) => kind === 'terminal')).toHaveLength(0)
      expect(kinds().filter((kind) => kind === 'terminalWindow')).toHaveLength(1)
      expect(kinds().filter((kind) => kind === 'editor')).toHaveLength(2)

      // The healed dock must survive the persist round trip, otherwise the
      // stray panel returns on the next launch.
      const healed = normalizeWorkspaceLayoutState(serializeWorkspaceLayoutState({ version: 3, dockview: api.toJSON() })).dockview
      expect(healed).not.toBeNull()
      expect(Object.keys(healed?.panels ?? {}).filter((id) => id.startsWith('content:terminal:'))).toEqual([])
      // The window still owns all eight real panes inside its nested layout.
      const windowParams = parseWorkspaceContentParams(healed?.panels['content:terminalWindow:cf22103f-c133-47f0-a706-209434133e39']?.params)
      expect(windowParams?.kind).toBe('terminalWindow')
      const inner = windowParams?.kind === 'terminalWindow' ? windowParams.inner : null
      expect(Object.keys(inner?.panels ?? {})).toHaveLength(8)
    } finally {
      api.dispose()
      host.remove()
    }
  })
})

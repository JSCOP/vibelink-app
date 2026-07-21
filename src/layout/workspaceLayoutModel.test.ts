import { describe, expect, it } from 'vitest'
import type { PaneMeta } from '../ipc/types'
import {
  createDefaultWorkspaceDockviewLayout,
  createSingletonContentParams,
  createTerminalContentParams,
  normalizeWorkspaceLayoutState,
  planTerminalArrangement,
  workspaceContentDescriptors,
  workspaceLayoutHasExactLiveTerminals,
} from './workspaceLayoutModel'
import { workspaceContentPanelId } from './workspaceContentModel'

function pane(id: string, title = 'Shell'): PaneMeta {
  return {
    id,
    alive: true,
    config: { paneId: id, args: [], env: [], title, icon: 'terminal', cols: 80, rows: 24 },
  }
}

describe('workspaceLayoutModel v3', () => {
  it('resets legacy state without migrating v2 pages or detached terminals', () => {
    expect(normalizeWorkspaceLayoutState(JSON.stringify({ version: 2, pages: [] }))).toEqual({ version: 3, dockview: null })
  })

  it('creates one outer content panel per live PTY with stable identity and full params', () => {
    const panes = [pane('pane-a', 'Alpha'), pane('pane-b', 'Beta')]
    const layout = createDefaultWorkspaceDockviewLayout(panes)
    const ids = panes.map((entry) => workspaceContentPanelId(createTerminalContentParams(entry)))

    expect(Object.keys(layout?.panels ?? {})).toEqual(ids)
    expect(layout?.panels[ids[0]]).toMatchObject({
      contentComponent: 'terminal',
      tabComponent: 'workspaceContentTab',
      renderer: 'always',
      params: { schema: 1, kind: 'terminal', instanceId: 'pane-a', paneId: 'pane-a', title: 'Alpha', icon: 'terminal' },
    })
    expect(JSON.stringify(layout)).not.toContain('vibelinkTerminalLayout')
  })

  it('defines content descriptors without a computer content kind', () => {
    expect(Object.keys(workspaceContentDescriptors)).toEqual([
      'terminal', 'browser', 'editor', 'explorer', 'workbench', 'agent', 'kanban', 'todo', 'diff',
    ])
    expect(createSingletonContentParams('workbench')).toEqual({
      schema: 1,
      kind: 'workbench',
      instanceId: 'workbench',
      title: 'Workbench',
      icon: 'git-branch',
    })
  })

  it('accepts mixed content only when terminal coverage is exact', () => {
    const panes = [pane('pane-a'), pane('pane-b')]
    const layout = createDefaultWorkspaceDockviewLayout(panes)!
    const explorer = createSingletonContentParams('explorer')
    const explorerId = workspaceContentPanelId(explorer)
    layout.panels[explorerId] = {
      id: explorerId,
      contentComponent: 'explorer',
      tabComponent: 'workspaceContentTab',
      params: explorer,
      title: explorer.title,
      renderer: 'always',
    }
    const firstLeaf = (layout.grid.root as { data: Array<{ data: { views: string[] } }> }).data[0]
    firstLeaf.data.views.push(explorerId)

    expect(workspaceLayoutHasExactLiveTerminals({ version: 3, dockview: layout }, ['pane-a', 'pane-b'])).toBe(true)
    expect(workspaceLayoutHasExactLiveTerminals({ version: 3, dockview: layout }, ['pane-a', 'pane-b', 'pane-c'])).toBe(false)
  })

  it('plans a row-major native Dockview terminal arrangement', () => {
    expect(planTerminalArrangement(['a', 'b', 'c', 'd'], { cols: 2, rows: 2 })).toEqual([
      { panelId: 'b', referencePanelId: 'a', position: 'right' },
      { panelId: 'c', referencePanelId: 'a', position: 'bottom' },
      { panelId: 'd', referencePanelId: 'c', position: 'right' },
    ])
  })
})

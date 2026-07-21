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

  it('creates an Explorer-left fallback plus one content panel per live PTY', () => {
    const panes = [pane('pane-a', 'Alpha'), pane('pane-b', 'Beta')]
    const layout = createDefaultWorkspaceDockviewLayout(panes)
    const explorerId = workspaceContentPanelId(createSingletonContentParams('explorer'))
    const terminalIds = panes.map((entry) => workspaceContentPanelId(createTerminalContentParams(entry)))

    expect(Object.keys(layout.panels)).toEqual([explorerId, ...terminalIds])
    expect(layout.panels[explorerId]).toMatchObject({
      contentComponent: 'explorer',
      params: { schema: 1, kind: 'explorer', instanceId: 'explorer', title: 'Explorer', icon: 'folder-tree' },
    })
    expect(layout.panels[terminalIds[0]]).toMatchObject({
      contentComponent: 'terminal',
      tabComponent: 'workspaceContentTab',
      renderer: 'always',
      params: { schema: 1, kind: 'terminal', instanceId: 'pane-a', paneId: 'pane-a', title: 'Alpha', icon: 'terminal' },
    })
    const root = layout.grid.root as { type: string; data: Array<{ data: { views: string[]; id: string } }> }
    expect(root.type).toBe('branch')
    expect(root.data[0].data.views).toEqual([explorerId])
    expect(layout.activeGroup).not.toBe(root.data[0].data.id)
    expect(JSON.stringify(layout)).not.toContain('vibelinkTerminalLayout')
  })

  it('defines all supported content descriptors without a computer content kind', () => {
    expect(Object.keys(workspaceContentDescriptors)).toEqual([
      'terminal', 'browser', 'editor', 'explorer', 'workbench', 'agent', 'orchestration', 'kanban', 'todo', 'diff',
    ])
    expect(createSingletonContentParams('workbench')).toEqual({
      schema: 1,
      kind: 'workbench',
      instanceId: 'workbench',
      title: 'Workbench',
      icon: 'git-branch',
    })
    expect(createSingletonContentParams('orchestration')).toEqual({
      schema: 1,
      kind: 'orchestration',
      instanceId: 'orchestration',
      title: 'Orchestration',
      icon: 'monitor-cog',
    })
  })

  it('preserves exact live terminal coverage when non-terminal panels are present', () => {
    const panes = [pane('pane-a'), pane('pane-b')]
    const layout = createDefaultWorkspaceDockviewLayout(panes)

    expect(workspaceLayoutHasExactLiveTerminals({ version: 3, dockview: layout }, ['pane-a', 'pane-b'])).toBe(true)
    expect(workspaceLayoutHasExactLiveTerminals({ version: 3, dockview: layout }, ['pane-a', 'pane-b', 'pane-c'])).toBe(false)
    expect(workspaceLayoutHasExactLiveTerminals({ version: 3, dockview: layout }, ['pane-a'])).toBe(false)
    expect(workspaceLayoutHasExactLiveTerminals({ version: 3, dockview: layout }, ['pane-a', 'pane-a'])).toBe(false)
  })

  it('plans a row-major native Dockview terminal arrangement', () => {
    expect(planTerminalArrangement(['a', 'b', 'c', 'd'], { cols: 2, rows: 2 })).toEqual([
      { panelId: 'b', referencePanelId: 'a', position: 'right' },
      { panelId: 'c', referencePanelId: 'a', position: 'bottom' },
      { panelId: 'd', referencePanelId: 'c', position: 'right' },
    ])
  })
})

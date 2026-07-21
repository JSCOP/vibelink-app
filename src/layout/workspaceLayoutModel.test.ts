import { describe, expect, it } from 'vitest'
import type { PaneMeta } from '../ipc/types'
import {
  createDefaultWorkspaceDockviewLayout,
  createPreviewContentParams,
  createSingletonContentParams,
  createTerminalContentParams,
  normalizeWorkspaceLayoutState,
  planTerminalArrangement,
  workspaceContentDescriptors,
  workspaceDefaultEdgeCollapse,
  workspaceEdgeCollapsedSize,
  workspaceLeftEdgeGroupId,
  workspaceLeftStructuralKinds,
  workspaceRightEdgeGroupId,
  workspaceRightStructuralKinds,
  workspaceLayoutHasExactLiveTerminals,
} from './workspaceLayoutModel'
import { parseWorkspaceContentParams, workspaceContentPanelId, workspaceContentResourceKey } from './workspaceContentModel'

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

  it('creates central terminals plus exact fixed edge groups', () => {
    const panes = [pane('pane-a', 'Alpha'), pane('pane-b', 'Beta')]
    const layout = createDefaultWorkspaceDockviewLayout(panes, 1600)
    const terminalIds = panes.map((entry) => workspaceContentPanelId(createTerminalContentParams(entry)))
    const leftIds = workspaceLeftStructuralKinds.map((kind) => workspaceContentPanelId(createSingletonContentParams(kind)))
    const rightIds = workspaceRightStructuralKinds.map((kind) => workspaceContentPanelId(createSingletonContentParams(kind)))

    expect(Object.keys(layout.panels)).toEqual([...leftIds, ...rightIds, ...terminalIds])
    expect(layout.edgeGroups).toEqual({
      left: {
        size: 300,
        visible: true,
        collapsed: undefined,
        group: { id: workspaceLeftEdgeGroupId, views: leftIds, activeView: leftIds[0] },
      },
      right: {
        size: 340,
        visible: true,
        collapsed: undefined,
        group: { id: workspaceRightEdgeGroupId, views: rightIds, activeView: rightIds[0] },
      },
    })
    const serializedRoot = JSON.stringify(layout.grid.root)
    expect(serializedRoot).toContain(terminalIds[0])
    expect(serializedRoot).not.toContain(leftIds[0])
    expect(serializedRoot).not.toContain(rightIds[0])
    expect(layout.activeGroup).toMatch(/^content-group-/)
    expect(JSON.stringify(layout)).not.toContain('vibelinkTerminalLayout')
  })

  it('uses deterministic width-sensitive default collapse without changing expanded sizes', () => {
    expect(workspaceDefaultEdgeCollapse(1600)).toEqual({ left: false, right: false })
    expect(workspaceDefaultEdgeCollapse(1100)).toEqual({ left: false, right: true })
    expect(workspaceDefaultEdgeCollapse(899)).toEqual({ left: true, right: true })
    expect(workspaceEdgeCollapsedSize).toBe(38)
    expect(createDefaultWorkspaceDockviewLayout([], 1100).edgeGroups?.right).toMatchObject({ size: 340, collapsed: true })
  })

  it('round-trips an edge-only layout and later accepts a first central panel', () => {
    const edgeOnly = createDefaultWorkspaceDockviewLayout([], 1600)
    expect(edgeOnly.grid.root).toEqual({ type: 'branch', data: [], size: 640 })
    expect(edgeOnly.activeGroup).toBeUndefined()

    const normalizedEdgeOnly = normalizeWorkspaceLayoutState(JSON.stringify({ version: 3, dockview: edgeOnly }))
    expect(normalizedEdgeOnly.dockview).toEqual(edgeOnly)
    expect(workspaceLayoutHasExactLiveTerminals(normalizedEdgeOnly, [])).toBe(true)

    const withTerminal = createDefaultWorkspaceDockviewLayout([pane('pane-a')], 1600)
    expect(normalizeWorkspaceLayoutState(JSON.stringify({ version: 3, dockview: withTerminal })).dockview).toEqual(withTerminal)
    expect(workspaceLayoutHasExactLiveTerminals({ version: 3, dockview: withTerminal }, ['pane-a'])).toBe(true)
  })

  it('defines every built-in content descriptor and Preview singleton identity', () => {
    expect(Object.keys(workspaceContentDescriptors)).toEqual([
      'terminal', 'browser', 'editor', 'preview', 'explorer', 'sourceControl', 'gitHistory', 'gitBranches', 'workbench', 'agent', 'orchestration', 'kanban', 'todo', 'diff', 'agentSessions',
    ])
    expect(createSingletonContentParams('sourceControl')).toEqual({
      schema: 1,
      kind: 'sourceControl',
      instanceId: 'sourceControl',
      title: 'Source Control',
      icon: 'git-compare-arrows',
    })
    const preview = createPreviewContentParams('src\\changed.ts')
    expect(preview).toEqual({ schema: 1, kind: 'preview', instanceId: 'preview', title: 'changed.ts', icon: 'file-search', relPath: 'src/changed.ts' })
    expect(workspaceContentPanelId(preview)).toBe('content:preview:preview')
    expect(workspaceContentResourceKey(preview)).toBe('preview')
    expect(parseWorkspaceContentParams(preview)).toEqual(preview)
    expect(() => createPreviewContentParams('../secret.txt')).toThrow(/workspace-relative/)
  })

  it('preserves exact live terminal coverage when edge panels are present', () => {
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

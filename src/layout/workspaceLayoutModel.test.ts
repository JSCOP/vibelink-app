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
  createTerminalWindowParams,
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

  it('wraps central terminals in one terminal window plus exact fixed edge groups', () => {
    const panes = [pane('pane-a', 'Alpha'), pane('pane-b', 'Beta')]
    const layout = createDefaultWorkspaceDockviewLayout(panes, 1600)
    const leftIds = workspaceLeftStructuralKinds.map((kind) => workspaceContentPanelId(createSingletonContentParams(kind)))
    const rightIds = workspaceRightStructuralKinds.map((kind) => workspaceContentPanelId(createSingletonContentParams(kind)))

    // Terminals no longer appear as top-level panels; they live inside a single
    // terminalWindow panel's nested inner Dockview.
    const panelIds = Object.keys(layout.panels)
    expect(panelIds.slice(0, leftIds.length + rightIds.length)).toEqual([...leftIds, ...rightIds])
    const windowIds = panelIds.filter((id) => id.startsWith('content:terminalWindow:'))
    expect(windowIds).toHaveLength(1)
    const windowPanel = layout.panels[windowIds[0]]
    expect(windowPanel.contentComponent).toBe('terminalWindow')
    const innerPanels = Object.values((windowPanel.params as { inner: { panels: Record<string, unknown> } }).inner.panels)
    expect(innerPanels.map((p) => (p as { contentComponent: string }).contentComponent)).toEqual(['terminal', 'terminal'])
    expect(innerPanels.map((p) => (p as { params: { paneId: string } }).params.paneId)).toEqual(['pane-a', 'pane-b'])

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
    expect(serializedRoot).toContain(windowIds[0])
    expect(serializedRoot).not.toContain(leftIds[0])
    expect(serializedRoot).not.toContain(rightIds[0])
    expect(layout.activeGroup).toMatch(/^content-group-/)
  })

  it('uses deterministic width-sensitive default collapse without changing expanded sizes', () => {
    expect(workspaceDefaultEdgeCollapse(1600)).toEqual({ left: false, right: false })
    expect(workspaceDefaultEdgeCollapse(1100)).toEqual({ left: false, right: true })
    expect(workspaceDefaultEdgeCollapse(899)).toEqual({ left: true, right: true })
    expect(workspaceEdgeCollapsedSize).toBe(38)
    expect(createDefaultWorkspaceDockviewLayout([], 1100).edgeGroups?.right).toMatchObject({ size: 340, collapsed: true })
  })

  it('round-trips a default terminal-window layout and an empty terminal window', () => {
    const empty = createDefaultWorkspaceDockviewLayout([], 1600)
    // Even with zero panes the central grid holds one (empty) terminal window.
    const emptyWindowIds = Object.keys(empty.panels).filter((id) => id.startsWith('content:terminalWindow:'))
    expect(emptyWindowIds).toHaveLength(1)
    expect(empty.activeGroup).toMatch(/^content-group-/)
    expect(normalizeWorkspaceLayoutState(JSON.stringify({ version: 3, dockview: empty })).dockview).toEqual(empty)

    const withTerminal = createDefaultWorkspaceDockviewLayout([pane('pane-a')], 1600)
    expect(normalizeWorkspaceLayoutState(JSON.stringify({ version: 3, dockview: withTerminal })).dockview).toEqual(withTerminal)
  })

  it('defines every built-in content descriptor and Preview singleton identity', () => {
    expect(Object.keys(workspaceContentDescriptors)).toEqual([
      'terminal', 'terminalWindow', 'browser', 'editor', 'preview', 'workspaces', 'explorer', 'sourceControl', 'gitHistory', 'gitBranches', 'workbench', 'agent', 'orchestration', 'kanban', 'todo', 'diff', 'agentSessions',
    ])
    expect(createSingletonContentParams('workspaces')).toEqual({
      schema: 1,
      kind: 'workspaces',
      instanceId: 'workspaces',
      title: 'Workspaces',
      icon: 'folder',
    })
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

  it('builds a terminal window whose inner layout holds one leaf per pane', () => {
    const paneParams = [createTerminalContentParams(pane('pane-a', 'Alpha')), createTerminalContentParams(pane('pane-b', 'Beta'))]
    const params = createTerminalWindowParams('win-1', paneParams, { cols: 2, rows: 1 })
    expect(params.kind).toBe('terminalWindow')
    expect(params.titlesHidden).toBe(false)
    expect(params.inner).not.toBeNull()
    const innerPanels = Object.keys(params.inner?.panels ?? {})
    expect(innerPanels).toEqual(['content:terminal:pane-a', 'content:terminal:pane-b'])
    // An empty terminal window has a null inner layout (rebuilt from live panes).
    expect(createTerminalWindowParams('win-2', [], { cols: 1, rows: 1 }).inner).toBeNull()
  })

  it('places later rows below the pane in the same column', () => {
    expect(planTerminalArrangement(['a', 'b', 'c', 'd'], { cols: 2, rows: 2 })).toEqual([
      { panelId: 'b', referencePanelId: 'a', position: 'right' },
      { panelId: 'c', referencePanelId: 'a', position: 'bottom' },
      { panelId: 'd', referencePanelId: 'b', position: 'bottom' },
    ])
  })

  it('plans a flat 4x2 grid instead of nesting the second row under column one', () => {
    expect(planTerminalArrangement(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], { cols: 4, rows: 2 })).toEqual([
      { panelId: 'b', referencePanelId: 'a', position: 'right' },
      { panelId: 'c', referencePanelId: 'b', position: 'right' },
      { panelId: 'd', referencePanelId: 'c', position: 'right' },
      { panelId: 'e', referencePanelId: 'a', position: 'bottom' },
      { panelId: 'f', referencePanelId: 'b', position: 'bottom' },
      { panelId: 'g', referencePanelId: 'c', position: 'bottom' },
      { panelId: 'h', referencePanelId: 'd', position: 'bottom' },
    ])
  })
})

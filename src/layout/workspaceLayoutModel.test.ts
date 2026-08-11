import { describe, expect, it } from 'vitest'
import type { PaneMeta } from '../ipc/types'
import {
  createDefaultWorkspaceDockviewLayout,
  completeWorkspaceStructuralLayout,
  createPreviewContentParams,
  createSingletonContentParams,
  createTerminalContentParams,
  createWorkspaceContentPanel,
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
import { isStructuralWorkspaceContentKind, parseWorkspaceContentParams, workspaceContentPanelId, workspaceContentResourceKey } from './workspaceContentModel'

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

  it('places the terminal window directly in the workspace grid with no wrapper tab', () => {
    const panes = [pane('pane-a', 'Alpha'), pane('pane-b', 'Beta')]
    const layout = createDefaultWorkspaceDockviewLayout(panes, 1600)
    const leftIds = workspaceLeftStructuralKinds.map((kind) => workspaceContentPanelId(createSingletonContentParams(kind)))
    const rightIds = workspaceRightStructuralKinds.map((kind) => workspaceContentPanelId(createSingletonContentParams(kind)))

    const panelIds = Object.keys(layout.panels)
    expect(panelIds.slice(0, leftIds.length + rightIds.length)).toEqual([...leftIds, ...rightIds])
    expect(panelIds.filter((id) => id.startsWith('content:workspaceWindow:'))).toHaveLength(0)
    const terminalWindowIds = panelIds.filter((id) => id.startsWith('content:terminalWindow:'))
    expect(terminalWindowIds).toHaveLength(1)
    const terminalWindowParams = parseWorkspaceContentParams(layout.panels[terminalWindowIds[0]].params)
    expect(terminalWindowParams?.kind).toBe('terminalWindow')
    if (terminalWindowParams?.kind !== 'terminalWindow' || !terminalWindowParams.inner) throw new Error('Missing terminal window layout')
    const paneIds = Object.values(terminalWindowParams.inner.panels).flatMap((entry) => {
      const params = parseWorkspaceContentParams(entry.params)
      return params?.kind === 'terminal' ? [params.paneId] : []
    })
    expect(paneIds).toEqual(['pane-a', 'pane-b'])

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
    expect(layout.grid.root.type).toBe('branch')
    // The terminal window is a leaf of the WORKSPACE grid now, so a second
    // content tab splits that same grid instead of a nested one.
    expect(JSON.stringify(layout.grid.root)).toContain(terminalWindowIds[0])
    expect(layout.activeGroup).toMatch(/^content-group-/)
  })

  it('hoists a pre-cutover Window Group layout back into the workspace grid instead of resetting it', () => {
    // Exactly the shape the removed `wrapWorkspaceWindowLayout` used to save:
    // sidebars outside, every central tab nested in one `workspaceWindow`.
    const current = createDefaultWorkspaceDockviewLayout([pane('pane-a')], 1600)
    const structuralPanels = Object.fromEntries(Object.entries(current.panels).filter(([, panel]) => {
      const params = parseWorkspaceContentParams(panel.params)
      return params && isStructuralWorkspaceContentKind(params.kind)
    }))
    const editorParams = { schema: 1 as const, kind: 'editor' as const, instanceId: 'AGENTS.md', title: 'AGENTS.md', icon: 'file-code', relPath: 'AGENTS.md' }
    const editorId = workspaceContentPanelId(editorParams)
    const terminalWindowId = Object.keys(current.panels).find((id) => id.startsWith('content:terminalWindow:'))
    if (!terminalWindowId) throw new Error('Missing terminal window panel')
    const inner = {
      panels: { [terminalWindowId]: current.panels[terminalWindowId], [editorId]: createWorkspaceContentPanel(editorParams) },
      grid: {
        root: {
          type: 'branch' as const,
          data: [
            { type: 'leaf' as const, data: { views: [terminalWindowId], activeView: terminalWindowId, id: 'content-group-0' }, size: 800 },
            { type: 'leaf' as const, data: { views: [editorId], activeView: editorId, id: 'legacy-editor-group' }, size: 800 },
          ],
          size: 1600,
        },
        width: 1600,
        height: 640,
        orientation: 'HORIZONTAL',
      },
      activeGroup: 'legacy-editor-group',
    }
    const wrapperParams = { schema: 1, kind: 'workspaceWindow', instanceId: 'legacy-window', title: 'Terminal + AGENTS.md', icon: 'layout-grid', inner }
    const wrapperId = 'content:workspaceWindow:legacy-window'
    const legacy = {
      panels: {
        ...structuralPanels,
        [wrapperId]: { id: wrapperId, contentComponent: 'workspaceWindow', tabComponent: 'workspaceContentTab', params: wrapperParams, title: wrapperParams.title, renderer: 'always' },
      },
      grid: {
        root: { type: 'branch', data: [{ type: 'leaf', data: { views: [wrapperId], activeView: wrapperId, id: 'workspace-window-group' }, size: 1600 }], size: 1600 },
        width: 1600,
        height: 640,
        orientation: 'HORIZONTAL',
      },
      activeGroup: 'workspace-window-group',
      edgeGroups: current.edgeGroups,
    }

    const restored = normalizeWorkspaceLayoutState(JSON.stringify({ version: 3, dockview: legacy })).dockview
    if (!restored) throw new Error('Legacy Window Group layout was rejected instead of migrated')
    expect(Object.keys(restored.panels)).not.toContain(wrapperId)
    expect(Object.keys(restored.panels)).toEqual(expect.arrayContaining([...Object.keys(structuralPanels), terminalWindowId, editorId]))
    // The split geometry the user arranged survives verbatim.
    expect(restored.grid.root).toEqual(inner.grid.root)
    expect(restored.activeGroup).toBe('legacy-editor-group')
    expect(restored.edgeGroups).toEqual(current.edgeGroups)
  })

  it('completes older edge layouts before reuse without replacing their active tab', () => {
    const layout = createDefaultWorkspaceDockviewLayout([], 1600)
    const explorerId = workspaceContentPanelId(createSingletonContentParams('explorer'))
    const workspaceFilesId = workspaceContentPanelId(createSingletonContentParams('workspaceFiles'))
    const sourceControlId = workspaceContentPanelId(createSingletonContentParams('sourceControl'))
    delete layout.panels[explorerId]
    delete layout.panels[workspaceFilesId]
    const leftGroup = layout.edgeGroups?.left?.group as { views: string[]; activeView?: string }
    const rightGroup = layout.edgeGroups?.right?.group as { views: string[]; activeView?: string }
    leftGroup.views = leftGroup.views.filter((id) => id !== explorerId)
    rightGroup.views = rightGroup.views.filter((id) => id !== workspaceFilesId)
    rightGroup.activeView = sourceControlId

    const completed = completeWorkspaceStructuralLayout(layout, 1600)
    const completedLeft = completed.edgeGroups?.left?.group as { views: string[] }
    const completedRight = completed.edgeGroups?.right?.group as { views: string[]; activeView?: string }

    expect(completedLeft.views).toEqual(workspaceLeftStructuralKinds.map((kind) => workspaceContentPanelId(createSingletonContentParams(kind))))
    expect(completedRight.views).toEqual(workspaceRightStructuralKinds.map((kind) => workspaceContentPanelId(createSingletonContentParams(kind))))
    expect(completed.panels[explorerId]).toBeDefined()
    expect(completed.panels[workspaceFilesId]).toBeDefined()
    expect(completedRight.activeView).toBe(sourceControlId)
  })

  it('uses deterministic width-sensitive default collapse without changing expanded sizes', () => {
    expect(workspaceDefaultEdgeCollapse(1600)).toEqual({ left: false, right: false })
    expect(workspaceDefaultEdgeCollapse(1100)).toEqual({ left: false, right: true })
    expect(workspaceDefaultEdgeCollapse(899)).toEqual({ left: true, right: true })
    expect(workspaceEdgeCollapsedSize).toBe(38)
    expect(createDefaultWorkspaceDockviewLayout([], 1100).edgeGroups?.right).toMatchObject({ size: 340, collapsed: true })
  })

  it('round-trips layouts with populated and empty terminal windows', () => {
    const empty = createDefaultWorkspaceDockviewLayout([], 1600)
    expect(Object.keys(empty.panels).filter((id) => id.startsWith('content:terminalWindow:'))).toHaveLength(1)
    expect(empty.activeGroup).toMatch(/^content-group-/)
    expect(normalizeWorkspaceLayoutState(JSON.stringify({ version: 3, dockview: empty })).dockview).toEqual(empty)

    const withTerminal = createDefaultWorkspaceDockviewLayout([pane('pane-a')], 1600)
    expect(normalizeWorkspaceLayoutState(JSON.stringify({ version: 3, dockview: withTerminal })).dockview).toEqual(withTerminal)
  })

  it('defines every built-in content descriptor and Preview singleton identity', () => {
    expect(Object.keys(workspaceContentDescriptors)).toEqual([
      'terminal', 'terminalWindow', 'browser', 'editor', 'preview', 'workspaces', 'explorer', 'workspaceFiles', 'sourceControl', 'gitHistory', 'gitBranches', 'automation', 'workbench', 'agent', 'orchestration', 'kanban', 'todo', 'diff', 'agentSessions', 'memory',
    ])
    expect(createSingletonContentParams('workspaces')).toEqual({
      schema: 1,
      kind: 'workspaces',
      instanceId: 'workspaces',
      title: 'Workspaces',
      icon: 'folder',
    })
    expect(createSingletonContentParams('workspaceFiles')).toEqual({
      schema: 1,
      kind: 'workspaceFiles',
      instanceId: 'workspaceFiles',
      title: 'Workspace Files',
      icon: 'file-search',
    })

    expect(createSingletonContentParams('sourceControl')).toEqual({
      schema: 1,
      kind: 'sourceControl',
      instanceId: 'sourceControl',
      title: 'Source Control',
      icon: 'git-compare-arrows',
    })
    expect(createSingletonContentParams('automation')).toEqual({
      schema: 1,
      kind: 'automation',
      instanceId: 'automation',
      title: 'Automations',
      icon: 'timer',
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

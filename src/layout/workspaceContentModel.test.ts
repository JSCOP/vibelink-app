import { describe, expect, it } from 'vitest'
import type { WorkspaceContentParams } from './workspaceContentModel'
import {
  freshWorkspaceLayoutEnvelope,
  isCentralWorkspaceContentKind,
  isLeftStructuralWorkspaceContentKind,
  isRightStructuralWorkspaceContentKind,
  isStructuralWorkspaceContentKind,
  normalizeWorkspaceLayoutEnvelope,
  normalizeWorkspaceRelativePath,
  parseWorkspaceContentParams,
  workspaceContentPanelId,
  workspaceContentResourceKey,
} from './workspaceContentModel'

const dockview = (panels: Record<string, unknown>) => ({
  panels,
  grid: {
    root: { type: 'leaf', data: { views: Object.keys(panels), activeView: Object.keys(panels)[0], id: 'group-1' }, size: 1000 },
    width: 1000,
    height: 600,
    orientation: 'HORIZONTAL',
  },
  activeGroup: 'group-1',
})

const panel = (params: WorkspaceContentParams) => ({
  id: workspaceContentPanelId(params),
  contentComponent: params.kind,
  tabComponent: 'workspaceContentTab',
  params,
  title: params.title,
  renderer: 'always',
})

describe('workspace content model', () => {
  it('accepts a valid mixed-content v3 envelope', () => {
    const terminal: WorkspaceContentParams = { schema: 1, kind: 'terminal', instanceId: 'pane-1', title: 'Shell', icon: 'terminal', paneId: 'pane-1' }
    const editor: WorkspaceContentParams = { schema: 1, kind: 'editor', instanceId: 'src/App.tsx', title: 'App.tsx', icon: 'file-code', relPath: 'src/App.tsx' }
    const workbench: WorkspaceContentParams = { schema: 1, kind: 'workbench', instanceId: 'workbench', title: 'Workbench', icon: 'git-branch' }
    const panels = Object.fromEntries([terminal, editor, workbench].map((params) => [workspaceContentPanelId(params), panel(params)]))

    const normalized = normalizeWorkspaceLayoutEnvelope(JSON.stringify({ version: 3, dockview: dockview(panels) }))

    expect(normalized.version).toBe(3)
    expect(Object.keys(normalized.dockview?.panels ?? {})).toEqual([
      'content:terminal:pane-1',
      'content:editor:src/App.tsx',
      'content:workbench:workbench',
    ])
  })

  it.each([
    null,
    '{',
    JSON.stringify({ version: 2, pages: [] }),
    JSON.stringify({ version: 4, dockview: null }),
    JSON.stringify({ version: 3, dockview: { panels: {}, grid: null } }),
  ])('resets invalid and non-v3 state instead of migrating it: %s', (raw) => {
    expect(normalizeWorkspaceLayoutEnvelope(raw)).toEqual(freshWorkspaceLayoutEnvelope())
  })

  it('rejects malformed params, panel identity mismatches, and duplicate resources', () => {
    const terminal: WorkspaceContentParams = { schema: 1, kind: 'terminal', instanceId: 'pane-1', title: 'Shell', icon: 'terminal', paneId: 'pane-1' }
    const duplicate: WorkspaceContentParams = { ...terminal, instanceId: 'duplicate' }
    const duplicatePanels = {
      [workspaceContentPanelId(terminal)]: panel(terminal),
      [workspaceContentPanelId(duplicate)]: panel(duplicate),
    }
    expect(normalizeWorkspaceLayoutEnvelope(JSON.stringify({ version: 3, dockview: dockview(duplicatePanels) }))).toEqual(freshWorkspaceLayoutEnvelope())

    const mismatched = { 'wrong-id': panel(terminal) }
    expect(normalizeWorkspaceLayoutEnvelope(JSON.stringify({ version: 3, dockview: dockview(mismatched) }))).toEqual(freshWorkspaceLayoutEnvelope())

    expect(parseWorkspaceContentParams({ ...terminal, schema: 2 })).toBeNull()
    expect(parseWorkspaceContentParams({ ...terminal, kind: 'computer' })).toBeNull()
    expect(parseWorkspaceContentParams({ ...terminal, instanceId: 'other-pane' })).toBeNull()
    expect(parseWorkspaceContentParams({ ...terminal, extra: true })).toBeNull()
    expect(parseWorkspaceContentParams({ schema: 1, kind: 'workbench', instanceId: 'other', title: 'Workbench', icon: 'git-branch' })).toBeNull()
  })

  it('rejects duplicate structural singleton references across grid and edge groups', () => {
    const explorer: WorkspaceContentParams = { schema: 1, kind: 'explorer', instanceId: 'explorer', title: 'Explorer', icon: 'folder-tree' }
    const explorerId = workspaceContentPanelId(explorer)
    const candidate = {
      ...dockview({ [explorerId]: panel(explorer) }),
      edgeGroups: {
        left: { size: 300, visible: true, group: { id: 'workspace-left-tools', views: [explorerId], activeView: explorerId } },
      },
    }
    expect(normalizeWorkspaceLayoutEnvelope(JSON.stringify({ version: 3, dockview: candidate }))).toEqual(freshWorkspaceLayoutEnvelope())
  })
  it('classifies structural edge and central content kinds', () => {
    expect(isLeftStructuralWorkspaceContentKind('explorer')).toBe(true)
    expect(isLeftStructuralWorkspaceContentKind('gitBranches')).toBe(true)
    expect(isRightStructuralWorkspaceContentKind('agentSessions')).toBe(true)
    expect(isStructuralWorkspaceContentKind('sourceControl')).toBe(true)
    expect(isStructuralWorkspaceContentKind('preview')).toBe(false)
    expect(isCentralWorkspaceContentKind('preview')).toBe(true)
    expect(isCentralWorkspaceContentKind('terminal')).toBe(true)
  })

  it('rejects zero geometry, dangling panels, duplicate views or groups, and invalid active or maximized references', () => {
    const terminal: WorkspaceContentParams = { schema: 1, kind: 'terminal', instanceId: 'pane-1', title: 'Shell', icon: 'terminal', paneId: 'pane-1' }
    const editor: WorkspaceContentParams = { schema: 1, kind: 'editor', instanceId: 'src/App.tsx', title: 'App.tsx', icon: 'file-code', relPath: 'src/App.tsx' }
    const terminalId = workspaceContentPanelId(terminal)
    const editorId = workspaceContentPanelId(editor)
    const panels = { [terminalId]: panel(terminal), [editorId]: panel(editor) }
    const valid = dockview(panels)
    const rejects = (candidate: unknown) => {
      expect(normalizeWorkspaceLayoutEnvelope(JSON.stringify({ version: 3, dockview: candidate }))).toEqual(freshWorkspaceLayoutEnvelope())
    }

    rejects({ ...valid, grid: { ...valid.grid, width: 0 } })
    rejects({ ...valid, grid: { ...valid.grid, height: 0 } })
    rejects({ ...valid, grid: { ...valid.grid, root: { ...valid.grid.root, size: 0 } } })
    rejects({ ...valid, grid: { ...valid.grid, root: { ...valid.grid.root, data: { ...valid.grid.root.data, views: ['missing'], activeView: 'missing' } } } })
    rejects({ ...valid, grid: { ...valid.grid, root: { ...valid.grid.root, data: { ...valid.grid.root.data, views: [terminalId], activeView: terminalId } } } })
    rejects({ ...valid, grid: { ...valid.grid, root: { ...valid.grid.root, data: { ...valid.grid.root.data, views: [terminalId, terminalId], activeView: terminalId } } } })
    rejects({ ...valid, grid: { ...valid.grid, root: { ...valid.grid.root, data: { ...valid.grid.root.data, activeView: 'missing' } } } })
    rejects({ ...valid, activeGroup: 'missing-group' })
    rejects({ ...valid, grid: { ...valid.grid, maximizedNode: { location: [1] } } })
    rejects({
      ...valid,
      grid: {
        ...valid.grid,
        root: {
          type: 'branch',
          size: 1000,
          data: [
            { type: 'leaf', size: 500, data: { id: 'duplicate-group', views: [terminalId], activeView: terminalId } },
            { type: 'leaf', size: 500, data: { id: 'duplicate-group', views: [editorId], activeView: editorId } },
          ],
        },
      },
    })
  })

  it('allows only normalized workspace-relative editor paths', () => {
    expect(normalizeWorkspaceRelativePath('src\\App.tsx')).toBe('src/App.tsx')
    expect(normalizeWorkspaceRelativePath('../secret.txt')).toBeNull()
    expect(normalizeWorkspaceRelativePath('C:/secret.txt')).toBeNull()
    expect(normalizeWorkspaceRelativePath('/absolute.txt')).toBeNull()
    expect(normalizeWorkspaceRelativePath('src//App.tsx')).toBeNull()

    expect(parseWorkspaceContentParams({
      schema: 1,
      kind: 'editor',
      instanceId: 'src/App.tsx',
      title: 'App.tsx',
      icon: 'file-code',
      relPath: 'src\\App.tsx',
    })).toEqual({
      schema: 1,
      kind: 'editor',
      instanceId: 'src/App.tsx',
      title: 'App.tsx',
      icon: 'file-code',
      relPath: 'src/App.tsx',
    })
  })

  it('normalizes Preview paths while preserving singleton panel/resource identity', () => {
    const preview = parseWorkspaceContentParams({
      schema: 1,
      kind: 'preview',
      instanceId: 'preview',
      title: 'changed.ts',
      icon: 'file-search',
      relPath: 'src\\changed.ts',
    })
    expect(preview).toEqual({
      schema: 1,
      kind: 'preview',
      instanceId: 'preview',
      title: 'changed.ts',
      icon: 'file-search',
      relPath: 'src/changed.ts',
    })
    expect(preview && workspaceContentPanelId(preview)).toBe('content:preview:preview')
    expect(preview && workspaceContentResourceKey(preview)).toBe('preview')
    expect(parseWorkspaceContentParams({ ...preview, instanceId: 'src/changed.ts' })).toBeNull()
    expect(parseWorkspaceContentParams({ ...preview, icon: 'file-code' })).toBeNull()
  })
})

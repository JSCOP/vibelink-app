import { describe, expect, it, vi, type Mock } from 'vitest'
import type { DockviewApi, IDockviewPanel } from 'dockview-react'

import {
  authoredWorkspaceLayoutHistoryLimit,
  rememberAuthoredLayout,
  collapseStructuralWorkspacePanel,
  closeStrayTerminalPanels,
  toggleStructuralWorkspacePanel,
  toggleWorkspaceLeftSidebar,
  collapseWorkspaceEdgesForCenterWidth,
  ensureWorkspaceEdgeShell,
  registerWorkspaceEdgeGroups,
  resolveMainContentGroup,
  createWorkspaceResizeCoordinator,
  resetWorkspaceEdgeDefaults,
  resolveWorkspaceContentGroup,
  updateOpenPreviewPanel,
  workspaceGroupShowsCreationControls,
  workspaceChromeStatesEqual,
} from './workspaceShellModel'
import { createPreviewContentParams, createSingletonContentParams } from './workspaceLayoutModel'
import { workspaceContentPanelId, type WorkspaceContentParams } from './workspaceContentModel'

type FakeGroup = {
  id: string
  panels: FakePanel[]
  activePanel?: FakePanel
  api: {
    location: { type: 'grid' | 'edge'; position?: 'left' | 'right' }
    isVisible: boolean
    locked: boolean | 'no-drop-target'
    collapsed: boolean
    collapse: Mock
    expand: Mock
    isCollapsed: () => boolean
    setSize: Mock
  }
}

type FakePanel = {
  id: string
  group: FakeGroup
  params: WorkspaceContentParams
  update: Mock
  api: {
    setTitle: Mock
    setActive: Mock
    moveTo: Mock
    close: Mock
  }
}

function fakeDock(initialGridIds: string[] = []) {
  const groups: FakeGroup[] = []
  const panels: FakePanel[] = []
  const edgeByPosition: Partial<Record<'left' | 'right', FakeGroup>> = {}
  const edgeOptions: Partial<Record<'left' | 'right', Record<string, unknown>>> = {}
  let activeGroup: FakeGroup | undefined

  const makeGroup = (id: string, type: 'grid' | 'edge', position?: 'left' | 'right') => {
    const group: FakeGroup = {
      id,
      panels: [],
      api: {
        location: type === 'edge' ? { type, position } : { type },
        isVisible: true,
        locked: false,
        collapsed: false,
        collapse: vi.fn(() => { group.api.collapsed = true }),
        expand: vi.fn(() => { group.api.collapsed = false }),
        isCollapsed: () => group.api.collapsed,
        setSize: vi.fn(),
      },
    }
    groups.push(group)
    return group
  }

  for (const id of initialGridIds) makeGroup(id, 'grid')
  activeGroup = groups[0]

  const makePanel = (params: WorkspaceContentParams, group: FakeGroup) => {
    const panel: FakePanel = {
      id: workspaceContentPanelId(params),
      params,
      group,
      update: vi.fn((update: { params?: WorkspaceContentParams }) => { if (update.params) panel.params = update.params }),
      api: {
        setTitle: vi.fn(),
        setActive: vi.fn(() => {
          panel.group.activePanel = panel
          activeGroup = panel.group
        }),
        moveTo: vi.fn(({ group: destination, index, skipSetActive }: { group: FakeGroup; index?: number; skipSetActive?: boolean }) => {
          const source = panel.group
          source.panels = source.panels.filter((candidate) => candidate !== panel)
          // Dockview drops a group's active panel when that panel leaves it. A
          // `skipSetActive` move therefore leaves the group with NO active
          // panel, which is exactly how the edge rail rendered blank.
          if (source.activePanel === panel) source.activePanel = undefined
          panel.group = destination
          destination.panels.splice(index ?? destination.panels.length, 0, panel)
          if (!skipSetActive) destination.activePanel = panel
        }),
        close: vi.fn(() => {
          panel.group.panels = panel.group.panels.filter((candidate) => candidate !== panel)
          const index = panels.indexOf(panel)
          if (index >= 0) panels.splice(index, 1)
        }),
      },
    }
    panels.push(panel)
    group.panels.push(panel)
    return panel
  }

  const api = {
    groups,
    panels,
    get activeGroup() { return activeGroup },
    set activeGroup(group: FakeGroup | undefined) { activeGroup = group },
    get activePanel() { return undefined },
    getEdgeGroup(position: 'left' | 'right') { return edgeByPosition[position]?.api },
    addEdgeGroup(position: 'left' | 'right', options: Record<string, unknown>) {
      edgeOptions[position] = options
      const group = makeGroup(String(options.id), 'edge', position)
      group.api.collapsed = Boolean(options.collapsed)
      edgeByPosition[position] = group
      return group.api
    },
    setEdgeGroupVisible(position: 'left' | 'right', visible: boolean) {
      const group = edgeByPosition[position]
      if (group) group.api.isVisible = visible
    },
    addGroup({ id }: { id: string; direction: 'right' }) {
      const group = makeGroup(id, 'grid')
      activeGroup = group
      return group
    },
    addPanel(options: { params: WorkspaceContentParams; position: { referenceGroup: FakeGroup } }) {
      return makePanel(options.params, options.position.referenceGroup)
    },
    getPanel(id: string) { return panels.find((panel) => panel.id === id) },
    toJSON() {
      return {
        panels: {},
        grid: { root: { type: 'branch', data: [], size: 640 }, width: 640, height: 480, orientation: 'HORIZONTAL' },
        edgeGroups: {
          left: edgeByPosition.left ? { size: 300, visible: true, collapsed: edgeByPosition.left.api.collapsed || undefined } : undefined,
          right: edgeByPosition.right ? { size: 340, visible: true, collapsed: edgeByPosition.right.api.collapsed || undefined } : undefined,
        },
      }
    },
  }

  const setActiveGroup = (group: FakeGroup | undefined) => { activeGroup = group }

  return { api: api as unknown as DockviewApi, groups, panels, edgeOptions, makePanel, setActiveGroup }
}

describe('WorkspaceView shell primitives', () => {
  it('registers the fixed edge group IDs and width-sensitive defaults', () => {
    const { api, edgeOptions } = fakeDock(['grid-main'])
    registerWorkspaceEdgeGroups(api, 1100)

    expect(edgeOptions.left).toMatchObject({ id: 'workspace-left-tools', initialSize: 300, minimumSize: 240, maximumSize: 440, collapsedSize: 38, collapsed: false })
    expect(edgeOptions.right).toMatchObject({ id: 'workspace-right-tools', initialSize: 340, minimumSize: 280, maximumSize: 520, collapsedSize: 38, collapsed: true })
    expect(api.getEdgeGroup('left')?.locked).toBe('no-drop-target')
    expect(api.getEdgeGroup('right')?.locked).toBe('no-drop-target')
  })

  it('moves old central Explorer and reconciles every structural singleton in fixed order', () => {
    const { api, groups, makePanel } = fakeDock(['grid-main'])
    registerWorkspaceEdgeGroups(api, 1600)
    makePanel(createSingletonContentParams('explorer'), groups[0])

    ensureWorkspaceEdgeShell(api)

    const left = groups.find((group) => group.id === 'workspace-left-tools')!
    const right = groups.find((group) => group.id === 'workspace-right-tools')!
    expect(left.panels.map((panel) => panel.params.kind)).toEqual(['workspaces', 'explorer'])
    expect(right.panels.map((panel) => panel.params.kind)).toEqual(['workspaceFiles', 'sourceControl', 'gitHistory', 'gitBranches', 'agentSessions'])
    expect(right.activePanel?.params.kind).toBe('workspaceFiles')
    expect(groups[0].panels).toEqual([])
  })
  it('leaves every edge group with an active panel so the rail cannot render blank', () => {
    const { api, groups, makePanel } = fakeDock(['grid-main'])
    registerWorkspaceEdgeGroups(api, 1600)
    const left = groups.find((group) => group.id === 'workspace-left-tools')!

    // Seed the rail out of order so reconciliation must MOVE panels, which is
    // the path that dropped the active panel and produced an expanded-but-empty
    // Workspaces panel during workspace switches.
    makePanel(createSingletonContentParams('gitHistory'), left)
    const workspaces = makePanel(createSingletonContentParams('workspaces'), left)
    left.activePanel = workspaces

    ensureWorkspaceEdgeShell(api)

    expect(left.panels.length).toBeGreaterThan(0)
    expect(left.activePanel, 'left rail must keep an active panel').toBeDefined()
    // The panel the user was looking at is the one restored, not an arbitrary tab.
    expect(left.activePanel?.params.kind).toBe('workspaces')

    const right = groups.find((group) => group.id === 'workspace-right-tools')!
    expect(right.activePanel, 'right rail must keep an active panel').toBeDefined()
  })

  it('never resolves central content into an active or requested edge group', () => {
    const { api, groups, setActiveGroup } = fakeDock(['grid-a', 'grid-b'])
    registerWorkspaceEdgeGroups(api, 1600)
    setActiveGroup(groups.find((group) => group.id === 'workspace-left-tools'))

    expect(resolveWorkspaceContentGroup(api, 'editor', 'workspace-left-tools', 'grid-b')?.id).toBe('grid-b')
    expect(resolveWorkspaceContentGroup(api, 'workspaceFiles', 'grid-a', 'grid-b')?.id).toBe('workspace-right-tools')
    expect(resolveWorkspaceContentGroup(api, 'sourceControl', 'grid-a', 'grid-b')?.id).toBe('workspace-right-tools')
    expect(resolveWorkspaceContentGroup(api, 'workspaces', 'grid-a', 'grid-b')?.id).toBe('workspace-left-tools')
  })

  it('keeps terminals and other content in separate central grid groups', () => {
    const { api, groups, makePanel } = fakeDock(['grid-term', 'grid-content'])
    registerWorkspaceEdgeGroups(api, 1600)
    const termGroup = groups.find((group) => group.id === 'grid-term')!
    const contentGroup = groups.find((group) => group.id === 'grid-content')!
    makePanel({ schema: 1, kind: 'terminal', instanceId: 'p1', title: 'Shell', icon: 'terminal', paneId: 'p1' }, termGroup)
    makePanel({ schema: 1, kind: 'editor', instanceId: 'e1', title: 'a.ts', icon: 'file', relPath: 'a.ts' }, contentGroup)

    // A terminal routes to the group that already holds terminals.
    expect(resolveWorkspaceContentGroup(api, 'terminal')?.id).toBe('grid-term')
    // Non-terminal content routes to the group without terminals.
    expect(resolveWorkspaceContentGroup(api, 'editor')?.id).toBe('grid-content')
    expect(resolveWorkspaceContentGroup(api, 'browser')?.id).toBe('grid-content')
  })

  it('splits a new non-terminal group beside the terminal window when none exists', () => {
    const { api, groups, makePanel } = fakeDock(['grid-term'])
    registerWorkspaceEdgeGroups(api, 1600)
    const termGroup = groups.find((group) => group.id === 'grid-term')!
    makePanel({ schema: 1, kind: 'terminal', instanceId: 'p1', title: 'Shell', icon: 'terminal', paneId: 'p1' }, termGroup)

    const resolved = resolveWorkspaceContentGroup(api, 'editor')
    expect(resolved?.id).not.toBe('grid-term')
    expect(resolved?.id).toMatch(/^content-group-main/)
  })

  it('shows New only on the current grid group while edge activation leaves it attached', () => {
    expect(workspaceGroupShowsCreationControls('grid', 'grid-b', 'grid-b')).toBe(true)
    expect(workspaceGroupShowsCreationControls('grid', 'grid-a', 'grid-b')).toBe(false)
    expect(workspaceGroupShowsCreationControls('edge', 'workspace-left-tools', 'grid-b')).toBe(false)
  })

  it('creates the first central grid group when only edges exist', () => {
    const { api } = fakeDock()
    registerWorkspaceEdgeGroups(api, 800)

    expect(resolveMainContentGroup(api).id).toBe('content-group-main')
    expect(resolveMainContentGroup(api).api.location.type).toBe('grid')
  })

  it('resets a pre-collapsed wide shell to expanded bounded edge sizes', () => {
    const { api, groups, edgeOptions } = fakeDock(['grid-main'])
    registerWorkspaceEdgeGroups(api, 900)
    const left = groups.find((group) => group.id === 'workspace-left-tools')!
    const right = groups.find((group) => group.id === 'workspace-right-tools')!
    left.api.collapsed = true
    right.api.collapsed = true

    resetWorkspaceEdgeDefaults(api, 1600)

    expect(left.api.isCollapsed()).toBe(false)
    expect(right.api.isCollapsed()).toBe(false)
    expect(left.api.setSize).toHaveBeenCalledWith({ width: 300 })
    expect(right.api.setSize).toHaveBeenCalledWith({ width: 340 })
    expect(edgeOptions.left).toMatchObject({ minimumSize: 240, maximumSize: 440 })
    expect(edgeOptions.right).toMatchObject({ minimumSize: 280, maximumSize: 520 })
  })

  it('toggles the whole left sidebar without changing its active structural panel', () => {
    const { api, groups } = fakeDock(['grid-main'])
    registerWorkspaceEdgeGroups(api, 1600)
    const left = groups.find((group) => group.id === 'workspace-left-tools')!

    expect(toggleWorkspaceLeftSidebar(api)).toBe(true)
    expect(left.api.isCollapsed()).toBe(true)
    expect(toggleWorkspaceLeftSidebar(api)).toBe(true)
    expect(left.api.isCollapsed()).toBe(false)
  })

  it('opens Workspaces from another left tab and collapses it when already active', () => {
    const { api, groups } = fakeDock(['grid-main'])
    registerWorkspaceEdgeGroups(api, 1600)
    ensureWorkspaceEdgeShell(api)
    const left = groups.find((group) => group.id === 'workspace-left-tools')!
    const workspaces = left.panels.find((panel) => panel.params.kind === 'workspaces')!
    const explorer = left.panels.find((panel) => panel.params.kind === 'explorer')!
    explorer.api.setActive()
    left.api.collapse()

    expect(toggleStructuralWorkspacePanel(api, 'workspaces')).toBe(true)
    expect(left.api.isCollapsed()).toBe(false)
    expect(left.activePanel?.id).toBe(workspaces.id)
    expect(toggleStructuralWorkspacePanel(api, 'workspaces')).toBe(true)
    expect(left.api.isCollapsed()).toBe(true)
  })

  it('coalesces live resize work per frame and settles once after quiet', () => {
    let frame: (() => void) | undefined
    let quiet: (() => void) | undefined
    const onLive = vi.fn()
    const onSettled = vi.fn()
    const coordinator = createWorkspaceResizeCoordinator(
      { onLive, onSettled },
      {
        requestFrame: vi.fn((callback: () => void) => { frame = callback; return 1 }),
        cancelFrame: vi.fn(),
        setQuietTimer: vi.fn((callback: () => void) => { quiet = callback; return 2 }),
        clearQuietTimer: vi.fn(),
      },
    )

    coordinator.request(1000, true)
    coordinator.request(1120, false)
    expect(onLive).not.toHaveBeenCalled()
    frame?.()
    expect(onLive).toHaveBeenCalledOnce()
    expect(onLive).toHaveBeenCalledWith(1120, true)
    quiet?.()
    expect(onSettled).toHaveBeenCalledOnce()
  })

  it('shallow-dedupes unchanged workspace chrome state', () => {
    const state = { contentCount: 2, activeContentKind: 'terminal' as const, activePanelId: 'content:terminal:pane-1', activeGroupId: 'grid-main' }
    expect(workspaceChromeStatesEqual(state, { ...state })).toBe(true)
    expect(workspaceChromeStatesEqual(state, { ...state, activePanelId: 'content:terminal:pane-2' })).toBe(false)
  })


  it('updates Preview in place without activation when activate is false', () => {
    const { groups, makePanel } = fakeDock(['grid-main'])
    const panel = makePanel(createPreviewContentParams('src/one.ts'), groups[0])
    const next = createPreviewContentParams('src/two.ts')

    expect(updateOpenPreviewPanel(panel as unknown as IDockviewPanel, next, false)).toBe('content:preview:preview')
    expect(panel.update).toHaveBeenCalledWith({ params: next })
    expect(panel.api.setTitle).toHaveBeenCalledWith('two.ts')
    expect(panel.api.setActive).not.toHaveBeenCalled()
    updateOpenPreviewPanel(panel as unknown as IDockviewPanel, next)
    expect(panel.api.setActive).toHaveBeenCalledOnce()
  })

  it('collapses structural close requests without disposing the panel', () => {
    const { api, groups, makePanel } = fakeDock(['grid-main'])
    registerWorkspaceEdgeGroups(api, 1600)
    const edge = groups.find((group) => group.id === 'workspace-left-tools')!
    const structural = makePanel(createSingletonContentParams('explorer'), edge)
    const central = makePanel(createPreviewContentParams('src/file.ts'), groups[0])

    expect(collapseStructuralWorkspacePanel(structural as unknown as IDockviewPanel, structural.params)).toBe(true)
    expect(edge.api.collapse).toHaveBeenCalledOnce()
    expect(collapseStructuralWorkspacePanel(central as unknown as IDockviewPanel, central.params)).toBe(false)
  })

  it('collapses right before left only when the center would become too narrow', () => {
    const { api, groups } = fakeDock(['grid-main'])
    registerWorkspaceEdgeGroups(api, 1600)
    const left = groups.find((group) => group.id === 'workspace-left-tools')!
    const right = groups.find((group) => group.id === 'workspace-right-tools')!

    collapseWorkspaceEdgesForCenterWidth(api, 1100)
    expect(right.api.collapse).toHaveBeenCalledOnce()
    expect(left.api.collapse).not.toHaveBeenCalled()

    collapseWorkspaceEdgesForCenterWidth(api, 700)
    expect(left.api.collapse).toHaveBeenCalledOnce()
  })

  it('closes top-level terminal panels left by pre-window layouts', () => {
    // Panes moved into a nested terminal window. A layout persisted before that
    // still carries outer `content:terminal:*` panels whose close button is
    // inert (no window owns the pane), so they were stuck on screen forever.
    const { api, groups, makePanel } = fakeDock(['grid-main'])
    const stray = makePanel({ schema: 1, kind: 'terminal', instanceId: 'pane-omp', title: 'omp', icon: 'zap', paneId: 'pane-omp' }, groups[0])
    const window = makePanel({ schema: 1, kind: 'terminalWindow', instanceId: 'win-1', title: 'Terminal', icon: 'terminal', inner: null, titlesHidden: false }, groups[0])
    const editor = makePanel({ schema: 1, kind: 'editor', instanceId: 'a.ts', title: 'a.ts', icon: 'file-code', relPath: 'a.ts' }, groups[0])

    expect(closeStrayTerminalPanels(api)).toEqual([stray.id])
    expect(stray.api.close).toHaveBeenCalledOnce()
    expect(window.api.close).not.toHaveBeenCalled()
    expect(editor.api.close).not.toHaveBeenCalled()
  })
})

describe('authored layout history', () => {
  it('recognises any recent self-authored layout, not only the newest', () => {
    // Several persists can be in flight, so save_layout can echo back an older
    // one. Treating that echo as an external change rebuilt the whole dock.
    const history = new Set<string>()
    rememberAuthoredLayout(history, 'layout-a')
    rememberAuthoredLayout(history, 'layout-b')
    rememberAuthoredLayout(history, 'layout-c')

    expect(history.has('layout-a')).toBe(true)
    expect(history.has('layout-b')).toBe(true)
    expect(history.has('layout-c')).toBe(true)
    expect(history.has('layout-from-another-view')).toBe(false)
  })

  it('stays bounded and keeps the most recent entries', () => {
    const history = new Set<string>()
    for (let index = 0; index < authoredWorkspaceLayoutHistoryLimit + 5; index += 1) {
      rememberAuthoredLayout(history, `layout-${index}`)
    }

    expect(history.size).toBe(authoredWorkspaceLayoutHistoryLimit)
    expect(history.has('layout-0')).toBe(false)
    expect(history.has(`layout-${authoredWorkspaceLayoutHistoryLimit + 4}`)).toBe(true)
  })

  it('refreshes an existing entry instead of letting it age out early', () => {
    const history = new Set<string>()
    rememberAuthoredLayout(history, 'sticky')
    for (let index = 0; index < authoredWorkspaceLayoutHistoryLimit - 1; index += 1) {
      rememberAuthoredLayout(history, `layout-${index}`)
      rememberAuthoredLayout(history, 'sticky')
    }
    rememberAuthoredLayout(history, 'newest')

    expect(history.has('sticky')).toBe(true)
  })
})

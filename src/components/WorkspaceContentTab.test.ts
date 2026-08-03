// @vitest-environment jsdom
import { createElement, type ReactElement } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Orientation } from 'dockview-core'
import { shouldRevealTabForDrag, workspaceAgentTabStatus, workspaceWindowDropPosition } from './workspaceContentTabModel'
import { WorkspaceContentTab } from './WorkspaceContentTab'
import { TerminalPaneTitleBar } from './TerminalPaneTitleBar'
import { buildWorkspaceContentTabContextMenu } from '../layout/workspaceContentTabMenu'
import { createSingletonContentParams, createTerminalContentParams, createTerminalWindowParams, createWorkspaceContentPanel, createWorkspaceWindowParams } from '../layout/workspaceLayoutModel'
import { workspaceContentPanelId } from '../layout/workspaceContentModel'
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../layout/contentActions'
import { registerTerminalWindow } from '../layout/terminalWindowRegistry'
import { registerWorkspaceWindow } from '../layout/workspaceWindowRegistry'
import { emptyGitRepositoryState, emptyGitSessionState, useGitStore } from '../state/git'
import { useWorkspaceStore } from '../state/store'

const actions = {
  openContent: vi.fn(async () => ''),
  activateContent: vi.fn(),
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleZoomContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameTerminal: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
} satisfies WorkspaceContentActions

const disposable = () => ({ dispose: vi.fn() })

function panelApi(id: string, title: string) {
  return {
    id,
    title,
    isActive: true,
    location: { type: 'grid' },
    group: { id: `group:${id}` },
    moveTo: vi.fn(),
    isMaximized: vi.fn(() => false),
    setActive: vi.fn(),
    onDidTitleChange: vi.fn(() => disposable()),
    onDidActiveChange: vi.fn(() => disposable()),
    onDidGroupChange: vi.fn(() => disposable()),
    onDidLocationChange: vi.fn(() => disposable()),
  }
}

const containerApi = {
  id: 'workspace-dock',
  onDidMaximizedGroupChange: vi.fn(() => disposable()),
}

function renderWithActions(element: ReactElement) {
  return render(createElement(WorkspaceContentActionsContext.Provider, { value: actions }, element))
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useGitStore.setState({ sessions: {} })
  useWorkspaceStore.setState({ activeSessionId: undefined })
})

describe('WorkspaceContentTab', () => {
  it('maps authoritative Hermes state with pending permission precedence', () => {
    expect(workspaceAgentTabStatus('busy', 1)).toEqual({ label: 'Waiting for input', tone: 'waiting', pulsing: false })
    expect(workspaceAgentTabStatus('starting', 0)).toEqual({ label: 'Working', tone: 'working', pulsing: true })
    expect(workspaceAgentTabStatus('busy', 0)).toEqual({ label: 'Working', tone: 'working', pulsing: true })
    expect(workspaceAgentTabStatus('running', 0)).toEqual({ label: 'Idle', tone: 'idle', pulsing: false })
    expect(workspaceAgentTabStatus('error', 0)).toEqual({ label: 'Error', tone: 'error', pulsing: false })
    expect(workspaceAgentTabStatus('idle', 0)).toEqual({ label: 'Stopped', tone: 'stopped', pulsing: false })
  })

  it('omits close, maximize, float, popout, and creation actions for structural tabs', () => {
    const params = createSingletonContentParams('sourceControl')
    const items = buildWorkspaceContentTabContextMenu({
      panel: { id: 'content:sourceControl:sourceControl', params },
      group: { id: 'workspace-left-tools' },
    } as never, actions)

    expect(items).toEqual([])
  })

  it('renders split windows as child segments inside one outer tab', () => {
    const terminal = createTerminalWindowParams('terminal-a', [], { cols: 1, rows: 1 })
    const browser = { schema: 1 as const, kind: 'browser' as const, instanceId: 'page-a', title: 'Browser', icon: 'globe', pageId: 'page-a', profileId: 'default' }
    const terminalId = workspaceContentPanelId(terminal)
    const browserId = workspaceContentPanelId(browser)
    const inner = {
      panels: {
        [terminalId]: createWorkspaceContentPanel(terminal),
        [browserId]: createWorkspaceContentPanel(browser),
      },
      grid: {
        width: 1000,
        height: 640,
        orientation: Orientation.HORIZONTAL,
        root: {
          type: 'branch' as const,
          size: 1000,
          data: [
            { type: 'leaf' as const, size: 500, data: { views: [terminalId], activeView: terminalId, id: 'terminal-group' } },
            { type: 'leaf' as const, size: 500, data: { views: [browserId], activeView: browserId, id: 'browser-group' } },
          ],
        },
      },
      activeGroup: 'terminal-group',
    }
    const childApis = {
      [terminalId]: panelApi(terminalId, 'Terminal'),
      [browserId]: panelApi(browserId, 'Browser'),
    }
    const childPanels = {
      [terminalId]: { id: terminalId, params: terminal, api: childApis[terminalId] },
      [browserId]: { id: browserId, params: browser, api: childApis[browserId] },
    }
    const unregister = registerWorkspaceWindow({
      windowId: 'window-a',
      outerPanelId: 'content:workspaceWindow:window-a',
      getInnerApi: () => ({ id: 'workspace-window-a', getPanel: (id: string) => childPanels[id], toJSON: () => inner } as never),
      settle: async () => undefined,
      persist: () => undefined,
      panelIds: () => [terminalId, browserId],
      activePanelId: () => terminalId,
      focusActive: () => undefined,
    })
    try {
      const params = { ...createWorkspaceWindowParams(inner, 'window-a'), title: 'Group 1' }
      const api = panelApi('content:workspaceWindow:window-a', params.title)
      renderWithActions(createElement(WorkspaceContentTab, { api, containerApi, params } as never))

      const combined = screen.getByRole('tablist', { name: 'Terminal + Browser' })
      expect(within(combined).getAllByRole('tab').map((tab) => tab.getAttribute('aria-label'))).toEqual(['Terminal', 'Browser'])
      expect(within(screen.getByRole('tab', { name: 'Terminal' })).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
        'Add panes',
        'Arrange panes',
        'Clear panes',
        'Hide pane titles',
        'Close content',
      ])
      const terminalTab = screen.getByRole('tab', { name: 'Terminal' })
      const browserTab = screen.getByRole('tab', { name: 'Browser' })
      fireEvent.pointerDown(browserTab, { button: 0 })
      expect(actions.activateContent).toHaveBeenCalledWith(browserId)

      const browserSegment = browserTab.closest<HTMLElement>('.workspace-window-combined-segment')
      expect(browserSegment?.draggable).toBe(true)
      Object.defineProperty(browserSegment, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) })
      const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn(), getData: vi.fn(() => terminalId) }
      fireEvent.dragStart(terminalTab, { dataTransfer })
      fireEvent.dragOver(browserSegment as HTMLElement, { dataTransfer, clientX: 95, clientY: 10 })
      fireEvent.drop(browserSegment as HTMLElement, { dataTransfer, clientX: 95, clientY: 10 })
      expect(childApis[terminalId].moveTo).toHaveBeenCalledWith({ group: childApis[browserId].group, position: 'center' })
      expect(workspaceWindowDropPosition({ left: 0, top: 0, width: 100, height: 20 } as DOMRect, 95, 10)).toBe('right')
      expect(combined.textContent).not.toContain('Group 1')
      expect(combined.getAttribute('data-dockview-dnd-disabled')).toBe('true')
      const menu = buildWorkspaceContentTabContextMenu({ panel: { id: api.id, params }, group: { id: 'workspace-window-group' } } as never, actions)
      expect(menu.map((item) => item.label)).toEqual(['Reset workspace layout'])
    } finally {
      unregister()
    }
  })

  it('reveals the hovered window while another window tab is dragged over it', () => {
    const terminal = createTerminalWindowParams('terminal-b', [], { cols: 1, rows: 1 })
    const browser = { schema: 1 as const, kind: 'browser' as const, instanceId: 'page-b', title: 'Browser', icon: 'globe', pageId: 'page-b', profileId: 'default' }
    const terminalId = workspaceContentPanelId(terminal)
    const browserId = workspaceContentPanelId(browser)
    // Both windows stacked in ONE inner group, so the browser is hidden behind
    // the terminal — the state where the split target was invisible mid-drag.
    const inner = {
      activeGroup: 'stacked-group',
      panels: {
        [terminalId]: createWorkspaceContentPanel(terminal),
        [browserId]: createWorkspaceContentPanel(browser),
      },
      grid: {
        width: 1000,
        height: 640,
        orientation: Orientation.HORIZONTAL,
        root: {
          type: 'branch' as const,
          size: 1000,
          data: [{ type: 'leaf' as const, size: 1000, data: { views: [terminalId, browserId], activeView: terminalId, id: 'stacked-group' } }],
        },
      },
    }
    const childApis = {
      [terminalId]: panelApi(terminalId, 'Terminal'),
      [browserId]: panelApi(browserId, 'Browser'),
    }
    const childPanels = {
      [terminalId]: { id: terminalId, params: terminal, api: childApis[terminalId] },
      [browserId]: { id: browserId, params: browser, api: childApis[browserId] },
    }
    const unregister = registerWorkspaceWindow({
      windowId: 'window-b',
      outerPanelId: 'content:workspaceWindow:window-b',
      getInnerApi: () => ({ id: 'workspace-window-b', getPanel: (id: string) => childPanels[id], toJSON: () => inner } as never),
      settle: async () => undefined,
      persist: () => undefined,
      panelIds: () => [terminalId, browserId],
      activePanelId: () => terminalId,
      focusActive: () => undefined,
    })
    try {
      const params = createWorkspaceWindowParams(inner, 'window-b')
      const api = panelApi('content:workspaceWindow:window-b', params.title)
      renderWithActions(createElement(WorkspaceContentTab, { api, containerApi, params } as never))

      const browserSegment = screen.getByRole('tab', { name: 'Browser' }).closest<HTMLElement>('.workspace-window-combined-segment')
      Object.defineProperty(browserSegment, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, right: 100, bottom: 20, width: 100, height: 20 }) })
      const dataTransfer = { effectAllowed: 'none', dropEffect: 'none', setData: vi.fn(), getData: vi.fn(() => terminalId) }
      fireEvent.dragStart(screen.getByRole('tab', { name: 'Terminal' }), { dataTransfer })
      fireEvent.dragOver(browserSegment as HTMLElement, { dataTransfer, clientX: 50, clientY: 10 })

      expect(childApis[browserId].setActive).toHaveBeenCalled()
      expect(childApis[terminalId].setActive).not.toHaveBeenCalled()
    } finally {
      unregister()
    }
  })

  it('aggregates the Source Control badge across repositories in the active workspace group', () => {
    const changedEntry = { path: 'src/app.ts', oldPath: null, changeType: 'modified' as const }
    useWorkspaceStore.setState({ activeSessionId: 'group-root' })
    useGitStore.setState({
      sessions: {
        'group-root': {
          ...emptyGitSessionState,
          activeRepoRoot: 'vibelink-app',
          repositories: {
            'vibelink-app': { ...emptyGitRepositoryState, status: { staged: [], unstaged: [changedEntry], untracked: [], conflicted: [], truncated: false } },
            'vibelink-mobile': { ...emptyGitRepositoryState, status: { staged: [], unstaged: [], untracked: [], conflicted: [changedEntry], truncated: false } },
          },
        },
      },
    })

    const api = panelApi('content:sourceControl:sourceControl', 'Source Control')
    api.location = { type: 'edge' }
    renderWithActions(createElement(WorkspaceContentTab, {
      api,
      containerApi,
      params: createSingletonContentParams('sourceControl'),
    } as never))

    expect(screen.getByLabelText('2 changed paths, 1 conflicted').textContent).toBe('2')
  })

  it('re-samples a structural panel location after subscribing to Dockview changes', () => {
    const api = panelApi('content:sourceControl:sourceControl', 'Source Control')
    api.location = { type: 'grid' }
    api.onDidLocationChange.mockImplementation(() => {
      // Model a restored panel moving to its edge group before React's effect
      // subscription is installed. Dockview's location event has already fired.
      api.location = { type: 'edge' }
      return disposable()
    })

    renderWithActions(createElement(WorkspaceContentTab, {
      api,
      containerApi,
      params: createSingletonContentParams('sourceControl'),
    } as never))

    expect(screen.getByRole('tab', { name: 'Source Control' }).classList.contains('workspace-edge-rail-tab')).toBe(true)
  })

  it('switches an inactive edge panel on pointerdown without letting Dockview collapse it on click', () => {
    const api = panelApi('content:sourceControl:sourceControl', 'Source Control')
    api.isActive = false
    api.location = { type: 'edge' }
    renderWithActions(createElement(WorkspaceContentTab, {
      api,
      containerApi,
      params: createSingletonContentParams('sourceControl'),
    } as never))
    const tab = screen.getByRole('tab', { name: 'Source Control' })

    fireEvent.pointerDown(tab)
    fireEvent.click(tab)

    expect(actions.activateContent).toHaveBeenCalledTimes(1)
  })

  it('keeps central terminal actions targeted at the owning grid group', () => {
    const params = createTerminalContentParams({ id: 'pane-a', config: { paneId: 'pane-a', args: [], env: [], title: 'Shell', icon: 'terminal', cols: 80, rows: 24 } })
    const items = buildWorkspaceContentTabContextMenu({
      panel: { id: 'content:terminal:pane-a', params },
      group: { id: 'grid-main' },
    } as never, actions)

    items[0]?.action?.()
    expect(actions.openContent).toHaveBeenCalledWith({ kind: 'terminal', targetGroupId: 'grid-main' })
    expect(items.map((item) => item.label)).toEqual([
      'New terminal in this group',
      'Split terminal right',
      'Split terminal below',
      'Maximize / restore content',
      'Close terminal',
    ])
  })

  it('keeps terminal window maintenance actions available on hover', () => {
    const params = createTerminalWindowParams('window-a', [], { cols: 1, rows: 1 })
    const unregister = registerTerminalWindow({
      windowId: 'window-a',
      getInnerApi: () => ({
        toJSON: () => ({
          grid: {
            width: 400,
            height: 200,
            orientation: 'HORIZONTAL',
            root: {
              type: 'branch',
              size: 200,
              data: ['pane-a', 'pane-b', 'pane-c', 'pane-d'].map((paneId) => ({
                type: 'leaf',
                size: 100,
                data: { views: [`content:terminal:${paneId}`] },
              })),
            },
          },
        }),
      } as never),
      addPane: () => null,
      removePane: () => undefined,
      settle: async () => undefined,
      persist: () => undefined,
      paneIds: () => ['pane-a', 'pane-b', 'pane-c', 'pane-d'],
      focusFirst: () => undefined,
    })

    try {
      const view = renderWithActions(createElement(WorkspaceContentTab, {
        api: panelApi('content:terminalWindow:window-a', 'Terminal'),
        containerApi,
        params,
      } as never))
      const actionBar = view.container.querySelector('.terminal-tab-actions')
      expect(actionBar).not.toBeNull()
      expect(within(actionBar as HTMLElement).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
        'Add panes',
        'Arrange panes',
        'Clear panes',
        'Hide pane titles',
        'Close content',
      ])
      fireEvent.click(screen.getByRole('button', { name: 'Arrange panes' }))
      fireEvent.click(screen.getByRole('button', { name: 'Clear panes' }))
      fireEvent.click(screen.getByRole('button', { name: 'Hide pane titles' }))
      expect(actions.arrangeTerminals).toHaveBeenCalledWith(null, 'window-a')
      expect(actions.clearTerminals).toHaveBeenCalledWith('window-a')
      expect(actions.toggleTerminalWindowTitles).toHaveBeenCalledWith('window-a')

      fireEvent.click(screen.getByRole('button', { name: 'Add panes' }))
      expect(screen.getByRole('dialog', { name: 'Add terminal panes' })).toBeTruthy()
      expect(screen.getByText('4 occupied · 0 new panes')).toBeTruthy()
      expect(screen.getByRole('button', { name: '4×1 occupied' })).toBeTruthy()
      fireEvent.pointerDown(screen.getByRole('button', { name: '4×2 available' }))
      expect(screen.getByText('4 occupied · 4 new panes')).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Create' }))
      expect(actions.openContent).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'terminal-grid',
        grid: expect.objectContaining({ windowId: 'window-a' }),
      }))
    } finally {
      unregister()
    }
  })

  it('moves terminal window maintenance actions into its context menu', () => {
    const params = createTerminalWindowParams('window-a', [], { cols: 1, rows: 1 })
    const items = buildWorkspaceContentTabContextMenu({
      panel: { id: 'content:terminalWindow:window-a', params },
      group: { id: 'window-group' },
    } as never, actions)

    expect(items.map((item) => item.label)).toEqual([
      'New terminal in this window',
      'Arrange panes',
      'Clear panes',
      'Hide pane titles',
      'Maximize / restore content',
      'Close terminal window',
    ])
    items[0]?.action?.()
    items[1]?.action?.()
    items[2]?.action?.()
    items[3]?.action?.()
    expect(actions.arrangeTerminals).toHaveBeenCalledWith(null, 'window-a')
    expect(actions.clearTerminals).toHaveBeenCalledWith('window-a')
    expect(actions.toggleTerminalWindowTitles).toHaveBeenCalledWith('window-a')
    expect(actions.openContent).toHaveBeenCalledWith({ kind: 'terminal', windowId: 'window-a' })
  })

  it('keeps arrange off the terminal pane title bar', () => {
    const params = createTerminalContentParams({ id: 'pane-a', config: { paneId: 'pane-a', args: [], env: [], title: 'Shell', icon: 'terminal', cols: 80, rows: 24 } })
    const view = renderWithActions(createElement(TerminalPaneTitleBar, {
      api: panelApi('content:terminal:pane-a', 'Shell'),
      params,
    } as never))
    const actionBar = view.container.querySelector('.terminal-tab-actions')
    expect(actionBar).not.toBeNull()
    expect(within(actionBar as HTMLElement).getAllByRole('button').map((button) => button.getAttribute('aria-label'))).toEqual([
      'Split terminal right',
      'Split terminal below',
      'Close terminal',
    ])
    expect(screen.queryByRole('button', { name: /Arrange/ })).toBeNull()
  })

  it('reveals a hovered tab only for a same-instance drag onto a different inactive tab', () => {
    const tab = { viewId: 'dock-1', panelId: 'content:terminalWindow:b', isActive: false }
    // Live drag of another window in this instance → reveal.
    expect(shouldRevealTabForDrag({ viewId: 'dock-1', panelId: 'content:terminalWindow:a' }, tab)).toBe(true)
    // No active drag → nothing to reveal.
    expect(shouldRevealTabForDrag(undefined, tab)).toBe(false)
    // The dragged tab itself must not re-activate.
    expect(shouldRevealTabForDrag({ viewId: 'dock-1', panelId: 'content:terminalWindow:b' }, tab)).toBe(false)
    // A drag from a different Dockview instance (e.g. an inner pane grid) is ignored.
    expect(shouldRevealTabForDrag({ viewId: 'dock-2', panelId: 'content:terminalWindow:a' }, tab)).toBe(false)
    // An already-active tab needs no reveal.
    expect(shouldRevealTabForDrag({ viewId: 'dock-1', panelId: 'content:terminalWindow:a' }, { ...tab, isActive: true })).toBe(false)
  })
})

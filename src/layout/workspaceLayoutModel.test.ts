import { describe, expect, it } from 'vitest'
import {
  createDefaultWorkspaceDockviewLayout,
  gitWorkspaceLayoutPageId,
  normalizeWorkspaceLayoutState,
  planningWorkspaceLayoutPageId,
  terminalWorkspaceLayoutPageId,
  workspaceWindowDescriptors,
} from './workspaceLayoutModel'

describe('normalizeWorkspaceLayoutState', () => {
  it('creates exactly the three fixed pages from null state with Terminal active', () => {
    const state = normalizeWorkspaceLayoutState(null, { now: 10 })

    expect(state).toEqual({
      version: 2,
      activePageId: terminalWorkspaceLayoutPageId,
      pages: [
        { id: terminalWorkspaceLayoutPageId, name: 'Terminal', layoutJson: null, createdAt: 10, updatedAt: 10 },
        { id: planningWorkspaceLayoutPageId, name: 'Kanban + Agent', layoutJson: null, createdAt: 10, updatedAt: 10 },
        { id: gitWorkspaceLayoutPageId, name: 'Git', layoutJson: null, createdAt: 10, updatedAt: 10 },
      ],
    })
  })

  it('defines page-aware reset layouts for Terminal and Kanban + Agent', () => {
    const terminal = createDefaultWorkspaceDockviewLayout(terminalWorkspaceLayoutPageId)
    const planning = createDefaultWorkspaceDockviewLayout(planningWorkspaceLayoutPageId)

    expect(terminal).toMatchObject({
      panels: {
        [workspaceWindowDescriptors.terminal.panelId]: { contentComponent: 'terminalWindow' },
      },
      activeGroup: `window-${workspaceWindowDescriptors.terminal.panelId}`,
    })
    expect(Object.keys(terminal.panels as Record<string, unknown>)).toEqual([workspaceWindowDescriptors.terminal.panelId])
    expect(planning).toMatchObject({
      grid: {
        orientation: 'HORIZONTAL',
        root: {
          data: [
            { data: { views: [workspaceWindowDescriptors.kanban.panelId] }, size: 700 },
            { data: { views: [workspaceWindowDescriptors.agent.panelId] }, size: 300 },
          ],
        },
      },
      panels: {
        [workspaceWindowDescriptors.kanban.panelId]: { contentComponent: 'kanban' },
        [workspaceWindowDescriptors.agent.panelId]: { contentComponent: 'agent' },
      },
      activeGroup: `window-${workspaceWindowDescriptors.kanban.panelId}`,
    })
    expect(Object.keys(planning.panels as Record<string, unknown>)).not.toContain(workspaceWindowDescriptors.terminal.panelId)
  })
  it('defines an Explorer + Git reset layout for the Git page', () => {
    const git = createDefaultWorkspaceDockviewLayout(gitWorkspaceLayoutPageId)

    expect(git).toMatchObject({
      grid: {
        orientation: 'HORIZONTAL',
        root: {
          data: [
            { data: { views: [workspaceWindowDescriptors.explorer.panelId] }, size: 300 },
            { data: { views: [workspaceWindowDescriptors.git.panelId] }, size: 700 },
          ],
        },
      },
      panels: {
        [workspaceWindowDescriptors.explorer.panelId]: { contentComponent: 'explorerWindow' },
        [workspaceWindowDescriptors.git.panelId]: { contentComponent: 'gitWindow' },
      },
      activeGroup: `window-${workspaceWindowDescriptors.git.panelId}`,
    })
    expect(Object.keys(git.panels as Record<string, unknown>)).not.toContain(workspaceWindowDescriptors.terminal.panelId)
  })

  it('preserves fixed page layouts and timestamps while removing arbitrary pages', () => {
    const terminalLayout = fixedWorkspaceDockLayout(workspaceWindowDescriptors.terminal.panelId, 'terminalWindow')
    const planningLayout = fixedWorkspaceDockLayout(workspaceWindowDescriptors.kanban.panelId, 'kanban')
    const state = normalizeWorkspaceLayoutState(JSON.stringify({
      version: 2,
      activePageId: planningWorkspaceLayoutPageId,
      pages: [
        { id: 'scratch', name: 'Scratch', layoutJson: terminalLayout, createdAt: 1, updatedAt: 2 },
        { id: planningWorkspaceLayoutPageId, name: 'Old Planning', layoutJson: planningLayout, createdAt: 30, updatedAt: 40 },
        { id: terminalWorkspaceLayoutPageId, name: 'Old Terminal', layoutJson: terminalLayout, createdAt: 10, updatedAt: 20 },
      ],
    }), { now: 99 })

    expect(state.activePageId).toBe(planningWorkspaceLayoutPageId)
    expect(state.pages).toEqual([
      { id: terminalWorkspaceLayoutPageId, name: 'Terminal', layoutJson: terminalLayout, createdAt: 10, updatedAt: 20 },
      { id: planningWorkspaceLayoutPageId, name: 'Kanban + Agent', layoutJson: planningLayout, createdAt: 30, updatedAt: 40 },
      { id: gitWorkspaceLayoutPageId, name: 'Git', layoutJson: null, createdAt: 99, updatedAt: 99 },
    ])
    expect(normalizeWorkspaceLayoutState(JSON.stringify({ ...state, activePageId: 'scratch' }), { now: 99 }).activePageId).toBe(terminalWorkspaceLayoutPageId)
  })

  it('wraps migrated legacy terminal layouts without injecting the Agent window', () => {
    const layout = JSON.stringify({
      grid: {
        root: { type: 'leaf', data: { id: 'group-pane-1', views: ['pane-1'], activeView: 'pane-1' }, size: 1000 },
        width: 1000,
        height: 600,
        orientation: 'HORIZONTAL',
      },
      panels: {
        'pane-1': { id: 'pane-1', contentComponent: 'terminal', params: { paneId: 'pane-1', title: 'Shell' }, title: 'Shell' },
      },
    })

    const state = normalizeWorkspaceLayoutState(layout, { terminalPaneIds: ['pane-1'], now: 1 })
    const pageLayout = JSON.parse(state.pages[0].layoutJson ?? '{}')

    expect(state.pages.map((page) => page.id)).toEqual([terminalWorkspaceLayoutPageId, planningWorkspaceLayoutPageId, gitWorkspaceLayoutPageId])
    expect(pageLayout.vibelinkTerminalLayout.panels['pane-1']).toMatchObject({ contentComponent: 'terminal' })
    expect(pageLayout.panels[workspaceWindowDescriptors.terminal.panelId]).toMatchObject({ contentComponent: 'terminalWindow' })
    expect(pageLayout.panels[workspaceWindowDescriptors.agent.panelId]).toBeUndefined()
    expect(JSON.stringify(pageLayout.grid.root)).not.toContain(workspaceWindowDescriptors.agent.panelId)
  })

  it('maps a legacy Kanban layout into the fixed planning page', () => {
    const legacyKanban = fixedWorkspaceDockLayout('board', 'kanban', {
      orchestrator: { id: 'orchestrator', contentComponent: 'agent' },
    })
    const state = normalizeWorkspaceLayoutState(null, { legacyKanbanLayoutJson: legacyKanban, now: 1 })
    const planning = JSON.parse(state.pages[1].layoutJson ?? '{}')

    expect(planning.panels[workspaceWindowDescriptors.kanban.panelId]).toMatchObject({ contentComponent: 'kanban' })
    expect(planning.panels[workspaceWindowDescriptors.agent.panelId]).toMatchObject({ contentComponent: 'agent' })
    expect(planning.panels.board).toBeUndefined()
    expect(planning.panels.orchestrator).toBeUndefined()
  })

  it('includes the singleton Todo List workspace window descriptor', () => {
    expect(workspaceWindowDescriptors.todo).toMatchObject({
      kind: 'todo',
      panelId: 'todo-list',
      component: 'todo',
      singleton: true,
    })
  })
})

function fixedWorkspaceDockLayout(panelId: string, contentComponent: string, extraPanels: Record<string, unknown> = {}): string {
  return JSON.stringify({
    grid: {
      root: { type: 'leaf', data: { id: `group-${panelId}`, views: [panelId], activeView: panelId }, size: 1000 },
      width: 1000,
      height: 600,
      orientation: 'HORIZONTAL',
    },
    panels: {
      [panelId]: { id: panelId, contentComponent },
      ...extraPanels,
    },
  })
}

import { describe, expect, it } from 'vitest'
import { normalizeWorkspaceLayoutState, workspaceWindowDescriptors } from './workspaceLayoutModel'

describe('normalizeWorkspaceLayoutState', () => {
  it('wraps migrated legacy terminal layouts inside the Terminal workspace window', () => {
    const layout = JSON.stringify({
      grid: {
        root: {
          type: 'leaf',
          data: { id: 'group-pane-1', views: ['pane-1'], activeView: 'pane-1' },
          size: 1000,
        },
        width: 1000,
        height: 600,
        orientation: 'HORIZONTAL',
      },
      panels: {
        'pane-1': {
          id: 'pane-1',
          contentComponent: 'terminal',
          params: { paneId: 'pane-1', title: 'Shell' },
          title: 'Shell',
        },
      },
    })

    const state = normalizeWorkspaceLayoutState(layout, { terminalPaneIds: ['pane-1'], now: 1 })
    const pageLayout = JSON.parse(state.pages[0].layoutJson ?? '{}')
    const agentId = workspaceWindowDescriptors.agent.panelId
    const terminalWindowId = workspaceWindowDescriptors.terminal.panelId

    expect(pageLayout.vibelinkTerminalLayout.panels['pane-1']).toMatchObject({
      id: 'pane-1',
      contentComponent: 'terminal',
      params: { paneId: 'pane-1', title: 'Shell' },
    })
    expect(pageLayout.panels[terminalWindowId]).toMatchObject({
      id: terminalWindowId,
      contentComponent: 'terminalWindow',
      params: { kind: 'terminal', title: 'Terminal' },
    })
    expect(pageLayout.panels[agentId]).toMatchObject({
      id: agentId,
      contentComponent: 'agent',
      params: { kind: 'agent', title: 'VibeLink Agent' },
    })
    expect(pageLayout.panels['pane-1']).toBeUndefined()
    expect(JSON.stringify(pageLayout.grid.root)).toContain(terminalWindowId)
    expect(JSON.stringify(pageLayout.grid.root)).toContain(agentId)
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

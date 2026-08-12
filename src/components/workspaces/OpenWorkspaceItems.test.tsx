// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { clearOpenContentSnapshot, publishOpenContentSnapshot } from '../../layout/openContentRegistry'
import { workspaceContentPanelId } from '../../layout/workspaceContentModel'
import { builtInContentComponents } from '../../layout/WorkspaceView'
import { OpenWorkspaceItems } from './OpenWorkspaceItems'

vi.mock('../AutomationPanel', () => ({
  AutomationPanel: ({ active }: { active?: boolean }) => <output data-testid="automation-consumer" data-visible={String(Boolean(active))} />,
}))
vi.mock('../agent/AgentSessionsSidebar', () => ({
  AgentSessionsSidebar: ({ active, visible }: { active?: boolean; visible?: boolean }) => <output data-testid="agent-sessions-consumer" data-active={String(Boolean(active))} data-visible={String(Boolean(visible))} />,
}))
vi.mock('../git/GitHistorySidebar', () => ({
  GitHistorySidebar: ({ active, visible }: { active?: boolean; visible?: boolean }) => <output data-testid="git-history-consumer" data-active={String(Boolean(active))} data-visible={String(Boolean(visible))} />,
}))
vi.mock('../git/GitBranchesSidebar', () => ({
  GitBranchesSidebar: ({ active, visible }: { active?: boolean; visible?: boolean }) => <output data-testid="git-branches-consumer" data-active={String(Boolean(active))} data-visible={String(Boolean(visible))} />,
}))

const activateContent = vi.fn()
const actions: WorkspaceContentActions = {
  openContent: vi.fn(async () => ''),
  activateContent,
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleZoomContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameContent: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

function renderItems(completionHighlights: Readonly<Record<string, unknown>> = {}) {
  return render(
    <WorkspaceContentActionsContext.Provider value={actions}>
      <OpenWorkspaceItems completionHighlights={completionHighlights} />
    </WorkspaceContentActionsContext.Provider>,
  )
}

function fakeEdgePanelApi() {
  let active = false
  let visible = true
  const activeListeners = new Set<() => void>()
  const visibleListeners = new Set<() => void>()
  const groupListeners = new Set<() => void>()
  const collapsedListeners = new Set<(event: { isCollapsed: boolean }) => void>()
  const api = {
    id: 'edge-panel',
    get isActive() { return active },
    get isVisible() { return visible },
    group: {
      api: {
        isCollapsed: () => false,
        collapse: vi.fn(),
        onDidCollapsedChange: (listener: (event: { isCollapsed: boolean }) => void) => {
          collapsedListeners.add(listener)
          return { dispose: () => collapsedListeners.delete(listener) }
        },
      },
    },
    onDidActiveChange: (listener: () => void) => {
      activeListeners.add(listener)
      return { dispose: () => activeListeners.delete(listener) }
    },
    onDidVisibilityChange: (listener: () => void) => {
      visibleListeners.add(listener)
      return { dispose: () => visibleListeners.delete(listener) }
    },
    onDidGroupChange: (listener: () => void) => {
      groupListeners.add(listener)
      return { dispose: () => groupListeners.delete(listener) }
    },
  }
  return {
    api,
    setActive(next: boolean) {
      active = next
      activeListeners.forEach((listener) => listener())
    },
    setVisible(next: boolean) {
      visible = next
      visibleListeners.forEach((listener) => listener())
    },
  }
}

describe('OpenWorkspaceItems', () => {
  beforeEach(() => {
    clearOpenContentSnapshot()
    activateContent.mockClear()
  })

  afterEach(() => {
    cleanup()
    clearOpenContentSnapshot()
  })

  test('renders every open item and activates the selected outer panel', () => {
    publishOpenContentSnapshot([
      { panelId: 'content:browser:page-1', kind: 'browser', title: 'Docs', icon: 'globe', active: false },
      { panelId: 'content:agent:agent', kind: 'agent', title: 'VibeLink Agent', icon: 'bot', active: true },
    ])
    renderItems()

    expect(screen.getByRole('button', { name: 'Docs' })).toBeInTheDocument()
    const agent = screen.getByRole('button', { name: 'VibeLink Agent' })
    expect(agent).toHaveAttribute('aria-current', 'true')
    fireEvent.click(agent)
    expect(activateContent).toHaveBeenCalledWith('content:agent:agent')
  })

  test('activates a terminal pane through its outer-facing content panel id and marks completion', () => {
    const paneId = 'pane-42'
    const panelId = workspaceContentPanelId({ kind: 'terminal', instanceId: paneId })
    publishOpenContentSnapshot([
      { panelId, kind: 'terminal', title: 'Codex', icon: 'sparkles', active: true },
    ])
    renderItems({ [paneId]: { sessionId: 'workspace-a' } })

    const pane = screen.getByRole('button', { name: 'Codex' })
    expect(pane.querySelector('.workspace-open-content-status')).toHaveClass('is-complete')
    fireEvent.keyDown(pane, { key: 'Enter' })
    expect(activateContent).toHaveBeenCalledWith(panelId)
    expect(panelId).toBe('content:terminal:pane-42')
  })

  test('collapses a terminal window into icon-only program launchers', () => {
    const windowPanelId = 'content:terminalWindow:window-1'
    const codexPanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-codex' })
    const claudePanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-claude' })
    publishOpenContentSnapshot([
      { panelId: windowPanelId, kind: 'terminalWindow', title: 'Terminal', icon: 'terminal', active: false, parentPanelId: null },
      { panelId: codexPanelId, kind: 'terminal', title: 'Codex', icon: 'codex', active: true, parentPanelId: windowPanelId },
      { panelId: claudePanelId, kind: 'terminal', title: 'Claude Code', icon: 'claude-code', active: false, parentPanelId: windowPanelId },
    ])
    renderItems()

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Terminal' }))
    const codexIcon = screen.getByRole('button', { name: 'Activate Codex' })
    const claudeIcon = screen.getByRole('button', { name: 'Activate Claude Code' })
    expect(codexIcon).toHaveAttribute('aria-current', 'true')
    expect(codexIcon.querySelector('img')).toHaveAttribute('src', '/agent-icons/codex.svg')
    expect(claudeIcon.querySelector('img')).toHaveAttribute('src', '/agent-icons/claude-code.svg')
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument()

    fireEvent.click(claudeIcon)
    expect(activateContent).toHaveBeenCalledWith(claudePanelId)
    fireEvent.click(screen.getByRole('button', { name: 'Expand Terminal' }))
    expect(screen.getByText('Claude Code')).toBeInTheDocument()
  })

  test('collapses and expands a terminal window from the chevron keyboard control', () => {
    const windowPanelId = 'content:terminalWindow:window-1'
    const panePanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-codex' })
    publishOpenContentSnapshot([
      { panelId: windowPanelId, kind: 'terminalWindow', title: 'Terminal', icon: 'terminal', active: false, parentPanelId: null },
      { panelId: panePanelId, kind: 'terminal', title: 'Codex', icon: 'codex', active: false, parentPanelId: windowPanelId },
    ])
    renderItems()

    const collapse = screen.getByRole('button', { name: 'Collapse Terminal' })
    collapse.focus()
    expect(fireEvent.keyDown(collapse, { key: 'Enter' })).toBe(true)
    expect(activateContent).not.toHaveBeenCalled()
    fireEvent.click(collapse)
    expect(screen.queryByRole('button', { name: 'Codex' })).not.toBeInTheDocument()

    const expand = screen.getByRole('button', { name: 'Expand Terminal' })
    expand.focus()
    expect(fireEvent.keyDown(expand, { key: ' ' })).toBe(true)
    expect(activateContent).not.toHaveBeenCalled()
    fireEvent.click(expand)
    expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument()
  })

  test('highlights the completed terminal row and its owning terminal group', () => {
    const windowPanelId = 'content:terminalWindow:window-1'
    const codexPanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-codex' })
    const claudePanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-claude' })
    publishOpenContentSnapshot([
      { panelId: windowPanelId, kind: 'terminalWindow', title: 'Terminal', icon: 'terminal', active: false, parentPanelId: null },
      { panelId: codexPanelId, kind: 'terminal', title: 'Codex', icon: 'codex', active: true, parentPanelId: windowPanelId },
      { panelId: claudePanelId, kind: 'terminal', title: 'Claude Code', icon: 'claude-code', active: false, parentPanelId: windowPanelId },
    ])
    renderItems({ 'pane-claude': { sessionId: 'workspace-a' } })

    const groupHeader = screen.getByRole('button', { name: 'Terminal' }).parentElement
    const completedPane = screen.getByRole('button', { name: 'Claude Code' })
    expect(groupHeader).toHaveClass('is-complete')
    expect(groupHeader?.querySelector('.workspace-open-content-status')).toHaveClass('is-complete')
    expect(completedPane).toHaveClass('is-complete')

    fireEvent.click(screen.getByRole('button', { name: 'Collapse Terminal' }))
    expect(screen.getByRole('button', { name: 'Activate Claude Code' })).toHaveClass('is-complete')
  })

  test('selecting a terminal window header activates that window instead of only collapsing it', () => {
    const windowPanelId = 'content:terminalWindow:window-1'
    const codexPanelId = workspaceContentPanelId({ kind: 'terminal', instanceId: 'pane-codex' })
    publishOpenContentSnapshot([
      { panelId: windowPanelId, kind: 'terminalWindow', title: 'Terminal', icon: 'terminal', active: false, parentPanelId: null },
      { panelId: codexPanelId, kind: 'terminal', title: 'Codex', icon: 'codex', active: false, parentPanelId: windowPanelId },
    ])
    renderItems()

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))
    expect(activateContent).toHaveBeenCalledWith(windowPanelId)
    // The window stays expanded: only the chevron collapses it.
    expect(screen.getByRole('button', { name: 'Codex' })).toBeInTheDocument()

    activateContent.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Terminal' }))
    expect(activateContent).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Codex' })).not.toBeInTheDocument()
  })
})

describe('WorkspaceView edge panel visibility', () => {
  afterEach(() => {
    cleanup()
  })

  test('passes Dockview visibility to all edge panel consumers', () => {
    const edge = fakeEdgePanelApi()
    const GitHistory = builtInContentComponents.gitHistory
    const GitBranches = builtInContentComponents.gitBranches
    const Automation = builtInContentComponents.automation
    const AgentSessions = builtInContentComponents.agentSessions
    const props = { api: edge.api } as unknown as Parameters<typeof GitHistory>[0]

    render(<>
      <GitHistory {...props} />
      <GitBranches {...props} />
      <Automation {...props} />
      <AgentSessions {...props} />
    </>)

    const visibleConsumers = [
      screen.getByTestId('git-history-consumer'),
      screen.getByTestId('git-branches-consumer'),
      screen.getByTestId('automation-consumer'),
      screen.getByTestId('agent-sessions-consumer'),
    ]
    expect(visibleConsumers.every((consumer) => consumer.dataset.visible === 'true')).toBe(true)
    expect(screen.getByTestId('git-history-consumer')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('git-branches-consumer')).toHaveAttribute('data-active', 'false')
    expect(screen.getByTestId('agent-sessions-consumer')).toHaveAttribute('data-active', 'false')

    act(() => edge.setActive(true))
    expect(screen.getByTestId('git-history-consumer')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('git-branches-consumer')).toHaveAttribute('data-active', 'true')
    expect(screen.getByTestId('agent-sessions-consumer')).toHaveAttribute('data-active', 'true')
    expect(visibleConsumers.every((consumer) => consumer.dataset.visible === 'true')).toBe(true)

    act(() => edge.setVisible(false))
    expect(visibleConsumers.every((consumer) => consumer.dataset.visible === 'false')).toBe(true)
  })
})

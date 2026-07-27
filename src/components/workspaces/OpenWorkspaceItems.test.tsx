// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { clearOpenContentSnapshot, publishOpenContentSnapshot } from '../../layout/openContentRegistry'
import { workspaceContentPanelId } from '../../layout/workspaceContentModel'
import { OpenWorkspaceItems } from './OpenWorkspaceItems'

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
  renameTerminal: vi.fn(async () => undefined),
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

    const groupHeader = screen.getByRole('button', { name: 'Collapse Terminal' })
    const completedPane = screen.getByRole('button', { name: 'Claude Code' })
    expect(groupHeader).toHaveClass('is-complete')
    expect(groupHeader.querySelector('.workspace-open-content-status')).toHaveClass('is-complete')
    expect(completedPane).toHaveClass('is-complete')

    fireEvent.click(groupHeader)
    expect(screen.getByRole('button', { name: 'Activate Claude Code' })).toHaveClass('is-complete')
  })
})

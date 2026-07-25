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
})

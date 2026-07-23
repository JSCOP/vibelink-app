// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { WorkspaceContentActionsContext, type WorkspaceContentActions } from '../../layout/contentActions'
import { AgentSessionsSidebar } from './AgentSessionsSidebar'

const mocks = vi.hoisted(() => ({
  controller: {
    workspaceId: 'workspace-a' as string | null,
    workspaceName: 'Workspace A',
    workspaceFolder: 'E:/repo' as string | null,
    commandOverride: null,
    status: 'busy' as 'idle' | 'starting' | 'running' | 'busy' | 'error',
    error: null as string | null,
    currentSessionId: 'current-acp' as string | null,
    sessions: [
      { id: 'older-acp', title: 'Older', updatedAt: '2026-07-21T10:00:00.000Z', cwd: 'D:/other/project' },
      { id: 'current-acp', title: 'Current task', updatedAt: '2026-07-22T10:00:00.000Z', cwd: 'E:/repo' },
      { id: 'newest-acp', title: 'Newest fix', updatedAt: '2026-07-22T12:00:00.000Z', cwd: 'E:/repo/src' },
      { id: 'no-time-acp', title: null, updatedAt: null, cwd: null },
    ],
    permissions: [{ requestId: 1, title: 'Allow edit', toolKind: 'edit', options: [] }],
    conversations: [] as { id: string; title: string; agent: string; updatedAt: string | null; cwd: string | null; path: string }[],
    conversationsLoading: false,
    actionsDisabled: false,
    refreshSessions: vi.fn(async () => true),
    newSession: vi.fn(async () => 'new-acp'),
    resumeSession: vi.fn(async () => true),
  },
}))

vi.mock('./useHermesSessionController', () => ({
  useHermesSessionController: () => mocks.controller,
}))

vi.mock('../WorkspaceSidebarPanelShell', () => ({
  WorkspaceSidebarPanelShell: ({ title, actions, filter, children, footer }: { title: string; actions?: React.ReactNode; filter?: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode }) => (
    <section aria-label={title}>
      <header><h2>{title}</h2>{actions}</header>
      {filter}
      <main>{children}</main>
      <footer>{footer}</footer>
    </section>
  ),
}))

const openContent = vi.fn(async () => 'content:agent:agent')
const activateContent = vi.fn()
const actions: WorkspaceContentActions = {
  openContent,
  activateContent,
  requestCloseContent: vi.fn(async () => 'closed' as const),
  splitTerminal: vi.fn(async () => undefined),
  arrangeTerminals: vi.fn(async () => undefined),
  clearTerminals: vi.fn(async () => undefined),
  toggleMaximizeContent: vi.fn(),
  toggleTerminalWindowTitles: vi.fn(),
  renameTerminal: vi.fn(async () => undefined),
  resetLayout: vi.fn(async () => undefined),
  getContentParams: vi.fn(() => null),
}

function renderSidebar() {
  return render(
    <WorkspaceContentActionsContext.Provider value={actions}>
      <AgentSessionsSidebar />
    </WorkspaceContentActionsContext.Provider>,
  )
}

describe('AgentSessionsSidebar', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
    mocks.controller.status = 'busy'
    mocks.controller.permissions = [{ requestId: 1, title: 'Allow edit', toolKind: 'edit', options: [] }]
    mocks.controller.actionsDisabled = false
    mocks.controller.currentSessionId = 'current-acp'
    mocks.controller.sessions = [
      { id: 'older-acp', title: 'Older', updatedAt: '2026-07-21T10:00:00.000Z', cwd: 'D:/other/project' },
      { id: 'current-acp', title: 'Current task', updatedAt: '2026-07-22T10:00:00.000Z', cwd: 'E:/repo' },
      { id: 'newest-acp', title: 'Newest fix', updatedAt: '2026-07-22T12:00:00.000Z', cwd: 'E:/repo/src' },
      { id: 'no-time-acp', title: null, updatedAt: null, cwd: null },
    ]
  })

  afterEach(cleanup)

  test('sorts/searches rows and renders authoritative status only for the current session', () => {
    const { container } = renderSidebar()
    const rows = screen.getAllByRole('option')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Newest fix'),
      expect.stringContaining('Current task'),
      expect.stringContaining('Older'),
      expect.stringContaining('no-time'),
    ])
    expect(container.querySelectorAll('.agent-session-status')).toHaveLength(1)
    expect(screen.getByLabelText('Waiting for input')).toBeInTheDocument()

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search agent sessions' }), { target: { value: 'repo/src' } })
    expect(screen.getAllByRole('option')).toHaveLength(1)
    expect(screen.getByRole('option')).toHaveTextContent('Newest fix')
  })

  test('disables new and historical resume while Hermes is busy or starting', () => {
    mocks.controller.actionsDisabled = true
    renderSidebar()

    expect(screen.getByRole('button', { name: 'New agent session' })).toBeDisabled()
    fireEvent.click(screen.getByRole('option', { name: /Older/ }))
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled()
  })

  test('preserves a valid user selection across refresh and derives a current fallback when it disappears', () => {
    const view = renderSidebar()
    fireEvent.click(screen.getByRole('option', { name: /Older/ }))
    expect(screen.getByRole('option', { name: /Older/ })).toHaveAttribute('aria-selected', 'true')

    mocks.controller.currentSessionId = 'newest-acp'
    mocks.controller.sessions = [...mocks.controller.sessions].reverse()
    view.rerender(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <AgentSessionsSidebar />
      </WorkspaceContentActionsContext.Provider>,
    )
    expect(screen.getByRole('option', { name: /Older/ })).toHaveAttribute('aria-selected', 'true')

    mocks.controller.sessions = mocks.controller.sessions.filter((session) => session.id !== 'older-acp')
    view.rerender(
      <WorkspaceContentActionsContext.Provider value={actions}>
        <AgentSessionsSidebar />
      </WorkspaceContentActionsContext.Provider>,
    )
    expect(screen.getByRole('option', { name: /Newest fix/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('button', { name: 'Open' })).toBeInTheDocument()
  })

  test('resumes a historical row, activates Agent, and records it as viewed', async () => {
    mocks.controller.status = 'running'
    mocks.controller.permissions = []
    renderSidebar()

    fireEvent.click(screen.getByRole('option', { name: /Older/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }))

    await waitFor(() => expect(mocks.controller.resumeSession).toHaveBeenCalledWith('older-acp'))
    expect(openContent).toHaveBeenCalledWith({ kind: 'agent' })
    expect(activateContent).toHaveBeenCalledWith('content:agent:agent')
    const viewed = JSON.parse(window.localStorage.getItem('vibelink:agentSessionViews') || '{}')
    expect(viewed.version).toBe(1)
    expect(viewed.workspaces['workspace-a']['older-acp']).toEqual(expect.any(Number))
  })

  test('opens the current row and creates a new session through the same activation callback', async () => {
    mocks.controller.status = 'running'
    mocks.controller.permissions = []
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(openContent).toHaveBeenCalledTimes(1))
    expect(mocks.controller.resumeSession).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'New agent session' }))
    await waitFor(() => expect(mocks.controller.newSession).toHaveBeenCalledTimes(1))
    expect(openContent).toHaveBeenCalledTimes(2)
    const viewed = JSON.parse(window.localStorage.getItem('vibelink:agentSessionViews') || '{}')
    expect(viewed.workspaces['workspace-a']['current-acp']).toEqual(expect.any(Number))
    expect(viewed.workspaces['workspace-a']['new-acp']).toEqual(expect.any(Number))
  })
})

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionMeta } from '../../ipc/types'
import type { WorkspaceGroup } from '../../state/workspaceGroups'
import { clearOpenContentSnapshot, publishOpenContentSnapshot } from '../../layout/openContentRegistry'

const { open, invoke, choiceDialog, confirmDialog, promptDialog } = vi.hoisted(() => ({
  open: vi.fn(),
  invoke: vi.fn(),
  choiceDialog: vi.fn(),
  confirmDialog: vi.fn(),
  promptDialog: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open }))
vi.mock('../appDialogStore', () => ({ choiceDialog, confirmDialog, promptDialog }))

const mocks = vi.hoisted(() => ({
  state: {
    sessions: [
      { id: 'alpha', name: 'Alpha', paneCount: 2, createdAt: 1, workspaceFolder: 'E:/repos/alpha' },
      { id: 'beta', name: 'Beta', paneCount: 1, createdAt: 2, workspaceFolder: 'E:/repos/beta' },
      { id: 'gamma', name: 'Gamma', paneCount: 3, createdAt: 3, workspaceFolder: 'E:/repos/gamma' },
      { id: 'delta', name: 'Delta', paneCount: 1, createdAt: 4, workspaceFolder: null },
    ] as SessionMeta[],
    activeSessionId: 'gamma',
    paneCompletionHighlights: {} as Record<string, { sessionId: string }>,
    settings: {
      defaultProfileId: 'codex',
      profiles: [],
      workspaceProfileIds: {} as Record<string, string>,
      worktreeStorage: { mode: 'drive', drive: '', folderName: 'VibeLinkWorktrees', customRoot: '', groupByRepository: true },
      workspaceWorktrees: {} as Record<string, {
        parentSessionId: string
        sourceWorkspaceFolder: string
        worktreePath: string
        branch: string
        startRef: string
        createdAt: string
      }>,
      workspaceGroups: [
        { id: 'core', name: 'Core', collapsed: false },
        { id: 'tools', name: 'Tools', collapsed: false },
      ] as WorkspaceGroup[],
      workspaceGroupIds: { alpha: 'tools', beta: 'core', gamma: 'core' } as Record<string, string>,
      workspaceOrder: ['gamma', 'alpha', 'delta', 'beta'],
    },
    openSession: vi.fn(async () => undefined),
    createSession: vi.fn(async (name?: string, workspaceFolder?: string | null): Promise<SessionMeta> => ({
      id: `created-${name}`,
      name: name ?? '',
      paneCount: 0,
      createdAt: 0,
      workspaceFolder,
    })),
    renameSession: vi.fn(async () => undefined),
    createWorktreeSession: vi.fn(async () => undefined),
    moveWorktreeSession: vi.fn(async () => undefined),
    removeWorktreeSession: vi.fn(async () => undefined),
    reorderWorkspaces: vi.fn(),
    renameWorkspaceGroup: vi.fn(),
    deleteWorkspaceGroup: vi.fn(),
    setWorkspaceGroup: vi.fn(),
    setWorkspaceGroupRootFolder: vi.fn(),
    toggleWorkspaceGroupCollapsed: vi.fn(),
    setError: vi.fn(),
  },
}))

vi.mock('../../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
  paneCompletionCountsBySession: (highlights: Record<string, { sessionId: string }>) => {
    const counts: Record<string, number> = {}
    for (const highlight of Object.values(highlights)) counts[highlight.sessionId] = (counts[highlight.sessionId] ?? 0) + 1
    return counts
  },
}))

import { WorkspacesSidebar } from './WorkspacesSidebar'

const integration = {
  onCreateWorkspaceRequested: vi.fn(),
  onImportReposRequested: vi.fn(),
  onDeleteWorkspaceRequested: vi.fn(),
  onEditWorkspaceRequested: vi.fn(),
  setWorkspaceOverlayOpen: vi.fn(),
}

function renderSidebar() {
  return render(<WorkspacesSidebar integration={integration} />)
}

function clickWorkspaceRow(row: HTMLElement, pointerId = 1) {
  Object.defineProperties(row, {
    setPointerCapture: { configurable: true, value: vi.fn() },
    hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
  })
  fireEvent.pointerDown(row, { button: 0, pointerId, clientY: 100 })
  fireEvent.pointerUp(row, { button: 0, pointerId, clientY: 100 })
}

function seedBetaWorktree() {
  mocks.state.sessions = [
    ...mocks.state.sessions,
    { id: 'beta-worktree', name: 'Fix Login', paneCount: 1, createdAt: 5, workspaceFolder: 'E:/worktrees/fix-login' },
  ]
  mocks.state.settings.workspaceWorktrees = {
    'beta-worktree': {
      parentSessionId: 'beta',
      sourceWorkspaceFolder: 'E:/repos/beta',
      worktreePath: 'E:/worktrees/fix-login',
      branch: 'vibelink/fix-login',
      startRef: 'HEAD',
      createdAt: '2026-07-27T00:00:00.000Z',
    },
  }
}

describe('WorkspacesSidebar', () => {
  beforeEach(() => {
    mocks.state.sessions = [
      { id: 'alpha', name: 'Alpha', paneCount: 2, createdAt: 1, workspaceFolder: 'E:/repos/alpha' },
      { id: 'beta', name: 'Beta', paneCount: 1, createdAt: 2, workspaceFolder: 'E:/repos/beta' },
      { id: 'gamma', name: 'Gamma', paneCount: 3, createdAt: 3, workspaceFolder: 'E:/repos/gamma' },
      { id: 'delta', name: 'Delta', paneCount: 1, createdAt: 4, workspaceFolder: null },
    ]
    mocks.state.settings.workspaceGroups = [
      { id: 'core', name: 'Core', collapsed: false },
      { id: 'tools', name: 'Tools', collapsed: false },
    ]
    mocks.state.paneCompletionHighlights = {}
    mocks.state.settings.workspaceWorktrees = {}
    mocks.state.settings.workspaceProfileIds = {}
    mocks.state.activeSessionId = 'gamma'
    clearOpenContentSnapshot()
    vi.clearAllMocks()
    open.mockReset().mockResolvedValue(null)
    invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === 'git_is_available') return true
      if (command === 'git_worktree_resolve_root') return { root: 'E:/VibeLinkWorktrees', example: 'E:/VibeLinkWorktrees/beta-12345678/<name>-abc12345', writable: true, fallbackReason: null }
      if (command === 'git_worktree_list') return []
      return undefined
    })
    choiceDialog.mockReset().mockResolvedValue(null)
    confirmDialog.mockReset().mockResolvedValue(false)
    promptDialog.mockReset().mockResolvedValue(null)
    mocks.state.createSession.mockReset().mockImplementation(async (name?: string, workspaceFolder?: string | null): Promise<SessionMeta> => ({
      id: `created-${name}`,
      name: name ?? '',
      paneCount: 0,
      createdAt: 0,
      workspaceFolder,
    }))
  })

  afterEach(() => {
    cleanup()
    clearOpenContentSnapshot()
  })

  test('numbers workspaces from the flattened group order and labels the first nine shortcuts', () => {
    renderSidebar()

    const ordered = [
      ['Gamma', 'Ctrl+1', '1'],
      ['Beta', 'Ctrl+2', '2'],
      ['Alpha', 'Ctrl+3', '3'],
      ['Delta', 'Ctrl+4', '4'],
    ] as const
    for (const [name, shortcut, number] of ordered) {
      const row = screen.getByText(name).closest('[data-session-id]') as HTMLElement
      expect(within(row).getByTitle(shortcut)).toHaveTextContent(number)
    }
  })

  test('selects another workspace without reopening the active workspace', () => {
    renderSidebar()

    const activeRow = screen.getByText('Gamma').closest('[data-session-id]') as HTMLElement
    clickWorkspaceRow(activeRow)
    fireEvent.keyDown(activeRow, { key: 'Enter' })
    clickWorkspaceRow(screen.getByText('Beta').closest('[data-session-id]') as HTMLElement, 2)

    expect(mocks.state.openSession).toHaveBeenCalledExactlyOnceWith('beta')
  })

  test('marks a workspace row and badge with its AI completion count', () => {
    mocks.state.paneCompletionHighlights = {
      'pane-beta-1': { sessionId: 'beta' },
      'pane-beta-2': { sessionId: 'beta' },
    }
    renderSidebar()

    const row = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    expect(row).toHaveClass('session-row', 'has-completions')
    expect(row).toHaveAttribute('data-completion-count', '2')
    expect(within(row).getByLabelText('2 AI coding agent panes need attention')).toHaveTextContent('2')
  })

  test('nests group members and keeps only the active one when the group is collapsed', () => {
    const view = renderSidebar()

    let coreGroup = screen.getByText('Core').closest('.workspaces-group') as HTMLElement
    expect(within(coreGroup).getByText('Gamma')).toBeInTheDocument()
    expect(within(coreGroup).getByText('Beta')).toBeInTheDocument()
    expect(within(coreGroup).queryByText('Delta')).not.toBeInTheDocument()

    mocks.state.settings.workspaceGroups = [
      { id: 'core', name: 'Core', collapsed: true },
      { id: 'tools', name: 'Tools', collapsed: false },
    ]
    view.rerender(<WorkspacesSidebar integration={integration} />)

    // Collapsing hides the members you are not standing in; the ACTIVE
    // workspace stays visible so the panel never loses your position.
    coreGroup = screen.getByText('Core').closest('.workspaces-group') as HTMLElement
    expect(within(coreGroup).getByText('Gamma')).toBeInTheDocument()
    expect(within(coreGroup).queryByText('Beta')).not.toBeInTheDocument()
    expect(screen.getByText('Delta')).toBeInTheDocument()

    mocks.state.activeSessionId = 'delta'
    view.rerender(<WorkspacesSidebar integration={integration} />)

    coreGroup = screen.getByText('Core').closest('.workspaces-group') as HTMLElement
    expect(within(coreGroup).queryByText('Gamma')).not.toBeInTheDocument()
    expect(within(coreGroup).queryByText('Beta')).not.toBeInTheDocument()
  })

  test('expands the open content list under the active workspace only', () => {
    publishOpenContentSnapshot([
      { panelId: 'content:browser:page-1', kind: 'browser', title: 'Docs', icon: 'globe', active: false },
      { panelId: 'content:agent:agent', kind: 'agent', title: 'Agent chat', icon: 'bot', active: true },
    ])
    renderSidebar()

    const activeRow = screen.getByText('Gamma').closest('[data-session-id]') as HTMLElement
    expect(within(activeRow).getByRole('list', { name: 'Open workspace items' })).toBeInTheDocument()
    expect(within(activeRow).getByText('Docs')).toBeInTheDocument()
    expect(within(activeRow).getByText('Agent chat')).toBeInTheDocument()

    const inactiveRow = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    expect(within(inactiveRow).queryByRole('list', { name: 'Open workspace items' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('list', { name: 'Open workspace items' })).toHaveLength(1)
  })

  test('nests worktree sessions and opens creation from the repository context menu', async () => {
    seedBetaWorktree()
    renderSidebar()

    const betaRow = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    expect(within(betaRow).getByText('Fix Login')).toBeInTheDocument()
    expect(within(betaRow).getByText(/vibelink\/fix-login/)).toBeInTheDocument()

    fireEvent.contextMenu(betaRow, { clientX: 120, clientY: 140 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Create worktree' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_is_available', { workspaceFolder: 'E:/repos/beta' }))
    expect(screen.getByRole('dialog', { name: 'Create worktree' })).toBeInTheDocument()
  })

  test('reveals a worktree checkout from its row action', async () => {
    seedBetaWorktree()
    renderSidebar()

    const worktreeRow = screen.getByText('Fix Login').closest('[data-session-id]') as HTMLElement
    fireEvent.click(within(worktreeRow).getByRole('button', { name: 'Reveal Fix Login in File Explorer' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('reveal_path', { path: 'E:/worktrees/fix-login' }))
  })

  test('removes a worktree through the worktree lifecycle instead of plain workspace deletion', async () => {
    seedBetaWorktree()
    choiceDialog.mockResolvedValue('checkout-and-branch')
    invoke.mockImplementation(async (command: string) => {
      if (command === 'git_worktree_list') return [{
        worktreePath: 'E:/worktrees/fix-login',
        branch: 'vibelink/fix-login',
        head: 'a'.repeat(40),
        isMain: false,
        locked: false,
        prunable: false,
        dirty: true,
        exists: true,
      }]
      return undefined
    })
    renderSidebar()

    const worktreeRow = screen.getByText('Fix Login').closest('[data-session-id]') as HTMLElement
    fireEvent.click(within(worktreeRow).getByRole('button', { name: 'Remove worktree Fix Login' }))

    await waitFor(() => expect(mocks.state.removeWorktreeSession).toHaveBeenCalledWith('beta-worktree', { deleteBranch: true, force: true }))
    expect(integration.onDeleteWorkspaceRequested).not.toHaveBeenCalled()
  })

  test('opens Manage worktrees from a worktree context menu for its parent repository', async () => {
    seedBetaWorktree()
    renderSidebar()

    const worktreeRow = screen.getByText('Fix Login').closest('[data-session-id]') as HTMLElement
    fireEvent.contextMenu(worktreeRow, { clientX: 120, clientY: 140 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage worktrees' }))

    expect(screen.getByRole('dialog', { name: 'Manage worktrees' })).toBeInTheDocument()
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_worktree_list', { workspaceFolder: 'E:/repos/beta' }))
    expect(integration.setWorkspaceOverlayOpen).toHaveBeenCalledWith('worktree-manage', true)
  })

  test('creates, groups, and opens a root workspace once during a fast double click', async () => {
    mocks.state.settings.workspaceGroups = [
      { id: 'core', name: 'Core', collapsed: false, rootFolder: 'E:/repos/core-root' },
      { id: 'tools', name: 'Tools', collapsed: false, rootFolder: null },
    ]
    let releaseCreation!: (session: SessionMeta) => void
    mocks.state.createSession.mockImplementationOnce(() => new Promise<SessionMeta>((resolve) => { releaseCreation = resolve }))
    renderSidebar()

    const row = screen.getByText('Core').closest('[data-workspace-group-row]') as HTMLElement
    expect(within(row).getByTitle('E:/repos/core-root')).toHaveTextContent('core-root')
    fireEvent.click(row)
    fireEvent.click(row)

    await waitFor(() => expect(mocks.state.createSession).toHaveBeenCalledOnce())
    expect(mocks.state.createSession).toHaveBeenCalledWith('Core', 'E:/repos/core-root', 'codex')
    expect(mocks.state.openSession).not.toHaveBeenCalled()
    releaseCreation({ id: 'core-root-session', name: 'Core', paneCount: 0, createdAt: 5, workspaceFolder: 'E:/repos/core-root' })

    await waitFor(() => expect(mocks.state.openSession).toHaveBeenCalledWith('core-root-session'))
    expect(mocks.state.setWorkspaceGroup).toHaveBeenCalledExactlyOnceWith('core-root-session', 'core')
  })

  test('opens an existing root workspace instead of creating a duplicate', async () => {
    mocks.state.settings.workspaceGroups = [
      { id: 'core', name: 'Core', collapsed: false, rootFolder: 'E:\\repos\\beta\\' },
      { id: 'tools', name: 'Tools', collapsed: false, rootFolder: null },
    ]
    renderSidebar()

    fireEvent.click(screen.getByText('Core').closest('[data-workspace-group-row]') as HTMLElement)

    await waitFor(() => expect(mocks.state.openSession).toHaveBeenCalledExactlyOnceWith('beta'))
    expect(mocks.state.createSession).not.toHaveBeenCalled()
    expect(mocks.state.setWorkspaceGroup).not.toHaveBeenCalled()
  })

  test('uses the chevron only for collapse without opening the group root', () => {
    mocks.state.settings.workspaceGroups = [
      { id: 'core', name: 'Core', collapsed: false, rootFolder: 'E:/repos/core-root' },
      { id: 'tools', name: 'Tools', collapsed: false, rootFolder: null },
    ]
    renderSidebar()

    const row = screen.getByText('Core').closest('[data-workspace-group-row]') as HTMLElement
    fireEvent.click(within(row).getByTitle('Collapse Core group'))

    expect(mocks.state.toggleWorkspaceGroupCollapsed).toHaveBeenCalledExactlyOnceWith('core')
    expect(mocks.state.openSession).not.toHaveBeenCalled()
    expect(mocks.state.createSession).not.toHaveBeenCalled()
  })

  test('keeps a rootless group collapse-only and lets the user pick its root folder', async () => {
    open.mockResolvedValue('E:/repos/core-root')
    renderSidebar()

    const row = screen.getByText('Core').closest('[data-workspace-group-row]') as HTMLElement
    fireEvent.click(row)
    fireEvent.click(within(row).getByRole('button', { name: 'Set root folder for Core group' }))

    expect(mocks.state.toggleWorkspaceGroupCollapsed).toHaveBeenCalledExactlyOnceWith('core')
    expect(mocks.state.openSession).not.toHaveBeenCalled()
    await waitFor(() => expect(open).toHaveBeenCalledWith({ directory: true, multiple: false, title: 'Select workspace group root folder' }))
    expect(mocks.state.setWorkspaceGroupRootFolder).toHaveBeenCalledExactlyOnceWith('core', 'E:/repos/core-root')
  })

  test('opens workspace details from the row action', () => {
    renderSidebar()

    fireEvent.click(screen.getByRole('button', { name: 'Edit Alpha' }))

    expect(integration.onEditWorkspaceRequested).toHaveBeenCalledExactlyOnceWith('alpha')
  })
})

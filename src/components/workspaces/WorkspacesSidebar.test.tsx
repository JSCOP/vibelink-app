// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionMeta } from '../../ipc/types'
import type { WorktreeBlocker, WorktreeProjection } from '../../ipc/worktrees'
import type { PendingWorktreeCreation } from '../../state/worktrees'
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
    paneCompletionHighlights: {} as Record<string, { completedAt: number; source: 'agent-hook'; sessionId: string }>,
    paneReviewMarkers: {} as Record<string, { reviewedAt: number; sessionId: string }>,
    attentionSnapshot: null as null | { capturedAt: number; panes: Array<{ workspaceId: string; paneId: string; state: 'idle' | 'working' | 'waiting' | 'blocked' | 'error' | 'done'; stateUpdatedAt: number; lastOutputAt: number; unreadCount: number; interrupted: boolean; source: string; alive: boolean; title: string }> },
    panes: {},
    hermesStatus: {},
    hermesPermissions: {},
    worktreeProjections: [] as WorktreeProjection[],
    pendingWorktreeCreations: {} as Record<string, PendingWorktreeCreation>,
    settings: {
      defaultProfileId: 'codex',
      profiles: [],
      workspaceProfileIds: {} as Record<string, string>,
      worktreeStorage: { mode: 'drive', drive: '', folderName: 'VibeLinkWorktrees', customRoot: '', groupByRepository: true },
      workspaceGroups: [
        { id: 'core', name: 'Core', collapsed: false },
        { id: 'tools', name: 'Tools', collapsed: false },
      ] as WorkspaceGroup[],
      workspaceGroupIds: { alpha: 'tools', beta: 'core', gamma: 'core' } as Record<string, string>,
      workspaceOrder: ['gamma', 'alpha', 'delta', 'beta'],
      workspaceSortMode: 'manual' as 'smart' | 'recent' | 'name' | 'repository' | 'manual',
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
    removeWorktreeSession: vi.fn(async () => ({ checkoutRemoved: true, branchDeleted: true, branchPreservedReason: null, sessionRemoved: true, metadataRemoved: true })),
    removeWorktreeById: vi.fn(async () => ({ checkoutRemoved: true, branchDeleted: true, branchPreservedReason: null, sessionRemoved: true, metadataRemoved: true })),
    preflightWorktreeRemoval: vi.fn(async () => ({ worktreeId: 'worktree-beta', instanceId: 'instance-beta', repositoryPath: 'E:/repos/beta', worktreePath: 'E:/worktrees/fix-login', branch: 'vibelink/fix-login', blockers: [] as WorktreeBlocker[], warnings: [] as string[] })),
    reconcileRepositoryWorktrees: vi.fn(async () => [] as WorktreeProjection[]),
    importExternalWorktree: vi.fn(),
    cancelPendingWorktreeCreation: vi.fn(async () => undefined),
    retryPendingWorktreeCreation: vi.fn(async () => undefined),
    dismissPendingWorktreeCreation: vi.fn(),
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
  mocks.state.worktreeProjections = [{
    id: 'worktree-beta',
    instanceId: 'instance-beta',
    state: 'managed',
    parentWorktreeId: null,
    childWorktreeIds: [],
    native: null,
    record: {
      id: 'worktree-beta', instanceId: 'instance-beta', repositoryId: 'repo-beta', repositoryPath: 'E:/repos/beta',
      worktreePath: 'E:/worktrees/fix-login', branch: 'vibelink/fix-login', head: 'a'.repeat(40), baseRef: 'HEAD',
      sessionId: 'beta-worktree', parentSessionId: 'beta', parentWorktreeId: null, parentInstanceId: null,
      origin: 'manual', lifecycle: 'active', locked: false, lockReason: null, prunable: false, prunableReason: null,
      dirty: true, untracked: false, hasConflicts: false, ahead: 0, behind: 0, exists: true,
      setupPolicy: 'inherit', sparsePreset: null, linkedFiles: [], initialAgent: null, initialPrompt: null,
      comment: null, reviewTarget: null, createdAt: 5_000, updatedAt: 5_000, lastActivityAt: 5_000,
    },
  }]
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
    mocks.state.settings.workspaceGroupIds = { alpha: 'tools', beta: 'core', gamma: 'core' }
    mocks.state.settings.workspaceOrder = ['gamma', 'alpha', 'delta', 'beta']
    mocks.state.paneCompletionHighlights = {}
    mocks.state.paneReviewMarkers = {}
    mocks.state.attentionSnapshot = null
    mocks.state.settings.workspaceSortMode = 'manual'
    mocks.state.worktreeProjections = []
    mocks.state.pendingWorktreeCreations = {}
    mocks.state.settings.workspaceProfileIds = {}
    mocks.state.activeSessionId = 'gamma'
    clearOpenContentSnapshot()
    vi.clearAllMocks()
    open.mockReset().mockResolvedValue(null)
    invoke.mockReset().mockImplementation(async (command: string) => {
      if (command === 'git_is_available') return true
      if (command === 'git_worktree_resolve_root') return { root: 'E:/VibeLinkWorktrees', example: 'E:/VibeLinkWorktrees/beta-12345678/<name>-abc12345', writable: true, fallbackReason: null }
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
      'pane-beta-1': { completedAt: 1, source: 'agent-hook', sessionId: 'beta' },
      'pane-beta-2': { completedAt: 2, source: 'agent-hook', sessionId: 'beta' },
    }
    renderSidebar()

    const row = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    expect(row).toHaveClass('session-row', 'has-completions')
    expect(row).toHaveAttribute('data-completion-count', '2')
    expect(within(row).getByLabelText(/Done · 2 completions · source agent-hook · completion-marker/)).toHaveTextContent('2')
  })

  test('renders hook-only smart attention order and disables manual dragging', () => {
    const now = Date.now()
    mocks.state.settings.workspaceGroups = []
    mocks.state.settings.workspaceGroupIds = {}
    mocks.state.settings.workspaceSortMode = 'smart'
    mocks.state.attentionSnapshot = {
      capturedAt: now,
      panes: [
        { workspaceId: 'alpha', paneId: 'pane-alpha', state: 'blocked', stateUpdatedAt: now - 4_000, lastOutputAt: now - 4_000, unreadCount: 2, interrupted: false, source: 'orchestration', alive: true, title: 'Shell' },
        { workspaceId: 'beta', paneId: 'pane-beta', state: 'done', stateUpdatedAt: now - 3_000, lastOutputAt: now - 3_000, unreadCount: 0, interrupted: false, source: 'orchestration', alive: true, title: 'Shell' },
        { workspaceId: 'gamma', paneId: 'pane-gamma', state: 'working', stateUpdatedAt: now - 2_000, lastOutputAt: now - 2_000, unreadCount: 0, interrupted: false, source: 'orchestration', alive: true, title: 'Shell' },
        { workspaceId: 'delta', paneId: 'pane-delta', state: 'idle', stateUpdatedAt: now - 1_000, lastOutputAt: now - 1_000, unreadCount: 0, interrupted: false, source: 'orchestration', alive: true, title: 'Shell' },
      ],
    }
    renderSidebar()

    expect(screen.getAllByRole('button').filter((row) => row.hasAttribute('data-session-id')).map((row) => row.dataset.sessionId)).toEqual(['alpha', 'gamma', 'delta', 'beta'])
    const alpha = screen.getByText('Alpha').closest('[data-session-id]') as HTMLElement
    expect(alpha).not.toHaveAttribute('data-workspace-reorder-id')
    expect(within(alpha).getByLabelText(/Needs attention · 2 unread · source orchestration · blocked/)).toBeInTheDocument()

    clickWorkspaceRow(screen.getByText('Beta').closest('[data-session-id]') as HTMLElement)
    expect(mocks.state.openSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByText('Beta').closest('[data-session-id]') as HTMLElement)
    expect(mocks.state.openSession).toHaveBeenCalledExactlyOnceWith('beta')
    expect(mocks.state.reorderWorkspaces).not.toHaveBeenCalled()
  })

  test('keeps keyboard focus on the same workspace when smart evidence reorders rows', () => {
    const now = Date.now()
    mocks.state.settings.workspaceGroups = []
    mocks.state.settings.workspaceGroupIds = {}
    mocks.state.settings.workspaceSortMode = 'smart'
    mocks.state.attentionSnapshot = {
      capturedAt: now,
      panes: [
        { workspaceId: 'alpha', paneId: 'pane-alpha', state: 'blocked', stateUpdatedAt: now - 2_000, lastOutputAt: now - 2_000, unreadCount: 0, interrupted: false, source: 'orchestration', alive: true, title: 'Shell' },
        { workspaceId: 'beta', paneId: 'pane-beta', state: 'working', stateUpdatedAt: now - 1_000, lastOutputAt: now - 1_000, unreadCount: 0, interrupted: false, source: 'orchestration', alive: true, title: 'Shell' },
      ],
    }
    const view = renderSidebar()
    const beta = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    beta.focus()
    expect(document.activeElement).toBe(beta)

    mocks.state.attentionSnapshot = {
      capturedAt: now + 1_000,
      panes: [
        { workspaceId: 'alpha', paneId: 'pane-alpha', state: 'working', stateUpdatedAt: now, lastOutputAt: now, unreadCount: 0, interrupted: false, source: 'orchestration', alive: true, title: 'Shell' },
        { workspaceId: 'beta', paneId: 'pane-beta', state: 'blocked', stateUpdatedAt: now + 1_000, lastOutputAt: now + 1_000, unreadCount: 0, interrupted: false, source: 'orchestration', alive: true, title: 'Shell' },
      ],
    }
    view.rerender(<WorkspacesSidebar integration={integration} />)

    expect(document.activeElement).toBe(screen.getByText('Beta').closest('[data-session-id]'))
    expect(mocks.state.activeSessionId).toBe('gamma')
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

  test('uses the group row as the root workspace and renders its open work directly below the group', () => {
    mocks.state.settings.workspaceGroups = [
      { id: 'core', name: 'Core', collapsed: false, rootFolder: 'E:\\repos\\beta\\' },
      { id: 'tools', name: 'Tools', collapsed: false, rootFolder: null },
    ]
    mocks.state.activeSessionId = 'beta'
    publishOpenContentSnapshot([
      { panelId: 'content:terminalWindow:root', kind: 'terminalWindow', title: 'Terminal', icon: 'terminal', active: true },
      { panelId: 'content:terminal:pane-1', kind: 'terminal', title: 'Codex', icon: 'codex', active: true },
    ])

    renderSidebar()

    const group = screen.getByText('Core').closest('.workspaces-group') as HTMLElement
    const groupRow = within(group).getByText('Core').closest('[data-workspace-group-row]') as HTMLElement
    expect(groupRow).toHaveClass('active')
    expect(groupRow).toHaveAttribute('data-session-id', 'beta')
    expect(within(group).queryByText('Beta')).not.toBeInTheDocument()
    expect(within(group).getByRole('list', { name: 'Open workspace items' })).toBeInTheDocument()
    expect(within(group).getByText('Codex')).toBeInTheDocument()
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

  test('removes a worktree with only the blockers the user acknowledged', async () => {
    seedBetaWorktree()
    choiceDialog.mockResolvedValue('checkout-and-branch')
    confirmDialog.mockResolvedValue(true)
    mocks.state.preflightWorktreeRemoval.mockResolvedValue({
      worktreeId: 'worktree-beta',
      instanceId: 'instance-beta',
      repositoryPath: 'E:/repos/beta',
      worktreePath: 'E:/worktrees/fix-login',
      branch: 'vibelink/fix-login',
      blockers: [{ kind: 'dirty', hard: false, message: 'Uncommitted changes are present.' }],
      warnings: [],
    })
    renderSidebar()

    const worktreeRow = screen.getByText('Fix Login').closest('[data-session-id]') as HTMLElement
    fireEvent.click(within(worktreeRow).getByRole('button', { name: 'Remove worktree Fix Login' }))

    await waitFor(() => expect(mocks.state.removeWorktreeSession).toHaveBeenCalledWith('beta-worktree', { deleteBranch: true, acknowledgedBlockers: ['dirty'] }))
    expect(integration.onDeleteWorkspaceRequested).not.toHaveBeenCalled()
  })

  test('refuses removal when a blocker appears after the user confirmed', async () => {
    seedBetaWorktree()
    choiceDialog.mockResolvedValue('checkout')
    confirmDialog.mockResolvedValue(true)
    mocks.state.preflightWorktreeRemoval
      .mockResolvedValueOnce({ worktreeId: 'worktree-beta', instanceId: 'instance-beta', repositoryPath: 'E:/repos/beta', worktreePath: 'E:/worktrees/fix-login', branch: 'vibelink/fix-login', blockers: [], warnings: [] })
      .mockResolvedValueOnce({ worktreeId: 'worktree-beta', instanceId: 'instance-beta', repositoryPath: 'E:/repos/beta', worktreePath: 'E:/worktrees/fix-login', branch: 'vibelink/fix-login', blockers: [], warnings: [] })
      .mockResolvedValueOnce({ worktreeId: 'worktree-beta', instanceId: 'instance-beta', repositoryPath: 'E:/repos/beta', worktreePath: 'E:/worktrees/fix-login', branch: 'vibelink/fix-login', blockers: [{ kind: 'dirty', hard: false, message: 'Uncommitted changes are present.' }], warnings: [] })
    renderSidebar()

    const worktreeRow = screen.getByText('Fix Login').closest('[data-session-id]') as HTMLElement
    fireEvent.click(within(worktreeRow).getByRole('button', { name: 'Remove worktree Fix Login' }))

    await waitFor(() => expect(mocks.state.setError).toHaveBeenCalledWith(expect.stringContaining('changed while you were confirming')))
    expect(mocks.state.removeWorktreeSession).not.toHaveBeenCalled()
  })

  test('refuses removal on a hard blocker without prompting for a branch policy', async () => {
    seedBetaWorktree()
    mocks.state.preflightWorktreeRemoval.mockResolvedValue({
      worktreeId: 'worktree-beta',
      instanceId: 'instance-beta',
      repositoryPath: 'E:/repos/beta',
      worktreePath: 'E:/worktrees/fix-login',
      branch: 'vibelink/fix-login',
      blockers: [{ kind: 'git_locked', hard: true, message: 'The checkout is locked by Git.' }],
      warnings: [],
    })
    renderSidebar()

    const worktreeRow = screen.getByText('Fix Login').closest('[data-session-id]') as HTMLElement
    fireEvent.click(within(worktreeRow).getByRole('button', { name: 'Remove worktree Fix Login' }))

    await waitFor(() => expect(mocks.state.setError).toHaveBeenCalledWith(expect.stringContaining('The checkout is locked by Git.')))
    expect(choiceDialog).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktreeSession).not.toHaveBeenCalled()
  })

  test('shows a pending creation row with its stage and keeps focus where the user is', async () => {
    mocks.state.pendingWorktreeCreations = {
      'operation-1': {
        operationId: 'operation-1',
        parentSessionId: 'beta',
        repositoryPath: 'E:/repos/beta',
        name: 'Fix Login',
        branch: 'vibelink/fix-login',
        startRef: 'HEAD',
        stage: 'creating',
        startedAt: 1,
        updatedAt: 1,
        cancelRequested: false,
        error: null,
        sessionId: null,
        request: {} as never,
      },
    }
    renderSidebar()

    const betaRow = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    expect(within(betaRow).getByText('Fix Login')).toBeInTheDocument()
    expect(within(betaRow).getByText('Creating checkout…')).toBeInTheDocument()
    expect(mocks.state.openSession).not.toHaveBeenCalled()

    fireEvent.click(within(betaRow).getByRole('button', { name: 'Cancel creating Fix Login' }))
    await waitFor(() => expect(mocks.state.cancelPendingWorktreeCreation).toHaveBeenCalledWith('operation-1'))
  })

  test('offers retry and recovery detail for a failed pending creation', async () => {
    mocks.state.pendingWorktreeCreations = {
      'operation-2': {
        operationId: 'operation-2',
        parentSessionId: 'beta',
        repositoryPath: 'E:/repos/beta',
        name: 'Fix Login',
        branch: 'vibelink/fix-login',
        startRef: 'HEAD',
        stage: 'failed',
        startedAt: 1,
        updatedAt: 2,
        cancelRequested: false,
        error: 'setup failed; retained E:/worktrees/fix-login — remove it manually before retrying',
        sessionId: null,
        request: {} as never,
      },
    }
    renderSidebar()

    const betaRow = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    expect(within(betaRow).getByRole('alert')).toHaveTextContent('retained E:/worktrees/fix-login')
    fireEvent.click(within(betaRow).getByRole('button', { name: 'Retry creating Fix Login' }))
    await waitFor(() => expect(mocks.state.retryPendingWorktreeCreation).toHaveBeenCalledWith('operation-2'))
  })

  test('renders a registry row that owns no workspace so a broken checkout stays visible', () => {
    mocks.state.worktreeProjections = [{
      id: 'worktree-missing',
      instanceId: 'instance-missing',
      state: 'missing',
      parentWorktreeId: null,
      childWorktreeIds: [],
      native: null,
      record: {
        id: 'worktree-missing', instanceId: 'instance-missing', repositoryId: 'repo-beta', repositoryPath: 'E:/repos/beta',
        worktreePath: 'E:/worktrees/gone', branch: 'vibelink/gone', head: 'b'.repeat(40), baseRef: 'HEAD',
        sessionId: null, parentSessionId: 'beta', parentWorktreeId: null, parentInstanceId: null,
        origin: 'manual', lifecycle: 'missing', locked: false, lockReason: null, prunable: false, prunableReason: null,
        dirty: false, untracked: false, hasConflicts: false, ahead: 0, behind: 0, exists: false,
        setupPolicy: 'inherit', sparsePreset: null, linkedFiles: [], initialAgent: null, initialPrompt: null,
        comment: null, reviewTarget: null, createdAt: 1, updatedAt: 1, lastActivityAt: 1,
      },
    }]
    renderSidebar()

    const betaRow = screen.getByText('Beta').closest('[data-session-id]') as HTMLElement
    expect(within(betaRow).getByText('vibelink/gone')).toBeInTheDocument()
    expect(within(betaRow).getByText('missing · no workspace')).toBeInTheDocument()
  })

  test('opens Manage worktrees from a worktree context menu for its parent repository', async () => {
    seedBetaWorktree()
    renderSidebar()

    const worktreeRow = screen.getByText('Fix Login').closest('[data-session-id]') as HTMLElement
    fireEvent.contextMenu(worktreeRow, { clientX: 120, clientY: 140 })
    fireEvent.click(screen.getByRole('menuitem', { name: 'Manage worktrees' }))

    expect(screen.getByRole('dialog', { name: 'Manage worktrees' })).toBeInTheDocument()
    await waitFor(() => expect(mocks.state.reconcileRepositoryWorktrees).toHaveBeenCalledWith('E:/repos/beta'))
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
    expect(mocks.state.setWorkspaceGroup).toHaveBeenCalledExactlyOnceWith('beta', 'core')

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

  test('never captures the pointer from a row action button in manual sort', () => {
    renderSidebar()

    const editButton = screen.getByRole('button', { name: 'Edit Alpha' })
    const row = editButton.closest('[data-session-id]') as HTMLElement
    const setPointerCapture = vi.fn()
    Object.defineProperties(row, {
      setPointerCapture: { configurable: true, value: setPointerCapture },
      hasPointerCapture: { configurable: true, value: vi.fn(() => false) },
    })

    fireEvent.pointerDown(editButton, { button: 0, pointerId: 11, clientY: 40 })
    expect(setPointerCapture).not.toHaveBeenCalled()

    fireEvent.pointerDown(row, { button: 0, pointerId: 12, clientY: 40 })
    expect(setPointerCapture).toHaveBeenCalledWith(12)
  })
})

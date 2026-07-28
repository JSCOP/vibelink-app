// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionMeta } from '../../ipc/types'
import type { WorktreeProjection, WorktreeReconcileState, WorktreeRecord } from '../../ipc/worktrees'

const { invoke, choiceDialog, confirmDialog, promptDialog } = vi.hoisted(() => ({
  invoke: vi.fn(),
  choiceDialog: vi.fn(),
  confirmDialog: vi.fn(),
  promptDialog: vi.fn(),
}))

const mocks = vi.hoisted(() => ({
  state: {
    reconcileRepositoryWorktrees: vi.fn(),
    importExternalWorktree: vi.fn(),
    preflightWorktreeRemoval: vi.fn(),
    removeWorktreeById: vi.fn(),
    moveWorktreeSession: vi.fn(async () => undefined),
  },
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../appDialogStore', () => ({ choiceDialog, confirmDialog, promptDialog }))
vi.mock('../../state/store', () => ({
  useWorkspaceStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}))

import { WorktreeManageDialog } from './WorktreeManageDialog'

const sourceSession: SessionMeta = {
  id: 'repo-session',
  name: 'Repository',
  paneCount: 2,
  createdAt: 1,
  workspaceFolder: 'E:/repos/project',
}

function record(overrides: Partial<WorktreeRecord> & Pick<WorktreeRecord, 'id' | 'worktreePath' | 'branch'>): WorktreeRecord {
  return {
    instanceId: `instance-${overrides.id}`,
    repositoryId: 'repository-1',
    repositoryPath: 'E:/repos/project',
    head: 'a'.repeat(40),
    baseRef: 'HEAD',
    sessionId: null,
    parentSessionId: 'repo-session',
    parentWorktreeId: null,
    parentInstanceId: null,
    origin: 'manual',
    lifecycle: 'active',
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
    dirty: false,
    untracked: false,
    hasConflicts: false,
    ahead: 0,
    behind: 0,
    exists: true,
    setupPolicy: 'inherit',
    sparsePreset: null,
    linkedFiles: [],
    initialAgent: null,
    initialPrompt: null,
    comment: null,
    reviewTarget: null,
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: 1,
    ...overrides,
  }
}

function projection(
  id: string,
  state: WorktreeReconcileState,
  options: { record?: WorktreeRecord | null; native?: Partial<WorktreeProjection['native']> | null } = {},
): WorktreeProjection {
  return {
    id,
    instanceId: `instance-${id}`,
    state,
    parentWorktreeId: null,
    childWorktreeIds: [],
    record: options.record ?? null,
    native: options.native === null ? null : {
      worktreePath: `E:/Worktrees/${id}`,
      normalizedPath: `e:/worktrees/${id}`,
      gitDirIdentity: `git-${id}`,
      head: 'a'.repeat(40),
      branch: `feature/${id}`,
      detached: false,
      bare: false,
      locked: false,
      lockReason: null,
      prunable: false,
      prunableReason: null,
      exists: true,
      isMain: false,
      dirty: false,
      untracked: false,
      hasConflicts: false,
      ahead: 0,
      behind: 0,
      ...options.native,
    } as WorktreeProjection['native'],
  }
}

const mainRow = projection('main', 'managed', {
  record: record({ id: 'main', worktreePath: 'E:/repos/project', branch: 'main', sessionId: 'repo-session' }),
  native: { worktreePath: 'E:/repos/project', branch: 'main', isMain: true },
})
const featureRow = projection('feature', 'managed', {
  record: record({ id: 'feature', worktreePath: 'E:/Worktrees/feature', branch: 'feature/login', sessionId: 'feature-session', dirty: true }),
  native: { worktreePath: 'E:/Worktrees/feature', branch: 'feature/login', dirty: true },
})
const unboundRow = projection('unbound', 'managed', {
  record: record({ id: 'unbound', worktreePath: 'E:/Worktrees/unbound', branch: 'feature/unbound', sessionId: null }),
  native: { worktreePath: 'E:/Worktrees/unbound', branch: 'feature/unbound' },
})
const externalRow = projection('external', 'external', {
  native: { worktreePath: 'E:/Worktrees/external', branch: 'feature/external' },
})
const missingRow = projection('missing', 'missing', {
  record: record({ id: 'missing', worktreePath: 'E:/Worktrees/missing', branch: 'feature/missing', exists: false, lifecycle: 'missing' }),
  native: null,
})
const conflictedRow = projection('conflicted', 'conflicted', {
  record: record({ id: 'conflicted', worktreePath: 'E:/Worktrees/conflicted', branch: 'feature/conflicted' }),
  native: { worktreePath: 'E:/Worktrees/conflicted', branch: 'feature/conflicted', locked: true, lockReason: 'in use by another tool' },
})

function renderDialog() {
  return render(<WorktreeManageDialog sourceSession={sourceSession} onClose={vi.fn()} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.reconcileRepositoryWorktrees.mockResolvedValue([mainRow, featureRow, externalRow, missingRow, conflictedRow])
  mocks.state.importExternalWorktree.mockResolvedValue(projection('external', 'managed', {
    record: record({ id: 'external', worktreePath: 'E:/Worktrees/external', branch: 'feature/external' }),
  }))
  mocks.state.preflightWorktreeRemoval.mockResolvedValue({
    worktreeId: 'feature',
    instanceId: 'instance-feature',
    repositoryPath: 'E:/repos/project',
    worktreePath: 'E:/Worktrees/feature',
    branch: 'feature/login',
    blockers: [],
    warnings: [],
  })
  mocks.state.removeWorktreeById.mockResolvedValue({
    checkoutRemoved: true,
    branchDeleted: true,
    branchPreservedReason: null,
    sessionRemoved: true,
    metadataRemoved: true,
  })
  invoke.mockResolvedValue(undefined)
  choiceDialog.mockResolvedValue(null)
  confirmDialog.mockResolvedValue(false)
  promptDialog.mockResolvedValue(null)
})

afterEach(cleanup)

describe('WorktreeManageDialog', () => {
  test('renders every reconcile state with its status and lock recovery instruction', async () => {
    renderDialog()

    const dialog = screen.getByRole('dialog', { name: 'Manage worktrees' })
    expect(await within(dialog).findByText('feature/login')).toBeInTheDocument()
    expect(mocks.state.reconcileRepositoryWorktrees).toHaveBeenCalledWith('E:/repos/project')
    for (const state of ['managed', 'external', 'missing', 'conflicted']) {
      expect(within(dialog).getAllByText(state).length).toBeGreaterThan(0)
    }
    expect(within(dialog).getByText('dirty')).toBeInTheDocument()
    expect(within(dialog).getByText(/git worktree unlock/)).toBeInTheDocument()
    expect(within(dialog).getByText('E:/Worktrees/feature')).toHaveAttribute('title', 'E:/Worktrees/feature')
  })

  test('imports an external checkout only through the explicit import action', async () => {
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Import feature/external into VibeLink' }))

    await waitFor(() => expect(mocks.state.importExternalWorktree).toHaveBeenCalledWith({
      repositoryPath: 'E:/repos/project',
      worktreePath: 'E:/Worktrees/external',
      parentSessionId: 'repo-session',
    }))
  })

  test('retries a managed import whose session binding was interrupted', async () => {
    mocks.state.reconcileRepositoryWorktrees.mockResolvedValue([unboundRow])
    mocks.state.importExternalWorktree.mockResolvedValue(projection('unbound', 'managed', {
      record: record({ id: 'unbound', worktreePath: 'E:/Worktrees/unbound', branch: 'feature/unbound', sessionId: 'session-unbound' }),
    }))
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Bind feature/unbound to a VibeLink workspace' }))

    await waitFor(() => expect(mocks.state.importExternalWorktree).toHaveBeenCalledWith({
      repositoryPath: 'E:/repos/project',
      worktreePath: 'E:/Worktrees/unbound',
      parentSessionId: 'repo-session',
    }))
  })

  test('refuses to remove an external checkout that was never imported', async () => {
    renderDialog()

    const externalRemove = await screen.findByRole('button', { name: 'Remove feature/external worktree' })
    expect(externalRemove).toBeDisabled()
    expect(mocks.state.removeWorktreeById).not.toHaveBeenCalled()
  })

  test('refuses destructive actions on a conflicted checkout', async () => {
    renderDialog()

    expect(await screen.findByRole('button', { name: 'Remove feature/conflicted worktree' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Move feature/conflicted worktree' })).toBeDisabled()
  })

  test('reveals an existing checkout in File Explorer', async () => {
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Reveal feature/login in File Explorer' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('reveal_path', { path: 'E:/Worktrees/feature' }))
  })

  test('moves a session-bound worktree and refreshes the list', async () => {
    promptDialog.mockResolvedValue('F:/Moved/Feature')
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Move feature/login worktree' }))

    await waitFor(() => expect(mocks.state.moveWorktreeSession).toHaveBeenCalledWith('feature-session', 'F:/Moved/Feature'))
    expect(promptDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: 'E:/Worktrees/feature' }))
    await waitFor(() => expect(mocks.state.reconcileRepositoryWorktrees).toHaveBeenCalledTimes(2))
  })

  test.each([
    ['checkout', false],
    ['checkout-and-branch', true],
  ] as const)('maps the %s remove choice to deleteBranch=%s with no acknowledged blockers', async (choice, deleteBranch) => {
    choiceDialog.mockResolvedValue(choice)
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove feature/login worktree' }))

    await waitFor(() => expect(mocks.state.removeWorktreeById).toHaveBeenCalledWith('feature', { deleteBranch, acknowledgedBlockers: [] }))
    expect(confirmDialog).not.toHaveBeenCalled()
  })

  test('reports a preserved branch instead of retrying a forced delete', async () => {
    choiceDialog.mockResolvedValue('checkout-and-branch')
    mocks.state.removeWorktreeById.mockResolvedValue({
      checkoutRemoved: true,
      branchDeleted: false,
      branchPreservedReason: 'branch has unmerged commits',
      sessionRemoved: true,
      metadataRemoved: true,
    })
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove feature/login worktree' }))

    // A preserved branch is a successful outcome the user must read, not an
    // error, so it is announced politely rather than assertively.
    expect(await screen.findByRole('status')).toHaveTextContent('branch has unmerged commits')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(mocks.state.removeWorktreeById).toHaveBeenCalledTimes(1)
  })

  test('refuses removal on a hard blocker without asking for a branch policy', async () => {
    mocks.state.preflightWorktreeRemoval.mockResolvedValue({
      worktreeId: 'feature',
      instanceId: 'instance-feature',
      repositoryPath: 'E:/repos/project',
      worktreePath: 'E:/Worktrees/feature',
      branch: 'feature/login',
      blockers: [{ kind: 'identity_mismatch', hard: true, message: 'The checkout identity changed.' }],
      warnings: [],
    })
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove feature/login worktree' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The checkout identity changed.')
    expect(choiceDialog).not.toHaveBeenCalled()
    expect(mocks.state.removeWorktreeById).not.toHaveBeenCalled()
  })

  test('acknowledges exactly the blockers the user confirmed', async () => {
    choiceDialog.mockResolvedValue('checkout')
    confirmDialog.mockResolvedValue(true)
    mocks.state.preflightWorktreeRemoval.mockResolvedValue({
      worktreeId: 'feature',
      instanceId: 'instance-feature',
      repositoryPath: 'E:/repos/project',
      worktreePath: 'E:/Worktrees/feature',
      branch: 'feature/login',
      blockers: [
        { kind: 'dirty', hard: false, message: 'Uncommitted changes are present.' },
        { kind: 'live_panes', hard: false, message: 'Terminal panes are live.' },
      ],
      warnings: [],
    })
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove feature/login worktree' }))

    await waitFor(() => expect(mocks.state.removeWorktreeById).toHaveBeenCalledWith('feature', { deleteBranch: false, acknowledgedBlockers: ['dirty', 'live_panes'] }))
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Uncommitted changes are present.'),
    }))
  })

  test('refuses removal when a new blocker appears after confirmation', async () => {
    choiceDialog.mockResolvedValue('checkout')
    const clean = {
      worktreeId: 'feature',
      instanceId: 'instance-feature',
      repositoryPath: 'E:/repos/project',
      worktreePath: 'E:/Worktrees/feature',
      branch: 'feature/login',
      blockers: [],
      warnings: [],
    }
    mocks.state.preflightWorktreeRemoval
      .mockResolvedValueOnce(clean)
      .mockResolvedValueOnce(clean)
      .mockResolvedValueOnce({ ...clean, blockers: [{ kind: 'dirty', hard: false, message: 'Uncommitted changes are present.' }] })
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove feature/login worktree' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('changed while you were confirming')
    expect(mocks.state.removeWorktreeById).not.toHaveBeenCalled()
  })
})

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionMeta, WorktreeEntry } from '../../ipc/types'

const { invoke, choiceDialog, confirmDialog, promptDialog } = vi.hoisted(() => ({
  invoke: vi.fn(),
  choiceDialog: vi.fn(),
  confirmDialog: vi.fn(),
  promptDialog: vi.fn(),
}))

const mocks = vi.hoisted(() => ({
  state: {
    settings: { workspaceWorktrees: {} as Record<string, { worktreePath: string }> },
    moveWorktreeSession: vi.fn(async () => undefined),
    removeWorktreeSession: vi.fn(async () => undefined),
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

const entries: WorktreeEntry[] = [
  {
    worktreePath: 'E:/repos/project',
    branch: 'main',
    head: 'a'.repeat(40),
    isMain: true,
    locked: false,
    prunable: false,
    dirty: false,
    exists: true,
  },
  {
    worktreePath: 'E:/Worktrees/Feature',
    branch: 'feature/login',
    head: 'b'.repeat(40),
    isMain: false,
    locked: false,
    prunable: false,
    dirty: true,
    exists: true,
  },
  {
    worktreePath: 'E:/Worktrees/Missing',
    branch: '',
    head: 'c'.repeat(40),
    isMain: false,
    locked: true,
    prunable: true,
    dirty: false,
    exists: false,
  },
]

function renderDialog() {
  return render(<WorktreeManageDialog sourceSession={sourceSession} onClose={vi.fn()} />)
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.state.settings.workspaceWorktrees = {
    'feature-session': { worktreePath: 'e:\\worktrees\\feature\\' },
  }
  invoke.mockImplementation(async (command: string) => {
    if (command === 'git_worktree_list') return entries
    return undefined
  })
  choiceDialog.mockResolvedValue(null)
  confirmDialog.mockResolvedValue(false)
  promptDialog.mockResolvedValue(null)
})

afterEach(cleanup)

describe('WorktreeManageDialog', () => {
  test('lists worktrees with paths and status badges', async () => {
    renderDialog()

    const dialog = screen.getByRole('dialog', { name: 'Manage worktrees' })
    expect(await within(dialog).findByText('feature/login')).toBeInTheDocument()
    expect(within(dialog).getAllByText('main')).toHaveLength(2)
    expect(within(dialog).getByText('dirty')).toBeInTheDocument()
    expect(within(dialog).getByText('locked')).toBeInTheDocument()
    expect(within(dialog).getByText('prunable')).toBeInTheDocument()
    expect(within(dialog).getByText('missing')).toBeInTheDocument()
    expect(within(dialog).getByText('E:/Worktrees/Feature')).toHaveAttribute('title', 'E:/Worktrees/Feature')
    expect(invoke).toHaveBeenCalledWith('git_worktree_list', { workspaceFolder: 'E:/repos/project' })
  })

  test('reveals an existing checkout in File Explorer', async () => {
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Reveal feature/login in File Explorer' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('reveal_path', { path: 'E:/Worktrees/Feature' }))
  })

  test('moves a mapped VibeLink worktree and refreshes the list', async () => {
    promptDialog.mockResolvedValue('F:/Moved/Feature')
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Move feature/login worktree' }))

    await waitFor(() => expect(mocks.state.moveWorktreeSession).toHaveBeenCalledWith('feature-session', 'F:/Moved/Feature'))
    expect(promptDialog).toHaveBeenCalledWith(expect.objectContaining({ defaultValue: 'E:/Worktrees/Feature' }))
    expect(invoke.mock.calls.filter(([command]) => command === 'git_worktree_list')).toHaveLength(2)
  })

  test('confirms the source and current branches before merging', async () => {
    confirmDialog.mockResolvedValue(true)
    invoke.mockImplementation(async (command: string) => {
      if (command === 'git_worktree_list') return entries
      if (command === 'git_branches') return [{ name: 'main', isHead: true }]
      return undefined
    })
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Merge feature/login worktree' }))

    await waitFor(() => expect(invoke).toHaveBeenCalledWith('git_merge', { workspaceFolder: 'E:/repos/project', refName: 'feature/login' }))
    expect(confirmDialog).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringMatching(/feature\/login.*main/),
    }))
  })

  test.each([
    ['checkout', false],
    ['checkout-and-branch', true],
  ] as const)('maps the %s remove choice to deleteBranch=%s', async (choice, deleteBranch) => {
    choiceDialog.mockResolvedValue(choice)
    renderDialog()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove feature/login worktree' }))

    await waitFor(() => expect(mocks.state.removeWorktreeSession).toHaveBeenCalledWith('feature-session', { deleteBranch, force: true }))
    expect(choiceDialog).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Uncommitted changes'),
      choices: expect.arrayContaining([
        expect.objectContaining({ id: 'checkout' }),
        expect.objectContaining({ id: 'checkout-and-branch' }),
      ]),
    }))
    expect(invoke).not.toHaveBeenCalledWith('git_worktree_remove', expect.anything())
  })
})

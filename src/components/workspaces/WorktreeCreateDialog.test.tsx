// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { SessionMeta } from '../../ipc/types'
import { defaultSettings } from '../../state/profiles'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
const mocks = vi.hoisted(() => ({
  storage: { mode: 'drive', drive: '', folderName: 'VibeLinkWorktrees', customRoot: '', groupByRepository: true },
  fallbackReason: null as string | null,
}))

vi.mock('@tauri-apps/api/core', () => ({ invoke }))
vi.mock('../../state/store', () => ({
  useWorkspaceStore: (selector: (state: { settings: { worktreeStorage: typeof mocks.storage } }) => unknown) => selector({ settings: { worktreeStorage: mocks.storage } }),
}))

import { WorktreeCreateDialog } from './WorktreeCreateDialog'
import { worktreeBranchName } from './worktreeNaming'

const sourceSession: SessionMeta = {
  id: 'repo-session',
  name: 'Repository',
  paneCount: 2,
  createdAt: 1,
  workspaceFolder: 'E:/repos/project',
}

beforeEach(() => {
  mocks.fallbackReason = null
  invoke.mockReset().mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command !== 'git_worktree_resolve_root') return undefined
    const name = typeof args?.name === 'string' ? args.name : ''
    return {
      root: 'E:\\VibeLinkWorktrees',
      example: `E:\\VibeLinkWorktrees\\project-01234567\\${name === 'Fix Login' ? 'fix-login' : '<name>'}-abc12345`,
      writable: true,
      fallbackReason: mocks.fallbackReason,
    }
  })
})

afterEach(cleanup)

describe('WorktreeCreateDialog', () => {
  test('derives a safe VibeLink branch until the user edits it', () => {
    expect(worktreeBranchName(' Fix Login / OAuth ')).toBe('vibelink/fix-login-oauth')
    const onCreate = vi.fn(async () => undefined)
    render(
      <WorktreeCreateDialog
        sourceSession={sourceSession}
        profiles={defaultSettings.profiles}
        initialProfileId="codex"
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Worktree name'), { target: { value: 'Fix Login / OAuth' } })
    expect(screen.getByLabelText('New branch')).toHaveValue('vibelink/fix-login-oauth')
    fireEvent.change(screen.getByLabelText('New branch'), { target: { value: 'feature/custom-branch' } })
    fireEvent.change(screen.getByLabelText('Worktree name'), { target: { value: 'Another task' } })
    expect(screen.getByLabelText('New branch')).toHaveValue('feature/custom-branch')
  })

  test('shows the resolved managed folder and compact fallback warning', async () => {
    mocks.fallbackReason = 'Requested drive is unavailable; using app data.'
    render(
      <WorktreeCreateDialog
        sourceSession={sourceSession}
        profiles={defaultSettings.profiles}
        initialProfileId="omp"
        onCreate={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('heading', { name: 'Create worktree' })).toBeInTheDocument()
    expect(screen.queryByText('Create isolated AI workspace')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Worktree name'), { target: { value: 'Fix Login' } })
    const managedFolder = await screen.findByText('E:\\VibeLinkWorktrees\\project-01234567\\fix-login-abc12345')
    expect(managedFolder).toHaveAttribute('title', 'E:\\VibeLinkWorktrees\\project-01234567\\fix-login-abc12345')
    expect(invoke).toHaveBeenCalledWith('git_worktree_resolve_root', {
      workspaceFolder: 'E:/repos/project',
      storage: mocks.storage,
      name: 'Fix Login',
    })
    expect(screen.getByText(/Requested drive is unavailable; using app data/)).toBeInTheDocument()
    expect(screen.getByText('This worktree folder')).toBeInTheDocument()
    expect(screen.getByText(/Uncommitted source changes are not copied/)).toBeInTheDocument()
    expect(screen.getByText(/Branches and Git history are shared/)).toBeInTheDocument()
    expect(screen.getByText(/must not already exist/)).toBeInTheDocument()
  })

  test('submits the repository, ref, branch, and selected agent profile', async () => {
    const onCreate = vi.fn(async () => undefined)
    render(
      <WorktreeCreateDialog
        sourceSession={sourceSession}
        profiles={defaultSettings.profiles}
        initialProfileId="codex"
        onCreate={onCreate}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Worktree name'), { target: { value: 'Fix Login' } })
    fireEvent.change(screen.getByLabelText('Start ref'), { target: { value: 'origin/main' } })
    fireEvent.change(screen.getByLabelText('Start with'), { target: { value: 'claude' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      parentSessionId: sourceSession.id,
      name: 'Fix Login',
      startRef: 'origin/main',
      branch: 'vibelink/fix-login',
      profileId: 'claude',
    }))
  })
})

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

  test('submits every lifecycle field the create transaction accepts', async () => {
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
    fireEvent.click(screen.getByRole('switch', { name: 'Fetch remote before creating' }))
    fireEvent.change(screen.getByLabelText('Setup policy'), { target: { value: 'run' } })
    fireEvent.change(screen.getByLabelText('Sparse preset'), { target: { value: ' frontend ' } })
    fireEvent.change(screen.getByLabelText('Linked files'), { target: { value: '.env\n config/local.json ,\n' } })
    fireEvent.change(screen.getByLabelText('Initial agent'), { target: { value: ' claude ' } })
    fireEvent.change(screen.getByLabelText('Initial prompt'), { target: { value: ' Fix the login redirect ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      parentSessionId: sourceSession.id,
      name: 'Fix Login',
      startRef: 'origin/main',
      branch: 'vibelink/fix-login',
      profileId: 'claude',
      fetch: true,
      setupPolicy: 'run',
      sparsePreset: 'frontend',
      linkedFiles: ['.env', 'config/local.json'],
      initialAgent: 'claude',
      initialPrompt: 'Fix the login redirect',
    }))
  })

  test('omits optional lifecycle fields the user left empty', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Create worktree' }))

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      fetch: false,
      setupPolicy: 'inherit',
      sparsePreset: null,
      linkedFiles: [],
      initialAgent: null,
      initialPrompt: null,
    })))
  })

  test('discards a stale storage resolution that resolves after a newer keystroke', async () => {
    const pending = new Map<string, (value: unknown) => void>()
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command !== 'git_worktree_resolve_root') return Promise.resolve(undefined)
      const name = typeof args?.name === 'string' ? args.name : ''
      const { promise, resolve } = Promise.withResolvers<unknown>()
      pending.set(name, resolve)
      return promise
    })
    render(
      <WorktreeCreateDialog
        sourceSession={sourceSession}
        profiles={defaultSettings.profiles}
        initialProfileId="codex"
        onCreate={vi.fn(async () => undefined)}
        onClose={vi.fn()}
      />,
    )

    fireEvent.change(screen.getByLabelText('Worktree name'), { target: { value: 'Old' } })
    await waitFor(() => expect(pending.has('Old')).toBe(true))
    fireEvent.change(screen.getByLabelText('Worktree name'), { target: { value: 'New' } })
    await waitFor(() => expect(pending.has('New')).toBe(true))

    // The newer request answers first, then the stale one arrives late.
    pending.get('New')?.({ root: 'E:\\Roots', example: 'E:\\Roots\\new-abc12345', writable: true, fallbackReason: null })
    expect(await screen.findByText('E:\\Roots\\new-abc12345')).toBeInTheDocument()
    pending.get('Old')?.({ root: 'E:\\Roots', example: 'E:\\Roots\\old-abc12345', writable: true, fallbackReason: null })

    await waitFor(() => expect(screen.queryByText('E:\\Roots\\old-abc12345')).not.toBeInTheDocument())
    expect(screen.getByText('E:\\Roots\\new-abc12345')).toBeInTheDocument()
  })
})

// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { SessionMeta } from '../../ipc/types'
import { defaultSettings } from '../../state/profiles'
import { WorktreeCreateDialog } from './WorktreeCreateDialog'
import { worktreeBranchName } from './worktreeNaming'

const sourceSession: SessionMeta = {
  id: 'repo-session',
  name: 'Repository',
  paneCount: 2,
  createdAt: 1,
  workspaceFolder: 'E:/repos/project',
}

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
    fireEvent.change(screen.getByLabelText('Start AI with'), { target: { value: 'claude' } })
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

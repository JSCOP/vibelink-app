// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorktreeReviewComment } from '../../state/worktrees'
import { WorktreeReviewPanel } from './WorktreeReviewPanel'

afterEach(cleanup)

const baseComment: WorktreeReviewComment = {
  id: 'comment-1', worktreeId: 'worktree-1', instanceId: 'instance-current', baseHead: 'base-sha', head: 'head-sha',
  path: 'src/review.ts', side: 'new', line: 12, range: null, hunkId: 'hunk-current', body: 'Keep this guard.', createdAt: 1, updatedAt: 1,
}

test('shows old-instance comments in the stale section with their original anchor', () => {
  const oldInstance = { ...baseComment, id: 'comment-old', instanceId: 'instance-old', body: 'Old checkout note.' }
  render(<WorktreeReviewPanel identity={{ worktreeId: 'worktree-1', instanceId: 'instance-current', baseHead: 'base-sha', head: 'head-sha' }} comments={[baseComment, oldInstance]} checkpoints={[]} currentAnchorKeys={new Set(['src/review.ts\0new\0line:12\0hunk-current'])} loading={false} error={null} onRefresh={vi.fn()} />)
  expect(screen.getByText('Keep this guard.').closest('[data-stale]')).toBeNull()
  const stale = screen.getByText('Old checkout note.').closest('[data-stale]')
  expect(stale).not.toBeNull()
  expect(stale?.textContent).toContain('src/review.ts · new line 12 · hunk hunk-current')
  expect(stale?.textContent).toContain('instance instance-old')
})

test('treats base or head snapshot mismatches as stale', () => {
  render(<WorktreeReviewPanel identity={{ worktreeId: 'worktree-1', instanceId: 'instance-current', baseHead: 'new-base', head: 'new-head' }} comments={[baseComment]} checkpoints={[]} currentAnchorKeys={new Set(['src/review.ts\0new\0line:12\0hunk-current'])} loading={false} error={null} onRefresh={vi.fn()} />)
  expect(screen.getByText('Keep this guard.').closest('[data-stale]')).not.toBeNull()
})

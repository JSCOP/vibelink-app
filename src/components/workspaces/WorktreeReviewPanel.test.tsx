// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { WorktreeReviewComment } from '../../state/worktrees'
import { WorktreeReviewPanel } from './WorktreeReviewPanel'

afterEach(cleanup)

const baseComment: WorktreeReviewComment = {
  id: 'comment-1', worktreeId: 'worktree-1', instanceId: 'instance-current', baseHead: 'base-sha', head: 'head-sha',
  path: 'src/review.ts', side: 'new', line: 12, range: null, hunkId: 'hunk-current', body: 'Keep this guard.', createdAt: 1, updatedAt: 1, state: 'open',
}

test('shows old-instance comments in the stale section with their original anchor', () => {
  const oldInstance = { ...baseComment, id: 'comment-old', instanceId: 'instance-old', body: 'Old checkout note.' }
  render(<WorktreeReviewPanel identity={{ worktreeId: 'worktree-1', instanceId: 'instance-current', baseHead: 'base-sha', head: 'head-sha' }} comments={[baseComment, oldInstance]} checkpoints={[]} currentAnchorKeys={new Set(['src/review.ts\0new\0line:12\0hunk-current'])} loading={false} error={null} onRefresh={vi.fn()} onSendToAgent={vi.fn()} onSetState={vi.fn()} />)
  expect(screen.getByText('Keep this guard.').closest('[data-stale]')).toBeNull()
  const stale = screen.getByText('Old checkout note.').closest('[data-stale]')
  expect(stale).not.toBeNull()
  expect(stale?.textContent).toContain('src/review.ts · new line 12 · hunk hunk-current')
  expect(stale?.textContent).toContain('instance instance-old')
})

test('treats base or head snapshot mismatches as stale', () => {
  render(<WorktreeReviewPanel identity={{ worktreeId: 'worktree-1', instanceId: 'instance-current', baseHead: 'new-base', head: 'new-head' }} comments={[baseComment]} checkpoints={[]} currentAnchorKeys={new Set(['src/review.ts\0new\0line:12\0hunk-current'])} loading={false} error={null} onRefresh={vi.fn()} onSendToAgent={vi.fn()} onSetState={vi.fn()} />)
  expect(screen.getByText('Keep this guard.').closest('[data-stale]')).not.toBeNull()
})

test('sends selected open comments and exposes sent lifecycle actions', () => {
  const onSendToAgent = vi.fn()
  const onSetState = vi.fn()
  const comments: WorktreeReviewComment[] = [
    baseComment,
    { ...baseComment, id: 'comment-2', body: 'Keep the fallback.' },
    { ...baseComment, id: 'comment-sent', body: 'Already sent.', state: 'sent' },
    { ...baseComment, id: 'comment-closed', body: 'Resolved note.', state: 'resolved' },
  ]
  render(<WorktreeReviewPanel identity={{ worktreeId: 'worktree-1', instanceId: 'instance-current', baseHead: 'base-sha', head: 'head-sha' }} comments={comments} checkpoints={[]} currentAnchorKeys={new Set(['src/review.ts\0new\0line:12\0hunk-current'])} loading={false} error={null} onRefresh={vi.fn()} onSendToAgent={onSendToAgent} onSetState={onSetState} />)

  for (const checkbox of screen.getAllByRole('checkbox')) fireEvent.click(checkbox)
  fireEvent.click(screen.getByRole('button', { name: 'Send to agent (2)' }))
  expect(onSendToAgent).toHaveBeenCalledWith(['comment-1', 'comment-2'])
  fireEvent.click(screen.getByRole('button', { name: 'Resolve' }))
  expect(onSetState).toHaveBeenCalledWith(['comment-sent'], 'resolved')
})

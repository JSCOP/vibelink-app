import { describe, expect, test } from 'vitest'
import type { WorktreeReviewComment } from '../../ipc/worktrees'
import { buildReviewPrompt, REVIEW_PROMPT_MAX_CHARS } from './reviewPrompt'

const comment = (overrides: Partial<WorktreeReviewComment>): WorktreeReviewComment => ({
  id: 'comment', worktreeId: 'worktree', instanceId: 'instance', baseHead: 'base', head: 'head', path: 'src/foo.ts', side: 'new', line: 42, range: null, hunkId: '1a2b3c4d9999', body: 'Keep this guard.', createdAt: 1, updatedAt: 1, state: 'open', ...overrides,
})

describe('buildReviewPrompt', () => {
  test('serializes anchors, multiline bodies, and bounded whole entries', () => {
    const prompt = buildReviewPrompt([
      comment({}),
      comment({ id: 'second', path: 'src/bar.ts', side: 'hunk', line: null, hunkId: '9f8e7d6c1234', body: 'Extract this\ninto a helper.' }),
      comment({ id: 'large', body: 'x'.repeat(REVIEW_PROMPT_MAX_CHARS) }),
    ])

    expect(prompt).toContain('1. src/foo.ts (new line 42, hunk 1a2b3c4d)\n   Keep this guard.')
    expect(prompt).toContain('2. src/bar.ts (hunk 9f8e7d6c)\n   Extract this\n   into a helper.')
    expect(prompt).toContain('(… 1 more comments not included; send them in a second batch.)')
    expect(prompt).not.toContain('3. src/foo.ts')
  })
})

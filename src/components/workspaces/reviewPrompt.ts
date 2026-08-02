import type { WorktreeReviewComment } from '../../ipc/worktrees'

export const REVIEW_PROMPT_MAX_CHARS = 4000

export function buildReviewPrompt(comments: WorktreeReviewComment[]): string {
  const header = 'Address these code review comments in the current worktree.'
  const entries = comments.map((comment, index) => formatComment(comment, index + 1))
  let prompt = header
  let included = 0
  for (const entry of entries) {
    const next = `${prompt}\n\n${entry}`
    if (next.length > REVIEW_PROMPT_MAX_CHARS) break
    prompt = next
    included += 1
  }
  const omitted = entries.length - included
  return omitted > 0 ? `${prompt}\n(… ${omitted} more comments not included; send them in a second batch.)` : prompt
}

function formatComment(comment: WorktreeReviewComment, number: number): string {
  const anchor = [comment.line === null ? null : `${comment.side} line ${comment.line}`, comment.hunkId === null ? null : `hunk ${comment.hunkId.slice(0, 8)}`]
    .filter(Boolean)
    .join(', ')
  const location = anchor ? `${comment.path} (${anchor})` : comment.path
  return `${number}. ${location}\n   ${comment.body.replace(/\r?\n/g, '\n   ')}`
}

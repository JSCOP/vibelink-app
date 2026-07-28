import type { WorktreeReviewComment } from '../../state/worktrees'

export type WorktreeReviewIdentity = {
  worktreeId: string
  instanceId: string
  baseHead: string
  head: string
}

export function reviewCommentAnchorKey(comment: Pick<WorktreeReviewComment, 'path' | 'side' | 'line' | 'hunkId'>): string {
  if (comment.line !== null) return `${comment.path}\0${comment.side}\0line:${comment.line}\0${comment.hunkId ?? ''}`
  return `${comment.path}\0hunk\0${comment.hunkId ?? ''}`
}
export function isCurrentReviewComment(comment: WorktreeReviewComment, identity: WorktreeReviewIdentity | null, currentAnchorKeys: ReadonlySet<string>): boolean {
  return Boolean(identity
    && comment.worktreeId === identity.worktreeId
    && comment.instanceId === identity.instanceId
    && comment.baseHead === identity.baseHead
    && comment.head === identity.head
    && currentAnchorKeys.has(reviewCommentAnchorKey(comment)))
}

export function partitionReviewComments(comments: WorktreeReviewComment[], identity: WorktreeReviewIdentity | null, currentAnchorKeys: ReadonlySet<string>): {
  current: WorktreeReviewComment[]
  stale: WorktreeReviewComment[]
} {
  const current: WorktreeReviewComment[] = []
  const stale: WorktreeReviewComment[] = []
  for (const comment of comments) {
    if (isCurrentReviewComment(comment, identity, currentAnchorKeys)) current.push(comment)
    else stale.push(comment)
  }
  return { current, stale }
}

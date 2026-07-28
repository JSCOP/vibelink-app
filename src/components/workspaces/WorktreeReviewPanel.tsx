import { AlertTriangle, MessageSquareText, RefreshCw } from 'lucide-react'
import type { WorktreeCheckpoint, WorktreeReviewComment } from '../../state/worktrees'
import { partitionReviewComments, type WorktreeReviewIdentity } from './worktreeReview'
import './WorktreeReviewPanel.css'

export type WorktreeReviewPanelProps = {
  identity: WorktreeReviewIdentity | null
  comments: WorktreeReviewComment[]
  checkpoints: WorktreeCheckpoint[]
  currentAnchorKeys: ReadonlySet<string>
  loading: boolean
  error: string | null
  onRefresh: () => void
}

export function WorktreeReviewPanel({ identity, comments, checkpoints, currentAnchorKeys, loading, error, onRefresh }: WorktreeReviewPanelProps) {
  const { current, stale } = partitionReviewComments(comments, identity, currentAnchorKeys)
  return (
    <section className="worktree-review-panel" aria-label="Worktree review">
      <header>
        <MessageSquareText size={14} aria-hidden="true" />
        <strong>Worktree review</strong>
        <span>{current.length} current · {stale.length} stale</span>
        <button type="button" onClick={onRefresh} disabled={loading} aria-label="Refresh worktree review"><RefreshCw className={loading ? 'spin' : undefined} size={13} aria-hidden="true" /></button>
      </header>
      {error ? <div className="worktree-review-error" role="alert"><AlertTriangle size={13} aria-hidden="true" />{error}</div> : null}
      <div className="worktree-review-sections">
        <ReviewCommentSection title="Current comments" comments={current} empty="No comments match the active worktree identity and review snapshot." />
        <ReviewCommentSection title="Stale comments" comments={stale} empty="No stale comments." stale />
        <section className="worktree-review-section worktree-review-checkpoints">
          <h3>Checkpoints</h3>
          {checkpoints.length > 0 ? <ol>{checkpoints.slice().reverse().map((checkpoint) => <li key={checkpoint.id}><strong>{checkpoint.kind.replaceAll('_', ' ')}</strong><span>{checkpoint.label}</span><code>{shortSha(checkpoint.head)}</code>{checkpoint.comment ? <small>{checkpoint.comment}</small> : null}</li>)}</ol> : <p>No checkpoints recorded.</p>}
        </section>
      </div>
    </section>
  )
}

function ReviewCommentSection({ title, comments, empty, stale = false }: { title: string; comments: WorktreeReviewComment[]; empty: string; stale?: boolean }) {
  return (
    <section className="worktree-review-section" data-stale={stale || undefined}>
      <h3>{title}</h3>
      {comments.length > 0 ? <ol>{comments.map((comment) => <li key={comment.id}><blockquote>{comment.body}</blockquote><small>{anchorLabel(comment)}</small>{stale ? <code>instance {shortSha(comment.instanceId)} · base {shortSha(comment.baseHead)} · head {shortSha(comment.head)}</code> : null}</li>)}</ol> : <p>{empty}</p>}
    </section>
  )
}

function anchorLabel(comment: WorktreeReviewComment): string {
  const line = comment.line === null ? '' : ` line ${comment.line}`
  const hunk = comment.hunkId ? ` · hunk ${shortSha(comment.hunkId)}` : ''
  return `${comment.path} · ${comment.side}${line}${hunk}`
}

function shortSha(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value
}

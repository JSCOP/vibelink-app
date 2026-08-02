import { useState } from 'react'
import { AlertTriangle, MessageSquareText, RefreshCw, Send } from 'lucide-react'
import type { WorktreeCheckpoint, WorktreeReviewComment, WorktreeReviewCommentState } from '../../state/worktrees'
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
  onSendToAgent: (commentIds: string[]) => void
  onSetState: (commentIds: string[], state: WorktreeReviewCommentState) => void
}

export function WorktreeReviewPanel({ identity, comments, checkpoints, currentAnchorKeys, loading, error, onRefresh, onSendToAgent, onSetState }: WorktreeReviewPanelProps) {
  const { current, stale } = partitionReviewComments(comments, identity, currentAnchorKeys)
  const open = current.filter((comment) => comment.state === 'open')
  const sent = current.filter((comment) => comment.state === 'sent')
  const closed = current.filter((comment) => comment.state === 'resolved' || comment.state === 'dismissed')
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(new Set())
  const selectedOpenIds = open.flatMap((comment) => selectedIds.has(comment.id) ? [comment.id] : [])
  const toggleSelected = (id: string) => setSelectedIds((selected) => {
    const next = new Set(selected)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
  const sendSelected = () => {
    onSendToAgent(selectedOpenIds)
    setSelectedIds(new Set())
  }

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
        <section className="worktree-review-section">
          <header><h3>Open</h3><button type="button" onClick={sendSelected} disabled={selectedOpenIds.length === 0}><Send size={12} aria-hidden="true" />Send to agent ({selectedOpenIds.length})</button></header>
          {open.length > 0 ? <ol>{open.map((comment) => <li key={comment.id}><label className="worktree-review-select"><input type="checkbox" checked={selectedIds.has(comment.id)} onChange={() => toggleSelected(comment.id)} /><span>{comment.body}</span></label><small>{anchorLabel(comment)}</small><ReviewActions comment={comment} states={['dismissed']} onSetState={onSetState} /></li>)}</ol> : <p>No open comments.</p>}
        </section>
        <section className="worktree-review-section">
          <h3>Sent</h3>
          {sent.length > 0 ? <ol>{sent.map((comment) => <li key={comment.id}><div><span className="worktree-review-chip">Sent</span><blockquote>{comment.body}</blockquote></div><small>{anchorLabel(comment)}</small><ReviewActions comment={comment} states={['resolved', 'open', 'dismissed']} onSetState={onSetState} /></li>)}</ol> : <p>No comments sent.</p>}
        </section>
        <details className="worktree-review-section worktree-review-closed">
          <summary>Closed ({closed.length})</summary>
          {closed.length > 0 ? <ol>{closed.map((comment) => <li key={comment.id}><blockquote>{comment.body}</blockquote><small>{anchorLabel(comment)}</small><span className="worktree-review-chip">{comment.state}</span><ReviewActions comment={comment} states={['open']} onSetState={onSetState} /></li>)}</ol> : <p>No closed comments.</p>}
        </details>
        <ReviewCommentSection title="Stale comments" comments={stale} empty="No stale comments." stale />
        <section className="worktree-review-section worktree-review-checkpoints">
          <h3>Checkpoints</h3>
          {checkpoints.length > 0 ? <ol>{checkpoints.slice().reverse().map((checkpoint) => <li key={checkpoint.id}><strong>{checkpoint.kind.replaceAll('_', ' ')}</strong><span>{checkpoint.label}</span><code>{shortSha(checkpoint.head)}</code>{checkpoint.comment ? <small>{checkpoint.comment}</small> : null}</li>)}</ol> : <p>No checkpoints recorded.</p>}
        </section>
      </div>
    </section>
  )
}

function ReviewActions({ comment, states, onSetState }: { comment: WorktreeReviewComment; states: WorktreeReviewCommentState[]; onSetState: WorktreeReviewPanelProps['onSetState'] }) {
  return <div className="worktree-review-actions">{states.map((state) => <button key={state} type="button" onClick={() => onSetState([comment.id], state)}>{state === 'open' ? 'Reopen' : state === 'resolved' ? 'Resolve' : 'Dismiss'}</button>)}</div>
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

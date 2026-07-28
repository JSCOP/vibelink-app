import { AlertTriangle, Check, ClipboardCopy, ExternalLink, GitMerge, GitPullRequest, KeyRound, LoaderCircle, LogIn, Plus, RefreshCw, Rocket } from 'lucide-react'
import type { ChangedFile, CiStatus, FileContents, PrCreated, PrDetail, PrInfo, UnifiedFileDiff } from '../../ipc/types'
import type { WorktreeReviewComment } from '../../state/worktrees'
import { DiffPane } from './DiffPane'
import './PullRequestsTabView.css'

export type PullRequestsTabViewProps = {
  provider: 'github' | 'gitlab' | null
  host: string | null
  tokenPresent: boolean
  loading: boolean
  error: string | null
  prs: PrInfo[]
  ciByNumber: Record<number, CiStatus>
  selectedNumber: number | null
  detail: PrDetail | null
  files: ChangedFile[]
  selectedPath: string | null
  contents: FileContents | null
  diffLoading: boolean
  reviewHunks: UnifiedFileDiff | null
  selectedReviewHunkId: string | null
  reviewHunkComments: WorktreeReviewComment[]
  mode: 'list' | 'create'
  token: string
  deviceCode: { userCode: string; verificationUri: string } | null
  created: PrCreated | null
  createTitle: string
  createBody: string
  createTarget: string
  createTargets: string[]
  createDraft: boolean
  sourceBranch: string
  needsPush: boolean
  onRefresh: () => void
  onTokenChange: (value: string) => void
  onSaveToken: () => void
  onDeviceSignIn: () => void
  onOpenUrl: (url: string) => void
  onCopyUrl: (url: string) => void
  onSelectPr: (number: number) => void
  onSelectFile: (path: string) => void
  onSelectReviewHunk: (hunkId: string) => void
  onCommentReviewHunk: () => void
  onCommentReviewLine: (line: number, side: 'old' | 'new') => void
  onModeChange: (mode: 'list' | 'create') => void
  onCreateTitleChange: (value: string) => void
  onCreateBodyChange: (value: string) => void
  onCreateTargetChange: (value: string) => void
  onCreateDraftChange: (value: boolean) => void
  onPushBranch: () => void
  onCreate: () => void
  onMergeAndCleanup: () => void
}

function UrlActions({ url, onOpenUrl, onCopyUrl }: { url: string; onOpenUrl: (url: string) => void; onCopyUrl: (url: string) => void }) {
  return (
    <span className="git-pr-url-actions">
      <button type="button" title="Open URL" aria-label="Open URL" onClick={() => onOpenUrl(url)}>
        <ExternalLink size={13} strokeWidth={1.9} aria-hidden="true" />
      </button>
      <button type="button" title="Copy URL" aria-label="Copy URL" onClick={() => onCopyUrl(url)}>
        <ClipboardCopy size={13} strokeWidth={1.9} aria-hidden="true" />
      </button>
    </span>
  )
}

export function PullRequestsTabView(props: PullRequestsTabViewProps) {
  const label = props.provider === 'gitlab' ? 'Merge Requests' : 'Pull Requests'
  const shortLabel = props.provider === 'gitlab' ? 'MR' : 'PR'

  if (!props.provider || !props.host) {
    return (
      <section className="git-pr-tab git-pr-blank">
        <div className="git-pr-blank-body">
          <span className="git-pr-blank-badge"><GitPullRequest size={22} strokeWidth={1.7} aria-hidden="true" /></span>
          <strong>No supported Git host detected</strong>
          <span>Configure an origin remote for GitHub or GitLab.</span>
        </div>
      </section>
    )
  }

  if (!props.tokenPresent) {
    const authError = props.error ? props.error.replace(/^AUTH:\s*/, '') : null
    return (
      <section className="git-pr-tab git-pr-auth" data-git-pr-auth="true">
        <div className="git-pr-card">
          <span className="git-pr-card-badge"><LogIn size={20} strokeWidth={1.7} aria-hidden="true" /></span>
          <h3>Sign in to {props.host}</h3>
          <p>Store a personal access token in Windows Credential Manager. Tokens never enter workspace files.</p>
          <label className="git-pr-field">
            Personal access token
            <input
              type="password"
              value={props.token}
              placeholder={props.provider === 'gitlab' ? 'glpat-…' : 'ghp_… / github_pat_…'}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => props.onTokenChange(event.target.value)}
            />
          </label>
          <div className="git-pr-card-actions">
            <button type="button" className="git-pr-primary" disabled={!props.token.trim()} onClick={props.onSaveToken}>
              <KeyRound size={13} strokeWidth={1.9} aria-hidden="true" />Save token
            </button>
            {props.provider === 'github' && props.host === 'github.com' ? (
              <button type="button" className="git-pr-secondary" onClick={props.onDeviceSignIn}>Use GitHub device sign-in</button>
            ) : null}
          </div>
          {props.deviceCode ? (
            <div className="git-pr-device-code">
              <span>
                Enter this code at{' '}
                <button type="button" className="git-pr-link" onClick={() => props.onOpenUrl(props.deviceCode!.verificationUri)}>
                  {props.deviceCode.verificationUri}
                </button>
              </span>
              <span className="git-pr-device-code-value">
                <strong>{props.deviceCode.userCode}</strong>
                <button type="button" title="Copy code" aria-label="Copy code" onClick={() => props.onCopyUrl(props.deviceCode!.userCode)}>
                  <ClipboardCopy size={13} strokeWidth={1.9} aria-hidden="true" />
                </button>
              </span>
            </div>
          ) : null}
          {authError ? (
            <div className="git-pr-error" role="alert">
              <AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" />
              <span>{authError}</span>
            </div>
          ) : null}
        </div>
      </section>
    )
  }

  return (
    <section className="git-pr-tab" data-git-pr-tab="true">
      <header className="git-pr-toolbar">
        <strong>{label}</strong>
        <span className="git-pr-toolbar-host">{props.host}</span>
        <span className="git-pr-toolbar-spacer" />
        <button type="button" className="git-pr-secondary" onClick={props.onRefresh} disabled={props.loading}>
          <RefreshCw className={props.loading ? 'spin' : undefined} size={13} strokeWidth={1.9} aria-hidden="true" />Refresh
        </button>
        <button type="button" className="git-pr-primary" onClick={() => props.onModeChange(props.mode === 'create' ? 'list' : 'create')}>
          <Plus size={13} strokeWidth={1.9} aria-hidden="true" />
          {props.mode === 'create' ? `View ${label}` : `Create ${shortLabel}`}
        </button>
      </header>

      {props.error ? (
        <div className="git-pr-error git-pr-error-banner" role="alert">
          <AlertTriangle size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>{props.error}</span>
          <button type="button" onClick={props.onRefresh} disabled={props.loading}>Retry</button>
        </div>
      ) : null}

      {props.created ? (
        <div className="git-pr-created" data-git-pr-created="true">
          <Check size={14} strokeWidth={2.1} aria-hidden="true" />
          <span className="git-pr-created-text">
            {shortLabel} #{props.created.number} created —{' '}
            <button type="button" className="git-pr-link" onClick={() => props.onOpenUrl(props.created!.url)}>{props.created.url}</button>
          </span>
          <UrlActions url={props.created.url} onOpenUrl={props.onOpenUrl} onCopyUrl={props.onCopyUrl} />
        </div>
      ) : null}

      {props.mode === 'create' ? (
        <div className="git-pr-create">
          <div className="git-pr-create-form">
            <h3>Create {props.provider === 'gitlab' ? 'Merge Request' : 'Pull Request'}</h3>
            <div className="git-pr-branches">
              <label className="git-pr-field">
                Base
                <select value={props.createTarget} onChange={(event) => props.onCreateTargetChange(event.target.value)}>
                  {props.createTargets.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
                </select>
              </label>
              <span className="git-pr-branches-arrow" aria-hidden="true">←</span>
              <label className="git-pr-field">
                Head
                <input value={props.sourceBranch} readOnly />
              </label>
            </div>
            <label className="git-pr-field">
              Title
              <input value={props.createTitle} placeholder={`${shortLabel} title`} onChange={(event) => props.onCreateTitleChange(event.target.value)} />
            </label>
            <label className="git-pr-field">
              Description
              <textarea rows={8} placeholder="Optional description" value={props.createBody} onChange={(event) => props.onCreateBodyChange(event.target.value)} />
            </label>
            <div className="git-pr-create-footer">
              <label className="git-pr-draft">
                <input type="checkbox" checked={props.createDraft} onChange={(event) => props.onCreateDraftChange(event.target.checked)} />
                Create as draft
              </label>
              {props.needsPush ? (
                <button type="button" className="git-pr-secondary" onClick={props.onPushBranch}>
                  <Rocket size={13} strokeWidth={1.9} aria-hidden="true" />Push branch first
                </button>
              ) : (
                <button
                  type="button"
                  className="git-pr-primary"
                  disabled={!props.createTitle.trim() || !props.sourceBranch || !props.createTarget || props.loading}
                  onClick={props.onCreate}
                >
                  <GitPullRequest size={13} strokeWidth={1.9} aria-hidden="true" />Create
                </button>
              )}
            </div>
            {props.needsPush ? <p className="git-pr-create-hint">The current branch has no upstream yet. Push it once, then create the {shortLabel.toLowerCase()}.</p> : null}
          </div>
        </div>
      ) : (
        <div className="git-pr-workbench">
          <aside className="git-pr-list">
            {props.loading && props.prs.length === 0 ? (
              <div className="git-pr-loading"><LoaderCircle className="spin" size={16} strokeWidth={1.9} aria-hidden="true" />Loading…</div>
            ) : props.prs.length === 0 ? (
              <div className="git-pr-list-empty">
                <Check size={18} strokeWidth={1.9} aria-hidden="true" />
                <strong>No open {label.toLowerCase()}</strong>
                <span>Create one from the current branch.</span>
              </div>
            ) : props.prs.map((pr) => {
              const ci = props.ciByNumber[pr.number]?.state ?? 'none'
              return (
                <article key={pr.number} className="git-pr-row" data-selected={props.selectedNumber === pr.number || undefined}>
                  <button type="button" className="git-pr-row-main" onClick={() => props.onSelectPr(pr.number)}>
                    <span className="git-pr-row-top">
                      <span className="git-pr-number">#{pr.number}</span>
                      <strong>{pr.title}</strong>
                      {pr.draft ? <span className="git-pr-chip" data-chip="draft">Draft</span> : null}
                    </span>
                    <small>{pr.author} · {pr.sourceBranch} → {pr.targetBranch}</small>
                  </button>
                  <span className="git-pr-ci-dot" data-state={ci} title={`CI: ${ci}`} />
                  <UrlActions url={pr.url} onOpenUrl={props.onOpenUrl} onCopyUrl={props.onCopyUrl} />
                </article>
              )
            })}
          </aside>
          <main className="git-pr-detail">
            {props.detail ? (
              <>
                <header className="git-pr-detail-header">
                  <div className="git-pr-detail-title">
                    <strong>#{props.detail.number} {props.detail.title}</strong>
                    <span>{props.detail.author} · {props.detail.sourceBranch} → {props.detail.targetBranch}</span>
                  </div>
                  <div className="git-pr-detail-actions">
                    <button type="button" className="git-pr-secondary" onClick={() => props.onOpenUrl(props.detail!.url)}>
                      <ExternalLink size={13} strokeWidth={1.9} aria-hidden="true" />Open
                    </button>
                    <button type="button" className="git-pr-primary" disabled={props.loading || !props.detail.headSha || props.detail.draft} title={props.detail.draft ? 'Draft reviews cannot be merged' : 'Validate provider CI, SHA, conflicts, local cleanliness, and upstream before merge'} onClick={props.onMergeAndCleanup}>
                      <GitMerge size={13} strokeWidth={1.9} aria-hidden="true" />Merge and clean up
                    </button>
                  </div>
                </header>
                {props.detail.body ? <p className="git-pr-body">{props.detail.body}</p> : null}
                {props.detail.checks.length > 0 ? (
                  <div className="git-pr-checks">
                    {props.detail.checks.map((check) => (
                      <button
                        key={`${check.name}:${check.url}`}
                        type="button"
                        data-state={check.state}
                        disabled={!check.url}
                        title={check.url ? 'Open check' : undefined}
                        onClick={() => { if (check.url) props.onOpenUrl(check.url) }}
                      >
                        <span aria-hidden="true" />{check.name}
                      </button>
                    ))}
                  </div>
                ) : null}
                <div className="git-pr-diff">
                  <DiffPane files={props.files} selectedPath={props.selectedPath} onSelect={props.onSelectFile} contents={props.contents} loading={props.diffLoading} splitView error={null} hunkDiff={props.reviewHunks} selectedHunkId={props.selectedReviewHunkId} onSelectHunk={props.onSelectReviewHunk} onCommentHunk={props.onCommentReviewHunk} onCommentLine={props.onCommentReviewLine} hunkComments={props.reviewHunkComments} />
                </div>
              </>
            ) : (
              <div className="git-pr-detail-placeholder">
                <GitPullRequest size={20} strokeWidth={1.7} aria-hidden="true" />
                <span>Select a {props.provider === 'gitlab' ? 'merge request' : 'pull request'}.</span>
              </div>
            )}
          </main>
        </div>
      )}
    </section>
  )
}

import { AlertTriangle, Check, ChevronDown, ChevronRight, CloudDownload, CloudUpload, FolderGit2, GitBranch, GitCommit, LoaderCircle, Minus, Plus, RefreshCw, RotateCcw, Undo2, X } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { ComponentType, CSSProperties, ReactNode } from 'react'
import type { ChangeType, CiStatus, FileContents, RepoInfo, RepoKind, WorkingStatus } from '../../ipc/types'
import type { GitTab } from '../../state/git'
import { DiffPane } from './DiffPane'

export type GitRowAction = {
  id: string
  label: string
  danger?: boolean
  onClick: () => void
}

export type GitChangeRow = {
  id: string
  kind: 'dir' | 'file'
  path: string
  name: string
  depth: number
  changeType: ChangeType | null
  oldPath: string | null
  repoKind: RepoKind | null
  ignored: boolean
  expanded?: boolean
  loading?: boolean
  count?: number
  selected: boolean
  actions: GitRowAction[]
  onSelect: () => void
  onToggle?: () => void
}

export type GitChangeGroup = {
  id: 'conflicted' | 'staged' | 'unstaged' | 'untracked'
  title: string
  count: number
  rows: GitChangeRow[]
  actions: GitRowAction[]
}

export type GitCloneViewState = {
  open: boolean
  url: string
  targetDir: string
  progress: string[]
  running: boolean
  onUrlChange: (value: string) => void
  onChooseTarget: () => void
  onStart: () => void
  onClose: () => void
}

export type GitWindowViewProps = {
  setRootElement: (element: HTMLDivElement | null) => void
  workspaceFolder: string | null
  repoInfo: RepoInfo | null
  status: WorkingStatus | null
  refreshing: boolean
  error: string | null
  activeTab: GitTab
  pullRequestsVisible: boolean
  ciStatus: CiStatus | null
  commitMessage: string
  amend: boolean
  canCommit: boolean
  groups: GitChangeGroup[]
  selectedPath: string | null
  contents: FileContents | null
  diffLoading: boolean
  diffError: string | null
  clone: GitCloneViewState
  onRefresh: () => void
  onInitialize: () => void
  onOpenClone: () => void
  onOpenBranchPicker: () => void
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  onContinueState: (() => void) | null
  onAbortState: (() => void) | null
  onTabChange: (tab: GitTab) => void
  onCommitMessageChange: (value: string) => void
  onAmendChange: (value: boolean) => void
  onCommit: () => void
  historyContent: ReactNode
  branchesContent: ReactNode
  pullRequestsContent: ReactNode
}

const CHANGE_BADGES: Record<ChangeType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: 'U',
}

const ACTION_ICONS: Record<string, ComponentType<LucideProps>> = {
  stage: Plus,
  'stage-all': Plus,
  unstage: Minus,
  'unstage-all': Minus,
  discard: Undo2,
  'discard-all': Undo2,
}

const ACTION_SHORT_LABELS: Record<string, string> = {
  ours: 'Ours',
  theirs: 'Theirs',
}

const REPO_KIND_LABELS: Record<RepoKind, string> = {
  submodule: 'submodule',
  nestedRepo: 'git repo',
}

function splitEntryPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf('/')
  return index < 0 ? { dir: '', name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) }
}

function GitChangeRowView({ row }: { row: GitChangeRow }) {
  const indent = { '--git-tree-depth': row.depth } as CSSProperties
  if (row.kind === 'dir') {
    return (
      <div className="git-window-change-row git-window-tree-dir" style={indent} data-selected={row.selected || undefined} data-ignored={row.ignored || undefined}>
        <button
          type="button"
          className="git-window-change-file"
          title={row.path}
          aria-expanded={row.expanded ?? false}
          onClick={row.onToggle ?? row.onSelect}
        >
          {row.loading
            ? <LoaderCircle size={12} strokeWidth={2} className="spin git-window-tree-chevron" aria-hidden="true" />
            : row.expanded
              ? <ChevronDown size={12} strokeWidth={2} className="git-window-tree-chevron" aria-hidden="true" />
              : <ChevronRight size={12} strokeWidth={2} className="git-window-tree-chevron" aria-hidden="true" />}
          {row.changeType ? <span className="git-window-change-badge" data-change-type={row.changeType} aria-label={row.changeType}>{CHANGE_BADGES[row.changeType]}</span> : null}
          <span className="git-window-change-name">{row.name}/</span>
          {row.repoKind ? <span className="git-window-repo-kind-badge" data-repo-kind={row.repoKind}>{REPO_KIND_LABELS[row.repoKind]}</span> : null}
          {row.count ? <span className="git-window-tree-count">{row.count}</span> : null}
        </button>
        <div className="git-window-row-actions">
          {row.actions.map((action) => <GitActionButton key={action.id} action={action} subject={row.path} />)}
        </div>
      </div>
    )
  }
  const { dir, name } = splitEntryPath(row.path)
  return (
    <div className="git-window-change-row" style={indent} data-selected={row.selected || undefined} data-ignored={row.ignored || undefined}>
      <button
        type="button"
        className="git-window-change-file"
        title={row.oldPath ? `${row.path} (from ${row.oldPath})` : row.path}
        onClick={row.onSelect}
      >
        {row.changeType ? <span className="git-window-change-badge" data-change-type={row.changeType} aria-label={row.changeType}>{CHANGE_BADGES[row.changeType]}</span> : null}
        <span className="git-window-change-name">{name}</span>
        {row.depth === 0 && dir ? <span className="git-window-change-dir">{dir}</span> : null}
        {row.oldPath ? <small className="git-window-change-from">from {row.oldPath}</small> : null}
      </button>
      <div className="git-window-row-actions">
        {row.actions.map((action) => <GitActionButton key={action.id} action={action} subject={row.path} />)}
      </div>
    </div>
  )
}

function GitActionButton({ action, subject }: { action: GitRowAction; subject?: string }) {
  const Icon = ACTION_ICONS[action.id]
  const title = subject ? `${action.label} ${subject}` : action.label
  return (
    <button type="button" title={title} aria-label={title} data-danger={action.danger || undefined} onClick={action.onClick}>
      {Icon ? <Icon size={13} strokeWidth={1.9} aria-hidden="true" /> : ACTION_SHORT_LABELS[action.id] ?? action.label}
    </button>
  )
}

export function GitWindowView({ setRootElement, workspaceFolder, repoInfo, status, refreshing, error, activeTab, pullRequestsVisible, ciStatus, commitMessage, amend, canCommit, groups, selectedPath, contents, diffLoading, diffError, clone, onRefresh, onInitialize, onOpenClone, onOpenBranchPicker, onFetch, onPull, onPush, onContinueState, onAbortState, onTabChange, onCommitMessageChange, onAmendChange, onCommit, historyContent, branchesContent, pullRequestsContent }: GitWindowViewProps) {
  if (!workspaceFolder) {
    return (
      <div ref={setRootElement} className="git-window git-window-empty" data-git-window="true">
        <FolderGit2 size={28} strokeWidth={1.6} aria-hidden="true" />
        <h2>No workspace folder</h2>
        <p>Set a workspace folder to use Git.</p>
      </div>
    )
  }

  if (!repoInfo) {
    return (
      <div ref={setRootElement} className="git-window git-window-empty" data-git-window="true">
        {refreshing
          ? <LoaderCircle size={22} strokeWidth={1.8} className="spin" aria-label="Loading Git status" />
          : <GitBranch size={26} strokeWidth={1.6} aria-hidden="true" />}
        <p data-error={error ? 'true' : undefined}>{error ?? 'Loading repository…'}</p>
        <div className="git-window-empty-actions">
          <button type="button" onClick={onRefresh}><RefreshCw size={14} aria-hidden="true" /> Refresh</button>
        </div>
      </div>
    )
  }

  if (!repoInfo.isRepo) {
    return (
      <div ref={setRootElement} className="git-window git-window-empty" data-git-window="true">
        <GitBranch size={28} strokeWidth={1.6} aria-hidden="true" />
        <h2>No Git repository</h2>
        <p>Initialize this workspace folder or clone into another folder.</p>
        {error ? <div className="git-window-error">{error}</div> : null}
        <div className="git-window-empty-actions">
          <button type="button" className="git-window-primary-action" onClick={onInitialize}><GitCommit size={14} aria-hidden="true" /> Initialize Repository</button>
          <button type="button" onClick={onOpenClone}><CloudDownload size={14} aria-hidden="true" /> Clone Repository…</button>
        </div>
        {clone.open ? <CloneDialog clone={clone} /> : null}
      </div>
    )
  }

  const branchLabel = repoInfo.branch ?? repoInfo.detachedSha?.slice(0, 8) ?? 'Detached'
  const stateActive = repoInfo.state !== 'clean'
  const tabs: Array<{ id: GitTab; label: string; visible: boolean }> = [
    { id: 'changes', label: 'Changes', visible: true },
    { id: 'history', label: 'History', visible: true },
    { id: 'branches', label: 'Branches', visible: true },
    { id: 'pullRequests', label: 'Pull Requests', visible: pullRequestsVisible },
  ]
  const visibleGroups = groups.filter((group) => group.rows.length > 0)

  return (
    <div ref={setRootElement} className="git-window" data-git-window="true">
      <header className="git-window-statusbar">
        <button
          type="button"
          className="git-window-branch-pill"
          onClick={onOpenBranchPicker}
          title={repoInfo.upstream ? `Switch branch — tracking ${repoInfo.upstream}` : 'Switch branch'}
        >
          <GitBranch size={13} strokeWidth={1.9} aria-hidden="true" />
          <span className="git-window-branch-name">{branchLabel}</span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {ciStatus ? <span className="git-window-ci-dot" data-state={ciStatus.state} title={`CI: ${ciStatus.state}`} /> : null}
        <span className="git-window-sync-count" title="Ahead" data-zero={repoInfo.ahead === 0 || undefined}>↑{repoInfo.ahead}</span>
        <span className="git-window-sync-count" title="Behind" data-zero={repoInfo.behind === 0 || undefined}>↓{repoInfo.behind}</span>
        <span className="git-window-status-spacer" />
        <button type="button" title="Refresh" aria-label="Refresh" onClick={onRefresh} disabled={refreshing}><RefreshCw size={14} strokeWidth={1.9} className={refreshing ? 'spin' : undefined} aria-hidden="true" /></button>
        <button type="button" title="Fetch" aria-label="Fetch" onClick={onFetch}><CloudDownload size={14} strokeWidth={1.9} aria-hidden="true" /></button>
        <button type="button" title="Pull" aria-label="Pull" onClick={onPull}><RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" /></button>
        <button type="button" title="Push" aria-label="Push" onClick={onPush}><CloudUpload size={14} strokeWidth={1.9} aria-hidden="true" /></button>
      </header>

      {stateActive ? (
        <div className="git-window-repo-state" data-repo-state={repoInfo.state}>
          <AlertTriangle size={15} strokeWidth={1.9} aria-hidden="true" />
          <span>Repository is {repoInfo.state}.</span>
          {onContinueState ? <button type="button" onClick={onContinueState}><Check size={13} aria-hidden="true" /> Continue</button> : null}
          {onAbortState ? <button type="button" onClick={onAbortState}><X size={13} aria-hidden="true" /> Abort</button> : null}
        </div>
      ) : null}
      {error ? <div className="git-window-error">{error}</div> : null}
      {status?.truncated ? <div className="git-window-warning">Showing the first 5,000 status entries.</div> : null}

      <nav className="git-window-tabs" role="tablist" aria-label="Git views">
        {tabs.filter((tab) => tab.visible).map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => onTabChange(tab.id)}>{tab.label}</button>
        ))}
      </nav>

      {activeTab === 'changes' ? (
        <section className="git-window-changes" data-git-tab="changes">
          <aside className="git-window-changes-list">
            <div className="git-window-commit-box">
              <textarea
                aria-label="Commit message"
                placeholder="Message (Ctrl+Enter to commit)"
                value={commitMessage}
                onChange={(event) => onCommitMessageChange(event.target.value)}
                onKeyDown={(event) => {
                  if (event.ctrlKey && event.key === 'Enter' && canCommit) onCommit()
                }}
              />
              <div className="git-window-commit-controls">
                <label><input type="checkbox" checked={amend} onChange={(event) => onAmendChange(event.target.checked)} /> Amend</label>
                <button type="button" className="git-window-commit-button" onClick={onCommit} disabled={!canCommit}><GitCommit size={14} strokeWidth={1.9} aria-hidden="true" /> Commit</button>
              </div>
            </div>
            {visibleGroups.length === 0 ? (
              <div className="git-window-no-changes"><Check size={15} strokeWidth={1.9} aria-hidden="true" /> No changes</div>
            ) : visibleGroups.map((group) => (
              <section key={group.id} className="git-window-change-group" data-change-group={group.id}>
                <header>
                  <h3>{group.title} <span>{group.count}</span></h3>
                  {group.actions.length > 0 ? (
                    <div className="git-window-group-actions">
                      {group.actions.map((action) => <GitActionButton key={action.id} action={action} />)}
                    </div>
                  ) : null}
                </header>
                {group.rows.map((row) => <GitChangeRowView key={row.id} row={row} />)}
              </section>
            ))}
          </aside>
          <div className="git-window-main-divider" role="separator" aria-orientation="vertical" />
          <DiffPane files={[]} selectedPath={selectedPath} onSelect={() => {}} contents={contents} loading={diffLoading} splitView error={diffError} hideFileList />
        </section>
      ) : activeTab === 'history' ? historyContent
        : activeTab === 'branches' ? branchesContent
          : pullRequestsContent
      }
      {clone.open ? <CloneDialog clone={clone} /> : null}
    </div>
  )
}

function CloneDialog({ clone }: { clone: GitCloneViewState }) {
  return (
    <div className="git-clone-backdrop" role="presentation" onMouseDown={clone.onClose}>
      <section className="git-clone-dialog" role="dialog" aria-label="Clone repository" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2>Clone Repository</h2><button type="button" title="Close" aria-label="Close" onClick={clone.onClose}><X size={14} strokeWidth={1.9} aria-hidden="true" /></button></header>
        <label>Repository URL<input value={clone.url} onChange={(event) => clone.onUrlChange(event.target.value)} placeholder="https://github.com/owner/repo.git" /></label>
        <label>Target directory<div><input readOnly value={clone.targetDir} placeholder="Choose an empty target folder" /><button type="button" onClick={clone.onChooseTarget}>Browse…</button></div></label>
        {clone.progress.length > 0 ? <pre>{clone.progress.join('\n')}</pre> : null}
        <footer><button type="button" onClick={clone.onClose} disabled={clone.running}>Cancel</button><button type="button" className="git-window-primary-action" onClick={clone.onStart} disabled={clone.running || !clone.url.trim() || !clone.targetDir}>{clone.running ? 'Cloning…' : 'Clone'}</button></footer>
      </section>
    </div>
  )
}

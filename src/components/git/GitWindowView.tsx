import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, CloudDownload, CloudUpload, FileDiff, FolderGit2, GitBranch, GitCommit, GitCompare, LoaderCircle, Minus, Plus, RefreshCw, RotateCcw, Undo2, X } from 'lucide-react'
import type { LucideProps } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import type { ChangeType, CiStatus, FileContents, RepoInfo, WorkingStatus } from '../../ipc/types'
import type { GitDiffArea, GitTab } from '../../state/git'
import { DiffPane } from './DiffPane'

export type GitRowAction = {
  id: string
  label: string
  danger?: boolean
  onClick: () => void
}


export type GitChangeListArea = GitDiffArea | 'remote'

export type GitChangeItem = {
  path: string
  oldPath: string | null
  changeType: ChangeType
  area: GitChangeListArea
}

export type GitChangeGroup = {
  id: 'conflicted' | 'staged' | 'unstaged' | 'untracked' | 'remote'
  title: string
  count: number
  actions: GitRowAction[]
  items: GitChangeItem[]
}

const ACTION_ICONS: Record<string, ComponentType<LucideProps>> = {
  'stage-all': Plus,
  'unstage-all': Minus,
  'discard-all': Undo2,
}

const CHANGE_LABEL_BY_TYPE: Record<ChangeType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: 'U',
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
  repositoryPath: string
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
  onOpenWorkspaceRepository: (() => void) | null
  onRefresh: () => void
  onInitialize: () => void
  onOpenClone: () => void
  onOpenBranchPicker: () => void
  onFetch: () => void
  onPull: () => void
  onPush: () => void
  selectedArea: GitChangeListArea
  remoteUpstream: string | null
  remoteComparisonActive: boolean
  remoteCompareLoading: boolean
  onCompareRemote: () => void
  onShowWorkingChanges: () => void
  onSelectChange: (item: GitChangeItem) => void
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


function GitActionButton({ action, subject }: { action: GitRowAction; subject?: string }) {
  const Icon = ACTION_ICONS[action.id]
  const title = subject ? `${action.label} ${subject}` : action.label
  return (
    <button type="button" title={title} aria-label={title} data-danger={action.danger || undefined} onClick={action.onClick}>
      {Icon ? <Icon size={13} strokeWidth={1.9} aria-hidden="true" /> : action.label}
    </button>
  )
}

export function GitWindowView({ setRootElement, workspaceFolder, repositoryPath, repoInfo, status, refreshing, error, activeTab, pullRequestsVisible, ciStatus, commitMessage, amend, canCommit, groups, selectedPath, selectedArea, contents, diffLoading, diffError, clone, remoteUpstream, remoteComparisonActive, remoteCompareLoading, onOpenWorkspaceRepository, onRefresh, onInitialize, onOpenClone, onOpenBranchPicker, onFetch, onPull, onPush, onCompareRemote, onShowWorkingChanges, onSelectChange, onContinueState, onAbortState, onTabChange, onCommitMessageChange, onAmendChange, onCommit, historyContent, branchesContent, pullRequestsContent }: GitWindowViewProps) {
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
  const repositoryLabel = repositoryPath.split('/').filter(Boolean).pop() ?? 'Workspace repo'
  const repositoryDescription = repositoryPath ? `nested repository ${repositoryPath}` : 'workspace repository'
  const tabs: Array<{ id: GitTab; label: string; visible: boolean }> = [
    { id: 'changes', label: 'Changes', visible: true },
    { id: 'history', label: 'History', visible: true },
    { id: 'branches', label: 'Branches', visible: true },
    { id: 'pullRequests', label: 'Pull Requests', visible: pullRequestsVisible },
  ]
  const visibleGroups = groups.filter((group) => group.count > 0)

  return (
    <div ref={setRootElement} className="git-window" data-git-window="true">
      <header className="git-window-statusbar">
        <div className="git-window-repository-context" title={`Git target: ${repositoryDescription}. Workspace, terminals, and AI scope stay unchanged.`}>
          <span className="git-window-repository-label">Git target</span>
          <button type="button" onClick={onOpenWorkspaceRepository ?? undefined} disabled={!onOpenWorkspaceRepository} aria-label={repositoryPath ? 'Open workspace repository' : 'Workspace repository'}>
            <FolderGit2 size={13} strokeWidth={1.9} aria-hidden="true" />
            <span>Workspace repo</span>
          </button>
          {repositoryPath ? <><ChevronRight size={11} aria-hidden="true" /><code>{repositoryPath}</code></> : null}
        </div>
        <button
          type="button"
          className="git-window-branch-pill"
          onClick={onOpenBranchPicker}
          title={repoInfo.upstream ? `Switch branch in ${repositoryDescription} — tracking ${repoInfo.upstream}` : `Switch branch in ${repositoryDescription}`}
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
        <button type="button" title={`Fetch ${repositoryDescription}`} aria-label={`Fetch ${repositoryDescription}`} onClick={onFetch}><CloudDownload size={14} strokeWidth={1.9} aria-hidden="true" /></button>
        <button type="button" title={`Pull ${repositoryDescription}`} aria-label={`Pull ${repositoryDescription}`} onClick={onPull}><RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" /></button>
        <button type="button" title={`Push ${repositoryDescription}`} aria-label={`Push ${repositoryDescription}`} onClick={onPush}><CloudUpload size={14} strokeWidth={1.9} aria-hidden="true" /></button>
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
                <button type="button" className="git-window-commit-button" title={`Commit staged changes to ${repositoryDescription}`} onClick={onCommit} disabled={!canCommit}><GitCommit size={14} strokeWidth={1.9} aria-hidden="true" /> Commit · {repositoryLabel}</button>
              </div>
            </div>
            <div className="git-window-remote-compare" data-active={remoteComparisonActive || undefined}>
              {remoteComparisonActive ? (
                <>
                  <div>
                    <strong>Remote comparison</strong>
                    <span>Exact local HEAD → {remoteUpstream}</span>
                  </div>
                  <button type="button" onClick={onShowWorkingChanges}><ArrowLeft size={13} aria-hidden="true" /> Working changes</button>
                </>
              ) : (
                <>
                  <div>
                    <strong>Remote changes</strong>
                    <span>{remoteUpstream ? `Fetch and compare ${remoteUpstream}` : 'Set an upstream branch to compare'}</span>
                  </div>
                  <button type="button" aria-label={remoteUpstream ? `Fetch and compare remote ${remoteUpstream}` : 'No upstream branch to compare'} disabled={!remoteUpstream || remoteCompareLoading} onClick={onCompareRemote}>
                    {remoteCompareLoading ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : <GitCompare size={13} aria-hidden="true" />} Compare
                  </button>
                </>
              )}
            </div>
            <div className="git-window-explorer-handoff">
              <FolderGit2 size={18} strokeWidth={1.7} aria-hidden="true" />
              <div><strong>Changed file list</strong><span>Selecting a file also reveals its location in Explorer.</span></div>
            </div>
            {visibleGroups.length === 0 ? (
              <div className="git-window-no-changes"><Check size={15} strokeWidth={1.9} aria-hidden="true" /> {remoteComparisonActive ? 'No remote changes' : 'No changes'}</div>
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
                <div className="git-window-change-items">
                  {group.items.map((item) => (
                    <button
                      key={`${item.area}:${item.path}`}
                      type="button"
                      aria-label={`${group.title}: ${item.path}`}
                      data-selected={selectedPath === item.path && selectedArea === item.area || undefined}
                      title={item.oldPath ? `${item.path} (from ${item.oldPath})` : item.path}
                      onClick={() => onSelectChange(item)}
                    >
                      <span className="git-window-change-type" data-change-type={item.changeType}>{CHANGE_LABEL_BY_TYPE[item.changeType]}</span>
                      <FileDiff size={13} aria-hidden="true" />
                      <span className="git-window-change-path">{item.path}</span>
                    </button>
                  ))}
                </div>
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

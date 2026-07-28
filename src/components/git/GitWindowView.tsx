import { AlertTriangle, ArrowLeft, Check, ChevronDown, ChevronRight, CloudDownload, CloudUpload, FolderGit2, GitBranch, GitCompare, RefreshCw, RotateCcw, X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { GitTab } from '../../state/git'
import { BranchesTab } from './BranchesTab'
import { DiffPane } from './DiffPane'
import { useGitWorkspace } from './GitWorkspaceProvider'
import { HistoryTab } from './HistoryTab'
import { WorktreeReviewPanel } from '../workspaces/WorktreeReviewPanel'

export type GitWindowViewProps = {
  assignedContent: ReactNode
}

export function GitWindowView({ assignedContent }: GitWindowViewProps) {
  const git = useGitWorkspace()
  const repoInfo = git.repoInfo
  const hasRepositoryTargets = git.repositoryTargets.length > 0

  if (!git.workspaceFolder) {
    return <div className="git-window git-window-empty" data-git-window="true"><FolderGit2 size={28} strokeWidth={1.6} aria-hidden="true" /><h2>No workspace folder</h2><p>Set a workspace folder to use Git.</p></div>
  }
  if (!repoInfo && !hasRepositoryTargets) {
    return <div className="git-window git-window-empty" data-git-window="true"><GitBranch size={26} strokeWidth={1.6} aria-hidden="true" /><p data-error={git.repository.error ? 'true' : undefined}>{git.repository.error ?? 'Loading repository…'}</p><div className="git-window-empty-actions"><button type="button" onClick={() => { void git.refresh() }}><RefreshCw size={14} aria-hidden="true" /> Refresh</button></div></div>
  }
  if (!repoInfo?.isRepo) {
    if (hasRepositoryTargets) {
      const scope = git.repositoryScopeName ? `the ${git.repositoryScopeName} workspace group` : 'this workspace'
      return <div className="git-window git-window-empty" data-git-window="true"><FolderGit2 size={28} strokeWidth={1.6} aria-hidden="true" /><h2>Select a Git repository</h2><p>Choose one of the {git.repositoryTargets.length} repositories in {scope} from Source Control. Workspace, terminal, and AI scope stay unchanged.</p></div>
    }
    return <div className="git-window git-window-empty" data-git-window="true"><GitBranch size={28} strokeWidth={1.6} aria-hidden="true" /><h2>No Git repository</h2><p>Use Source Control to initialize this target or clone a repository.</p><div className="git-window-empty-actions"><button type="button" onClick={git.openClone}><CloudDownload size={14} aria-hidden="true" /> Clone Repository…</button></div></div>
  }

  const repositoryDescription = git.activeRepoRoot ? `nested repository ${git.activeRepoRoot}` : 'workspace repository'
  const workspaceTargetLabel = git.repositoryTargets.some((target) => target.root === '') ? 'Workspace repo' : 'Workspace root'
  const branchLabel = repoInfo.branch ?? repoInfo.detachedSha?.slice(0, 8) ?? 'Detached'
  const tabs: Array<{ id: GitTab; label: string }> = [
    { id: 'changes', label: 'Changes' },
    { id: 'history', label: 'History' },
    { id: 'branches', label: 'Branches' },
    { id: 'assigned', label: 'Assigned / Pull Requests' },
  ]

  return (
    <div className="git-window git-workbench-detail" data-git-window="true">
      <header className="git-window-statusbar">
        <strong className="git-window-title">Workbench</strong>
        <div className="git-window-repository-context" title={`Git target: ${repositoryDescription}. Workspace, terminals, and AI scope stay unchanged.`}><span className="git-window-repository-label">Git target</span><button type="button" onClick={() => git.activateRepository('')} disabled={!git.activeRepoRoot} aria-label={git.activeRepoRoot ? `Open ${workspaceTargetLabel.toLowerCase()}` : workspaceTargetLabel}><FolderGit2 size={13} strokeWidth={1.9} aria-hidden="true" /><span>{workspaceTargetLabel}</span></button>{git.activeRepoRoot ? <><ChevronRight size={11} aria-hidden="true" /><code>{git.activeRepoRoot}</code></> : null}</div>
        <button type="button" className="git-window-branch-pill" onClick={git.openBranchPicker} title={repoInfo.upstream ? `Switch branch in ${repositoryDescription} — tracking ${repoInfo.upstream}` : `Switch branch in ${repositoryDescription}`}><GitBranch size={13} strokeWidth={1.9} aria-hidden="true" /><span className="git-window-branch-name">{branchLabel}</span><ChevronDown size={12} aria-hidden="true" /></button>
        <span className="git-window-upstream" title={repoInfo.upstream ? `Upstream ${repoInfo.upstream}` : 'No upstream configured'}>{repoInfo.upstream ?? 'No upstream'}</span>
        {git.repository.ciStatus ? <span className="git-window-ci-dot" data-state={git.repository.ciStatus.state} title={`CI: ${git.repository.ciStatus.state}`} /> : null}
        <span className="git-window-sync-count" title="Ahead" data-zero={repoInfo.ahead === 0 || undefined}>↑{repoInfo.ahead}</span><span className="git-window-sync-count" title="Behind" data-zero={repoInfo.behind === 0 || undefined}>↓{repoInfo.behind}</span><span className="git-window-status-spacer" />
        <button type="button" title="Refresh" aria-label="Refresh" onClick={() => { void git.refresh() }} disabled={git.repository.refreshing}><RefreshCw size={14} strokeWidth={1.9} className={git.repository.refreshing ? 'spin' : undefined} aria-hidden="true" /></button><button type="button" title={`Fetch ${repositoryDescription}`} aria-label={`Fetch ${repositoryDescription}`} onClick={git.fetch}><CloudDownload size={14} strokeWidth={1.9} aria-hidden="true" /></button><button type="button" title={`Pull ${repositoryDescription}`} aria-label={`Pull ${repositoryDescription}`} onClick={git.pull}><RotateCcw size={14} strokeWidth={1.9} aria-hidden="true" /></button><button type="button" title={`Push ${repositoryDescription}`} aria-label={`Push ${repositoryDescription}`} onClick={git.push}><CloudUpload size={14} strokeWidth={1.9} aria-hidden="true" /></button>
      </header>
      {repoInfo.state !== 'clean' ? <div className="git-window-repo-state" data-repo-state={repoInfo.state}><AlertTriangle size={15} strokeWidth={1.9} aria-hidden="true" /><span>Repository is {repoInfo.state}.</span>{git.continueState ? <button type="button" onClick={git.continueState}><Check size={13} aria-hidden="true" /> Continue</button> : null}{git.abortState ? <button type="button" onClick={git.abortState}><X size={13} aria-hidden="true" /> Abort</button> : null}</div> : null}
      {git.repository.error ? <div className="git-window-error">{git.repository.error}</div> : null}
      <nav className="git-window-tabs" role="tablist" aria-label="Workbench views">{tabs.map((tab) => <button key={tab.id} type="button" role="tab" aria-selected={git.activeTab === tab.id} onClick={() => { void git.openWorkbench(tab.id) }}>{tab.label}</button>)}</nav>
      {git.activeTab === 'changes' ? <section className="git-window-changes git-workbench-changes-detail" data-git-tab="changes">
        {git.remoteComparisonActive ? <div className="git-window-remote-compare" data-active><div><strong>Remote comparison</strong><span>Exact local HEAD → {repoInfo.upstream}</span></div><button type="button" onClick={git.showWorkingChanges}><ArrowLeft size={13} aria-hidden="true" /> Working changes</button></div> : repoInfo.upstream ? <div className="git-window-remote-compare"><div><strong>Remote changes</strong><span>Fetch and compare {repoInfo.upstream}</span></div><button type="button" disabled={git.remoteCompareLoading} onClick={git.compareRemote}>{git.remoteCompareLoading ? 'Comparing…' : <><GitCompare size={13} aria-hidden="true" /> Compare</>}</button></div> : null}
        <DiffPane files={[]} selectedPath={git.selectedPath} onSelect={() => {}} contents={git.contents} loading={git.diffLoading} splitView error={git.diffError} hideFileList hunkDiff={git.diffHunks} selectedHunkId={git.selectedHunkId} onSelectHunk={git.selectHunk} onHunkAction={git.applyHunk} onCommentHunk={git.commentHunk} onCommentLine={git.commentLine} hunkComments={git.selectedHunkComments} reviewWarning={git.reviewWarning} />
        {git.reviewIdentity || git.reviewLoading || git.reviewComments.length > 0 || git.reviewCheckpoints.length > 0 || git.reviewError ? <WorktreeReviewPanel identity={git.reviewIdentity} comments={git.reviewComments} checkpoints={git.reviewCheckpoints} currentAnchorKeys={git.reviewAnchorKeys} loading={git.reviewLoading} error={git.reviewError} onRefresh={() => { void git.refreshReview() }} /> : null}
      </section> : git.activeTab === 'history' ? <HistoryTab /> : git.activeTab === 'branches' ? <BranchesTab /> : assignedContent}
    </div>
  )
}

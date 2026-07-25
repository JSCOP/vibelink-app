import { invoke } from '@tauri-apps/api/core'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, Check, ChevronRight, CloudDownload, CloudUpload, FileDiff, FolderGit2, GitBranch, GitCommit, GitCompareArrows, MoreHorizontal, RefreshCw, RotateCcw } from 'lucide-react'
import { memo, useMemo, useRef } from 'react'
import type { ChangeType } from '../../ipc/types'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { useGitWorkspace } from './GitWorkspaceProvider'
import { flattenGitChangeRows, gitChangeRowHeight } from './gitChangeRows'
import type { GitChangeItem } from './gitWorkspaceModel'

export type SourceControlSidebarProps = {
  active?: boolean
  collapsed?: boolean
  onCollapse?: () => void
}

const CHANGE_LABEL: Record<ChangeType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: '?',
}

export function SourceControlSidebar({ active = true, collapsed = false, onCollapse }: SourceControlSidebarProps) {
  const git = useGitWorkspace()
  const changeScrollRef = useRef<HTMLDivElement | null>(null)
  // A dirty repository can hold thousands of entries. Rendering one row per
  // change put ~19k elements (79% of the whole app DOM) behind every React
  // pass, so unrelated work like splitting a pane paid for reconciling the
  // entire list. Flatten group headers + rows into one list and virtualize it.
  const changeRows = useMemo(() => flattenGitChangeRows(git.groups), [git.groups])
  // TanStack Virtual intentionally exposes non-memoizable functions; this component is not compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const changeVirtualizer = useVirtualizer({
    count: changeRows.length,
    getScrollElement: () => changeScrollRef.current,
    estimateSize: (index) => gitChangeRowHeight(changeRows[index]),
    overscan: 12,
  })
  const repoInfo = git.repoInfo
  const repositoryDescription = git.activeRepoRoot ? `nested repository ${git.activeRepoRoot}` : 'workspace repository'
  const shellState = !git.workspaceFolder
    ? { kind: 'empty' as const, message: 'No workspace folder', detail: 'Set a local workspace folder to use Git.' }
    : !repoInfo
      ? { kind: git.repository.error ? 'error' as const : 'loading' as const, message: git.repository.error ?? 'Loading repository…' }
      : null

  const footer = repoInfo?.isRepo && git.primaryAction ? (
    <button type="button" className="git-sidebar-primary-action" disabled={git.primaryAction.disabled} onClick={git.runPrimaryAction}>{git.primaryAction.label}</button>
  ) : null

  return (
    <WorkspaceSidebarPanelShell
      title="Source Control"
      icon={<GitCompareArrows size={15} aria-hidden="true" />}
      active={active}
      collapsed={collapsed}
      onCollapse={onCollapse}
      collapseLabel="Collapse Source Control"
      state={shellState}
      className="git-sidebar git-source-control-sidebar"
      actions={<>
        <button type="button" title="Refresh Source Control" aria-label="Refresh Source Control" onClick={() => { void git.refresh() }} disabled={git.repository.refreshing}><RefreshCw size={13} className={git.repository.refreshing ? 'spin' : undefined} aria-hidden="true" /></button>
        <details className="git-sidebar-overflow"><summary role="button" aria-label="More Source Control actions" title="More actions"><MoreHorizontal size={14} aria-hidden="true" /></summary><div role="menu"><button type="button" role="menuitem" onClick={() => { void git.openAssigned() }}>Assigned / Pull Requests</button><button type="button" role="menuitem" onClick={git.fetch}>Fetch</button><button type="button" role="menuitem" onClick={git.pull}>Pull</button><button type="button" role="menuitem" onClick={git.push}>Push</button></div></details>
      </>}
      footer={footer}
    >
      {repoInfo && !repoInfo.isRepo ? (
        <div className="git-sidebar-empty-actions"><FolderGit2 size={24} aria-hidden="true" /><strong>No Git repository</strong><span>Initialize this Git target or clone into another folder.</span>{git.repository.error ? <div className="git-window-error">{git.repository.error}</div> : null}<button type="button" onClick={() => { if (git.activeWorkspaceFolder) void git.runMutation(() => invoke('git_init', { workspaceFolder: git.activeWorkspaceFolder })) }}><GitCommit size={13} aria-hidden="true" /> Initialize Repository</button><button type="button" onClick={git.openClone}><CloudDownload size={13} aria-hidden="true" /> Clone Repository…</button></div>
      ) : repoInfo?.isRepo ? <>
        <div className="git-sidebar-repository-context" title={`Git target: ${repositoryDescription}. Workspace, terminals, and AI scope stay unchanged.`}><span>Git target</span><button type="button" onClick={() => git.activateRepository('')} disabled={!git.activeRepoRoot}><FolderGit2 size={12} aria-hidden="true" /> Workspace repo</button>{git.activeRepoRoot ? <><ChevronRight size={11} aria-hidden="true" /><code>{git.activeRepoRoot}</code></> : null}</div>
        <div className="git-sidebar-branch-row"><button type="button" onClick={git.openBranchPicker} title={`Switch branch in ${repositoryDescription}`}><GitBranch size={13} aria-hidden="true" /><strong>{repoInfo.branch ?? repoInfo.detachedSha?.slice(0, 8) ?? 'Detached'}</strong></button><span title={repoInfo.upstream ?? 'No upstream'}>{repoInfo.upstream ?? 'No upstream'}</span>{git.repository.ciStatus ? <i className="git-window-ci-dot" data-state={git.repository.ciStatus.state} title={`CI: ${git.repository.ciStatus.state}`} /> : null}<em title="Ahead">↑{repoInfo.ahead}</em><em title="Behind">↓{repoInfo.behind}</em><button type="button" title={repoInfo.upstream ? `Compare with ${repoInfo.upstream}` : 'No upstream branch'} disabled={!repoInfo.upstream || git.remoteCompareLoading} onClick={git.compareRemote}><GitCompareArrows size={12} aria-hidden="true" /></button></div>
        {repoInfo.state !== 'clean' ? <div className="git-sidebar-operation" data-repo-state={repoInfo.state}><AlertTriangle size={13} aria-hidden="true" /><span>Repository is {repoInfo.state}.</span>{git.continueState ? <button type="button" onClick={git.continueState}><Check size={12} aria-hidden="true" /> Continue</button> : null}{git.abortState ? <button type="button" onClick={git.abortState}>Abort</button> : null}</div> : null}
        {git.repository.error ? <div className="git-window-error">{git.repository.error}</div> : null}
        {git.status.truncated ? <div className="git-window-warning">Showing the first 5,000 status entries.</div> : null}
        <div className="git-sidebar-commit-box"><textarea aria-label="Commit message" placeholder="Message (Ctrl+Enter to commit)" value={git.commitMessage} onChange={(event) => git.setCommitMessage(event.target.value)} onKeyDown={(event) => { if (event.ctrlKey && event.key === 'Enter' && !git.primaryAction?.disabled && git.primaryAction?.id === 'commit') git.commit() }} /><div><label><input type="checkbox" checked={git.amend} onChange={(event) => git.setAmend(event.target.checked)} /> Amend</label><button type="button" onClick={git.commit} disabled={!git.commitMessage.trim() || (!git.amend && git.status.staged.length === 0)}><GitCommit size={12} aria-hidden="true" /> Commit</button></div></div>
        {git.remoteComparisonActive ? <div className="git-sidebar-remote-banner"><span>Remote comparison</span><button type="button" onClick={git.showWorkingChanges}><RotateCcw size={12} aria-hidden="true" /> Working changes</button></div> : null}
        <div className="git-sidebar-change-groups" ref={changeScrollRef}>
          <div className="git-sidebar-change-viewport" style={{ height: changeVirtualizer.getTotalSize() }}>
            {changeVirtualizer.getVirtualItems().map((virtualRow) => {
              const row = changeRows[virtualRow.index]
              if (!row) return null
              return (
                <div key={row.key} className="git-sidebar-change-slot" style={{ height: virtualRow.size, transform: `translateY(${virtualRow.start}px)` }}>
                  {row.kind === 'header' ? (
                    <header className="git-sidebar-change-group-header" data-change-group={row.group.id}>
                      <h3>{row.group.title} <span>{row.group.count}</span></h3>
                      <div>{row.group.actions.map((action) => <button key={action.id} type="button" title={action.label} data-danger={action.danger || undefined} onClick={action.onClick}>{action.label}</button>)}</div>
                    </header>
                  ) : (
                    <ChangeRow
                      item={row.item}
                      untracked={row.untracked}
                      selected={git.selectedPath === row.item.path && git.selectedArea === row.item.area}
                      onSelect={git.selectChange}
                      onStage={git.stagePaths}
                      onUnstage={git.unstagePaths}
                      onDiscard={git.discardPaths}
                    />
                  )}
                </div>
              )
            })}
          </div>
        </div>
        {git.groups.every((group) => group.count === 0) ? <div className="git-sidebar-clean"><Check size={14} aria-hidden="true" /> No changes</div> : null}
        <div className="git-sidebar-sync-actions"><button type="button" onClick={git.fetch}><CloudDownload size={12} aria-hidden="true" /> Fetch</button><button type="button" onClick={git.pull}><RotateCcw size={12} aria-hidden="true" /> Pull</button><button type="button" onClick={git.push}><CloudUpload size={12} aria-hidden="true" /> Push</button></div>
      </> : null}
    </WorkspaceSidebarPanelShell>
  )
}

type ChangeRowProps = {
  item: GitChangeItem
  selected: boolean
  untracked: boolean
  onSelect: (item: GitChangeItem) => void
  onStage: (paths: string[]) => void
  onUnstage: (paths: string[]) => void
  onDiscard: (paths: string[], untracked: boolean) => void
}

// Memoized against the controller's stable callbacks: the per-row closures are
// built inside so a re-render of the sidebar does not invalidate every row.
const ChangeRow = memo(function ChangeRow({ item, selected, untracked, onSelect, onStage, onUnstage, onDiscard }: ChangeRowProps) {
  const slash = item.path.lastIndexOf('/')
  const basename = slash >= 0 ? item.path.slice(slash + 1) : item.path
  const parent = slash >= 0 ? item.path.slice(0, slash) : ''
  return (
    <div className="git-sidebar-change-row" data-selected={selected || undefined}>
      <button type="button" className="git-sidebar-change-main" aria-label={`${item.area}: ${item.path}`} onClick={() => onSelect(item)}><span data-change-type={item.changeType}>{CHANGE_LABEL[item.changeType]}</span><FileDiff size={12} aria-hidden="true" /><strong>{basename}</strong>{parent ? <small>{parent}</small> : null}</button>
      <details><summary role="button" aria-label={`Actions for ${item.path}`}><MoreHorizontal size={13} aria-hidden="true" /></summary><div role="menu">{item.area === 'staged' ? <button type="button" role="menuitem" onClick={() => onUnstage([item.path])}>Unstage</button> : item.area !== 'remote' ? <button type="button" role="menuitem" onClick={() => onStage([item.path])}>Stage</button> : null}{item.area !== 'remote' ? <button type="button" role="menuitem" data-danger onClick={() => onDiscard([item.path], untracked)}>Discard…</button> : null}</div></details>
    </div>
  )
})

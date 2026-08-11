import { useEffect } from 'react'
import { History, RefreshCw } from 'lucide-react'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { useGitWorkspace } from './GitWorkspaceProvider'
import { HistoryNavigatorView } from './HistoryTabView'

export type GitHistorySidebarProps = {
  /** Dockview focus — header accent only. */
  active?: boolean
  /** Selected tab in its edge group. Loading is gated on this, not `active`. */
  visible?: boolean
  collapsed?: boolean
  onCollapse?: () => void
}

export function GitHistorySidebar({ active = true, visible = true, collapsed = false, onCollapse }: GitHistorySidebarProps) {
  const git = useGitWorkspace()
  const history = git.history

  useEffect(() => {
    if (visible && git.repoInfo?.isRepo) history.activate()
  }, [visible, git.activeRepoRoot, git.repoInfo?.isRepo, history])

  const state = !git.workspaceFolder
    ? { kind: 'empty' as const, message: 'No workspace folder', detail: 'Set a local workspace folder to browse history.' }
    : !git.repoInfo
      ? { kind: git.repository.error ? 'error' as const : 'loading' as const, message: git.repository.error ?? 'Loading repository…' }
      : !git.repoInfo.isRepo
        ? { kind: 'empty' as const, message: 'No Git repository', detail: 'Initialize the active Git target before browsing history.' }
        : null

  return (
    <WorkspaceSidebarPanelShell
      title="Git History"
      icon={<History size={15} aria-hidden="true" />}
      active={active}
      collapsed={collapsed}
      onCollapse={onCollapse}
      collapseLabel="Collapse Git History"
      state={state}
      className="git-sidebar git-history-sidebar"
      actions={<button type="button" title="Refresh Git History" aria-label="Refresh Git History" onClick={() => { history.activate(); void history.refresh() }} disabled={history.loading}><RefreshCw size={13} className={history.loading ? 'spin' : undefined} aria-hidden="true" /></button>}
    >
      {git.repoInfo?.isRepo ? <>
        <div className="git-sidebar-target"><span>Git target</span><code>{git.activeRepoRoot || 'Workspace repo'}</code></div>
        <HistoryNavigatorView
          commits={history.commits}
          graph={history.graph}
          hasMore={history.hasMore}
          loading={history.loading}
          error={history.error}
          search={history.search}
          author={history.author}
          pathFilter={history.pathFilter}
          selectedSha={history.selectedSha}
          onSearchChange={history.setSearch}
          onAuthorChange={history.setAuthor}
          onClearPathFilter={history.clearPathFilter}
          onSelectCommit={history.selectCommit}
          onLoadMore={() => { if (!history.loading && history.hasMore) void history.loadMore() }}
        />
      </> : null}
    </WorkspaceSidebarPanelShell>
  )
}

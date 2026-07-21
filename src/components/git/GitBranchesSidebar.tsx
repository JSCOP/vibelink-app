import { useEffect } from 'react'
import { GitBranch, RefreshCw } from 'lucide-react'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { useGitWorkspace } from './GitWorkspaceProvider'
import { BranchesNavigatorView, StashDialog } from './BranchesTabView'

export type GitBranchesSidebarProps = {
  active?: boolean
  collapsed?: boolean
  onCollapse?: () => void
}

export function GitBranchesSidebar({ active = true, collapsed = false, onCollapse }: GitBranchesSidebarProps) {
  const git = useGitWorkspace()
  const branches = git.branches

  useEffect(() => {
    if (active && git.repoInfo?.isRepo) branches.activate()
  }, [active, branches, git.activeRepoRoot, git.repoInfo?.isRepo])

  const state = !git.workspaceFolder
    ? { kind: 'empty' as const, message: 'No workspace folder', detail: 'Set a local workspace folder to manage branches.' }
    : !git.repoInfo
      ? { kind: git.repository.error ? 'error' as const : 'loading' as const, message: git.repository.error ?? 'Loading repository…' }
      : !git.repoInfo.isRepo
        ? { kind: 'empty' as const, message: 'No Git repository', detail: 'Initialize the active Git target before managing branches.' }
        : null

  return (
    <>
      <WorkspaceSidebarPanelShell
        title="Branches"
        icon={<GitBranch size={15} aria-hidden="true" />}
        active={active}
        collapsed={collapsed}
        onCollapse={onCollapse}
        collapseLabel="Collapse Git Branches"
        state={state}
        className="git-sidebar git-branches-sidebar"
        actions={<button type="button" title="Refresh Git Branches" aria-label="Refresh Git Branches" onClick={() => { branches.activate(); void branches.refresh() }} disabled={branches.loading}><RefreshCw size={13} className={branches.loading ? 'spin' : undefined} aria-hidden="true" /></button>}
        footer={git.repoInfo?.isRepo ? <button type="button" className="git-sidebar-primary-action" onClick={branches.compare}>Compare {branches.baseRef}…{branches.headRef}</button> : null}
      >
        {git.repoInfo?.isRepo ? <>
          <div className="git-sidebar-target"><span>Git target</span><code>{git.activeRepoRoot || 'Workspace repo'}</code></div>
          <BranchesNavigatorView
            localRows={branches.localRows}
            remoteRows={branches.remoteRows}
            stashRows={branches.stashRows}
            workingTreeDirty={branches.workingTreeDirty}
            loading={branches.loading}
            error={branches.error}
            onCreateBranch={branches.createBranch}
            onOpenStash={branches.openStash}
          />
          <div className="git-sidebar-ref-picker"><span>Compare refs</span><button type="button" onClick={branches.openBasePicker}>{branches.baseRef}</button><span>…</span><button type="button" onClick={branches.openHeadPicker}>{branches.headRef}</button></div>
        </> : null}
      </WorkspaceSidebarPanelShell>
      <StashDialog
        open={branches.stashOpen}
        message={branches.stashMessage}
        includeUntracked={branches.includeUntracked}
        onMessageChange={branches.setStashMessage}
        onIncludeUntrackedChange={branches.setIncludeUntracked}
        onSave={branches.saveStash}
        onClose={branches.closeStash}
      />
    </>
  )
}

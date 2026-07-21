import type { BranchInfo, ChangeType, RepoInfo, StashInfo, WorkingStatus } from '../../ipc/types'
import type { GitDiffArea } from '../../state/git'

export type GitChangeListArea = GitDiffArea | 'remote'

export type GitRowAction = {
  id: string
  label: string
  danger?: boolean
  onClick: () => void
}

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

export type BranchRowAction = { id: string; label: string; danger?: boolean; onClick: () => void }
export type BranchRowView = { branch: BranchInfo; actions: BranchRowAction[] }
export type StashRowView = {
  stash: StashInfo
  onApply: () => void
  onPop: () => void
  onDrop: () => void
}

export type SourceControlPrimaryAction = {
  id: 'review-conflicts' | 'continue' | 'stage-all' | 'enter-message' | 'commit' | 'pull' | 'push' | 'up-to-date'
  label: string
  disabled: boolean
}

export function sourceControlPrimaryAction(
  repoInfo: RepoInfo,
  status: WorkingStatus,
  commitMessage: string,
  canContinue: boolean,
): SourceControlPrimaryAction {
  if (repoInfo.state !== 'clean' || status.conflicted.length > 0) {
    return canContinue
      ? { id: 'continue', label: 'Continue', disabled: false }
      : { id: 'review-conflicts', label: 'Review conflicts', disabled: false }
  }

  const stageable = [...status.unstaged, ...status.untracked]
    .some((entry) => !entry.repoKind || (entry.repoKind === 'submodule' && Boolean(entry.submoduleState?.commitChanged)))
  if (status.staged.length === 0 && stageable) return { id: 'stage-all', label: 'Stage All', disabled: false }
  if (status.staged.length > 0 && !commitMessage.trim()) return { id: 'enter-message', label: 'Enter commit message', disabled: true }
  if (status.staged.length > 0) return { id: 'commit', label: 'Commit', disabled: false }
  if (repoInfo.behind > 0) return { id: 'pull', label: 'Pull', disabled: false }
  if (repoInfo.ahead > 0) return { id: 'push', label: 'Push', disabled: false }
  return { id: 'up-to-date', label: 'Up to date', disabled: true }
}

import type { GitChangeGroup, GitChangeItem } from './gitWorkspaceModel'

/**
 * One flat row of the Source Control change list: either a group header or a
 * single change. Keeping headers in the same list lets the whole list be
 * virtualized as one scroller instead of one scroller per group.
 */
export type GitChangeListRow =
  | { kind: 'header'; key: string; group: GitChangeGroup }
  | { kind: 'item'; key: string; item: GitChangeItem; untracked: boolean }

/** Must match `.git-sidebar-change-group-header` / `.git-sidebar-change-row` CSS. */
export const gitChangeHeaderHeight = 25
export const gitChangeItemHeight = 29

export function flattenGitChangeRows(groups: readonly GitChangeGroup[]): GitChangeListRow[] {
  const rows: GitChangeListRow[] = []
  for (const group of groups) {
    if (group.count <= 0) continue
    rows.push({ kind: 'header', key: `header:${group.id}`, group })
    for (const item of group.items) {
      rows.push({ kind: 'item', key: `${item.area}:${item.path}`, item, untracked: group.id === 'untracked' })
    }
  }
  return rows
}

export function gitChangeRowHeight(row: GitChangeListRow | undefined): number {
  return row?.kind === 'header' ? gitChangeHeaderHeight : gitChangeItemHeight
}

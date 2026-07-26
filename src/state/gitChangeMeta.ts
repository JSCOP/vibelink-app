import type { ChangeType } from '../ipc/types'

/**
 * The one description of a Git change type shared by every surface that labels
 * a changed path: the Source Control sidebar, the Explorer tree badges, and the
 * shared diff pane file list. Keeping letters and words in a single place stops
 * the same state from reading as `?` in one panel and `U` in another.
 */
export type GitChangeMeta = {
  letter: string
  word: string
  explanation: string
}

export const gitChangeMeta: Record<ChangeType, GitChangeMeta> = {
  added: { letter: 'A', word: 'Added', explanation: 'new tracked file' },
  modified: { letter: 'M', word: 'Modified', explanation: 'tracked file content changed' },
  deleted: { letter: 'D', word: 'Deleted', explanation: 'tracked file removed' },
  renamed: { letter: 'R', word: 'Renamed', explanation: 'tracked file moved or renamed' },
  copied: { letter: 'C', word: 'Copied', explanation: 'tracked file copied' },
  typeChanged: { letter: 'T', word: 'Type changed', explanation: 'file type or mode changed' },
  untracked: { letter: 'U', word: 'Untracked', explanation: 'new file Git is not tracking yet' },
}

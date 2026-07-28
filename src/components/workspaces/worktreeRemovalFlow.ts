import type { WorktreeBlocker, WorktreeBlockerKind, WorktreeRemovalPreflight, WorktreeRemovalResult } from '../../ipc/worktrees'
import { choiceDialog, confirmDialog } from '../appDialogStore'

export type WorktreeRemovalTarget = {
  worktreeId: string
  branch: string
  worktreePath: string
  displayName: string
}

export type WorktreeRemovalFlowDeps = {
  preflight: (worktreeId: string, deleteBranch: boolean) => Promise<WorktreeRemovalPreflight>
  execute: (options: { deleteBranch: boolean; acknowledgedBlockers: WorktreeBlockerKind[] }) => Promise<WorktreeRemovalResult>
}

function blockerLines(blockers: WorktreeBlocker[]): string {
  return blockers.map((blocker) => blocker.message).join(' ')
}

function sortedKinds(blockers: WorktreeBlocker[]): WorktreeBlockerKind[] {
  return blockers.map((blocker) => blocker.kind).sort()
}

/**
 * Two-phase removal shared by the sidebar and the manage dialog.
 *
 * The user acknowledges an exact blocker set. Right before execution the
 * preflight is recomputed, and if a blocker appeared that was not in that set
 * the removal is refused rather than silently re-acknowledged — a checkout that
 * turned dirty while the confirmation was open must never be force-removed on
 * the strength of an older consent. Hard blockers abort at both phases; `force`
 * never bypasses them.
 *
 * Resolves `null` when the user cancelled at any prompt.
 */
export async function runWorktreeRemovalFlow(
  target: WorktreeRemovalTarget,
  deps: WorktreeRemovalFlowDeps,
): Promise<WorktreeRemovalResult | null> {
  const initial = await deps.preflight(target.worktreeId, false)
  const initialHard = initial.blockers.find((blocker) => blocker.hard)
  if (initialHard) throw new Error(initialHard.message)

  const choice = await choiceDialog({
    title: `Remove ${target.displayName} worktree`,
    message: `Choose whether to preserve the local branch after removing "${target.worktreePath}".`,
    choices: [
      { id: 'checkout', label: 'Remove checkout', tone: 'danger' },
      { id: 'checkout-and-branch', label: 'Remove checkout and branch', tone: 'danger' },
    ],
    cancelLabel: 'Cancel',
  })
  if (!choice) return null
  const deleteBranch = choice === 'checkout-and-branch'

  const reviewed = await deps.preflight(target.worktreeId, deleteBranch)
  const reviewedHard = reviewed.blockers.find((blocker) => blocker.hard)
  if (reviewedHard) throw new Error(reviewedHard.message)
  const forceable = reviewed.blockers.filter((blocker) => !blocker.hard)
  if (forceable.length > 0) {
    const warnings = reviewed.warnings.length > 0 ? ` ${reviewed.warnings.join(' ')}` : ''
    const confirmed = await confirmDialog({
      title: 'Force worktree removal',
      message: `${blockerLines(forceable)}${warnings} Continue and acknowledge these blockers?`,
      confirmLabel: 'Force remove',
    })
    if (!confirmed) return null
  }
  const acknowledgedBlockers = sortedKinds(forceable)

  // Last-moment recheck against the exact acknowledged set.
  const final = await deps.preflight(target.worktreeId, deleteBranch)
  const finalHard = final.blockers.find((blocker) => blocker.hard)
  if (finalHard) throw new Error(finalHard.message)
  const acknowledged = new Set(acknowledgedBlockers)
  const unacknowledged = final.blockers.filter((blocker) => !acknowledged.has(blocker.kind))
  if (unacknowledged.length > 0) {
    throw new Error(`The worktree changed while you were confirming, so removal was not attempted: ${blockerLines(unacknowledged)} Review and confirm again.`)
  }

  return deps.execute({ deleteBranch, acknowledgedBlockers })
}

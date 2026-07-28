import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRightLeft, Download, FolderGit2, FolderOpen, GitBranch, RefreshCw, Trash2, X } from 'lucide-react'
import type { SessionMeta } from '../../ipc/types'
import type { WorktreeProjection, WorktreeReconcileState, WorktreeRecord } from '../../ipc/worktrees'
import { useWorkspaceStore } from '../../state/store'
import { projectionLabel, worktreePathOf } from '../../state/worktrees'
import { promptDialog } from '../appDialogStore'
import { runWorktreeRemovalFlow } from './worktreeRemovalFlow'

export type WorktreeManageDialogProps = {
  sourceSession: SessionMeta
  onClose: () => void
}

const stateDescriptions: Record<WorktreeReconcileState, string> = {
  managed: 'Tracked by VibeLink',
  external: 'Registered with Git but not imported into VibeLink',
  missing: 'Registered in VibeLink but the checkout directory is gone',
  stale: 'The directory exists but Git no longer registers it as a worktree',
  conflicted: 'Repository, path, and Git directory identity disagree',
  untrusted: 'Identity could not be resolved; shown read-only',
}

// A state whose checkout cannot be trusted for a destructive action.
const unresolvedStates: Record<WorktreeReconcileState, true | undefined> = {
  managed: undefined,
  external: undefined,
  missing: undefined,
  stale: undefined,
  conflicted: true,
  untrusted: true,
}

export function WorktreeManageDialog({ sourceSession, onClose }: WorktreeManageDialogProps) {
  const reconcileRepositoryWorktrees = useWorkspaceStore((state) => state.reconcileRepositoryWorktrees)
  const importExternalWorktree = useWorkspaceStore((state) => state.importExternalWorktree)
  const preflightWorktreeRemoval = useWorkspaceStore((state) => state.preflightWorktreeRemoval)
  const removeWorktreeById = useWorkspaceStore((state) => state.removeWorktreeById)
  const moveWorktreeSession = useWorkspaceStore((state) => state.moveWorktreeSession)
  const workspaceFolder = sourceSession.workspaceFolder?.trim() ?? ''
  const [entries, setEntries] = useState<WorktreeProjection[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Outcome the user must read even though nothing failed, e.g. a checkout that
  // was removed while its branch was deliberately preserved.
  const [notice, setNotice] = useState<string | null>(null)
  const requestRef = useRef(0)
  const busyRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      if (!workspaceFolder) throw new Error('A repository workspace folder is required to manage worktrees.')
      const next = await reconcileRepositoryWorktrees(workspaceFolder)
      if (requestRef.current === requestId) setEntries(next)
    } catch (caught) {
      if (requestRef.current === requestId) setError(String(caught))
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [reconcileRepositoryWorktrees, workspaceFolder])

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0)
    return () => {
      window.clearTimeout(timer)
      requestRef.current += 1
    }
  }, [refresh])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || busyRef.current) return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const runBusy = async (key: string, action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = key
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await action()
    } catch (caught) {
      setError(String(caught))
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  // Import is an explicit, separate action. Reveal/move/remove never import an
  // external checkout as a side effect: adopting a checkout into the registry
  // is a decision the user makes, not a consequence of clicking Remove.
  const managedRecord = (entry: WorktreeProjection): WorktreeRecord => {
    if (!entry.record) throw new Error('Import this external checkout before managing it from VibeLink.')
    if (unresolvedStates[entry.state]) throw new Error(`This checkout is ${entry.state}: ${stateDescriptions[entry.state]}. Resolve its identity before managing it.`)
    return entry.record
  }

  const importEntry = (entry: WorktreeProjection) => {
    void runBusy(`import:${entry.id}`, async () => {
      const worktreePath = worktreePathOf(entry)
      if (!worktreePath) throw new Error('The external checkout has no discoverable path.')
      await importExternalWorktree({ repositoryPath: workspaceFolder, worktreePath, parentSessionId: sourceSession.id })
      await refresh()
    })
  }

  const revealEntry = (entry: WorktreeProjection) => {
    const path = worktreePathOf(entry)
    if (!path) return
    void runBusy(`reveal:${entry.id}`, async () => { await invoke('reveal_path', { path }) })
  }

  const moveEntry = (entry: WorktreeProjection) => {
    void runBusy(`move:${entry.id}`, async () => {
      const record = managedRecord(entry)
      if (!record.sessionId) throw new Error('Only a worktree bound to a workspace can be moved from here.')
      const destinationPath = await promptDialog({
        title: `Move ${record.branch || 'detached'} worktree`,
        message: 'Enter the new absolute destination path.',
        label: 'Destination path',
        defaultValue: record.worktreePath,
        confirmLabel: 'Move',
      })
      if (!destinationPath) return
      await moveWorktreeSession(record.sessionId, destinationPath)
      await refresh()
    })
  }

  const removeEntry = (entry: WorktreeProjection) => {
    void runBusy(`remove:${entry.id}`, async () => {
      const record = managedRecord(entry)
      const result = await runWorktreeRemovalFlow(
        { worktreeId: record.id, branch: record.branch, worktreePath: record.worktreePath, displayName: projectionLabel(entry) },
        {
          preflight: preflightWorktreeRemoval,
          execute: (options) => removeWorktreeById(record.id, options),
        },
      )
      await refresh()
      // Independent branch policy: a preserved branch after a successful
      // checkout removal is reported, never retried as a forced delete. Set
      // after the refresh so the reconcile pass does not clear the notice.
      if (result && !result.branchDeleted && result.branchPreservedReason) {
        setNotice(`Checkout removed. The branch was preserved: ${result.branchPreservedReason}`)
      }
    })
  }

  const actionsDisabled = loading || Boolean(busy)

  return (
    <div className="workspace-create-backdrop worktree-manage-backdrop" role="presentation" onMouseDown={() => { if (!busyRef.current) onClose() }}>
      <section className="workspace-create-dialog worktree-manage-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-manage-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="workspace-create-header">
          <div className="worktree-create-heading"><span className="worktree-create-mark" aria-hidden="true"><FolderGit2 size={17} /></span><h2 id="worktree-manage-title">Manage worktrees</h2></div>
          <button type="button" className="settings-close" title="Close" aria-label="Close worktree manager" disabled={Boolean(busy)} onClick={onClose}><X size={14} aria-hidden="true" /></button>
        </header>
        <div className="worktree-create-source"><GitBranch size={14} aria-hidden="true" /><span><strong>{sourceSession.name}</strong><small title={workspaceFolder || undefined}>{workspaceFolder}</small></span></div>
        <div className="worktree-manage-list" aria-busy={loading || undefined}>
          {error ? <p className="worktree-manage-error" role="alert">{error}</p> : null}
          {notice ? <p className="worktree-manage-note worktree-manage-notice" role="status">{notice}</p> : null}
          {entries.map((entry) => {
            const native = entry.native
            const record = entry.record
            const branchLabel = projectionLabel(entry)
            const path = worktreePathOf(entry)
            const isMain = native?.isMain ?? false
            const importable = Boolean(path) && (!record || !record.sessionId)
            const unresolved = Boolean(unresolvedStates[entry.state])
            const lockReason = record?.lockReason ?? native?.lockReason ?? null
            const prunableReason = record?.prunableReason ?? native?.prunableReason ?? null
            const sessionBound = Boolean(record?.sessionId)
            return (
              <div key={entry.id} className="worktree-manage-row" data-worktree-state={entry.state}>
                <div className="worktree-manage-copy">
                  <div className="worktree-manage-title-line">
                    <strong>{branchLabel}</strong>
                    <span className="worktree-manage-badges">
                      {isMain ? <span className="worktree-manage-badge is-main">main</span> : null}
                      <span className={`worktree-manage-badge${unresolved ? ' is-danger' : entry.state === 'managed' ? '' : ' is-warning'}`} title={stateDescriptions[entry.state]}>{entry.state}</span>
                      {sessionBound ? <span className="worktree-manage-badge">workspace</span> : null}
                      {native?.locked || record?.locked ? <span className="worktree-manage-badge is-warning">locked</span> : null}
                      {native?.prunable || record?.prunable ? <span className="worktree-manage-badge is-warning">prunable</span> : null}
                      {native?.dirty || record?.dirty ? <span className="worktree-manage-badge is-warning">dirty</span> : null}
                      {native?.untracked || record?.untracked ? <span className="worktree-manage-badge is-warning">untracked</span> : null}
                      {native?.hasConflicts || record?.hasConflicts ? <span className="worktree-manage-badge is-danger">conflicts</span> : null}
                    </span>
                  </div>
                  <code className="worktree-manage-path" title={path}>{path}</code>
                  {lockReason ? <p className="worktree-manage-note">Locked: {lockReason}. Run <code>git worktree unlock {path}</code> in the repository to release it.</p> : null}
                  {prunableReason ? <p className="worktree-manage-note">Prunable: {prunableReason}</p> : null}
                  {unresolved ? <p className="worktree-manage-note">{stateDescriptions[entry.state]}</p> : null}
                </div>
                {!isMain ? (
                  <div className="worktree-manage-actions">
                    {importable ? (
                      <button type="button" disabled={actionsDisabled} aria-label={record ? `Bind ${branchLabel} to a VibeLink workspace` : `Import ${branchLabel} into VibeLink`} onClick={() => importEntry(entry)}><Download size={13} aria-hidden="true" />{record ? 'Bind' : 'Import'}</button>
                    ) : null}
                    <button type="button" disabled={actionsDisabled || !(native?.exists ?? record?.exists ?? false)} aria-label={`Reveal ${branchLabel} in File Explorer`} onClick={() => revealEntry(entry)}><FolderOpen size={13} aria-hidden="true" />Reveal</button>
                    <button type="button" disabled={actionsDisabled || !sessionBound || unresolved} aria-label={`Move ${branchLabel} worktree`} onClick={() => moveEntry(entry)}><ArrowRightLeft size={13} aria-hidden="true" />Move</button>
                    <button type="button" className="danger" disabled={actionsDisabled || !record || unresolved} aria-label={`Remove ${branchLabel} worktree`} onClick={() => removeEntry(entry)}><Trash2 size={13} aria-hidden="true" />Remove</button>
                  </div>
                ) : null}
              </div>
            )
          })}
          {!loading && !error && entries.length === 0 ? <p className="worktree-manage-empty">No Git worktrees found.</p> : null}
          {loading && entries.length === 0 ? <p className="worktree-manage-empty">Loading worktrees…</p> : null}
        </div>
        <footer className="workspace-create-footer worktree-manage-footer">
          <span className="worktree-manage-progress">{loading ? 'Refreshing…' : busy ? 'Working…' : `${entries.length} worktree${entries.length === 1 ? '' : 's'}`}</span>
          <div className="workspace-create-footer-actions"><button type="button" disabled={actionsDisabled} onClick={() => void runBusy('refresh', refresh)}><RefreshCw size={13} aria-hidden="true" />Refresh</button><button type="button" className="primary-action" disabled={Boolean(busy)} onClick={onClose}>Close</button></div>
        </footer>
      </section>
    </div>
  )
}

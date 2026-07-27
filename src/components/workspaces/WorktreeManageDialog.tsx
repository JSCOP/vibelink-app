import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowRightLeft, FolderGit2, FolderOpen, GitBranch, GitMerge, RefreshCw, Trash2, X } from 'lucide-react'
import type { BranchInfo, SessionMeta, WorktreeEntry, WorktreeInfo } from '../../ipc/types'
import { useWorkspaceStore } from '../../state/store'
import { choiceDialog, confirmDialog, promptDialog } from '../appDialogStore'

export type WorktreeManageDialogProps = {
  sourceSession: SessionMeta
  onClose: () => void
}

function normalizedWorktreePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function WorktreeManageDialog({ sourceSession, onClose }: WorktreeManageDialogProps) {
  const workspaceWorktrees = useWorkspaceStore((state) => state.settings.workspaceWorktrees)
  const moveWorktreeSession = useWorkspaceStore((state) => state.moveWorktreeSession)
  const removeWorktreeSession = useWorkspaceStore((state) => state.removeWorktreeSession)
  const workspaceFolder = sourceSession.workspaceFolder?.trim() ?? ''
  const [entries, setEntries] = useState<WorktreeEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const requestRef = useRef(0)
  const busyRef = useRef<string | null>(null)
  const sessionIdByPath = useMemo(() => {
    const mapped = new Map<string, string>()
    for (const [sessionId, worktree] of Object.entries(workspaceWorktrees)) {
      const path = normalizedWorktreePath(worktree.worktreePath)
      if (path) mapped.set(path, sessionId)
    }
    return mapped
  }, [workspaceWorktrees])

  const refresh = useCallback(async () => {
    const requestId = ++requestRef.current
    setLoading(true)
    setError(null)
    try {
      if (!workspaceFolder) throw new Error('A repository workspace folder is required to manage worktrees.')
      const next = await invoke<WorktreeEntry[]>('git_worktree_list', { workspaceFolder })
      if (requestRef.current === requestId) setEntries(next)
    } catch (caught) {
      if (requestRef.current === requestId) setError(String(caught))
    } finally {
      if (requestRef.current === requestId) setLoading(false)
    }
  }, [workspaceFolder])

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
    try {
      await action()
    } catch (caught) {
      setError(String(caught))
    } finally {
      busyRef.current = null
      setBusy(null)
    }
  }

  const revealEntry = (entry: WorktreeEntry) => {
    void runBusy(`reveal:${entry.worktreePath}`, async () => {
      await invoke('reveal_path', { path: entry.worktreePath })
    })
  }

  const moveEntry = (entry: WorktreeEntry) => {
    void runBusy(`move:${entry.worktreePath}`, async () => {
      const destinationPath = await promptDialog({
        title: `Move ${entry.branch || 'detached'} worktree`,
        message: 'Enter the new absolute destination path.',
        label: 'Destination path',
        defaultValue: entry.worktreePath,
        confirmLabel: 'Move',
      })
      if (!destinationPath) return
      const sessionId = sessionIdByPath.get(normalizedWorktreePath(entry.worktreePath))
      if (sessionId) await moveWorktreeSession(sessionId, destinationPath)
      else await invoke<WorktreeInfo>('git_worktree_move', { workspaceFolder, worktreePath: entry.worktreePath, destinationPath })
      await refresh()
    })
  }

  const mergeEntry = (entry: WorktreeEntry) => {
    void runBusy(`merge:${entry.worktreePath}`, async () => {
      const branches = await invoke<BranchInfo[]>('git_branches', { workspaceFolder })
      const currentBranch = branches.find((branch) => branch.isHead)?.name ?? 'detached HEAD'
      const confirmed = await confirmDialog({
        title: `Merge ${entry.branch}`,
        message: `Merge source branch "${entry.branch}" into repository branch "${currentBranch}"?`,
        confirmLabel: 'Merge',
      })
      if (!confirmed) return
      await invoke('git_merge', { workspaceFolder, refName: entry.branch })
      await refresh()
    })
  }

  const removeEntry = (entry: WorktreeEntry) => {
    void runBusy(`remove:${entry.worktreePath}`, async () => {
      const choice = await choiceDialog({
        title: `Remove ${entry.branch || 'detached'} worktree`,
        message: entry.dirty
          ? `Uncommitted changes in "${entry.worktreePath}" will be lost. Removal uses force.`
          : `Remove the checkout at "${entry.worktreePath}"?`,
        choices: [
          { id: 'checkout', label: 'Remove checkout', tone: 'danger' },
          { id: 'checkout-and-branch', label: 'Remove checkout and branch', tone: 'danger' },
        ],
        cancelLabel: 'Cancel',
      })
      if (!choice) return
      const deleteBranch = choice === 'checkout-and-branch'
      const sessionId = sessionIdByPath.get(normalizedWorktreePath(entry.worktreePath))
      if (sessionId) await removeWorktreeSession(sessionId, { deleteBranch, force: entry.dirty })
      else await invoke('git_worktree_remove', {
        workspaceFolder,
        worktreePath: entry.worktreePath,
        branch: entry.branch,
        force: entry.dirty,
        deleteBranch,
      })
      await refresh()
    })
  }

  const actionsDisabled = loading || Boolean(busy)

  return (
    <div className="workspace-create-backdrop worktree-manage-backdrop" role="presentation" onMouseDown={() => { if (!busyRef.current) onClose() }}>
      <section className="workspace-create-dialog worktree-manage-dialog" role="dialog" aria-modal="true" aria-labelledby="worktree-manage-title" onMouseDown={(event) => event.stopPropagation()}>
        <header className="workspace-create-header">
          <div className="worktree-create-heading">
            <span className="worktree-create-mark" aria-hidden="true"><FolderGit2 size={17} /></span>
            <h2 id="worktree-manage-title">Manage worktrees</h2>
          </div>
          <button type="button" className="settings-close" title="Close" aria-label="Close worktree manager" disabled={Boolean(busy)} onClick={onClose}>
            <X size={14} aria-hidden="true" />
          </button>
        </header>

        <div className="worktree-create-source">
          <GitBranch size={14} aria-hidden="true" />
          <span><strong>{sourceSession.name}</strong><small title={workspaceFolder || undefined}>{workspaceFolder}</small></span>
        </div>

        <div className="worktree-manage-list" aria-busy={loading || undefined}>
          {error ? <p className="worktree-manage-error" role="alert">{error}</p> : null}
          {entries.map((entry) => {
            const branchLabel = entry.branch || 'detached'
            return (
              <div key={`${entry.worktreePath}:${entry.head}`} className="worktree-manage-row">
                <div className="worktree-manage-copy">
                  <div className="worktree-manage-title-line">
                    <strong>{branchLabel}</strong>
                    <span className="worktree-manage-badges">
                      {entry.isMain ? <span className="worktree-manage-badge is-main">main</span> : null}
                      {entry.locked ? <span className="worktree-manage-badge">locked</span> : null}
                      {entry.prunable ? <span className="worktree-manage-badge is-warning">prunable</span> : null}
                      {entry.dirty ? <span className="worktree-manage-badge is-warning">dirty</span> : null}
                      {!entry.exists ? <span className="worktree-manage-badge is-danger">missing</span> : null}
                    </span>
                  </div>
                  <code className="worktree-manage-path" title={entry.worktreePath}>{entry.worktreePath}</code>
                </div>
                {!entry.isMain ? (
                  <div className="worktree-manage-actions">
                    <button type="button" disabled={actionsDisabled || !entry.exists} aria-label={`Reveal ${branchLabel} in File Explorer`} onClick={() => revealEntry(entry)}>
                      <FolderOpen size={13} aria-hidden="true" />Reveal
                    </button>
                    <button type="button" disabled={actionsDisabled} aria-label={`Move ${branchLabel} worktree`} onClick={() => moveEntry(entry)}>
                      <ArrowRightLeft size={13} aria-hidden="true" />Move
                    </button>
                    <button type="button" disabled={actionsDisabled || !entry.branch} aria-label={`Merge ${branchLabel} worktree`} onClick={() => mergeEntry(entry)}>
                      <GitMerge size={13} aria-hidden="true" />Merge
                    </button>
                    <button type="button" className="danger" disabled={actionsDisabled} aria-label={`Remove ${branchLabel} worktree`} onClick={() => removeEntry(entry)}>
                      <Trash2 size={13} aria-hidden="true" />Remove
                    </button>
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
          <div className="workspace-create-footer-actions">
            <button type="button" disabled={actionsDisabled} onClick={() => void runBusy('refresh', refresh)}><RefreshCw size={13} aria-hidden="true" />Refresh</button>
            <button type="button" className="primary-action" disabled={Boolean(busy)} onClick={onClose}>Close</button>
          </div>
        </footer>
      </section>
    </div>
  )
}

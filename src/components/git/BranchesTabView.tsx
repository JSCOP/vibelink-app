import { useState, type ComponentType } from 'react'
import { Archive, ArchiveRestore, ArrowDown, ArrowRightLeft, ArrowUp, Check, ChevronDown, ChevronRight, Copy, GitBranch, GitBranchPlus, GitCompare, GitMerge, Inbox, ListEnd, PackageOpen, Pencil, Trash2, X, type LucideProps } from 'lucide-react'
import type { ChangedFile, FileContents } from '../../ipc/types'
import type { BranchRowView, StashRowView } from './gitWorkspaceModel'
import { DiffPane } from './DiffPane'

export type BranchesNavigatorViewProps = {
  localRows: BranchRowView[]
  remoteRows: BranchRowView[]
  stashRows: StashRowView[]
  workingTreeDirty: boolean
  loading: boolean
  error: string | null
  onCreateBranch: () => void
  onOpenStash: () => void
}

export type BranchCompareDetailViewProps = {
  baseRef: string
  headRef: string
  compareFiles: ChangedFile[]
  selectedPath: string | null
  contents: FileContents | null
  loading: boolean
  error: string | null
  onOpenBasePicker: () => void
  onOpenHeadPicker: () => void
  onCompare: () => void
  onSelectFile: (path: string) => void
}

export type StashDialogProps = {
  open: boolean
  message: string
  includeUntracked: boolean
  onMessageChange: (value: string) => void
  onIncludeUntrackedChange: (value: boolean) => void
  onSave: () => void
  onClose: () => void
}

export function BranchesNavigatorView({ localRows, remoteRows, stashRows, workingTreeDirty, loading, error, onCreateBranch, onOpenStash }: BranchesNavigatorViewProps) {
  return (
    <div className="git-branches-list-pane git-branches-navigator">
      <header className="git-branches-toolbar"><button type="button" title="Create a new branch" onClick={onCreateBranch}><GitBranchPlus size={13} aria-hidden="true" /> New branch</button></header>
      {error ? <div className="git-window-error">{error}</div> : null}
      {loading && localRows.length + remoteRows.length === 0 ? <div className="git-sidebar-inline-state">Loading branches…</div> : null}
      <div className="git-branches-scroll"><BranchSection title="Local" emptyHint="No local branches yet." rows={localRows} /><BranchSection title="Remotes" emptyHint="No remote branches. Fetch to see remote refs." rows={remoteRows} /></div>
      <section className="git-stash-strip">
        <header className="git-stash-strip-header"><h3><Archive size={12} aria-hidden="true" /> Stashes <span className="git-stash-count">{stashRows.length}</span></h3><button type="button" title={workingTreeDirty ? 'Stash working tree changes' : 'Nothing to stash — working tree is clean'} onClick={onOpenStash} disabled={!workingTreeDirty}><PackageOpen size={13} aria-hidden="true" /> Stash changes</button></header>
        {stashRows.length === 0 ? <p className="git-stash-empty"><Inbox size={12} aria-hidden="true" /> No stashes</p> : stashRows.map(({ stash, onApply, onPop, onDrop }) => (
          <div key={stash.index} className="git-stash-row"><span className="git-stash-index">stash@{'{'}{stash.index}{'}'}</span><strong className="git-stash-message" title={stash.message}>{stash.message}</strong><div className="git-stash-row-actions"><button type="button" title={`Apply stash ${stash.index}`} onClick={onApply}><ArchiveRestore size={12} aria-hidden="true" /> Apply</button><button type="button" title={`Pop stash ${stash.index}`} onClick={onPop}>Pop</button><button type="button" title={`Drop stash ${stash.index}`} data-danger onClick={onDrop}><Trash2 size={12} aria-hidden="true" /><span className="git-branch-action-label">Drop</span></button></div></div>
        ))}
      </section>
    </div>
  )
}

export function BranchCompareDetailView({ baseRef, headRef, compareFiles, selectedPath, contents, loading, error, onOpenBasePicker, onOpenHeadPicker, onCompare, onSelectFile }: BranchCompareDetailViewProps) {
  return (
    <main className="git-branch-compare-pane git-branch-detail-projection">
      <header className="git-branch-compare-picker"><span className="git-branch-compare-caption"><GitCompare size={13} aria-hidden="true" /> Compare</span><button type="button" className="git-branch-ref-button" title="Choose base ref" onClick={onOpenBasePicker}><GitBranch size={12} aria-hidden="true" /><span>{baseRef}</span></button><span className="git-branch-compare-ellipsis" aria-hidden="true">…</span><button type="button" className="git-branch-ref-button" title="Choose head ref" onClick={onOpenHeadPicker}><GitBranch size={12} aria-hidden="true" /><span>{headRef}</span></button><button type="button" className="git-branch-compare-run" title={`Compare ${baseRef}…${headRef}`} onClick={onCompare}><GitCompare size={13} aria-hidden="true" /> Compare</button></header>
      <DiffPane files={compareFiles} selectedPath={selectedPath} onSelect={onSelectFile} contents={contents} loading={loading} splitView error={error} />
    </main>
  )
}

export function StashDialog({ open, message, includeUntracked, onMessageChange, onIncludeUntrackedChange, onSave, onClose }: StashDialogProps) {
  if (!open) return null
  return (
    <div className="git-clone-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="git-stash-dialog" role="dialog" aria-label="Stash changes" onMouseDown={(event) => event.stopPropagation()}>
        <header><h2><Archive size={14} aria-hidden="true" /> Stash changes</h2><button type="button" title="Close" onClick={onClose}><X size={14} aria-hidden="true" /></button></header>
        <label className="git-stash-dialog-field">Message<input autoFocus placeholder="Optional message for this stash" value={message} onChange={(event) => onMessageChange(event.target.value)} /></label>
        <label className="git-stash-dialog-check"><input type="checkbox" checked={includeUntracked} onChange={(event) => onIncludeUntrackedChange(event.target.checked)} /> Include untracked files</label>
        <footer><button type="button" onClick={onClose}>Cancel</button><button type="button" className="git-stash-dialog-save" onClick={onSave}><PackageOpen size={13} aria-hidden="true" /> Stash</button></footer>
      </section>
    </div>
  )
}

const branchActionIcons: Record<string, ComponentType<LucideProps>> = {
  checkout: ArrowRightLeft,
  merge: GitMerge,
  rebase: ListEnd,
  rename: Pencil,
  delete: Trash2,
  copy: Copy,
  'new-from': GitBranchPlus,
}

function BranchSection({ title, emptyHint, rows }: { title: string; emptyHint: string; rows: BranchRowView[] }) {
  const [open, setOpen] = useState(true)
  const Chevron = open ? ChevronDown : ChevronRight
  return (
    <section className="git-branch-section" data-collapsed={!open || undefined}>
      <header className="git-branch-section-header"><button type="button" aria-expanded={open} title={`${open ? 'Collapse' : 'Expand'} ${title.toLowerCase()} branches`} onClick={() => setOpen((value) => !value)}><Chevron size={13} aria-hidden="true" /></button><h3>{title} <span className="git-branch-section-count">{rows.length}</span></h3></header>
      {open ? rows.length === 0 ? <p className="git-branch-section-empty">{emptyHint}</p> : rows.map(({ branch, actions }) => (
        <div key={`${branch.isRemote ? 'remote' : 'local'}:${branch.name}`} className="git-branch-row" data-head={branch.isHead || undefined}><GitBranch size={13} aria-hidden="true" className="git-branch-row-icon" /><span className="git-branch-row-main"><span className="git-branch-row-title"><strong>{branch.name}</strong>{branch.isHead ? <span className="git-branch-head-chip"><Check size={10} aria-hidden="true" /> HEAD</span> : null}</span><small>{branch.lastCommitSubject}{branch.lastCommitDate ? ` · ${new Date(branch.lastCommitDate).toLocaleDateString()}` : ''}</small></span>{branch.ahead ? <em className="git-branch-sync-chip" data-dir="ahead" title={`${branch.ahead} commits ahead`}><ArrowUp size={10} aria-hidden="true" />{branch.ahead}</em> : null}{branch.behind ? <em className="git-branch-sync-chip" data-dir="behind" title={`${branch.behind} commits behind`}><ArrowDown size={10} aria-hidden="true" />{branch.behind}</em> : null}<div className="git-branch-row-actions">{actions.map((action) => {
          const Icon = branchActionIcons[action.id]
          return <button key={action.id} type="button" title={`${action.label} ${branch.name}`} data-danger={action.danger || undefined} onClick={action.onClick}>{Icon ? <Icon size={13} strokeWidth={1.9} aria-hidden="true" /> : null}<span className="git-branch-action-label">{action.label}</span></button>
        })}</div></div>
      )) : null}
    </section>
  )
}

import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { AlertTriangle, ArrowRight, Check, ChevronDown, ChevronRight, Copy, File, FileMinus2, FilePlus2, Folder, FolderGit2, FolderOpen, GitCommit, GitFork, Link2, LoaderCircle, PanelRightClose, PanelRightOpen, Pencil, RefreshCw } from 'lucide-react'
import type { ChangeType } from '../../ipc/types'
import type { ExplorerChangeSummary, ExplorerGitDecoration, ExplorerNode } from '../../state/explorer'
import type { GitStatusPresentation } from '../../state/profiles'
import './ExplorerTreeView.css'

export type ExplorerContextAction = { id: string; label: string; disabled?: boolean; danger?: boolean; onClick: () => void }
export type ExplorerContextMenu = { x: number; y: number; path: string; actions: ExplorerContextAction[] } | null

export type ExplorerTreeViewProps = {
  nodes: ExplorerNode[]
  selectedPath: string | null
  loading: boolean
  error: string | null
  statusSummary: ExplorerChangeSummary | null
  statusPresentation: GitStatusPresentation
  previewVisible: boolean
  onTogglePreview: () => void
  treeId?: string
  workspaceLabel?: string
  workspacePath?: string
  repositoryLabel?: string
  renamingPath: string | null
  renameValue: string
  contextMenu: ExplorerContextMenu
  dragOverPath: string | null
  onSelect: (node: ExplorerNode) => void
  onOpen: (node: ExplorerNode) => void
  onToggle: (node: ExplorerNode) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => void
  onRenameValueChange: (value: string) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onContextMenu: (event: React.MouseEvent, node: ExplorerNode) => void
  onCloseContextMenu: () => void
  onDragStart: (node: ExplorerNode) => void
  onDragOver: (event: React.DragEvent, node: ExplorerNode) => void
  onDragLeave: () => void
  onDrop: (event: React.DragEvent, node: ExplorerNode) => void
}

export function ExplorerTreeView({ nodes, selectedPath, loading, error, statusSummary, statusPresentation, previewVisible, onTogglePreview, treeId = 'explorer-tree', workspaceLabel = 'Workspace', workspacePath, repositoryLabel = 'Workspace root', renamingPath, renameValue, contextMenu, dragOverPath, onSelect, onOpen, onToggle, onKeyDown, onRenameValueChange, onCommitRename, onCancelRename, onContextMenu, onCloseContextMenu, onDragStart, onDragOver, onDragLeave, onDrop }: ExplorerTreeViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const domTreeId = useMemo(() => stableDomId(treeId), [treeId])
  const rowIds = useMemo(() => new Map(nodes.map((node) => [node.path, `${domTreeId}-row-${stableDomId(node.path)}`])), [domTreeId, nodes])
  const siblingMetadata = useMemo(() => {
    const totals = new Map<string, number>()
    const positions = new Map<string, number>()
    for (const node of nodes) totals.set(node.parentPath, (totals.get(node.parentPath) ?? 0) + 1)
    const seen = new Map<string, number>()
    for (const node of nodes) {
      const position = (seen.get(node.parentPath) ?? 0) + 1
      seen.set(node.parentPath, position)
      positions.set(node.path, position)
    }
    return { positions, totals }
  }, [nodes])
  // TanStack Virtual intentionally exposes non-memoizable functions; this component is not compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: nodes.length, getScrollElement: () => scrollRef.current, estimateSize: () => 24, overscan: 20 })
  const virtualItems = virtualizer.getVirtualItems()
  const rows = virtualItems.length > 0 ? virtualItems : nodes.map((_, index) => ({ index, key: index, start: index * 24, size: 24, end: (index + 1) * 24, lane: 0 }))
  const contextPosition = contextMenu ? clampMenuPosition(contextMenu.x, contextMenu.y, contextMenu.actions.length) : null
  const activeDescendant = selectedPath ? rowIds.get(selectedPath) : undefined

  useEffect(() => {
    if (!selectedPath) return
    const index = nodes.findIndex((node) => node.path === selectedPath)
    if (index >= 0) virtualizer.scrollToIndex(index, { align: 'auto' })
  }, [nodes, selectedPath, virtualizer])

  const focusTree = () => scrollRef.current?.focus({ preventScroll: true })

  return (
    <aside className="explorer-tree-pane" data-explorer-tree="true">
      <header>
        <div className="explorer-tree-titlebar">
          <strong>EXPLORER</strong>
          <span className="explorer-tree-header-spacer" />
          {statusSummary ? <ChangeSummaryBadges summary={statusSummary} presentation={statusPresentation} compact /> : null}
          {loading ? <LoaderCircle className="spin" size={13} /> : null}
          <button type="button" className="explorer-preview-toggle" title={previewVisible ? 'Hide file preview' : 'Show file preview'} aria-label={previewVisible ? 'Hide file preview' : 'Show file preview'} aria-pressed={previewVisible} onClick={onTogglePreview}>
            {previewVisible ? <PanelRightClose size={13} aria-hidden="true" /> : <PanelRightOpen size={13} aria-hidden="true" />}
          </button>
        </div>
        <div className="explorer-tree-context" aria-label={`Workspace ${workspaceLabel}; Git repository ${repositoryLabel}`}>
          <span title={workspacePath ?? workspaceLabel}><b>Workspace</b><span>{workspaceLabel}</span></span>
          <span title={`Git repository: ${repositoryLabel}`}><b>Git</b><span>{repositoryLabel}</span></span>
        </div>
      </header>
      {error ? <div className="explorer-error" role="alert">{error}</div> : null}
      <div
        id={domTreeId}
        ref={scrollRef}
        className="explorer-tree-scroll"
        role="tree"
        aria-label={`Files in ${workspaceLabel}`}
        aria-activedescendant={activeDescendant}
        aria-busy={loading}
        tabIndex={0}
        onKeyDown={onKeyDown}
      >
        <div className="explorer-tree-virtual" style={{ height: `${virtualizer.getTotalSize() || nodes.length * 24}px` }}>
          {rows.map((virtualRow) => {
            const node = nodes[virtualRow.index]
            if (!node) return null
            const Icon = node.entry.isSymlink ? Link2 : node.entry.repoKind ? FolderGit2 : node.entry.isDir ? (node.expanded ? FolderOpen : Folder) : File
            return (
              <div
                id={rowIds.get(node.path)}
                key={node.path}
                className="explorer-tree-row"
                role="treeitem"
                aria-level={node.depth + 1}
                aria-posinset={siblingMetadata.positions.get(node.path)}
                aria-setsize={siblingMetadata.totals.get(node.parentPath)}
                aria-expanded={node.entry.isDir ? node.expanded : undefined}
                aria-selected={selectedPath === node.path}
                data-selected={selectedPath === node.path || undefined}
                data-explorer-path={node.path}
                data-ignored={node.ignored || undefined}
                data-drag-over={dragOverPath === node.path || undefined}
                data-git-state={node.decoration?.conflicted ? 'conflicted' : node.decoration?.unstaged ? 'unstaged' : node.decoration?.untracked ? 'untracked' : node.decoration?.staged ? 'staged' : undefined}
                data-git-only={node.gitOnly || undefined}
                data-repository-kind={node.entry.repoKind ?? undefined}
                data-repository-initialized={node.entry.repositoryInitialized === false ? 'false' : undefined}
                draggable={!node.gitOnly && !node.entry.repoKind}
                style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)`, '--explorer-depth': node.depth } as React.CSSProperties}
                onClick={() => { focusTree(); onSelect(node) }}
                onDoubleClick={() => { focusTree(); if (node.entry.isDir) onToggle(node); else onOpen(node) }}
                onContextMenu={(event) => { focusTree(); onContextMenu(event, node) }}
                onDragStart={() => onDragStart(node)}
                onDragOver={(event) => onDragOver(event, node)}
                onDragLeave={onDragLeave}
                onDrop={(event) => onDrop(event, node)}
              >
                {node.entry.isDir ? <button type="button" className="explorer-tree-twisty" tabIndex={-1} aria-label={node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`} onClick={(event) => { event.stopPropagation(); focusTree(); onToggle(node) }}>{node.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="explorer-tree-indent" />}
                <Icon className="explorer-tree-icon" size={14} aria-hidden="true" />
                {renamingPath === node.path ? (
                  <input className="explorer-tree-rename" aria-label={`Rename ${node.name}`} autoFocus value={renameValue} onChange={(event) => onRenameValueChange(event.target.value)} onBlur={onCommitRename} onKeyDown={(event) => { event.stopPropagation(); if (event.key === 'Enter') onCommitRename(); if (event.key === 'Escape') onCancelRename() }} />
                ) : <span className="explorer-tree-name">{node.name}</span>}
                {node.repositoryRef ? <span className="explorer-repository-ref" title={`Checked out ${node.repositoryRef}`}>{node.repositoryRef}</span> : null}
                {node.entry.repoKind ? <RepositoryBadges node={node} presentation={statusPresentation} /> : null}
                {node.changeSummary ? <ChangeSummaryBadges summary={node.changeSummary} presentation={statusPresentation} /> : null}
                {node.decoration ? <DecorationBadges decoration={node.decoration} presentation={statusPresentation} /> : null}
              </div>
            )
          })}
        </div>
      </div>
      {nodes.length === 0 && !loading ? <div className="explorer-empty">This folder is empty.</div> : null}
      {contextMenu && contextPosition ? createPortal(
        <>
          <div className="terminal-context-backdrop" onMouseDown={onCloseContextMenu} onContextMenu={(event) => { event.preventDefault(); onCloseContextMenu() }} />
          <div className="terminal-context-menu explorer-context-menu" role="menu" aria-label={`Actions for ${contextMenu.path}`} style={{ left: contextPosition.x, top: contextPosition.y }}>
            {contextMenu.actions.map((action) => <button key={action.id} type="button" role="menuitem" disabled={action.disabled} data-danger={action.danger || undefined} onClick={action.onClick}>{action.label}</button>)}
          </div>
        </>,
        document.body,
      ) : null}
    </aside>
  )
}

function stableDomId(value: string): string {
  if (!value) return 'root'
  return Array.from(value, (character) => character.codePointAt(0)?.toString(16) ?? '0').join('-')
}

type ChangeBadgeMeta = {
  letter: string
  word: string
  explanation: string
  icon: typeof Check
}

type StatusBadgeSpec = {
  area: string
  letter: string
  word: string
  title: string
  icon: typeof Check
  changeType?: ChangeType
}

const CHANGE_META_BY_TYPE: Record<ChangeType, ChangeBadgeMeta> = {
  added: { letter: 'A', word: 'Added', explanation: 'new tracked file', icon: FilePlus2 },
  modified: { letter: 'M', word: 'Modified', explanation: 'tracked file content changed', icon: Pencil },
  deleted: { letter: 'D', word: 'Deleted', explanation: 'tracked file removed', icon: FileMinus2 },
  renamed: { letter: 'R', word: 'Renamed', explanation: 'tracked file moved or renamed', icon: ArrowRight },
  copied: { letter: 'C', word: 'Copied', explanation: 'tracked file copied', icon: Copy },
  typeChanged: { letter: 'T', word: 'Type changed', explanation: 'file type or mode changed', icon: RefreshCw },
  untracked: { letter: 'U', word: 'Untracked', explanation: 'new file Git is not tracking yet', icon: FilePlus2 },
}

const CONFLICT_SPEC: StatusBadgeSpec = { area: 'conflicted', letter: '!', word: 'Conflict', title: 'Conflict — Git needs you to choose or combine competing changes.', icon: AlertTriangle }
const POINTER_SPEC: StatusBadgeSpec = { area: 'submodule-pointer', letter: 'P', word: 'Pointer', title: 'Pointer changed — the parent repository now points to a different submodule commit.', icon: GitCommit }
const SUBMODULE_MODIFIED_SPEC: StatusBadgeSpec = { area: 'submodule-modified', letter: 'M', word: 'Modified', title: 'Modified inside submodule — tracked files changed in the child repository.', icon: Pencil }
const SUBMODULE_UNTRACKED_SPEC: StatusBadgeSpec = { area: 'submodule-untracked', letter: 'U', word: 'Untracked', title: 'Untracked inside submodule — the child repository contains files Git is not tracking.', icon: FilePlus2 }
const UNTRACKED_SPEC: StatusBadgeSpec = { area: 'untracked', letter: 'U', word: 'Untracked', title: 'Untracked — new file Git is not tracking yet.', icon: FilePlus2, changeType: 'untracked' }

function DecorationBadges({ decoration, presentation }: { decoration: ExplorerGitDecoration; presentation: GitStatusPresentation }) {
  if (decoration.conflicted) return <span className="explorer-git-badges"><StatusBadge spec={CONFLICT_SPEC} presentation={presentation} /></span>
  const submodule = decoration.repoKind === 'submodule' ? decoration.submoduleState : null
  const stagedSpec = decoration.staged ? changeSpec(decoration.staged, true) : null
  const unstagedSpec = decoration.unstaged ? changeSpec(decoration.unstaged, false) : null
  return (
    <span className="explorer-git-badges">
      {stagedSpec ? <StatusBadge spec={stagedSpec} presentation={presentation} /> : null}
      {submodule?.commitChanged ? <StatusBadge spec={POINTER_SPEC} presentation={presentation} /> : null}
      {submodule?.modified ? <StatusBadge spec={SUBMODULE_MODIFIED_SPEC} presentation={presentation} /> : null}
      {submodule?.untracked ? <StatusBadge spec={SUBMODULE_UNTRACKED_SPEC} presentation={presentation} /> : null}
      {!submodule && unstagedSpec ? <StatusBadge spec={unstagedSpec} presentation={presentation} /> : null}
      {decoration.untracked ? <StatusBadge spec={UNTRACKED_SPEC} presentation={presentation} /> : null}
    </span>
  )
}

function RepositoryBadges({ node, presentation }: { node: ExplorerNode; presentation: GitStatusPresentation }) {
  const isSubmodule = node.entry.repoKind === 'submodule'
  const Icon = isSubmodule ? GitFork : FolderGit2
  const title = isSubmodule ? 'Submodule — a separate Git repository recorded by the parent repository.' : 'Repository — a separate nested Git repository.'
  return (
    <span className="explorer-repository-badges">
      <em data-kind={node.entry.repoKind} data-presentation={presentation} title={title} aria-label={title}>
        {presentation === 'icons' ? <Icon size={11} aria-hidden="true" /> : presentation === 'letters' ? (isSubmodule ? 'SUB' : 'REPO') : (isSubmodule ? 'Submodule' : 'Repository')}
      </em>
      {node.entry.repositoryInitialized === false ? (
        <em data-state="uninitialized" data-presentation={presentation} title="Not initialized — download and check out the submodule before opening it." aria-label="Submodule is not initialized">
          {presentation === 'icons' ? <AlertTriangle size={11} aria-hidden="true" /> : presentation === 'letters' ? 'INIT' : 'Not initialized'}
        </em>
      ) : null}
    </span>
  )
}

function ChangeSummaryBadges({ summary, presentation, compact = false }: { summary: ExplorerChangeSummary; presentation: GitStatusPresentation; compact?: boolean }) {
  const title = `${summary.total} changed path${summary.total === 1 ? '' : 's'}: ${summary.conflicted} conflicted, ${summary.staged} staged, ${summary.unstaged} modified, ${summary.untracked} untracked`
  if (compact && presentation === 'words') {
    return <span className="explorer-change-summary" title={title} aria-label={title} data-compact="true"><em data-area="dirty" data-presentation="words">Dirty {summary.total}</em></span>
  }
  return (
    <span className="explorer-change-summary" title={title} aria-label={title} data-compact={compact || undefined}>
      {summary.conflicted ? <StatusBadge spec={{ ...CONFLICT_SPEC, word: 'Conflicts', title }} presentation={presentation} count={summary.conflicted} /> : null}
      {summary.staged ? <StatusBadge spec={{ area: 'staged', letter: 'S', word: 'Staged', title, icon: Check }} presentation={presentation} count={summary.staged} /> : null}
      {summary.unstaged ? <StatusBadge spec={{ area: 'unstaged', letter: 'M', word: 'Modified', title, icon: Pencil }} presentation={presentation} count={summary.unstaged} /> : null}
      {summary.untracked ? <StatusBadge spec={{ ...UNTRACKED_SPEC, title }} presentation={presentation} count={summary.untracked} /> : null}
    </span>
  )
}

function StatusBadge({ spec, presentation, count }: { spec: StatusBadgeSpec; presentation: GitStatusPresentation; count?: number }) {
  const Icon = spec.icon
  const word = count === undefined ? spec.word : `${spec.word} ${count}`
  const ariaLabel = count === undefined ? spec.title : `${word}. ${spec.title}`
  return (
    <em className="explorer-tree-badge" data-area={spec.area} data-change-type={spec.changeType} data-presentation={presentation} title={spec.title} aria-label={ariaLabel}>
      {presentation === 'icons' ? <><Icon size={11} aria-hidden="true" />{count}</> : presentation === 'letters' ? `${spec.letter}${count ?? ''}` : word}
    </em>
  )
}

function changeSpec(changeType: ChangeType, staged: boolean): StatusBadgeSpec {
  const meta = CHANGE_META_BY_TYPE[changeType]
  return {
    area: staged ? 'staged' : 'unstaged',
    letter: meta.letter,
    word: staged ? `Staged ${meta.word}` : meta.word,
    title: staged
      ? `Staged ${meta.word.toLowerCase()} — ${meta.explanation}; included in the next commit.`
      : `${meta.word} — ${meta.explanation}; not staged for the next commit.`,
    icon: meta.icon,
    changeType,
  }
}

function clampMenuPosition(x: number, y: number, actionCount: number): { x: number; y: number } {
  const margin = 8
  const width = 240
  const height = Math.min(actionCount * 30 + 10, Math.max(30, window.innerHeight - margin * 2))
  return {
    x: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
    y: Math.max(margin, Math.min(y, window.innerHeight - height - margin)),
  }
}

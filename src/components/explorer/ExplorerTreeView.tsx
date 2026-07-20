import { useRef } from 'react'
import { createPortal } from 'react-dom'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, File, Folder, FolderGit2, FolderOpen, Link2, LoaderCircle } from 'lucide-react'
import type { ChangeType } from '../../ipc/types'
import type { ExplorerChangeSummary, ExplorerGitDecoration, ExplorerNode } from '../../state/explorer'
import './ExplorerTreeView.css'

export type ExplorerContextAction = { id: string; label: string; disabled?: boolean; danger?: boolean; onClick: () => void }
export type ExplorerContextMenu = { x: number; y: number; path: string; actions: ExplorerContextAction[] } | null

export type ExplorerTreeViewProps = {
  nodes: ExplorerNode[]
  selectedPath: string | null
  loading: boolean
  error: string | null
  statusSummary: ExplorerChangeSummary | null
  renamingPath: string | null
  renameValue: string
  contextMenu: ExplorerContextMenu
  dragOverPath: string | null
  onSelect: (node: ExplorerNode) => void
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

export function ExplorerTreeView({ nodes, selectedPath, loading, error, statusSummary, renamingPath, renameValue, contextMenu, dragOverPath, onSelect, onToggle, onKeyDown, onRenameValueChange, onCommitRename, onCancelRename, onContextMenu, onCloseContextMenu, onDragStart, onDragOver, onDragLeave, onDrop }: ExplorerTreeViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // TanStack Virtual intentionally exposes non-memoizable functions; this component is not compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: nodes.length, getScrollElement: () => scrollRef.current, estimateSize: () => 24, overscan: 20 })
  const virtualItems = virtualizer.getVirtualItems()
  const rows = virtualItems.length > 0 ? virtualItems : nodes.map((_, index) => ({ index, key: index, start: index * 24, size: 24, end: (index + 1) * 24, lane: 0 }))
  const contextPosition = contextMenu ? clampMenuPosition(contextMenu.x, contextMenu.y, contextMenu.actions.length) : null

  return (
    <aside className="explorer-tree-pane" data-explorer-tree="true">
      <header><strong>EXPLORER</strong><span className="explorer-tree-header-spacer" />{statusSummary ? <ChangeSummaryBadges summary={statusSummary} compact /> : null}{loading ? <LoaderCircle className="spin" size={13} /> : null}</header>
      {error ? <div className="explorer-error">{error}</div> : null}
      <div ref={scrollRef} className="explorer-tree-scroll" role="tree" tabIndex={0} onKeyDown={onKeyDown}>
        <div className="explorer-tree-virtual" style={{ height: `${virtualizer.getTotalSize() || nodes.length * 24}px` }}>
          {rows.map((virtualRow) => {
            const node = nodes[virtualRow.index]
            if (!node) return null
            const Icon = node.entry.isSymlink ? Link2 : node.entry.repoKind ? FolderGit2 : node.entry.isDir ? (node.expanded ? FolderOpen : Folder) : File
            return (
              <div
                key={node.path}
                className="explorer-tree-row"
                role="treeitem"
                aria-expanded={node.entry.isDir ? node.expanded : undefined}
                aria-selected={selectedPath === node.path}
                data-selected={selectedPath === node.path || undefined}
                data-ignored={node.ignored || undefined}
                data-drag-over={dragOverPath === node.path || undefined}
                data-git-state={node.decoration?.conflicted ? 'conflicted' : node.decoration?.unstaged ? 'unstaged' : node.decoration?.untracked ? 'untracked' : node.decoration?.staged ? 'staged' : undefined}
                data-git-only={node.gitOnly || undefined}
                data-repository-kind={node.entry.repoKind ?? undefined}
                data-repository-initialized={node.entry.repositoryInitialized === false ? 'false' : undefined}
                draggable={!node.gitOnly && !node.entry.repoKind}
                style={{ height: `${virtualRow.size}px`, transform: `translateY(${virtualRow.start}px)`, '--explorer-depth': node.depth } as React.CSSProperties}
                onClick={() => onSelect(node)}
                onDoubleClick={() => onToggle(node)}
                onContextMenu={(event) => onContextMenu(event, node)}
                onDragStart={() => onDragStart(node)}
                onDragOver={(event) => onDragOver(event, node)}
                onDragLeave={onDragLeave}
                onDrop={(event) => onDrop(event, node)}
              >
                {node.entry.isDir ? <button type="button" className="explorer-tree-twisty" tabIndex={-1} aria-label={node.expanded ? `Collapse ${node.name}` : `Expand ${node.name}`} onClick={(event) => { event.stopPropagation(); onToggle(node) }}>{node.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}</button> : <span className="explorer-tree-indent" />}
                <Icon className="explorer-tree-icon" size={14} />
                {renamingPath === node.path ? (
                  <input className="explorer-tree-rename" autoFocus value={renameValue} onChange={(event) => onRenameValueChange(event.target.value)} onBlur={onCommitRename} onKeyDown={(event) => { if (event.key === 'Enter') onCommitRename(); if (event.key === 'Escape') onCancelRename() }} />
                ) : <span className="explorer-tree-name">{node.name}</span>}
                {node.repositoryRef ? <span className="explorer-repository-ref" title={`Checked out ${node.repositoryRef}`}>{node.repositoryRef}</span> : null}
                {node.entry.repoKind ? <RepositoryBadges node={node} /> : null}
                {node.changeSummary ? <ChangeSummaryBadges summary={node.changeSummary} /> : null}
                {node.decoration ? <DecorationBadges decoration={node.decoration} /> : null}
              </div>
            )
          })}
        </div>
      </div>
      {nodes.length === 0 && !loading ? <div className="explorer-empty">This folder is empty.</div> : null}
      {contextMenu && contextPosition ? createPortal(
        <>
          <div className="terminal-context-backdrop" onMouseDown={onCloseContextMenu} onContextMenu={(event) => { event.preventDefault(); onCloseContextMenu() }} />
          <div className="terminal-context-menu explorer-context-menu" role="menu" style={{ left: contextPosition.x, top: contextPosition.y }}>
            {contextMenu.actions.map((action) => <button key={action.id} type="button" role="menuitem" disabled={action.disabled} data-danger={action.danger || undefined} onClick={action.onClick}>{action.label}</button>)}
          </div>
        </>,
        document.body,
      ) : null}
    </aside>
  )
}

const CHANGE_BADGE_BY_TYPE: Record<ChangeType, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  typeChanged: 'T',
  untracked: 'U',
}

const CHANGE_TITLE_BY_TYPE: Record<ChangeType, string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
  copied: 'Copied',
  typeChanged: 'Type changed',
  untracked: 'Untracked',
}

function DecorationBadges({ decoration }: { decoration: ExplorerGitDecoration }) {
  if (decoration.conflicted) return <span className="explorer-git-badges"><em className="explorer-tree-badge" data-area="conflicted" title="Merge conflict">!</em></span>
  const submodule = decoration.repoKind === 'submodule' ? decoration.submoduleState : null
  return (
    <span className="explorer-git-badges">
      {decoration.staged ? <em className="explorer-tree-badge" data-area="staged" data-change-type={decoration.staged} title={`Staged: ${CHANGE_TITLE_BY_TYPE[decoration.staged]}`}>{CHANGE_BADGE_BY_TYPE[decoration.staged]}</em> : null}
      {submodule?.commitChanged ? <em className="explorer-tree-badge" data-area="submodule-pointer" title="Submodule commit differs from the parent repository">P</em> : null}
      {submodule?.modified ? <em className="explorer-tree-badge" data-area="submodule-modified" title="Submodule contains modified tracked files">M</em> : null}
      {submodule?.untracked ? <em className="explorer-tree-badge" data-area="submodule-untracked" title="Submodule contains untracked files">U</em> : null}
      {!submodule && decoration.unstaged ? <em className="explorer-tree-badge" data-area="unstaged" data-change-type={decoration.unstaged} title={`Working tree: ${CHANGE_TITLE_BY_TYPE[decoration.unstaged]}`}>{CHANGE_BADGE_BY_TYPE[decoration.unstaged]}</em> : null}
      {decoration.untracked ? <em className="explorer-tree-badge" data-area="untracked" data-change-type="untracked" title="Untracked">U</em> : null}
    </span>
  )
}

function RepositoryBadges({ node }: { node: ExplorerNode }) {
  const kind = node.entry.repoKind === 'submodule' ? 'SUB' : 'REPO'
  return (
    <span className="explorer-repository-badges">
      <em data-kind={node.entry.repoKind} title={node.entry.repoKind === 'submodule' ? 'Git submodule repository boundary' : 'Nested Git repository boundary'}>{kind}</em>
      {node.entry.repositoryInitialized === false ? <em data-state="uninitialized" title="Submodule is not initialized">INIT</em> : null}
    </span>
  )
}

function ChangeSummaryBadges({ summary, compact = false }: { summary: ExplorerChangeSummary; compact?: boolean }) {
  const title = `${summary.total} changed path${summary.total === 1 ? '' : 's'}: ${summary.conflicted} conflicted, ${summary.staged} staged, ${summary.unstaged} modified, ${summary.untracked} untracked`
  return (
    <span className="explorer-change-summary" title={title} aria-label={title} data-compact={compact || undefined}>
      {summary.conflicted ? <em data-area="conflicted">!{summary.conflicted}</em> : null}
      {summary.staged ? <em data-area="staged">S{summary.staged}</em> : null}
      {summary.unstaged ? <em data-area="unstaged">M{summary.unstaged}</em> : null}
      {summary.untracked ? <em data-area="untracked">U{summary.untracked}</em> : null}
    </span>
  )
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

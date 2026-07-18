import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronDown, ChevronRight, File, Folder, FolderOpen, Link2, LoaderCircle } from 'lucide-react'
import type { ExplorerNode } from '../../state/explorer'
import './ExplorerTreeView.css'

export type ExplorerContextAction = { id: string; label: string; disabled?: boolean; danger?: boolean; onClick: () => void }
export type ExplorerContextMenu = { x: number; y: number; path: string; actions: ExplorerContextAction[] } | null

export type ExplorerTreeViewProps = {
  nodes: ExplorerNode[]
  selectedPath: string | null
  loading: boolean
  error: string | null
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

export function ExplorerTreeView({ nodes, selectedPath, loading, error, renamingPath, renameValue, contextMenu, dragOverPath, onSelect, onToggle, onKeyDown, onRenameValueChange, onCommitRename, onCancelRename, onContextMenu, onCloseContextMenu, onDragStart, onDragOver, onDragLeave, onDrop }: ExplorerTreeViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  // TanStack Virtual intentionally exposes non-memoizable functions; this component is not compiler-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({ count: nodes.length, getScrollElement: () => scrollRef.current, estimateSize: () => 24, overscan: 20 })
  const virtualItems = virtualizer.getVirtualItems()
  const rows = virtualItems.length > 0 ? virtualItems : nodes.map((_, index) => ({ index, key: index, start: index * 24, size: 24, end: (index + 1) * 24, lane: 0 }))

  return (
    <aside className="explorer-tree-pane" data-explorer-tree="true">
      <header><strong>EXPLORER</strong>{loading ? <LoaderCircle className="spin" size={13} /> : null}</header>
      {error ? <div className="explorer-error">{error}</div> : null}
      <div ref={scrollRef} className="explorer-tree-scroll" role="tree" tabIndex={0} onKeyDown={onKeyDown}>
        <div className="explorer-tree-virtual" style={{ height: `${virtualizer.getTotalSize() || nodes.length * 24}px` }}>
          {rows.map((virtualRow) => {
            const node = nodes[virtualRow.index]
            if (!node) return null
            const Icon = node.entry.isSymlink ? Link2 : node.entry.isDir ? (node.expanded ? FolderOpen : Folder) : File
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
                data-decoration={node.decoration ?? undefined}
                draggable
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
                {node.ancestorChanged ? <i className="explorer-change-dot" aria-label="Contains changed files" /> : null}
                {node.decoration ? <em className="explorer-tree-badge" title={decorationTitle(node.decoration)}>{node.decoration === 'conflicted' ? '!' : decorationLabel(node.decoration)}</em> : null}
              </div>
            )
          })}
        </div>
      </div>
      {nodes.length === 0 && !loading ? <div className="explorer-empty">This folder is empty.</div> : null}
      {contextMenu ? (
        <>
          <div className="terminal-context-backdrop" onMouseDown={onCloseContextMenu} onContextMenu={(event) => { event.preventDefault(); onCloseContextMenu() }} />
          <div className="terminal-context-menu explorer-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
            {contextMenu.actions.map((action) => <button key={action.id} type="button" role="menuitem" disabled={action.disabled} data-danger={action.danger || undefined} onClick={action.onClick}>{action.label}</button>)}
          </div>
        </>
      ) : null}
    </aside>
  )
}

function decorationLabel(decoration: Exclude<ExplorerNode['decoration'], null | 'conflicted'>): string {
  return ({ added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typeChanged: 'T', untracked: 'U' })[decoration]
}

function decorationTitle(decoration: NonNullable<ExplorerNode['decoration']>): string {
  return ({ added: 'Added', modified: 'Modified', deleted: 'Deleted', renamed: 'Renamed', copied: 'Copied', typeChanged: 'Type changed', untracked: 'Untracked', conflicted: 'Merge conflict' })[decoration]
}

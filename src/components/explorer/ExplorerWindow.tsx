import { Eye, FilePlus2, FolderPlus, FolderTree, RefreshCw } from 'lucide-react'
import { WorkspaceSidebarPanelShell } from '../WorkspaceSidebarPanelShell'
import { ChangeSummaryBadges, ExplorerTreeView } from './ExplorerTreeView'
import { useExplorerController, type ExplorerControllerOptions } from './useExplorerController'

export type ExplorerSidebarPanelProps = ExplorerControllerOptions & {
  onCollapse?: () => void
}

export function ExplorerSidebarPanel({ sessionId, workspaceFolder, onCollapse }: ExplorerSidebarPanelProps) {
  const controller = useExplorerController({ sessionId, workspaceFolder })

  const canOpenPreview = Boolean(controller.selectedNode && !controller.selectedNode.entry.isDir && !controller.selectedNode.gitOnly)
  const actions = (
    <>
      {controller.statusSummary ? <ChangeSummaryBadges summary={controller.statusSummary} presentation={controller.statusPresentation} compact /> : null}
      <button type="button" title="Refresh Explorer" aria-label="Refresh Explorer" onClick={() => { void controller.refresh() }}><RefreshCw size={13} aria-hidden="true" /></button>
      <button type="button" title="New File" aria-label="New File" onClick={() => { void controller.createFile() }}><FilePlus2 size={13} aria-hidden="true" /></button>
      <button type="button" title="New Folder" aria-label="New Folder" onClick={() => { void controller.createFolder() }}><FolderPlus size={13} aria-hidden="true" /></button>
      <button type="button" title="Open Preview" aria-label="Open Preview" disabled={!canOpenPreview} onClick={() => { void controller.openPreview() }}><Eye size={13} aria-hidden="true" /></button>
    </>
  )
  const context = (
    <div className="explorer-tree-context" aria-label={`Workspace ${controller.workspaceLabel}; Git repository ${controller.activeRepositoryLabel}`}>
      <span title={controller.workspaceFolder}><b>Workspace</b><span>{controller.workspaceLabel}</span></span>
      <span title={`Git repository: ${controller.activeRepositoryLabel}`}><b>Git</b><span>{controller.activeRepositoryLabel}</span></span>
    </div>
  )

  return (
    <div className="explorer-window" data-explorer-window="true">
      <WorkspaceSidebarPanelShell title="Explorer" icon={<FolderTree size={15} />} actions={actions} filter={context} onCollapse={onCollapse} collapseLabel="Collapse Explorer">
        <ExplorerTreeView
          nodes={controller.nodes}
          selectedPath={controller.session.selectedPath}
          loading={controller.session.loadingPaths.size > 0}
          error={controller.session.error}
          statusSummary={controller.statusSummary}
          statusPresentation={controller.statusPresentation}
          canOpenPreview={canOpenPreview}
          showHeader={false}
          treeId={`explorer-tree-${sessionId}`}
          workspaceLabel={controller.workspaceLabel}
          workspacePath={controller.workspaceFolder}
          repositoryLabel={controller.activeRepositoryLabel}
          renamingPath={controller.renamingPath}
          renameValue={controller.renameValue}
          contextMenu={controller.contextMenu}
          dragOverPath={controller.dragOverPath}
          onRefresh={() => { void controller.refresh() }}
          onNewFile={() => { void controller.createFile() }}
          onNewFolder={() => { void controller.createFolder() }}
          onOpenPreview={() => { void controller.openPreview() }}
          onSelect={controller.selectNode}
          onOpen={(node) => { void controller.openNode(node) }}
          onToggle={(node) => { void controller.toggleNode(node) }}
          onKeyDown={controller.handleKeyDown}
          onRenameValueChange={controller.setRenameValue}
          onCommitRename={() => { void controller.commitRename() }}
          onCancelRename={controller.cancelRename}
          onContextMenu={controller.openContextMenu}
          onCloseContextMenu={controller.closeContextMenu}
          onDragStart={controller.startDrag}
          onDragOver={controller.dragOver}
          onDragLeave={controller.dragLeave}
          onDrop={controller.drop}
        />
      </WorkspaceSidebarPanelShell>
    </div>
  )
}

export function ExplorerWindow(props: ExplorerSidebarPanelProps) {
  return <ExplorerSidebarPanel {...props} />
}

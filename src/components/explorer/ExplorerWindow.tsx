import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TextFile } from '../../ipc/types'
import { emptyExplorerSessionState, deriveGitDecorations, flattenExplorerTree, joinPath, parentPath, useExplorerStore, type ExplorerNode } from '../../state/explorer'
import { emptyGitSessionState, useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { useWorkspaceWindowActions } from '../../layout/windowActions'
import { ExplorerTreeView, type ExplorerContextMenu } from './ExplorerTreeView'
import { ExplorerViewerView } from './ExplorerViewerView'

export type ExplorerWindowProps = { sessionId: string; workspaceFolder: string }

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])

export function ExplorerWindow({ sessionId, workspaceFolder }: ExplorerWindowProps) {
  const session = useExplorerStore((state) => state.sessions[sessionId] ?? emptyExplorerSessionState)
  const loadChildren = useExplorerStore((state) => state.loadChildren)
  const setExpanded = useExplorerStore((state) => state.setExpanded)
  const setSelectedPath = useExplorerStore((state) => state.setSelectedPath)
  const invalidatePath = useExplorerStore((state) => state.invalidatePath)
  const setExplorerError = useExplorerStore((state) => state.setError)
  const gitSession = useGitStore((state) => state.sessions[sessionId] ?? emptyGitSessionState)
  const refreshGit = useGitStore((state) => state.refreshGit)
  const runGitMutation = useGitStore((state) => state.runGitMutation)
  const setGitSelectedPath = useGitStore((state) => state.setSelectedPath)
  const setGitActiveTab = useGitStore((state) => state.setActiveTab)
  const spawnPane = useWorkspaceStore((state) => state.spawnPane)
  const editorCommand = useWorkspaceStore((state) => state.settings.externalEditorCommand).trim()
  const windowActions = useWorkspaceWindowActions()
  const [textFile, setTextFile] = useState<TextFile | null>(null)
  const [imageSrc, setImageSrc] = useState<string | null>(null)
  const [viewerLoading, setViewerLoading] = useState(false)
  const [viewerError, setViewerError] = useState<string | null>(null)
  const [imageFit, setImageFit] = useState(true)
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<ExplorerContextMenu>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const draggedPathRef = useRef<string | null>(null)

  const decorations = useMemo(() => deriveGitDecorations(gitSession.status), [gitSession.status])
  const nodes = useMemo(() => flattenExplorerTree(session, decorations), [decorations, session])
  const selectedNode = nodes.find((node) => node.path === session.selectedPath) ?? null

  useEffect(() => { void loadChildren(sessionId, workspaceFolder, '') }, [loadChildren, sessionId, workspaceFolder])
  useEffect(() => {
    void refreshGit(sessionId, workspaceFolder)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refreshGit(sessionId, workspaceFolder) }, 10_000)
    return () => window.clearInterval(timer)
  }, [refreshGit, sessionId, workspaceFolder])
  useEffect(() => {
    const refreshVisibleTree = () => {
      const current = useExplorerStore.getState().sessions[sessionId]
      const paths = current ? [...current.childrenByPath.keys()] : ['']
      for (const path of paths) void loadChildren(sessionId, workspaceFolder, path)
    }
    window.addEventListener('focus', refreshVisibleTree)
    return () => window.removeEventListener('focus', refreshVisibleTree)
  }, [loadChildren, sessionId, workspaceFolder])

  useEffect(() => {
    let cancelled = false
    const timer = window.setTimeout(() => {
      setTextFile(null)
      setImageSrc(null)
      setViewerError(null)
      if (!selectedNode || selectedNode.entry.isDir) { setViewerLoading(false); return }
      setViewerLoading(true)
      const extension = selectedNode.name.split('.').pop()?.toLowerCase() ?? ''
      const request = IMAGE_EXTENSIONS.has(extension)
        ? invoke<string>('fs_read_image', { workspaceFolder, relPath: selectedNode.path }).then((base64) => ({ image: `data:${imageMime(extension)};base64,${base64}` }))
        : invoke<TextFile>('fs_read_text', { workspaceFolder, relPath: selectedNode.path }).then((text) => ({ text }))
      void request.then((result) => {
        if (cancelled) return
        if ('image' in result) setImageSrc(result.image)
        else setTextFile(result.text)
      }).catch((reason) => { if (!cancelled) setViewerError(String(reason)) }).finally(() => { if (!cancelled) setViewerLoading(false) })
    }, 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [selectedNode, workspaceFolder])

  const reloadPaths = useCallback(async (...paths: string[]) => {
    const unique = new Set(paths.map(parentPath).concat(paths).filter((path) => session.childrenByPath.has(path) || path === ''))
    for (const path of unique) await loadChildren(sessionId, workspaceFolder, path)
    await refreshGit(sessionId, workspaceFolder)
  }, [loadChildren, refreshGit, session.childrenByPath, sessionId, workspaceFolder])

  const toggleNode = useCallback(async (node: ExplorerNode) => {
    if (!node.entry.isDir || node.entry.isSymlink) return
    const expanded = !node.expanded
    setExpanded(sessionId, node.path, expanded)
    if (expanded && !session.childrenByPath.has(node.path)) await loadChildren(sessionId, workspaceFolder, node.path)
  }, [loadChildren, session.childrenByPath, sessionId, setExpanded, workspaceFolder])

  const beginRename = useCallback((node: ExplorerNode) => {
    setContextMenu(null)
    setRenamingPath(node.path)
    setRenameValue(node.name)
  }, [])

  const commitRename = useCallback(async () => {
    const source = renamingPath
    const name = renameValue.trim()
    setRenamingPath(null)
    if (!source || !name || name === source.split('/').pop()) return
    const destination = joinPath(parentPath(source), name)
    try {
      await invoke('fs_rename', { workspaceFolder, fromRel: source, toRel: destination })
      setSelectedPath(sessionId, destination)
      invalidatePath(sessionId, source)
      await reloadPaths(source, destination)
    } catch (reason) { setExplorerError(sessionId, String(reason)) }
  }, [invalidatePath, reloadPaths, renameValue, renamingPath, sessionId, setExplorerError, setSelectedPath, workspaceFolder])

  const deleteNode = useCallback(async (node: ExplorerNode) => {
    setContextMenu(null)
    if (!window.confirm(`Delete ${node.name}? This cannot be undone.`)) return
    try {
      await invoke('fs_delete', { workspaceFolder, relPaths: [node.path] })
      if (session.selectedPath === node.path || session.selectedPath?.startsWith(`${node.path}/`)) setSelectedPath(sessionId, null)
      invalidatePath(sessionId, node.path)
      await reloadPaths(node.path)
    } catch (reason) { setExplorerError(sessionId, String(reason)) }
  }, [invalidatePath, reloadPaths, session.selectedPath, sessionId, setExplorerError, setSelectedPath, workspaceFolder])

  const createEntry = useCallback(async (node: ExplorerNode, directory: boolean) => {
    setContextMenu(null)
    const name = window.prompt(directory ? 'Folder name' : 'File name')?.trim()
    if (!name) return
    const targetDir = node.entry.isDir ? node.path : node.parentPath
    const path = joinPath(targetDir, name)
    try {
      await invoke(directory ? 'fs_create_dir' : 'fs_create_file', { workspaceFolder, relPath: path })
      if (node.entry.isDir) setExpanded(sessionId, node.path, true)
      setSelectedPath(sessionId, path)
      await reloadPaths(targetDir)
    } catch (reason) { setExplorerError(sessionId, String(reason)) }
  }, [reloadPaths, sessionId, setExpanded, setExplorerError, setSelectedPath, workspaceFolder])

  const moveNode = useCallback(async (sourcePath: string, target: ExplorerNode) => {
    const targetDir = target.entry.isDir ? target.path : target.parentPath
    if (sourcePath === targetDir || targetDir.startsWith(`${sourcePath}/`)) return
    const destination = joinPath(targetDir, sourcePath.split('/').pop() ?? '')
    if (destination === sourcePath) return
    try {
      await invoke('fs_rename', { workspaceFolder, fromRel: sourcePath, toRel: destination })
      setSelectedPath(sessionId, destination)
      invalidatePath(sessionId, sourcePath)
      await reloadPaths(sourcePath, destination, targetDir)
    } catch (reason) { setExplorerError(sessionId, String(reason)) }
  }, [invalidatePath, reloadPaths, sessionId, setExplorerError, setSelectedPath, workspaceFolder])

  const openGit = useCallback(async (node: ExplorerNode, history: boolean) => {
    setContextMenu(null)
    setGitSelectedPath(sessionId, node.path)
    setGitActiveTab(sessionId, history ? 'history' : 'changes', history ? node.path : null)
    await windowActions.openWindow('git')
  }, [sessionId, setGitActiveTab, setGitSelectedPath, windowActions])

  const mutateGit = useCallback(async (node: ExplorerNode, stage: boolean) => {
    setContextMenu(null)
    await runGitMutation(sessionId, workspaceFolder, () => invoke(stage ? 'git_stage' : 'git_unstage', { workspaceFolder, paths: [node.path] }))
  }, [runGitMutation, sessionId, workspaceFolder])

  const absolutePath = useCallback((path: string) => `${workspaceFolder.replace(/[\\/]+$/, '')}\\${path.replace(/\//g, '\\')}`, [workspaceFolder])
  const openTerminal = useCallback(async (node: ExplorerNode) => {
    const cwd = absolutePath(node.entry.isDir ? node.path : node.parentPath)
    await spawnPane(sessionId, { cwd })
  }, [absolutePath, sessionId, spawnPane])

  const actionsFor = useCallback((node: ExplorerNode) => {
    const staged = gitSession.status?.staged.some((entry) => entry.path === node.path) ?? false
    const changed = decorations.has(node.path)
    const wrap = (action: () => void | Promise<void>) => () => { setContextMenu(null); void action() }
    return [
      { id: 'new-file', label: 'New File', onClick: wrap(() => createEntry(node, false)) },
      { id: 'new-folder', label: 'New Folder', onClick: wrap(() => createEntry(node, true)) },
      { id: 'rename', label: 'Rename', onClick: wrap(() => beginRename(node)) },
      { id: 'delete', label: 'Delete', danger: true, onClick: wrap(() => deleteNode(node)) },
      { id: 'editor', label: 'Open in Editor', disabled: !editorCommand, onClick: wrap(() => invoke('open_in_editor', { workspaceFolder, relPath: node.path, editorCommand })) },
      { id: 'terminal', label: 'Open in Terminal', onClick: wrap(() => openTerminal(node)) },
      { id: 'reveal', label: 'Reveal in File Explorer', onClick: wrap(() => invoke('reveal_path', { path: absolutePath(node.path) })) },
      { id: 'copy-rel', label: 'Copy Relative Path', onClick: wrap(() => navigator.clipboard.writeText(node.path)) },
      { id: 'copy-abs', label: 'Copy Absolute Path', onClick: wrap(() => navigator.clipboard.writeText(absolutePath(node.path))) },
      { id: staged ? 'unstage' : 'stage', label: staged ? 'Unstage' : 'Stage', disabled: !changed, onClick: wrap(() => mutateGit(node, !staged)) },
      { id: 'diff', label: 'Diff vs HEAD', disabled: !changed, onClick: wrap(() => openGit(node, false)) },
      { id: 'history', label: 'File History', onClick: wrap(() => openGit(node, true)) },
    ]
  }, [absolutePath, beginRename, createEntry, decorations, deleteNode, editorCommand, gitSession.status, mutateGit, openGit, openTerminal, workspaceFolder])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (nodes.length === 0) return
    const index = Math.max(0, nodes.findIndex((node) => node.path === session.selectedPath))
    const node = nodes[index]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = nodes[Math.min(nodes.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      setSelectedPath(sessionId, next.path)
    } else if (event.key === 'ArrowRight') { event.preventDefault(); void toggleNode(node) }
    else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (node.expanded) void toggleNode(node)
      else if (node.parentPath) setSelectedPath(sessionId, node.parentPath)
    } else if (event.key === 'Enter' && node.entry.isDir) { event.preventDefault(); void toggleNode(node) }
    else if (event.key === 'F2') { event.preventDefault(); beginRename(node) }
    else if (event.key === 'Delete') { event.preventDefault(); void deleteNode(node) }
  }, [beginRename, deleteNode, nodes, session.selectedPath, sessionId, setSelectedPath, toggleNode])

  return (
    <div className="explorer-window" data-explorer-window="true">
      <ExplorerTreeView
        nodes={nodes}
        selectedPath={session.selectedPath}
        loading={session.loadingPaths.size > 0}
        error={session.error}
        renamingPath={renamingPath}
        renameValue={renameValue}
        contextMenu={contextMenu}
        dragOverPath={dragOverPath}
        onSelect={(node) => setSelectedPath(sessionId, node.path)}
        onToggle={(node) => { void toggleNode(node) }}
        onKeyDown={handleKeyDown}
        onRenameValueChange={setRenameValue}
        onCommitRename={() => { void commitRename() }}
        onCancelRename={() => setRenamingPath(null)}
        onContextMenu={(event, node) => { event.preventDefault(); setSelectedPath(sessionId, node.path); setContextMenu({ x: event.clientX, y: event.clientY, path: node.path, actions: actionsFor(node) }) }}
        onCloseContextMenu={() => setContextMenu(null)}
        onDragStart={(node) => { draggedPathRef.current = node.path }}
        onDragOver={(event, node) => { event.preventDefault(); setDragOverPath(node.path) }}
        onDragLeave={() => setDragOverPath(null)}
        onDrop={(event, node) => { event.preventDefault(); setDragOverPath(null); const source = draggedPathRef.current; draggedPathRef.current = null; if (source) void moveNode(source, node) }}
      />
      <ExplorerViewerView
        path={session.selectedPath}
        entry={selectedNode?.entry ?? null}
        textFile={textFile}
        imageSrc={imageSrc}
        loading={viewerLoading}
        error={viewerError}
        imageFit={imageFit}
        canOpenEditor={Boolean(editorCommand)}
        onToggleImageFit={() => setImageFit((value) => !value)}
        onOpenEditor={() => { if (selectedNode && editorCommand) void invoke('open_in_editor', { workspaceFolder, relPath: selectedNode.path, editorCommand }) }}
        onOpenTerminal={() => { if (selectedNode) void openTerminal(selectedNode) }}
        onReveal={() => { if (selectedNode) void invoke('reveal_path', { path: absolutePath(selectedNode.path) }) }}
        onCopyPath={() => { if (selectedNode) void navigator.clipboard.writeText(absolutePath(selectedNode.path)) }}
      />
    </div>
  )
}

function imageMime(extension: string): string {
  if (extension === 'jpg' || extension === 'jpeg') return 'image/jpeg'
  if (extension === 'svg') return 'image/svg+xml'
  return `image/${extension}`
}

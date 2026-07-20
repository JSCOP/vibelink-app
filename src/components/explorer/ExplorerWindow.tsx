import { invoke } from '@tauri-apps/api/core'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TextFile, WorkingStatus } from '../../ipc/types'
import { emptyExplorerSessionState, deriveGitDecorations, flattenExplorerTree, joinPath, parentPath, useExplorerStore, type ExplorerNode } from '../../state/explorer'
import { emptyGitSessionState, useGitStore } from '../../state/git'
import { useWorkspaceStore } from '../../state/store'
import { useWorkspaceWindowActions } from '../../layout/windowActions'
import { ExplorerTreeView, type ExplorerContextAction, type ExplorerContextMenu } from './ExplorerTreeView'
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
  const [nestedStatuses, setNestedStatuses] = useState<Map<string, WorkingStatus>>(() => new Map())

  const decorations = useMemo(() => {
    const combined = deriveGitDecorations(gitSession.status)
    for (const [repoRoot, status] of nestedStatuses) {
      for (const [path, decoration] of deriveGitDecorations(status, repoRoot, repoRoot)) combined.set(path, decoration)
    }
    return combined
  }, [gitSession.status, nestedStatuses])
  const nodes = useMemo(() => flattenExplorerTree(session, decorations), [decorations, session])
  const statusSummary = useMemo(() => {
    if (decorations.size === 0) return null
    const summary = { total: decorations.size, conflicted: 0, staged: 0, unstaged: 0, untracked: 0 }
    for (const decoration of decorations.values()) {
      if (decoration.conflicted) summary.conflicted += 1
      if (decoration.staged) summary.staged += 1
      if (decoration.unstaged) summary.unstaged += 1
      if (decoration.untracked) summary.untracked += 1
    }
    return summary
  }, [decorations])
  const selectedNode = nodes.find((node) => node.path === session.selectedPath) ?? null
  const selectedHasDiff = Boolean(selectedNode && !selectedNode.entry.isDir && selectedNode.decoration)

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
      if (!selectedNode || selectedNode.entry.isDir || selectedNode.gitOnly) { setViewerLoading(false); return }
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
    if (!expanded) return
    const requests: Promise<unknown>[] = []
    if (!node.gitOnly && !session.childrenByPath.has(node.path)) requests.push(loadChildren(sessionId, workspaceFolder, node.path))
    if (node.decoration?.repoKind && !nestedStatuses.has(node.path)) {
      const nestedWorkspaceFolder = `${workspaceFolder.replace(/[\\/]+$/, '')}/${node.path}`
      requests.push(invoke<WorkingStatus>('git_working_status', { workspaceFolder: nestedWorkspaceFolder }).then((status) => {
        setNestedStatuses((current) => new Map(current).set(node.path, status))
      }).catch((reason) => setExplorerError(sessionId, `Could not inspect ${node.path}: ${String(reason)}`)))
    }
    await Promise.all(requests)
  }, [loadChildren, nestedStatuses, session.childrenByPath, sessionId, setExpanded, setExplorerError, workspaceFolder])

  const selectNode = useCallback((node: ExplorerNode) => {
    setSelectedPath(sessionId, node.path)
    if (node.entry.isDir || !node.decoration) return
    const area = node.decoration.conflicted || node.decoration.unstaged || node.decoration.untracked ? 'unstaged' : 'staged'
    setGitSelectedPath(sessionId, node.path, node.decoration.repoRoot, area)
    setGitActiveTab(sessionId, 'changes')
  }, [sessionId, setGitActiveTab, setGitSelectedPath, setSelectedPath])

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

  const gitTargetForNode = useCallback((node: ExplorerNode) => {
    let repoRoot = node.decoration?.repoRoot ?? null
    if (!repoRoot) {
      const matchingRoots = [...nestedStatuses.keys()].filter((root) => node.path === root || node.path.startsWith(`${root}/`))
      matchingRoots.sort((left, right) => right.length - left.length)
      repoRoot = matchingRoots[0] ?? null
    }
    const relativePath = repoRoot ? node.path.slice(repoRoot.length).replace(/^\/+/, '') : node.path
    return {
      repoRoot,
      workspaceFolder: repoRoot ? `${workspaceFolder.replace(/[\\/]+$/, '')}/${repoRoot}` : workspaceFolder,
      path: relativePath || '.',
    }
  }, [nestedStatuses, workspaceFolder])

  const refreshNestedRepo = useCallback(async (repoRoot: string | null) => {
    if (!repoRoot) return
    const nestedWorkspaceFolder = `${workspaceFolder.replace(/[\\/]+$/, '')}/${repoRoot}`
    const status = await invoke<WorkingStatus>('git_working_status', { workspaceFolder: nestedWorkspaceFolder })
    setNestedStatuses((current) => new Map(current).set(repoRoot, status))
  }, [workspaceFolder])

  const openGit = useCallback(async (node: ExplorerNode, history: boolean) => {
    setContextMenu(null)
    const target = gitTargetForNode(node)
    const area = node.decoration?.conflicted || node.decoration?.unstaged || node.decoration?.untracked ? 'unstaged' : 'staged'
    setGitSelectedPath(sessionId, node.path, target.repoRoot, area)
    setGitActiveTab(sessionId, history ? 'history' : 'changes', history ? target.path : null)
    await windowActions.openWindow('git')
  }, [gitTargetForNode, sessionId, setGitActiveTab, setGitSelectedPath, windowActions])

  const mutateGit = useCallback(async (command: 'git_stage' | 'git_unstage' | 'git_conflict_take', node: ExplorerNode, extra: Record<string, unknown> = {}) => {
    setContextMenu(null)
    const target = gitTargetForNode(node)
    await runGitMutation(sessionId, workspaceFolder, () => invoke(command, { workspaceFolder: target.workspaceFolder, paths: [target.path], ...extra }))
    await refreshNestedRepo(target.repoRoot)
  }, [gitTargetForNode, refreshNestedRepo, runGitMutation, sessionId, workspaceFolder])

  const discardGit = useCallback(async (node: ExplorerNode) => {
    setContextMenu(null)
    const targetName = node.entry.isDir ? `${node.name} and its changed descendants` : node.name
    const untracked = Boolean(node.decoration?.untracked || node.changeSummary?.untracked)
    const message = untracked
      ? `Discard ${targetName}? Untracked paths will be moved to the Recycle Bin.`
      : `Discard changes in ${targetName}? This cannot be undone.`
    if (!window.confirm(message)) return
    const target = gitTargetForNode(node)
    await runGitMutation(sessionId, workspaceFolder, () => invoke('git_discard', { workspaceFolder: target.workspaceFolder, paths: [target.path] }))
    await refreshNestedRepo(target.repoRoot)
    await reloadPaths(node.path)
  }, [gitTargetForNode, refreshNestedRepo, reloadPaths, runGitMutation, sessionId, workspaceFolder])

  const absolutePath = useCallback((path: string) => `${workspaceFolder.replace(/[\\/]+$/, '')}\\${path.replace(/\//g, '\\')}`, [workspaceFolder])
  const openTerminal = useCallback(async (node: ExplorerNode) => {
    const cwd = absolutePath(node.entry.isDir ? node.path : node.parentPath)
    await spawnPane(sessionId, { cwd })
  }, [absolutePath, sessionId, spawnPane])

  const actionsFor = useCallback((node: ExplorerNode) => {
    const staged = Boolean(node.decoration?.staged || node.changeSummary?.staged)
    const unstaged = Boolean(node.decoration?.unstaged || node.decoration?.untracked || node.changeSummary?.unstaged || node.changeSummary?.untracked)
    const conflicted = Boolean(node.decoration?.conflicted || node.changeSummary?.conflicted)
    const changed = staged || unstaged || conflicted
    const present = !node.gitOnly
    const wrap = (action: () => void | Promise<void>) => () => { setContextMenu(null); void action() }
    const actions: ExplorerContextAction[] = [
      { id: 'new-file', label: 'New File', disabled: !present, onClick: wrap(() => createEntry(node, false)) },
      { id: 'new-folder', label: 'New Folder', disabled: !present, onClick: wrap(() => createEntry(node, true)) },
      { id: 'rename', label: 'Rename', disabled: !present, onClick: wrap(() => beginRename(node)) },
      { id: 'delete', label: 'Delete', disabled: !present, danger: true, onClick: wrap(() => deleteNode(node)) },
      { id: 'editor', label: 'Open in Editor', disabled: !present || !editorCommand, onClick: wrap(() => invoke('open_in_editor', { workspaceFolder, relPath: node.path, editorCommand })) },
      { id: 'terminal', label: 'Open in Terminal', disabled: !present, onClick: wrap(() => openTerminal(node)) },
      { id: 'reveal', label: 'Reveal in File Explorer', disabled: !present, onClick: wrap(() => invoke('reveal_path', { path: absolutePath(node.path) })) },
      { id: 'copy-rel', label: 'Copy Relative Path', onClick: wrap(() => navigator.clipboard.writeText(node.path)) },
      { id: 'copy-abs', label: 'Copy Absolute Path', onClick: wrap(() => navigator.clipboard.writeText(absolutePath(node.path))) },
    ]
    if (unstaged) actions.push({ id: 'stage', label: node.entry.isDir ? 'Stage Folder Changes' : 'Stage Changes', onClick: wrap(() => mutateGit('git_stage', node)) })
    if (staged) actions.push({ id: 'unstage', label: node.entry.isDir ? 'Unstage Folder Changes' : 'Unstage Changes', onClick: wrap(() => mutateGit('git_unstage', node)) })
    if (unstaged) actions.push({ id: 'discard', label: node.entry.isDir ? 'Discard Folder Changes' : 'Discard Changes', danger: true, onClick: wrap(() => discardGit(node)) })
    if (node.decoration?.conflicted && !node.entry.isDir) {
      actions.push({ id: 'ours', label: 'Accept Ours', onClick: wrap(() => mutateGit('git_conflict_take', node, { side: 'ours' })) })
      actions.push({ id: 'theirs', label: 'Accept Theirs', onClick: wrap(() => mutateGit('git_conflict_take', node, { side: 'theirs' })) })
    }
    if (!node.entry.isDir && changed) actions.push({ id: 'diff', label: 'Diff vs HEAD', onClick: wrap(() => openGit(node, false)) })
    actions.push({ id: 'history', label: node.entry.isDir ? 'Folder History' : 'File History', onClick: wrap(() => openGit(node, true)) })
    return actions
  }, [absolutePath, beginRename, createEntry, deleteNode, discardGit, editorCommand, mutateGit, openGit, openTerminal, workspaceFolder])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (nodes.length === 0) return
    const index = Math.max(0, nodes.findIndex((node) => node.path === session.selectedPath))
    const node = nodes[index]
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = nodes[Math.min(nodes.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
      selectNode(next)
    } else if (event.key === 'ArrowRight') { event.preventDefault(); void toggleNode(node) }
    else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (node.expanded) void toggleNode(node)
      else if (node.parentPath) {
        const parent = nodes.find((candidate) => candidate.path === node.parentPath)
        if (parent) selectNode(parent)
      }
    } else if (event.key === 'Enter' && node.entry.isDir) { event.preventDefault(); void toggleNode(node) }
    else if (event.key === 'F2' && !node.gitOnly) { event.preventDefault(); beginRename(node) }
    else if (event.key === 'Delete' && !node.gitOnly) { event.preventDefault(); void deleteNode(node) }
  }, [beginRename, deleteNode, nodes, selectNode, session.selectedPath, toggleNode])

  return (
    <div className="explorer-window" data-explorer-window="true">
      <ExplorerTreeView
        nodes={nodes}
        selectedPath={session.selectedPath}
        loading={session.loadingPaths.size > 0}
        error={session.error}
        statusSummary={statusSummary}
        renamingPath={renamingPath}
        renameValue={renameValue}
        contextMenu={contextMenu}
        dragOverPath={dragOverPath}
        onSelect={selectNode}
        onToggle={(node) => { void toggleNode(node) }}
        onKeyDown={handleKeyDown}
        onRenameValueChange={setRenameValue}
        onCommitRename={() => { void commitRename() }}
        onCancelRename={() => setRenamingPath(null)}
        onContextMenu={(event, node) => { event.preventDefault(); selectNode(node); setContextMenu({ x: event.clientX, y: event.clientY, path: node.path, actions: actionsFor(node) }) }}
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
        canOpenDiff={selectedHasDiff}
        workingTreePresent={!selectedNode?.gitOnly}
        onToggleImageFit={() => setImageFit((value) => !value)}
        onOpenEditor={() => { if (selectedNode && editorCommand) void invoke('open_in_editor', { workspaceFolder, relPath: selectedNode.path, editorCommand }) }}
        onOpenDiff={() => { if (selectedNode && selectedHasDiff) void openGit(selectedNode, false) }}
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

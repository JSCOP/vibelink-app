import { invoke } from '@tauri-apps/api/core'
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { TextFile } from '../../ipc/types'
import { WorkspaceContentActionsContext } from '../../layout/contentActions'
import { workspaceContentPanelId } from '../../layout/workspaceContentModel'
import { browserEditorCloseDecision, getEditorDocumentStore } from '../../editor/documentStore'
import { emptyExplorerSessionState, deriveGitDecorations, flattenExplorerTree, joinPath, parentPath, useExplorerStore, type ExplorerNode } from '../../state/explorer'
import { emptyGitSessionState, repositoryFolder, repositoryStateFor, useGitStore } from '../../state/git'
import { getWorkspaceSessionEpoch, getWorkspaceSessionReadyEpoch, getWorkspaceSessionTargetId, useWorkspaceStore } from '../../state/store'
import type { ExplorerContextAction, ExplorerContextMenu } from './ExplorerTreeView'

export type ExplorerControllerOptions = { sessionId: string; workspaceFolder: string }

const IMAGE_EXTENSION: Record<string, true> = { png: true, jpg: true, jpeg: true, gif: true, webp: true, svg: true, bmp: true }
type ExplorerWorkspaceOwnership = { sessionId: string; sessionEpoch: number; workspaceFolder: string }

export function useExplorerController({ sessionId, workspaceFolder }: ExplorerControllerOptions) {
  const session = useExplorerStore((state) => state.sessions[sessionId] ?? emptyExplorerSessionState)
  const loadChildren = useExplorerStore((state) => state.loadChildren)
  const setExpanded = useExplorerStore((state) => state.setExpanded)
  const setSelectedPath = useExplorerStore((state) => state.setSelectedPath)
  const invalidatePath = useExplorerStore((state) => state.invalidatePath)
  const setExplorerError = useExplorerStore((state) => state.setError)
  const gitSession = useGitStore((state) => state.sessions[sessionId] ?? emptyGitSessionState)
  const refreshGit = useGitStore((state) => state.refreshGit)
  const refreshRepository = useGitStore((state) => state.refreshRepository)
  const refreshHosting = useGitStore((state) => state.refreshHosting)
  const runGitMutation = useGitStore((state) => state.runGitMutation)
  const setActiveRepository = useGitStore((state) => state.setActiveRepository)
  const setGitSelectedPath = useGitStore((state) => state.setSelectedPath)
  const setGitActiveTab = useGitStore((state) => state.setActiveTab)
  const editorCommand = useWorkspaceStore((state) => state.settings.externalEditorCommand).trim()
  const gitStatusPresentation = useWorkspaceStore((state) => state.settings.gitStatusPresentation)
  const contentActions = useContext(WorkspaceContentActionsContext)
  const editorDocuments = useMemo(() => getEditorDocumentStore(sessionId, workspaceFolder), [sessionId, workspaceFolder])
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [contextMenu, setContextMenu] = useState<ExplorerContextMenu>(null)
  const [dragOverPath, setDragOverPath] = useState<string | null>(null)
  const draggedPathRef = useRef<string | null>(null)
  const captureWorkspaceOwnership = useCallback((): ExplorerWorkspaceOwnership | null => {
    const state = useWorkspaceStore.getState()
    const sessionEpoch = getWorkspaceSessionEpoch()
    const currentFolder = state.sessions.find((candidate) => candidate.id === sessionId)?.workspaceFolder ?? null
    if (state.activeSessionId !== sessionId
      || currentFolder !== workspaceFolder
      || getWorkspaceSessionReadyEpoch() !== sessionEpoch
      || getWorkspaceSessionTargetId() !== sessionId) return null
    return { sessionId, sessionEpoch, workspaceFolder }
  }, [sessionId, workspaceFolder])
  const workspaceOwnershipIsCurrent = useCallback((ownership: ExplorerWorkspaceOwnership | null): ownership is ExplorerWorkspaceOwnership => {
    if (!ownership) return false
    const state = useWorkspaceStore.getState()
    return state.activeSessionId === ownership.sessionId
      && getWorkspaceSessionEpoch() === ownership.sessionEpoch
      && getWorkspaceSessionReadyEpoch() === ownership.sessionEpoch
      && getWorkspaceSessionTargetId() === ownership.sessionId
      && state.sessions.find((candidate) => candidate.id === ownership.sessionId)?.workspaceFolder === ownership.workspaceFolder
  }, [])

  const repositoryInfoByRoot = useMemo(() => new Map(
    Object.entries(gitSession.repositories).map(([root, state]) => [root, state.repoInfo] as const),
  ), [gitSession.repositories])
  const decorations = useMemo(() => {
    const combined = deriveGitDecorations(repositoryStateFor(gitSession, '').status)
    for (const [repoRoot, state] of Object.entries(gitSession.repositories)) {
      if (!repoRoot || !state.status) continue
      for (const [path, decoration] of deriveGitDecorations(state.status, repoRoot, repoRoot)) combined.set(path, decoration)
    }
    return combined
  }, [gitSession])
  const nodes = useMemo(() => flattenExplorerTree(session, decorations, repositoryInfoByRoot), [decorations, repositoryInfoByRoot, session])
  const knownRepositoryRoots = useMemo(() => {
    const roots = new Set(Object.keys(gitSession.repositories).filter(Boolean))
    for (const node of nodes) {
      if (node.entry.repoKind || node.decoration?.repoKind) roots.add(node.path)
    }
    return [...roots].sort((left, right) => right.length - left.length)
  }, [gitSession.repositories, nodes])
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
  const workspaceLabel = useMemo(() => {
    const segments = workspaceFolder.replace(/[\\/]+$/, '').split(/[\\/]/)
    return segments[segments.length - 1] || workspaceFolder
  }, [workspaceFolder])
  const activeRepositoryLabel = gitSession.activeRepoRoot || 'Workspace root'

  useEffect(() => { void loadChildren(sessionId, workspaceFolder, '') }, [loadChildren, sessionId, workspaceFolder])

  const refreshVisibleTree = useCallback(async () => {
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const explorerState = useExplorerStore.getState().sessions[sessionId]
    const paths = explorerState ? [...explorerState.childrenByPath.keys()] : ['']
    for (const path of paths) {
      await loadChildren(sessionId, workspaceFolder, path)
      if (!workspaceOwnershipIsCurrent(ownership)) return
    }
    await refreshGit(sessionId, workspaceFolder)
    if (!workspaceOwnershipIsCurrent(ownership)) return
    const currentGit = useGitStore.getState().sessions[sessionId]
    if (!currentGit) return
    for (const repoRoot of Object.keys(currentGit.repositories)) {
      if (repoRoot && (explorerState?.expandedPaths.has(repoRoot) || currentGit.activeRepoRoot === repoRoot)) {
        await refreshRepository(sessionId, workspaceFolder, repoRoot)
        if (!workspaceOwnershipIsCurrent(ownership)) return
      }
    }
  }, [captureWorkspaceOwnership, loadChildren, refreshGit, refreshRepository, sessionId, workspaceFolder, workspaceOwnershipIsCurrent])

  const reloadPaths = useCallback(async (ownership: ExplorerWorkspaceOwnership, ...paths: string[]): Promise<boolean> => {
    if (!workspaceOwnershipIsCurrent(ownership)) return false
    const unique = new Set(paths.map(parentPath).concat(paths).filter((path) => session.childrenByPath.has(path) || path === ''))
    for (const path of unique) {
      await loadChildren(sessionId, workspaceFolder, path)
      if (!workspaceOwnershipIsCurrent(ownership)) return false
    }
    await refreshGit(sessionId, workspaceFolder)
    return workspaceOwnershipIsCurrent(ownership)
  }, [loadChildren, refreshGit, session.childrenByPath, sessionId, workspaceFolder, workspaceOwnershipIsCurrent])

  const toggleNode = useCallback(async (node: ExplorerNode) => {
    const ownership = captureWorkspaceOwnership()
    if (!ownership || !node.entry.isDir || node.entry.isSymlink) return
    const expanded = !node.expanded
    setExpanded(sessionId, node.path, expanded)
    if (!expanded) return
    const requests: Promise<unknown>[] = []
    if (!node.gitOnly && node.entry.repositoryInitialized !== false && !session.childrenByPath.has(node.path)) {
      requests.push(loadChildren(sessionId, workspaceFolder, node.path))
    }
    if ((node.entry.repoKind || node.decoration?.repoKind) && node.entry.repositoryInitialized !== false) {
      requests.push(refreshRepository(sessionId, workspaceFolder, node.path))
    }
    await Promise.all(requests)
    if (!workspaceOwnershipIsCurrent(ownership)) return
  }, [captureWorkspaceOwnership, loadChildren, refreshRepository, session.childrenByPath, sessionId, setExpanded, workspaceFolder, workspaceOwnershipIsCurrent])

  const repositoryRootForPath = useCallback((path: string) => knownRepositoryRoots.find((root) => path === root || path.startsWith(`${root}/`)) ?? '', [knownRepositoryRoots])
  const targetForPath = useCallback((path: string, repoRoot: string) => ({
    repoRoot,
    workspaceFolder: repositoryFolder(workspaceFolder, repoRoot),
    path: repoRoot ? path.slice(repoRoot.length).replace(/^\/+/, '') || '.' : path || '.',
  }), [workspaceFolder])
  const parentRepositoryRoot = useCallback((node: ExplorerNode) => repositoryRootForPath(node.parentPath), [repositoryRootForPath])
  const gitTargetForNode = useCallback((node: ExplorerNode) => targetForPath(node.path, repositoryRootForPath(node.path)), [repositoryRootForPath, targetForPath])

  const openPreview = useCallback(async (node: ExplorerNode | null = selectedNode, activate = true) => {
    if (!node || node.entry.isDir || node.gitOnly || !contentActions) return
    const ownership = captureWorkspaceOwnership()
    if (!workspaceOwnershipIsCurrent(ownership)) return
    try {
      await contentActions.openContent({
        kind: 'preview',
        relPath: node.path,
        activate,
        workspaceId: ownership.sessionId,
        workspaceEpoch: ownership.sessionEpoch,
      })
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [captureWorkspaceOwnership, contentActions, selectedNode, sessionId, setExplorerError, workspaceOwnershipIsCurrent])

  const selectNode = useCallback((node: ExplorerNode) => {
    setSelectedPath(sessionId, node.path)
    if (!node.entry.isDir && !node.gitOnly) void openPreview(node, false)
    if (node.entry.isDir || !node.decoration) return
    const target = gitTargetForNode(node)
    const area = node.decoration.conflicted || node.decoration.unstaged || node.decoration.untracked ? 'unstaged' : 'staged'
    setActiveRepository(sessionId, target.repoRoot)
    setGitSelectedPath(sessionId, node.path, target.repoRoot, area)
    setGitActiveTab(sessionId, 'changes')
  }, [gitTargetForNode, openPreview, sessionId, setActiveRepository, setGitActiveTab, setGitSelectedPath, setSelectedPath])

  const openVibeLinkEditor = useCallback(async (node: ExplorerNode, capturedOwnership?: ExplorerWorkspaceOwnership) => {
    if (!isVibeLinkEditorCandidate(node)) return
    const ownership = capturedOwnership ?? captureWorkspaceOwnership()
    if (!workspaceOwnershipIsCurrent(ownership)) return
    if (!contentActions) {
      setExplorerError(sessionId, 'VibeLink Editor is not available in this workspace layout.')
      return
    }
    try {
      if (!workspaceOwnershipIsCurrent(ownership)) return
      await contentActions.openContent({ kind: 'editor', relPath: node.path, workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
      if (!workspaceOwnershipIsCurrent(ownership)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [captureWorkspaceOwnership, contentActions, sessionId, setExplorerError, workspaceOwnershipIsCurrent])

  const reopenEditors = useCallback(async (paths: string[], ownership: ExplorerWorkspaceOwnership) => {
    if (!contentActions || !workspaceOwnershipIsCurrent(ownership)) return
    for (const path of paths) {
      try {
        if (!workspaceOwnershipIsCurrent(ownership)) return
        await contentActions.openContent({ kind: 'editor', relPath: path, workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
        if (!workspaceOwnershipIsCurrent(ownership)) return
      } catch (reason) {
        if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
        return
      }
    }
  }, [contentActions, sessionId, setExplorerError, workspaceOwnershipIsCurrent])

  const prepareEditorPathMutation = useCallback(async (path: string, ownership: ExplorerWorkspaceOwnership): Promise<string[] | null> => {
    if (!workspaceOwnershipIsCurrent(ownership)) return null
    const affected = editorDocuments.documentsUnder(path)
    if (await editorDocuments.preparePathMutation(path, browserEditorCloseDecision) === 'cancelled') return null
    if (!workspaceOwnershipIsCurrent(ownership)) return null
    const openPaths = affected.filter((document) => document.viewCount > 0).map((document) => document.relPath)
    if (openPaths.length === 0) return []
    if (!contentActions) {
      setExplorerError(sessionId, 'Close the open VibeLink Editor before renaming or deleting this path.')
      return null
    }
    const closed: string[] = []
    for (const openPath of openPaths) {
      if (!workspaceOwnershipIsCurrent(ownership)) return null
      const panelId = workspaceContentPanelId({ kind: 'editor', instanceId: openPath })
      let closeResult: 'closed' | 'cancelled'
      try {
        closeResult = await contentActions.requestCloseContent(panelId, { workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
        if (!workspaceOwnershipIsCurrent(ownership)) return null
      } catch (reason) {
        if (workspaceOwnershipIsCurrent(ownership)) {
          setExplorerError(sessionId, String(reason))
          await reopenEditors(closed, ownership)
        }
        return null
      }
      if (closeResult === 'cancelled') {
        await reopenEditors(closed, ownership)
        if (!workspaceOwnershipIsCurrent(ownership)) return null
        return null
      }
      closed.push(openPath)
    }
    return openPaths
  }, [contentActions, editorDocuments, reopenEditors, sessionId, setExplorerError, workspaceOwnershipIsCurrent])

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
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const destination = joinPath(parentPath(source), name)
    if (editorDocuments.documentsUnder(destination).some((document) => document.dirty || document.viewCount > 0)) {
      setExplorerError(sessionId, `Close or resolve the existing editor document at ${destination} before renaming.`)
      return
    }
    const openPaths = await prepareEditorPathMutation(source, ownership)
    if (!openPaths || !workspaceOwnershipIsCurrent(ownership)) return
    try {
      await invoke('fs_rename', { workspaceFolder: ownership.workspaceFolder, fromRel: source, toRel: destination })
      editorDocuments.applyDelete(destination)
      editorDocuments.applyRename(source, destination)
      if (!workspaceOwnershipIsCurrent(ownership)) return
      setSelectedPath(sessionId, destination)
      invalidatePath(sessionId, source)
      if (!await reloadPaths(ownership, source, destination)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) {
        await reopenEditors(openPaths, ownership)
        if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
      }
      return
    }
    await reopenEditors(openPaths.map((path) => path === source ? destination : `${destination}${path.slice(source.length)}`), ownership)
    if (!workspaceOwnershipIsCurrent(ownership)) return
  }, [captureWorkspaceOwnership, editorDocuments, invalidatePath, prepareEditorPathMutation, reloadPaths, renameValue, renamingPath, reopenEditors, sessionId, setExplorerError, setSelectedPath, workspaceOwnershipIsCurrent])

  const deleteNode = useCallback(async (node: ExplorerNode) => {
    setContextMenu(null)
    if (!window.confirm(`Delete ${node.name}? This cannot be undone.`)) return
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const openPaths = await prepareEditorPathMutation(node.path, ownership)
    if (!openPaths || !workspaceOwnershipIsCurrent(ownership)) return
    try {
      await invoke('fs_delete', { workspaceFolder: ownership.workspaceFolder, relPaths: [node.path] })
      editorDocuments.applyDelete(node.path)
      if (!workspaceOwnershipIsCurrent(ownership)) return
      if (session.selectedPath === node.path || session.selectedPath?.startsWith(`${node.path}/`)) setSelectedPath(sessionId, null)
      invalidatePath(sessionId, node.path)
      await reloadPaths(ownership, node.path)
      if (!workspaceOwnershipIsCurrent(ownership)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) {
        await reopenEditors(openPaths, ownership)
        if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
      }
    }
  }, [captureWorkspaceOwnership, editorDocuments, invalidatePath, prepareEditorPathMutation, reloadPaths, reopenEditors, session.selectedPath, sessionId, setExplorerError, setSelectedPath, workspaceOwnershipIsCurrent])

  const createEntry = useCallback(async (node: ExplorerNode | null, directory: boolean) => {
    setContextMenu(null)
    const name = window.prompt(directory ? 'Folder name' : 'File name')?.trim()
    if (!name) return
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const targetDir = node ? (node.entry.isDir ? node.path : node.parentPath) : ''
    const path = joinPath(targetDir, name)
    try {
      await invoke(directory ? 'fs_create_dir' : 'fs_create_file', { workspaceFolder: ownership.workspaceFolder, relPath: path })
      if (!workspaceOwnershipIsCurrent(ownership)) return
      if (node?.entry.isDir) setExpanded(sessionId, node.path, true)
      setSelectedPath(sessionId, path)
      await reloadPaths(ownership, targetDir)
      if (!workspaceOwnershipIsCurrent(ownership)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [captureWorkspaceOwnership, reloadPaths, sessionId, setExpanded, setExplorerError, setSelectedPath, workspaceOwnershipIsCurrent])

  const moveNode = useCallback(async (sourcePath: string, target: ExplorerNode) => {
    const source = nodes.find((node) => node.path === sourcePath)
    if (source?.entry.repoKind || target.entry.repoKind) return
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const targetDir = target.entry.isDir ? target.path : target.parentPath
    if (sourcePath === targetDir || targetDir.startsWith(`${sourcePath}/`)) return
    const destination = joinPath(targetDir, sourcePath.split('/').pop() ?? '')
    if (destination === sourcePath) return
    if (editorDocuments.documentsUnder(destination).some((document) => document.dirty || document.viewCount > 0)) {
      setExplorerError(sessionId, `Close or resolve the existing editor document at ${destination} before moving.`)
      return
    }
    const openPaths = await prepareEditorPathMutation(sourcePath, ownership)
    if (!openPaths || !workspaceOwnershipIsCurrent(ownership)) return
    try {
      await invoke('fs_rename', { workspaceFolder: ownership.workspaceFolder, fromRel: sourcePath, toRel: destination })
      editorDocuments.applyDelete(destination)
      editorDocuments.applyRename(sourcePath, destination)
      if (!workspaceOwnershipIsCurrent(ownership)) return
      setSelectedPath(sessionId, destination)
      invalidatePath(sessionId, sourcePath)
      if (!await reloadPaths(ownership, sourcePath, destination, targetDir)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) {
        await reopenEditors(openPaths, ownership)
        if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
      }
      return
    }
    await reopenEditors(openPaths.map((path) => path === sourcePath ? destination : `${destination}${path.slice(sourcePath.length)}`), ownership)
    if (!workspaceOwnershipIsCurrent(ownership)) return
  }, [captureWorkspaceOwnership, editorDocuments, invalidatePath, nodes, prepareEditorPathMutation, reloadPaths, reopenEditors, sessionId, setExplorerError, setSelectedPath, workspaceOwnershipIsCurrent])

  const openGit = useCallback(async (node: ExplorerNode, history: boolean, capturedOwnership?: ExplorerWorkspaceOwnership) => {
    setContextMenu(null)
    const ownership = capturedOwnership ?? captureWorkspaceOwnership()
    if (!workspaceOwnershipIsCurrent(ownership)) return
    const target = gitTargetForNode(node)
    const area = node.decoration?.conflicted || node.decoration?.unstaged || node.decoration?.untracked ? 'unstaged' : 'staged'
    setActiveRepository(sessionId, target.repoRoot)
    setGitSelectedPath(sessionId, node.path, target.repoRoot, area)
    setGitActiveTab(sessionId, history ? 'history' : 'changes', history ? target.path : null)
    if (target.repoRoot) void refreshRepository(sessionId, ownership.workspaceFolder, target.repoRoot)
    if (!contentActions || !workspaceOwnershipIsCurrent(ownership)) return
    try {
      await contentActions.openContent({ kind: history ? 'gitHistory' : 'sourceControl', workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
      if (!history && workspaceOwnershipIsCurrent(ownership)) {
        await contentActions.openContent({ kind: 'workbench', workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
      }
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [captureWorkspaceOwnership, contentActions, gitTargetForNode, refreshRepository, sessionId, setActiveRepository, setExplorerError, setGitActiveTab, setGitSelectedPath, workspaceOwnershipIsCurrent])

  const openRepository = useCallback(async (node: ExplorerNode, tab: 'changes' | 'history') => {
    setContextMenu(null)
    const ownership = captureWorkspaceOwnership()
    if (!ownership || node.entry.repositoryInitialized === false) return
    setActiveRepository(sessionId, node.path)
    setGitSelectedPath(sessionId, null, node.path, null)
    setGitActiveTab(sessionId, tab, null)
    void refreshRepository(sessionId, ownership.workspaceFolder, node.path)
    void refreshHosting(sessionId, ownership.workspaceFolder, 'HEAD', false, node.path)
    if (!contentActions || !workspaceOwnershipIsCurrent(ownership)) return
    try {
      await contentActions.openContent({ kind: tab === 'history' ? 'gitHistory' : 'sourceControl', workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
      if (tab === 'changes' && workspaceOwnershipIsCurrent(ownership)) {
        await contentActions.openContent({ kind: 'workbench', workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
      }
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [captureWorkspaceOwnership, contentActions, refreshHosting, refreshRepository, sessionId, setActiveRepository, setExplorerError, setGitActiveTab, setGitSelectedPath, workspaceOwnershipIsCurrent])

  const openPointerHistory = useCallback(async (node: ExplorerNode) => {
    setContextMenu(null)
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const repoRoot = parentRepositoryRoot(node)
    const target = targetForPath(node.path, repoRoot)
    setActiveRepository(sessionId, repoRoot)
    setGitSelectedPath(sessionId, null, repoRoot, null)
    setGitActiveTab(sessionId, 'history', target.path)
    if (repoRoot) void refreshRepository(sessionId, ownership.workspaceFolder, repoRoot)
    if (!contentActions || !workspaceOwnershipIsCurrent(ownership)) return
    try {
      await contentActions.openContent({ kind: 'gitHistory', workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [captureWorkspaceOwnership, contentActions, parentRepositoryRoot, refreshRepository, sessionId, setActiveRepository, setExplorerError, setGitActiveTab, setGitSelectedPath, targetForPath, workspaceOwnershipIsCurrent])

  const mutateGit = useCallback(async (command: 'git_stage' | 'git_unstage' | 'git_conflict_take', node: ExplorerNode, extra: Record<string, unknown> = {}) => {
    setContextMenu(null)
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const repoRoot = node.entry.repoKind ? parentRepositoryRoot(node) : repositoryRootForPath(node.path)
    const target = targetForPath(node.path, repoRoot)
    await runGitMutation(sessionId, ownership.workspaceFolder, () => invoke(command, { workspaceFolder: target.workspaceFolder, paths: [target.path], ...extra }), repoRoot)
    if (!workspaceOwnershipIsCurrent(ownership)) return
  }, [captureWorkspaceOwnership, parentRepositoryRoot, repositoryRootForPath, runGitMutation, sessionId, targetForPath, workspaceOwnershipIsCurrent])

  const discardGit = useCallback(async (node: ExplorerNode) => {
    setContextMenu(null)
    const targetName = node.entry.isDir ? `${node.name} and its changed descendants` : node.name
    const untracked = Boolean(node.decoration?.untracked || node.changeSummary?.untracked)
    const message = untracked
      ? `Discard ${targetName}? Untracked paths will be moved to the Recycle Bin.`
      : `Discard changes in ${targetName}? This cannot be undone.`
    if (!window.confirm(message)) return
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const target = gitTargetForNode(node)
    await runGitMutation(sessionId, ownership.workspaceFolder, () => invoke('git_discard', { workspaceFolder: target.workspaceFolder, paths: [target.path] }), target.repoRoot)
    if (!workspaceOwnershipIsCurrent(ownership)) return
    await reloadPaths(ownership, node.path)
    if (!workspaceOwnershipIsCurrent(ownership)) return
  }, [captureWorkspaceOwnership, gitTargetForNode, reloadPaths, runGitMutation, sessionId, workspaceOwnershipIsCurrent])

  const mutateSubmodule = useCallback(async (command: 'git_submodule_update' | 'git_submodule_sync', node: ExplorerNode) => {
    setContextMenu(null)
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    const repoRoot = parentRepositoryRoot(node)
    const target = targetForPath(node.path, repoRoot)
    try {
      await runGitMutation(sessionId, ownership.workspaceFolder, () => invoke(command, { workspaceFolder: target.workspaceFolder, path: target.path }), repoRoot)
      if (!workspaceOwnershipIsCurrent(ownership)) return
      await loadChildren(sessionId, ownership.workspaceFolder, node.parentPath)
      if (!workspaceOwnershipIsCurrent(ownership)) return
      if (command === 'git_submodule_update') {
        await refreshRepository(sessionId, ownership.workspaceFolder, node.path)
        if (!workspaceOwnershipIsCurrent(ownership)) return
        await loadChildren(sessionId, ownership.workspaceFolder, node.path)
        if (!workspaceOwnershipIsCurrent(ownership)) return
      }
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [captureWorkspaceOwnership, loadChildren, parentRepositoryRoot, refreshRepository, runGitMutation, sessionId, setExplorerError, targetForPath, workspaceOwnershipIsCurrent])

  const absolutePath = useCallback((path: string) => `${workspaceFolder.replace(/[\\/]+$/, '')}\\${path.replace(/\//g, '\\')}`, [workspaceFolder])
  const openTerminal = useCallback(async (node: ExplorerNode) => {
    const ownership = captureWorkspaceOwnership()
    if (!ownership || !contentActions) return
    const cwd = absolutePath(node.entry.isDir ? node.path : node.parentPath)
    if (!workspaceOwnershipIsCurrent(ownership)) return
    try {
      await contentActions.openContent({ kind: 'terminal', cwd, workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
      if (!workspaceOwnershipIsCurrent(ownership)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [absolutePath, captureWorkspaceOwnership, contentActions, sessionId, setExplorerError, workspaceOwnershipIsCurrent])

  const openSystemPath = useCallback(async (node: ExplorerNode, capturedOwnership?: ExplorerWorkspaceOwnership) => {
    const ownership = capturedOwnership ?? captureWorkspaceOwnership()
    if (!workspaceOwnershipIsCurrent(ownership) || node.gitOnly || node.entry.isDir) return
    try {
      await invoke('open_path', { path: absolutePath(node.path) })
      if (!workspaceOwnershipIsCurrent(ownership)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [absolutePath, captureWorkspaceOwnership, sessionId, setExplorerError, workspaceOwnershipIsCurrent])

  const openExternalEditor = useCallback(async (node: ExplorerNode) => {
    const ownership = captureWorkspaceOwnership()
    if (!ownership || !editorCommand) return
    try {
      await invoke('open_in_editor', { workspaceFolder: ownership.workspaceFolder, relPath: node.path, editorCommand })
      if (!workspaceOwnershipIsCurrent(ownership)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [captureWorkspaceOwnership, editorCommand, sessionId, setExplorerError, workspaceOwnershipIsCurrent])

  const revealSystemPath = useCallback(async (node: ExplorerNode) => {
    const ownership = captureWorkspaceOwnership()
    if (!ownership) return
    try {
      await invoke('reveal_path', { path: absolutePath(node.path) })
      if (!workspaceOwnershipIsCurrent(ownership)) return
    } catch (reason) {
      if (workspaceOwnershipIsCurrent(ownership)) setExplorerError(sessionId, String(reason))
    }
  }, [absolutePath, captureWorkspaceOwnership, sessionId, setExplorerError, workspaceOwnershipIsCurrent])

  const openSelectedNode = useCallback(async (node: ExplorerNode) => {
    const ownership = captureWorkspaceOwnership()
    if (!ownership || node.entry.isDir) return
    if (node.gitOnly) {
      if (node.decoration) await openGit(node, false, ownership)
      return
    }
    if (isImagePath(node.name) || !isVibeLinkEditorCandidate(node) || !contentActions) {
      await openSystemPath(node, ownership)
      return
    }
    try {
      const probe = await invoke<TextFile>('fs_read_text', { workspaceFolder: ownership.workspaceFolder, relPath: node.path })
      if (!workspaceOwnershipIsCurrent(ownership)) return
      if (probe.binary) {
        await openSystemPath(node, ownership)
        return
      }
    } catch {
      if (!workspaceOwnershipIsCurrent(ownership)) return
      await openSystemPath(node, ownership)
      return
    }
    if (workspaceOwnershipIsCurrent(ownership)) await openVibeLinkEditor(node, ownership)
  }, [captureWorkspaceOwnership, contentActions, openGit, openSystemPath, openVibeLinkEditor, workspaceOwnershipIsCurrent])

  const actionsFor = useCallback((node: ExplorerNode) => {
    const repoKind = node.entry.repoKind ?? node.decoration?.repoKind ?? null
    const isRepository = Boolean(repoKind)
    const isSubmodule = repoKind === 'submodule'
    const initialized = node.entry.repositoryInitialized !== false
    const staged = Boolean(node.decoration?.staged || node.changeSummary?.staged)
    const unstaged = Boolean(node.decoration?.unstaged || node.decoration?.untracked || node.changeSummary?.unstaged || node.changeSummary?.untracked)
    const conflicted = Boolean(node.decoration?.conflicted || node.changeSummary?.conflicted)
    const changed = staged || unstaged || conflicted
    const present = !node.gitOnly && initialized
    const canStage = unstaged && (!isSubmodule || Boolean(node.decoration?.submoduleState?.commitChanged))
    const wrap = (action: () => void | Promise<void>) => () => {
      setContextMenu(null)
      void Promise.resolve().then(action).catch((reason) => {
        if (captureWorkspaceOwnership()) setExplorerError(sessionId, String(reason))
      })
    }
    const actions: ExplorerContextAction[] = []
    if (!node.entry.isDir) {
      actions.push(
        { id: 'open', label: 'Open', disabled: !present, onClick: wrap(() => openSelectedNode(node)) },
        { id: 'preview', label: 'Open Preview', disabled: !present || !contentActions, onClick: wrap(() => openPreview(node, true)) },
        { id: 'vibelink-editor', label: 'Open in VibeLink Editor', disabled: !present || !isVibeLinkEditorCandidate(node) || !contentActions, onClick: wrap(() => openVibeLinkEditor(node)) },
        { id: 'external-editor', label: 'Open in External Editor', disabled: !present || !editorCommand, onClick: wrap(() => openExternalEditor(node)) },
      )
    }
    if (isRepository) {
      actions.push(
        { id: 'repo-changes', label: 'Open Repository Changes', disabled: !initialized, onClick: wrap(() => openRepository(node, 'changes')) },
        { id: 'repo-history', label: 'Open Repository History', disabled: !initialized, onClick: wrap(() => openRepository(node, 'history')) },
      )
      if (isSubmodule) {
        actions.push(
          { id: 'pointer-history', label: 'Pointer History in Parent', onClick: wrap(() => openPointerHistory(node)) },
          { id: 'submodule-update', label: initialized ? 'Update to Recorded Commit' : 'Initialize Submodule', onClick: wrap(() => mutateSubmodule('git_submodule_update', node)) },
          { id: 'submodule-sync', label: 'Sync Submodule URL', onClick: wrap(() => mutateSubmodule('git_submodule_sync', node)) },
        )
      }
    }
    actions.push(
      { id: 'new-file', label: 'New File', disabled: !present, onClick: wrap(() => createEntry(node, false)) },
      { id: 'new-folder', label: 'New Folder', disabled: !present, onClick: wrap(() => createEntry(node, true)) },
      { id: 'rename', label: 'Rename', disabled: !present || isRepository, onClick: wrap(() => beginRename(node)) },
      { id: 'delete', label: 'Delete', disabled: !present || isRepository, danger: true, onClick: wrap(() => deleteNode(node)) },
      { id: 'terminal', label: 'Open in Terminal', disabled: !present, onClick: wrap(() => openTerminal(node)) },
      { id: 'reveal', label: 'Reveal in File Explorer', disabled: !present, onClick: wrap(() => revealSystemPath(node)) },
      { id: 'copy-rel', label: 'Copy Relative Path', onClick: wrap(() => navigator.clipboard.writeText(node.path)) },
      { id: 'copy-abs', label: 'Copy Absolute Path', onClick: wrap(() => navigator.clipboard.writeText(absolutePath(node.path))) },
    )
    if (canStage) actions.push({ id: 'stage', label: node.entry.isDir ? 'Stage Folder Changes' : 'Stage Changes', onClick: wrap(() => mutateGit('git_stage', node)) })
    if (staged) actions.push({ id: 'unstage', label: node.entry.isDir ? 'Unstage Folder Changes' : 'Unstage Changes', onClick: wrap(() => mutateGit('git_unstage', node)) })
    if (unstaged && !isRepository) actions.push({ id: 'discard', label: node.entry.isDir ? 'Discard Folder Changes' : 'Discard Changes', danger: true, onClick: wrap(() => discardGit(node)) })
    if (node.decoration?.conflicted && !node.entry.isDir) {
      actions.push({ id: 'ours', label: 'Accept Ours', onClick: wrap(() => mutateGit('git_conflict_take', node, { side: 'ours' })) })
      actions.push({ id: 'theirs', label: 'Accept Theirs', onClick: wrap(() => mutateGit('git_conflict_take', node, { side: 'theirs' })) })
    }
    if (!node.entry.isDir && changed) actions.push({ id: 'diff', label: 'Diff vs HEAD', onClick: wrap(() => openGit(node, false)) })
    if (!isRepository) actions.push({ id: 'history', label: node.entry.isDir ? 'Folder History' : 'File History', onClick: wrap(() => openGit(node, true)) })
    return actions
  }, [absolutePath, beginRename, captureWorkspaceOwnership, contentActions, createEntry, deleteNode, discardGit, editorCommand, mutateGit, mutateSubmodule, openExternalEditor, openGit, openPointerHistory, openPreview, openRepository, openSelectedNode, openTerminal, openVibeLinkEditor, revealSystemPath, sessionId, setExplorerError])

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (nodes.length === 0 || event.altKey || event.ctrlKey || event.metaKey) return
    const index = nodes.findIndex((node) => node.path === session.selectedPath)
    const node = index >= 0 ? nodes[index] : null
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      const nextIndex = index < 0 ? (direction > 0 ? 0 : nodes.length - 1) : index + direction
      if (nextIndex < 0 || nextIndex >= nodes.length || nextIndex === index) return
      selectNode(nodes[nextIndex])
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      const nextIndex = event.key === 'Home' ? 0 : nodes.length - 1
      if (nextIndex !== index) selectNode(nodes[nextIndex])
      return
    }
    if (!node) return
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      if (!node.entry.isDir || node.entry.isSymlink) return
      if (!node.expanded) {
        void toggleNode(node)
        return
      }
      const child = nodes[index + 1]
      if (child?.parentPath === node.path) selectNode(child)
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      if (node.entry.isDir && node.expanded) {
        void toggleNode(node)
        return
      }
      if (node.parentPath) {
        const parent = nodes.find((candidate) => candidate.path === node.parentPath)
        if (parent) selectNode(parent)
      }
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if (node.entry.isDir) void toggleNode(node)
      else void openSelectedNode(node)
      return
    }
    if (event.key === ' ') {
      event.preventDefault()
      if (!node.entry.isDir) void openPreview(node, true)
      return
    }
    if (event.key === 'F2' && !node.gitOnly && !node.entry.repoKind) { event.preventDefault(); beginRename(node) }
    else if (event.key === 'Delete' && !node.gitOnly && !node.entry.repoKind) { event.preventDefault(); void deleteNode(node) }
  }, [beginRename, deleteNode, nodes, openPreview, openSelectedNode, selectNode, session.selectedPath, toggleNode])

  return {
    session,
    nodes,
    selectedNode,
    statusSummary,
    statusPresentation: gitStatusPresentation,
    workspaceLabel,
    workspaceFolder,
    activeRepositoryLabel,
    renamingPath,
    renameValue,
    contextMenu,
    dragOverPath,
    refresh: refreshVisibleTree,
    createFile: () => createEntry(selectedNode, false),
    createFolder: () => createEntry(selectedNode, true),
    openPreview: () => openPreview(selectedNode, true),
    selectNode,
    openNode: openSelectedNode,
    toggleNode,
    handleKeyDown,
    setRenameValue,
    commitRename,
    cancelRename: () => setRenamingPath(null),
    closeContextMenu: () => setContextMenu(null),
    openContextMenu: (event: React.MouseEvent, node: ExplorerNode) => {
      event.preventDefault()
      selectNode(node)
      setContextMenu({ x: event.clientX, y: event.clientY, path: node.path, actions: actionsFor(node) })
    },
    startDrag: (node: ExplorerNode) => { draggedPathRef.current = node.entry.repoKind ? null : node.path },
    dragOver: (event: React.DragEvent, node: ExplorerNode) => {
      if (!node.entry.repoKind) {
        event.preventDefault()
        setDragOverPath(node.path)
      }
    },
    dragLeave: () => setDragOverPath(null),
    drop: (event: React.DragEvent, node: ExplorerNode) => {
      event.preventDefault()
      setDragOverPath(null)
      const source = draggedPathRef.current
      draggedPathRef.current = null
      if (source) void moveNode(source, node)
    },
  }
}

function isVibeLinkEditorCandidate(node: ExplorerNode): boolean {
  if (node.entry.isDir || node.entry.isSymlink || node.gitOnly) return false
  const extension = node.name.split('.').pop()?.toLowerCase() ?? ''
  return !IMAGE_EXTENSION[extension]
}

function isImagePath(path: string): boolean {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  return Boolean(IMAGE_EXTENSION[extension])
}

import { invoke } from '@tauri-apps/api/core'
import { lazy, Suspense, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { DirEntryInfo, TextFile } from '../../ipc/types'
import { WorkspaceContentActionsContext } from '../../layout/contentActions'
import { deriveGitDecorations, parentPath } from '../../state/explorer'
import { emptyGitSessionState, repositoryStateFor, useGitStore } from '../../state/git'
import { getWorkspaceSessionEpoch, getWorkspaceSessionReadyEpoch, getWorkspaceSessionTargetId, useWorkspaceStore } from '../../state/store'
import { ExplorerViewerView } from './ExplorerViewerView'
import { IMAGE_MIME_BY_EXTENSION } from './previewFileTypes'

const MarkdownPreview = lazy(() => import('./MarkdownPreview').then((module) => ({ default: module.MarkdownPreview })))

export type PreviewContentPanelProps = {
  sessionId: string
  workspaceFolder: string
  relPath: string
}

type PreviewState = {
  requestKey: string
  entry: DirEntryInfo | null
  textFile: TextFile | null
  imageSrc: string | null
  workingTreePresent: boolean
  loading: boolean
  error: string | null
}

type PreviewOwnership = { sessionId: string; sessionEpoch: number; workspaceFolder: string }


function loadingPreviewState(relPath: string): PreviewState {
  const name = relPath.split('/').pop() ?? relPath
  return {
    requestKey: relPath,
    entry: { name, isDir: false, isSymlink: false, size: 0, modifiedAt: null },
    textFile: null,
    imageSrc: null,
    workingTreePresent: true,
    loading: true,
    error: null,
  }
}

export function PreviewContentPanel({ sessionId, workspaceFolder, relPath }: PreviewContentPanelProps) {
  const contentActions = useContext(WorkspaceContentActionsContext)
  const editorCommand = useWorkspaceStore((state) => state.settings.externalEditorCommand).trim()
  const gitSession = useGitStore((state) => state.sessions[sessionId] ?? emptyGitSessionState)
  const setActiveRepository = useGitStore((state) => state.setActiveRepository)
  const setGitSelectedPath = useGitStore((state) => state.setSelectedPath)
  const setGitActiveTab = useGitStore((state) => state.setActiveTab)
  const [preview, setPreview] = useState<PreviewState>(() => loadingPreviewState(relPath))
  const [imageFitState, setImageFitState] = useState({ relPath, value: true })
  const visiblePreview = preview.requestKey === relPath ? preview : loadingPreviewState(relPath)
  const imageFit = imageFitState.relPath === relPath ? imageFitState.value : true

  const captureOwnership = useCallback((): PreviewOwnership | null => {
    const state = useWorkspaceStore.getState()
    const sessionEpoch = getWorkspaceSessionEpoch()
    const currentFolder = state.sessions.find((candidate) => candidate.id === sessionId)?.workspaceFolder ?? null
    if (state.activeSessionId !== sessionId
      || currentFolder !== workspaceFolder
      || getWorkspaceSessionReadyEpoch() !== sessionEpoch
      || getWorkspaceSessionTargetId() !== sessionId) return null
    return { sessionId, sessionEpoch, workspaceFolder }
  }, [sessionId, workspaceFolder])

  const ownershipIsCurrent = useCallback((ownership: PreviewOwnership | null): ownership is PreviewOwnership => {
    if (!ownership) return false
    const state = useWorkspaceStore.getState()
    return state.activeSessionId === ownership.sessionId
      && getWorkspaceSessionEpoch() === ownership.sessionEpoch
      && getWorkspaceSessionReadyEpoch() === ownership.sessionEpoch
      && getWorkspaceSessionTargetId() === ownership.sessionId
      && state.sessions.find((candidate) => candidate.id === ownership.sessionId)?.workspaceFolder === ownership.workspaceFolder
  }, [])

  const decorations = useMemo(() => {
    const combined = deriveGitDecorations(repositoryStateFor(gitSession, '').status)
    for (const [repoRoot, repository] of Object.entries(gitSession.repositories)) {
      if (!repoRoot || !repository.status) continue
      for (const [path, decoration] of deriveGitDecorations(repository.status, repoRoot, repoRoot)) combined.set(path, decoration)
    }
    return combined
  }, [gitSession])
  const decoration = decorations.get(relPath) ?? null
  const knownRepositoryRoots = useMemo(() => Object.keys(gitSession.repositories).filter(Boolean).sort((left, right) => right.length - left.length), [gitSession.repositories])
  const hasDecoration = Boolean(decoration)
  const repositoryRoot = decoration?.repoRoot ?? knownRepositoryRoots.find((root) => relPath === root || relPath.startsWith(`${root}/`)) ?? ''
  const repositoryLabel = repositoryRoot || 'Workspace root'
  const workspaceLabel = workspaceFolder.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || workspaceFolder
  const absolutePath = `${workspaceFolder.replace(/[\\/]+$/, '')}\\${relPath.replace(/\//g, '\\')}`

  useEffect(() => {
    const ownership = captureOwnership()
    if (!ownership) return
    let cancelled = false
    const name = relPath.split('/').pop() ?? relPath
    const placeholder: DirEntryInfo = { name, isDir: false, isSymlink: false, size: 0, modifiedAt: null }
    const load = async () => {
      const directory = parentPath(relPath)
      const entries = await invoke<DirEntryInfo[]>('fs_list_dir', { workspaceFolder: ownership.workspaceFolder, relPath: directory })
      if (cancelled || !ownershipIsCurrent(ownership)) return
      const entry = entries.find((candidate) => candidate.name === name) ?? null
      if (!entry) {
        if (hasDecoration) {
          setPreview({ requestKey: relPath, entry: placeholder, textFile: null, imageSrc: null, workingTreePresent: false, loading: false, error: null })
          return
        }
        throw new Error(`File does not exist: ${relPath}`)
      }
      if (entry.isDir) {
        setPreview({ requestKey: relPath, entry, textFile: null, imageSrc: null, workingTreePresent: true, loading: false, error: null })
        return
      }
      const extension = extensionForPath(relPath)
      if (IMAGE_MIME_BY_EXTENSION[extension]) {
        const base64 = await invoke<string>('fs_read_image', { workspaceFolder: ownership.workspaceFolder, relPath })
        if (cancelled || !ownershipIsCurrent(ownership)) return
        setPreview({ requestKey: relPath, entry, textFile: null, imageSrc: `data:${IMAGE_MIME_BY_EXTENSION[extension]};base64,${base64}`, workingTreePresent: true, loading: false, error: null })
        return
      }
      if (extension === 'pdf') {
        if (cancelled || !ownershipIsCurrent(ownership)) return
        setPreview({
          requestKey: relPath,
          entry,
          textFile: { content: '', truncated: false, binary: true },
          imageSrc: null,
          workingTreePresent: true,
          loading: false,
          error: null,
        })
        return
      }
      const textFile = await invoke<TextFile>('fs_read_text', { workspaceFolder: ownership.workspaceFolder, relPath })
      if (cancelled || !ownershipIsCurrent(ownership)) return
      setPreview({ requestKey: relPath, entry, textFile, imageSrc: null, workingTreePresent: true, loading: false, error: null })
    }
    void load().catch((reason) => {
      if (!cancelled && ownershipIsCurrent(ownership)) {
        setPreview({ requestKey: relPath, entry: placeholder, textFile: null, imageSrc: null, workingTreePresent: false, loading: false, error: reason instanceof Error ? reason.message : String(reason) })
      }
    })
    return () => { cancelled = true }
  }, [captureOwnership, hasDecoration, ownershipIsCurrent, relPath])

  const openEditor = useCallback(async () => {
    const ownership = captureOwnership()
    if (!contentActions || !ownershipIsCurrent(ownership)) return
    await contentActions.openContent({ kind: 'editor', relPath, workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
  }, [captureOwnership, contentActions, ownershipIsCurrent, relPath])

  const openChanges = useCallback(async () => {
    const ownership = captureOwnership()
    if (!contentActions || !ownershipIsCurrent(ownership) || !decoration) return
    const area = decoration.conflicted || decoration.unstaged || decoration.untracked ? 'unstaged' : 'staged'
    setActiveRepository(sessionId, repositoryRoot)
    setGitSelectedPath(sessionId, relPath, repositoryRoot, area)
    setGitActiveTab(sessionId, 'changes')
    await contentActions.openContent({ kind: 'sourceControl', workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
    if (ownershipIsCurrent(ownership)) await contentActions.openContent({ kind: 'workbench', workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
  }, [captureOwnership, contentActions, decoration, ownershipIsCurrent, relPath, repositoryRoot, sessionId, setActiveRepository, setGitActiveTab, setGitSelectedPath])

  const openTerminal = useCallback(async () => {
    const ownership = captureOwnership()
    if (!contentActions || !ownershipIsCurrent(ownership)) return
    const directory = visiblePreview.entry?.isDir ? relPath : parentPath(relPath)
    const cwd = directory ? `${workspaceFolder.replace(/[\\/]+$/, '')}\\${directory.replace(/\//g, '\\')}` : workspaceFolder
    await contentActions.openContent({ kind: 'terminal', cwd, workspaceId: ownership.sessionId, workspaceEpoch: ownership.sessionEpoch })
  }, [captureOwnership, contentActions, ownershipIsCurrent, relPath, visiblePreview.entry?.isDir, workspaceFolder])

  return (
    <ExplorerViewerView
      path={relPath}
      workspaceLabel={workspaceLabel}
      workspacePath={workspaceFolder}
      repositoryLabel={repositoryLabel}
      entry={visiblePreview.entry}
      textFile={visiblePreview.textFile}
      textPreview={['md', 'markdown'].includes(extensionForPath(relPath)) && visiblePreview.textFile && !visiblePreview.textFile.binary
        ? <Suspense fallback={null}><MarkdownPreview content={visiblePreview.textFile.content} workspaceFolder={workspaceFolder} relPath={relPath} /></Suspense>
        : undefined}
      imageSrc={visiblePreview.imageSrc}
      loading={visiblePreview.loading}
      error={visiblePreview.error}
      imageFit={imageFit}
      canOpenVibeLinkEditor={Boolean(visiblePreview.workingTreePresent && visiblePreview.textFile && !visiblePreview.textFile.binary)}
      canOpenExternalEditor={Boolean(editorCommand)}
      canOpenDiff={Boolean(decoration)}
      canOpenDefault={Boolean(visiblePreview.workingTreePresent && visiblePreview.entry && !visiblePreview.entry.isDir && (visiblePreview.entry.isSymlink || visiblePreview.imageSrc || visiblePreview.textFile?.binary))}
      workingTreePresent={visiblePreview.workingTreePresent}
      onToggleImageFit={() => setImageFitState((current) => ({ relPath, value: current.relPath === relPath ? !current.value : false }))}
      onOpenVibeLinkEditor={() => { void openEditor() }}
      onOpenDefault={() => { void invoke('open_path', { path: absolutePath }) }}
      onOpenExternalEditor={() => { void invoke('open_in_editor', { workspaceFolder, relPath, editorCommand }) }}
      onOpenDiff={() => { void openChanges() }}
      onOpenTerminal={() => { void openTerminal() }}
      onReveal={() => { void invoke('reveal_path', { path: absolutePath }) }}
      onCopyPath={() => { void navigator.clipboard.writeText(absolutePath) }}
    />
  )
}

function extensionForPath(path: string): string {
  return path.split('.').pop()?.toLowerCase() ?? ''
}

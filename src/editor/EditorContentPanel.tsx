import MonacoEditorComponent from '@monaco-editor/react'
import { useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentType } from 'react'
import { AlertTriangle, Check, ChevronRight, Columns2, CopyPlus, FileCode2, FolderOpen, GitCompareArrows, History, Map, MoreHorizontal, RefreshCw, RotateCcw, Save, SaveAll, WrapText } from 'lucide-react'
import { WorkspaceContentActionsContext } from '../layout/contentActions'
import { deriveGitDecorations, parentPath, useExplorerStore } from '../state/explorer'
import { emptyGitSessionState, repositoryStateFor, useGitStore } from '../state/git'
import { getWorkspaceSessionEpoch, getWorkspaceSessionReadyEpoch, getWorkspaceSessionTargetId, useWorkspaceStore } from '../state/store'
import {
  getEditorDocumentStore,
  type EditorDocument,
  type EditorTextModel,
} from './documentStore'
import { languageForPath, languageLabel } from './languageForPath'
import { monaco } from './monaco'
import { registerVibeLinkMonacoThemes, vibeLinkMonacoThemeName } from './monacoTheme'
import { registerEditorNavigation, type EditorNavigationTarget } from './editorNavigation'
import './EditorContentPanel.css'
import { promptDialog } from '../components/appDialogStore'

type Disposable = { dispose(): void }
type MonacoModelOptions = { tabSize: number; insertSpaces: boolean }
type MonacoEditorTextModel = EditorTextModel & {
  getOptions?(): MonacoModelOptions
  getLanguageId?(): string
}

export type MonacoEditorHandle = {
  getModel(): MonacoEditorTextModel | null
  getPosition(): { lineNumber: number; column: number } | null
  setPosition(position: { lineNumber: number; column: number }): void
  revealPositionInCenter(position: { lineNumber: number; column: number }): void
  focus(): void
  layout(dimension?: { width: number; height: number }): void
  updateOptions(options: Record<string, unknown>): void
  onDidChangeCursorPosition(listener: (event: { position: { lineNumber: number; column: number } }) => void): Disposable
  onDidChangeModelOptions(listener: () => void): Disposable
}

export type MonacoEditorSurfaceProps = {
  path: string
  value: string
  language?: string
  theme?: string
  keepCurrentModel?: boolean
  options?: Record<string, unknown>
  onChange?: (value: string | undefined) => void
  onMount?: (editor: MonacoEditorHandle) => void
}

export type EditorContentPanelProps = {
  sessionId: string
  workspaceFolder: string
  relPath: string
  MonacoEditor?: ComponentType<MonacoEditorSurfaceProps>
  onSavedAs?: (relPath: string) => void | Promise<void>
}

const DefaultMonacoEditor = MonacoEditorComponent as ComponentType<MonacoEditorSurfaceProps>

export function EditorContentPanel({ sessionId, workspaceFolder, relPath, MonacoEditor = DefaultMonacoEditor, onSavedAs }: EditorContentPanelProps) {
  const store = useMemo(() => getEditorDocumentStore(sessionId, workspaceFolder), [sessionId, workspaceFolder])
  const contentActions = useContext(WorkspaceContentActionsContext)
  const document = useSyncExternalStore(store.subscribe, () => store.getDocument(relPath), () => store.getDocument(relPath))
  const terminalThemeId = useWorkspaceStore((state) => state.settings.terminalThemeId)
  const editorWordWrap = useWorkspaceStore((state) => state.settings.editorWordWrap)
  const editorMinimap = useWorkspaceStore((state) => state.settings.editorMinimap)
  const updateSettings = useWorkspaceStore((state) => state.updateSettings)
  const gitSession = useGitStore((state) => state.sessions[sessionId] ?? emptyGitSessionState)
  const setActiveRepository = useGitStore((state) => state.setActiveRepository)
  const setGitSelectedPath = useGitStore((state) => state.setSelectedPath)
  const setGitActiveTab = useGitStore((state) => state.setActiveTab)
  const [compareVisible, setCompareVisible] = useState(false)
  const [overflowOpen, setOverflowOpen] = useState(false)
  const [cursor, setCursor] = useState({ lineNumber: 1, column: 1 })
  const [indentation, setIndentation] = useState('Spaces: 4')
  const editorRef = useRef<MonacoEditorHandle | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const editorListenersRef = useRef<Disposable[]>([])
  const pendingNavigationRef = useRef<EditorNavigationTarget | null>(null)
  const navigationFramesRef = useRef<number[]>([])

  useEffect(() => {
    store.setRefreshHooks({
      afterSave: async (savedPath) => {
        const gitStore = useGitStore.getState()
        const currentGit = gitStore.sessions[sessionId]
        const repositoryRoot = Object.keys(currentGit?.repositories ?? {})
          .filter((root) => root && (savedPath === root || savedPath.startsWith(`${root}/`)))
          .sort((left, right) => right.length - left.length)[0] ?? ''
        await Promise.all([
          useExplorerStore.getState().loadChildren(sessionId, workspaceFolder, parentPath(savedPath)),
          gitStore.refreshRepository(sessionId, workspaceFolder, repositoryRoot),
          ...(repositoryRoot ? [gitStore.refreshGit(sessionId, workspaceFolder)] : []),
        ])
      },
    })
  }, [sessionId, store, workspaceFolder])

  useEffect(() => {
    store.retain(relPath)
    void store.load(relPath).then(() => store.checkRevision(relPath)).catch(() => undefined)
    return () => store.release(relPath)
  }, [relPath, store])

  useEffect(() => {
    const check = () => { if (globalThis.document.visibilityState === 'visible') void store.checkRevision(relPath) }
    window.addEventListener('focus', check)
    globalThis.document.addEventListener('visibilitychange', check)
    return () => {
      window.removeEventListener('focus', check)
      globalThis.document.removeEventListener('visibilitychange', check)
    }
  }, [relPath, store])

  useEffect(() => {
    const themeName = registerVibeLinkMonacoThemes(monaco, terminalThemeId)
    monaco.editor.setTheme(themeName)
  }, [terminalThemeId])

  const revealPendingNavigation = useCallback(() => {
    const editor = editorRef.current
    const target = pendingNavigationRef.current
    if (!editor || !target) return
    for (const frameId of navigationFramesRef.current) window.cancelAnimationFrame(frameId)
    navigationFramesRef.current = []
    const firstFrame = window.requestAnimationFrame(() => {
      const secondFrame = window.requestAnimationFrame(() => {
        navigationFramesRef.current = []
        if (editorRef.current !== editor || pendingNavigationRef.current !== target) return
        editor.setPosition(target)
        editor.revealPositionInCenter(target)
        editor.focus()
        pendingNavigationRef.current = null
      })
      navigationFramesRef.current = [secondFrame]
    })
    navigationFramesRef.current = [firstFrame]
  }, [])

  const navigateTo = useCallback((target: EditorNavigationTarget) => {
    pendingNavigationRef.current = target
    revealPendingNavigation()
  }, [revealPendingNavigation])

  useEffect(() => registerEditorNavigation(sessionId, relPath, navigateTo), [navigateTo, relPath, sessionId])

  useEffect(() => () => {
    for (const frameId of navigationFramesRef.current) window.cancelAnimationFrame(frameId)
    navigationFramesRef.current = []
    pendingNavigationRef.current = null
    for (const listener of editorListenersRef.current) listener.dispose()
    editorListenersRef.current = []
    editorRef.current = null
  }, [])

  // Dockview hides inactive content panels with `visibility: hidden` (and the
  // overlay can be repositioned while hidden). Monaco's automaticLayout polls
  // element SIZE, not visibility, so an editor reshown after a tab switch or a
  // sidebar-toggle relayout can keep a stale render — glyphs from the previous
  // geometry overlap the current ones. Force a fresh layout whenever the
  // surface becomes visible or its box changes.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || typeof IntersectionObserver === 'undefined') return
    const relayout = () => {
      if (surface.offsetParent === null) return
      editorRef.current?.layout()
    }
    const intersection = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) requestAnimationFrame(relayout)
    })
    intersection.observe(surface)
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => requestAnimationFrame(relayout))
    resize?.observe(surface)
    return () => {
      intersection.disconnect()
      resize?.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!overflowOpen) return
    const close = () => setOverflowOpen(false)
    window.addEventListener('pointerdown', close)
    return () => window.removeEventListener('pointerdown', close)
  }, [overflowOpen])

  const languageId = languageForPath(document?.relPath ?? relPath)
  const themeName = vibeLinkMonacoThemeName(terminalThemeId)
  const monacoPath = editorModelUri(sessionId, document?.relPath ?? relPath)
  const breadcrumbs = (document?.relPath ?? relPath).split('/').filter(Boolean)

  const captureOwnership = useCallback(() => {
    const state = useWorkspaceStore.getState()
    const workspaceEpoch = getWorkspaceSessionEpoch()
    if (state.activeSessionId !== sessionId
      || getWorkspaceSessionReadyEpoch() !== workspaceEpoch
      || getWorkspaceSessionTargetId() !== sessionId
      || state.sessions.find((candidate) => candidate.id === sessionId)?.workspaceFolder !== workspaceFolder) return null
    return { workspaceId: sessionId, workspaceEpoch }
  }, [sessionId, workspaceFolder])

  const repositoryRoot = useMemo(() => Object.keys(gitSession.repositories)
    .filter((root) => root && (relPath === root || relPath.startsWith(`${root}/`)))
    .sort((left, right) => right.length - left.length)[0] ?? '', [gitSession.repositories, relPath])
  const repositoryPath = repositoryRoot ? relPath.slice(repositoryRoot.length).replace(/^\/+/, '') || '.' : relPath
  const decoration = useMemo(() => {
    const rootDecoration = deriveGitDecorations(repositoryStateFor(gitSession, '').status).get(relPath)
    if (rootDecoration) return rootDecoration
    const repository = gitSession.repositories[repositoryRoot]
    return repository?.status ? deriveGitDecorations(repository.status, repositoryRoot, repositoryRoot).get(relPath) ?? null : null
  }, [gitSession, relPath, repositoryRoot])

  const save = useCallback(async () => {
    const current = store.getDocument(relPath)
    if (!current?.dirty || current.saving || current.conflict) return
    await store.save(relPath).catch(() => undefined)
  }, [relPath, store])

  const saveAs = useCallback(async () => {
    const current = store.getDocument(relPath)
    if (!current || current.saving) return
    const target = await promptDialog({ title: 'Save As', label: 'Workspace-relative path', defaultValue: current.relPath, confirmLabel: 'Save' })
    if (!target) return
    const result = await store.saveAs(relPath, target).catch(() => null)
    if (result?.status !== 'saved') return
    if (onSavedAs) await onSavedAs(target)
    else if (contentActions) {
      const ownership = captureOwnership()
      await contentActions.openContent({ kind: 'editor', relPath: target, ...(ownership ?? {}) })
    }
  }, [captureOwnership, contentActions, onSavedAs, relPath, store])

  const saveAll = useCallback(async () => {
    await store.saveAll()
  }, [store])

  const revealInExplorer = useCallback(async () => {
    const ownership = captureOwnership()
    if (!contentActions || !ownership) return
    await contentActions.openContent({ kind: 'explorer', ...ownership })
    await useExplorerStore.getState().revealPath(sessionId, workspaceFolder, relPath)
  }, [captureOwnership, contentActions, relPath, sessionId, workspaceFolder])

  const openFileHistory = useCallback(async () => {
    const ownership = captureOwnership()
    if (!contentActions || !ownership) return
    setActiveRepository(sessionId, repositoryRoot)
    setGitSelectedPath(sessionId, relPath, repositoryRoot, null)
    setGitActiveTab(sessionId, 'history', repositoryPath)
    await contentActions.openContent({ kind: 'gitHistory', ...ownership })
  }, [captureOwnership, contentActions, relPath, repositoryPath, repositoryRoot, sessionId, setActiveRepository, setGitActiveTab, setGitSelectedPath])

  const openChanges = useCallback(async () => {
    const ownership = captureOwnership()
    if (!contentActions || !ownership || !decoration) return
    const area = decoration.conflicted || decoration.unstaged || decoration.untracked ? 'unstaged' : 'staged'
    setActiveRepository(sessionId, repositoryRoot)
    setGitSelectedPath(sessionId, relPath, repositoryRoot, area)
    setGitActiveTab(sessionId, 'changes')
    await contentActions.openContent({ kind: 'sourceControl', ...ownership })
    await contentActions.openContent({ kind: 'workbench', ...ownership })
  }, [captureOwnership, contentActions, decoration, relPath, repositoryRoot, sessionId, setActiveRepository, setGitActiveTab, setGitSelectedPath])

  const handleMount = useCallback((editor: MonacoEditorHandle) => {
    for (const listener of editorListenersRef.current) listener.dispose()
    editorListenersRef.current = []
    editorRef.current = editor
    const model = editor.getModel()
    if (model) store.attachModel(relPath, model)
    const updateStatus = () => {
      const position = editor.getPosition()
      if (position) setCursor(position)
      const options = editor.getModel()?.getOptions?.()
      if (options) setIndentation(options.insertSpaces ? `Spaces: ${options.tabSize}` : `Tab Size: ${options.tabSize}`)
    }
    updateStatus()
    editorListenersRef.current = [
      editor.onDidChangeCursorPosition((event) => setCursor(event.position)),
      editor.onDidChangeModelOptions(updateStatus),
    ]
    if (pendingNavigationRef.current) revealPendingNavigation()
    else editor.focus()
  }, [relPath, revealPendingNavigation, store])

  if (!document) return <div className="editor-content-panel editor-loading">Opening {relPath}…</div>

  const canSave = document.dirty && !document.saving && !document.conflict && Boolean(document.revision)
  const hasDirtyDocuments = store.listDocuments().some((candidate) => candidate.dirty)

  return (
    <section
      className="editor-content-panel"
      data-dirty={document.dirty || undefined}
      data-conflict={Boolean(document.conflict) || undefined}
      onKeyDownCapture={(event) => {
        if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's') return
        event.preventDefault()
        if (event.shiftKey) void saveAs()
        else void save()
      }}
    >
      <header className="editor-toolbar">
        <nav className="editor-breadcrumbs" aria-label="File path">
          {breadcrumbs.map((segment, index) => <span key={`${segment}-${index}`}><span title={breadcrumbs.slice(0, index + 1).join('/')}>{segment}</span>{index < breadcrumbs.length - 1 ? <ChevronRight size={11} aria-hidden="true" /> : null}</span>)}
        </nav>
        <span className="editor-file-identity" title={document.relPath}>
          <FileCode2 size={14} aria-hidden="true" />
          <strong>{fileName(document.relPath)}</strong>
          <span className="editor-language-chip">{languageLabel(languageId)}</span>
          {document.dirty ? <span className="editor-dirty-mark" title="Unsaved changes">●</span> : null}
          {document.conflict ? <span className="editor-conflict-chip">Conflict</span> : null}
        </span>
        <div className="editor-toolbar-actions">
          <button type="button" disabled={!canSave} onClick={() => { void save() }} title="Save (Ctrl+S)"><Save size={13} />Save</button>
          <button type="button" disabled={document.saving} onClick={() => { void saveAs() }} title="Save As (Ctrl+Shift+S)"><CopyPlus size={13} />Save As</button>
          <button type="button" disabled={document.saving || !hasDirtyDocuments} onClick={() => { void saveAll() }} title="Save all dirty files"><SaveAll size={13} />Save All</button>
          <button type="button" aria-pressed={editorWordWrap} onClick={() => updateSettings({ editorWordWrap: !editorWordWrap })} title="Toggle word wrap"><WrapText size={13} />Wrap</button>
          <button type="button" aria-pressed={editorMinimap} onClick={() => updateSettings({ editorMinimap: !editorMinimap })} title="Toggle minimap"><Map size={13} />Minimap</button>
          <div className="editor-overflow">
            <button type="button" aria-expanded={overflowOpen} aria-haspopup="menu" aria-label="More editor actions" title="More editor actions" onPointerDown={(event) => event.stopPropagation()} onClick={() => setOverflowOpen((open) => !open)}><MoreHorizontal size={14} /></button>
            {overflowOpen ? (
              <div className="editor-overflow-menu" role="menu" onPointerDown={(event) => event.stopPropagation()}>
                <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); void revealInExplorer() }}><FolderOpen size={13} />Reveal in Explorer</button>
                <button type="button" role="menuitem" onClick={() => { setOverflowOpen(false); void openFileHistory() }}><History size={13} />File History</button>
                <button type="button" role="menuitem" disabled={!decoration} onClick={() => { setOverflowOpen(false); void openChanges() }}><GitCompareArrows size={13} />Open Changes</button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      {document.conflict ? (
        <div className="editor-conflict-banner" role="alert">
          <AlertTriangle size={15} aria-hidden="true" />
          <span>The file changed on disk. VibeLink will not overwrite it.</span>
          <div>
            <button type="button" onClick={() => { setCompareVisible((visible) => !visible); if (!document.conflict?.diskContent) void store.refreshConflict(relPath).catch(() => undefined) }}><Columns2 size={12} />Compare</button>
            <button type="button" onClick={() => { void store.refreshConflict(relPath).catch(() => undefined) }}><RefreshCw size={12} />Reload</button>
            <button type="button" onClick={() => { void store.discardLocal(relPath).then(() => setCompareVisible(false)).catch(() => undefined) }}><RotateCcw size={12} />Discard Local</button>
            <button type="button" onClick={() => { void saveAs() }}><CopyPlus size={12} />Save As</button>
          </div>
        </div>
      ) : null}

      {document.errors.length > 0 ? <div className="editor-error" role="alert">{document.errors.join(' ')}</div> : null}

      {compareVisible && document.conflict ? (
        <ConflictComparison document={document} />
      ) : (
        <div className="editor-surface" ref={surfaceRef}>
          {document.loading ? <div className="editor-loading">Loading document…</div> : (
            <MonacoEditor
              path={monacoPath}
              value={document.current}
              language={languageId}
              theme={themeName}
              keepCurrentModel
              options={{
                automaticLayout: true,
                disableLayerHinting: true,
                minimap: { enabled: editorMinimap },
                scrollBeyondLastLine: false,
                wordWrap: editorWordWrap ? 'on' : 'off',
                renderWhitespace: 'selection',
                bracketPairColorization: { enabled: true },
                find: { addExtraSpaceOnTop: false },
                multiCursorModifier: 'alt',
                padding: { top: 6 },
              }}
              onChange={(value) => store.updateCurrent(relPath, value ?? '')}
              onMount={handleMount}
            />
          )}
        </div>
      )}

      <footer className="editor-statusbar">
        <span>Ln {cursor.lineNumber}, Col {cursor.column}</span>
        <span>{indentation}</span>
        <span>{document.encoding === 'utf8Bom' ? 'UTF-8 with BOM' : 'UTF-8'}</span>
        <span>{document.lineEnding === 'crlf' ? 'CRLF' : 'LF'}</span>
        <span>{languageLabel(languageId)}</span>
        <span className="editor-statusbar-state">{document.saving ? 'Saving…' : document.conflict ? 'Conflict' : document.dirty ? 'Modified' : <><Check size={11} />Saved</>}</span>
      </footer>
    </section>
  )
}

function ConflictComparison({ document }: { document: EditorDocument }) {
  return (
    <div className="editor-conflict-comparison" aria-label="Local and disk comparison">
      <section>
        <header>Local changes</header>
        <pre><code>{document.current}</code></pre>
      </section>
      <section>
        <header>File on disk</header>
        <pre><code>{document.conflict?.diskContent ?? 'Loading disk version…'}</code></pre>
      </section>
    </div>
  )
}

function editorModelUri(sessionId: string, relPath: string): string {
  return `vibelink-editor://${encodeURIComponent(sessionId)}/${relPath.split('/').map(encodeURIComponent).join('/')}`
}

function fileName(relPath: string): string {
  return relPath.split('/').pop() ?? relPath
}

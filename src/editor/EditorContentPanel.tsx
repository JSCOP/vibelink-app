import { useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore, type ComponentType } from 'react'
import { AlertTriangle, Columns2, CopyPlus, FileCode2, RefreshCw, RotateCcw, Save, SaveAll } from 'lucide-react'
import { WorkspaceContentActionsContext } from '../layout/contentActions'
import { parentPath, useExplorerStore } from '../state/explorer'
import { useGitStore } from '../state/git'
import {
  getEditorDocumentStore,
  type EditorDocument,
  type EditorTextModel,
} from './documentStore'
import './EditorContentPanel.css'

export type MonacoEditorSurfaceProps = {
  path: string
  value: string
  language?: string
  theme?: string
  keepCurrentModel?: boolean
  options?: Record<string, unknown>
  onChange?: (value: string | undefined) => void
  onMount?: (editor: { getModel(): EditorTextModel | null; focus(): void }) => void
}

export type EditorContentPanelProps = {
  sessionId: string
  workspaceFolder: string
  relPath: string
  MonacoEditor?: ComponentType<MonacoEditorSurfaceProps>
  onSavedAs?: (relPath: string) => void | Promise<void>
}

export function EditorContentPanel({ sessionId, workspaceFolder, relPath, MonacoEditor, onSavedAs }: EditorContentPanelProps) {
  const store = useMemo(() => getEditorDocumentStore(sessionId, workspaceFolder), [sessionId, workspaceFolder])
  const contentActions = useContext(WorkspaceContentActionsContext)
  const document = useSyncExternalStore(store.subscribe, () => store.getDocument(relPath), () => store.getDocument(relPath))
  const [compareVisible, setCompareVisible] = useState(false)

  useEffect(() => {
    store.setRefreshHooks({
      afterSave: async (savedPath) => {
        const gitStore = useGitStore.getState()
        const gitSession = gitStore.sessions[sessionId]
        const repositoryRoot = Object.keys(gitSession?.repositories ?? {})
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

  const save = async () => {
    if (!document?.dirty || document.saving || document.conflict) return
    await store.save(relPath).catch(() => undefined)
  }

  const saveAs = useCallback(async () => {
    if (!document || document.saving) return
    const target = window.prompt('Save As (workspace-relative path)', document.relPath)?.trim()
    if (!target) return
    const result = await store.saveAs(relPath, target).catch(() => null)
    if (result?.status !== 'saved') return
    if (onSavedAs) await onSavedAs(target)
    else if (contentActions) await contentActions.openContent({ kind: 'editor', relPath: target })
  }, [contentActions, document, onSavedAs, relPath, store])

  const saveAll = useCallback(async () => {
    await store.saveAll()
  }, [store])

  if (!document) return <div className="editor-content-panel editor-loading">Opening {relPath}…</div>

  const MonacoSurface = MonacoEditor
  const monacoPath = editorModelUri(sessionId, document.relPath)
  const canSave = document.dirty && !document.saving && !document.conflict && Boolean(document.revision)

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
        <span className="editor-file-identity" title={document.relPath}>
          <FileCode2 size={14} aria-hidden="true" />
          <strong>{fileName(document.relPath)}</strong>
          {document.dirty ? <span className="editor-dirty-mark" title="Unsaved changes">●</span> : null}
        </span>
        <span className="editor-toolbar-status">
          {document.saving ? 'Saving…' : document.conflict ? 'Conflict' : document.dirty ? 'Modified' : 'Saved'}
          {' · '}{document.encoding === 'utf8Bom' ? 'UTF-8 BOM' : 'UTF-8'}
          {' · '}{document.lineEnding.toUpperCase()}
        </span>
        <div className="editor-toolbar-actions">
          <button type="button" disabled={!canSave} onClick={() => { void save() }} title="Save (Ctrl+S)"><Save size={13} />Save</button>
          <button type="button" disabled={document.saving} onClick={() => { void saveAs() }} title="Save As (Ctrl+Shift+S)"><CopyPlus size={13} />Save As</button>
          <button type="button" disabled={document.saving} onClick={() => { void saveAll() }} title="Save all dirty files"><SaveAll size={13} />Save All</button>
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
        <div className="editor-surface">
          {document.loading ? <div className="editor-loading">Loading document…</div> : MonacoSurface ? (
            <MonacoSurface
              path={monacoPath}
              value={document.current}
              language={languageForPath(document.relPath)}
              theme="vs-dark"
              keepCurrentModel
              options={{
                automaticLayout: true,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'off',
                renderWhitespace: 'selection',
                bracketPairColorization: { enabled: true },
              }}
              onChange={(value) => store.updateCurrent(relPath, value ?? '')}
              onMount={(editor) => {
                const model = editor.getModel()
                if (model) store.attachModel(relPath, model)
                editor.focus()
              }}
            />
          ) : (
            <textarea
              className="editor-textarea-fallback"
              aria-label={`Editor for ${document.relPath}`}
              spellCheck={false}
              value={document.current}
              onChange={(event) => store.updateCurrent(relPath, event.target.value)}
            />
          )}
        </div>
      )}
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

function languageForPath(relPath: string): string | undefined {
  const extension = relPath.split('.').pop()?.toLowerCase()
  return ({
    c: 'c', cpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', html: 'html', java: 'java', js: 'javascript', jsx: 'javascript', json: 'json',
    md: 'markdown', py: 'python', rb: 'ruby', rs: 'rust', sh: 'shell', sql: 'sql', toml: 'toml', ts: 'typescript', tsx: 'typescript',
    xml: 'xml', yaml: 'yaml', yml: 'yaml',
  } as Record<string, string>)[extension ?? '']
}
